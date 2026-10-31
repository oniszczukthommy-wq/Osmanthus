"""Portable executables, process checks and advisory job locks.

No model downloads and no implicit credentials from another checkout.
"""
import errno
import os
from pathlib import Path
import shutil
import sys

CODE_ROOT = Path(__file__).resolve().parent
VALIDATION = CODE_ROOT.parent


def load_env(filename):
    path = Path(filename)
    if not path.is_file():
        return
    for raw in path.read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        name, value = line.removeprefix('export ').split('=', 1)
        name, value = name.strip(), value.strip()
        if name.replace('_', '').isalnum() and not name[0].isdigit():
            if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(name, value)


def media_binary(name):
    override = os.environ.get(name.upper() + '_BIN')
    if override:
        return Path(shutil.which(override) or override).expanduser().resolve()
    found = shutil.which(name)
    if found:
        return Path(found).resolve()
    legacy = VALIDATION / 'audiocraft/conda-env/bin' / name
    return legacy if legacy.is_file() else Path(name + ('.exe' if os.name == 'nt' else ''))


def venv_python(directory, env_name=None, fallback=False):
    if env_name and os.environ.get(env_name):
        value = os.environ[env_name]
        return Path(shutil.which(value) or value).expanduser().absolute()
    root = Path(directory)
    candidate = root / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if candidate.is_file() or not fallback:
        return candidate
    return Path(sys.executable)


def check_process(pid):
    """os.kill(pid, 0) can terminate a process on Windows; never use it there."""
    import psutil
    try:
        process = psutil.Process(int(pid))
        if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
            raise psutil.NoSuchProcess(int(pid))
    except (psutil.NoSuchProcess, ValueError, TypeError) as exc:
        raise ProcessLookupError('Worker process no longer exists') from exc


if os.name != 'nt':
    import fcntl as file_lock
else:
    import portalocker

    class file_lock:
        LOCK_EX = portalocker.LOCK_EX
        LOCK_SH = portalocker.LOCK_SH
        LOCK_NB = portalocker.LOCK_NB
        LOCK_UN = portalocker.LOCK_UN

        @staticmethod
        def flock(handle, flags):
            # Windows uses 0 for LK_UNLCK; bitwise detection never matches it.
            if flags == portalocker.LOCK_UN:
                return portalocker.unlock(handle)
            try:
                return portalocker.lock(handle, flags)
            except portalocker.exceptions.LockException as exc:
                if flags & portalocker.LOCK_NB:
                    raise BlockingIOError(errno.EAGAIN, 'Worker lock already held') from exc
                raise
