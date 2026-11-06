/**
 * 接线测试：给一个假的 ctx，确认插件能装载、工具能定义、补丁能装上。
 *
 * 这一层不启动宿主，只验证「我们的代码形状对不对」：
 * 导入是否成功、Config 是否合法、defineTool 的参数契约是否被接受、
 * 事件监听与资源回收是否按 cordis 的方式登记。
 *
 * 跑法：node test/wire.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, name } from '../lib/index.js';
import { enginePatched } from '../lib/engine.js';
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
check('默认不暴露 advisor 工具', tools.has('advisor') === false);
check('监听了 turn-stopping', listeners.some((entry) => entry.event === 'agent/turn-stopping'));
check('块记录类型合法', /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u.test(BLOCK_RECORD_TYPE));
check('装载了 /advisor 子插件', subplugins.some((plugin) => plugin.name === 'compaction-tower-command'));

const oracle = subplugins.find((plugin) => plugin.name === 'compaction-tower-command');
await oracle?.apply(ctx);
check('注册了 /advisor 命令', commands.has('advisor'));
check('/advisor 有定义 id', typeof commands.get('advisor')?.definitionId === 'string');

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

// ── advisorExpose = true 时才把 advisor 暴露给模型 ──────────────────────
const exposed = new Map();
const exposedCtx = {
  ...ctx,
  tools: {
    register(tool) {
      exposed.set(tool.name, tool);
      return () => exposed.delete(tool.name);
    },
  },
  plugin() { return undefined; },
};
apply(exposedCtx, { advisorExpose: true });
check('advisorExpose 打开后注册 advisor', exposed.has('advisor'));
check('advisor 零参数', JSON.stringify(exposed.get('advisor')?.parameters?.properties ?? {}) === '{}');

if (failures.length === 0) {
  rmSync(home, { recursive: true, force: true });
  console.log(`✅ wire: ${passed} 项全部通过（工具 ${[...tools.keys()].join(', ')}；命令 ${[...commands.keys()].join(', ') || '无'}；路由 ${[...routes.keys()].join(', ') || '无'}）`);
} else {
  console.error(`❌ wire: ${failures.length} 项失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
