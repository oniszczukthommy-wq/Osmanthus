#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if /usr/bin/curl --silent --fail http://127.0.0.1:8792/api/capabilities >/dev/null; then
  echo 'Demo已运行，请打开 http://127.0.0.1:8792/'
  exit 0
fi
if ! command -v node >/dev/null; then
  echo '需要先安装 Node.js 22 或以上版本。'
  exit 1
fi
export MV_DISABLE_MODELS="${MV_DISABLE_MODELS:-1}"
exec node server.mjs
