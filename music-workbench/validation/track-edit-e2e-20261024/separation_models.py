"""Offline Demucs fine-mode model layout and readiness checks."""
from pathlib import Path
import hashlib

FINE_FILES=('f7e0c4bc-ba3fe64a.th','d12395a8-e57c48e6.th',
            '92cfc3b6-ef3bcb9c.th','04573f0d-f3cf25b2.th')
FINE_SIZE=84141271
FINE_CONFIG="models: ['f7e0c4bc', 'd12395a8', '92cfc3b6', '04573f0d']\nweights: [[1.,0.,0.,0.],[0.,1.,0.,0.],[0.,0.,1.,0.],[0.,0.,0.,1.]]\n"
_VERIFIED={}

def fine_repo(root):
    return Path(root)/'.local'/'models'/'htdemucs-ft'

def fine_problem(root):
    repo=fine_repo(root)
    try:
        if (repo/'htdemucs_ft.yaml').read_text(encoding='utf-8')!=FINE_CONFIG:
            return '精细分轨模型配置不正确，请重新检查模型安装。'
        for name in FINE_FILES:
            path=repo/name
            if path.is_symlink() or not path.is_file():return '精细分轨模型文件不完整，请先按说明安装。'
            stat=path.stat()
            if stat.st_size!=FINE_SIZE:return '精细分轨模型文件不完整，请先按说明安装。'
            fingerprint=(str(path),stat.st_size,stat.st_mtime_ns)
            if fingerprint not in _VERIFIED:
                h=hashlib.sha256()
                with path.open('rb') as stream:
                    for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
                after=path.stat()
                if (after.st_size,after.st_mtime_ns)!=(stat.st_size,stat.st_mtime_ns) or not h.hexdigest().startswith(name.rsplit('-',1)[1].split('.')[0]):
                    return '精细分轨模型校验失败，请检查模型安装。'
                _VERIFIED[fingerprint]=True
    except OSError:
        return '精细分轨模型尚未安装，请先按说明安装。'
    return None
