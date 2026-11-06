/**
 * 补丁行为测试：不启动宿主，用假的 engine/agent/session 走一遍
 * 「压力 → 选段 → 提交给引擎 → 摘要查表」的完整链路。
 *
 * 这一段是整个方案的心脏：提交路径上必须零 LLM 调用，
 * 且塔自己决定压不压，永远不把压缩交回宿主。
 *
 * 跑法：node test/patch.mjs
 */
import { Tower } from '../lib/tower.js';

const failures = [];
let passed = 0;
function check(label, condition) {
  if (condition) { passed += 1; return; }
  failures.push(label);
}

// ── 假会话：system + 三段用户消息 ────────────────────────────────────────
const types = { 0: 'system/message', 1: 'user/message', 2: 'user/message', 3: 'user/message' };
const events = new Map(Object.entries(types).map(([seq, type]) => [Number(seq), { seq: Number(seq), type }]));
const session = {
  id: 'tower-patch',
  header: { cwd: process.cwd() },
  surface: { nodes: [0, 1, 2, 3] },
  eventAt: (seq) => events.get(seq),
  deriveEventMessage: () => null,
};

const nodes = [
  { seq: 0, tokens: 1000, heuristicTokens: 1000 },
  { seq: 1, tokens: 2000, heuristicTokens: 2000 },
  { seq: 2, tokens: 3000, heuristicTokens: 3000 },
  { seq: 3, tokens: 4000, heuristicTokens: 4000 },
];

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tokenMeter: { measure: () => ({ nodes, surfaceTokens: 10000, totalTokens: 10000 }), estimateMessage: () => 10 },
  llm: { resolveModelInfo: async () => ({ context: { contextWindow: 10000 } }) },
};

const tower = new Tower(ctx, {
  triggerRatio: 0.45,
  targetRatio: 0.15,
  distillMinRunRatio: 0.05,
  retainRecentGroups: 1,
  observerMaxTokens: 16000,
  observerTimeoutMs: 300000,
  inlineMaxRatio: 0.02,
  hardMaxTokens: 40000,
  exportKeepSessions: 20,
  mergeMinBlocks: 2,
  advisorExpose: false,
  advisorProvider: '',
  advisorModel: '',
  advisorMaxTokens: 8000,
});

const block = {
  blockId: 'b00001',
  tier: 1,
  covers: [1],
  summary: [{ type: 'text', text: '第一条的摘要' }],
  coveredTokens: 2000,
  summaryTokens: 100,
};
tower.blocksOf = () => [block];

const agent = { session, options: { provider: 'p', model: 'm' }, ctx: { get: () => undefined } };
const signal = new AbortController().signal;

// ── 1. 有现成块：接管，并把摘要零成本交给引擎 ───────────────────────────
const calls = [];
let served = null;
const engine = {
  async compactRegion(start, end, owner, abort) {
    calls.push([start, end]);
    served = await tower.serveSummary(engine, async () => ({ summary: [{ type: 'text', text: '不该走到这里' }] }), { messages: [] }, owner, abort);
    return { startSeq: start, endSeq: end };
  },
};
const result = await tower.compactIfNeeded(engine, agent, 'pressure', signal);
check('进入 compactRegion', calls.length === 1);
check('压的是整块的首尾', calls[0][0] === 1 && calls[0][1] === 1);
check('摘要在提交路径上零 LLM', served?.summary?.[0]?.text?.includes('b00001'));
check('返回引擎的结果', result?.startSeq === 1);
check('pending 已清理', tower.pending.get(session) === undefined);
check('提交计数 +1', tower.stats.committed === 1 && tower.stats.served === 1);

// ── 1b. 块号分配：并发任务共享同一份 blocks 快照也不能撞号 ────────────────
const allocSession = { id: 'alloc' };
const idA = tower.allocateBlockId(allocSession, [{ blockId: 'b00001' }]);
const idB = tower.allocateBlockId(allocSession, [{ blockId: 'b00001' }]);
check('并发分配不会撞块号', idA !== idB, `${idA} / ${idB}`);
check('块号按已有最大号递增', idA === 'b00002' && idB === 'b00003', `${idA} / ${idB}`);

// ── 1c. 库存目标由公式推导，不再是配置项 ────────────────────────────────
// 窗口 10000、触发 0.45、目标 0.15、单位 0.05 → 缺口 3000 / 500 = 6，再 +1 安全垫
check('库存目标按公式算', tower.reserveUnitsOf(10000) === 7, String(tower.reserveUnitsOf(10000)));

// ── 2. 没有现成块：这次不压，也不交回宿主 ───────────────────────────────
// 交回宿主会压出一段没有块号的 checkpoint，塔的账本从此对不上账。
const noBlockTower = new Tower(ctx, tower.config);
noBlockTower.blocksOf = () => [];
const beforeNoBlock = calls.length;
const noBlockResult = await noBlockTower.compactIfNeeded(engine, agent, 'pressure', signal);
check('无块时不压', calls.length === beforeNoBlock);
check('无块时返回 null', noBlockResult === null);

