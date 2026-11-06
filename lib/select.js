/**
 * 选段：纯函数，不碰 session。
 *
 * 所有决策都建立在宿主的 TokenSurfaceNode 上（seq / tokens / heuristicTokens），
 * 这样触发判断与提交范围用的是同一把尺子。
 *
 * 两个消费者：
 *   - 提交计划 planCommits：请求前决定「压哪几块」，按层级升序（保真优先）；
 *   - 观察者材料 selectRawRun / selectMergeRun：回合尾决定「蒸什么」。
 */

/**
 * 表层的「可压缩区」：跳过开头 system，止于第一个受保护节点。
 *
 * @param {ReadonlyArray<{seq:number}>} nodes
 * @param {object} options
 * @param {Set<number>} options.systemSeqs
 * @param {Set<number>} options.protectedSeqs
 * @returns {{seqs:number[], startIndex:number, endIndex:number}|null}
 */
export function headRun(nodes, { systemSeqs, protectedSeqs }) {
  let start = 0;
  while (start < nodes.length && systemSeqs.has(nodes[start].seq)) start += 1;
  let end = start;
  while (end < nodes.length && !protectedSeqs.has(nodes[end].seq)) end += 1;
  if (end === start) return null;
  const seqs = [];
  for (let i = start; i < end; i += 1) seqs.push(nodes[i].seq);
  return { seqs, startIndex: start, endIndex: end };
}

/**
 * 一块材料是否还「可用」：covers 全部仍在表层，且摘要确实更小。
 *
 * 提交计划与分层库存都必须过这一关，但只共用到这里：提交还要求材料落在可压区
 * （保护区之外），库存不管保护区 —— 蒸馏本来就不受保护区限制，块只是提前备好，
 * 等材料滑出保护区再提交。
 *
 * 之所以按「还在不在表层」判，是因为塔外的压缩（宿主的 /compact，或老会话里
 * 已经存在的 checkpoint）会把一段历史换成没有块号的 checkpoint。覆盖那段的块
 * 从此永远提交不了；库存若照旧把它们算成待命，观察者会以为库存满了而停止补料，
 * 塔就慢性停摆了。
 *
 * @param {object} block 块记录
 * @param {object} scope
 * @param {Set<number>} scope.surfaceSeqs 仍在表层的 seq 集合
 * @returns {boolean}
 */
export function usable(block, { surfaceSeqs }) {
  if (!Array.isArray(block.covers) || block.covers.length === 0) return false;
  if (!block.covers.every((seq) => surfaceSeqs.has(seq))) return false;
  const summaryTokens = Number(block.summaryTokens ?? 0);
  // 公理：提交只缩小
  return summaryTokens > 0 && summaryTokens < Number(block.coveredTokens ?? 0);
}

/**
 * 提交计划：在可压缩区里按「层级升序、同层最老优先」挑块，累加到目标即停。
 *
 * 这就是 Sisyph 的「最少提交 + 分层优先」：先用 T1（原文换摘要，只损失一层），
 * T1 用尽仍不达标才动 T2（若干已提交 checkpoint 合成一条）。所有材料一次算清，
 * 不会出现「某块压过线就卡住」。
 *
 * @param {object} params
 * @param {Array<object>} params.blocks 全部块记录
 * @param {number[]} params.runSeqs 可压缩区的表层 seq（按位置顺序）
 * @param {Set<number>} params.surfaceSeqs 仍在表层的 seq
 * @param {number} params.contentTokens 当前内容用量
 * @param {number} params.targetTokens 目标
 * @returns {{blocks:Array<object>, projectedTokens:number}}
 */
