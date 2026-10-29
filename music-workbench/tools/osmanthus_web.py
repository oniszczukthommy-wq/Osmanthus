#!/usr/bin/env python3
"""Start the existing music and MV applications behind one local Web entry."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
MUSIC = ROOT / 'validation/track-edit-e2e-20261024'
MV_DEFAULT = ROOT.parent / 'mv-studio'
if not MV_DEFAULT.is_dir():
    MV_DEFAULT = ROOT.parent / 'ai video/mv-studio'
MV = Path(os.environ.get('OSMANTHUS_MV_DIR', str(MV_DEFAULT)))
RUNTIME = ROOT / '.local/osmanthus-web'
STATE = RUNTIME / 'services.json'
MUSIC_PORT = int(os.environ.get('MUSIC_EDITOR_PORT', '8603'))
MV_PORT = int(os.environ.get('MUSIC_MV_PORT', '8792'))
BASE = f'http://127.0.0.1:{MUSIC_PORT}'


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def request(path, port=MUSIC_PORT):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=3) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def ready(kind):
    if kind == 'music':
        data = request('/api/project')
        return isinstance(data, dict) and 'tracks' in data and 'revision' in data
    data = request('/api/capabilities', MV_PORT)
    return isinstance(data, dict) and data.get('kind') == 'local-ai-music-video-workspace'


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
    raise RuntimeError('没有找到 Node.js 22 或以上版本，可用 OSMANTHUS_NODE 指定。')


def spec(kind):
    if kind == 'mv':
        if not (MV / 'server.mjs').is_file():
            raise RuntimeError('未找到视频工程，请先从 GitHub 恢复，或用 OSMANTHUS_MV_DIR 指定位置。')
        return [node_binary(), str(MV / 'server.mjs')], MV, MV_PORT
    python = ROOT / 'validation/audio-separation/.venv/bin/python'
    if not python.is_file() or not (MUSIC / 'server.py').is_file():
        raise RuntimeError('音乐服务或现有 Python 运行环境缺失，请恢复依赖后再启动。')
    return [str(python), str(MUSIC / 'server.py')], MUSIC, MUSIC_PORT


def save(state):
    RUNTIME.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    temporary.replace(STATE)


def start_service(kind, state):
    if ready(kind):
        print(('音乐' if kind == 'music' else '视频') + '服务已在运行。')
        return
    command, directory, port = spec(kind)
    if listening(port):
        raise RuntimeError(f'端口 {port} 被其他程序占用，未停止或覆盖该程序。')
    env = dict(os.environ, MUSIC_EDITOR_PORT=str(MUSIC_PORT), MUSIC_MV_PORT=str(MV_PORT),
               PORT=str(MV_PORT), MUSIC_BASE_URL=BASE,
               FFMPEG_BIN=str(ROOT / 'validation/audiocraft/conda-env/bin/ffmpeg'),
               FFPROBE_BIN=str(ROOT / 'validation/audiocraft/conda-env/bin/ffprobe'))
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / (kind + '.log')).open('ab') as log:
        child = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    state[kind] = {'pid': child.pid, 'command': command, 'cwd': str(directory), 'port': port}
    save(state)
    for _ in range(90):
        if ready(kind):
            print(('音乐' if kind == 'music' else '视频') + '服务已就绪。')
            return
        if child.poll() is not None:
            raise RuntimeError(f'{kind} 启动失败，日志：{RUNTIME / (kind + ".log")}')
        time.sleep(.3)
    raise RuntimeError(f'{kind} 启动超时，日志：{RUNTIME / (kind + ".log")}')


def stop_service(kind, state):
    record = state.get(kind)
    if not record:
        return
    # PID reuse must never stop a different application.
    try:
        actual = subprocess.check_output(['ps', '-p', str(record['pid']), '-o', 'command='], text=True).strip()
    except subprocess.CalledProcessError:
        state.pop(kind, None)
        save(state)
        return
    if not all(part in actual for part in record['command']):
        raise RuntimeError(f'{kind} 的进程标识已变化，未停止其他程序。')
    os.kill(record['pid'], signal.SIGTERM)
    port = record.get('port', MV_PORT if kind == 'mv' else MUSIC_PORT)
    for _ in range(50):
        if not listening(port):
            break
        time.sleep(.1)
    else:
        raise RuntimeError(f'{kind} 尚未停止，已保留进程记录，请稍后再试。')
    state.pop(kind, None)
    save(state)


def main():
    parser = argparse.ArgumentParser(description='Osmanthus 本机 Web 工作台')
    parser.add_argument('action', choices=('start', 'status', 'stop'), nargs='?', default='start')
    parser.add_argument('--open', action='store_true', help='启动后打开浏览器')
    args = parser.parse_args()
    state = read_json(STATE)
    if args.action == 'start':
        # Start the audio service first: video import depends on its handoff API.
        for kind in ('music', 'mv'):
            start_service(kind, state)
        print(f'\nOsmanthus 网页：{BASE}/\nMV 画布：{BASE}/mv/')
        if args.open:
            webbrowser.open(BASE + '/')
    elif args.action == 'status':
        result = {'url': BASE + '/', 'music_ready': ready('music'), 'mv_ready': ready('mv')}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['music_ready'] and result['mv_ready'] else 1
    else:
        for kind in ('mv', 'music'):
            stop_service(kind, state)
        print('已停止本启动器启动的服务；其他已运行服务保持原状。')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
