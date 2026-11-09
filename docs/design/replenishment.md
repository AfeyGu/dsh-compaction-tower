# 观察者按缺口补货

> 只改**观察者的派发策略**（蒸哪层、蒸几块）。不改账本格式、不改提交循环、不改组装与读回。
> 目标：把「每层固定备 K 份」换成「离触发线还差多少就蒸多少」。

---

## 0. 一句话

观察者不再问「材料够不够一段」，而是问「还差多少库存」；块数是被切段数出来的，不是预先配的。

---

## 1. 现状与问题

现在的算法是 `reserveUnitsOf(usable)`：

```
U = distillMinRunRatio × 可用预算          // 一个单位
D = (triggerRatio − targetRatio) × 可用预算 // 一次越线要回收的量
K = ceil(D / U) + 1                        // 每层备 K 份
```

然后 `planObservation` 逐层算 `missing = K×U − inventory[tier]`，按缺口发名额。

四个问题：

| # | 问题 | 后果 |
|---|---|---|
| 1 | **每层各备 K 份** | T1 备 7 块、T2 再备 7 块，而越线只需要 `D`。总量约 2 倍冗余，全是 LLM 调用 |
| 2 | **与内容无关** | 会话才 10% 就开始备货，可能整场都用不上 |
| 3 | **忽略回收率** | 一块 T1 实际回收 ≈ 0.8U、T2 ≈ 0.6U，算法却按 1U 记账 |
| 4 | **蒸馏不避开保护区** | 休眠块的 covers 可能整段落在保护区里，被算进库存但提交时提不出来（`headRun` 不含保护区） |

第 4 条最隐蔽：库存显示「够了」，越线时却一块都提交不了。

---

## 2. 符号

| 符号 | 含义 | 来源 |
|---|---|---|
| `B` | 可用预算 = 窗口 − 固定开销（system + 工具 schema） | `budgetOf` / `overheadOf` |
| `C` | 内容用量（不含固定开销，已乘事实修正系数） | `planPressure` 里的 `content` |
| `T` | 触发线 = `triggerRatio × B` | 派生 |
| `G` | 目标线 = `targetRatio × B` | 派生 |
| `D` | 一次越线要回收 = `T − G` | **派生，不做配置项** |
| `U` | 一个单位 = `distillMinRunRatio × B` | 派生 |
| `r` | 净回收率：一块蒸完能省下覆盖量的百分之几 | 见 §6 |
| `inv[t]` | 第 t 层的库存净回收 token | `inventoryOf` |
| `target` | 本轮要备的库存 | §3 |
| `need` | 还差多少 = 逐层抵扣后的缺口 | §5 |

`D` 必须由两条线相减得出。单独配一个 `D`，线和线之间迟早打架。

---

## 3. 备多少：target

```
target = 0                                        若 C < G
       = min(D, C − G + U) + U × r(0)             若 C ≥ G
```

- `C − G`：离目标线多远，最朴素的需求；
- `+ U`：提前一个段动手，等真缺了再蒸来不及；
- `+ U × r(0)`：误差垫——`r` 可能估高，观察者跑的时候内容还在涨；
- `min(D, …)` 只封顶主项，垫加在外面，所以实备上限是 `D + U·r(0)`。

---

## 4. 手里有多少：库存口径

只算一种块：**蒸好了、还没提交、且材料还在表层**。

```js
// select.js —— 与 planCommits 共用同一个函数，不允许各写一份
export function usable(block, { surfaceSeqs }) {
  return block.covers.length > 0
    && block.covers.every((seq) => surfaceSeqs.has(seq))
    && block.summaryTokens > 0
    && block.summaryTokens < block.coveredTokens;
}

// tower.js —— 按层累计净回收
inventoryOf(session, blocks)   // Map<tier, covered − summary>
```

`usable` 里那条「covers 仍在表层」是 DSH 特有的：宿主压缩会把一段历史换成没有块号的 checkpoint，原料于是离开表层。少了这条，库存会假满。

「与提交同源」是硬约束：两处各写一份判据，迟早分叉——库存算进一个提交不掉的块，观察者停手，越线时才发现无货。

---

## 5. 还差多少：need 递推

```
need = target − inv[1]                    // 第一层只扣第一层的库存
for level = 0, 1, 2, …:
    if need ≤ 0: break
    if level > 0:
        need -= inv[level + 1]            // 轮到自己这层，才扣自己这层的库存
        if need ≤ 0: break
    本层材料 = 切段(level)
    for chunk in 本层材料:
        if need ≤ 0: break
        派发(chunk)
        need -= chunk.tokens × r(level)
```

三个要点：

