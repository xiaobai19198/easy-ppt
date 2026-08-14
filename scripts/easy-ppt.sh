#!/bin/sh
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
skill_dir=$(dirname -- "$script_dir")
runtime_dir="$skill_dir/.runtime"
cache_file="$runtime_dir/node-path.txt"
main_script="$script_dir/easy-ppt.mjs"

find_node_runtime() {
  if [ -f "$cache_file" ]; then
    cached=$(sed -n '1p' "$cache_file" 2>/dev/null)
    if [ -n "$cached" ] && [ -x "$cached" ]; then
      printf '%s\n' "$cached"
      return 0
    fi
  fi

  candidates=""
  if [ -n "${CODEX_NODE_PATH:-}" ]; then candidates="$CODEX_NODE_PATH"; fi
  for candidate in \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/node" \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/node" \
    "$HOME/.cache/codex-runtimes"/*/dependencies/node/bin/node \
    "$HOME/.cache/codex-runtimes"/*/dependencies/bin/override/node \
    "$HOME/.cache/codex-runtimes"/*/dependencies/bin/fallback/node
  do
    if [ -x "$candidate" ]; then
      if [ -z "$candidates" ]; then candidates="$candidate"; else candidates="$candidates
$candidate"; fi
    fi
  done
  if command -v node >/dev/null 2>&1; then
    system_node=$(command -v node)
    if [ -z "$candidates" ]; then candidates="$system_node"; else candidates="$candidates
$system_node"; fi
  fi

  old_ifs=$IFS
  IFS='
'
  for candidate in $candidates; do
    if [ -x "$candidate" ] && "$candidate" --version 2>/dev/null | grep -Eq '^v[0-9]+'; then
      IFS=$old_ifs
      mkdir -p "$runtime_dir" 2>/dev/null || true
      printf '%s\n' "$candidate" > "$cache_file" 2>/dev/null || true
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  IFS=$old_ifs
  return 1
}

node_runtime=$(find_node_runtime) || {
  printf '%s\n' '当前环境缺少 Node.js，Easy PPT 无法继续运行。请前往 https://nodejs.org 下载并安装 Node.js，然后新建会话重新使用 Easy PPT。' >&2
  exit 127
}

if [ "$#" -eq 1 ] && [ "$1" = '--runtime-check' ]; then
  printf '{"ok":true,"node":"%s","cached":true}\n' "$node_runtime"
  exit 0
fi

exec "$node_runtime" "$main_script" "$@"
