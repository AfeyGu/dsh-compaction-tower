/**
 * 布局探针：在不同窗口宽度下量「Tower 面板」与「配置表单」有没有溢出、有没有被挤压，
 * 每种宽度留一张截图。顺带能验证 /advisor 斜杠命令（TOWER_SLASH=1）。
 *
 * 用法：node tools/probe-layout.mjs <url> [debugPort]
 *
 * 环境变量：
 *   TOWER_WIDTHS=1440,1024,800   要测的宽度（默认这三个）
 *   TOWER_LAYOUT_TARGET=panel|config|both（默认 both）
 *   TOWER_SLASH=1                额外测一次 /advisor（会真的发一条斜杠命令）
 *   TOWER_LAYOUT_TURNS=16        先发几轮（默认 0；空浏览器里没有会话就看不到 tab，且块要几轮才攒得出来）
 *   TOWER_LAYOUT_WAIT_MS=6000    页面加载后先等多久
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const debugPort = Number(process.argv[3] ?? 19260);
if (url === undefined) {
  console.error('用法：node tools/probe-layout.mjs <url> [debugPort]');
  process.exit(2);
}

const widths = (process.env.TOWER_WIDTHS ?? '1440,1024,800')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value));
const target = process.env.TOWER_LAYOUT_TARGET ?? 'both';
const slash = process.env.TOWER_SLASH === '1';
const firstTurn = Number(process.env.TOWER_LAYOUT_TURNS ?? 0);

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'tower-layout-'));
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
      const page = targets.find((item) => item.type === 'page' && String(item.url).includes('127.0.0.1'));
      if (page !== undefined) return page;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error('CDP 端口没起来');
}

const targetPage = await pageTarget();
const socket = new WebSocket(targetPage.webSocketDebuggerUrl);
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
await sleep(Number(process.env.TOWER_LAYOUT_WAIT_MS ?? 6000));

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) return { error: result.exceptionDetails.text };
  return result.result?.value;
};

const clickText = async (label) => evaluate(`
  (() => {
    for (const el of document.querySelectorAll('button,[role="button"],a,li,div,span')) {
      if ((el.textContent || '').trim() === ${JSON.stringify(label)}) { el.click(); return true; }
    }
    return false;
  })()
`);

async function setWidth(width) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: 900,
  });
  await sleep(700);
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(process.env.TEMP ?? tmpdir(), `${name}.png`);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

/** 量页面有没有横向溢出，以及关键元素占多宽。 */
const measure = async (selector) => evaluate(`(() => {
  const doc = document.documentElement;
  const box = (el) => {
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    return {
      w: Math.round(rect.width),
      x: Math.round(rect.left),
      right: Math.round(rect.right),
      h: Math.round(rect.height),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      clipped: el.scrollWidth > el.clientWidth + 1,
    };
  };
  const root = document.querySelector(${JSON.stringify(selector)});
  if (root === null) return { missing: true, innerWidth: window.innerWidth };
  const table = root.querySelector('table');
  const fields = [...root.querySelectorAll('.tw-cfg-field')];
  const squeezed = fields.filter((field) => {
    const label = field.querySelector('.tw-cfg-label');
    const body = field.querySelector('.tw-cfg-body');
    if (label === null || body === null) return false;
    return label.getBoundingClientRect().right > body.getBoundingClientRect().left + 1;
  }).length;
  const cells = table === null ? [] : [...table.querySelectorAll('th')].map((cell) => Math.round(cell.getBoundingClientRect().width));
  return {
    innerWidth: window.innerWidth,
    pageOverflow: doc.scrollWidth > window.innerWidth + 1,
    docScrollWidth: doc.scrollWidth,
    root: box(root),
    table: box(table),
    columnWidths: cells,
    fields: fields.length,
    squeezed,
  };
})()`);

/** 发一条消息（首个回合用，确保有会话可看）。 */
async function sendTurn(text) {
  const done = async () => (await evaluate(`(document.body.innerText.match(/已完成/g) ?? []).length`)) ?? 0;
  const before = await done();
  const focused = await evaluate(`
    (() => {
      const list = [
        ...document.querySelectorAll('[contenteditable="true"]'),
        ...document.querySelectorAll('textarea'),
      ].filter((el) => el.getClientRects().length > 0);
      if (list.length === 0) return { ok: false };
      list[list.length - 1].focus();
      return { ok: true };
    })()
  `);
  if (focused?.ok !== true) return false;
  await send('Input.insertText', { text });
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
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(2000);
    if ((await done()) > before) return true;
  }
  return false;
}

await clickText('继续');
await sleep(1200);

// 可选：先在侧栏里点开某个会话（标题包含该子串），用来复测已经攒了很多块的旧会话
const sessionHint = process.env.TOWER_LAYOUT_SESSION;
if (sessionHint !== undefined && sessionHint.length > 0) {
  const picked = await evaluate(`
    (() => {
      const hint = ${JSON.stringify(sessionHint)};
      const items = [...document.querySelectorAll('button,a,li,div,span')].filter((el) => {
        const text = (el.textContent || '').trim();
        const rect = el.getBoundingClientRect();
        return text.includes(hint) && rect.left < 300 && rect.width > 40 && rect.height > 16 && rect.height < 70;
      });
      if (items.length === 0) return { ok: false };
      // 取后代最少的就是最内层那个元素
      const pick = items.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
      pick.click();
      return { ok: true, text: (pick.textContent || '').trim().slice(0, 40) };
    })()
  `);
  console.log('打开旧会话:', JSON.stringify(picked));
  await sleep(3000);
}

