/**
 * 真机验证「插件页里的配置表单」：打开 Plugins 页 → 找到本插件的卡片 →
 * 读出表单 → 改一个值 → 保存 → 复查 → 截图。
 *
 * 用法：node tools/probe-config-ui.mjs <url> [debugPort]
 *
 * 环境变量：
 *   TOWER_CFG_KEY=triggerRatio   改哪个字段（默认 triggerRatio，按 data-field 命中）
 *   TOWER_CFG_LABEL=触发线        没有 data-field 时按标签文本找（默认「触发线」）
 *   TOWER_CFG_VALUE=0.01         改成多少（默认 0.01）
 *   TOWER_CFG_KEEP=1             保存后不恢复（默认保存完再点「恢复默认」）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const debugPort = Number(process.argv[3] ?? 19231);
if (url === undefined) {
  console.error('用法：node tools/probe-config-ui.mjs <url> [debugPort]');
  process.exit(2);
}

const key = process.env.TOWER_CFG_KEY ?? 'triggerRatio';
const label = process.env.TOWER_CFG_LABEL ?? '触发线';
const value = process.env.TOWER_CFG_VALUE ?? '0.01';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'tower-cfg-ui-'));
const browser = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,1000',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && String(target.url).includes('127.0.0.1'));
      if (page !== undefined) return page;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error('CDP 端口没起来');
}

const target = await pageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const problems = [];
let nextId = 1;

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener('message', (message) => {
  const frame = JSON.parse(message.data);
  if (frame.id !== undefined) {
    const waiter = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error !== undefined) waiter?.reject(new Error(frame.error.message));
    else waiter?.resolve(frame.result);
    return;
  }
  if (frame.method === 'Runtime.exceptionThrown') {
    const detail = frame.params.exceptionDetails;
    problems.push(`exception: ${detail.text} ${detail.exception?.description ?? ''}`.trim());
  }
  if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') {
    problems.push(`console.error: ${frame.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
});
await send('Runtime.enable');
await send('Page.enable');
await sleep(Number(process.env.TOWER_CFG_WAIT_MS ?? 7000));

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) return { error: result.exceptionDetails.text };
  return result.result?.value;
};

const clickText = async (label) => evaluate(`
  (() => {
    for (const el of document.querySelectorAll('button,[role="button"],[role="tab"],a,div[tabindex]')) {
      if ((el.textContent || '').trim() === ${JSON.stringify(label)}) { el.click(); return true; }
    }
    return false;
  })()
`);

const clickContaining = async (needle) => evaluate(`
  (() => {
    const scope = document.querySelector('main') ?? document.body;
    const nodes = [...scope.querySelectorAll('button,[role="button"],a,div,li')];
    const exact = nodes.filter((el) => (el.textContent || '').trim() === ${JSON.stringify(needle)});
    const pool = exact.length > 0 ? exact : nodes.filter((el) => (el.textContent || '').includes(${JSON.stringify(needle)}));
    if (pool.length === 0) return false;
    const smallest = pool.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    const clickable = smallest.closest('button,[role="button"],a') ?? smallest;
    clickable.click();
    return { clicked: (clickable.textContent || '').trim().slice(0, 80), tag: clickable.tagName };
  })()
`);

const readConfigPanel = async () => evaluate(`(() => {
  const root = document.querySelector('.tw-cfg');
  return root === null ? null : (root.innerText || '');
})()`);

// 0) 关掉一次性弹窗
console.log('关闭弹窗:', await clickText('继续'));
await sleep(1200);

// 1) 进插件页
const navLabels = (await evaluate(`
  (() => {
    const out = [];
    for (const el of document.querySelectorAll('button,[role="button"],a,[role="tab"]')) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length < 16) out.push(text);
    }
    return [...new Set(out)].slice(0, 40);
  })()
`)) ?? [];
console.log('可点标签:', navLabels.join(' | '));

let entered = await clickText('插件');
if (entered !== true) entered = await clickText('Plugins');
console.log('进入插件页:', entered);
await sleep(2500);

// 2) 找本插件的卡片：在「已安装插件」标题下方、正文列（x > 320）里找同名元素。
//    不能按整页找 —— 左侧会话列表里每个会话都挂着工作区名 dsh-compaction-tower。
const found = await evaluate(`
  (() => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4,span,div')]
      .find((el) => (el.textContent || '').trim() === '已安装插件');
    const baseY = heading === undefined ? 0 : heading.getBoundingClientRect().top;
    // 卡片标题来自 locale/meta（中文界面显示「Tower 分层压缩」），没有 locale 时退回包名。
    const names = ['dsh-compaction-tower', 'Tower 分层压缩', 'Tower'];
    const candidates = [...document.querySelectorAll('div,span,a,button')].filter((el) => {
      const text = (el.textContent || '').trim();
      if (!names.some((name) => text === name)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.left > 320 && rect.top >= baseY - 4;
    });
    if (candidates.length === 0) return { ok: false, reason: '找不到已安装的卡片' };
    // 卡片标题是可点的 button，外层 titleRow 只是 div —— 必须点到 button 才有反应。
    const withButton = candidates.find((el) => el.tagName === 'BUTTON' || el.querySelector('button') !== null);
    const target = withButton ?? candidates[0];
    const clickable = target.tagName === 'BUTTON' ? target : (target.querySelector('button') ?? target.closest('a,button,[role="button"]') ?? target);
    clickable.click();
    return { ok: true, tag: clickable.tagName, cls: String(clickable.className).slice(0, 60) };
  })()
`);
console.log('点开本插件卡片:', JSON.stringify(found));
await sleep(2500);

// 3) 读表单
let panel = await readConfigPanel();
console.log('\n=== 配置表单 ===');
console.log(panel === null ? '（没找到 .tw-cfg，说明 slot 没渲染）' : panel);

if (panel === null) {
  const diag = await evaluate(`(() => ({
    styleInjected: document.getElementById('dsh-compaction-tower-style') !== null,
    bodyStart: (document.body.innerText || '').slice(0, 1600),
    cfgLike: [...document.querySelectorAll('[data-plugin-config]')].length,
    headings: [...document.querySelectorAll('h1,h2,h3')].map((el) => (el.textContent || '').trim()).slice(0, 12),
  }))()`);
  console.log('\n=== 诊断 ===');
  console.log('样式已注入:', diag?.styleInjected);
  console.log('配置区节点:', diag?.cfgLike);
  console.log('标题:', (diag?.headings ?? []).join(' | '));
  console.log('--- 正文 ---');
  console.log(diag?.bodyStart);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(process.env.TEMP ?? tmpdir(), 'tower-cfg-missing.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图: ${file}`);
  console.log('\n=== 页面错误 ===');
  console.log(problems.length === 0 ? '（无）' : problems.slice(0, 12).join('\n'));
  socket.close();
  browser.kill();
  process.exit(1);
}

// 4) 只读模式：不写，只顺带把 /tower/state 的预算读出来，验证「配置真的生效到运行时」
if (process.env.TOWER_CFG_READONLY === '1') {
  const budget = await evaluate(`fetch('/tower/state', { headers: { accept: 'application/json' } })
    .then((r) => r.json())
    .then((body) => body.budget ?? body.error ?? null)
    .catch((cause) => String(cause))`);
  console.log('\n=== 运行时预算（来自 /tower/state） ===');
  console.log(JSON.stringify(budget));
  console.log('\n=== 页面错误 ===');
  console.log(problems.length === 0 ? '（无）' : problems.slice(0, 12).join('\n'));
  socket.close();
  browser.kill();
  process.exit(0);
}

// 5) 改值：React 受控输入要绕过 value 的 setter
const changed = await evaluate(`
  (() => {
    const label = ${JSON.stringify(label)};
    const fieldKey = ${JSON.stringify(key)};
    const rows = [...document.querySelectorAll('.tw-cfg-field')];
    // 优先按 data-field 精确命中；没有该属性时退回标签文本包含匹配。
    const row = rows.find((el) => (el.dataset.field ?? '') === fieldKey)
      ?? rows.find((el) => {
        const name = el.querySelector('.tw-cfg-label');
        return name !== null && (name.textContent || '').includes(label);
      });
    if (row === undefined) return { ok: false, reason: '找不到字段' };
    const input = row.querySelector('input');
    if (input === null) return { ok: false, reason: '这一行没有输入框' };
    const before = input.value;
    if (input.type === 'checkbox') {
      input.click();
      return { ok: true, before, after: input.value, toggled: true };
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = [...document.querySelectorAll('button')]
      .map((el) => (el.textContent || '').trim())
      .find((text) => text === '保存' || text.startsWith('保存 ')) ?? null;
    return { ok: true, before, after: input.value, button };
  })()
`);
console.log('\n改值:', JSON.stringify(changed));
await sleep(600);

// 5) 保存
const saved = await evaluate(`
  (() => {
    for (const el of document.querySelectorAll('button')) {
      const text = (el.textContent || '').trim();
      if (text === '保存' || text.startsWith('保存 ')) { el.click(); return text; }
    }
    return null;
  })()
`);
console.log('点保存:', saved);
await sleep(2500);

console.log('\n=== 保存后 ===');
console.log(await readConfigPanel());

// 6) 恢复默认（除非要求保留）
if (process.env.TOWER_CFG_KEEP !== '1') {
  const reset = await evaluate(`
    (() => {
      for (const el of document.querySelectorAll('button')) {
        if ((el.textContent || '').trim() === '恢复默认') { el.click(); return true; }
      }
      return false;
    })()
  `);
  console.log('\n点恢复默认:', reset);
  await sleep(2500);
  console.log('\n=== 恢复后 ===');
  console.log(await readConfigPanel());
}

console.log('\n=== 页面错误 ===');
console.log(problems.length === 0 ? '（无）' : problems.slice(0, 12).join('\n'));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotFile = join(process.env.TEMP ?? tmpdir(), 'tower-cfg-ui.png');
writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
console.log(`\n截图: ${shotFile}`);

socket.close();
browser.kill();
process.exit(0);
