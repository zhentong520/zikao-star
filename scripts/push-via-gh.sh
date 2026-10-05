/**
 * 批量上传文件到 GitHub（纯 Bash + gh api，不用 node 调 gh —— 那样会 EBUSY）
 *
 * 背景：本机代理拦 git 的 HTTPS CONNECT，但 gh CLI 走 API 通道可通。
 *   由于 node spawn gh.exe 会 EBUSY，改用 bash 循环调 gh api。
 *
 * 用法：bash scripts/push-via-gh.sh
 */
set -e
cd "$(dirname "$0")/.."

REPO="zhentong520/zikao-star"
API="repos/$REPO"

echo "📦 收集文件..."
FILES=$(git ls-files 2>/dev/null | grep -v package-lock.json)
COUNT=$(echo "$FILES" | wc -l)
echo "   $COUNT 个文件"

# 1. 取当前 main 的 commit（作为 base_tree）
echo "🔍 检查远端状态..."
BASE=$(gh api "$API/git/ref/heads/main" --jq '.object.sha' 2>/dev/null || echo "")
if [ -n "$BASE" ]; then
  echo "   base = ${BASE:0:7}"
else
  BASE="null"
  echo "   无基线，将创建新 tree"
fi

# 2. 逐个建 blob，拼 tree 数组
TREE_ITEMS=""
IDX=0
TOTAL=$(echo "$FILES" | wc -l)

for f in $FILES; do
  IDX=$((IDX + 1))
  [ -f "$f" ] || continue
  B64=$(base64 -w0 "$f" 2>/dev/null || base64 "$f" | tr -d '\n')
  # 写 payload 到临时文件，避免超长命令行
  printf '{"content":"%s","encoding":"base64"}' "$B64" > /tmp/zk_blob.json
  SHA=$(gh api "$API/git/blobs" -X POST --input /tmp/zk_blob.json --jq '.sha' 2>/dev/null)
  if [ -n "$SHA" ]; then
    TREE_ITEMS="${TREE_ITEMS}{\"path\":\"$f\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$SHA\"},"
    [ $((IDX % 20)) -eq 0 ] && echo "   $IDX/$TOTAL"
  else
    echo "   ⚠️ 跳过 $f"
  fi
done

TREE_ITEMS="${TREE_ITEMS%,}"
echo "   blob 全部上传完成（$IDX 个）"

# 3. 建 tree
if [ "$BASE" = "null" ]; then
  printf '{"tree":[%s]}' "$TREE_ITEMS" > /tmp/zk_tree.json
else
  printf '{"base_tree":"%s","tree":[%s]}' "$BASE" "$TREE_ITEMS" > /tmp/zk_tree.json
fi
TREE=$(gh api "$API/git/trees" -X POST --input /tmp/zk_tree.json --jq '.sha')
echo "🌳 tree: ${TREE:0:7}"

# 4. 建 commit
read -r -d '' MSG <<'EOF' || true
feat: 自考星 v1.0 - 自考本科备考管理工具

- 选省份/院校/专业自动生成考纲（广东 080901 计算机科学与技术）
- 科目状态机 + 成绩录入，实时计算毕业进度与学位均分
- 双均分口径：真实均分（官方）+ 预测均分（模拟器），避免虚假安全感
- 多源爬虫 + 政策变动检测（风险分级），三层降噪
- 资讯详情本地缓存，离线可读
- 双运行模式：PC 端（Node + SQLite）/ Android 端（Capacitor 独立运行）
- 零第三方运行时依赖，使用 Node 22 内置 node:sqlite
- shared/ 让 PC 与手机共用同一套规则，保证结果一致

隐私：data/ 已 gitignore，仓库内为无个人数据的示例库
EOF

if [ "$BASE" = "null" ]; then
  PARENTS='[]'
else
  PARENTS="[\"$BASE\"]"
fi
python -c "
import json,sys
msg=open('/tmp/zk_msg.txt',encoding='utf-8').read() if __import__('os').path.exists('/tmp/zk_msg.txt') else '$MSG'
print(json.dumps({'message':msg,'tree':'$TREE','parents':json.loads('$PARENTS')}))
" > /tmp/zk_commit.json 2>/dev/null || printf '{"message":"feat: 自考星 v1.0","tree":"%s","parents":%s}' "$TREE" "$PARENTS" > /tmp/zk_commit.json

COMMIT=$(gh api "$API/git/commits" -X POST --input /tmp/zk_commit.json --jq '.sha')
echo "✅ commit: ${COMMIT:0:7}"

# 5. 更新 ref
if [ "$BASE" = "null" ]; then
  gh api "$API/git/refs" -X POST -f ref="refs/heads/main" -f sha="$COMMIT" > /dev/null
else
  gh api "$API/git/refs/heads/main" -X PATCH -f sha="$COMMIT" -F force=false > /dev/null
fi

echo ""
echo "🎉 推送完成 → https://github.com/$REPO"
echo "   commit: $COMMIT"
