/**
 * 客户端半侧的渲染测试。
 *
 * 这里不追求真实 DOM，只守住一条最容易犯、后果最重的规则：
 * **同一个组件每次渲染的钩子数量必须一致**。真实 React 在钩子数量变化时会抛
 * #310（Rendered more hooks than during the previous render）—— 面板会整块空白，
 * 而空白在界面上看不出任何原因。本文件用一个「会记账」的假 React 在 Node 里把
 * 这件事复现出来，让它在测试阶段就炸，而不是等用户看到一块白板。
 *
 * 跑法：node test/client.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed += 1; return; }
  failures.push(detail === undefined ? label : `${label}（${detail}）`);
}

// ── 载入客户端模块 ──────────────────────────────────────────────────────
let definition = null;
const sandbox = {
  window: { __ModuleLoader__: { load(candidate) { definition = candidate; } } },
  console,
  fetch: async () => { throw new Error('测试里不发请求'); },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  AbortController,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
check('客户端模块完成注册', definition !== null && definition.id === 'dsh-compaction-tower');

// ── 假 React：记录每个组件每次渲染用了几个钩子 ───────────────────────────
const hookCounts = new Map();
const hookStores = new Map();
let currentType = null;
let hookIndex = 0;

class Component {
  constructor(props) { this.props = props; this.state = {}; }
  setState(patch) { this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }; }
}

const Fragment = Symbol('Fragment');

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } };
}

function slotsOf(type) {
  if (!hookStores.has(type)) hookStores.set(type, []);
  return hookStores.get(type);
}

function useState(init) {
  const slots = slotsOf(currentType);
  const index = hookIndex += 1;
  if (!(index - 1 in slots)) slots[index - 1] = { value: typeof init === 'function' ? init() : init };
  const slot = slots[index - 1];
  const setter = (value) => { slot.value = typeof value === 'function' ? value(slot.value) : value; };
  slot.setter = setter;
  return [slot.value, setter];
}

const React = {
  Component,
  Fragment,
  createElement,
  useState,
  // 每个钩子都要计数：只数 useState 的话，「多一个 useCallback」这种错就漏过去了。
  useCallback: (fn) => { hookIndex += 1; return fn; },
  useMemo: (fn) => { hookIndex += 1; return fn(); },
  useEffect: () => { hookIndex += 1; },
  useRef: (init) => { hookIndex += 1; return { current: init }; },
};

function callComponent(type, props) {
  const previous = hookCounts.get(type);
  const savedType = currentType;
  const savedIndex = hookIndex;
  currentType = type;
  hookIndex = 0;
  try {
    const out = type(props);
    if (previous !== undefined && previous !== hookIndex) {
      throw new Error(`${type.name} 的钩子数量变了：上次 ${previous}，这次 ${hookIndex}（真实 React 会抛 #310）`);
    }
    hookCounts.set(type, hookIndex);
    return out;
  } finally {
    currentType = savedType;
    hookIndex = savedIndex;
  }
}

function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(render);
  if (node.type === Fragment) return render(node.props.children ?? []);
  if (typeof node.type === 'function') {
    if (typeof node.type.prototype?.render === 'function') return render(new node.type(node.props).render());
    return render(callComponent(node.type, node.props));
  }
  return { kind: 'host', tag: node.type, props: { ...node.props, children: render(node.props.children ?? []) } };
}

function texts(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const child of node) texts(child, out);
  else if (node !== null && typeof node === 'object' && node.kind === 'host') texts(node.props.children ?? [], out);
  return out;
}

/** 收集所有 host 节点，用来断言某些装饰元素真的渲染出来了。 */
function hosts(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) hosts(child, out); return out; }
  if (node !== null && typeof node === 'object' && node.kind === 'host') {
    out.push(node);
    hosts(node.props.children ?? [], out);
  }
  return out;
}

// ── 运行 ────────────────────────────────────────────────────────────────
const api = definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`未知依赖 ${name}`);
});
check('导出三个入口', typeof api.apply === 'function'
  && typeof api.TowerView === 'function'
  && typeof api.ConfigPanel === 'function');

const fakeState = {
  session: { id: 'session-test' },
  budget: { total: 200000, contextWindow: 1000000, triggerTokens: 450000, targetTokens: 150000 },
  blocks: [{
    blockId: 'b00001',
    tier: 1,
    covers: [1, 2],
    coveredLabel: '78.7K',
    summaryLabel: '2.2K',
    status: 'committed',
    summary: '摘要正文',
  }],
  advice: [],
  sessions: ['session-test'],
  pressure: { kind: 'no-block', blocks: 5, run: 120, total: 440900, trigger: 314600 },
  observation: { kind: 'no-material', unit: 52429, protected: 400 },
};

