/**
 * 提示词的测试：三档观察者指令、顾问的留空回退、以及「自己发那次摘要请求」的形状。
 *
 * 这里守的是三条容易退化的约定：
 *   1. 留空 / host 必须真的走宿主，不能悄悄接管；
 *   2. 接管时请求形状必须和宿主一致 —— 指令在末尾、带 toolHistory、带 purpose、输出上限给足；
 *   3. 截断一律算失败（半截摘要不许回去写块）。
 *
 * 跑法：node test/prompts.mjs
 */
import { Tower } from '../lib/tower.js';
import { advisorPersona, advisorRequest, summaryInstruction, SUMMARY_PROMPT_ZH, ADVISOR_SYSTEM, ADVISOR_PROMPT } from '../lib/prompts.js';
import { requestSummary } from '../lib/summarize.js';
import { resolveConfig } from '../lib/config.js';

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed += 1; return; }
  failures.push(detail === undefined ? label : `${label}（${detail}）`);
}

const base = resolveConfig({});

// ── 1. 三档指令 ─────────────────────────────────────────────────────────
check('默认（host）不接管，交给宿主', summaryInstruction(base) === null);
check('中文档给出中文指令', summaryInstruction({ ...base, summaryPromptMode: 'zh' }) === SUMMARY_PROMPT_ZH);
check('中文档保留了英文小节标题', SUMMARY_PROMPT_ZH.includes('## Primary Request and Intent')
  && SUMMARY_PROMPT_ZH.includes('## Critical Context'));
check('中文档明确要求中文正文', SUMMARY_PROMPT_ZH.includes('用简洁的中文技术叙述来写'));
check('中文档仍要求合并旧检查点', SUMMARY_PROMPT_ZH.includes('<compacted-summary>'));
check('自定义档用自己的文本', summaryInstruction({ ...base, summaryPromptMode: 'custom', summaryPrompt: '只写三条要点' }) === '只写三条要点');
check('自定义档留空则退回宿主', summaryInstruction({ ...base, summaryPromptMode: 'custom', summaryPrompt: '   ' }) === null);
check('未知档位按 host 处理', summaryInstruction({ ...base, summaryPromptMode: 'nope' }) === null);

// ── 2. 顾问：留空 = 内置 ────────────────────────────────────────────────
check('顾问人设留空用内置', advisorPersona(base) === ADVISOR_SYSTEM);
check('顾问请求留空用内置', advisorRequest(base) === ADVISOR_PROMPT);
check('内置档即使写了文本也用内置', advisorPersona({ ...base, advisorSystem: '写了但没切档' }) === ADVISOR_SYSTEM);
check('自定义档用人设覆盖', advisorPersona({ ...base, advisorSystemMode: 'custom', advisorSystem: '你是挑剔的架构师' }) === '你是挑剔的架构师');
check('自定义档用请求覆盖', advisorRequest({ ...base, advisorPromptMode: 'custom', advisorPrompt: '只回答一句话' }) === '只回答一句话');
check('自定义档留空退回内置人设', advisorPersona({ ...base, advisorSystemMode: 'custom', advisorSystem: '   ' }) === ADVISOR_SYSTEM);
check('自定义档留空退回内置请求', advisorRequest({ ...base, advisorPromptMode: 'custom', advisorPrompt: '' }) === ADVISOR_PROMPT);

// ── 3. requestSummary 的请求形状 ────────────────────────────────────────
const seen = [];
function fakeCtx(finish = { kind: 'stop' }, text = '中文摘要正文') {
  return {
    llm: {
      stream: (options) => {
        seen.push(options);
        return (async function* stream() {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: finish };
        }());
      },
    },
  };
}
const session = {
  id: 'session-prompts',
  toolHistory: () => [{ name: 'bash', arguments: {} }],
};
const input = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: '会话的 system' }] },
    { role: 'user', content: [{ type: 'text', text: '历史' }] },
  ],
  tools: [{ name: 'bash', parameters: {} }],
};

