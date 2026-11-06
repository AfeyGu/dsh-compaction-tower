/**
 * 纯逻辑烟测：不启动宿主，直接驱动 Session 与选段函数。
 *
 * 跑法：node test/smoke.mjs
 */
import { Session } from '@deepseek-ai/dsh-session';
import { DEFAULTS, resolveConfig } from '../lib/config.js';
import { appendBlock, appendCommit, blockHeader, checkpointIndex, checkpointOwner, nextBlockId, readBlocks, readCommits, refOf } from '../lib/core.js';
import { headRun, planCommits, planObservation, protectedTail, selectMergeRun, selectRawRun, usable } from '../lib/select.js';
import { Tower } from '../lib/tower.js';
import { closedStepEnd } from '../lib/core.js';

let passed = 0;
const failures = [];
function check(label, condition) {
  if (condition) { passed += 1; return; }
  failures.push(label);
}
function equal(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(`${label}（得到 ${a}，期望 ${e}）`, a === e);
}

// ── 配置 ────────────────────────────────────────────────────────────────
equal('默认配置可解析', resolveConfig({}).triggerRatio, DEFAULTS.triggerRatio);
let threw = false;
try { resolveConfig({ triggerRatio: 0.2, targetRatio: 0.3 }); } catch { threw = true; }
check('targetRatio >= triggerRatio 被拒', threw);
threw = false;
try { resolveConfig({ nope: 1 }); } catch { threw = true; }
check('未知配置项被拒', threw);

// ── 会话 + 块记录 ───────────────────────────────────────────────────────
const session = Session.create('tower-smoke');
const push = (text) => session.append('user/message', {
  id: `h_${Math.random().toString(16).slice(2, 10)}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
}, { surfaceOp: 'append' });

const s0 = push('第一条');
const s1 = push('第二条');
const s2 = push('第三条');
equal('表层节点数', session.surface.nodes.length, 3);

equal('无块时 readBlocks 为空', readBlocks(session).length, 0);
const recordSeq = appendBlock(session, {
  blockId: nextBlockId([]),
  tier: 1,
  covers: [s0.seq, s1.seq],
  summary: [{ type: 'text', text: '这里是摘要' }],
  coveredTokens: 8400,
  kind: 'run',
  origin: { provider: 'p', model: 'm' },
  createdAt: new Date().toISOString(),
});
check('appendPluginRecord 返回记录的 seq', typeof recordSeq === 'number');
equal('块记录可读回', readBlocks(session).map((b) => b.blockId), ['b00001']);
equal('块记录不进表层', session.surface.nodes.length, 3);
equal('下一个块号递增', nextBlockId(readBlocks(session)), 'b00002');

// ── checkpoint 身份：提交记录优先，正文块头只给老会话兜底 ────────────────
const checkpointText = (blockId) => `[${blockId} · T1 · 2 条 · m00000…m00001 · 原 1K tok]\n这里是摘要`;
const pushCheckpoint = (target, source, text) => target.append('user/message', {
  id: `h_${Math.random().toString(16).slice(2, 10)}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source,
}, { surfaceOp: 'append' });

const indexSession = Session.create('tower-index');
const checkpoint = indexSession.append('user/message', {
  id: 'h_cp',
  role: 'user',
  content: [{ type: 'text', text: checkpointText('b00001') }],
  source: { kind: 'compact-checkpoint', compactionId: 'c1' },
}, { surfaceOp: 'append' });
appendCommit(indexSession, { blockId: 'b00001', checkpointSeq: checkpoint.seq, compactionId: 'c1' });
equal('提交记录可读回', readCommits(indexSession).map((c) => [c.blockId, c.checkpointSeq]), [['b00001', checkpoint.seq]]);
equal('提交记录定位 checkpoint', checkpointIndex(indexSession).get('b00001'), checkpoint.seq);
equal('反向索引', checkpointOwner(indexSession).get(checkpoint.seq), 'b00001');

// 普通 user 消息里出现同形字面量，不能被误认成 checkpoint（老代码会误判）。
const fpSession = Session.create('tower-false-positive');
pushCheckpoint(fpSession, { kind: 'user' }, `让我看看 [b00009 · T1 · 2 条] 这个块`);
equal('正文里的同形字面量不算 checkpoint', checkpointIndex(fpSession).size, 0);

