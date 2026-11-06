/**
 * 调试助手：连上无头 Edge 里的沙盒 GUI，打印输入框周围的按钮与一段截图。
 *
 * 用法：node tools/probe-ui.mjs <url> [debugPort]
 * 产物：$env:TEMP\tower-ui.png
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const debugPort = Number(process.argv[3] ?? 19224);
if (url === undefined) {
  console.error('用法：node tools/probe-ui.mjs <url> [debugPort]');
  process.exit(2);
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'tower-probe-'));
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
let nextId = 1;

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener('message', (message) => {
  const frame = JSON.parse(message.data);
  if (frame.id === undefined) return;
  const waiter = pending.get(frame.id);
  pending.delete(frame.id);
  if (frame.error !== undefined) waiter?.reject(new Error(frame.error.message));
  else waiter?.resolve(frame.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
});
await send('Runtime.enable');
await send('Page.enable');
await sleep(7000);

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) return { error: result.exceptionDetails.text };
  return result.result?.value;
};

const buttons = await evaluate(`
  (() => {
    const out = [];
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      out.push({
        tag: el.tagName,
        aria: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        text: (el.textContent || '').trim().slice(0, 30),
        disabled: el.disabled === true,
        cls: (el.className || '').toString().slice(0, 60),
      });
    }
    return out.slice(0, 40);
  })()
`);
console.log('=== buttons ===');
console.log(JSON.stringify(buttons, null, 2));

const body = await evaluate(`document.body.innerText.slice(0, 1500)`);
console.log('\n=== body text ===');
console.log(body);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const file = join(process.env.TEMP ?? tmpdir(), 'tower-ui.png');
writeFileSync(file, Buffer.from(shot.data, 'base64'));
console.log(`\n截图: ${file}`);

socket.close();
browser.kill();
process.exit(0);
