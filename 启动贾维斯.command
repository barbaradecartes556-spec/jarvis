#!/bin/bash
# 双击启动 J.A.R.V.I.S.：自动运行本地服务并用 Chrome 打开。关闭这个终端窗口即停止。
cd "$(dirname "$0")"
HERE="$(pwd -P)"
PORT=8765
URL="http://localhost:$PORT"

# 端口上如果已经有贾维斯在跑（比如旧版本文件夹里的），先把它关掉，保证打开的是这个文件夹里的版本
OLD=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "发现 $PORT 端口上已有服务在运行，先关掉它……"
  kill $OLD 2>/dev/null; sleep 1
  OLD=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null); [ -n "$OLD" ] && kill -9 $OLD 2>/dev/null && sleep 0.5
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "没找到 python3。请先安装：在终端运行 xcode-select --install ，或到 python.org 下载。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi

# Key 统一放在 个人文件夹/Jarvis/config.json，以后更新解压出新文件夹也不用重新填
CFG_DIR="$HOME/Jarvis"; CFG="$CFG_DIR/config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "$CFG_DIR"
  # 先找找以前的版本里有没有填好的 config.json（同一目录下的 jarvis、jarvis 2……），有就直接搬过去
  FOUND=""
  for f in "$HERE/config.json" "$HERE"/../jarvis*/config.json "$HERE"/../*/jarvis*/config.json; do
    if [ -f "$f" ] && grep -q '"[a-z_]*api_key"[[:space:]]*:[[:space:]]*"[A-Za-z0-9]' "$f"; then FOUND="$f"; break; fi
  done
  if [ -n "$FOUND" ]; then
    cp "$FOUND" "$CFG"; echo "已把之前填好的 Key 从 $FOUND 搬到 $CFG"
  else
    cp config.example.json "$CFG"
    echo ""
    echo "还没有填大模型的 Key。已经在 个人文件夹/Jarvis 里建好 config.json 并打开，填好 Key、保存，然后刷新网页即可。"
    open -e "$CFG"
  fi
fi

python3 server.py &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null "$URL" && break; sleep 0.3; done
open -a "Google Chrome" "$URL/?v=$(date +%s)" 2>/dev/null || open "$URL/?v=$(date +%s)"
echo ""
echo "J.A.R.V.I.S. 已启动：$URL （文件夹：$HERE）"
echo "用完关闭这个窗口即可。"
wait $SERVER_PID
