import { WM_TOOL_NAMES } from './wm-tools.generated.mjs';

/** 工具名清单（与 mcp/tools.mjs 的 TOOL_DEFS 保持一致，供技能/提示词引用自检）。
 * 前 13 个是 webnovel_* 本体；后 13 个 wm_* 来自 WritingMaster 套件（由 scripts/gen-wm-tools.mjs 生成）。 */
export const TOOL_NAMES = [
  'webnovel_init',
  'webnovel_status',
  'webnovel_books',
  'webnovel_outline',
  'webnovel_context',
  'webnovel_commit',
  'webnovel_query',
  'webnovel_pacing',
  'webnovel_review',
  'webnovel_memory',
  'webnovel_doctor',
  'webnovel_craft',
  'webnovel_restore',
];

// wm_* 追加在末尾：TOOL_DEFS 也是这个顺序（先是本体 13 个，再拼上套件 13 个）
TOOL_NAMES.push(...WM_TOOL_NAMES);

export default TOOL_NAMES;
