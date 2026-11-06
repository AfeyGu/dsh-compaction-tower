/**
 * 打印最近若干条工具结果，用来看工具真的返回了什么。
 *
 * 跑法：node tools/inspect-tools.mjs <session.v4.jsonl.zstd> [条数]
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
const limit = Number(process.argv[3] ?? 3);
const raw = readFileSync(path);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const frames = [];
let start = 0;
for (let i = 1; i < raw.length - 3; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) {
    frames.push(raw.subarray(start, i));
    start = i;
  }
}
frames.push(raw.subarray(start));
let text = '';
for (const frame of frames) {
  if (frame.length === 0) continue;
  try { text += zstdDecompressSync(frame).toString('utf8'); } catch { /* 半截帧 */ }
}
const events = text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));

// tool/call 事件的 message.content 里带 name 与 toolCallId
const names = new Map();
for (const event of events) {
  if (event.type !== 'tool/call') continue;
  for (const part of event.data?.message?.content ?? []) {
    if (part.type === 'tool-call') names.set(part.toolCallId ?? part.id, part.name);
  }
  if (event.data?.message?.toolCallId !== undefined) names.set(event.data.message.toolCallId, event.data.message.name);
}

const results = events.filter((event) => event.type === 'tool/result').slice(-limit);
for (const event of results) {
  const message = event.data?.message ?? {};
  const name = names.get(message.toolCallId) ?? message.toolCallId ?? '?';
  const body = (message.content ?? []).map((part) => part.text ?? JSON.stringify(part)).join('\n');
  console.log(`── seq ${event.seq}  ${name}  isError=${message.isError}  ${body.length} 字 ──`);
  console.log(body.slice(0, 700));
  console.log('');
}
