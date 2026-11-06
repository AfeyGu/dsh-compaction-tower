/**
 * 模型可见的两个工具：decompress / search_context。
 *
 * 两个工具都只读日志，不改任何状态——模型无法通过它们让上下文变短或变长，
 * 只能「看回」已经被压缩掉的内容。
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { blockHeader, describeMessage, formatTokens, iterateEvents, refOf, roleLabel, seqOfRef } from './core.js';
import { blockText } from './tower.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
};

const renderText = (_args, value) => [{ type: 'text', text: value.text }];

/**
 * 注册两个工具。
 * @param {object} ctx 宿主 context
 * @param {import('./tower.js').Tower} tower
 * @returns {() => void} disposer
 */
export function registerTools(ctx, tower) {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'decompress',
      description: '展开被压缩掉的对话历史。给 blockId 精确展开一个块的下一层；给 range（如 ["m00012","m00030"]）按事件序号取回一段历史。默认只展开一层：T1 块展开为原文，T2 及以上展开为下一层块摘要。内容过大时会导出到文件而不是内联。仍在上下文中的消息无需展开。',
      parameters: {
        blockId: { type: 'string', description: '块号，如 "b00007"。与 range 二选一。' },
        range: { type: 'array', description: '事件序号区间 [起始, 结束]，两端都含。与 blockId 二选一。', items: { type: 'string' } },
        inline: { type: 'boolean', description: '强制内联返回（仍受绝对上限截断）。' },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === undefined) throw new Error('decompress 需要一个 agent 会话');
        const session = agent.session;
        const blocks = tower.blocksOf(session);
        const surface = new Set(session.surface.nodes);

        if (typeof args.blockId === 'string' && args.blockId.length > 0) {
          const block = blocks.find((candidate) => candidate.blockId === args.blockId);
          if (block === undefined) {
            throw new Error(`块 ${args.blockId} 不存在（已有块：${blocks.map((b) => b.blockId).join(', ') || '无'}）`);
          }
          if (block.covers.every((seq) => surface.has(seq))) {
            return { text: `块 ${block.blockId} 的内容仍在上下文中，无需展开。` };
          }
          return { text: await expandBlock(tower, session, block, blocks, args.inline === true, exec.signal) };
        }

        if (Array.isArray(args.range) && args.range.length === 2) {
          const start = seqOfRef(args.range[0]);
          const end = seqOfRef(args.range[1]);
          if (start === undefined || end === undefined) throw new Error('range 的两端要写成 m00012 这样的序号');
          const lo = Math.min(start, end);
          const hi = Math.max(start, end);
          const seqs = [];
          for (const event of iterateEvents(session)) {
            if (event.seq < lo || event.seq > hi) continue;
            if (session.deriveEventMessage(event) === null) continue;
            seqs.push(event.seq);
          }
          if (seqs.length === 0) return { text: `区间 ${refOf(lo)}…${refOf(hi)} 内没有消息。` };
          const body = `区间 ${refOf(lo)}…${refOf(hi)}（${seqs.length} 条消息）\n${tower.renderSeqs(session, seqs, { maxCharsPerMessage: Number.MAX_SAFE_INTEGER }).join('\n')}`;
          return { text: await emit(ctx, tower, session, body, `range-${lo}-${hi}`, args.inline === true, exec.signal) };
        }

        throw new Error('decompress 需要 blockId 或 range 之一');
      },
    })),

    ctx.tools.register(defineTool({
      name: 'search_context',
      description: '在当前会话的完整历史中搜索关键字，包括已经被压缩掉的原文。命中的每条会标注它属于哪个块（或仍在上下文中）。',
      parameters: {
        query: { type: 'string', required: true, description: '要搜索的关键字，尽量短。' },
        limit: { type: 'integer', description: '最多返回多少条命中，默认 10，上限 30。' },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderText },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === undefined) throw new Error('search_context 需要一个 agent 会话');
        const query = String(args.query ?? '').trim();
        if (query.length === 0) throw new Error('query 不能为空');
        const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 30);

        const session = agent.session;
        const blocks = tower.blocksOf(session);
        const surface = new Set(session.surface.nodes);
        const terms = tokenize(query);
        const hits = [];
        for (const event of iterateEvents(session)) {
          const message = session.deriveEventMessage(event);
          if (message === null || message === undefined) continue;
          const score = scoreText(describeMessage(message, 4000), query, terms);
          if (score <= 0) continue;
          hits.push({ seq: event.seq, event, message, score });
        }
        if (hits.length === 0) return { text: `没有找到「${query}」。` };
        hits.sort((a, b) => b.score - a.score || b.seq - a.seq);
        const top = hits.slice(0, limit);
        const lines = top.map((hit) => {
          const where = surface.has(hit.seq) ? '仍在上下文' : coverageLabel(hit.seq, blocks);
          return `${refOf(hit.seq)}  [${roleLabel(hit.event, hit.message)}]  ${describeMessage(hit.message, 160)}   ← ${where}`;
        });
        const more = hits.length > top.length ? `\n（共 ${hits.length} 条命中，显示前 ${top.length} 条）` : '';
        return { text: `${top.length} 条命中：\n${lines.join('\n')}${more}` };
      },
    })),
  ];

  return () => { for (const dispose of disposers) dispose?.(); };
}