// 老会话没有提交记录：回落到正文块头，但要先过 source 校验。
const oldSession = Session.create('tower-old');
const oldCheckpoint = pushCheckpoint(oldSession, { kind: 'compact-checkpoint', compactionId: 'c2' }, checkpointText('b00002'));
equal('老会话按正文块头回落', checkpointIndex(oldSession).get('b00002'), oldCheckpoint.seq);

// 提交成功后当场记账：身份不依赖正文格式。
const tower = new Tower({}, resolveConfig({}));
const commitSession = Session.create('tower-commit');
const commitStart = commitSession.append('compaction/start', { compactionId: 'c9', turn: 1 });
const commitCheckpoint = pushCheckpoint(commitSession, { kind: 'compact-checkpoint', compactionId: 'c9' }, checkpointText('b00003'));
const commitEnd = commitSession.append('compaction/end', { compactionId: 'c9', turn: 1 });
tower.recordCheckpoint(commitSession, 'b00003', {
  startSeq: commitStart.seq, endSeq: commitEnd.seq, compactionId: 'c9',
});
equal('提交成功即写提交记录', checkpointIndex(commitSession).get('b00003'), commitCheckpoint.seq);

const emptySession = Session.create('tower-no-checkpoint');
const emptyStart = emptySession.append('compaction/start', { compactionId: 'c10', turn: 1 });
const emptyEnd = emptySession.append('compaction/end', { compactionId: 'c10', turn: 1 });
tower.recordCheckpoint(emptySession, 'b00004', {
  startSeq: emptyStart.seq, endSeq: emptyEnd.seq, compactionId: 'c10',
});
equal('找不到 checkpoint 时不写记录', readCommits(emptySession).length, 0);

// ── 摘要来源：compaction/summary 事件必须记真正写摘要的那个模型 ──────────
const sourceTower = new Tower({}, resolveConfig({}));
const sourceAgent = { session: { id: 's-source' }, options: { provider: 'main-p', model: 'main-m' } };
sourceTower.pending.set(sourceAgent.session, {
  block: {
    blockId: 'b00005',
    tier: 1,
    covers: [1],
    coveredTokens: 100,
    summary: [{ type: 'text', text: '摘要正文' }],
    childBlockIds: [],
    origin: { provider: 'magpie', model: 'auto/minimax-m3' },
  },
});
const served = await sourceTower.serveSummary({}, () => { throw new Error('不该走到宿主 summarize'); }, {}, sourceAgent, undefined);
equal('摘要来源取块自己的来源，不是主模型', [served.provider, served.model], ['magpie', 'auto/minimax-m3']);

// ── 摘要头 ──────────────────────────────────────────────────────────────
equal('T1 头部格式', blockHeader({
  blockId: 'b00007', tier: 1, covers: [12, 15, 18], coveredTokens: 8400, childBlockIds: [],
}), '[b00007 · T1 · 3 条 · m00012…m00018 · 原 8.4K tok]');
equal('T2+ 头部不给区间', blockHeader({
  blockId: 'b00011', tier: 2, covers: [5, 9, 12], coveredTokens: 9500, childBlockIds: ['b1', 'b2'],
}), '[b00011 · T2 · 3 条（含 2 个 T1 块）· 原 9.5K tok]');
equal('引用补零', refOf(7), 'm00007');

// ── 选段 ────────────────────────────────────────────────────────────────
const nodes = [
  { seq: 0, tokens: 1000, heuristicTokens: 1000 },
  { seq: 1, tokens: 2000, heuristicTokens: 2000 },
  { seq: 2, tokens: 3000, heuristicTokens: 3000 },
  { seq: 3, tokens: 4000, heuristicTokens: 4000 },
];
equal('跳过 system、止于受保护节点', headRun(nodes, {
  systemSeqs: new Set([0]), protectedSeqs: new Set([3]),
}).seqs, [1, 2]);
equal('可压缩区为空时返回 null', headRun(nodes, {
  systemSeqs: new Set([0, 1, 2, 3]), protectedSeqs: new Set(),
}), null);

