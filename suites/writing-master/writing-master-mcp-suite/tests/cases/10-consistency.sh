#!/usr/bin/env bash
# case 10 · 一致性冒烟：SKILL 文档 ↔ scripts 实现对齐 + 通用装机 + 技能互调接力
CASE=10-consistency
source "$(dirname "$0")/../lib.sh"
setup
S="$PKG/scripts"
NOUT="$SBX/.node-out"

# 判读 node 检查脚本输出：OK 开头行记 pass，✗/BAD 记 fail
judge() {
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      OK*) pass "${line#OK }";;
      *)   fail "$line";;
    esac
  done < "$NOUT"
}

echo "## 10-consistency — SKILL 与实现一致性 / 通用装机 / 技能互调"

echo "### A1. SKILL 引用的命令文件全部存在"
for f in $(grep -rhoE 'wm-[a-z]+\.sh' "$PKG/skills" --include='SKILL.md' | sort -u); do
  file_is "$S/$f"
done

echo "### A2. SKILL 用法行参数 ⊆ wm.js 实现参数（无幽灵参数）"
node - "$PKG" > "$NOUT" <<'N'
const fs = require('fs'), path = require('path');
const PKG = process.argv[2];
const src = fs.readFileSync(path.join(PKG, 'scripts/wm.js'), 'utf8');
const usage = {};
for (const m of src.matchAll(/(\w+): '用法: bash (wm-\w+)\.sh([^']+)'/g)) usage[m[2]] = [...m[3].matchAll(/--([a-z-]+)/g)].map(x => x[1]);
let bad = 0;
for (const [cmd, params] of Object.entries(usage)) {
  const re = new RegExp('wm-' + cmd + '\\.sh[^\\n]*', 'g');
  for (const d of fs.readdirSync(path.join(PKG, 'skills'))) {
    const sf = path.join(PKG, 'skills', d, 'SKILL.md');
    if (!fs.existsSync(sf)) continue;
    const txt = fs.readFileSync(sf, 'utf8');
    for (const line of txt.match(re) || []) for (const pm of line.matchAll(/--([a-z-]+)/g)) {
      if (!params.includes(pm[1])) { console.log(`✗ ${d}: wm-${cmd}.sh 用了实现不存在的参数 --${pm[1]}`); bad++; }
    }
  }
}
console.log(bad ? `BAD ${bad} 处幽灵参数` : 'OK SKILL 引用参数全部存在于实现');
N
judge

echo "### A3. 每条命令 --help 正常"
for c in init context commit review status archive restore doctor; do
  if bash "$S/wm-$c.sh" --help >"$OUT" 2>&1 && grep -q "用法" "$OUT"; then pass "wm-$c --help 输出用法"; else fail "wm-$c --help 异常"; fi
done

echo "### B. 全包相对引用完整性"
node - "$PKG" > "$NOUT" <<'N'
const fs = require('fs'), path = require('path');
const PKG = process.argv[2];
let bad = 0, n = 0;
const files = [];
/* 排除项：COMPARISON.md 是三方对标审计报告（引用的是外部项目路径，非本包引用）；
 * tests/REPORT.md 是每次测试自动再生的产物（内容含运行期输出）。二者均非包功能文档。 */
