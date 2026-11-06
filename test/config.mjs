/**
 * 配置读写测试：覆盖层落盘、优先级、校验、以及 /tower/config 路由。
 *
 * 关键约束：绝不能碰真实的 ~/.dsh —— 在导入插件之前把 DSH_HOME 指到临时目录，
 * `dshHomePath()` 是调用时解析，所以这里设完就生效。
 *
 * 跑法：node test/config.mjs
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tower-cfg-'));
process.env.DSH_HOME = home;

const { ConfigStore, configPath } = await import('../lib/config-store.js');
const { DEFAULTS, FIELDS } = await import('../lib/config.js');
const { registerTowerRoutes } = await import('../lib/server.js');

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

// ── 路径跟随 DSH_HOME ───────────────────────────────────────────────────
check('配置文件落在 DSH_HOME 下', configPath() === join(home, 'storages', 'compaction-tower', 'config.json'));

// ── 三个来源的优先级 ────────────────────────────────────────────────────
const store = new ConfigStore({ triggerRatio: 0.3 });
equal('profile 条目覆盖默认值', store.config.triggerRatio, 0.3);
equal('未配置的键取默认值', store.config.targetRatio, DEFAULTS.targetRatio);

store.save({ targetRatio: 0.1 });
equal('界面值覆盖 profile', store.config.targetRatio, 0.1);
equal('没改的键仍取 profile', store.config.triggerRatio, 0.3);
const onDisk = JSON.parse(readFileSync(configPath(), 'utf8'));
equal('磁盘只存被改过的键', onDisk, { targetRatio: 0.1 });
check('临时文件没有残留', readdirSync(join(home, 'storages', 'compaction-tower')).join(',') === 'config.json');

// ── 重新装载后仍然生效（等价于重启宿主） ────────────────────────────────
const reloaded = new ConfigStore({ triggerRatio: 0.3 });
equal('重启后读到覆盖值', reloaded.config.targetRatio, 0.1);

// ── 校验 ────────────────────────────────────────────────────────────────
let threw = false;
try { store.save({ triggerRatio: 0.05 }); } catch { threw = true; }
check('保存后 target >= trigger 被拒', threw);
equal('被拒的写入没有落盘', JSON.parse(readFileSync(configPath(), 'utf8')).triggerRatio, undefined);

threw = false;
try { store.save({ nope: 1 }); } catch { threw = true; }
check('未知键被拒', threw);

threw = false;
try { store.save({ retainRecentGroups: 1.5 }); } catch { threw = true; }
check('整数项被拒非整数', threw);

threw = false;
try { store.save({ triggerRatio: 1.5 }); } catch { threw = true; }
check('比例超出 0..1 被拒', threw);

// ── 恢复默认 ────────────────────────────────────────────────────────────
store.reset(['targetRatio']);
equal('reset 回到 profile 值', store.config.targetRatio, DEFAULTS.targetRatio);
equal('reset 后磁盘为空对象', JSON.parse(readFileSync(configPath(), 'utf8')), {});

// ── onChange 把新值推给 Tower ───────────────────────────────────────────
let pushed = null;
store.onChange = (next) => { pushed = next; };
store.save({ mergeMinBlocks: 4 });
equal('保存会回调拿到新配置', pushed?.mergeMinBlocks, 4);

// ── 快照给界面的形状 ────────────────────────────────────────────────────
const snapshot = store.snapshot();
check('快照带配置文件路径', snapshot.path === configPath());
check('快照分组覆盖所有字段', snapshot.groups.flatMap((group) => group.fields).length === FIELDS.length);
const mergeField = snapshot.groups.flatMap((group) => group.fields).find((field) => field.key === 'mergeMinBlocks');
equal('快照标出被覆盖的字段', mergeField?.override, true);
equal('快照带字段默认值', mergeField?.default, DEFAULTS.mergeMinBlocks);
equal('比例字段带百分比', snapshot.groups.flatMap((g) => g.fields).find((f) => f.key === 'triggerRatio')?.percent, 30);

// ── 提示词字段：三档选择 + 多行文本 ────────────────────────────────────
const allFields = snapshot.groups.flatMap((group) => group.fields);
const modeField = allFields.find((field) => field.key === 'summaryPromptMode');
equal('提示词档位默认 host', modeField?.value, 'host');
check('档位下拉带三个候选项', Array.isArray(modeField?.options) && modeField.options.length === 3);
equal('自定义提示词是多行文本', allFields.find((field) => field.key === 'summaryPrompt')?.type, 'textarea');
equal('顾问请求也是多行文本', allFields.find((field) => field.key === 'advisorPrompt')?.type, 'textarea');
equal('顾问提示词默认留空', allFields.find((field) => field.key === 'advisorPrompt')?.value, '');
equal('顾问人设档位默认 builtin', allFields.find((field) => field.key === 'advisorSystemMode')?.value, 'builtin');
check('顾问人设档位两个候选', allFields.find((field) => field.key === 'advisorSystemMode')?.options?.length === 2);
equal('蒸馏提示词记着它的档位键', allFields.find((field) => field.key === 'summaryPrompt')?.modeKey, 'summaryPromptMode');
equal('蒸馏提示词知道预设映射', allFields.find((field) => field.key === 'summaryPrompt')?.presetFor, { host: 'summaryHost', zh: 'summaryZh' });
check('摘要输出上限默认是很大的保险丝', DEFAULTS.summaryMaxTokens >= 200000, String(DEFAULTS.summaryMaxTokens));
check('摘要输出上限允许填 0（不传）', allFields.find((field) => field.key === 'summaryMaxTokens')?.min === 0);
store.save({ summaryMaxTokens: 0 });
equal('上限可以存成 0', store.config.summaryMaxTokens, 0);
store.reset(['summaryMaxTokens']);

store.save({ summaryPromptMode: 'zh', advisorPrompt: '只回答一句话' });
equal('提示词档位可保存', store.config.summaryPromptMode, 'zh');
equal('顾问提示词可保存', store.config.advisorPrompt, '只回答一句话');
threw = false;
try { store.save({ summaryPromptMode: 'nope' }); } catch { threw = true; }
check('未知档位被拒', threw);
store.reset(['summaryPromptMode', 'advisorPrompt']);

// ── 路由：GET / POST /tower/config ──────────────────────────────────────
const routes = new Map();
const ctx = {
  get: () => undefined,
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  sessions: { list: () => [] },
  agents: { get: () => undefined },
};
registerTowerRoutes(ctx, { tower: {}, store });
check('注册了配置路由', routes.has('/tower/config'));

function fakeRequest(method, body) {
  const listeners = new Map();
  const req = {
    method,
    url: '/tower/config',
    on(event, handler) { listeners.set(event, handler); return req; },
  };
  setImmediate(() => {
    if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)));
    listeners.get('end')?.();
  });
  return req;
}

function fakeResponse() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) { res.status = status; },
    end(chunk) { res.body = chunk ?? ''; },
  };
  return res;
}

const handler = routes.get('/tower/config').handler;

const getRes = fakeResponse();
await handler(fakeRequest('GET'), getRes);
const getBody = JSON.parse(getRes.body);
equal('GET 返回 200', getRes.status, 200);
check('GET 返回分组', Array.isArray(getBody.groups) && getBody.groups.length > 0);

const badRes = fakeResponse();
await handler(fakeRequest('POST', { patch: { triggerRatio: 0.01 } }), badRes);
equal('非法补丁返回 400', badRes.status, 400);
check('400 带中文原因', JSON.parse(badRes.body).error.includes('目标线'));

const okRes = fakeResponse();
await handler(fakeRequest('POST', { patch: { targetRatio: 0.2 } }), okRes);
equal('合法补丁返回 200', okRes.status, 200);
equal('保存后快照是新值', JSON.parse(okRes.body).groups.flatMap((g) => g.fields).find((f) => f.key === 'targetRatio')?.value, 0.2);

const resetRes = fakeResponse();
await handler(fakeRequest('POST', { reset: ['targetRatio'] }), resetRes);
equal('reset 后回到默认', JSON.parse(resetRes.body).groups.flatMap((g) => g.fields).find((f) => f.key === 'targetRatio')?.value, DEFAULTS.targetRatio);

const emptyRes = fakeResponse();
await handler(fakeRequest('POST', {}), emptyRes);
equal('空 body 返回 400', emptyRes.status, 400);

// ── 模型目录：随配置一起下发，给观察者/顾问的下拉框用 ────────────────────
const catalogRoutes = new Map();
registerTowerRoutes({
  webServer: { register(route) { catalogRoutes.set(route.path, route); return () => {}; } },
  sessions: { list: () => [] },
  agents: { get: () => undefined },
  get: (name) => (name === 'llm'
    ? {
      listProviders: () => [{ id: 'magpie', name: 'Magpie' }, { id: 'deepseek-account', name: 'DeepSeek' }],
      // 一家掉线不该拖垮整张目录
      listModels: async (provider) => (provider === 'deepseek-account'
        ? [{ id: 'deepseek-flash', name: 'flash' }]
        : Promise.reject(new Error('offline'))),
    }
    : undefined),
}, { tower: {}, store });

const catalogRes = fakeResponse();
await catalogRoutes.get('/tower/config').handler(fakeRequest('GET'), catalogRes);
const catalogBody = JSON.parse(catalogRes.body);
equal('配置响应带 provider 目录', catalogBody.catalog.providers.map((provider) => provider.id), ['magpie', 'deepseek-account']);
equal('某个 provider 掉线不影响别的', catalogBody.catalog.models.map((model) => `${model.provider}/${model.id}`), ['deepseek-account/deepseek-flash']);

store.save({ observerProvider: 'magpie', observerModel: 'group/deepseek-flash' });
equal('观察者路由可以保存', `${store.config.observerProvider}/${store.config.observerModel}`, 'magpie/group/deepseek-flash');
equal('单块原文上限默认给到 200K', DEFAULTS.observerMaxTokens, 200000);

rmSync(home, { recursive: true, force: true });

if (failures.length === 0) {
  console.log(`✅ config: ${passed} 项全部通过（覆盖层 ${configPath().includes('tower') ? 'ok' : '?'}；临时目录已清理）`);
} else {
  console.error(`❌ config: ${failures.length} 项失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
