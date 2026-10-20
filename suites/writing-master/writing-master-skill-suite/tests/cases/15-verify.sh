#!/usr/bin/env bash
# case 15 · wm-verify：四道门禁 + sha 锁动态生成/篡改检出/新增切片纳入 + CLI↔MCP 一致性
# 注：全部在沙箱副本上操作，不触碰真实包内容
CASE=15-verify
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"
CP="$SBX/pkg"

echo "## 15-verify — 包完整性门禁"
# 沙箱副本先剥离 lock.json/.tap/REPORT，模拟「无锁全新包」状态（lock 属运行期状态，非源码）
cp -r "$PKG" "$CP" && rm -rf "$CP/tests/.tap.txt" "$CP/tests/.run.log" "$CP/tests/REPORT.md" "$CP/knowledge/lock.json"

echo "### 全新包（无锁）：V1-V4 通过 + 无锁警告"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "V1 知识切片"
out_has "V2 模板引用"
out_has "V3 命令齐备"
out_has "未找到 knowledge/lock.json"

echo "### 全量（含 V4 冒烟）"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP"
out_has "V4 全链路冒烟"
out_has "【通过】"

echo "### sha 锁动态生成（以 index.json 当前内容为准）"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --update-lock --no-smoke
out_has "sha 锁已生成"
file_is "$CP/knowledge/lock.json"
jget "$CP/knowledge/lock.json" "o.slices.length===require('$CP/knowledge/index.json').length" "锁条目数 === 索引切片数（动态，无硬编码）"
SLICE_FILE=$(node -e "const i=require('$CP/knowledge/index.json');console.log(i[0].file)")
SLICE_ID=$(node -e "const i=require('$CP/knowledge/index.json');console.log(i[0].id)")
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "全部一致"

echo "### 篡改切片 → sha 检出 → 复锁回绿"
printf '\n<!-- 篡改测试 -->\n' >> "$CP/knowledge/$SLICE_FILE"
ck_run 1 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "sha 不一致"
out_has "$SLICE_ID"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --update-lock --no-smoke
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "全部一致"

echo "### 删除切片文件 → V1 检出"
rm "$CP/knowledge/$SLICE_FILE"
ck_run 1 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "切片文件缺失"
cp "$PKG/knowledge/$SLICE_FILE" "$CP/knowledge/$SLICE_FILE"

echo "### index.json 新增切片 → 锁自动要求补锁（动态纳入，无数量硬编码）"
cp "$PKG/knowledge/$SLICE_FILE" "$CP/knowledge/slices/extra-dynamic-test.md"
node -e "
const fs=require('fs');
const idx=JSON.parse(fs.readFileSync('$CP/knowledge/index.json','utf8'));
idx.push({id:'extra-dynamic-test',track:'novel',stage:'write',file:'slices/extra-dynamic-test.md',words:734,trigger:'动态测试'});
fs.writeFileSync('$CP/knowledge/index.json',JSON.stringify(idx,null,2)+'\n');
"
ck_run 1 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "锁内缺失 extra-dynamic-test"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --update-lock --no-smoke
jget "$CP/knowledge/lock.json" "o.slices.some(s=>s.id==='extra-dynamic-test')" "新切片被动态纳入锁"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "全部一致"

echo "### V3：删包装 → 检出；删 MCP 服务器 → 检出"
rm "$CP/scripts/wm-outline.sh"
ck_run 1 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "缺少脚本包装"
cp "$PKG/scripts/wm-outline.sh" "$CP/scripts/wm-outline.sh"
mv "$CP/scripts/mcp-server.mjs" "$SBX/mcp-backup.mjs"
ck_run 1 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "缺少 scripts/mcp-server.mjs"
mv "$SBX/mcp-backup.mjs" "$CP/scripts/mcp-server.mjs"

echo "### V2：SKILL 引用的模板缺失 → 检出"
TPL=$(ls "$CP/templates" | head -1)
mv "$CP/templates/$TPL" "$SBX/tpl-backup.md"
ck_run 1 bash "$S/wm-verify.sh" --root "$CP" --no-smoke
out_has "模板缺失"
mv "$SBX/tpl-backup.md" "$CP/templates/$TPL"

echo "### 恢复原状后全绿"
ck_run 0 bash "$S/wm-verify.sh" --root "$CP"
out_has "【通过】"

echo "### 真实包体检（只读，含冒烟）"
ck_run 0 bash "$S/wm-verify.sh" --no-smoke
out_has "【通过】"
