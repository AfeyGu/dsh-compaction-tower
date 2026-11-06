/**
 * 读沙盒会话日志：解出 zstd 帧里的 JSONL，统计我们关心的事件。
 *
 * 跑法：node tools/inspect-log.mjs <session.v4.jsonl.zstd 的路径>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
if (!path) {
  console.error('用法: node tools/inspect-log.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}

const raw = readFileSync(path);
// 文件由多个独立的 zstd 帧拼接而成：按魔数切分后逐帧解压再拼接。
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
  try {
    text += zstdDecompressSync(frame).toString('utf8');
  } catch (error) {
    console.error(`跳过一帧（${frame.length} 字节）：${error.message}`);
  }
}

const events = [];
for (const line of text.split('\n')) {
  if (line.trim().length === 0) continue;
  try { events.push(JSON.parse(line)); } catch { /* 半截行 */ }
}

const counts = new Map();
for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);

console.log(`事件总数 ${events.length}，共 ${counts.size} 种类型`);
for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${type}${type.startsWith('plugin:') ? '   ← 插件记录' : ''}`);
}

const tower = events.filter((event) => event.type === 'plugin:tower/block');
console.log(`\nTower 块记录 ${tower.length} 条：`);
for (const event of tower) {
  const data = event.data ?? {};
  console.log(`  seq ${event.seq}  ${data.blockId}  T${data.tier}  covers=${JSON.stringify(data.covers)}  ${data.coveredTokens} tok  ${data.kind}`);
  console.log(`    摘要：${String(data.summary?.[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' ')}`);
}

const headers = events.filter((event) => event.type === 'request/header');
if (headers.length > 0) {
  const tools = headers[headers.length - 1].data?.header?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  console.log(`\n最后一次请求的工具（${names.length} 个）：${names.join(', ')}`);
  console.log(`  decompress 在列：${names.includes('decompress')}`);
  console.log(`  search_context 在列：${names.includes('search_context')}`);
}

const surface = events.filter((event) => event.surfaceOp?.op === 'replace');
console.log(`\n表层替换 ${surface.length} 次`);

const lifecycle = events.filter((event) => event.type.startsWith('compaction/'));
for (const event of lifecycle) {
  const data = event.data ?? {};
  const detail = event.type === 'compaction/end'
    ? `error=${data.error === undefined ? '(none)' : JSON.stringify(data.error).slice(0, 400)}`
    : `id=${data.compactionId ?? '?'} range=${data.startSeq ?? '?'}-${data.endSeq ?? '?'} shadowed=${data.shadowedTokenCount ?? '?'}`;
  console.log(`  seq ${event.seq}  ${event.type}  ${detail}`);
}
