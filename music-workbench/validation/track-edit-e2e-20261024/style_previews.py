"""Whitelist and inspect self-hosted style previews without disclosing paths."""
import os
from pathlib import Path

from media_paths import media_file

STYLE_PREVIEW_IDS = (
    'chinese-pop', 'heartfelt-ballad', 'urban-folk', 'chinese-rnb', 'city-pop', 'lofi',
    'dream-pop', 'pop-rock', 'indie-pop', 'chinese-style', 'electronic-dance', 'jazz-lounge',
    'cinematic', 'bright-acoustic', 'synth-pop', 'gentle-piano',
)


def style_preview_file(root, style_id):
    if style_id not in STYLE_PREVIEW_IDS:
        raise ValueError('文件不存在')
    return media_file(Path(root) / 'assets' / 'style-previews', style_id + '.mp3', ('.mp3',))


def available_style_previews(root):
    available = []
    for style_id in STYLE_PREVIEW_IDS:
        try:
            with style_preview_file(root, style_id).open('rb') as file:
                if os.fstat(file.fileno()).st_size > 0:
                    available.append(style_id)
        except (OSError, ValueError):
            continue
    return available
