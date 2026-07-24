#!/bin/bash
# workbuddy-skin — 暂停皮肤，恢复原生界面（不重启 WorkBuddy）
unset ELECTRON_RUN_AS_NODE
cd "$(dirname "$0")/.."

NODE=""
for candidate in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
[ -z "$NODE" ] && NODE="node"

exec "$NODE" src/cli.mjs pause "$@"
