#!/usr/bin/env bash
# case 01 · wm-init：正常路径 + 边界（非法赛道/模式/参数/缺文件/重复初始化）
CASE=01-init
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"

echo "## 01-init — 初始化命令"

echo "### 正常路径"
# 默认目录（当前目录初始化）
( cd "$SBX" && ck_run 0 bash "$S/wm-init.sh" --track novel --title 测试书名 --target-words 300000 )
file_is "$SBX/.wm/state.json"
jget "$SBX/.wm/state.json" "o.track==='novel' && o.title==='测试书名' && o.target_words===300000 && o.mode==='auto' && o.chapter===0 && o.stage==='init'" "state.json 字段正确"
file_is "$SBX/.wm/ledger/names.tsv"
file_is "$SBX/.wm/commits.log"
out_has "下一步"

# 指定目录 + collab 模式
ck_run 0 bash "$S/wm-init.sh" --track romance --title 言情测试 --target-words 250000 --mode collab --dir "$SBX/proj2"
jget "$SBX/proj2/.wm/state.json" "o.track==='romance' && o.mode==='collab'" "指定目录+collab 模式生效"

# 五大赛道逐一初始化成功
for tr in novel romance screenplay jubensha toolbook; do
  ck_run 0 bash "$S/wm-init.sh" --track "$tr" --title "书-$tr" --target-words 100000 --dir "$SBX/p-$tr"
done

echo "### 边界与非法参数"
ck_run 1 bash "$S/wm-init.sh" --track poetry --title x --target-words 50000 --dir "$SBX/bad-track"
out_has "无效赛道"
ck_run 1 bash "$S/wm-init.sh" --track novel --title x --target-words 50000 --mode turbo --dir "$SBX/bad-mode"
out_has "无效模式"
ck_run 2 bash "$S/wm-init.sh" --title x --target-words 50000 --dir "$SBX/no-track"
out_has "缺少必填参数 --track"
ck_run 2 bash "$S/wm-init.sh" --track novel --target-words 50000 --dir "$SBX/no-title"
out_has "缺少必填参数 --title"
ck_run 2 bash "$S/wm-init.sh" --track novel --title x --dir "$SBX/no-words"
out_has "缺少必填参数 --target-words"
ck_run 1 bash "$S/wm-init.sh" --track novel --title x --target-words abc --dir "$SBX/words-abc"
out_has "target-words"
ck_run 1 bash "$S/wm-init.sh" --track novel --title x --target-words -5 --dir "$SBX/words-neg"
ck_run 1 bash "$S/wm-init.sh" --track novel --title x --target-words 0 --dir "$SBX/words-zero"
ck_run 2 bash "$S/wm-init.sh" --track novel --title "  " --target-words 50000 --dir "$SBX/blank-title"
out_has "--title"
# 重复初始化被拒
ck_run 1 bash "$S/wm-init.sh" --track novel --title 再来 --target-words 50000 --dir "$SBX"
out_has "已初始化"
# 帮助
ck_run 0 bash "$S/wm-init.sh" --help
out_has "用法"
