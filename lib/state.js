/**
 * UI 数据：把一块会话的压缩状态整理成一份纯 JSON。
 *
 * 这里是唯一的"给界面看"的出口：不依赖任何 UI 框架，也不写日志。
 * 块的三种状态全部从事件现算——不缓存，避免界面与账本不一致。
 */
import { blockText } from './tower.js';
import {
  checkpointIndex, formatTokens, refOf,
} from './core.js';

/**
 * 构造一份可序列化的状态快照。
 * @param {import('./tower.js').Tower} tower
 * @param {object} session
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function buildState(tower, session, signal) {
  const measurement = tower.ctx.tokenMeter.measure(session);
  // 固定开销（system + 工具 schema）不从窗口里扣掉，进度条就会把「还能塞 700K」
  // 画成可用空间。阈值与面板必须用同一个分母，所以两边都走 overheadOf。
  const overhead = tower.overheadOf(session, measurement.nodes);
  // 估算值统一乘事实修正系数，和 provider 报的真实 token 同一把尺子。
  const scale = tower.calibration(session, measurement, overhead);
  const blocks = tower.blocksOf(session);
  const surfaceSeqs = session.surface.nodes;
  const surface = new Set(surfaceSeqs);
  const checkpointOf = checkpointIndex(session);
  const childOf = new Set();
  for (const block of blocks) for (const id of block.childBlockIds ?? []) childOf.add(id);

  const header = session.requestHeader();
  const route = header?.config;
  const budget = await budgetOf(tower, route, signal);
  const messages = Math.max(0, Number(measurement.surfaceTokens ?? 0) - overhead.system);
  const content = Math.max(0, messages * scale);
  const usable = budget === null ? null : Math.max(1, budget - overhead.total * scale);

  return {
    session: {
      id: String(session.id),
      cwd: session.header?.cwd ?? null,
    },
    pressure: pressureOf(tower, session),
    observation: observationOf(tower, session),
    budget: {
      contextWindow: budget,
      total: measurement.totalTokens,
      content,
      fixed: { system: overhead.system, tools: overhead.tools, total: Math.round(overhead.total * scale), ratio: scale },
      usable,
      triggerTokens: usable === null ? null : Math.round(tower.config.triggerRatio * usable),
      targetTokens: usable === null ? null : Math.round(tower.config.targetRatio * usable),
      triggerRatio: tower.config.triggerRatio,
      targetRatio: tower.config.targetRatio,
      retainRecentGroups: tower.config.retainRecentGroups,
    },
    blocks: blocks.map((block) => ({
      blockId: block.blockId,
      tier: block.tier,
      kind: block.kind ?? 'run',
      covers: block.covers,
      coverRefs: block.covers.map(refOf),
      coveredTokens: block.coveredTokens ?? 0,
      summaryTokens: block.summaryTokens ?? 0,
      coveredLabel: formatTokens(block.coveredTokens ?? 0),
      summaryLabel: formatTokens(block.summaryTokens ?? 0),
      childBlockIds: block.childBlockIds ?? [],
      checkpointSeq: checkpointOf.get(block.blockId) ?? null,
      status: statusOf(block, checkpointOf, surface, childOf),
      createdAt: block.createdAt ?? null,
      origin: block.origin ?? null,
      summary: blockText(block),
    })),
    surface: surfaceSeqs.map((seq) => {
      const event = session.eventAt(seq);
      return {
        seq,
        ref: refOf(seq),
        type: event?.type ?? 'unknown',
        checkpoint: checkpointOf.size > 0 ? checkpointBlockOf(checkpointOf, seq) : null,
      };
    }),
    stats: { ...tower.stats },
  };
}

/** 会话里所有 checkpoint 节点：blockId → 该节点的 seq。 */
function checkpointBlockOf(index, seq) {
  for (const [blockId, at] of index) if (at === seq) return blockId;
  return null;
}

/**
 * 块状态：
 *   consumed  = 已被上层块覆盖（上层块的 childBlockIds 里有它）
 *   committed = 摘要节点仍在表层
 *   dormant   = 已蒸馏但还没进过上下文
 */
function statusOf(block, checkpointOf, surface, childOf) {
  if (childOf.has(block.blockId)) return 'consumed';
  const seq = checkpointOf.get(block.blockId);
  if (seq !== undefined && surface.has(seq)) return 'committed';
  return 'dormant';
}

/**
 * 上一次压力判定（为什么压 / 为什么没压）。只暴露可序列化的字段。
 * @param {object} tower
 * @param {object} session
 */
function pressureOf(tower, session) {
  const last = tower.lastPressure?.get(session);
  if (last === undefined || last === null) return null;
  return {
    at: last.at ?? null,
    kind: last.kind ?? null,
    total: last.total ?? null,
    content: last.content ?? null,
    fixed: last.fixed ?? null,
    usable: last.usable ?? null,
    trigger: last.trigger ?? null,
    budget: last.budget ?? null,
    blockIds: Array.isArray(last.blockIds) ? last.blockIds : null,
    blockCount: Array.isArray(last.blockIds) ? last.blockIds.length : null,
    projected: last.projected ?? null,
    blocks: Array.isArray(last.blocks) ? last.blocks.length : (last.blocks ?? null),
    run: last.run ?? null,
    calls: last.calls ?? null,
    outcome: last.outcome === undefined || last.outcome === null ? null : {
      planned: last.outcome.planned ?? 0,
      succeeded: last.outcome.succeeded ?? 0,
      error: last.outcome.error ?? null,
    },
  };
}

/**
 * 上一次观察判定（为什么蒸 / 为什么没蒸）。只暴露可序列化的字段。
 * @param {object} tower
 * @param {object} session
 */
function observationOf(tower, session) {
  const last = tower.lastObservation?.get(session);
  if (last === undefined || last === null) return null;
  return {
    at: last.at ?? null,
    kind: last.kind ?? null,
    unit: last.unit ?? null,
    protected: last.protected ?? null,
    plan: Array.isArray(last.plan) ? last.plan : null,
    available: Array.isArray(last.available) ? last.available : null,
  };
}

async function budgetOf(tower, route, signal) {
  if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') return null;
  try {
    return await tower.budgetOfRoute(route.provider, route.model, signal);
  } catch {
    return null;
  }
}