// ── 3. 未到阈值：什么都不做 ─────────────────────────────────────────────
const relaxed = new Tower({ ...ctx, tokenMeter: { measure: () => ({ nodes, surfaceTokens: 1000, totalTokens: 1000 }), estimateMessage: () => 10 } }, tower.config);
relaxed.blocksOf = () => [block];
const idle = await relaxed.compactIfNeeded(engine, agent, 'pressure', signal);
check('未到阈值返回 null', idle === null);

// ── 3b. 分母扣掉固定开销：system 不进触发线 ──────────────────────────────
// 窗口 10000、system 1000 → 可用 9000，触发 0.45×9000 = 4050。
// 整条请求 5000 看着越线，但内容只有 4000，还差一点 —— 不该压。
const meter = (totalTokens) => ({ measure: () => ({ nodes, surfaceTokens: totalTokens, totalTokens }), estimateMessage: () => 10 });
const belowOverhead = new Tower({ ...ctx, tokenMeter: meter(5000) }, tower.config);
belowOverhead.blocksOf = () => [block];
const overheadIdle = await belowOverhead.compactIfNeeded(engine, agent, 'pressure', signal);
check('触发线按「窗口 − 固定开销」算', overheadIdle === null, String(overheadIdle));

// 内容越过 4050 就照常提交（整条请求 5100 → 内容 4100）。
const quietEngine = { async compactRegion(start, end) { return { startSeq: start, endSeq: end }; } };
const overOverhead = new Tower({ ...ctx, tokenMeter: meter(5100) }, tower.config);
overOverhead.blocksOf = () => [block];
const overheadCommit = await overOverhead.compactIfNeeded(quietEngine, agent, 'pressure', signal);
check('越过按可用预算算的触发线就压', overheadCommit !== null && overOverhead.stats.committed === 1);

// ── 4. 溢出：不交回宿主，改成「用手上的块强压一次」 ──────────────────────
// 交回宿主会在塔外压出一段没有块号的 checkpoint（真实会话里已经出现过一次）。
const beforeOverflow = calls.length;
const overflowResult = await tower.compactIfNeeded(engine, agent, 'context-overflow', signal);
check('context-overflow 用手上的块强压', calls.length === beforeOverflow + 1 && overflowResult !== null);

// ── 5. 宿主 summarize 是兜底，不是常态 ──────────────────────────────────
check('passthrough 计数只在无 pending 时增长', tower.stats.passthrough === 0);

// ── 6. 一次压力提交多块：按层级升序，逐块各走一次 compactRegion ─────────
const multiTower = new Tower(ctx, { ...tower.config, targetRatio: 0.05 });
multiTower.blocksOf = () => [
  { blockId: 'b00001', tier: 1, covers: [1], summary: [{ type: 'text', text: '低层' }], coveredTokens: 2000, summaryTokens: 100 },
  { blockId: 'b00002', tier: 1, covers: [2], summary: [{ type: 'text', text: '低层二' }], coveredTokens: 3000, summaryTokens: 100 },
];
const multiCalls = [];
const multiEngine = {
  async compactRegion(start, end) {
    multiCalls.push([start, end]);
    await multiTower.serveSummary(multiEngine, async () => ({ summary: [] }), { messages: [] }, agent, signal);
    return { startSeq: start, endSeq: end };
  },
};
await multiTower.compactIfNeeded(multiEngine, agent, 'pressure', signal);
check('多块提交按顺序各走一次', JSON.stringify(multiCalls) === JSON.stringify([[1, 1], [2, 2]]));
check('多块提交计数 +2', multiTower.stats.committed === 2);

// ── 7. T2 识别：checkpoint 消息正文里带块头 ────────────────────────────
const checkpointEvents = new Map([[
  10,
  {
    seq: 10,
    type: 'user/message',
    data: {
      source: { kind: 'compact-checkpoint', compactionId: 'c1' },
      content: [{ type: 'text', text: '<checkpoint>\n[b00001 · T1 · 1 条 · m00001…m00001 · 原 2.0K tok]\n第一条的摘要' }],
    },
  },
]]);
const checkpointSession = {
  ...session,
  surface: { nodes: [0, 1, 2, 3, 10] },
  eventAt: (seq) => checkpointEvents.get(seq),
};
const children = tower.childBlocksOf(checkpointSession, [10], [block]);
check('从 checkpoint 消息认出子块', children.length === 1 && children[0].blockId === 'b00001');
// 普通消息不是子块。eventAt 必须像真 session 一样越界返回 undefined。
const plainSession = {
  ...session,
  eventAt: (seq) => (seq === 1
    ? { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [] } }
    : undefined),
};
const notCheckpoint = tower.childBlocksOf(plainSession, [1], [block]);
check('普通消息不算子块', notCheckpoint.length === 0);

