/**
 * 接管「蒸馏那一次 LLM 调用」。
 *
 * 为什么需要它：宿主 `summarizeWithLlm` 把指令写死在模块常量里，没有参数能换；
 * 想用自己的提示词，只能自己把这次请求发一遍。所以这里逐条照抄宿主的做法，
 * 少一条都会退化：
 *
 *   - 指令作为**最后一条 user 消息**（不是 system）→ 前缀缓存仍然复用，成本不涨；
 *   - `toolHistory` 与 `tools` 必须带上，否则摘要模型看不到工具调用与工具定义；
 *   - `purpose: 'compaction'` 是路由与计费的分类标记，不能丢；
 *   - `maxTokens` 是**防失控的保险丝**，不是剪摘要的剪刀：给 0 表示不传（交给模型自己的
 *     输出上限）。一旦撞上上限就会触发 max-tokens → 整块作废，所以这个值只应该设得很大；
 *     设小等于让蒸馏反复失败。
 *   - 出错 / 中断 / 截断一律算失败，绝不把半截摘要交回去写块。
 */
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm';

/**
 * 终止状态 → 错误。与宿主 compaction-basic 的同名私有实现一致。
 * @param {object} finish
 */
function finishError(finish) {
  if (finish === undefined) return undefined;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap');
    error.code = 'MAX_TOKENS';
    return error;
  }
  return undefined;
}

/** 摘要只要文本块（宿主的 summaryText 也是这个口径）。 */
function textOf(blocks) {
  return blocks.filter((part) => part.type === 'text');
}

/**
 * 用自己的指令发一次摘要请求。
 *
 * @param {object} params
 * @param {object} params.ctx 插件 context（要 `llm` 服务）
 * @param {object} params.session 会话（要 `toolHistory()` 与 `id`）
 * @param {string} params.provider 摘要模型
 * @param {string} params.model
 * @param {{messages: object[], tools?: object[]}} params.input 重放出来的材料
 * @param {string} params.instruction 末尾那条指令
 * @param {number} params.maxTokens 输出上限（保险丝）
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{summary: object[], provider: string, model: string, maxTokens: number, usage?: object}>}
 */
export async function requestSummary({ ctx, session, provider, model, input, instruction, maxTokens, signal }) {
  if (provider === '' || model === '') {
    throw new Error('compaction-tower: 自定义摘要提示词需要明确的 provider / model');
  }
  const assembler = new BlockAssembler();
  const messages = [
    ...input.messages,
    Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: instruction })]) }),
  ];
  const request = {
    provider,
    model,
    messages,
    toolHistory: session.toolHistory(),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    // 0 = 不设上限（交给适配器/模型自己的输出上限）。默认是一个很大但存在的保险丝。
    ...(maxTokens === undefined || maxTokens === 0 ? {} : { maxTokens }),
    sessionId: session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };

  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
  const failure = finishError(assembler.finish);
  if (failure !== undefined) throw failure;

  const summary = textOf(assembler.blocks());
  if (!summary.some((part) => typeof part.text === 'string' && part.text.trim().length > 0)) {
    throw new Error('compaction-tower: 摘要是空的（模型没有输出文本块）');
  }
  return {
    summary,
    provider,
    model,
    maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  };
}
