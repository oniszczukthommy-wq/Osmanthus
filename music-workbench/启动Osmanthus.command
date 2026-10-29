#!/bin/zsh
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
python3 "$SCRIPT_DIR/tools/osmanthus_web.py" start --open
if [[ $? -ne 0 ]]; then
  echo "启动未完成，请查看上面的提示。按回车关闭。"
  read
fi