const EXCLUDE = new Set(['COMPARISON.md', path.join('tests', 'REPORT.md')]);
(function walk(d){ for (const f of fs.readdirSync(d)) { const p = path.join(d, f);
  if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.md')) files.push(p); } })(PKG);
for (const f of files) {
  if (EXCLUDE.has(path.relative(PKG, f))) continue;
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/(?:slices|templates|skills|scripts|knowledge)\/[A-Za-z0-9_\-\u4e00-\u9fff./*]+/g)) {
    let ref = m[0].replace(/[.,，；;）)】」`]+$/, '');
    if (ref.includes('*') || ref.includes('XXX') || ref.includes('<')) continue;
    if (/[\u4e00-\u9fff-]$/.test(ref) && !fs.existsSync(path.join(PKG, ref))) {
      /* 以连字/汉字结尾且紧邻 <赛道> 占位符的截断引用（如 skills/wm-<track>）非真实文件引用 */
      continue;
    }
    const target = ref.startsWith('slices/') ? 'knowledge/' + ref : ref;
    n++;
    if (!fs.existsSync(path.join(PKG, target))) { console.log(`✗ ${path.relative(PKG, f)} → ${ref} 不存在`); bad++; }
  }
}
console.log(bad === 0 ? `OK ${n} 处相对引用全部有效` : `BAD ${bad} 处失效引用`);
N
judge

echo "### C. index.json ↔ 切片双向一致（含字数口径）"
node - "$PKG" > "$NOUT" <<'N'
const fs = require('fs'), path = require('path');
const PKG = process.argv[2];
const idx = JSON.parse(fs.readFileSync(path.join(PKG, 'knowledge/index.json'), 'utf8'));
const slices = fs.readdirSync(path.join(PKG, 'knowledge/slices')).filter(f => f.endsWith('.md'));
const idxF = idx.map(e => e.file.replace(/^slices\//, ''));
let bad = 0;
for (const f of idxF) if (!slices.includes(f)) { console.log(`✗ 索引引用缺失文件: ${f}`); bad++; }
for (const f of slices) if (!idxF.includes(f)) { console.log(`✗ 切片未入索引: ${f}`); bad++; }
for (const e of idx) {
  const fp = path.join(PKG, 'knowledge', e.file);
  const raw = fs.readFileSync(fp, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) { console.log(`✗ ${e.id} 缺 frontmatter`); bad++; continue; }
  const fmWords = +(fm[1].match(/^words:\s*(\d+)/m) || [])[1];
  if (fmWords !== e.words) { console.log(`✗ ${e.id} frontmatter.words=${fmWords} ≠ index.words=${e.words}`); bad++; }
  const bodyN = raw.slice(fm[0].length).replace(/\s/g, '').length;
  if (Math.abs(bodyN - e.words) > 2) { console.log(`✗ ${e.id} 实际字数${bodyN} ≠ 标注${e.words}`); bad++; }
}
console.log(bad === 0 ? `OK index ${idx.length} 条与切片文件/字数完全一致` : `BAD ${bad} 处不一致`);
N
judge

echo "### D. 通用装机模拟（主路由 SKILL 装机方式A + 装机自检原文）"
INST="$SBX/writing-master"
cp -r "$PKG" "$INST"
ck_run 0 bash "$INST/scripts/wm-init.sh" --track novel --title 冒烟测试 --target-words 300000 --dir "$SBX/wm-smoke"
ck_run 0 bash "$INST/scripts/wm-doctor.sh" --dir "$SBX/wm-smoke"
out_has "全部通过"
rm -rf "$SBX/wm-smoke"
[ "$(ls "$INST/skills" | wc -l)" = "6" ] && pass "skills 恰好六个子目录（与主路由文档口径一致）" || fail "skills 子目录数 ≠ 6"
for c in init context commit review status archive restore doctor; do
  [ -x "$INST/scripts/wm-$c.sh" ] && pass "wm-$c.sh 可执行" || fail "wm-$c.sh 缺失或不可执行"
done

echo "### E. 技能互调链路（文件接力）"
for tr in novel romance screenplay jubensha toolbook; do
  f="$PKG/skills/wm-$tr/SKILL.md"
  if [ -s "$f" ]; then pass "主路由可接力到 wm-$tr"; else fail "wm-$tr/SKILL.md 缺失或为空"; fi
done
node - "$PKG" > "$NOUT" <<'N'
const fs = require('fs'), path = require('path');
const PKG = process.argv[2];
let bad = 0;
for (const tr of ['novel', 'romance', 'screenplay', 'jubensha', 'toolbook']) {
  const f = path.join(PKG, 'skills', 'wm-' + tr, 'SKILL.md');
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/slices\/([A-Za-z0-9_-]+)\.md/g)) {
    if (!fs.existsSync(path.join(PKG, 'knowledge/slices', m[1] + '.md'))) { console.log(`✗ wm-${tr} 引用切片不存在: ${m[1]}`); bad++; }
  }
  for (const m of txt.matchAll(/templates\/([^\s`|）)]+\.md)/g)) {
    if (m[1].includes('*')) continue;
    if (!fs.existsSync(path.join(PKG, 'templates', m[1]))) { console.log(`✗ wm-${tr} 引用模板不存在: ${m[1]}`); bad++; }
  }
  for (const m of txt.matchAll(/wm-(init|context|commit|review|status|archive|restore|doctor)\.sh/g)) {
    if (!fs.existsSync(path.join(PKG, 'scripts', m[0]))) { console.log(`✗ wm-${tr} 引用命令不存在: ${m[0]}`); bad++; }
  }
}
console.log(bad === 0 ? 'OK 五赛道 SKILL 的切片/模板/命令引用（含跨赛道加读）全部有效' : `BAD ${bad} 处失效`);
N
judge
# 状态共享：任意技能视角 restore 无损续接（新项目一句话恢复含续作指引）
ck_run 0 bash "$S/wm-init.sh" --track romance --title 互调验证 --target-words 100000 --dir "$SBX/e3"
ck_run 0 bash "$S/wm-restore.sh" --dir "$SBX/e3"
out_has "续作指引"

echo "### F. 互调工程基础：八命令输出均含「下一步」建议"
bash "$S/wm-init.sh" --track novel --title F链 --target-words 100000 --dir "$SBX/f-proj" > "$OUT" 2>&1
grep -q "下一步" "$OUT" && pass "wm-init 输出含下一步建议" || fail "wm-init 输出缺下一步建议"
for c in context status restore doctor; do
  bash "$S/wm-$c.sh" --dir "$SBX/f-proj" > "$OUT" 2>&1
  if grep -q "下一步" "$OUT"; then pass "wm-$c 输出含下一步建议"; else fail "wm-$c 输出缺下一步建议"; fi
done
cat > "$SBX/rf.md" <<'M'
# 稿

林昭夜里赶路，未见异常。
M
cat > "$SBX/rf.json" <<'J'
{"names": [{"name": "林昭", "new": true, "type": "person"}], "summary": {"chapter": 1, "one_line": "开局。", "hook_type": "悬念", "changes": ""}, "words_count": 1000}
J
bash "$S/wm-review.sh" --dir "$SBX/f-proj" --file "$SBX/rf.md" --chapter 1 > "$OUT" 2>&1
grep -q "下一步" "$OUT" && pass "wm-review 输出含下一步建议" || fail "wm-review 缺下一步建议"
bash "$S/wm-commit.sh" --dir "$SBX/f-proj" --file "$SBX/rf.json" > "$OUT" 2>&1
grep -q "下一步" "$OUT" && pass "wm-commit 输出含下一步建议" || fail "wm-commit 缺下一步建议"
bash "$S/wm-archive.sh" --dir "$SBX/f-proj" --part 1 > "$OUT" 2>&1
grep -q "下一步" "$OUT" && pass "wm-archive 输出含下一步建议" || fail "wm-archive 缺下一步建议"
