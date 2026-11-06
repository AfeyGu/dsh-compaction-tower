/**
 * 探针：验证「块摘要」能否通过宿主的 JSON 无损检查。
 *
 * 背景：compactRegion 报 `session event "compaction/summary" carries
 * non-JSON-serializable data`，需要确定是哪一层数据不合格。
 *
 * 跑法：node tools/probe-json.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { snapshotJsonValue, isJsonValue } from '@deepseek-ai/dsh-util-values';

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
const block = events.find((event) => event.type === 'plugin:tower/block');
if (block === undefined) {
  console.error('日志里没有块记录');
  process.exit(2);
}

const summary = block.data.summary;
console.log(`摘要 ${summary.length} 段，第一段 ${summary[0].text.length} 字`);

const payload = {
  compactionId: 'probe',
  summary,
  shadowedRange: { start: block.data.covers[0], end: block.data.covers.at(-1) },
  shadowedSeqs: [...block.data.covers],
  shadowedTokenCount: block.data.coveredTokens,
};

const cases = [
  ['整段 payload', payload],
  ['只有 summary', summary],
  ['第一段文本', summary[0].text],
  ['covers 数组', [...block.data.covers]],
  ['coveredTokens', block.data.coveredTokens],
  ['block.data 全量', block.data],
];

for (const [label, value] of cases) {
  const ok = isJsonValue(value);
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    // 逐段拆开，找出具体哪一段不合格
    if (Array.isArray(value)) {
      value.forEach((item, index) => console.log(`   [${index}] ${isJsonValue(item) ? 'ok' : 'BAD'}`));
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) console.log(`   ${key}: ${isJsonValue(value[key]) ? 'ok' : 'BAD'}`);
    }
  }
}

const detached = snapshotJsonValue(payload);
console.log(detached === undefined ? 'snapshotJsonValue → undefined（会被 append 拒绝）' : 'snapshotJsonValue → 通过');
