/**
 * 章节范围解析：`1-300`、`1-14,247,280`、`3`、`1-10 20-25` 都认。
 * 中文逗号、空白、全角波浪号也容忍；返回去重升序的章号数组。
 *
 * 设计原则：解析失败必须报清楚哪一段不认识，并给示例——批量接口一旦静默
 * 退化成「全部章节」，dry-run 也会变成误伤。
 */
export function parseChapterSpec(spec, { maxSpan = 20000 } = {}) {
  if (spec === undefined || spec === null) return null;
  const raw = String(spec).trim();
  if (!raw) return null;

  const out = new Set();
  for (const part of raw.split(/[,，;；\s]+/).filter(Boolean)) {
    const m = /^(\d+)\s*[-~～—]\s*(\d+)$/.exec(part);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      if (a <= 0) throw new Error(`章节号必须从 1 开始（收到「${part}」）`);
      if (b - a + 1 > maxSpan) {
        throw new Error(`章节范围过大（${a}-${b}，超过 ${maxSpan} 章）；请拆成多段`);
      }
      for (let n = a; n <= b; n += 1) out.add(n);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n <= 0) throw new Error(`章节号必须从 1 开始（收到「${part}」）`);
      out.add(n);
      continue;
    }
    throw new Error(`无法识别章节范围「${part}」。示例：1-300 / 1-14,247,280`);
  }
  return [...out].sort((a, b) => a - b);
}

/** 把章号数组压回紧凑写法（展示用）：[1,2,3,7] → "1-3,7" */
export function formatChapterSpec(chapters) {
  const nums = [...new Set((chapters ?? []).map(Number).filter((n) => n > 0))].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < nums.length; i += 1) {
    const start = nums[i];
    let end = start;
    while (i + 1 < nums.length && nums[i + 1] === end + 1) {
      i += 1;
      end = nums[i];
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(',');
}
