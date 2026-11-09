/**
 * 接线测试：给一个假的 ctx，确认插件能装载、工具能定义、补丁能装上。
 *
 * 这一层不启动宿主，只验证「我们的代码形状对不对」：
 * 导入是否成功、Config 是否合法、defineTool 的参数契约是否被接受、
 * 事件监听与资源回收是否按 cordis 的方式登记。
 *
 * 跑法：node test/wire.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, name } from '../lib/index.js';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import { enginePatched, installEnginePatches } from '../lib/engine.js';
import { BLOCK_RECORD_TYPE } from '../lib/core.js';

// 配置覆盖层会写到 DSH_HOME 下，测试里指到临时目录，别碰真实的 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'tower-wire-'));
process.env.DSH_HOME = home;

const tools = new Map();
const listeners = [];
const effects = [];
const commands = new Map();
const subplugins = [];
const routes = new Map();

const ctx = {
  logger: { info: () => {}, warn: (msg) => console.log(`[warn] ${msg}`), error: () => {} },
  on(event, handler) { listeners.push({ event, handler }); },
  effect(generatorFactory) {
    const iterator = generatorFactory();
    let step = iterator.next();
    while (!step.done) { effects.push(step.value); step = iterator.next(); }
  },
  get() { return undefined; },
  /** 子插件：记下来，测试里手动 apply，便于验证可选能力。 */
  plugin(plugin) {
    subplugins.push(plugin);
    return plugin;
  },
  commands: {
    register(definition) {
      if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`);
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  tools: {
    register(tool) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
  },
  tokenMeter: { estimateMessage: () => 42, measure: () => ({ nodes: [], totalTokens: 0 }) },
  llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) },
};

const failures = [];
let passed = 0;
function check(label, condition) {
  if (condition) { passed += 1; return; }
  failures.push(label);
}

apply(ctx, {});

check('插件名正确', name === 'compaction-tower');
check('注入四项服务', JSON.stringify(inject) === JSON.stringify(['tools', 'tokenMeter', 'llm', 'sessions']));
check('引擎补丁已装上', enginePatched() === true);
check('注册了 decompress', tools.has('decompress'));
check('注册了 search_context', tools.has('search_context'));
check('监听了 turn-stopping', listeners.some((entry) => entry.event === 'agent/turn-stopping'));
check('块记录类型合法', /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u.test(BLOCK_RECORD_TYPE));

const routesPlugin = subplugins.find((plugin) => plugin.name === 'compaction-tower-routes');
check('装载了 Web 路由子插件', routesPlugin !== undefined);
await routesPlugin?.apply(ctx);
check('注册了状态路由', routes.has('/tower/state'));
check('注册了操作路由', routes.has('/tower/action'));
check('注册了配置路由', routes.has('/tower/config'));

const decompress = tools.get('decompress');
check('decompress 有 output 契约', typeof decompress?.output?.render === 'function');
check('decompress 参数含 blockId/range', Boolean(decompress?.parameters?.properties?.blockId && decompress?.parameters?.properties?.range));
const search = tools.get('search_context');
check('search_context 的 query 必填', search?.parameters?.required?.includes('query') === true);

// sourceEventSeqs / surfaceOp 的调用形状无法在这里验证，留待真机联调。

// ── 重装插件后，补丁必须改指向新实例 ────────────────────────────────────
// 原型补丁只装一次（PATCHED 标记挡住重复安装），如果方法闭包捕获了 tower，
// 插件重新装载后补丁会一直捏着旧实例：旧实例收到调用，界面读的却是新实例，
// 表现就是「内容越线了但上次判定还没跑过」。这里验证引用会跟着换。
const rebindCalls = [];
const fakeTower = (tag) => ({
  rememberEngine() {},
  compactIfNeeded() { rebindCalls.push(tag); return null; },
  serveSummary() { rebindCalls.push(`${tag}-sum`); return null; },
});
installEnginePatches(fakeTower('A'));
BasicCompactionEngine.prototype.compactIfNeeded.call({}, { session: {} }, 'pressure', undefined);
installEnginePatches(fakeTower('B'));
BasicCompactionEngine.prototype.compactIfNeeded.call({}, { session: {} }, 'pressure', undefined);
check('重装后补丁改指向新实例', JSON.stringify(rebindCalls) === JSON.stringify(['A', 'B']), rebindCalls.join(','));

// ── 插件模块被重新加载后，补丁仍指向新实例 ──────────────────────────────
// cordis 重装插件时会新建模块实例。若补丁把实例存在模块级变量里，
// 原型上的旧闭包读的是旧模块的变量，新模块换自己的那份，等于没换 —— 现象是
// 「面板说还没判定过」「观察者说引擎实例还没露面」。用带 query 的动态 import
// 造出第二个模块实例，复现这条。
const freshEngine = await import('../lib/engine.js?instance=2');
const freshCalls = [];
freshEngine.installEnginePatches({
  rememberEngine() {},
  compactIfNeeded() { freshCalls.push('fresh'); return null; },
  serveSummary() { freshCalls.push('fresh-sum'); return null; },
  manualCompact() { freshCalls.push('fresh-manual'); return null; },
});
BasicCompactionEngine.prototype.compactIfNeeded.call({}, { session: {} }, 'pressure', undefined);
check('新模块实例能接管旧闭包', freshCalls.length === 1 && freshCalls[0] === 'fresh', freshCalls.join(','));

// ── package.json 不能带 BOM ─────────────────────────────────────────────
// 宿主装包时要 JSON.parse 它，BOM 会让整条安装被拒（Unexpected token '\uFEFF'）。
// pnpm pack 会重排 JSON 把 BOM 抹掉，所以本地装没事；npm publish 是原样拷贝，
// 带 BOM 的包一发布，别人就装不上。Windows 上用 PowerShell 改这个文件最容易踩。
const pkgBytes = readFileSync(new URL('../package.json', import.meta.url));
check('package.json 不带 BOM',
  !(pkgBytes[0] === 0xEF && pkgBytes[1] === 0xBB && pkgBytes[2] === 0xBF),
  [...pkgBytes.subarray(0, 3)].map((b) => b.toString(16)).join(' '));
check('package.json 能被严格 JSON.parse 解析',
  (() => { try { JSON.parse(pkgBytes.toString('utf8')); return true; } catch { return false; } })());

if (failures.length === 0) {
  rmSync(home, { recursive: true, force: true });
  console.log(`✅ wire: ${passed} 项全部通过（工具 ${[...tools.keys()].join(', ')}；命令 ${[...commands.keys()].join(', ') || '无'}；路由 ${[...routes.keys()].join(', ') || '无'}）`);
} else {
  console.error(`❌ wire: ${failures.length} 项失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