// 提交计划：先 T1（只损一层），T1 不够才动 T2（若干 checkpoint 合成一条）。
const commitBlocks = [
  { blockId: 'b1', tier: 1, covers: [1, 2], coveredTokens: 5000, summaryTokens: 200 },
  { blockId: 'b2', tier: 1, covers: [3], coveredTokens: 4000, summaryTokens: 150 },
  { blockId: 'b3', tier: 2, covers: [5, 6], coveredTokens: 300, summaryTokens: 100 },
];
const allSurface = new Set([1, 2, 3, 5, 6]);
equal('T1 用尽仍不达标才动 T2', planCommits({
  blocks: commitBlocks, runSeqs: [1, 2, 3, 5, 6], surfaceSeqs: allSurface,
  contentTokens: 10000, targetTokens: 1000,
}).blocks.map((b) => b.blockId), ['b1', 'b2', 'b3']);
equal('T1 达标就不动 T2', planCommits({
  blocks: commitBlocks, runSeqs: [1, 2, 3, 5, 6], surfaceSeqs: allSurface,
  contentTokens: 10000, targetTokens: 3000,
}).blocks.map((b) => b.blockId), ['b1', 'b2']);
equal('达标即停，不多压', planCommits({
  blocks: commitBlocks, runSeqs: [1, 2, 3, 5, 6], surfaceSeqs: allSurface,
  contentTokens: 10000, targetTokens: 8000,
}).blocks.map((b) => b.blockId), ['b1']);
equal('材料不足以达标时全提交', planCommits({
  blocks: commitBlocks, runSeqs: [1, 2, 3, 5, 6], surfaceSeqs: allSurface,
  contentTokens: 10000, targetTokens: 0,
}).blocks.map((b) => b.blockId), ['b1', 'b2', 'b3']);
equal('已不在表层的块不能提交', planCommits({
  blocks: commitBlocks, runSeqs: [1, 2, 3, 5, 6], surfaceSeqs: new Set([5, 6]),
  contentTokens: 10000, targetTokens: 0,
}).blocks.map((b) => b.blockId), ['b3']);
equal('摘要不比原文小的块被剔除', planCommits({
  blocks: [{ blockId: 'b9', tier: 1, covers: [1], coveredTokens: 100, summaryTokens: 100 }],
  runSeqs: [1], surfaceSeqs: new Set([1]), contentTokens: 10000, targetTokens: 0,
}).blocks, []);

// 材料是否还可用：提交计划与分层库存共用的第一道筛。
equal('材料还在表层：可用', usable(
  { covers: [1, 2], coveredTokens: 100, summaryTokens: 10 }, { surfaceSeqs: new Set([1, 2]) },
), true);
equal('有 cover 已离开表层：不可用', usable(
  { covers: [1, 2], coveredTokens: 100, summaryTokens: 10 }, { surfaceSeqs: new Set([2]) },
), false);
equal('摘要不比原文小：不可用', usable(
  { covers: [1], coveredTokens: 100, summaryTokens: 100 }, { surfaceSeqs: new Set([1]) },
), false);
equal('空 covers：不可用', usable({ covers: [] }, { surfaceSeqs: new Set([1]) }), false);

// ── 分层库存：只算「材料还在」的块 ───────────────────────────────────────
// 塔外的压缩（宿主的 /compact、或老会话里已有的 checkpoint）会把一段历史换成
// 没有块号的 checkpoint。覆盖那段的块从此永远提交不了；库存若照旧算它们，
// 观察者会以为库存满了而停止补料。
const fakeSession = (surfaceSeqs, events) => ({
  surface: { nodes: surfaceSeqs },
  eventAt: (seq) => events.get(seq),
});
const textEvent = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
const liveEvents = new Map([[0, textEvent('一')], [1, textEvent('二')], [9, textEvent('九')]]);
const dormant = { blockId: 'b00001', tier: 1, covers: [0, 1], coveredTokens: 1000, summaryTokens: 100, childBlockIds: [] };

