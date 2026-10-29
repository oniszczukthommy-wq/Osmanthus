#!/usr/bin/env python3
"""Local immutable-image processing. No network access or runtime model downloads.
U2NETP uses the publisher-exported ONNX model (upstream U-2-Net Apache-2.0).
SRVGG compact architecture is adapted from xinntao/Real-ESRGAN, BSD-3-Clause.
BSD 3-Clause License

Copyright (c) 2021, Xintao Wang
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

import json, sys, os, math, hashlib
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 16_777_216
MAX_OUTPUT_PIXELS = 16_777_216

def save(image, directory, name, role, **extra):
    file = directory / name
    image.save(file, format='PNG')
    return dict(filename=name, role=role, width=image.width, height=image.height, **extra)

def segment(image, model):
    import onnxruntime as ort
    opts = ort.SessionOptions(); opts.intra_op_num_threads = 2; opts.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])
    rgb = image.convert('RGB').resize((320,320), Image.Resampling.LANCZOS)
    a = np.asarray(rgb, dtype=np.float32)
    a /= max(float(a.max()), 1.)
    a = (a - np.array([.485,.456,.406],dtype=np.float32)) / np.array([.229,.224,.225],dtype=np.float32)
    a = a.transpose(2,0,1)[None].astype(np.float32)
    pred = session.run(None,{session.get_inputs()[0].name:a})[0][0,0]
    lo,hi = float(pred.min()),float(pred.max())
    pred = np.clip((pred-lo)/max(hi-lo,1e-8)*255,0,255).astype(np.uint8)
    mask = Image.fromarray(pred).resize(image.size,Image.Resampling.LANCZOS)
    original = np.asarray(image.getchannel('A'),dtype=np.uint16)
    alpha = ((np.asarray(mask,dtype=np.uint16)*original+127)//255).astype(np.uint8)
    foreground = image.copy(); foreground.putalpha(Image.fromarray(alpha))
    background = image.copy(); background.putalpha(Image.fromarray((original*(255-np.asarray(mask,dtype=np.uint16))+127)//255).convert('L'))
    return foreground,background,Image.fromarray(alpha),mask

def upscale(image, model, scale):
    import torch
    from torch import nn
    from torch.nn import functional as functional
    torch.set_num_threads(2)
    class SRVGGNetCompact(nn.Module):
        def __init__(self):
            super().__init__()
            self.body = nn.ModuleList([nn.Conv2d(3,64,3,1,1),nn.PReLU(num_parameters=64)])
            for _ in range(32):self.body.extend([nn.Conv2d(64,64,3,1,1),nn.PReLU(num_parameters=64)])
            self.body.append(nn.Conv2d(64,48,3,1,1));self.upsampler=nn.PixelShuffle(4)
        def forward(self,x):
            out=x
            for layer in self.body:out=layer(out)
            return self.upsampler(out)+functional.interpolate(x,scale_factor=4,mode='nearest')
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    net=SRVGGNetCompact();state=torch.load(str(model),map_location='cpu',weights_only=True)
    net.load_state_dict(state.get('params_ema',state.get('params',state)),strict=True)
    net.eval().to(device)
    rgb=np.asarray(image.convert('RGB'),dtype=np.float32)/255
    h,w=rgb.shape[:2]
    # The source network is 4x. 2x is neural 4x output followed by a Lanczos downsample.
    # Tiling bounds temporary feature tensors; overlap is discarded to avoid edge padding seams.
    if w*h*scale*scale>MAX_OUTPUT_PIXELS:raise ValueError('upscale target exceeds 4096x4096 pixel area limit')
    result=np.empty((h*4,w*4,3),dtype=np.uint8);tile=128;pad=40
    with torch.inference_mode():
        for y in range(0,h,tile):
            for x in range(0,w,tile):
                x0,y0=max(0,x-pad),max(0,y-pad);x1,y1=min(w,x+tile+pad),min(h,y+tile+pad)
                patch=torch.from_numpy(rgb[y0:y1,x0:x1].copy()).permute(2,0,1)[None].to(device)
                out=net(patch).clamp(0,1)[0].permute(1,2,0).cpu().numpy()
                out=np.rint(out*255).astype(np.uint8)
                cw,ch=min(tile,w-x),min(tile,h-y)
                result[y*4:(y+ch)*4,x*4:(x+cw)*4]=out[(y-y0)*4:(y-y0+ch)*4,(x-x0)*4:(x-x0+cw)*4]
    output=Image.fromarray(result).convert('RGBA')
    output.putalpha(image.getchannel('A').resize(output.size,Image.Resampling.LANCZOS))
    if scale==2:output=output.resize((w*2,h*2),Image.Resampling.LANCZOS)
    return output,device

def depth(image, model_dir):
    import torch
    from transformers import AutoImageProcessor, DepthAnythingForDepthEstimation
    torch.set_num_threads(2)
    device='mps' if torch.backends.mps.is_available() else 'cpu'
    processor=AutoImageProcessor.from_pretrained(str(model_dir),local_files_only=True,use_fast=False)
    model=DepthAnythingForDepthEstimation.from_pretrained(str(model_dir),local_files_only=True,use_safetensors=True).eval().to(device)
    inputs=processor(images=image.convert('RGB'),return_tensors='pt')
    with torch.inference_mode():
        prediction=model(**{k:v.to(device)for k,v in inputs.items()}).predicted_depth
        prediction=torch.nn.functional.interpolate(prediction[:,None],size=(image.height,image.width),mode='bicubic',align_corners=False)[0,0].float().cpu().numpy()
    lo,hi=float(prediction.min()),float(prediction.max())
    normalized=np.clip((prediction-lo)/max(hi-lo,1e-8),0,1)
    return Image.fromarray(np.rint(normalized*65535).astype(np.uint16)),Image.fromarray(np.rint(normalized*255).astype(np.uint8)).convert('RGB'),device,lo,hi

def main():
    body=json.load(sys.stdin);directory=Path(body['output_dir']);operation=body['operation']
    with Image.open(body['input_file']) as opened:
        if opened.width*opened.height>16_777_216:raise ValueError('image exceeds 4096x4096 pixel area limit')
        image=ImageOps.exif_transpose(opened).convert('RGBA')
    if image.width<1 or image.height<1:raise ValueError('empty image')
    outputs=[];meta={'sourceDimensions':{'width':image.width,'height':image.height}}
    if operation in ['remove-background','layer-split']:
        fg,bg,alpha,mask=segment(image,Path(body['model_dir'])/'u2netp.onnx')
        outputs=[save(fg,directory,'foreground.png','foreground'),save(bg,directory,'background.png','background-visible-region'),save(alpha,directory,'alpha.png','alpha'),save(mask,directory,'mask.png','segmentation-mask')]
        meta.update(model='u2netp',layers='foreground-and-visible-background-only',hiddenBackgroundReconstructed=False,alphaMin=int(np.asarray(alpha).min()),alphaMax=int(np.asarray(alpha).max()))
    elif operation=='upscale':
        scale=body.get('scale',2)
        if type(scale)is not int or scale not in [2,4]:raise ValueError('upscale scale must be 2 or 4')
        output,device=upscale(image,Path(body['model_dir'])/'realesr-general-x4v3.pth',scale)
        outputs=[save(output,directory,'upscaled.png','upscaled')];meta.update(model='realesr-general-x4v3',nativeScale=4,outputScale=scale,device=device)
    elif operation=='depth':
        depth16,preview,device,lo,hi=depth(image,Path(body['model_dir'])/'depth-anything-v2-small')
        outputs=[save(depth16,directory,'depth.png','relative-inverse-depth-16bit'),save(preview,directory,'depth-preview.png','relative-inverse-depth-preview')]
        meta.update(model='Depth-Anything-V2-Small',device=device,depthType='relative-inverse-depth',whiteMeans='nearer',metric=False,rawMin=lo,rawMax=hi)
    elif operation=='grid-split':
        rows,cols=body.get('rows',2),body.get('columns',2)
        if type(rows)is not int or type(cols)is not int or not 1<=rows<=10 or not 1<=cols<=10 or rows*cols>64 or rows>image.height or cols>image.width:raise ValueError('invalid grid dimensions')
        for row in range(rows):
            for col in range(cols):
                box=(col*image.width//cols,row*image.height//rows,(col+1)*image.width//cols,(row+1)*image.height//rows)
                outputs.append(save(image.crop(box),directory,f'cell-{row+1}-{col+1}.png','grid-cell',row=row,column=col,crop=list(box)))
        meta.update(model=None,rows=rows,columns=cols,method='exact-integer-grid-crops')
    else:raise ValueError('unsupported operation')
    print(json.dumps({'outputs':outputs,'metadata':meta},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr);sys.exit(1)
