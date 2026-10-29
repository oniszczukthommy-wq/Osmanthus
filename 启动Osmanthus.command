#!/bin/zsh
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
MUSIC_ROOT="${OSMANTHUS_MUSIC_DIR:-$SCRIPT_DIR/music-workbench}"
python3 "$MUSIC_ROOT/tools/osmanthus_web.py" start --open
if [[ $? -ne 0 ]]; then
  echo "请按 README 恢复音乐运行环境与工程数据。按回车关闭。"
  read
fi