equal('材料都在表层：算库存', tower.inventoryOf(fakeSession([0, 1], liveEvents), [dormant]).get(1), 900);
equal('宿主兜底换掉一段后：不再算库存', tower.inventoryOf(fakeSession([7], liveEvents), [dormant]).size, 0);
equal('摘要不比原文小：不算库存', tower.inventoryOf(fakeSession([0, 1], liveEvents), [
  { ...dormant, summaryTokens: 1000 },
]).size, 0);
const nested = tower.inventoryOf(fakeSession([0, 1, 9], liveEvents), [
  dormant,
  { blockId: 'b00002', tier: 2, covers: [9], coveredTokens: 900, summaryTokens: 90, childBlockIds: ['b00001'] },
]);
equal('已被上层吃掉的块不算库存', nested.get(1), undefined);
equal('上层块本身照常算库存', nested.get(2), 810);

// ── step 边界：块必须按 step 对齐，否则提交会被宿主拒绝 ─────────────────
const stepEvents = [
  { seq: 0, type: 'system/message' },
  { seq: 1, type: 'step/start' },
  { seq: 2, type: 'assistant/message' },
  { seq: 3, type: 'tool/call' },
  { seq: 4, type: 'tool/result' },
  { seq: 5, type: 'step/end' },
  { seq: 6, type: 'step/start' },
  { seq: 7, type: 'assistant/message' },
];
const stepSession = { eventAt: (seq) => stepEvents.find((event) => event.seq === seq) };
equal('闭合 step 内的消息能取到 step 末尾', closedStepEnd(stepSession, 3), 5);
equal('step 第一条消息也算这个 step', closedStepEnd(stepSession, 1), 5);
equal('未闭合的 step 返回 null', closedStepEnd(stepSession, 7), null);
equal('不属于任何 step 的消息返回 null', closedStepEnd(stepSession, 0), null);

// ── 观察配额：从最底层开始发名额 ─────────────────────────────────────────
const observation = (available, inventory, concurrency = 4) => planObservation({
  available: new Map(available),
  inventory: new Map(inventory),
  reserveTokens: 200,   // 目标库存 200 token
  unitTokens: 50,       // 一个单位 50 token → 每层目标 4 个
  concurrency,
});
equal('只有底层有料时全给底层', observation([[1, 5]], []), [{ tier: 1, count: 4 }]);
equal('底层 2 个 + 二层 1 个，名额够就都发', observation([[1, 2], [2, 1]], []), [{ tier: 1, count: 2 }, { tier: 2, count: 1 }]);
equal('底层吃满名额，二层不发', observation([[1, 5], [2, 3]], [], 2), [{ tier: 1, count: 2 }]);
equal('某层库存已够就不发，把名额让给上层', observation([[1, 5], [2, 3]], [[1, 200]]), [{ tier: 2, count: 3 }]);
equal('库存够的层跳过、不够的层按缺口发', observation([[1, 5]], [[1, 150]]), [{ tier: 1, count: 1 }]);
equal('并发为 0 时什么都不发', observation([[1, 5]], [], 0), []);

equal('原文段跳过 system 与受保护尾', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set([3]),
  coveredSeqs: new Set(),
  checkpointSeqs: new Set(),
  minTokens: 1000,
  maxTokens: 12000,
}), [1, 2]);
equal('低于阈值不蒸馏', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set([3]),
  coveredSeqs: new Set(),
  checkpointSeqs: new Set(),
  minTokens: 9000,
  maxTokens: 12000,
}), []);
equal('遇 checkpoint 断开原文段', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set([3]),
  coveredSeqs: new Set(),
  checkpointSeqs: new Set([2]),
  minTokens: 100,
  maxTokens: 12000,
}), [1]);
equal('被块覆盖的消息不再进原文段', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set([3]),
  coveredSeqs: new Set([2]),
  checkpointSeqs: new Set(),
  minTokens: 100,
  maxTokens: 12000,
}), [1]);
// 攒够一个单位就收手：剩下的原文留给下一回合，避免一次吞掉一百多 K。
equal('攒够一个单位就收手', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set(),
  coveredSeqs: new Set(),
  checkpointSeqs: new Set(),
  minTokens: 2000,
  maxTokens: 200000,
  stopAtTokens: 2000,
}), [1]);
equal('旧料再多也只取一个单位', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set(),
  coveredSeqs: new Set(),
  checkpointSeqs: new Set(),
  minTokens: 3000,
  maxTokens: 200000,
  stopAtTokens: 3000,
}), [1, 2]);
equal('保险丝仍然生效（单个节点过大时截住）', selectRawRun(nodes, {
  systemSeqs: new Set([0]),
  protectedSeqs: new Set(),
  coveredSeqs: new Set(),
  checkpointSeqs: new Set(),
  minTokens: 1000,
  maxTokens: 2500,
  stopAtTokens: 100000,
}), [1]);

