/**
 * `/advisor` 命令：用户手动请评审顾问看一遍当前上下文。
 *
 * 单独一个模块，因为 `@deepseek-ai/dsh-commands` 是可选依赖：
 * 只有确实装载了 commands 服务的 profile 才会动态导入这里。
 */
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';

/**
 * 注册 `/advisor`。
 * @param {object} ctx 带 commands 服务的 context
 * @param {import('./tower.js').Tower} tower
 * @returns {() => void} disposer
 */
export function registerAdvisorCommand(ctx, tower) {
  return ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-compaction-tower'),
    name: 'advisor',
    description: '请独立评审模型审查当前上下文，返回 计划/纠正/叫停 三种意见之一',
    handler: (invocation) => runAdvisor(tower, invocation),
  });
}

/** 执行一次评审，把可预期的失败翻成人类可读的结果。 */
async function runAdvisor(tower, invocation) {
  try {
    const answer = await tower.advise(invocation.agent, invocation.signal);
    return { kind: 'success', text: answer.text };
  } catch (error) {
    if (invocation.signal?.aborted === true) return { kind: 'error', text: '顾问评审已取消。' };
    return { kind: 'error', text: `顾问评审失败：${error?.message ?? String(error)}` };
  }
}