// 第一帧：state 还是 null，只有加载态
let loading = null;
try {
  loading = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  check('首帧渲染出加载态', texts(loading).some((text) => text.includes('加载中')), JSON.stringify(texts(loading)));
} catch (error) {
  check('首帧渲染不抛错', false, error.message);
}

// 第二帧：数据到位。这一步正是 #310 的现场 —— 钩子必须和首帧一模一样。
let loaded = null;
try {
  const slots = slotsOf(api.TowerView);
  check('状态钩子拿到了 setter', typeof slots[0]?.setter === 'function', '第一帧没有产生 state 钩子');
  slots[0]?.setter(fakeState);
  loaded = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  check('数据帧渲染出压缩记录', texts(loaded).some((text) => text.includes('压缩记录')), JSON.stringify(texts(loaded)));
  check('数据帧渲染出块号', texts(loaded).some((text) => text.includes('b00001')));
  check('数据帧渲染出设置按钮', texts(loaded).some((text) => text === '设置'));
  // 占用条是三段一条：实心（已用）/ 斜纹（当前→触发）/ 灰（触发之后）
  const withClass = (suffix) => hosts(loaded).filter((node) => typeof node.props.className === 'string'
    && node.props.className.includes(suffix));
  const realBar = withClass('tw-bar-real');
  const stripes = withClass('tw-bar-stripes');
  const dead = withClass('tw-bar-dead');
  check('已用段宽度按比例', realBar.length === 1 && realBar[0].props.style?.width === '20%',
    realBar.map((node) => node.props.style?.width).join(','));
  check('斜纹段从当前画到触发线', stripes.length === 1
    && stripes[0].props.style?.left === '20%' && stripes[0].props.style?.width === '25%',
    stripes.map((node) => `${node.props.style?.left}/${node.props.style?.width}`).join(','));
  check('灰段从触发线开始', dead.length === 1 && dead[0].props.style?.left === '45%',
    dead.map((node) => node.props.style?.left).join(','));
  check('图例给出触发线数字', texts(loaded).some((text) => text === '触发线 450.0K（内容）'), JSON.stringify(texts(loaded)));
  check('显示上次观察（为什么没蒸）', texts(loaded).some((text) => text.includes('没有可蒸材料')),
    JSON.stringify(texts(loaded).filter((text) => text.includes('上次观察'))));
  check('显示上次判定（为什么没压）', texts(loaded).some((text) => text.includes('没有可提交的块')),
    JSON.stringify(texts(loaded).filter((text) => text.includes('上次判定'))));

  // 越过触发线：斜纹消失是正常的（没有剩余空间），但要换成「更深的一截」而不是凭空少一段。
  slotsOf(api.TowerView)[0].setter({ ...fakeState, budget: { ...fakeState.budget, total: 500000 } });
  const overTree = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  const overNodes = (suffix) => hosts(overTree).filter((node) => typeof node.props.className === 'string'
    && node.props.className.includes(suffix));
  check('越线后不再画斜纹', overNodes('tw-bar-stripes').length === 0);
  check('实心被触发线截断', overNodes('tw-bar-real')[0]?.props.style?.width === '45%',
    overNodes('tw-bar-real')[0]?.props.style?.width);
  check('越线部分单独成一截', overNodes('tw-bar-over')[0]?.props.style?.left === '45%'
    && overNodes('tw-bar-over')[0]?.props.style?.width === '5%',
    `${overNodes('tw-bar-over')[0]?.props.style?.left}/${overNodes('tw-bar-over')[0]?.props.style?.width}`);
  check('灰段从当前开始', overNodes('tw-bar-dead')[0]?.props.style?.left === '50%',
    overNodes('tw-bar-dead')[0]?.props.style?.left);
  check('越线时图例给出提示', texts(overTree).some((text) => text.includes('已越过触发线')));

  // 固定开销（system + 工具 schema）：最前面一截黑色，实心从它右边起。
  slotsOf(api.TowerView)[0].setter({
    ...fakeState,
    budget: {
      ...fakeState.budget,
      total: 230000,
      content: 200000,
      fixed: { system: 20000, tools: 10000, total: 30000 },
      usable: 970000,
      triggerTokens: 436500,
    },
  });
  const fixedTree = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  const fixedNodes = (suffix) => hosts(fixedTree).filter((node) => typeof node.props.className === 'string'
    && node.props.className.includes(suffix));
  check('固定开销画成最前面一截', fixedNodes('tw-bar-fixed')[0]?.props.style?.width === '3%',
    fixedNodes('tw-bar-fixed')[0]?.props.style?.width);
  check('实心从固定开销右边起', fixedNodes('tw-bar-real')[0]?.props.style?.left === '3%'
    && fixedNodes('tw-bar-real')[0]?.props.style?.width === '20%',
    `${fixedNodes('tw-bar-real')[0]?.props.style?.left}/${fixedNodes('tw-bar-real')[0]?.props.style?.width}`);
  check('斜纹从当前画到触发线（含固定开销偏移）', fixedNodes('tw-bar-stripes')[0]?.props.style?.left === '23%',
    fixedNodes('tw-bar-stripes')[0]?.props.style?.left);
  check('图例分开报内容、可用与固定', texts(fixedTree).some((text) => text === '内容 200.0K / 可用 970.0K · 固定 30.0K'),
    JSON.stringify(texts(fixedTree)));

  // 判定行：第几次判定要真的填上数字（以前是硬编码的空字符串）。
  slotsOf(api.TowerView)[0].setter({
    ...fakeState,
    pressure: { kind: 'below-trigger', total: 470000, content: 440000, trigger: 436500, calls: 12 },
  });
  const verdictTree = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  check('判定行带上第几次', texts(verdictTree).some((text) => text.includes('（第 12 次判定）')),
    JSON.stringify(texts(verdictTree).filter((text) => text.includes('上次判定'))));
} catch (error) {
  check('数据帧渲染不抛错', false, error.message);
}