equal('checkpoint 够数才合并', selectMergeRun(nodes, {
  protectedSeqs: new Set([3]),
  checkpointSeqs: new Set([1]),
  tierOf: new Map([[1, 1]]),
  minCount: 2,
  minTokens: 1000,
  maxTokens: 12000,
}), []);
equal('相邻同层 checkpoint 可合并', selectMergeRun(nodes, {
  protectedSeqs: new Set([3]),
  checkpointSeqs: new Set([1, 2]),
  tierOf: new Map([[1, 1], [2, 1]]),
  minCount: 2,
  minTokens: 4000,
  maxTokens: 12000,
}), [1, 2]);
equal('不同层不混合合并', selectMergeRun(nodes, {
  protectedSeqs: new Set([3]),
  checkpointSeqs: new Set([1, 2]),
  tierOf: new Map([[1, 1], [2, 2]]),
  minCount: 2,
  minTokens: 100,
  maxTokens: 12000,
}), []);
equal('跳过够不成的老组，合并后面同层的一组', selectMergeRun(nodes, {
  protectedSeqs: new Set([3]),
  checkpointSeqs: new Set([0, 1, 2]),
  tierOf: new Map([[0, 3], [1, 1], [2, 1]]),
  minCount: 2,
  minTokens: 4000,
  maxTokens: 12000,
}), [1, 2]);
// 取料必须先按目标层过滤：不过滤的话，从最老的 checkpoint 扫起会先撞上更深的
// 那一组，拿回来一比对「合并出来不是我要的层」就整轮空手，浅层材料永远轮不到。
const tieredNodes = [
  { seq: 0, tokens: 1000 }, { seq: 1, tokens: 1000 }, { seq: 2, tokens: 1000 },
  { seq: 3, tokens: 1000 }, { seq: 4, tokens: 1000 },
];
const tieredOptions = {
  protectedSeqs: new Set(),
  checkpointSeqs: new Set([0, 1, 2, 3, 4]),
  tierOf: new Map([[0, 2], [1, 2], [2, 2], [3, 1], [4, 1]]),
  minCount: 2,
  minTokens: 2000,
  maxTokens: 12000,
};
equal('想要 T2 时只从 T1 取料', selectMergeRun(tieredNodes, { ...tieredOptions, memberTier: 1 }), [3, 4]);
equal('不指定成员层时仍取最老的一组', selectMergeRun(tieredNodes, tieredOptions), [0, 1]);
equal('超过单次合并上限就截断', selectMergeRun(nodes, {
  protectedSeqs: new Set(),
  checkpointSeqs: new Set([1, 2, 3]),
  tierOf: new Map([[1, 1], [2, 1], [3, 1]]),
  minCount: 2,
  minTokens: 4000,
  maxTokens: 5000,
}), [1, 2]);
// 合并和蒸馏共用同一把尺子：材料没攒到 5% 就不值得花一次调用。
equal('材料不够 5% 不合并', selectMergeRun(nodes, {
  protectedSeqs: new Set(),
  checkpointSeqs: new Set([1, 2]),
  tierOf: new Map([[1, 1], [2, 1]]),
  minCount: 2,
  minTokens: 6000,
  maxTokens: 12000,
}), []);
equal('攒够一个 5% 就收手，多的留给下一轮', selectMergeRun(nodes, {
  protectedSeqs: new Set(),
  checkpointSeqs: new Set([0, 1, 2, 3]),
  tierOf: new Map([[0, 1], [1, 1], [2, 1], [3, 1]]),
  minCount: 2,
  minTokens: 2500,
  maxTokens: 12000,
}), [0, 1]);
equal('已被上层块覆盖的 checkpoint 不再合并', selectMergeRun(nodes, {
  protectedSeqs: new Set(),
  coveredSeqs: new Set([1]),
  checkpointSeqs: new Set([1, 2]),
  tierOf: new Map([[1, 1], [2, 1]]),
  minCount: 2,
  minTokens: 100,
  maxTokens: 12000,
}), []);