1. **逐层抵扣，不要一次扣总账。**
   若写成 `need = target − Σ inv`，T2 的存货会顶掉 T1 的名额：T1 明明又攒出材料，却因为「总库存够了」而不蒸；越线时提交虽然仍是 T1 先，但能动用的只有既有那几块，缺口只能靠 T2 补——备料顺序和提交顺序就反了。
2. **本层没材料就 `continue` 到上一层，不是 `break`。**
   T1 原文枯竭不代表 T2 没材料：T2 的原料是已提交的 T1 块，与原文余量无关。
3. **`need` 是 token，不是块数。**
   T1 一块约 1% 预算、T2 约 2%，拿块数走账必然偏。

---

## 6. 回收率 r

```
r(level) = 缺省 0.8（level 0）/ 0.6（level ≥ 1）
           若同层最近 10 块里有 ≥3 块可算，取中位数（下界 0.5）
```

缺省值来自摘要提示词的长度约束（原文材料 ≤ 20%，摘要材料 ≤ 40%）。这是整条链上**唯一需要预报的量**，其余（B/C/T/G/U/covered/库存）都是账上能查的数。

中位数抗单块写歪；只看最近 10 块，换模型后旧样本自动淘汰；下界 0.5 防极端短块把 `r` 拉到接近 1。

---

## 7. 材料与切段

| 层 | 材料 | 切法 |
|---|---|---|
| `level = 0` | 保护区之外的连续原文 | 每个连续区独立切，洞两侧绝不并段 |
| `level ≥ 1` | 已提交、未被蒸馏的该层 checkpoint | 按覆盖起点切，id 跳号处断开 |

**改动一：T1 材料必须排除保护区。**
现在是 `protectedSeqs: new Set()`（刻意不限制），理由曾是「提前备着等材料滑出去」。但这样库存与可提交性就对不上（见 §1 第 4 条）。改成与提交同一口径后，新蒸出的块 covers 天然在保护区外，而保护区只会往前移，所以它永远可提交。

**改动二：越线时允许切尾巴。**
`C ≥ T` 时给 `selectRawRun` / `selectMergeRun` 加 `flushTail`，把不足一个单位的尾巴也切出来。没有这条会死锁：内容越线、材料不足一段、观察者「没有可蒸材料」、越线判定又无货可提。

注意是 `flushTail`（只放行尾巴），不是把段长降到 1（那会一次切出几十个小块）。

---

## 8. 时机与并发

| 时机 | 行为 | 变化 |
|---|---|---|
| 每个 step 前 | `pump(wait:false)`，5 秒节流 | 不变 |
| 回合结束 | `pump(wait:true)` | 不变 |

并发保持 `observerConcurrency`：每轮派发总数 ≤ 槽位，`need` 没填完的留到下一轮（节流后自然重来）。Sisyph 那边的单飞等价于槽位无限，我们这边要显式收口。

---

## 9. 数值走查

归一化 `B = 100`，`T = 60`，`G = 40`，`D = 20`，`U = 5`，`r(0) = 0.8`。

| C | target = min(20, C−40+5) + 4 | 库存 | need | 派发 |
|---|---|---|---|---|
| 44 | min(20, 9) + 4 = 13 | 0 | 13 | T1 切 3 段（15） |
| 48 | min(20, 13) + 4 = 17 | 15 | 2 | T1 切 1 段（5） |
| 56 | min(20, 21) + 4 = 24 | 20 | 4 | T1 切 1 段（5） |
| 60 | 24 | 25 | 0 | 不蒸 |

到越线时库存 25 ≥ D = 20，提交 5 块压回 40，第 6 块是垫。

**逐层抵扣的例子**：`target = 24`，`inv[1] = 8`（2 个 T1），`inv[2] = 12`（4 个 T2）。

- `need = 24 − 8 = 16`
- level 0 有材料 → 继续蒸 T1，直到 `need` 降下来（**不会因为 T2 有 12 就停手**）
- level 0 没材料 → `need -= inv[2] = 12` → `need = 4` → T2 再切一段

---

## 10. 边界情况

| # | 情况 | 对策 |
|---|---|---|
| 1 | 越线且材料不足一段 | `flushTail`（§7 改动二） |
| 2 | 保护区自己超过触发线 | `headRun` 返回 null → `no-range`；面板单列「保护区占用」并告警 |
| 3 | 观察者连续失败 | 断路器（本设计不做，另开） |
| 4 | 摘要没比原料短 | `usable` 里含 `summary < covered`（已有） |
| 5 | 单条消息比 U 还大 | 单段上限 ≤ 观察者窗口一半，超了在消息边界拆 |
| 6 | 计划算出后块被提交 | `distillOne` 保留 `still` 检查 |
| 7 | 配置矛盾（`target ≥ trigger`、`U ≥ D`） | 加载时校验并给人话 |

