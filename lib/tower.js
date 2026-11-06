/**
 * Tower 的核心：提交策略 + 摘要供给 + 观察者。
 *
 * 分工：
 *   - 观察者（后台）把早期历史蒸馏成块记录，写进日志，模型看不见；
 *   - 提交（请求前）只做查表：把「已经蒸馏好的整块」交给引擎换进表层；
 *   - 摘要在提交路径上零 LLM 调用——这是整个方案存在的理由。
 */
import {
  appendBlock, appendCommit, blockHeader, checkpointIndex, checkpointOwner, closedStepEnd,
  describeMessage, iterateEvents, nextBlockId, readBlocks, refOf, roleLabel, stepStartSeqs,
} from './core.js';
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm';
import { isCompactCheckpointSource, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { summaryInstruction } from './prompts.js';
import { requestSummary } from './summarize.js';
import { headRun, planCommits, planObservation, protectedTail, selectMergeRun, selectRawRun, usable } from './select.js';

/**
 * 把流的终止状态翻成错误：出错/被中断/截断都算失败，正常结束返回 undefined。
 * 与 compaction-basic 的同名私有实现一致。
 * @param {object} finish
 */
function finishError(finish) {
  if (finish === undefined) return undefined;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('answer truncated at the token cap');
    error.code = 'MAX_TOKENS';
    return error;
  }
  return undefined;
}

