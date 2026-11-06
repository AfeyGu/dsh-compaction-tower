/**
 * 读会话日志里的「每次请求的上下文规模」，用来看压缩是否真的让请求变小。
 *
 * 跑法：node tools/inspect-requests.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
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

let turn = 0;
for (const event of events) {
  if (event.type === 'turn/start') turn = event.data?.turn ?? turn;
  if (event.type !== 'request/context') continue;
  const data = event.data ?? {};
  const context = data.context ?? data;
  const total = context.totalTokens ?? context.tokens ?? '?';
  const nodes = Array.isArray(context.nodes) ? context.nodes.length : '?';
  const breakdown = Array.isArray(context.breakdown)
    ? context.breakdown.map((entry) => `${entry.label ?? entry.kind}=${entry.tokens}`).join(' ')
    : '';
  console.log(`turn ${String(turn).padStart(2)}  seq ${String(event.seq).padStart(3)}  total=${total}  nodes=${nodes}  ${breakdown}`);
}
