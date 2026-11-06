/**
 * 会话日志与块记录的底层读取。
 *
 * 这里不持有任何状态：一切从 session 的事件日志现算。
 * 块记录（plugin:tower/block）是唯一的账本，重启后从日志重建。
 */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';

export { pluginRecordOf };

/** 块记录的事件类型（宿主语法：plugin: + 全小写分段）。 */
export const BLOCK_RECORD_TYPE = 'plugin:tower/block';

/** 提交记录的事件类型：块号 ↔ 它换进表层的那个 checkpoint 节点。 */
export const COMMIT_RECORD_TYPE = 'plugin:tower/commit';

/** 顾问意见的记录类型。与块分开，因为它不是上下文的一部分。 */
export const ADVICE_RECORD_TYPE = 'plugin:tower/advice';

/**
 * 所有 step/start 的 seq（升序）—— 用来划「保护最近 N 步」的边界。
 *
 * step = 一次模型请求。用户发一句话到 agent 收工是一个 turn，中间可能有很多 step；
 * 保护窗口按 step 算才有意义（10 个用户轮次会把整段对话都圈进去）。
 *
 * @param {object} session
 * @returns {number[]}
 */
export function stepStartSeqs(session) {
  const seqs = [];
  for (const event of iterateEvents(session)) {
    if (event.type === 'step/start') seqs.push(event.seq);
  }
  return seqs;
}

/**
 * 列出所有**已闭合**的 step 区间（step/start … step/end）。
 *
 * 一次扫描拿全部区间，避免对每条候选消息都重扫一遍事件（块覆盖上百条时是 O(n·m)）。
 *
 * @param {object} session
 * @returns {Array<{start: number, end: number}>} 按 seq 升序
 */
export function stepSpans(session) {
  const spans = [];
  let start = null;
  for (const event of iterateEvents(session)) {
    if (event.type === 'step/start') start = event.seq;
    else if (event.type === 'step/end' && start !== null) {
      spans.push({ start, end: event.seq });
      start = null;
    }
  }
  return spans;
}

/**
 * 找 seq 所在 step 的闭合边界（step/end 的 seq）。
 *
 * 宿主的 `compactRegion` 要求区间**按 step 对齐**：end 必须是某个已闭合 step 的最后一条
 * 消息，否则会抛 `not a balanced boundary (would split a step, or the step is still open)`。
 * 块是按消息切的，边界天然可能落在 step 中间，所以提交前要用这里对齐。
 *
 * @param {object} session
 * @param {number} seq
 * @returns {number|null} 该 step 的 step/end seq；step 还没闭合（或找不到）时返回 null
 */
export function closedStepEnd(session, seq) {
  let start = null;
  for (const event of iterateEvents(session)) {
    if (event.type === 'step/start') {
      start = event.seq;
      continue;
    }
    if (event.type !== 'step/end') continue;
    if (start !== null && seq >= start && seq <= event.seq) return event.seq;
    start = null;
  }
  return null;
}

/**
 * 按 seq 顺序遍历全部事件。
 * 宿主没有暴露事件数组，seq 连续且不复用，所以用 eventAt 逐号取到 undefined 为止。
 * @param {object} session
 * @returns {Iterable<object>}
 */
export function* iterateEvents(session) {
  for (let seq = 0; ; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) return;
    yield event;
  }
}

/**
 * 读出全部块记录，按写入顺序（= 块号顺序）。
 * @param {object} session
 * @returns {Array<object>} 每项带 recordSeq（记录事件自己的 seq）
 */
export function readBlocks(session) {
  const blocks = [];
  for (const event of iterateEvents(session)) {
    const record = pluginRecordOf(event);
    if (record === undefined || record.type !== BLOCK_RECORD_TYPE) continue;
    const data = record.data;
    if (typeof data?.blockId !== 'string' || !Array.isArray(data.covers)) continue;
    blocks.push({ ...data, recordSeq: event.seq });
  }
  return blocks;
}

/**
 * 分配下一个块号。块号只增不减，删除记录也不会回填。
 * @param {Array<object>} blocks 现有记录
 * @returns {string} 形如 b00007
 */
