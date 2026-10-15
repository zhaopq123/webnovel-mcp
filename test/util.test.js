/**
 * 单元测试：纯函数（util）。
 * 运行：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords, sanitizeFilename, padChapter, getPath, setPath, deepMerge,
  mergeArray, uniqueBy, splitSections, parseFrontmatter, stripMarkdown,
  truncate, percent, toInt, firstParagraph, bodyOf,
} from '../lib/util.js';

test('countWords 统计中文按字计', () => {
  assert.equal(countWords('你好世界'), 4);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('countWords 忽略空白与 Markdown 标记', () => {
  const text = '# 标题\n\n这是**正文**，有标点。';
  // 标题行、正文汉字、标点都算；** 与 # 不算
  const n = countWords(text);
  assert.ok(n >= 10, `期望 >=10，实际 ${n}`);
  assert.ok(!String(n).includes('.'), '应是整数');
});

test('countWords 西文按字母计', () => {
  assert.equal(countWords('hello world'), 10);
});

test('sanitizeFilename 去掉 Windows 非法字符', () => {
  assert.equal(sanitizeFilename('拜入宗门'), '拜入宗门');
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(sanitizeFilename('   '), '未命名');
  assert.equal(sanitizeFilename(''), '未命名');
  assert.equal(sanitizeFilename(null), '未命名');
});

test('sanitizeFilename 限长并去尾部点空格', () => {
  const long = '一'.repeat(100);
  assert.equal(sanitizeFilename(long, 10).length, 10);
  assert.equal(sanitizeFilename('abc...'), 'abc');
});

test('padChapter 零填充', () => {
  assert.equal(padChapter(1), '0001');
  assert.equal(padChapter(12), '0012');
  assert.equal(padChapter('7'), '0007');
  assert.throws(() => padChapter('abc'), /非法章节号/);
});

test('getPath 点号路径读取', () => {
  const obj = { a: { b: { c: 1 } } };
  assert.equal(getPath(obj, 'a.b.c'), 1);
  assert.equal(getPath(obj, 'a.b'), obj.a.b);
  assert.equal(getPath(obj, 'a.x', 'fallback'), 'fallback');
  assert.equal(getPath(obj, ''), obj);
});

test('setPath 点号路径写入（含自动建层）', () => {
  const obj = {};
  setPath(obj, 'power.realm', '炼气三层');
  assert.deepEqual(obj, { power: { realm: '炼气三层' } });
});

test('deepMerge 深合并、数组整体替换', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] };
  const patch = { nested: { y: 9, z: 3 }, arr: [7] };
  assert.deepEqual(deepMerge(base, patch), {
    a: 1, nested: { x: 1, y: 9, z: 3 }, arr: [7],
  });
});

test('deepMerge 不修改原对象', () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { b: 2 } });
  assert.equal(base.a.b, 1);
});

test('mergeArray 去重合并', () => {
  assert.deepEqual(mergeArray(['a'], ['b', 'a', '', null]), ['a', 'b']);
  assert.deepEqual(mergeArray(null, ['x']), ['x']);
});

test('uniqueBy 按 key 去重且后者覆盖', () => {
  const out = uniqueBy([{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }], (i) => i.id);
  assert.equal(out.length, 2);
  assert.equal(out.find((i) => i.id === 1).v, 'c');
});

test('splitSections 按标题切分', () => {
  const md = '# A\ntext a\n## B\ntext b';
  const secs = splitSections(md);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].heading, 'A');
  assert.equal(secs[1].level, 2);
  assert.equal(secs[1].content, 'text b');
});

test('parseFrontmatter 解析简单标量与数组', () => {
  const md = '---\ntitle: 测试\nchapter: 12\ntags: [a, b]\n---\n正文';
  const fm = parseFrontmatter(md);
  assert.equal(fm.title, '测试');
  assert.equal(fm.chapter, '12');
  assert.deepEqual(fm.tags, ['a', 'b']);
});

test('parseFrontmatter 无 frontmatter 返回空对象', () => {
  assert.deepEqual(parseFrontmatter('正文'), {});
});

test('stripMarkdown 去掉常见标记', () => {
  assert.equal(stripMarkdown('# 标题'), '标题');
  assert.equal(stripMarkdown('**粗**'), '粗');
  assert.equal(stripMarkdown('[链接](http://x)'), '链接');
  assert.equal(stripMarkdown('`code`'), 'code');
});

test('truncate 截断加省略号', () => {
  assert.equal(truncate('abcdef', 3), 'ab…');
  assert.equal(truncate('abc', 10), 'abc');
});

test('percent 格式化', () => {
  assert.equal(percent(1, 2), '50%');
  assert.equal(percent(1, 3), '33.3%');
  assert.equal(percent(1, 0), '0%');
});

test('toInt 安全解析', () => {
  assert.equal(toInt('12'), 12);
  assert.equal(toInt('abc', 5), 5);
  assert.equal(toInt(undefined, 3), 3);
});

test('firstParagraph / bodyOf 取正文', () => {
  assert.equal(firstParagraph('# 标题\n\n第一段内容。\n第二段'), '第一段内容。');
  assert.equal(bodyOf('# 标题\n\n内容'), '内容');
});
