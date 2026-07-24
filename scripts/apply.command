#!/bin/bash
# workbuddy-skin — 以 CDP 调试模式重启 WorkBuddy 并应用当前主题
set -e
unset ELECTRON_RUN_AS_NODE
cd "$(dirname "$0")/.."

APP="/Applications/WorkBuddy.app"
PORT="${WORKBUDDY_CDP_PORT:-9223}"

# 定位 node：优先 WorkBuddy 自带，其次 PATH
NODE=""
for candidate in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
[ -z "$NODE" ] && NODE="node"

if [ ! -d "$APP" ]; then
  echo "未找到 WorkBuddy.app，请确认安装在 /Applications/WorkBuddy.app" >&2
  exit 1
fi

echo "退出 WorkBuddy..."
osascript -e 'tell application "WorkBuddy" to quit' 2>/dev/null || true
for i in $(seq 1 10); do
  pgrep -f "/Applications/WorkBuddy.app/Contents/MacOS/Electron" >/dev/null 2>&1 || break
  sleep 1
done
pkill -f "/Applications/WorkBuddy.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 2

echo "以 CDP 调试模式重启（端口 $PORT）..."
nohup "$APP/Contents/MacOS/Electron" --remote-debugging-port="$PORT" > /tmp/workbuddy-skin-cdp.log 2>&1 &
disown

echo "等待 CDP 就绪..."
for i in $(seq 1 20); do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "CDP 就绪（${i}s）"
    break
  fi
  sleep 1
done

echo "应用皮肤..."
exec "$NODE" src/cli.mjs apply "$@"