export function nextBlockId(blocks) {
  let max = 0;
  for (const block of blocks) {
    const match = /^b(\d+)$/.exec(block.blockId);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `b${String(max + 1).padStart(5, '0')}`;
}

/**
 * 写入一个块记录。仅日志，不进表层——模型看不见。
 * @param {object} session
 * @param {object} data 无损 JSON
 * @returns {object} 追加的事件
 */
export function appendBlock(session, data) {
  return appendPluginRecord(session, BLOCK_RECORD_TYPE, data);
}

/**
 * 读出全部提交记录，按写入顺序。
 * @param {object} session
 * @returns {Array<{blockId: string, checkpointSeq: number, compactionId?: string}>}
 */
export function readCommits(session) {
  const commits = [];
  for (const event of iterateEvents(session)) {
    const record = pluginRecordOf(event);
    if (record === undefined || record.type !== COMMIT_RECORD_TYPE) continue;
    const data = record.data;
    if (typeof data?.blockId !== 'string' || !Number.isInteger(data.checkpointSeq)) continue;
    commits.push({ ...data, recordSeq: event.seq });
  }
  return commits;
}

/**
 * 写入一条提交记录：块号 ↔ 它换进来的 checkpoint 节点。
 *
 * 这是块身份的**唯一权威来源**。不能靠 checkpoint 正文里的块头反推：格式一改，
 * 历史块就全部失联，库存会重新把它们算成待命，塔又停摆。
 * @param {object} session
 * @param {{blockId: string, checkpointSeq: number, compactionId?: string}} data
 * @returns {object} 追加的事件
 */
export function appendCommit(session, data) {
  return appendPluginRecord(session, COMMIT_RECORD_TYPE, data);
}

/**
 * 写入一条顾问意见。仅日志：不进表层，也不参与压缩决策。
 * @param {object} session
 * @param {object} data 无损 JSON
 * @returns {object} 追加的事件
 */
export function appendAdvice(session, data) {
  return appendPluginRecord(session, ADVICE_RECORD_TYPE, data);
}

/**
 * 表层上每个 checkpoint 节点的「块号 → 该节点 seq」。
 *
 * 两个来源，权威优先：
 *   1. 提交记录（plugin:tower/commit）—— 提交成功时当场写，与正文格式无关；
 *   2. 正文里的块头 `[b00007 · T2 · …]` —— 只给没有提交记录的老会话兜底。
 *      这条必须校验 source（`compact-checkpoint`），否则普通 user 消息里出现
 *      同形字面量（例如让模型去读插件源码）就会被误认成 checkpoint。
 * @param {object} session
 * @returns {Map<string, number>}
 */
export function checkpointIndex(session) {
  const surface = new Set(session.surface.nodes);
  const index = new Map();
  for (const commit of readCommits(session)) {
    if (surface.has(commit.checkpointSeq)) index.set(commit.blockId, commit.checkpointSeq);
  }
  const claimed = new Set(index.values());
  for (const seq of session.surface.nodes) {
    if (claimed.has(seq)) continue;
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source === undefined || !isCompactCheckpointSource(source)) continue;
    const text = (event.data?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const match = /\[(b\d{5}) · T\d+/u.exec(text);
    if (match !== null && !index.has(match[1])) index.set(match[1], seq);
  }
  return index;
}

/**
 * 反向索引：checkpoint 节点 seq → 块号。
 * 合并任务按位置找成员，需要这个方向；与 checkpointIndex 同源。
 * @param {object} session
 * @returns {Map<number, string>}
 */
export function checkpointOwner(session) {
  const owner = new Map();
  for (const [blockId, seq] of checkpointIndex(session)) owner.set(seq, blockId);
  return owner;
}

/** 把 seq 渲染成模型可见引用。 */
export function refOf(seq) {
  return `m${String(seq).padStart(5, '0')}`;
}

/** 由 m00042 反解 seq；无法解析返回 undefined。 */
export function seqOfRef(ref) {
  const match = /^m(\d+)$/.exec(String(ref).trim());
  return match === null ? undefined : Number(match[1]);
}

/** 8400 → "8.4K"。 */
export function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * 摘要消息的头部。这是模型唯一能看到的块元信息。
 *
 * T1（成员全是原文消息）给首尾引用；T2+（成员含下层块，seq 会乱序）不给自己区。
 * @param {object} params
 * @returns {string} 单行头部
 */
export function blockHeader({ blockId, tier, covers, coveredTokens, childBlockIds }) {
  const count = `${covers.length} 条`;
  const cost = `原 ${formatTokens(coveredTokens)} tok`;
  if (tier === 1) {
    const first = refOf(covers[0]);
    const last = refOf(covers[covers.length - 1]);
    return `[${blockId} · T1 · ${count} · ${first}…${last} · ${cost}]`;
  }
  const inner = childBlockIds.length > 0 ? `${childBlockIds.length} 个 T${tier - 1} 块` : '下层块';
  return `[${blockId} · T${tier} · ${count}（含 ${inner}）· ${cost}]`;
}

/** 摘录一条消息的文本，用于搜索命中行与解压预览。 */
export function describeMessage(message, maxChars = 200) {
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool-call') parts.push(`→ ${block.name}(${JSON.stringify(block.arguments ?? {})})`);
    else if (block.type === 'image') parts.push('[image]');
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** 消息的角色标签，用于 [user] / [bash] 这种前缀。 */
export function roleLabel(event, message) {
  if (event.type === 'tool/result') return message.source?.toolName ?? 'tool';
  if (event.type === 'assistant/message') return 'assistant';
  if (event.type === 'system/message') return 'system';
  return message.role ?? 'user';
}