export function planCommits({ blocks, runSeqs, surfaceSeqs, contentTokens, targetTokens }) {
  const inRun = new Set(runSeqs);
  const position = new Map(runSeqs.map((seq, index) => [seq, index]));

  // 两道筛：材料还在（与库存同一判据）→ 材料在可压区。
  const candidates = blocks.filter((block) => usable(block, { surfaceSeqs })
    && block.covers.every((seq) => inRun.has(seq)));

  candidates.sort((a, b) => (Number(a.tier ?? 1) - Number(b.tier ?? 1))
    || ((position.get(a.covers[0]) ?? 0) - (position.get(b.covers[0]) ?? 0)));

  const chosen = [];
  let content = contentTokens;
  for (const block of candidates) {
    if (content <= targetTokens) break;
    if (chosen.some((picked) => overlaps(picked, block))) continue;
    chosen.push(block);
    content += Number(block.summaryTokens ?? 0) - Number(block.coveredTokens ?? 0);
  }
  return { blocks: chosen, projectedTokens: content };
}

/** 两个块是否有覆盖交集。 */
function overlaps(a, b) {
  const seen = new Set(a.covers);
  return b.covers.some((seq) => seen.has(seq));
}

/**
 * 观察配额：从最底层开始逐层发名额，发满并发上限就停。
 *
 * 每层独立记账 —— 低层块只能顶低层的缺，高层块顶不了（提交顺序是低层优先，
 * 高层要等低层用完才会被动用）。所以「T1 有 2 个 + T2 有 2 个」不等于「库存够了」。
 *
 * @param {object} params
 * @param {Map<number, number>} params.available 每层现在有几个单位的材料
 * @param {Map<number, number>} params.inventory 每层未提交块的可回收 token
 * @param {number} params.reserveTokens 每层目标库存（token）
 * @param {number} params.unitTokens 一个单位多少 token
 * @param {number} params.concurrency 一次最多发几个
 * @returns {Array<{tier: number, count: number}>}
 */
export function planObservation({ available, inventory, reserveTokens, unitTokens, concurrency }) {
  const tiers = [...available.keys()].sort((a, b) => a - b);
  const plan = [];
  let slots = Math.max(0, Math.floor(concurrency));
  for (const tier of tiers) {
    if (slots <= 0) break;
    const missing = reserveTokens - (inventory.get(tier) ?? 0);
    if (missing <= 0) continue;          // 这一层库存够了，不再主动蒸
    const need = Math.max(1, Math.ceil(missing / unitTokens));
    const count = Math.min(need, available.get(tier) ?? 0, slots);
    if (count <= 0) continue;
    plan.push({ tier, count });
    slots -= count;
  }
  return plan;
}

/**
 * 观察者材料 A：一段连续的原文。
 *
 * 从最老的「既没被块覆盖、也不是 checkpoint」的位置起算，遇到 checkpoint 就断——
 * 段内位置连续，covers 才能诚实地对应一个区间。
 *
 * 取多少：**攒够一个单位就收手**（`stopAtTokens`，通常是窗口的 5%）。多出来的原文
 * 留在表层不动，下一回合接着蒸——所以单块分量是稳定的「一个单位」，不会因为旧料
 * 攒了半天就长成一百多 K。`maxTokens` 只是保险丝（拦住异常巨大的单个节点），
 * 不是常规尺寸。
 *
 * @param {ReadonlyArray<{seq:number, tokens:number}>} nodes
 * @param {object} options
 * @param {number} [options.stopAtTokens] 攒到这个量就停
 * @returns {number[]} 可为空
 */
export function selectRawRun(nodes, { systemSeqs, protectedSeqs, coveredSeqs, checkpointSeqs, minTokens, maxTokens, stopAtTokens }) {
  let start = 0;
  while (start < nodes.length && systemSeqs.has(nodes[start].seq)) start += 1;
  while (start < nodes.length) {
    const node = nodes[start];
    const usable = !coveredSeqs.has(node.seq) && !checkpointSeqs.has(node.seq) && !protectedSeqs.has(node.seq);
    if (usable) break;
    start += 1;
  }

  const seqs = [];
  let tokens = 0;
  for (let i = start; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (protectedSeqs.has(node.seq) || coveredSeqs.has(node.seq) || checkpointSeqs.has(node.seq)) break;
    if (tokens + node.tokens > maxTokens && seqs.length > 0) break;
    seqs.push(node.seq);
    tokens += node.tokens;
    if (stopAtTokens !== undefined && tokens >= stopAtTokens) break;
  }
  if (tokens < minTokens) return [];
  return seqs;
}

