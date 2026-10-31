"""Small provider transport shared by the song generator and stream receiver."""
import json
import os
from pathlib import Path
import shutil
import urllib.error
import urllib.parse
import urllib.request
from runtime_support import load_env as read_env


def load_env():
    read_env(Path(__file__).resolve().parent.parent / '.env.local')


def request_json(url, key, payload=None, timeout=60):
    if not key:
        raise ValueError('请先配置自己的模型 API Key')
    request = urllib.request.Request(url,
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None,
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
        method='POST' if payload is not None else 'GET')
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read(1600).decode('utf-8', 'replace').replace(key, '<redacted>')
        raise RuntimeError(f'HTTP {error.code}: {detail}') from None


def download(url, path):
    if urllib.parse.urlparse(url).scheme not in ('https', 'http'):
        raise ValueError('音频地址必须使用 HTTP(S)')
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.download')
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=120) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        if temporary.stat().st_size < 10000:
            raise ValueError('下载的音频文件不完整，原生成任务已保留')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