/** 展开一个块的下一层：有子块就展开子块摘要，没有就展开原文。 */
async function expandBlock(tower, session, block, blocks, inline, signal) {
  const byId = new Map(blocks.map((candidate) => [candidate.blockId, candidate]));
  const childBlocks = (block.childBlockIds ?? []).map((id) => byId.get(id)).filter((child) => child !== undefined);
  const header = blockHeader({
    blockId: block.blockId,
    tier: block.tier,
    covers: block.covers,
    coveredTokens: block.coveredTokens,
    childBlockIds: childBlocks.map((child) => child.blockId),
  });
  const body = childBlocks.length > 0
    ? childBlocks.map((child) => `${blockHeader({
      blockId: child.blockId,
      tier: child.tier,
      covers: child.covers,
      coveredTokens: child.coveredTokens,
      childBlockIds: child.childBlockIds ?? [],
    })}\n${blockText(child)}`).join('\n\n')
    : tower.renderSeqs(session, block.covers, { maxCharsPerMessage: Number.MAX_SAFE_INTEGER }).join('\n');
  return emit(tower.ctx, tower, session, `${header}\n${body}`, block.blockId, inline, signal);
}

/**
 * 决定内联还是落盘。
 * 内联上限 = inlineMaxRatio × 上下文窗口；绝对上限 = hardMaxTokens。
 */
async function emit(ctx, tower, session, text, name, inline, signal) {
  // 估算口径换算成真实口径：宿主只有 chars/4 的密度估算，中文会被低估三成，
  // 而这里的上限（内联阈值、硬截断）是真实 token 数。
  const measurement = ctx.tokenMeter.measure(session);
  const scale = tower.calibration(session, measurement, tower.overheadOf(session, measurement.nodes));
  const tokens = Math.round(estimateText(ctx, text) * scale);
  const budget = await routeBudget(tower, session, signal);
  const inlineLimit = Math.max(1000, Math.floor(tower.config.inlineMaxRatio * (budget ?? 100000)));

  if (inline && tokens > tower.config.hardMaxTokens) {
    return `${truncateToTokens(ctx, text, tower.config.hardMaxTokens, scale)}\n…（已按绝对上限截断；用 blockId 可以落盘展开全文）`;
  }
  if (inline || tokens <= inlineLimit) return text;

  const root = projectRoot(session);
  const dir = join(root, '.dsh', 'tower', session8(session));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.gitignore'), '*\n', 'utf8').catch(() => {});
  const file = join(dir, `${name}.md`);
  await writeFile(file, `${text}\n`, 'utf8');
  await pruneExports(tower, join(root, '.dsh', 'tower'));
  // 预览是给模型判断「要不要打开这个文件」的，不是给它的内容本身：
  // 每条消息压到 200 字符，否则一个块的首 20 行就可能又是几十 K。
  const preview = text.split('\n').slice(0, 20)
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
    .join('\n');
  const shown = relative(root, file).split(sep).join('/');
  return `已导出到 ${shown}（${formatTokens(tokens)} tok）\n前 20 行预览：\n${preview}`;
}

/** 用宿主的估算器数 token；拿不到就退回 字符数/4。 */
function estimateText(ctx, text) {
  try {
    return ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] });
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function truncateToTokens(ctx, text, maxTokens, scale = 1) {
  const chars = Math.max(200, Math.round((maxTokens * 4) / Math.max(1, scale)));
  return text.length <= chars ? text : `${text.slice(0, chars)}\n…（已截断）`;
}

/** 取当前会话路由的上下文窗口。 */
async function routeBudget(tower, session, signal) {
  const config = session.requestHeader()?.config;
  if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return null;
  return tower.budgetOfRoute(config.provider, config.model, signal);
}

/** 命中行的覆盖说明。 */
function coverageLabel(seq, blocks) {
  const covering = blocks.filter((block) => block.covers.includes(seq));
  if (covering.length === 0) return '已不在上下文';
  return `被 ${covering.map((block) => block.blockId).join(' / ')} 覆盖`;
}

function tokenize(query) {
  return query.split(/[\s,，.。;；:：/\\|()[\]{}"'`]+/u).filter((term) => term.length > 0);
}

function scoreText(text, query, terms) {
  if (text.length === 0) return 0;
  let score = 0;
  if (query.length > 1 && text.includes(query)) score += 5;
  for (const term of terms) {
    let index = text.indexOf(term);
    let count = 0;
    while (index !== -1 && count < 5) { count += 1; index = text.indexOf(term, index + term.length); }
    score += count;
  }
  return score;
}

/** 会话 cwd → 项目根（最近一个含 .git 的祖先，找不到就用 cwd）。 */
function projectRoot(session) {
  const cwd = resolve(session.header?.cwd ?? process.cwd());
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/** 只保留最近 N 个会话目录（按 mtime）。文件是视图，删掉随时可重建。 */
async function pruneExports(tower, towerDir) {
  let entries;
  try {
    entries = await readdir(towerDir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(towerDir, entry.name);
    try {
      dirs.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch { /* ignore */ }
  }
  if (dirs.length <= tower.config.exportKeepSessions) return;
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const stale of dirs.slice(tower.config.exportKeepSessions)) {
    await rm(stale.path, { recursive: true, force: true }).catch(() => {});
  }
}

function session8(session) {
  return String(session.id).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'session';
}
