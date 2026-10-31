#!/usr/bin/env python3
"""Portable local music + MV launcher. Run Python with UTF-8 enabled."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
MUSIC = ROOT / 'validation/track-edit-e2e-20261024'
sys.path.insert(0, str(MUSIC))
from runtime_support import load_env, media_binary, venv_python

load_env(ROOT.parent / '.env')
load_env(ROOT / 'validation/.env.local')
MV_DEFAULT = ROOT.parent / 'mv-studio'
if not MV_DEFAULT.is_dir():
    MV_DEFAULT = ROOT.parent / 'ai video/mv-studio'
MV = Path(os.environ.get('OSMANTHUS_MV_DIR', str(MV_DEFAULT))).resolve()
RUNTIME = Path(os.environ.get('OSMANTHUS_RUNTIME_DIR', str(ROOT / '.local/osmanthus-web')))
STATE = RUNTIME / 'services.json'
MUSIC_PORT = int(os.environ.get('MUSIC_EDITOR_PORT', '8603'))
MV_PORT = int(os.environ.get('MUSIC_MV_PORT', '8792'))
BASE = f'http://127.0.0.1:{MUSIC_PORT}'


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def request(route, port=MUSIC_PORT):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}{route}', timeout=3) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def ready(kind):
    data = request('/api/project') if kind == 'music' else request('/api/capabilities', MV_PORT)
    return isinstance(data, dict) and (('tracks' in data and 'revision' in data) if kind == 'music'
        else data.get('kind') == 'local-ai-music-video-workspace')


def listening(port):
    with socket.socket() as connection:
        connection.settimeout(.3)
        return connection.connect_ex(('127.0.0.1', port)) == 0


def node_binary():
    candidates = [os.environ.get('OSMANTHUS_NODE'), shutil.which('node'),
        str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')]
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            version = subprocess.check_output([candidate, '--version'], text=True, timeout=5)
            if int(version.strip().lstrip('v').split('.')[0]) >= 22:
                return str(Path(candidate).resolve())
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    raise RuntimeError('没有找到 Node.js 22+，请安装或用 OSMANTHUS_NODE 指定。')


def python_binary():
    configured = os.environ.get('OSMANTHUS_PYTHON')
    if configured:
        candidate = Path(shutil.which(configured) or configured)
        if not candidate.is_file():
            raise RuntimeError('OSMANTHUS_PYTHON 指定的 Python 不存在')
        return str(candidate.absolute())
    for environment in [ROOT.parent / '.venv', ROOT / 'validation/audio-separation/.venv']:
        candidate = venv_python(environment)
        if candidate.is_file():
            return str(candidate.absolute())
    return sys.executable


def spec(kind):
    if kind == 'mv':
        if not (MV / 'server.mjs').is_file():
            raise RuntimeError('未找到视频源码，请重新下载完整仓库。')
        return [node_binary(), str(MV / 'server.mjs')], MV, MV_PORT
    return [python_binary(), '-X', 'utf8', str(MUSIC / 'server.py')], MUSIC, MUSIC_PORT


def save(state):
    RUNTIME.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(STATE)


def start_service(kind, state):
    import psutil
    if ready(kind):
        print(('音乐' if kind == 'music' else '视频') + '服务已在运行。')
        return
    command, directory, port = spec(kind)
    if listening(port):
        raise RuntimeError(f'端口 {port} 已被占用，未停止其他程序。')
    env = dict(os.environ, MUSIC_EDITOR_PORT=str(MUSIC_PORT), MUSIC_MV_PORT=str(MV_PORT),
               PORT=str(MV_PORT), MUSIC_BASE_URL=BASE, PYTHONUTF8='1', PYTHONIOENCODING='utf-8',
               FFMPEG_BIN=str(media_binary('ffmpeg')), FFPROBE_BIN=str(media_binary('ffprobe')))
    if (MV / '.env').is_file():
        env.setdefault('MV_ENV_FILE', str(MV / '.env'))
    RUNTIME.mkdir(parents=True, exist_ok=True)
    process_options = {'creationflags':subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS} if os.name == 'nt' else {'start_new_session':True}
    with (RUNTIME / (kind + '.log')).open('ab') as log:
        child = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, **process_options)
    state[kind] = {'pid':child.pid, 'created':psutil.Process(child.pid).create_time(),
                   'command':command, 'cwd':str(directory), 'port':port}
    save(state)
    for _ in range(120):
        if ready(kind):
            print(('音乐' if kind == 'music' else '视频') + '服务已就绪。')
            return
        if child.poll() is not None:
            raise RuntimeError(f'{kind} 启动失败，日志：{RUNTIME / (kind + ".log")}')
        time.sleep(.3)
    raise RuntimeError(f'{kind} 启动超时，日志：{RUNTIME / (kind + ".log")}')


def stop_service(kind, state):
    import psutil
    record = state.get(kind)
    if not record:
        return
    try:
        process = psutil.Process(record['pid'])
        normal = lambda value:os.path.normcase(os.path.abspath(value)) if os.path.isabs(value) else value
        actual, expected = process.cmdline(), record['command']
        if ('created' in record and abs(process.create_time()-record['created'])>.01) or len(actual)!=len(expected) or any(normal(a)!=normal(b) for a,b in zip(actual,expected)):
            raise RuntimeError(f'{kind} 进程标识已变化，未停止其他程序。')
        process.terminate()
        try:
            process.wait(timeout=6)
        except psutil.TimeoutExpired as exc:
            raise RuntimeError(f'{kind} 尚未停止，已保留进程记录。') from exc
    except psutil.NoSuchProcess:
        pass
    state.pop(kind, None)
    save(state)


def doctor():
    issues=[]
    for name in ['ffmpeg','ffprobe','curl']:
        binary = str(media_binary(name)) if name!='curl' else shutil.which('curl')
        try:
            subprocess.run([binary,'-version' if name!='curl' else '--version'],check=True,capture_output=True,timeout=8)
            print(f'{name}: OK')
        except (OSError,TypeError,subprocess.SubprocessError):
            issues.append(f'没有可用的 {name}')
    try:
        print('Node.js: '+node_binary())
        subprocess.run([python_binary(),'-X','utf8','-c','import numpy,soundfile,PIL,psutil; from runtime_support import file_lock'],cwd=MUSIC,check=True,capture_output=True,timeout=15)
        print('Python 基础依赖: OK')
    except (RuntimeError,OSError,subprocess.SubprocessError):
        issues.append('Node.js 或 Python 依赖不完整，请先运行安装脚本')
    print('模型配置: '+', '.join(f'{key}='+('已配置' if os.environ.get(key) else '未配置') for key in ['DEEPSEEK_API_KEY','YINCHAO_API_KEY','DASHSCOPE_API_KEY']))
    for issue in issues:print(issue,file=sys.stderr)
    return 1 if issues else 0


def main():
    parser=argparse.ArgumentParser(description='Osmanthus 本机 Web 工作台')
    parser.add_argument('action',choices=('start','status','stop','doctor'),nargs='?',default='start')
    parser.add_argument('--open',action='store_true')
    args=parser.parse_args();state=read_json(STATE)
    if args.action=='doctor':return doctor()
    if args.action=='start':
        for kind in ('music','mv'):start_service(kind,state)
        print(f'\nOsmanthus 网页：{BASE}/\nMV：{BASE}/mv/')
        if args.open:webbrowser.open(BASE+'/')
    elif args.action=='status':
        result={'url':BASE+'/', 'music_ready':ready('music'), 'mv_ready':ready('mv')}
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0 if result['music_ready'] and result['mv_ready'] else 1
    else:
        for kind in ('mv','music'):stop_service(kind,state)
        print('已停止本启动器记录的服务；歌曲与工程仍保留。')
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (RuntimeError,OSError,ImportError) as error:
        print(str(error),file=sys.stderr);sys.exit(1)