if (firstTurn > 0) {
  for (let index = 1; index <= firstTurn; index += 1) {
    const ok = await sendTurn(`只回答两个字：收到（${index}）`);
    console.log(`第 ${index}/${firstTurn} 轮:`, ok);
  }
  await sleep(1500);
}

// ── 面板：多种宽度 ────────────────────────────────────────────────────
if (target === 'panel' || target === 'both') {
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
  console.log('点开 Tower tab:', await clickText('Tower'));
  await sleep(3000);

  for (const width of widths) {
    await setWidth(width);
    const info = await measure('.tw-root');
    console.log(`\n[面板 ${width}px] ${JSON.stringify(info)}`);
    console.log('截图:', await shot(`tower-panel-${width}`));
    if (process.env.TOWER_LAYOUT_DUMP === '1') {
      console.log('--- 面板文字 ---');
      console.log(await evaluate(`(() => {
        const root = document.querySelector('.tw-root');
        return root === null ? null : (root.innerText || '');
      })()`));
    }
  }

  if (slash) {
    console.log('\n=== /advisor 斜杠命令 ===');
    const before = await evaluate(`(document.querySelector('.tw-root')?.innerText.match(/顾问意见（(\\d+)）/) ?? [])[1] ?? null`);
    console.log('执行前顾问条数:', before);
    await setWidth(1440);
    const sent = await sendTurn('/advisor');
    console.log('发出 /advisor:', sent);
    await sleep(3000);
    const body = await evaluate(`document.body.innerText.slice(-1200)`);
    console.log('页面尾部文字:\n' + body);
    const after = await evaluate(`(document.querySelector('.tw-root')?.innerText.match(/顾问意见（(\\d+)）/) ?? [])[1] ?? null`);
    console.log('执行后顾问条数:', after);
    await clickText('Tower');
    await sleep(1500);
    console.log('面板顾问段:\n' + JSON.stringify(await evaluate(`(() => {
      const root = document.querySelector('.tw-root');
      if (root === null) return null;
      const text = root.innerText || '';
      const index = text.indexOf('顾问意见');
      return index < 0 ? text.slice(-400) : text.slice(index, index + 600);
    })()`)));
    console.log('截图:', await shot('tower-advisor'));
  }
}

// ── 配置表单：多种宽度 ────────────────────────────────────────────────
if (target === 'config' || target === 'both') {
  await setWidth(1440);
  console.log('\n进入插件页:', await clickText('插件'));
  await sleep(2500);
  // 卡片在视口外时不会被点，先把它滚进来（0.2.2 的插件页比一屏长）
  const scrolled = await evaluate(`
    (() => {
      const heading = [...document.querySelectorAll('h1,h2,h3,h4,span,div')]
        .find((el) => (el.textContent || '').trim() === '已安装插件');
      if (heading === undefined) return { ok: false, reason: 'no-heading' };
      heading.scrollIntoView({ block: 'start' });
      return { ok: true, top: Math.round(heading.getBoundingClientRect().top) };
    })()
  `);
  await sleep(1200);
  const opened = await evaluate(`
    (() => {
      const heading = [...document.querySelectorAll('h1,h2,h3,h4,span,div')]
        .find((el) => (el.textContent || '').trim() === '已安装插件');
      const baseY = heading === undefined ? 0 : heading.getBoundingClientRect().top;
      const names = ['dsh-compaction-tower', 'Tower 分层压缩', 'Tower'];
      const seen = [];
      const candidates = [...document.querySelectorAll('div,span,a,button')].filter((el) => {
        const text = (el.textContent || '').trim();
        if (!names.some((name) => text === name)) return false;
        const rect = el.getBoundingClientRect();
        seen.push({ tag: el.tagName, top: Math.round(rect.top), left: Math.round(rect.left), w: Math.round(rect.width) });
        return rect.width > 0 && rect.left > 320 && rect.top >= baseY - 4;
      });
      const button = candidates.find((el) => el.tagName === 'BUTTON') ?? candidates[0];
      if (button === undefined) return { ok: false, count: candidates.length, baseY: Math.round(baseY), seen: seen.slice(0, 6) };
      button.click();
      return { ok: true, tag: button.tagName };
    })()
  `);
  console.log('滚动到已安装插件:', JSON.stringify(scrolled));
  console.log('点开本插件卡片:', JSON.stringify(opened));
  await sleep(2500);

  for (const width of widths) {
    await setWidth(width);
    const info = await measure('.tw-cfg');
    console.log(`\n[配置 ${width}px] ${JSON.stringify(info)}`);
    console.log('截图:', await shot(`tower-config-${width}`));
  }
}

console.log('\n=== 页面错误 ===');
console.log(problems.length === 0 ? '（无）' : problems.slice(0, 12).join('\n'));

socket.close();
browser.kill();
process.exit(0);