const produced = await requestSummary({
  ctx: fakeCtx(),
  session,
  provider: 'p',
  model: 'm',
  input,
  instruction: '用中文写检查点',
  maxTokens: 65536,
});
const request = seen.at(-1);
check('摘要请求带上了 provider/model', request.provider === 'p' && request.model === 'm');
check('指令是最后一条 user 消息', request.messages.at(-1).role === 'user'
  && request.messages.at(-1).content[0].text === '用中文写检查点');
check('原始材料一条不少', request.messages.length === input.messages.length + 1);
check('带上了 toolHistory', Array.isArray(request.toolHistory) && request.toolHistory.length === 1);
check('带上了 tools', Array.isArray(request.tools) && request.tools[0].name === 'bash');
check('purpose 是 compaction', request.purpose === 'compaction');
check('输出上限按配置给足', request.maxTokens === 65536);
check('sessionId 传给了宿主', request.sessionId === 'session-prompts');
check('返回文本摘要', produced.summary.length === 1 && produced.summary[0].text === '中文摘要正文');

// 上限填 0 = 不传，交给模型自己的输出上限（而不是发一个 maxTokens: 0 出去）
seen.length = 0;
await requestSummary({
  ctx: fakeCtx(),
  session,
  provider: 'p',
  model: 'm',
  input,
  instruction: 'x',
  maxTokens: 0,
});
check('上限 0 时不传 maxTokens 字段', !Object.hasOwn(seen.at(-1), 'maxTokens'), JSON.stringify(Object.keys(seen.at(-1))));

// 截断必须算失败：半截摘要绝不能回去写块。
let truncated = null;
try {
  await requestSummary({
    ctx: fakeCtx({ kind: 'max-tokens' }),
    session,
    provider: 'p',
    model: 'm',
    input,
    instruction: 'x',
    maxTokens: 1000,
  });
} catch (error) {
  truncated = error;
}
check('截断抛 MAX_TOKENS', truncated?.code === 'MAX_TOKENS', String(truncated));

// 路由不全要明确报错，不能静默发出去
let noRoute = null;
try {
  await requestSummary({ ctx: fakeCtx(), session, provider: '', model: '', input, instruction: 'x', maxTokens: 1000 });
} catch (error) {
  noRoute = error;
}
check('缺 provider/model 直接报错', noRoute !== null && String(noRoute.message).includes('provider'));

// ── 4. summarizeWithRoute：两条路径的切换 ───────────────────────────────
const engineCalls = [];
const engine = {
  config: { summarizationProvider: '', summarizationModel: '', maxTokens: 4000 },
  async summarize() {
    engineCalls.push('host');
    return { summary: [{ type: 'text', text: '宿主的摘要' }] };
  },
};
const agent = {
  session,
  options: { provider: 'p', model: 'm' },
};

const hostTower = new Tower({ llm: fakeCtx().llm }, resolveConfig({}));
engineCalls.length = 0;
seen.length = 0;
await hostTower.summarizeWithRoute(engine, input, agent, undefined);
check('默认档仍走宿主 summarize', engineCalls.length === 1 && seen.length === 0);

const zhTower = new Tower({ llm: fakeCtx().llm }, resolveConfig({ summaryPromptMode: 'zh' }));
engineCalls.length = 0;
seen.length = 0;
const zhOut = await zhTower.summarizeWithRoute(engine, input, agent, undefined);
check('中文档绕开宿主，自己发请求', engineCalls.length === 0 && seen.length === 1);
check('中文档确实用中文指令', seen.at(-1).messages.at(-1).content[0].text.includes('压缩引擎'));
check('中文档返回模型输出', zhOut.summary[0].text === '中文摘要正文');

// 自定义但路由不全：退回宿主，且不把蒸馏搞停
const partialTower = new Tower({ llm: fakeCtx().llm }, resolveConfig({ summaryPromptMode: 'custom', summaryPrompt: '自定义' }));
engineCalls.length = 0;
seen.length = 0;
await partialTower.summarizeWithRoute(engine, input, { session, options: {} }, undefined);
check('路由不全时退回宿主', engineCalls.length === 1 && seen.length === 0);

if (failures.length === 0) {
  console.log(`✅ prompts: ${passed} 项全部通过`);
} else {
  console.error(`❌ prompts: ${failures.length} 项失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
