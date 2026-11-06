/**
 * 真机验证「Tower 面板能渲染、按钮能用」：在无头 Edge 里开一个会话，发几轮，
 * 再点开 Tower tab，必要时点一个操作按钮并再发一轮，最后留一张截图。
 *
 * 用法：
 *   node tools/check-ui-live.mjs <url> [debugPort] [prompt]
 *
 * 环境变量：
 *   TOWER_UI_TURNS=4              先发几轮（默认 1）
 *   TOWER_UI_ACTION=立即提交       点哪个按钮（可选：立即蒸馏 / 立即提交 / 合并选中）
 *   TOWER_UI_TURNS_AFTER_ACTION=1 点完按钮后再发几轮（验证排队的手动提交）
 *   TOWER_UI_WAIT_MS=…            页面加载后先等多久
 *
 * 会话型槽位（`conversation.view` 是 scope: 'session'）只在有会话打开时渲染，
 * 所以空页面看不到 tab —— 必须真的发一条消息。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const debugPort = Number(process.argv[3] ?? 19223);
const prompt = process.argv[4] ?? '只回答两个字：收到';
if (url === undefined) {
  console.error('用法：node tools/check-ui-live.mjs <url> [debugPort] [prompt]');
  process.exit(2);
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'tower-ui-live-'));
const browser = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,900',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  url,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
await sleep(Number(process.env.TOWER_UI_WAIT_MS ?? 6000));

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) return { error: result.exceptionDetails.text };
  return result.result?.value;
};

/** 发一个回合：聚焦输入框 → 打字 → 回车 → 等「已完成」计数增加。 */
async function sendTurn(label) {
  const doneCount = async () => (await evaluate(`(document.body.innerText.match(/已完成/g) ?? []).length`)) ?? 0;
  const before = await doneCount();
  const focused = await evaluate(`
    (() => {
      const candidates = [
        ...document.querySelectorAll('[contenteditable="true"]'),
        ...document.querySelectorAll('textarea'),
      ].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
      if (candidates.length === 0) return { ok: false };
      candidates[candidates.length - 1].focus();
      return { ok: true };
    })()
  `);
  if (focused?.ok !== true) {
    console.log(`第 ${label} 回合：找不到输入框`);
    return false;
  }
  await send('Input.insertText', { text: `${prompt}（${label}）` });
  await sleep(400);
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r' } : {}),
    });
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(2000);
    if ((await doneCount()) > before) {
      console.log(`第 ${label} 回合：完成`);
      return true;
    }
  }
  console.log(`第 ${label} 回合：超时`);
  return false;
}

const readPanel = async () => (await evaluate(`(() => {
  const root = document.querySelector('.tw-root');
  return root === null ? null : (root.innerText || '');
})()`)) ?? null;

const clickText = async (label) => evaluate(`
  (() => {
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if ((el.textContent || '').trim() === ${JSON.stringify(label)}) { el.click(); return true; }
    }
    return false;
  })()
`);

// 0) 关掉「预览版说明」之类的一次性弹窗
console.log('关闭弹窗:', await clickText('继续'));
await sleep(1500);

// 1) 先跑几轮，让观察者攒出块
const turns = Number(process.env.TOWER_UI_TURNS ?? 1);
for (let index = 1; index <= turns; index += 1) await sendTurn(index);

// 2) 等 tab 出现
let tabs = [];
for (let attempt = 0; attempt < 30; attempt += 1) {
  tabs = (await evaluate(`
    (() => {
      const out = [];
      for (const el of document.querySelectorAll('[role="tab"], button, a')) {
        const text = (el.textContent || '').trim();
        if (text.length > 0 && text.length < 24) out.push(text);
      }
      return [...new Set(out)].slice(0, 60);
    })()
  `)) ?? [];
  if (tabs.includes('Tower')) break;
  await sleep(1000);
}
console.log('tab 列表:', tabs.join(' | '));

// 3) 点开 Tower
console.log('点开 Tower tab:', await clickText('Tower'));
await sleep(4000);
console.log('\n=== 面板 ===');
console.log(await readPanel());

// 4) 可选：点一个面板按钮
const action = process.env.TOWER_UI_ACTION;
if (action !== undefined) {
  console.log(`\n点击「${action}」:`, await clickText(action));
  await sleep(3000);
  console.log('\n=== 操作后 ===');
  console.log(await readPanel());
}

// 5) 可选：按钮之后再发几轮（验证排队的手动提交真的在回合开始时执行）
const afterTurns = Number(process.env.TOWER_UI_TURNS_AFTER_ACTION ?? 0);
if (afterTurns > 0) {
  for (let index = 1; index <= afterTurns; index += 1) await sendTurn(`后${index}`);
  await sleep(2000);
  console.log('\n=== 再跑回合后的面板 ===');
  console.log(await readPanel());
}

console.log('\n=== 页面错误 ===');
console.log(problems.length === 0 ? '（无）' : problems.slice(0, 12).join('\n'));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotFile = join(process.env.TEMP ?? tmpdir(), 'tower-ui-live.png');
writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
console.log(`\n截图: ${shotFile}`);

socket.close();
browser.kill();
process.exit(0);
