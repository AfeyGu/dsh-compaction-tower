/**
 * UI 数据层测试：不启动宿主，用假会话验证状态快照的形状与三种块状态。
 *
 * 跑法：node test/state.mjs
 */
import { buildState } from '../lib/state.js';
import { Tower } from '../lib/tower.js';

const failures = [];
let passed = 0;
function check(label, condition) {
  if (condition) { passed += 1; return; }
  failures.push(label);
}

// ── 假会话：system + 一段原文 + 一个 T1 checkpoint + 一个 T2 checkpoint ──
const checkpointText = (blockId, tier) => `<checkpoint>\n[${blockId} · T${tier} · 2 条 · m00001…m00002 · 原 2.0K tok]\n摘要正文`;

const events = new Map([
  [0, { seq: 0, type: 'system/message', data: { content: [{ type: 'text', text: 'system' }] } }],
  [1, { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '原文一' }] } }],
  [2, { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: '回答一' }] } }],
  [3, {
    seq: 3,
    type: 'user/message',
    data: { source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: checkpointText('b00002', 2) }] },
  }],
  [9, { seq: 9, type: 'plugin:tower/block', data: {} }],
]);

const session = {
  id: 'tower-state',
  header: { cwd: 'C:\\work' },
  surface: { nodes: [0, 1, 2, 3] },
  eventAt: (seq) => events.get(seq),
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
};

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tokenMeter: { measure: () => ({ nodes: [{ seq: 0, tokens: 5000, heuristicTokens: 5000 }], totalTokens: 12000 }), estimateMessage: () => 10 },
  llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) },
};

const config = {
  triggerRatio: 0.45, targetRatio: 0.15, distillMinRunRatio: 0.05, retainRecentGroups: 10,
  observerMaxTokens: 16000, observerTimeoutMs: 120000, inlineMaxRatio: 0.02, hardMaxTokens: 40000,
  exportKeepSessions: 20, mergeMinBlocks: 2, advisorExpose: false, advisorProvider: '',
  advisorModel: '', advisorMaxTokens: 8000,
};

const tower = new Tower(ctx, config);
tower.blocksOf = () => [
  { blockId: 'b00001', tier: 1, covers: [1, 2], coveredTokens: 2048, summaryTokens: 120, childBlockIds: [], kind: 'run', summary: [{ type: 'text', text: 'T1 摘要' }], createdAt: '2026-11-05T00:00:00.000Z' },
  { blockId: 'b00002', tier: 2, covers: [3], coveredTokens: 300, summaryTokens: 90, childBlockIds: ['b00001'], kind: 'distill', summary: [{ type: 'text', text: 'T2 摘要' }], createdAt: '2026-11-05T00:01:00.000Z' },
  { blockId: 'b00003', tier: 1, covers: [7], coveredTokens: 900, summaryTokens: 100, childBlockIds: [], kind: 'run', summary: [{ type: 'text', text: '还没提交' }], createdAt: '2026-11-05T00:02:00.000Z' },
];

const state = await buildState(tower, session);

check('给出会话 id', state.session.id === 'tower-state');
check('预算按「窗口 − 固定开销」算', state.budget.triggerTokens === 42750 && state.budget.targetTokens === 14250,
  `${state.budget.triggerTokens}/${state.budget.targetTokens}`);
check('固定开销单独报出来', state.budget.fixed.system === 5000 && state.budget.fixed.tools === 0
  && state.budget.fixed.total === 5000, JSON.stringify(state.budget.fixed));
check('内容与可用预算分开给', state.budget.content === 7000 && state.budget.usable === 95000,
  `${state.budget.content}/${state.budget.usable}`);
check('块数量与账本一致', state.blocks.length === 3);
check('被上层覆盖的块是 consumed', state.blocks[0].status === 'consumed');
check('摘要仍在表层的是 committed', state.blocks[1].status === 'committed');
check('没进过上下文的是 dormant', state.blocks[2].status === 'dormant');
check('块头带上块号与层级', state.blocks[1].blockId === 'b00002' && state.blocks[1].tier === 2);
check('覆盖引用可读', state.blocks[0].coverRefs.join(',') === 'm00001,m00002');
check('token 有可读标签', state.blocks[0].coveredLabel === '2.0K');
check('子块关系带出来', state.blocks[1].childBlockIds.join(',') === 'b00001');
check('checkpoint seq 可定位', state.blocks[1].checkpointSeq === 3);
check('表层节点带 checkpoint 归属', state.surface.find((node) => node.seq === 3)?.checkpoint === 'b00002');
check('顾问记录为空时给空数组', Array.isArray(state.advice) && state.advice.length === 0);

if (failures.length === 0) {
  console.log(`✅ state: ${passed} 项全部通过`);
} else {
  console.error(`❌ state: ${passed} 通过 / ${failures.length} 失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