---

## 11. 接口改动

### `lib/select.js`

| 函数 | 性质 | 说明 |
|---|---|---|
| `usable(block, {surfaceSeqs})` | 不动 | 提交与库存共用 |
| `planObservation({targetTokens, inventory, materials, recovery, concurrency})` | **重写** | 入参全部换成 token 口径；返回 `[{level, count}]` |
| `selectRawRun(..., {flushTail})` | 加参数 | 越线时放行尾巴 |
| `selectMergeRun(..., {flushTail})` | 加参数 | 同上 |

### `lib/tower.js`

| 成员 | 变化 |
|---|---|
| `reserveUnitsOf(usable)` | **删除** |
| `planTarget({usable, content, targetRatio, triggerRatio})` | **新增**（纯函数，可放 select.js） |
| `recoveryRatio(session, level)` | **新增** |
| `inventoryOf(session, blocks)` | 不变（已按层累计净回收） |
| `availableUnits(...)` | 改：返回 `Map<level, {units, unitTokens}>`；材料排除保护区 |
| `distillOne(agent, signal, turn, tier, options)` | 加 `emergency`，传给 `selectRawRun` / `selectMergeRun` |
| `scheduleObservations(...)` | 串起来：target → inventory → materials → plan |
| 面板 `lastObservation` | 报 `target / need / inv₁`，否则「为什么还在蒸 T1」看不出来 |

---

## 12. 测试清单

全部打在 `test/smoke.mjs`（纯函数），`test/patch.mjs` 补一条链路。

| 用例 | 断言 |
|---|---|
| `target` 在 `C < G` 时为 0 | 没到目标线不备货 |
| `target` 在 `C ≥ T` 时为 `D + U·r` | 垫不被 `min` 吃掉 |
| 改 `triggerRatio` 后 target 跟着变 | 配置驱动 |
| 已提交块不计入库存 | 已进上下文 |
| 摘要 ≥ 覆盖量不计入库存 | 提交不掉 |
| 库存判据与提交判据认同一批块 | 同源 |
| `inv` 够时计划为空 | 不派发 |
| T1 材料充足只派 level 0 | 低层优先 |
| T1 不够时缺口漏到 level 1 | 递推 |
| level 0 无材料、level 1 有 → 仍派 level 1 | continue 不是 break |
| **T2 补满但 T1 未满 → 仍派 T1** | 逐层抵扣（一次性扣总账会返回空计划） |
| 越线且材料不足一段 → 仍切 | flushTail |
| 未越线且材料不足一段 → 不切 | 不浪费 |
| 3 个 r=0.6 的块 → 校准返回 0.6 | 实测校准 |
| 实测 r < 0.5 被下界接住 | 防极端 |
| 并发槽位截断 | 计划总数 ≤ concurrency |

**连带重写**：`planObservation` 现有 5 条用例、`reserveUnitsOf` 相关断言。

---

## 13. 实施顺序

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | `select.js` 里加 `planTarget` / `recoveryRatio` / 新 `planObservation`，全部纯函数 | `smoke` 新用例全绿 |
| 2 | `tower.js` 接线：`availableUnits` 换 token 口径、材料排除保护区、`reserveUnitsOf` 下架 | `smoke` + `patch` 全绿 |
| 3 | `flushTail` 紧急态 | 新增两条用例 |
| 4 | 面板文案（`target / need / inv₁`）与 README | `client` / `state` 测试 |

每步单独 commit，测试必须全绿才打包。

---

## 14. 明确不做

- **不做「每层都备满 N 份」**：低层优先意味着上层库存大部分时间不会被消耗。
- **不用块数当控制量**：跨层块大小差一个量级。
- **不用「总缺口」当闸门**：见 §5 第 1 条。
- **不并发观察**：`observerConcurrency` 已经够，并发要额外解决在途记账。
- **不改提交逻辑**：`planCommits` 的顺序、算术、护栏都不动。

---

## 附：与 Sisyph 方案的差异

| 项 | Sisyph | 这里 | 原因 |
|---|---|---|---|
| 库存判据 | `0 < tokens < covered` | 再加 `covers ⊆ 表层` | 宿主压缩会让原料离开表层 |
| 材料范围 | 近区之外 | 保护区之外（**本次改**） | 否则库存 ≠ 可提交 |
| 紧急态 | `min_len = 1` | `flushTail`（只放行尾巴） | 我们批量派发，段长降到 1 会一次切出几十块 |
| 并发 | 单飞（在途无穷） | 显式槽位 | 我们有 `observerConcurrency` |