/** 安全取服务：未注入或 context 已失效时返回 undefined，不抛。 */
function captureService(ctx, name) {
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 一块大约能回收它覆盖内容的多少。
 *
 * 提交一块换掉的是 covered（原文 / 下层摘要），换进来的是 summary（自己的摘要），
 * 所以真实回收 = covered − summary。实测约 92%，这里取 0.8 留余量。
 */
const RECLAIM_RATE = 0.8;

/** 把块记录变成模型可见的消息块。头部 + 正文。 */
export function summaryBlocks(block, childBlockIds = []) {
  const header = blockHeader({
    blockId: block.blockId,
    tier: block.tier,
    covers: block.covers,
    coveredTokens: block.coveredTokens,
    childBlockIds,
  });
  return [{ type: 'text', text: header }, ...block.summary];
}

/** 摘要记录的纯文本（搜索/UI 用）。 */
export function blockText(block) {
  return block.summary.map((part) => part.text ?? '').join('\n');
}

export class Tower {
  /**
   * @param {object} ctx 宿主 context（插件级）
   * @param {object} config 已校验的配置
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    // 服务引用必须在装载时抓住：回合结束后 context 会变成 inactive，
    // 那时再通过 ctx.sessions 取会抛 "cannot get required service … in inactive context"。
    this.sessions = captureService(ctx, 'sessions');
    /** 宿主投影：工具 schema 的 token 只能从这里拿（工具不是表层节点）。 */
    this.projections = captureService(ctx, 'sessionProjections');
    /** 提交时用于把「选中的整块」传给 summarize：WeakMap<Session, {block, seqs}> */
    this.pending = new WeakMap();
    /** 正在后台蒸馏的会话，避免同一会话同时排两批 */
    this.distilling = new WeakSet();
    /** 已分配但还没写入的块号（并发蒸馏防撞号） */
    this.pendingIds = new WeakMap();
    /** 已被在飞任务占用的 seq：并发蒸馏时防止两个任务挑到同一段材料 */
    this.reserved = new WeakMap();
    /** 上次请求前排程的时间，用来做 5 秒节流（每个 step 都全量测量太贵） */
    this.lastPump = new WeakMap();
    /** 上一次压力判定（面板用来回答「为什么没压」） */
    this.lastPressure = new WeakMap();
    /** 上一次观察判定（面板用来回答「为什么没蒸」） */
    this.lastObservation = new WeakMap();
    /** 诊断计数，便于日志确认补丁真的在工作 */
    this.stats = { distilled: 0, committed: 0, served: 0, passthrough: 0, failures: 0 };
    /**
     * 见过的压缩引擎：WeakMap<Agent, engine>。
     *
     * 压缩后端挂在 preset 的隔离组里，某些组合（例如 web）从 `agent.ctx` 取不到
     * 那个服务；但引擎自己会调用我们的补丁方法，那时 `this` 就是它 —— 顺手记下来，
     * 后台蒸馏与手动操作就不必再猜服务名。
     */
    this.engines = new WeakMap();
    /** 手动要求「立刻提交」的会话：下一个回合开始时执行一次全量提交。 */
    this.commitRequests = new WeakSet();
    /** 事实修正系数：WeakMap<Session, {scale, samples}>（见 calibration） */
    this.fits = new WeakMap();
  }

  /**
   * 换一份配置（配置界面保存后调用）。
   *
   * 所有读配置的地方都走 `this.config`，所以换掉这个对象即刻生效，
   * 不需要重启宿主，也不需要重建 Tower 实例。
   * @param {object} next 已校验的完整配置
   */
  updateConfig(next) {
    this.config = next;
    // 判定记录里的触发线、单位都是旧参数算出来的。不作废的话，面板会出现
    // 「进度条触发线 471.9K、上次判定触发线 314.6K」这种自相矛盾，一直挂到下次请求。
    this.lastPressure = new WeakMap();
    this.lastObservation = new WeakMap();
  }

  /** 补丁入口调用：记住「这个 agent 用的是哪个引擎实例」。 */
  rememberEngine(agent, engine) {
    // 按**会话**记，不按 agent 对象记：宿主在不同钩子里传进来的 agent 包装可能不是同一个引用。
    const session = agent?.session;
    if (session !== undefined && session !== null && engine !== undefined && engine !== null) {
      this.engines.set(session, engine);
    }
  }

  /**
   * 每层该备多少份库存：把「触发线 → 目标线」这段缺口填满，再留 1 份安全垫。
   *
   * 一块顶掉的不是它覆盖的全部原文，而是 covered − summary（摘要本身还占着）。
   * 实测回收率约 92%，这里按 80% 算 —— 模糊的正确：把份数放大一点，
   * 宁可多备一块，也别在越线那一刻差一点点。
   *
   * 不做成配置项 —— 它完全由 triggerRatio / targetRatio / 一个单位 推出来，
   * 手填只会和这三个数打架。
   * @param {number} usable 可用预算（窗口 − 固定开销）
   * @returns {{unit:number, reclaim:number, blocks:number, tokens:number}}
   */
  reserveOf(usable) {
    const unit = Math.max(1, this.config.distillMinRunRatio * usable);
    const reclaim = Math.max(1, Math.round(unit * RECLAIM_RATE));
    const gap = Math.max(0, this.config.triggerRatio - this.config.targetRatio) * usable;
    // 减一个极小量再 ceil：0.45−0.15 在浮点里是 0.30000000000000004，
    // 直接 ceil(6.000000000000001) 会多算一份。
    const blocks = Math.ceil(gap / reclaim - 1e-9) + 1;
    return { unit, reclaim, blocks, tokens: blocks * reclaim };
  }

  /**
   * 分配块号。并发蒸馏时多个任务各自持有同一份 blocks 快照，
   * 直接 nextBlockId() 会算出同一个号，所以这里把「已分配但还没写入」的号也占位。
   * @param {object} session
   * @param {Array<object>} blocks
   * @returns {string}
   */
  allocateBlockId(session, blocks) {
    let reserved = this.pendingIds.get(session);
    if (reserved === undefined) {
      reserved = new Set();
      this.pendingIds.set(session, reserved);
    }
    const taken = [...blocks.map((block) => block.blockId), ...reserved].map((blockId) => ({ blockId }));
    const id = nextBlockId(taken);
    reserved.add(id);
    return id;
  }

  /** 取该 agent 的压缩引擎：先用见过的实例，再回落服务查找。 */
  engineFor(agent) {
    const session = agent?.session;
    const seen = session === undefined || session === null ? undefined : this.engines.get(session);
    if (seen !== undefined) return seen;
    // 两条退路：插件自己的 context（profile 级），以及 agent 的 context。
    const candidates = [this.ctx, agent?.ctx];
    for (const ctx of candidates) {
      let found;
      try {
        found = ctx?.get?.('compaction');
      } catch {
        found = undefined;
      }
      if (found !== undefined && found !== null) {
        if (session !== undefined && session !== null) this.engines.set(session, found);
        return found;
      }
    }
    return undefined;
  }

  /** 诊断：TOWER_DEBUG=1 时把决策过程写进 stderr（不依赖 logger 是否可用）。 */
  debug(message) {
    if (process.env.TOWER_DEBUG !== '1') return;
    console.error(`tower[debug]: ${message}`);
  }

  /** 读出某个会话的全部块记录。 */
  blocksOf(session) {
    return readBlocks(session);
  }

  /**
   * 把刚追加的记录落盘。
   *
   * 宿主的持久化检查点在「每次请求」前后，回合结束后的后台追加不在检查点里；
   * 不主动 flush，进程退出（headless 一次性任务）就会把块丢掉。
   */
  async flushSession(agent, session) {
    for (const [label, service] of [['plugin', this.sessions], ['agent', captureService(agent?.ctx, 'sessions')]]) {
      try {
        if (service && typeof service.flush === 'function') {
          await service.flush(session);
          this.debug(`flush 完成（${label}）`);
          return;
        }
      } catch (error) {
        this.debug(`flush 失败（${label}）: ${error?.message ?? error}`);
      }
    }
    this.debug('没有 flush 通道，块记录只留在内存里');
  }

  /**
   * 表层上的 system 节点：恒占窗口、永不压缩，阈值分母要先扣掉。
   * @param {object} session
   * @param {ReadonlyArray<{seq:number}>} nodes
   * @returns {Set<number>}
   */
  systemSeqsOf(session, nodes) {
    const systemSeqs = new Set();
    for (const node of nodes) {
      if (session.eventAt(node.seq)?.type === 'system/message') systemSeqs.add(node.seq);
    }
    return systemSeqs;
  }

  /**
   * 工具 schema 占多少 token。
   *
   * 工具不是表层节点，唯一的来源是宿主 tokenMeter 的 `contextBreakdown` 投影。
   * 服务不在或读失败就当 0 —— 固定开销只会算少，不会算多。
   * @param {object} session
   * @returns {number}
   */
  toolsTokens(session) {
    const projections = this.projections;
    if (projections === undefined || typeof projections.snapshot !== 'function') return 0;
    try {
      const breakdown = projections.snapshot(session, ['contextBreakdown'])?.values?.contextBreakdown;
      const tokens = Number(breakdown?.toolsTokens ?? 0);
      return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 固定开销：system 提示词 + 工具 schema。
   *
   * 这两块恒占窗口、永远不会被压缩，所以「内容」与「预算」都要先扣掉它们：
   * 阈值按可用预算算，进度条把它们画成最前面那一段。
   *
   * @param {object} session
   * @param {ReadonlyArray<{seq:number, tokens:number}>} nodes
   * @returns {{systemSeqs: Set<number>, system: number, tools: number, total: number}}
   */
  overheadOf(session, nodes) {
    const systemSeqs = this.systemSeqsOf(session, nodes);
    let system = 0;
    for (const node of nodes) if (systemSeqs.has(node.seq)) system += node.tokens ?? 0;
    const tools = this.toolsTokens(session);
    return { systemSeqs, system, tools, total: system + tools };
  }

  /**
   * 事实修正系数：把 chars/4 的估算折算成 provider 报的真实 token。
   *
   * 宿主没有分词器，只有两种数：provider 每次响应里的真实用量（整条请求一个数），
   * 和每条消息的 chars/4 估算。中文被估算低估三成，实测整条请求的
   * 「真实 / 估算」≈ 1.25，而且会随内容构成漂移。
   *
   * 所以每次拿到真实用量就重算一次并做平滑，再乘到所有估算值上：
   * 阈值、单位、块大小、面板显示全部走同一把尺子。
   *
   * 注意它同时放大了 system + 工具 schema —— 那部分只有 4K 量级，
   * 放大后仍小于真实值（实测 26K），差的 20K 在 1M 窗口里是 2%，不值得再引入第二个参数。
   *
   * @param {object} session
   * @param {object} measurement tokenMeter.measure 的结果
   * @param {object} overhead overheadOf 的结果
   * @returns {number} ≥1 的换算系数；没有真实用量时是 1
   */
  calibration(session, measurement, overhead) {
    let fit = this.fits.get(session);
    if (fit === undefined) {
      fit = { scale: 1, samples: 0 };
      this.fits.set(session, fit);
    }
    const estimated = Number(measurement.surfaceTokens ?? 0) + Number(overhead.tools ?? 0);
    const total = Number(measurement.totalTokens ?? 0);
    if (measurement.baseline?.kind === 'usage' && total > 0 && estimated > 5000) {
      const ratio = total / estimated;
      if (Number.isFinite(ratio) && ratio > 0.5 && ratio < 4) {
        const smoothed = fit.samples === 0 ? ratio : fit.scale * 0.7 + ratio * 0.3;
        // 保留两位：长会话里它会收敛成一个稳定值，面板上的 token 数不会每轮抖一下。
        fit.scale = Math.round(smoothed * 100) / 100;
        fit.samples += 1;
      }
    }
    return fit.scale;
  }
  /**
   * 用 usage 差分测一段材料的真实 token。
   *
   * 第 n 次请求的 prompt 是「此前所有消息 + system + 工具」。所以
   * `prompt(区间后第一条) − prompt(区间前最后一条)` 就是这两次之间新增的消息
   * 一共占了多少真实 token —— 也就是这段材料在请求里真实的花费。
   *
   * 只在两端都找得到、且量级合理时返回；跨过压缩或裁剪的区间会算出负数或者
   * 离谱的倍数，一律返回 null，让调用方退回「估算 × 系数」。
   *
   * @param {object} session
   * @param {number[]} seqs 升序 seq
   * @param {number} estimated 同一段的估算值，用来做量级校验
   * @returns {number|null}
   */
  realTokensOf(session, seqs, estimated) {
    if (seqs.length === 0) return null;
    const first = seqs[0];
    const last = seqs[seqs.length - 1];
    let before = null;
    let after = null;
    for (const event of iterateEvents(session)) {
      if (event.type !== 'assistant/message' || event.data?.usage === undefined) continue;
      if (event.seq < first) before = event;
      else if (event.seq > last) { after = event; break; }
    }
    if (before === null || after === null) return null;
    const promptOf = (event) => {
      const usage = event.data.usage ?? {};
      return Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0);
    };
    // 差分把 before 那条 assistant 也算了进去（它在 first 之前），减掉它的输出。
    const real = promptOf(after) - promptOf(before) - Number(before.data.usage?.outputTokens ?? 0);
    if (!Number.isFinite(real) || real <= 0) return null;
    const ratio = real / Math.max(1, estimated);
    if (ratio < 0.4 || ratio > 5) return null;
    return Math.round(real);
  }

  /**
   * 把表层节点分成三类：system（永不动）、受保护（最近 N 步）、其余。
   * @param {object} session
   * @param {ReadonlyArray<{seq:number}>} nodes
   * @param {Set<number>} [systemSeqs] 已经算过就传进来，省一次扫描
   */
  classify(session, nodes, systemSeqs = this.systemSeqsOf(session, nodes)) {
    const surfaceSeqs = session.surface.nodes;
    const protectedSeqs = protectedTail(surfaceSeqs, stepStartSeqs(session), this.config.retainRecentGroups);
    const checkpointSeqs = new Set();
    for (const seq of surfaceSeqs) {
      const event = session.eventAt(seq);
      const source = event?.type === 'user/message' ? event.data?.source : undefined;
      if (source !== undefined && isCompactCheckpointSource(source)) checkpointSeqs.add(seq);
    }
    return { systemSeqs, protectedSeqs, checkpointSeqs, surfaceSeqs: new Set(surfaceSeqs) };
  }

  /**
   * 取当前路由的上下文窗口（token）。拿不到就返回 null，调用方放弃压缩。
   * @param {object} agent
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<number|null>}
   */
  /**
   * 当前该用哪个上下文窗口。
   *
   * **优先用会话最近一次请求的路由**，其次才是 agent.options ——
   * 面板（state.js）和提交判定（这里）必须用同一个来源，否则会出现
   * 「面板显示越线了、判定却拿不到窗口直接跳过」这种前后矛盾。
   *
   * @param {object} agent
   * @param {AbortSignal} [signal]
   * @returns {Promise<number|null>}
   */
  async budgetOf(agent, signal) {
    const header = agent.session?.requestHeader?.()?.config;
    if (typeof header?.provider === 'string' && header.provider !== ''
      && typeof header?.model === 'string' && header.model !== '') {
      const routed = await this.budgetOfRoute(header.provider, header.model, signal);
      if (routed !== null) return routed;
    }
    return this.budgetOfRoute(agent.options?.provider, agent.options?.model, signal);
  }

  /**
   * 按 provider/model 取上下文窗口。拿不到返回 null（调用方据此放弃压缩）。
   * @param {string|undefined} provider
   * @param {string|undefined} model
   * @param {AbortSignal|undefined} signal
   * @returns {Promise<number|null>}
   */
  async budgetOfRoute(provider, model, signal) {
    if (typeof provider !== 'string' || typeof model !== 'string') return null;
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model, signal);
      const window = info?.context?.contextWindow;
      return Number.isFinite(window) && window > 0 ? window : null;
    } catch {
      return null;
    }
  }

  /**
   * 压力触发时决定「压哪一块」。
   * @param {object} agent
   * @param {AbortSignal} [signal]
   * @param {{force?: boolean}} [options] force = 手动要求，忽略触发线、按目标 0 全提交
   * @returns {Promise<{kind:'skip'}|{kind:'no-block'}|{kind:'commit', blocks:object[]}>}
   */
  async planPressure(agent, signal, options = {}) {
    const force = options.force === true;
    const budget = await this.budgetOf(agent, signal);
    if (budget === null) {
      this.lastPressure.set(agent.session, { at: Date.now(), kind: 'no-window' });
      this.debug('量不到上下文窗口，这次不压');
      return { kind: 'no-window' };
    }
    const session = agent.session;
    const measurement = this.ctx.tokenMeter.measure(session);
    const nodes = measurement.nodes;
    // 固定开销（system + 工具 schema）恒占窗口、永不压缩：
    // 分母扣掉它得「可用预算」，分子扣掉它得「内容」，两者才可比。
    const overhead = this.overheadOf(session, nodes);
    // 估算值统一乘上事实修正系数，和 provider 报的真实 token 同一把尺子。
    const scale = this.calibration(session, measurement, overhead);
    const fixed = overhead.total * scale;
    const messages = Math.max(0, Number(measurement.surfaceTokens ?? 0) - overhead.system);
    const usable = Math.max(1, budget - fixed);
    const content = Math.max(0, messages * scale);
    const triggerTokens = Math.round(this.config.triggerRatio * usable);
    const nodeSum = nodes.reduce((sum, node) => sum + (node.tokens ?? 0), 0);
    this.debug(`压力判定：total=${measurement.totalTokens} 固定=${Math.round(fixed)} 内容=${Math.round(content)} 可用=${usable} surface=${measurement.surfaceTokens} 系数=${scale.toFixed(2)} baseline=${measurement.baseline} nodes=${nodes.length} 节点合计=${nodeSum} 触发线=${triggerTokens}${force ? '（手动要求）' : ''}`);
    /** 记下这次判定，面板据此回答「为什么没压」。 */
    const note = (info) => {
      this.lastPressure.set(session, {
        at: Date.now(),
        total: measurement.totalTokens,
        content,
        fixed: Math.round(fixed),
        ratio: scale,
        usable,
        trigger: triggerTokens,
        budget,
        calls: this.stats.pressureCalls ?? 0,
        ...info,
      });
      return info;
    };
    if (force !== true && content < triggerTokens) {
      return note({ kind: 'below-trigger' });
    }

    const { systemSeqs, protectedSeqs, surfaceSeqs } = this.classify(session, nodes, overhead.systemSeqs);
    const run = headRun(nodes, { systemSeqs, protectedSeqs });
    if (run === null) return note({ kind: 'no-range' });

    const blocks = this.blocksOf(session);
    const plan = planCommits({
      blocks,
      runSeqs: run.seqs,
      surfaceSeqs,
      contentTokens: content,
      targetTokens: force ? 0 : this.config.targetRatio * usable,
    });
    this.debug(`提交计划：${plan.blocks.length} 块（${plan.blocks.map((b) => `${b.blockId}/T${b.tier}`).join(' ') || '无'}），预计内容 ${content} → ${Math.round(plan.projectedTokens)}`);
    if (plan.blocks.length === 0) {
      return note({ kind: 'no-block', blocks: blocks.length, run: run.seqs.length });
    }
    return note({
      kind: 'commit',
      blocks: plan.blocks,
      blockIds: plan.blocks.map((block) => block.blockId),
      projected: Math.round(plan.projectedTokens),
    });
  }

  /**
   * 把区间末尾对齐到 step 边界。
   *
   * 宿主的 `compactRegion` 拒绝「end 落在 step 中间」的区间，所以提交前把 end
   * 向后推到该 step 的最后一条表层消息；找不到（比如 end 根本不是任何 step 的成员，
   * 例如 checkpoint 节点）就返回 null，让调用方决定是跳过还是原样传。
   *
   * @param {object} session
   * @param {number} endSeq
   * @param {Set<number>} surface 表层 seq 集合
   * @returns {number|null}
   */
  alignedEnd(session, endSeq, surface) {
    const stepEnd = closedStepEnd(session, endSeq);
    if (stepEnd === null) return null;
    let best = null;
    for (const seq of surface) {
      if (seq < endSeq || seq > stepEnd) continue;
      if (best === null || seq > best) best = seq;
    }
    return best;
  }

  /**
   * 让一段原材料落在工具配对平衡的位置上：向后补齐同一 step 的尾消息，补不动就剪掉这半个 step。
   *
   * 宿主要的是「工具配对平衡」（工具调用和它的结果不跨切点），step 末尾天然满足。
   * 不补齐的话，切点可能正好落在一个工具调用和它的结果之间，提交时会被宿主拒绝
   * （`not a balanced boundary`）——块白蒸，空间压不下去。
   *
   * @param {object} session
   * @param {number[]} seqs
   * @param {Set<number>} blockers 受保护 / 已覆盖 / checkpoint：跨过去就不许补
   * @returns {number[]} 对齐后的 seq 列表（可能为空）
   */
  alignRun(session, seqs, blockers) {
    const list = seqs.slice();
    const surface = session.surface.nodes.slice().sort((a, b) => a - b);
    for (let guard = 0; guard < 80 && list.length > 0; guard += 1) {
      const last = list[list.length - 1];
      const stepEnd = closedStepEnd(session, last);
      if (stepEnd === null) {
        list.pop();
        continue;
      }
      const extras = surface.filter((seq) => seq > last && seq <= stepEnd);
      if (extras.some((seq) => blockers.has(seq))) {
        list.pop();
        continue;
      }
      return [...list, ...extras];
    }
    return [];
  }

  /**
   * 在块自己的 covers 里找一个「工具配对平衡的末条」：优先缩，不向后扩。
   *
   * 宿主的提交闸门是**工具配对平衡**，不是 step 边界 —— dsh-compaction 的
   * tool-pairing 文档原话：safe cuts 由 tool-call/result 的内容推出，
   * "rather than step markers"。那句 `would split a step` 的报错文案是旧语义的遗留。
   *
   * 以前按 step 找边界，结果合并块的成员全是 checkpoint 节点、落在 step 之外
   * （compactRegion 就在 step 之间跑），一个都找不到 —— T2/T3 永远提交不了。
   *
   * 为什么只缩不扩：扩展会把没进摘要的消息也吞进 checkpoint —— 那几条既不在块的
   * covers 里（`decompress` 取不到），也不在摘要里，等于**悄悄丢内容**。
   * 缩到块的内部边界顶多让同一条消息被覆盖两次，是可接受的重复，不是丢失。
   *
   * @param {object} session
   * @param {number[]} covers 块覆盖的 seq（升序）
   * @param {Set<number>} surface 表层 seq 集合
   * @returns {number|null} 可安全作为 end 的 seq；找不到就返回 null（这一块先不提交）
   */
  balancedPrefixEnd(session, covers, surface) {
    for (let index = covers.length - 1; index >= 0; index -= 1) {
      const candidate = covers[index];
      if (!surface.has(candidate)) continue;
      try {
        if (toolPairingBalancedAfter(session, candidate)) return candidate;
      } catch {
        // 宿主判不了（事件缺失 / 表层已变）就当不齐，继续往前缩。
      }
    }
    return null;
  }

  /**
   * 补丁：compactIfNeeded。塔自己决定压不压、压多少，**不再交回宿主**。
   *
   * 交回宿主的代价是它会在塔外压出一段没有块号的 checkpoint：既不能 `decompress`，
   * 也不参与分层，塔的账本从此对不上账。宁可这次不压（请求照发，额度不够就报错），
   * 也不留这种无法追溯的压缩。溢出（context-overflow）不再直接放过：当成一次
   * 强制提交，用手上的块把空间腾出来，腾不动就让请求自己失败。
   */
  async compactIfNeeded(engine, agent, trigger, signal) {
    this.stats.pressureCalls = (this.stats.pressureCalls ?? 0) + 1;
    this.debug(`compactIfNeeded 被调用：trigger=${trigger}`);
    // 手动提交没法在空闲时做：宿主的 compactRegion 要求事件落在一个「打开的回合」里。
    // 所以按钮只排队，等下一回合开始、引擎来问的时候按目标 0 一次提交完。
    const manual = this.commitRequests.has(agent.session);
    const force = manual || trigger !== 'pressure';
    let plan;
    try {
      plan = await this.planPressure(agent, signal, { force });
    } catch (error) {
      this.stats.failures += 1;
      this.ctx.logger?.warn(`tower: pressure planning failed (${String(error)}); leaving this request uncompressed`);
      return null;
    } finally {
      if (manual) this.commitRequests.delete(agent.session);
    }
    this.debug(`pressure 计划：${plan.kind}${plan.blockIds ? ` ${plan.blockIds.join(',')}` : ''}`);
    if (plan.kind === 'below-trigger') return null;
    // 量不到窗口 / 算不出可压区 / 没有就绪块：这次不压。原因已记进 lastPressure，面板会说。
    if (plan.kind !== 'commit') return null;

    // 一次请求可以连续提交多块：每块自己一对 compaction 事件，区间互不重叠。
    let first = null;
    let succeeded = 0;
    let lastError = null;
    const surface = new Set(agent.session.surface.nodes);
    for (const block of plan.blocks) {
      // 宿主的闸门是工具配对平衡。优先在块自己的 covers 里缩到平衡点（不丢内容），
      // 缩不出来就跳过这一块 —— 绝不向后扩，那会把没进摘要的消息也盖掉。
      const end = this.balancedPrefixEnd(agent.session, block.covers, surface);
      if (end === null) {
        lastError = `block ${block.blockId} 的 covers 里找不到平衡点，跳过`;
        this.debug(lastError);
        continue;
      }
      this.pending.set(agent.session, { block });
      try {
        const result = await engine.compactRegion(block.covers[0], end, agent, signal);
        if (result !== null) {
          this.stats.committed += 1;
          succeeded += 1;
          this.recordCheckpoint(agent.session, block.blockId, result);
          first ??= result;
        }
      } catch (error) {
        this.stats.failures += 1;
        lastError = error?.message ?? String(error);
        this.ctx.logger?.warn(`tower: 提交 ${block.blockId} 失败（${lastError}）`);
        this.debug(`提交 ${block.blockId} 失败：${lastError}`);
        break;
      } finally {
        this.pending.delete(agent.session);
      }
    }
    // 把真实结果补回判定记录：只写「计划提交」会让人误以为已经压下去了。
    const previous = this.lastPressure.get(agent.session) ?? {};
    this.lastPressure.set(agent.session, {
      ...previous,
      outcome: { planned: plan.blocks.length, succeeded, error: lastError },
    });
    return first;
  }

  /**
   * 提交成功后，把「块号 ↔ checkpoint 节点」记进账本。
   *
   * 块身份不能靠 checkpoint 正文里的块头反推：格式一改，历史块就全部失联，
   * 库存会把它们重新算成待命，塔又停摆。checkpoint 是宿主在 compactRegion 里
   * 追加的，落在 startSeq…endSeq（compaction/end）之间，source 带 compactionId。
   *
   * @param {object} session
   * @param {string} blockId
   * @param {object} result compactRegion 的返回值
   */
  recordCheckpoint(session, blockId, result) {
    const first = Number(result.startSeq ?? 0);
    const last = Number(result.endSeq ?? session.seq);
    for (let seq = last; seq >= first; seq -= 1) {
      const event = session.eventAt(seq);
      if (event?.type !== 'user/message') continue;
      const source = event.data?.source;
      if (source === undefined || !isCompactCheckpointSource(source)) continue;
      if (result.compactionId !== undefined && source.compactionId !== result.compactionId) continue;
      const data = { blockId, checkpointSeq: event.seq };
      if (result.compactionId !== undefined) data.compactionId = result.compactionId;
      try {
        appendCommit(session, data);
      } catch (error) {
        // 记不上只是退化成正文回落，不能让一次提交被它带翻。
        this.debug(`写提交记录失败（${error?.message ?? error}），该块只能走正文回落`);
      }
      return;
    }
    this.debug(`提交 ${blockId} 后没找到 checkpoint 节点，未写提交记录（该会话只能走正文回落）`);
  }

  /**
   * 手动要求「立刻提交」。
   *
   * 合成本身可以在空闲时做（只写块记录），但把块换成 checkpoint 必须落在
   * 一个打开的回合里——`compactRegion` 会拒绝 `no open turn`。所以这里只排队，
   * 由下一个回合的 compactIfNeeded（那时有回合）忽略触发线、按目标 0 一次提交完。
   *
   * @param {object} agent
   * @returns {boolean} 是否已排队
   */
  requestCommit(agent) {
    if (agent?.session === undefined || agent.session === null) return false;
    this.commitRequests.add(agent.session);
    this.debug(`已排队手动提交：session=${agent.session.id}`);
    return true;
  }

  /**
   * 补丁：summarize。有现成块就零成本返回，否则交回宿主现场蒸馏。
   * @returns {Promise<{summary: object[]}>}
   */
  async serveSummary(engine, original, input, agent, signal) {
    const pending = this.pending.get(agent.session);
    if (pending !== undefined) {
      this.pending.delete(agent.session);
      this.stats.served += 1;
      const summary = summaryBlocks(pending.block, pending.block.childBlockIds ?? []);
      this.debug(`serveSummary 返回 ${summary.length} 个内容块: ${JSON.stringify(summary).slice(0, 160)}`);
      // provider/model 是 compaction/summary 事件的必填字段：引擎无条件写入这两个键，
      // 传 undefined 会让 append 以「carries non-JSON-serializable data」拒绝整条事件。
      // 值必须取**块自己的**来源：摘要可能来自观察者路由（observerProvider/observerModel）
      // 或自带提示词那一发，写主模型的名字等于把账记到别人头上。
      return {
        summary,
        provider: pending.block.origin?.provider ?? 'unknown',
        model: pending.block.origin?.model ?? 'unknown',
      };
    }
    this.stats.passthrough += 1;
    return original.call(engine, input, agent, signal);
  }

  /**
   * 会话是否还在 store 里活着。
   *
   * 后台蒸馏要花几秒，期间宿主可能已经关闭会话；那样写进内存的记录永远落不了盘，
   * 下一步就会重复蒸馏同一段。宁可不写，也不留悬空的块。
   * @param {object} session
   * @returns {boolean}
   */
  isLive(session) {
    const service = this.sessions;
    if (service === undefined || typeof service.get !== 'function') return true;
    try {
      return service.get(session.id) === session;
    } catch {
      return false;
    }
  }

  /**
   * 观察者（回合尾）：按分层库存补蒸一批块，并等它们写完。
   *
   * 之所以在 turn-stopping 上等（而不是 fire-and-forget）：宿主的持久化检查点
   * 只在请求前后，回合结束立刻关会话；不等就必然丢块。代价是这个回合晚几秒收尾。
   *
   * 请求前的那一次（pre-step）走同一个 `pump`，但**不等**：那时回合还开着，
   * 块写进内存后由下一次请求的检查点落盘。
   *
   * @param {object} agent
   * @param {number} turn
   * @param {AbortSignal|undefined} outerSignal
   */
  async observe(agent, turn, outerSignal) {
    const session = agent.session;
    this.debug(`turn-stopping 收到：session=${session.id} turn=${turn}`);
    if (!this.isLive(session)) {
      this.debug('会话已不在 store 里，跳过观察');
      return;
    }
    await this.pump(agent, outerSignal, turn, { wait: true });
  }

  /**
   * 排一批观察任务：分层算缺口 → 从最底层开始发名额 → 并发蒸馏。
   *
   * @param {object} agent
   * @param {AbortSignal|undefined} outerSignal
   * @param {number} turn
   * @param {{wait?: boolean}} options wait=true 时等这批全部结束（回合尾用）
   */
  async pump(agent, outerSignal, turn, options = {}) {
    const session = agent.session;
    if (!this.isLive(session)) return;
    if (this.distilling.has(session)) {
      this.debug('已有一批观察在跑，跳过');
      return;
    }
    if (options.wait !== true) {
      // 每个 step 都跑一遍全量测量太重：请求前的判定做个 5 秒节流。
      const last = this.lastPump.get(session) ?? 0;
      if (Date.now() - last < 5000) return;
      this.lastPump.set(session, Date.now());
    }
    this.distilling.add(session);
    const timeout = this.config.observerTimeoutMs;
    const batch = (async () => {
      try {
        await this.scheduleObservations(agent, outerSignal, turn);
      } catch (error) {
        this.stats.failures += 1;
        this.debug(`观察排程失败：${error?.message ?? error}`);
      }
    })();
    if (options.wait !== true) {
      // 请求前：发起即走，别卡住这次请求。批次结束自己收拾状态。
      batch.finally(() => this.distilling.delete(session));
      return;
    }
    const timer = setTimeout(() => this.debug(`观察批次超过 ${timeout}ms 仍未结束，先放手`), timeout);
    try {
      await batch;
    } finally {
      clearTimeout(timer);
      this.distilling.delete(session);
    }
  }

  /**
   * 算这批要蒸几块、每层几块，然后并发发出去。
   *
   * 分三步：
   *   1. 量出「每层未提交块还能回收多少 token」（分层库存）；
   *   2. 量出「每层现在有几个单位的材料」；
   *   3. 从最底层开始按缺口发名额，发满并发上限就停。
   *
   * @param {object} agent
   * @param {AbortSignal|undefined} signal
   * @param {number} turn
   */
  async scheduleObservations(agent, signal, turn) {
    const session = agent.session;
    const engine = this.engineFor(agent);
    if (engine === undefined || engine === null) {
      this.debug('引擎实例还没露面（首次请求后才有），跳过这次观察');
      this.lastObservation.set(session, { at: Date.now(), kind: 'no-engine' });
      return;
    }
    const budget = await this.budgetOf(agent, signal);
    if (budget === null) {
      this.debug('拿不到上下文窗口，跳过观察');
      this.lastObservation.set(session, { at: Date.now(), kind: 'no-window' });
      return;
    }

    const measurement = this.ctx.tokenMeter.measure(session);
    const nodes = measurement.nodes;
    // 单位与库存都按「可用预算」算：system 与工具 schema 不参与压缩，也就不该进分母。
    const overhead = this.overheadOf(session, nodes);
    const scale = this.calibration(session, measurement, overhead);
    const blocks = this.blocksOf(session);
    const usable = Math.max(1, budget - overhead.total * scale);
    const { systemSeqs, protectedSeqs, checkpointSeqs } = this.classify(session, nodes, overhead.systemSeqs);
    const coveredSeqs = new Set();
    for (const block of blocks) for (const seq of block.covers) coveredSeqs.add(seq);
    const tierOf = this.checkpointTiers(session, checkpointSeqs, blocks);
    // 在飞任务已经占用的材料，不能再被另一个任务挑中
    const reserved = this.reservedOf(session);
    for (const seq of reserved) coveredSeqs.add(seq);

    const unit = Math.min(this.config.distillMinRunRatio * usable, this.config.observerMaxTokens);
    // unit 是真实口径，而 availableUnits 累加的是节点估算值 → 换算成估算口径再比。
    const unitH = Math.max(1, Math.round(unit / scale));
    // 库存与配额都按「一块能回收多少」记账：inventory 数的是 covered − summary，
    // 拿 unit 当分母会永远差一点点（差的就是摘要本身的大小）。
    const reserve = this.reserveOf(usable);
    const inventory = this.inventoryOf(session, blocks);
    const available = this.availableUnits({
      nodes, systemSeqs, coveredSeqs, checkpointSeqs, tierOf, unit: unitH, blocks,
    });
    const plan = planObservation({
      available,
      inventory,
      reserveTokens: reserve.tokens,
      unitTokens: reserve.reclaim,
      concurrency: this.config.observerConcurrency,
    });
    /** 记下这次观察判定，面板据此回答「为什么没蒸」。 */
    const note = (info) => {
      this.lastObservation.set(session, {
        at: Date.now(),
        unit: Math.round(unit),
        protected: protectedSeqs.size,
        available: [...available].map(([tier, units]) => [tier, units]),
        inventory: [...inventory].map(([tier, tokens]) => [tier, Math.round(tokens)]),
        ...info,
      });
    };
    if (plan.length === 0) {
      // 全部材料都在保护区里 或 库存已够：两种都记下来，别让人以为观察者没跑。
      const stocked = [...available.keys()].some((tier) => (inventory.get(tier) ?? 0) >= reserve.tokens);
      note({ kind: available.size === 0 ? 'no-material' : stocked ? 'stocked' : 'no-quota' });
      this.debug(`不补蒸：库存=${[...inventory].map(([t, v]) => `T${t}:${Math.round(v)}`).join(',') || '空'} 可用=${[...available].map(([t, v]) => `T${t}:${v}`).join(',') || '空'}`);
      return;
    }
    note({ kind: 'launched', plan });
    this.debug(`本批观察：${plan.map((job) => `T${job.tier}×${job.count}`).join(' ')}（单位 ${Math.round(unit)} tok）`);

    const jobs = [];
    for (const job of plan) {
      for (let index = 0; index < job.count; index += 1) {
        jobs.push(this.distillOne(agent, signal, turn, job.tier));
      }
    }
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.stats.failures += 1;
        this.debug(`蒸馏失败：${result.reason?.message ?? result.reason}`);
      }
    }
  }

  /** 这个会话上已被在飞任务占用的 seq 集合（懒建）。 */
  reservedOf(session) {
    let set = this.reserved.get(session);
    if (set === undefined) {
      set = new Set();
      this.reserved.set(session, set);
    }
    return set;
  }

  /**
   * 分层库存：每层「已蒸馏、还没进上下文、且**材料还在**」的块能回收多少 token。
   *
   * 未提交 = 没被合并进上层（consumed）、没在表层生成 checkpoint（committed），
   * 且 covers 全部仍在表层（usable）——最后这条与提交计划共用。
   * 塔外的压缩（宿主的 /compact、或老会话里已有的 checkpoint）会把一段历史换成
   * 没有块号的 checkpoint，覆盖该段的块从此永远提交不了；若还把它们算成库存，
   * 观察者会以为库存满了而不再补料。
   *
   * 保护区不影响库存：蒸馏不受保护区限制，保护只在提交时起作用，块提前备着等材料滑出去。
   *
   * @param {object} session
   * @param {Array<object>} blocks
   * @returns {Map<number, number>}
   */
  inventoryOf(session, blocks) {
    const surface = new Set(session.surface.nodes);
    const index = checkpointIndex(session);
    const consumed = new Set();
    for (const block of blocks) for (const child of block.childBlockIds ?? []) consumed.add(child);
    const inventory = new Map();
    for (const block of blocks) {
      if (consumed.has(block.blockId)) continue;
      const seq = index.get(block.blockId);
      if (seq !== undefined && surface.has(seq)) continue;
      if (!usable(block, { surfaceSeqs: surface })) continue;
      const tier = Number(block.tier ?? 1);
      const reclaim = Number(block.coveredTokens ?? 0) - Number(block.summaryTokens ?? 0);
      inventory.set(tier, (inventory.get(tier) ?? 0) + reclaim);
    }
    return inventory;
  }

  /**
   * 每层现在有几个「单位」的材料可蒸。
   *
   * T1 看最早那段连续可蒸原文；T2+ 看同层相邻 checkpoint 攒了多少。
   * 这是**近似值**：只用来决定这一批发几个名额，不需要精确到个位。
   *
   * @returns {Map<number, number>}
   */
  availableUnits({ nodes, systemSeqs, coveredSeqs, checkpointSeqs, tierOf, unit, blocks }) {
    const tokensOf = new Map(nodes.map((node) => [node.seq, node.tokens ?? 0]));
    const available = new Map();

    // T1：整段可蒸原文一共多少 token。
    // 注意这里**不受保护区限制** —— 蒸馏不改变上下文，保护区只在提交时起作用。
    const rawRun = selectRawRun(nodes, {
      systemSeqs,
      protectedSeqs: new Set(),
      coveredSeqs,
      checkpointSeqs,
      minTokens: unit,
      maxTokens: Number.MAX_SAFE_INTEGER,
    });
    if (rawRun.length > 0) {
      let raw = 0;
      for (const seq of rawRun) raw += tokensOf.get(seq) ?? 0;
      const units = Math.floor(raw / unit);
      if (units > 0) available.set(1, units);
    }

    // T2+：把表层按「同层相邻 checkpoint」分组，每组能凑几个单位
    const groups = new Map();
    let previous = null;
    for (const seq of nodes.map((node) => node.seq)) {
      const tier = checkpointSeqs.has(seq) ? tierOf.get(seq) : undefined;
      if (tier === undefined) {
        previous = null;
        continue;
      }
      if (previous === null || previous.tier !== tier) {
        previous = { tier, tokens: 0, count: 0 };
        if (!groups.has(tier)) groups.set(tier, []);
        groups.get(tier).push(previous);
      }
      previous.tokens += tokensOf.get(seq) ?? 0;
      previous.count += 1;
    }
    for (const [tier, list] of groups) {
      let units = 0;
      for (const group of list) {
        if (group.count < this.config.mergeMinBlocks) continue;
        units += Math.floor(group.tokens / unit);
      }
      if (units > 0) available.set(tier + 1, (available.get(tier + 1) ?? 0) + units);
    }
    return available;
  }

  /**
   * 蒸一块：按目标层挑段 → 借宿主的 summarize 生成摘要 → 写块记录。
   *
   * @param {object} agent
   * @param {AbortSignal|undefined} outerSignal
   * @param {number} turn
   * @param {number} wantTier 目标层：1 = 蒸原文，≥2 = 合并同层 checkpoint
   */
  async distillOne(agent, outerSignal, turn, wantTier) {
    const session = agent.session;
    const engine = this.engineFor(agent);
    if (engine === undefined || engine === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('tower: distillation timed out')), this.config.observerTimeoutMs);
    if (outerSignal !== undefined) {
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      else outerSignal.addEventListener('abort', () => controller.abort(outerSignal.reason), { once: true });
    }
    const reserved = this.reservedOf(session);
    let claimed = [];
    try {
      const budget = await this.budgetOf(agent, controller.signal);
      if (budget === null) return;
      const measurement = this.ctx.tokenMeter.measure(session);
      const nodes = measurement.nodes;
      // 与提交端同一分母：可用预算 = 窗口 − 固定开销。
      const overhead = this.overheadOf(session, nodes);
      const scale = this.calibration(session, measurement, overhead);
      const blocks = this.blocksOf(session);
      const usable = Math.max(1, budget - overhead.total * scale);
      const { systemSeqs, protectedSeqs, checkpointSeqs } = this.classify(session, nodes, overhead.systemSeqs);
      const coveredSeqs = new Set();
      for (const block of blocks) for (const seq of block.covers) coveredSeqs.add(seq);
      for (const seq of reserved) coveredSeqs.add(seq);
      const tierOf = this.checkpointTiers(session, checkpointSeqs, blocks);
      const unit = Math.min(this.config.distillMinRunRatio * usable, this.config.observerMaxTokens);
      // 选段累加的是节点估算值，门槛是真实口径 → 一起换算到估算口径再比。
      const unitH = Math.max(1, Math.round(unit / scale));
      const maxH = Math.max(unitH, Math.round(this.config.observerMaxTokens / scale));

      let seqs = [];
      if (wantTier <= 1) {
        // 蒸馏不受保护区限制：块只是写进账本，不改变上下文。
        // 真正需要保护的是「提交」——那一步在 planCommits 里按保护区过滤。
        seqs = selectRawRun(nodes, {
          systemSeqs, protectedSeqs: new Set(), coveredSeqs, checkpointSeqs,
          minTokens: unitH,
          maxTokens: maxH,
          stopAtTokens: unitH,
        });
      } else {
        const mergeRun = selectMergeRun(nodes, {
          protectedSeqs, coveredSeqs, checkpointSeqs, tierOf,
          // 只从「上一层」取料：想要 T2 就只从 T1 里选。先选再比对的话，
          // 扫描会先撞上更老的深层 run，对不上目标层就整轮空手，浅层永远轮不到。
          memberTier: wantTier - 1,
          minCount: this.config.mergeMinBlocks,
          minTokens: unitH,
          maxTokens: maxH,
        });
        // 再验一次目标层：memberTier 已经在选料时过滤过，这里防的是 tierOf 缺项。
        const tier = mergeRun.length === 0 ? undefined : (tierOf.get(mergeRun[0]) ?? 0) + 1;
        if (tier === wantTier) seqs = mergeRun;
      }
      if (seqs.length === 0) {
        this.debug(`T${wantTier} 这一份没挑到材料（可能刚被别的任务占了）`);
        return;
      }
      // 原材料块的尾巴要落在工具配对平衡的位置上（补齐到 step 末尾正好满足：
      // step 结束意味着工具调用和结果都齐了）。合并块的材料是 checkpoint 节点，
      // 它替换的区间两端本来就是平衡的，不需要这一步。
      if (wantTier <= 1) {
        const blockers = new Set([...coveredSeqs, ...checkpointSeqs, ...reserved]);
        const aligned = this.alignRun(session, seqs, blockers);
        if (aligned.length === 0) {
          this.debug('对齐 step 边界后没有完整的一段，放弃这一份');
          return;
        }
        seqs = aligned;
      }
      claimed = seqs;
      for (const seq of claimed) reserved.add(seq);
      await this.materialize(agent, controller.signal, turn, seqs, nodes, blocks, engine, scale);
    } finally {
      for (const seq of claimed) reserved.delete(seq);
      clearTimeout(timer);
    }
  }

  /**
   * 手动合并：把指定的几个块的 checkpoint 节点合成一个新块。
   * 只接受当前表层上、层级相同的块，避免造出跨层的怪块。
   *
   * @param {object} agent
   * @param {AbortSignal} signal
   * @param {string[]} blockIds
   * @param {number} [turn]
   * @returns {Promise<object|null>} 新块记录，失败返回 null
   */
  async mergeBlocks(agent, signal, blockIds, turn = 0) {
    const session = agent.session;
    const engine = this.engineFor(agent);
    if (engine === undefined || engine === null) return null;
    const blocks = this.blocksOf(session);
    const byId = new Map(blocks.map((block) => [block.blockId, block]));
    const wanted = [];
    for (const id of blockIds) {
      const block = byId.get(id);
      if (block === undefined) return null;
      wanted.push(block);
    }
    if (wanted.length < 2) return null;
    const tier = Number(wanted[0].tier ?? 1);
    if (wanted.some((block) => Number(block.tier ?? 1) !== tier)) return null;

    const surface = new Set(session.surface.nodes);
    const index = checkpointIndex(session);
    const seqs = [];
    for (const block of wanted) {
      const seq = index.get(block.blockId);
      if (seq === undefined || !surface.has(seq)) return null;
      seqs.push(seq);
    }
    seqs.sort((a, b) => a - b);

    const measurement = this.ctx.tokenMeter.measure(session);
    const nodes = measurement.nodes;
    const scale = this.calibration(session, measurement, this.overheadOf(session, nodes));
    return this.materialize(agent, signal, turn, seqs, nodes, blocks, engine, scale);
  }

  /**
   * 把选中的一段做成块：借宿主的 summarize 生成摘要 → 写块记录。
   * 自动蒸馏与手动合并共用这一段，唯一的差别是 seqs 从哪来。
   *
   * @param {object} agent
   * @param {AbortSignal} signal
   * @param {number} turn
   * @param {number[]} seqs
   * @param {Array<{seq:number, tokens:number, heuristicTokens?:number}>} nodes
   * @param {Array<object>} blocks
   * @param {object} engine
   * @param {number} [scale] 事实修正系数（见 calibration）
   * @returns {Promise<object|null>} 新块记录
   */
  async materialize(agent, signal, turn, seqs, nodes, blocks, engine, scale = 1) {
    const session = agent.session;
    const input = this.buildSummaryInput(session, seqs);
    if (input.messages.length === 0) {
      this.debug('选中段投影不出消息，跳过');
      return null;
    }
    this.debug(`开始蒸馏 ${seqs.length} 条（seq ${seqs[0]}…${seqs[seqs.length - 1]}）`);

    const route = this.observerRoute(agent);
    const produced = await this.summarizeWithRoute(engine, input, agent, signal);
    const text = (produced?.summary ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length === 0) {
      this.debug('摘要为空，跳过');
      return null;
    }

    // 真值优先：同一段材料在两次请求之间的 prompt 差，就是它真实占的 token
    // （实测比 chars/4 估算大 1.2～1.4 倍）。测不到才退回「估算 × 标定系数」。
    const estimated = sumHeuristic(nodes, seqs);
    const measured = this.realTokensOf(session, seqs, estimated);
    const coveredTokens = measured ?? Math.round(estimated * scale);
    const summaryTokens = Math.round(this.estimateText(text) * scale);
    const children = this.childBlocksOf(session, seqs, blocks);
    const tier = children.length === 0 ? 1 : Math.max(...children.map((child) => child.tier ?? 1)) + 1;
    const record = {
      blockId: this.allocateBlockId(session, blocks),
      tier,
      covers: seqs,
      childBlockIds: children.map((child) => child.blockId),
      summary: [{ type: 'text', text }],
      coveredTokens,
      summaryTokens,
      kind: children.length === 0 ? 'run' : 'distill',
      origin: { provider: route.provider || 'unknown', model: route.model || 'unknown', turn },
      createdAt: new Date().toISOString(),
    };
    if (!this.isLive(session)) {
      this.debug('会话在蒸馏期间已经关闭，放弃写入（下一回合会重新蒸馏）');
      this.pendingIds.get(session)?.delete(record.blockId);
      return null;
    }
    appendBlock(session, record);
    // 块已进账本，占位的号可以释放了（下一次 nextBlockId 会自然跳过它）。
    this.pendingIds.get(session)?.delete(record.blockId);
    await this.flushSession(agent, session);
    this.stats.distilled += 1;
    this.debug(`写入块 ${record.blockId}（T${record.tier}, ${seqs.length} 条, ${coveredTokens} → ${summaryTokens} tok, ${record.kind}）`);
    return record;
  }

  /**
   * 观察者这次蒸馏该用哪个模型。留空就跟随当前会话的路由。
   * @param {object} agent
   * @returns {{provider: string, model: string}}
   */
  observerRoute(agent) {
    return {
      provider: this.config.observerProvider || agent.options?.provider || '',
      model: this.config.observerModel || agent.options?.model || '',
    };
  }

  /**
   * 让宿主的 summarize 生成摘要；两种情况会绕开它：
   *
   *   1. 观察者配了自己的模型 —— 宿主挑模型的顺序是「引擎的 summarization* 配置 →
   *      会话最近一次请求的路由 → agent.options」，前两级都会盖掉 agent.options，
   *      改 agent 没用，只能临时换掉引擎那份 config。引擎实例属于这个 agent 的
   *      context，同一会话的压缩是串行的，这个替换窗口是安全的，拿到结果立刻还原。
   *   2. 观察者配了自己的提示词（中文预设 / 自定义）—— 宿主的指令是写死的常量，
   *      没有参数能换，所以这一次请求由 requestSummary 自己发（形状照抄宿主）。
   *
   * @param {object} engine
   * @param {object} input
   * @param {object} agent
   * @param {AbortSignal} signal
   */
  async summarizeWithRoute(engine, input, agent, signal) {
    const route = this.observerRoute(agent);
    const instruction = summaryInstruction(this.config);
    if (instruction !== null) {
      if (route.provider === '' || route.model === '') {
        // 自定义提示词要自己发请求，必须知道发给谁；路由不全就退回宿主，别把蒸馏搞停。
        this.debug('自定义摘要提示词已启用，但观察者路由不完整，这一次仍走宿主 summarize');
      } else {
        return requestSummary({
          ctx: this.ctx,
          session: agent.session,
          provider: route.provider,
          model: route.model,
          input,
          instruction,
          maxTokens: this.config.summaryMaxTokens,
          signal,
        });
      }
    }

    const follows = route.provider === '' || route.model === '';
    const same = agent.options?.provider === route.provider && agent.options?.model === route.model;
    if (follows || same) return engine.summarize(input, agent, signal);

    const saved = engine.config;
    engine.config = { ...saved, summarizationProvider: route.provider, summarizationModel: route.model };
    try {
      return await engine.summarize(input, agent, signal);
    } finally {
      engine.config = saved;
    }
  }

  /**
   * 一份文本按宿主口径折算成 token 数（与 shadow-price 同一把尺）。
   * 宿主不可用时退回字符估算，绝不抛。
   * @param {string} text
   */
  estimateText(text) {
    try {
      return this.ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] });
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * 表层上每个 checkpoint 节点的层级：查 checkpointOwner 反查块记录。
   * @param {object} session
   * @param {Set<number>} checkpointSeqs
   * @param {Array<object>} blocks
   * @returns {Map<number, number>}
   */
  checkpointTiers(session, checkpointSeqs, blocks) {
    const byId = new Map(blocks.map((block) => [block.blockId, block]));
    const owner = checkpointOwner(session);
    const tiers = new Map();
    for (const seq of checkpointSeqs) {
      const block = byId.get(owner.get(seq));
      if (block !== undefined) tiers.set(seq, Number(block.tier ?? 1));
    }
    return tiers;
  }

  /**
   * 找出一段历史里「已经是某个块的摘要节点」的成员。
   *
   * 身份查 checkpointOwner（提交记录优先，老会话回落正文块头），不再解析正文。
   * 有子块就说明这一段是「摘要的摘要」——层级 +1，成为 T2。
   *
   * @param {object} session
   * @param {number[]} seqs
   * @param {Array<object>} blocks
   * @returns {Array<object>}
   */
  childBlocksOf(session, seqs, blocks) {
    const byId = new Map(blocks.map((block) => [block.blockId, block]));
    const owner = checkpointOwner(session);
    const found = [];
    const seen = new Set();
    for (const seq of seqs) {
      const blockId = owner.get(seq);
      if (blockId === undefined || seen.has(blockId)) continue;
      const block = byId.get(blockId);
      if (block === undefined) continue;
      seen.add(blockId);
      found.push(block);
    }
    return found;
  }

  /**
   * 复刻引擎的 buildSummarizationInput：system 头 + 工具 schema + 区间内逐条消息。
   * 前缀与真实请求一致，供应商侧 KV 缓存才能命中。
   * @param {object} session
   * @param {number[]} seqs
   */
  buildSummaryInput(session, seqs) {
    const header = session.requestHeader();
    const headSeq = session.surface.nodes[0];
    const head = headSeq === undefined ? undefined : session.eventAt(headSeq);
    const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null;
    const regionMessages = [];
    for (const seq of seqs) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      const message = session.deriveEventMessage(event);
      if (message !== null && message !== undefined) regionMessages.push(message);
    }
    return {
      ...(header?.tools === undefined ? {} : { tools: header.tools }),
      messages: system === null ? regionMessages : [system, ...regionMessages],
    };
  }

  /** 渲染一段 seq 的原文，用于解压输出。 */
  renderSeqs(session, seqs, { maxCharsPerMessage = 400 } = {}) {
    const lines = [];
    for (const seq of seqs) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      const message = session.deriveEventMessage(event);
      if (message === null || message === undefined) continue;
      lines.push(`${refOf(seq)}  [${roleLabel(event, message)}]  ${describeMessage(message, maxCharsPerMessage)}`);
    }
    return lines;
  }
}

/**
 * 按节点口径求和。
 *
 * 优先取 `tokens` 而不是 `heuristicTokens`：两者的差别只在图片/文件节点上，
 * `tokens` 用的是路由的真实计价（视觉 token + 投影文本），`heuristicTokens`
 * 只给一个结构化的固定估计 —— 取后者会把图片的真实成本吞掉。
 */
function sumHeuristic(nodes, seqs) {
  const wanted = new Set(seqs);
  let total = 0;
  for (const node of nodes) if (wanted.has(node.seq)) total += node.tokens ?? node.heuristicTokens;
  return total;
}