// ── 7b. 提交闸门是工具配对平衡，不是 step 边界 ──────────────────────────
// 真实的 compactRegion 在 step 之间跑（step/end → compaction/* → step/start），
// 所以 checkpoint 节点落在所有 step 之外。老代码按 step 找边界 → 返回 null →
// 合并块（T2/T3）永远提交不了，真实会话里两块 T2 从来没生成过 checkpoint。
const pairEvents = new Map([
  [0, { seq: 0, type: 'system/message', data: { content: [] } }],
  [1, { seq: 1, type: 'step/start' }],
  [2, { seq: 2, type: 'user/message', data: { content: [], source: { kind: 'user' } } }],
  [3, { seq: 3, type: 'step/end' }],
  [4, { seq: 4, type: 'user/message', data: { content: [], source: { kind: 'compact-checkpoint', compactionId: 'c1' } } }],
  [5, { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 't1', name: 'bash', arguments: {} }] } } }],
]);
const pairSession = {
  id: 'tower-pair',
  surface: { nodes: [0, 1, 2, 3, 4, 5], replaceGeneration: 1 },
  eventAt: (seq) => pairEvents.get(seq),
};
const pairSurface = new Set([0, 1, 2, 3, 4, 5]);
const mergeEnd = tower.balancedPrefixEnd(pairSession, [4], pairSurface);
check('checkpoint 落在 step 之外也能提交', mergeEnd === 4, String(mergeEnd));
const shrinkEnd = tower.balancedPrefixEnd(pairSession, [4, 5], pairSurface);
check('末位卡在工具调用中间就往前缩', shrinkEnd === 4, String(shrinkEnd));

// ── 8. advisor：旁路请求、提示词替换、不写表层 ─────────────────────────
const adviceSession = {
  id: 'tower-advisor',
  deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: '执行者的 system' }] },
    { role: 'user', content: [{ type: 'text', text: '做点事' }] },
  ],
};
const requests = [];
const advisorTower = new Tower({
  ...ctx,
  llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 10000 } }),
    stream: (options) => {
      requests.push(options);
      return (async function* stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '计划：先跑测试' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '计划：先跑测试' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }());
    },
  },
}, tower.config);
advisorTower.isLive = () => false;
const advice = await advisorTower.advise({ session: adviceSession, options: { provider: 'p', model: 'm' } }, signal);
check('advisor 返回评审文本', advice.text.includes('计划'));
check('advisor 换了 system 人设', requests[0].messages[0].content[0].text.includes('评审顾问'));
check('advisor 在尾部追加了请求', requests[0].messages.at(-1).content[0].text.includes('三选一'));
check('advisor 保留了执行者消息', requests[0].messages.some((message) => message.content?.[0]?.text === '做点事'));
check('advisor 用独立 purpose', requests[0].purpose === 'advisor');
check('advisor 默认跟随会话路由', requests[0].provider === 'p' && requests[0].model === 'm');

// ── 9. 观察者模型：配了就临时换引擎的摘要路由，换完立刻还原 ───────────────
const swapTower = new Tower({ ...ctx }, {
  ...tower.config,
  observerProvider: 'obs-p',
  observerModel: 'obs-m',
});
const swapSeen = [];
const swapEngine = {
  config: { thresholdRatio: 0.6, summarizationProvider: '', summarizationModel: '', maxTokens: 4000 },
  async summarize() {
    swapSeen.push({ provider: swapEngine.config.summarizationProvider, model: swapEngine.config.summarizationModel });
    return { summary: [{ type: 'text', text: '观察者的摘要' }] };
  },
};
const swapAgent = { session, options: { provider: 'p', model: 'm' }, ctx: { get: () => undefined } };
const swapped = await swapTower.summarizeWithRoute(swapEngine, { messages: [] }, swapAgent, signal);
check('观察者模型：调用期间换成配置的路由', swapSeen[0]?.provider === 'obs-p' && swapSeen[0]?.model === 'obs-m');
check('观察者模型：调用后引擎配置还原', swapEngine.config.summarizationProvider === '' && swapEngine.config.summarizationModel === '');
check('观察者模型：摘要原样返回', swapped.summary[0].text === '观察者的摘要');

const followSeen = [];
const followEngine = {
  config: { summarizationProvider: '', summarizationModel: '' },
  async summarize() {
    followSeen.push(followEngine.config.summarizationProvider);
    return { summary: [] };
  },
};
await tower.summarizeWithRoute(followEngine, { messages: [] }, swapAgent, signal);
check('观察者留空：不碰引擎配置', followSeen[0] === '');

if (failures.length === 0) {
  console.log(`✅ patch: ${passed} 项全部通过`);
} else {
  console.error(`❌ patch: ${failures.length} 项失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
