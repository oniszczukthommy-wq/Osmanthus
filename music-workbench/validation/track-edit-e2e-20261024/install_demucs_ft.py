"""Explicitly install the official Demucs fine-mode weights, never overwrite files."""
from pathlib import Path
import argparse, hashlib, os, shutil, tempfile
from urllib.request import urlopen
from separation_models import FINE_CONFIG, FINE_FILES, fine_repo
from project import ROOT

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser(description='Install verified local Demucs fine-mode models')
    mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--source-dir',type=Path,help='Directory containing the official weight files')
    mode.add_argument('--download',action='store_true',help='Explicitly download the weights from the official source')
    args=p.parse_args();repo=fine_repo(ROOT);repo.mkdir(parents=True,exist_ok=True)
    for name in FINE_FILES:
        target=repo/name;expected=name.rsplit('-',1)[1].split('.')[0]
        if target.is_symlink(): raise RuntimeError(f'Refusing symbolic link: {target}')
        if target.exists():
            if not target.is_file() or not digest(target).startswith(expected):
                raise RuntimeError(f'Existing model does not match official SHA-256 prefix; not overwritten: {target}')
            print(f'{name}: verified existing file',flush=True);continue
        fd,tmpname=tempfile.mkstemp(prefix='.model-',suffix='.part',dir=repo);tmp=Path(tmpname)
        try:
            with os.fdopen(fd,'wb') as out:
                if args.source_dir:
                    with (args.source_dir/name).open('rb') as source: shutil.copyfileobj(source,out,1024*1024)
                else:
                    with urlopen('https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/'+name,timeout=120) as source:
                        shutil.copyfileobj(source,out,1024*1024)
            if not digest(tmp).startswith(expected):raise RuntimeError(f'SHA-256 check failed: {name}')
            created=False
            try:
                with target.open('xb') as out, tmp.open('rb') as source:
                    created=True;shutil.copyfileobj(source,out,1024*1024)
            except Exception:
                if created:target.unlink(missing_ok=True)
                raise
            print(f'{name}: installed and verified',flush=True)
        finally:
            tmp.unlink(missing_ok=True)
    config=repo/'htdemucs_ft.yaml'
    if config.is_symlink():raise RuntimeError(f'Refusing symbolic link: {config}')
    try:
        with config.open('x',encoding='utf-8',newline='\n') as f:f.write(FINE_CONFIG)
    except FileExistsError:
        if config.read_text(encoding='utf-8')!=FINE_CONFIG:
            raise RuntimeError(f'Existing config differs and was not overwritten: {config}')
    print(f'Fine-mode models ready at {repo}')

if __name__=='__main__':main()
