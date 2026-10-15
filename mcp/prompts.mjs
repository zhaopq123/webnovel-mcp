/**
 * MCP Prompts：把插件原来的 6 个「技能」搬成 MCP 提示词。
 *
 * 这样即使客户端不装任何专家包，也能通过 prompts/list 拿到整套写作流程手册
 * （开书 / 规划 / 写章 / 审查 / 查询 / 沉淀经验）。
 */
import { registerSkills } from './skills-src.mjs';

const captured = [];
registerSkills({
  skills: {
    register(skill) {
      captured.push(skill);
      return () => {};
    },
  },
});

export const PROMPTS = captured;

export function listPrompts() {
  return PROMPTS.map((s) => ({
    name: s.name,
    description: `${s.description}（何时用：${s.whenToUse}）`,
    arguments: [],
  }));
}

export function getPrompt(name) {
  const skill = PROMPTS.find((s) => s.name === name);
  if (!skill) {
    throw new Error(`未知提示词：${name}。可用：${PROMPTS.map((p) => p.name).join(' / ')}`);
  }
  return {
    description: skill.description,
    messages: [{ role: 'user', content: { type: 'text', text: skill.content } }],
  };
}

export const PROMPT_NAMES = PROMPTS.map((p) => p.name);
