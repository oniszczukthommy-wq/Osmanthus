"""Resolve server-generated media filenames inside one trusted directory.

The same filename rules apply on every OS: URL routing alone does not reject
Windows drive paths, UNC paths, backslashes, device names or alternate streams.
"""
from pathlib import Path
import re


def media_file(directory, name, extensions):
    # These routes serve generated assets, never arbitrary user-supplied paths.
    # A literal percent is excluded so an extra URL decode cannot change meaning.
    if (not isinstance(name, str) or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.[a-z0-9]+', name) or
            Path(name).suffix not in extensions or
            name.split('.', 1)[0].upper() in
            {'CON', 'PRN', 'AUX', 'NUL', *('COM'+str(i) for i in range(1, 10)),
             *('LPT'+str(i) for i in range(1, 10))}):
        raise ValueError('无效文件')
    try:
        root = Path(directory).resolve(strict=True)
        file = (root/name).resolve(strict=True)
        # Exact parent comparison, not a string prefix (exports-elsewhere is
        # not exports). Resolving also rejects symlinks to another directory.
        if file.parent != root or not file.is_file():
            raise ValueError('无效文件')
        return file
    except (OSError, RuntimeError):
        raise ValueError('文件不存在或不可访问') from None