equal('最近 2 步受保护', [...protectedTail([0, 1, 2, 3], [0, 2], 2)].sort((a, b) => a - b), [0, 1, 2, 3]);
equal('只保护最近 1 步', [...protectedTail([0, 1, 2, 3], [0, 2], 1)].sort((a, b) => a - b), [2, 3]);
equal('retain 0 时不保护', protectedTail([0, 1, 2, 3], [0, 2], 0).size, 0);
equal('没有 step 记录时不保护', protectedTail([0, 1], [], 3).size, 0);

// ── 事实修正系数：真实 token ÷ chars/4 估算 ────────────────────────────
// 宿主没有分词器，只有 provider 报的真实用量（整条请求一个数）。用它除以同一时刻的
// 估算量就得到系数，乘回所有估算值 —— 阈值、单位、块大小、面板全走这一把尺子。
// 保留两位：长会话里它会收敛，面板上的数字才不会每轮抖一下。
const fitTower = new Tower({}, resolveConfig({}));
const fitSession = { id: 'fit' };
const sample = (surfaceTokens, totalTokens, kind = 'usage') => ({ surfaceTokens, totalTokens, baseline: { kind } });
const fitOverhead = { system: 1000, tools: 1000, total: 2000 };
equal('没有真实用量时系数是 1', fitTower.calibration(fitSession, sample(401000, 0, 'estimated'), fitOverhead), 1);
// 510000 / (401000 + 1000) = 1.2686 → 1.27
equal('系数 = 真实 ÷ 估算（两位小数）', fitTower.calibration(fitSession, sample(401000, 510000), fitOverhead), 1.27);
// 平滑：1.27 × 0.7 + (520000 / 403000 = 1.2903) × 0.3 = 1.2761 → 1.28
equal('后续样本做平滑再取两位', fitTower.calibration(fitSession, sample(402000, 520000), fitOverhead), 1.28);
equal('没有真实用量时沿用已收敛的系数', fitTower.calibration(fitSession, sample(402000, 0, 'estimated'), fitOverhead), 1.28);

// ── 真值归因：两次请求的 prompt 差，就是这段材料真实占的 token ────────────
const txEvents = new Map([
  [0, { seq: 0, type: 'user/message', data: {} }],
  [1, { seq: 1, type: 'assistant/message', data: { usage: { inputTokens: 100000, outputTokens: 500 } } }],
  [2, { seq: 2, type: 'user/message', data: {} }],
  [3, { seq: 3, type: 'tool/result', data: {} }],
  [4, { seq: 4, type: 'assistant/message', data: { usage: { inputTokens: 130000, outputTokens: 400 } } }],
]);
const txSession = { id: 'tx', eventAt: (seq) => txEvents.get(seq) };
// 130000 − 100000 − 500（差分里混进的 before 输出）= 29500
equal('差分测出这段的真实占用', tower.realTokensOf(txSession, [2, 3], 20000), 29500);
equal('量级离谱（多半跨了压缩点）就放弃', tower.realTokensOf(txSession, [2, 3], 5000), null);
const shrunkEvents = new Map(txEvents);
shrunkEvents.set(4, { seq: 4, type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 400 } } });
equal('差分为负（区间跨过压缩）就放弃', tower.realTokensOf({ id: 'tx2', eventAt: (seq) => shrunkEvents.get(seq) }, [2, 3], 20000), null);
equal('缺 usage 边界就放弃', tower.realTokensOf({ id: 'tx3', eventAt: () => undefined }, [2, 3], 20000), null);

// ── 结果 ────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`✅ smoke: ${passed} 项全部通过`);
} else {
  console.error(`❌ smoke: ${passed} 通过 / ${failures.length} 失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
