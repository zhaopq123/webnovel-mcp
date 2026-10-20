/**
 * 断点恢复包：把「写到哪了 / 手里有什么 / 下一章怎么接」压成一份可以整段贴给新会话的交接文档。
 *
 * 为什么需要它：换会话、换 Agent、隔几天回来接着写时，只调 status 看得到全局但没有任务书，
 * 只调 context 拿得到任务书但看不到全局待办；两份东西分开贴，接手的人要自己拼，
 * 而且很容易漏掉「还没定章纲」这种硬前置。这一层只是**拼装**，不引入新口径：
 * 数据全部来自 projectStatus() 与 doctorCheck()，与单独调用时逐字一致。
 */
import { projectStatus } from './status.js';
import { doctorCheck } from './doctor.js';

/** 恢复包最多提示几条待办：再多就不是「接手」，是给人看仓库。 */
const TODO_LIMIT = 5;

export function buildRestorePack(root, options = {}) {
  const status = projectStatus(root, { structure: options.structure ?? 'summary' });
  const doctor = doctorCheck(root);
  const errors = doctor.issues.filter((i) => i.severity === 'error');
  const warns = doctor.issues.filter((i) => i.severity === 'warn');

  const stats = status.stats ?? {};
  const title = status.project?.title ?? '';
  const nextChapter = Number.isFinite(stats.nextChapter) ? stats.nextChapter : null;
  const lines = [];

  lines.push(title ? `# 断点恢复包 ·《${title}》` : '# 断点恢复包');
  lines.push('');
  lines.push(`- 账本完整性：${errors.length === 0 ? '通过' : `❌ ${errors.length} 项错误`}`
    + `${warns.length ? `（另有 ${warns.length} 条提醒）` : ''}`);
  if (errors.length) {
    for (const e of errors.slice(0, 3)) lines.push(`  - [${e.code}] ${e.message}`);
    if (errors.length > 3) lines.push(`  - ……共 ${errors.length} 条，完整清单用 webnovel_doctor`);
  }
  lines.push(`- 已写：${stats.chaptersCommitted ?? 0} 章 / ${stats.totalWords ?? 0} 字｜`
    + `下一章：第 ${nextChapter ?? 1} 章`);
  if ((stats.uncommitted ?? []).length) {
    lines.push(`- ⚠️ 有正文但未提交：第 ${stats.uncommitted.join('、')} 章（先 webnovel_commit）`);
  }
  lines.push('');

  lines.push('## 一、现在的进度');
  // status.lines 末尾自带「待办：」整块，这里要把它摘掉——下面第二节会用结构化待办重列一遍，
  // 不摘就会出现「同一条待办出现两次」，接手的人会以为有两倍的事要做。
  const todoAt = status.lines.indexOf('待办：');
  const progressLines = todoAt >= 0 ? status.lines.slice(0, todoAt) : status.lines;
  for (const line of progressLines) lines.push(line);
  lines.push('');

  const todos = Array.isArray(status.todos) ? status.todos.slice(0, TODO_LIMIT) : [];
  lines.push('## 二、接手先做这几件');
  if (todos.length === 0) {
    lines.push('- 没有待办，直接取任务书开写。');
  } else {
    for (const t of todos) {
      const icon = t.priority === 'high' ? '🔴' : t.priority === 'low' ? 'ℹ️' : '🟡';
      const tool = t.tool ? `（用 ${t.tool}）` : '';
      lines.push(`- ${icon} ${t.action}${t.why ? `　— ${t.why}` : ''}${tool}`);
    }
  }
  lines.push('');

  lines.push('## 三、下一章怎么接');
  if (nextChapter !== null) {
    lines.push(`1. 先取任务书：\`webnovel_context chapter=${nextChapter}\`（本章必守规则、前情、主角状态、专名表都在里面）`);
    lines.push('2. 任务书若有 ⛔ 前置（通常是缺章纲），先 `webnovel_outline action=write_chapter` 补齐再动笔');
    lines.push('3. 写完先 `webnovel_review`，再 `webnovel_commit` 把人物/伏笔/时间线/剧情线的变化写回台账');
  } else {
    lines.push('1. 先 `webnovel_outline` 定大纲与第一章章纲');
    lines.push('2. 再用 `webnovel_context chapter=1` 取任务书开写');
  }
  lines.push('');

  lines.push('## 四、不可跳的三条');
  lines.push('- 没有章纲不动笔（「大纲即法律」，任务书会直接返回 blocker）');
  lines.push('- 写完必须提交事实增量，否则下一章的任务书是瞎的');
  lines.push('- 专名只能按台账锁定写法，新名字先与作者确认');

  return { text: lines.join('\n'), issues: errors.length, warnings: warns.length, stats };
}
