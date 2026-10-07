#!/usr/bin/env bash
# 全量冒烟测试编排：bash 负责 dump 页面 DOM（绕开 Node spawn shim），Node 负责断言
#
# 用法：bash tests/smoke.sh [端口] [是否允许写操作=1/0，默认1]
# 前置：对应端口的服务已启动（建议用演示库）
set -e
cd "$(dirname "$0")/.."

PORT="${1:-5173}"
BASE="http://127.0.0.1:${PORT}"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
DOM_DIR="$(pwd)/tests/.dom"

mkdir -p "$DOM_DIR"

# 服务探活
if ! curl -s -o /dev/null "$BASE/api/bootstrap"; then
  echo "❌ 服务不可达：$BASE （先启动服务）"
  exit 1
fi

echo "🧪 全量冒烟测试 → $BASE"
echo "   第 1 步：dump 6 个页面 DOM（Edge headless）"
echo ""

dump() {
  local name="$1" query="$2"
  local out="$DOM_DIR/$name.html"
  rm -f "$out"
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=750,2000 \
    --dump-dom \
    --virtual-time-budget=11000 \
    --disable-features=ServiceWorker \
    "${BASE}/?shot=${query}" > "$out" 2>/dev/null || true
  local size
  size=$(wc -c < "$out" 2>/dev/null || echo 0)
  printf "  ✓ %-22s %s KB\n" "$name" "$(( size / 1024 ))"
}

dump "01-home"           ""
dump "02-courses"        "courses"
dump "03-course-detail"  "course=00023"
dump "04-degree"         "degree"
dump "05-news"           "news"
dump "06-calendar"       "cal"

echo ""
echo "   第 2 步：API + 页面断言（Node）"
echo ""
ZK_DOM_DIR="$DOM_DIR" node tests/smoke.js "$PORT"

# 清理
rm -rf "$DOM_DIR"