/**
 * 观察者材料 B：相邻的、**同一层**的已提交 checkpoint。
 *
 * 只合并同层，是为了让塔真的按层长：两个 T1 合成一个 T2，两个 T2 才合成 T3。
 * 若允许 T1 与 T2 混合合并，每次都会把「最新的浅块」吸进「上一层」，深度随
 * 提交次数线性增长，分层就名存实亡了。
 *
 * 合并与蒸馏用同一把尺子：**材料攒够 minTokens（窗口的 5%）才值得花一次调用**。
 * 所以从最老的 checkpoint 往后累加，一旦累计达到阈值就收手——这一次要合并的
 * 就是「刚好够分量」的那几个，多出来的留给下一轮，别把一堆小 checkpoint 一次
 * 吞掉（那样每次合并都只值几 K token，白花一次模型调用）。
 *
 * @param {ReadonlyArray<{seq:number, tokens:number}>} nodes
 * @param {object} options
 * @param {Map<number, number>} options.tierOf checkpoint 的层级
 * @param {number} [options.memberTier] 只从这一层的 checkpoint 里选。塔要蒸第 N 层时
 *   必须传 N-1：不过滤的话，从最老的 checkpoint 扫起会先撞上更深的 run，回来后
 *   一比对「合并出来不是我要的层」就整轮空手，浅层的材料永远轮不到。
 * @param {number} options.minCount 一次合并的块数下限（≥2）
 * @param {number} options.minTokens 材料总量下限（通常是窗口的 5%）
 * @param {number} options.maxTokens 一次合并的原文上限
 * @param {Set<number>} [options.coveredSeqs] 已被更高层块覆盖的 checkpoint，不再重复合并
 * @returns {number[]} 可为空
 */
export function selectMergeRun(nodes, {
  protectedSeqs,
  coveredSeqs,
  checkpointSeqs,
  tierOf,
  memberTier,
  minCount,
  minTokens,
  maxTokens,
}) {
  const covered = coveredSeqs ?? new Set();
  let index = 0;
  while (index < nodes.length) {
    const seq = nodes[index].seq;
    if (!checkpointSeqs.has(seq) || protectedSeqs.has(seq) || covered.has(seq)) { index += 1; continue; }
    const tier = tierOf.get(seq);
    if (tier === undefined) { index += 1; continue; }
    if (memberTier !== undefined && tier !== memberTier) { index += 1; continue; }

    const run = [];
    let tokens = 0;
    let next = index;
    while (next < nodes.length) {
      const candidate = nodes[next].seq;
      if (!checkpointSeqs.has(candidate) || protectedSeqs.has(candidate) || covered.has(candidate)) break;
      if (tierOf.get(candidate) !== tier) break;
      if (run.length > 0 && tokens + nodes[next].tokens > maxTokens) break;
      run.push(candidate);
      tokens += nodes[next].tokens;
      next += 1;
      if (tokens >= minTokens) break;
    }
    if (run.length >= minCount && tokens >= minTokens) return run;
    index = next;
  }
  return [];
}

/**
 * 从「最近 retain 个 step」推导受保护的表层节点。
 *
 * 一个 step = 一次模型请求。保护窗口按 step 算，不按用户轮次 —— 用户发一句话之后
 * agent 可能连续跑几十步，按轮次算会把整段新对话都圈成保护区，永远没料可蒸。
 *
 * @param {ReadonlyArray<number>} surfaceSeqs 表层节点 seq，按位置顺序
 * @param {ReadonlyArray<number>} stepStarts 所有 step/start 的 seq（升序）
 * @param {number} retainSteps 保护最近几个 step；0 = 不保护
 * @returns {Set<number>}
 */
export function protectedTail(surfaceSeqs, stepStarts, retainSteps) {
  if (retainSteps <= 0 || stepStarts.length === 0) return new Set();
  const cutSeq = stepStarts[Math.max(0, stepStarts.length - retainSteps)];
  return new Set(surfaceSeqs.filter((seq) => seq >= cutSeq));
}
