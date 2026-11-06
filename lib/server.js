/**
 * 给 Web 界面用的路由：状态、手动操作、配置读写。
 *
 * 只挂在宿主的 webServer 上（与 GUI 同源），所以客户端用相对路径 fetch 即可。
 * headless / TUI 之类没有 webServer 的 profile 不会装载本模块。
 */
import { buildState } from './state.js';
import { PROMPT_PRESETS } from './prompts.js';

/** 允许的手动操作。 */
const ACTIONS = new Set(['distill', 'commit', 'merge']);

/**
 * 注册路由。
 * @param {object} ctx 带 webServer / sessions / agents 服务的 context
 * @param {{tower: import('./tower.js').Tower, store: import('./config-store.js').ConfigStore}} deps
 * @returns {() => void} disposer
 */
export function registerTowerRoutes(ctx, deps) {
  const { tower, store } = deps;
  // 宿主自带的 named route 不套登录鉴权（只有它自己的 /api 走），
  // 所以这里自己问一次连接服务：没带会话 cookie 就 401，别把会话状态漏给本机任何进程。
  // 注意用 ctx.get()：直接 ctx.connection 会因为没有 inject 而抛错；
  // 也不能在注册时就取 —— 路由比连接服务先装载，那时它还是 undefined。
  let cached;
  const connectionOf = () => {
    if (cached !== undefined) return cached;
    try {
      cached = ctx.get?.('connection');
    } catch {
      cached = undefined;
    }
    return cached;
  };
  const authorize = (req, res) => {
    const connection = connectionOf();
    if (connection === undefined || typeof connection.authorizeIndex !== 'function') return true;
    try {
      return connection.authorizeIndex(req, res) === true;
    } catch {
      return false;
    }
  };
  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/tower/state',
      handler: (req, res) => (authorize(req, res) ? handleState(ctx, tower, req, res) : undefined),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/tower/action',
      handler: (req, res) => (authorize(req, res) ? handleAction(ctx, tower, req, res) : undefined),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/tower/config',
      handler: (req, res) => (authorize(req, res) ? handleConfig(ctx, store, req, res) : undefined),
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose?.();
  };
}

/** GET /tower/state?sessionId=…（省略时取最近一个活动会话） */
async function handleState(ctx, tower, req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const wanted = url.searchParams.get('sessionId');
  const live = listSessions(ctx);
  const session = wanted === null || wanted.length === 0
    ? live.at(-1)
    : live.find((candidate) => String(candidate.id) === wanted);

  if (session === undefined) {
    return fail(res, 404, wanted === null ? 'no live session' : `session "${wanted}" is not open`);
  }
  try {
    const state = await buildState(tower, session);
    return json(res, 200, { ...state, sessions: live.map((candidate) => String(candidate.id)) });
  } catch (error) {
    return fail(res, 500, String(error?.message ?? error));
  }
}

/** POST /tower/action {kind, sessionId, blockIds?} */
async function handleAction(ctx, tower, req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return fail(res, 400, 'body must be JSON');
  }
  const kind = String(body?.kind ?? '');
  if (!ACTIONS.has(kind)) return fail(res, 400, `unknown action "${kind}"`);

  const sessionId = String(body?.sessionId ?? '');
  const agent = lookupAgent(ctx, sessionId);
  if (agent === undefined) return fail(res, 404, `no live agent for session "${sessionId}"`);

  try {
    if (kind === 'distill') {
      await tower.observe(agent, undefined, undefined);
      return json(res, 200, { ok: true, message: '已蒸馏一次' });
    }
    if (kind === 'commit') {
      // 真正换成 checkpoint 必须发生在回合里，这里只排队（见 tower.requestCommit）。
      const queued = tower.requestCommit(agent);
      return json(res, 200, {
        ok: true,
        queued,
        message: queued ? '已排队：下一个回合开始时提交' : '这个会话没有可排队的回合',
      });
    }
    const blockIds = Array.isArray(body?.blockIds) ? body.blockIds.map(String) : [];
    const record = await tower.mergeBlocks(agent, undefined, blockIds);
    if (record === null) return fail(res, 400, '这两个块无法合并（需同层且仍在表层）');
    return json(res, 200, { ok: true, blockId: record.blockId });
  } catch (error) {
    return fail(res, 500, String(error?.message ?? error));
  }
}

/** GET /tower/config（读快照）· POST /tower/config {patch} 或 {reset:[key…]} */
async function handleConfig(ctx, store, req, res) {
  if (req.method === 'GET') {
    try {
      return json(res, 200, { ok: true, ...store.snapshot(), catalog: await modelCatalog(ctx), presets: PROMPT_PRESETS });
    } catch (error) {
      return fail(res, 500, String(error?.message ?? error));
    }
  }
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return fail(res, 400, 'body must be JSON');
  }

  try {
    if (body?.reset !== undefined) {
      store.reset(body.reset);
    } else if (body?.patch !== undefined) {
      store.save(body.patch);
    } else {
      return fail(res, 400, '需要 patch 或 reset 字段');
    }
  } catch (error) {
    return fail(res, 400, String(error?.message ?? error));
  }
  return json(res, 200, { ok: true, ...store.snapshot(), catalog: await modelCatalog(ctx), presets: PROMPT_PRESETS });
}

/**
 * 宿主的模型目录：下拉框的数据源。
 *
 * `llm.listModels` 可能去问 provider，所以结果缓存一分钟；某个 provider 挂了
 * 只有它自己的模型缺失，不影响其它 provider（allSettled）。
 */
const catalogCache = { at: 0, value: undefined, pending: undefined };

async function modelCatalog(ctx) {
  if (catalogCache.value !== undefined && Date.now() - catalogCache.at < 60000) return catalogCache.value;
  if (catalogCache.pending !== undefined) return catalogCache.pending;

  catalogCache.pending = (async () => {
    const catalog = { providers: [], models: [] };
    let llm;
    try {
      llm = ctx.get?.('llm');
    } catch {
      llm = undefined;
    }
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return catalog;
    try {
      catalog.providers = (llm.listProviders() ?? []).map((provider) => ({
        id: String(provider.id),
        name: String(provider.name ?? provider.id),
      }));
      const settled = await Promise.allSettled(
        catalog.providers.map((provider) => llm.listModels(provider.id)),
      );
      settled.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const provider = catalog.providers[index].id;
        for (const model of result.value ?? []) {
          catalog.models.push({
            provider,
            id: String(model.id),
            name: String(model.name ?? model.id),
          });
        }
      });
    } catch {
      // 目录拿不到就当空目录：界面退化成手填不了也不至于报错。
    }
    return catalog;
  })();

  try {
    const value = await catalogCache.pending;
    if (value.providers.length > 0) {
      catalogCache.value = value;
      catalogCache.at = Date.now();
    }
    return value;
  } finally {
    catalogCache.pending = undefined;
  }
}

function lookupAgent(ctx, sessionId) {  try {
    return ctx.agents.get(sessionId);
  } catch {
    return undefined;
  }
}

/** 当前打开着的会话，按打开顺序。 */
function listSessions(ctx) {
  try {
    return ctx.sessions.list();
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { ok: false, error: message });
}
