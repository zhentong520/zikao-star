#!/usr/bin/env bash
# GitHub API 推送编排（bash 拿输入 → Node fetch 推送）
#
# 用法：bash scripts/push-via-gh.sh [repo] [commit消息文件]
# 前置：gh 已登录
set -e
cd "$(dirname "$0")/.."

# 仓库：参数 > git remote
REPO="${1:-}"
if [ -z "$REPO" ]; then
  REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]##; s#\.git$##')
fi
[ -n "$REPO" ] || { echo "❌ 无法确定仓库"; exit 1; }

# token：gh 的 keyring（bash 调 gh 不受 Node spawn shim 影响）
TOKEN=$(gh auth token 2>/dev/null)
[ -n "$TOKEN" ] || { echo "❌ gh 未登录（gh auth login）"; exit 1; }

# 文件清单：git ls-files 天然处理 .gitignore，无需自己解析
LIST="$(mktemp)"
git ls-files > "$LIST"

# commit 消息：参数文件 > git log 最新一条
MSG="$(mktemp)"
if [ -n "$2" ] && [ -f "$2" ]; then
  cp "$2" "$MSG"
else
  git log -1 --pretty=%B > "$MSG" 2>/dev/null || echo "update" > "$MSG"
fi

# 关键：把 MSYS 路径转成 Windows 路径再传给 Node
# （Git Bash 的 /tmp 是 C:\Users\...\AppData\Local\Temp，node.exe 直接收 /tmp 会解析错）
winpath() { cygpath -w "$1"; }

node scripts/push-core.mjs "$REPO" "$TOKEN" "$(winpath "$LIST")" "$(winpath "$MSG")"

rm -f "$LIST" "$MSG"