// 第三帧：切到设置视图，再切回来
try {
  const slots = slotsOf(api.TowerView);
  const setShowConfig = slots[5]?.setter;
  check('设置开关握着 setter', typeof setShowConfig === 'function');
  setShowConfig(true);
  const config = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  check('设置视图渲染出压缩参数', texts(config).some((text) => text.includes('压缩参数')), JSON.stringify(texts(config)));
  setShowConfig(false);
  const back = render(createElement(api.TowerView, { sessionId: 'session-test' }));
  check('切回压缩记录', texts(back).some((text) => text.includes('压缩记录')));
} catch (error) {
  check('视图切换不抛错', false, error.message);
}

// 配置面板自己也能渲染（插件页那条路）
try {
  render(createElement(api.ConfigPanel, { embedded: true }));
  check('配置面板可渲染', true);
} catch (error) {
  check('配置面板可渲染', false, error.message);
}

// ── 预设档：文本框只读展示预设正文；自定义档才可编辑 ─────────────────────
const modeField = (value) => ({
  key: 'summaryPromptMode',
  label: '蒸馏提示词',
  type: 'select',
  targetKey: 'summaryPrompt',
  options: [
    { value: 'host', label: '宿主' },
    { value: 'zh', label: '中文版' },
    { value: 'custom', label: '自定义' },
  ],
  value,
  default: 'host',
  base: 'host',
  override: false,
});
const promptField = (value) => ({
  key: 'summaryPrompt',
  label: '自定义蒸馏提示词',
  type: 'textarea',
  rows: 5,
  modeKey: 'summaryPromptMode',
  presetFor: { host: 'summaryHost', zh: 'summaryZh' },
  value,
  default: '',
  base: '',
  override: false,
});
const configPayload = (mode, text) => ({
  path: 'C:/tmp/tower-config.json',
  revision: 1,
  groups: [{ title: '观察者', fields: [modeField(mode), promptField(text)] }],
  presets: { summaryHost: 'EN PRESET TEXT', summaryZh: '中文预设正文' },
  catalog: { providers: [], models: [] },
  problem: null,
});

try {
  slotsOf(api.ConfigPanel)[0] = { value: configPayload('zh', '') };
  const presetTree = render(createElement(api.ConfigPanel, { embedded: true }));
  const presetBoxes = hosts(presetTree).filter((node) => node.tag === 'textarea');
  check('预设档渲染出一个文本框', presetBoxes.length === 1, `实际 ${presetBoxes.length}`);
  check('预设档文本框只读', presetBoxes[0]?.props.readOnly === true);
  check('预设档显示预设正文', presetBoxes[0]?.props.value === '中文预设正文', String(presetBoxes[0]?.props.value));
  check('只读样式生效', String(presetBoxes[0]?.props.className).includes('tw-cfg-readonly'));

  slotsOf(api.ConfigPanel)[0] = { value: configPayload('custom', '我自己的提示词') };
  const customTree = render(createElement(api.ConfigPanel, { embedded: true }));
  const customBoxes = hosts(customTree).filter((node) => node.tag === 'textarea');
  check('自定义档文本框可编辑', customBoxes[0]?.props.readOnly === false);
  check('自定义档显示自己的文本', customBoxes[0]?.props.value === '我自己的提示词');
} catch (error) {
  check('配置面板渲染不抛错', false, error.message);
}

if (failures.length === 0) {
  console.log(`✅ client: ${passed} 项全部通过（钩子数量一致性已守住）`);
} else {
  console.error(`❌ client: ${failures.length} 项失败`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exitCode = 1;
}
