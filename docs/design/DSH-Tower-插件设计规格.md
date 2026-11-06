# DSH Tower · 插件设计规格

> 状态：v1 骨架已实现并通过离线测试（实现状态见 §15）
> 目标宿主：DeepSeek Harness 0.2.x（`@deepseek-ai/dsh-*`）
> 方案来源：Sisyph 的分层压缩 + DSH 的 compaction seam
> 事实等级：`[实测]` 有代码/运行证据 · `[推断]` 由契约推导 · `[未验证]` 必须验证后才能实现

---

## 0. 命名

| 位置 | 名字 | 理由 |
|---|---|---|
| 功能名 | **Tower** | 呼应 Sisyph 的 DistillTower 视图：分层蒸馏、越往上越抽象 |
| npm 包 | `dsh-compaction-tower` | DSH 的压缩后端是 `dsh-compaction-*` 系列（`-basic`、`-tool-result-pruner`），这个名字一眼看出是同类 |
| 事件类型 | `plugin:tower/block` | 宿主语法强制 `plugin:` 前缀 + 全小写 `/` 分段；用 `appendPluginRecord` 写入（自动带 `ignorable: true`） |
| 配置键前缀 | `tower.` | 例：`tower.triggerRatio` |
| 导出目录 | `<项目根>/.dsh/tower/` | |
| 工具名 | `decompress` / `search_context` | 不带品牌前缀：通用语义，避免模型把工具名当专有名词 |

**关于 ACP**：`ACP` = Active Context Pruning，是 `acp-kernel` 这个库的名字（billion-context 的压缩引擎就是它）。它属于上游血统，不是本项目的术语，本设计**不使用**。

> 事件类型是**永久写进日志**的字符串。改名在实现后代价极高（旧日志无法识别），所以在这里一次定死。`plugin:` 前缀还是宿主区分"插件私有记录"与"核心事件"的唯一机制，不能省。

---

## 1. 要做什么

给 DSH 装一个**自动分层压缩**能力：

1. 模型**不参与压缩决策**（没有 compress 工具，没有 nudge 提示）；
2. 会话空闲时，后台把较早的历史蒸馏成摘要块（dormant）；
3. 上下文逼近上限时，把已经蒸馏好的块**瞬间**换进表层（提交），不产生等待；
4. 模型保留两个工具：`decompress`（取回原文）和 `search_context`（搜索含已压缩内容）。

### 不做的事（防止范围蔓延）

| 不做 | 理由 |
|---|---|
| `acp_status` 工具 | 压缩自动进行，模型不需要知道状态；用户看 UI |
| `compress` 工具 | 与 Sisyph 同一判断：模型零压缩职责 |
| 自建账本 / 自建 fold | 宿主日志就是账本，`foldSurface` 现成 |
| 跨会话检索 | 宿主有 `dsh-experimental-session-search`（默认关） |
| 改 system prompt / 工具定义 | 压缩只管可压缩的表层，不动 envelope |

---

## 2. 术语（先把三个词锁死）

| 词 | 含义 | 谁看得见 |
|---|---|---|
| **seq** | 每条事件的流水号，连续、不复用、**包含非消息事件** | 只有代码 |
| **表层（surface）** | 由事件折叠出的、模型可见的有序节点序列 | 模型看到的是渲染后的文本 |
| **仅日志事件** | 写进日志但不进上下文的事件 | 模型看不见 |

**关键区分**：`seq` 是**事件**编号，不是消息编号。一段连续的消息，seq 是跳号的（中间夹着 `step/start`、`turn/end` 等）。

---

## 3. 总体架构

```
┌─ 观察者（后台，不阻塞） ─────────────────────────┐
│ 触发：agent/turn-stopping（返回 promise，宿主会等）│
│ 材料 A：早于最近 N 轮、未被覆盖、且不跨越 checkpoint│
│         的一段原文，够大才蒸 → 新 T1 块           │
│ 材料 B：相邻且**同层**的 ≥2 个 checkpoint        │
│         → 合并成上一层块（T2、T3…）              │
│ 动作：调一次 LLM 生成摘要 → appendPluginRecord    │
│ 产物：dormant 块（仅日志，模型看不见）            │
└──────────────────────────────────────────────────┘
                    ↓
┌─ 提交（请求前，纯查表，毫秒） ───────────────────┐
│ 补丁 compactIfNeeded：分层贪心（先 T1，T1 用尽  │
│   仍不达标才动 T2），一次可提交多块，达标即停     │
│ 补丁 summarize：返回预蒸馏文本，零 LLM 调用       │
│ 锁 / 四个事件 / 计价 / 表层替换：引擎自己的方法   │
│ 产物：表层替换（模型看到一条 user 角色摘要消息）  │
└──────────────────────────────────────────────────┘
                    ↓
┌─ 工具面（模型可用） ─────────────────────────────┐
│ decompress(blockId | range)  ·  search_context   │
│ advisor（可选，默认不暴露）                       │
└──────────────────────────────────────────────────┘
```

**为什么这样分**：蒸馏要等 LLM（几秒），提交是纯查表（毫秒）。把两者分开，提交就永远不会让用户感到等待。

**为什么复用引擎而不是自己实现**：`dsh-compaction-basic` 已经实现了锁、四事件顺序、shadow-price 记账、表面稳定性校验、溢出重试。自己重写这些只会复刻一遍它们的 bug 面。引擎把两个扩展点挂在 `this` 上动态派发（见 §11），补丁它们即可，不需要注册 `compaction` 服务、也不需要禁用宿主自带压缩。

### 3.1 提交策略：最少提交 + 分层优先

这是从 Sisyph 搬过来的核心策略（`sisyph/context.py:140` `commit_plan`，术语见 `research/COMPRESSION_V2.md:130`）：

1. 触发线检查通过后，把**所有**可提交的块一次算清（covers 全在当前表层的块）；
2. 按 `tier` 升序、同层按覆盖位置从老到新排序；
3. 逐块累加 `content += summaryTokens - coveredTokens`，**到目标线即停**；
4. 材料全提交完仍不到目标 → 就停在"尽力而为"的位置（不额外制造更深的块）。

含义：**T1 全部提交了还不行，才动 T2；T2 用完才动 T3。** 每个 T1 只损失一层保真度（原文 → 摘要），T3 损失三层。同样能把上下文压到目标，优先牺牲损失最小的块。

> 与「深优先」相对：Sisyph 还有第二个视角 `assemble_advisor`（`sisyph/context.py:220`，把同一本账按"能提交的尽量提交"渲染成一份更短的历史给评审模型），那是**另一条投影**，不参与提交决策。DSH 只有一条 `surface → deriveMessages` 渲染路径，所以这里只落成"提交策略"，顾问改走独立旁路请求（见 §7.3）。

### 3.2 塔必须由同层合并构成

**链式结构在这里行不通**。若提交时把"上一个块的摘要"和"新内容"混着压，`tier` 就会随提交次数线性增长：每压一次深一层，最后全是 T7、T8，每一层都叠一次摘要损失。

根本原因在宿主的约束上：`compactRegion(start, end)` 要求**区间仍在表层**。T1 块一旦提交，它覆盖的那些 seq 就离开了表层，任何以它们为 covers 的"父块"就再也提交不了。

所以塔只能这样长：

```
两个 T1 checkpoint  →  合并成 T2（covers = 两个 checkpoint 节点的 seq）
两个 T2 checkpoint  →  合并成 T3
...
```

深度因此是 log₂(提交次数)，而不是线性的。落成两条实现约束：

- `selectMergeRun` 只挑**相邻且同层**的 checkpoint，混合层不合并；
- `tier = max(子块 tier) + 1`，与合并规则自洽，摘要头里的"含 N 个 T{k-1} 块"才是真话。

---

## 4. 事件类型

### 4.1 `plugin:tower/block`（仅日志，dormant）

**写入方式（验证后已定死）**：

```ts
appendPluginRecord(sess, 'plugin:tower/block', data)
```

三条硬约束，全部来自宿主代码：

1. **类型名语法**：`/^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u`（`dsh-session/lib/index.js:1246`）。`plugin:tower/block` ✅、`plugin:tower.block` ✅、`plugin:tower/block/v2` ✅、`tower/block` ❌、`plugin:Tower/block` ❌（大写被拒）。
2. **必须走 `appendPluginRecord`**：它在内部把事件标成 `ignorable: true`。普通 `sess.append('plugin:tower/block', …)` 虽然不会当场报错，但**不带 `ignorable`**，卸载插件后会话会在加载期被整份拒绝（见 §12 第 2 条原文）。
3. **`declare module` 只是类型糖**：合并进 `SessionEventMap` 影响 TS 编译，不影响运行时是否接受——运行时只看 `KNOWN_SESSION_EVENT_TYPES` + `ignorable`。

记录体（`data`，无损 JSON）：

```ts
// 仅为类型提示；运行时靠 appendPluginRecord 的 ignorable 标记
interface TowerBlockRecord {
  /** 块号，如 "b00007"；会话内自增，从 b00001 起 */
  blockId: string;
  /** 层级：1 = 蒸馏原文；2+ = 蒸馏同层的下层块 */
  tier: 1 | 2 | 3;
  /** 精确的成员事件 seq，按表层顺序；**不是区间** */
  covers: number[];
  /** 摘要正文 */
  summary: { type: 'text'; text: string }[];
  /** 覆盖内容的 token 估计，提交时用于记账 */
  coveredTokens: number;
  /** 摘要自身的 token，提交计划用它算「压完还剩多少」 */
  summaryTokens: number;
  /** 成员里已经是 checkpoint 的那些块；提交后从摘要头反查补齐 */
  childBlockIds: string[];
  /** 产物形态：run = 一段原文；distill = 同层块集合 */
  kind: 'run' | 'distill';
  /** 生成该摘要的模型与用量 */
  origin: { provider: string; model: string; usage?: { input: number; output: number } };
  /** ISO 时间 */
  createdAt: string;
}
```

**约束**：`data` 必须无损 JSON 序列化——**不能有 `undefined`、`BigInt`、`Date`、`Map`、类实例**。可选字段一律用 `null` 占位或整体省略。

**读取**：`pluginRecordOf(event)`——签名收**事件对象**（不是 `(session, seq)`），返回 `{ type, seq, time, data }`；非 `ignorable` 或非 `plugin:` 前缀返回 `undefined`。

### 4.2 提交产物（引擎写，我们不手写）

一次提交 = 四个事件，顺序固定 `[实测：dsh-compaction README.zh.md:95]`：

```
compaction/start      （仅日志，取锁）
compaction/summary    （仅日志，记录摘要与遮蔽价格）
user/message          （唯一的表层变更：surfaceOp = {op:'replace', startSeq, endSeq}）
compaction/end        （仅日志，放锁）
```

**验证后的决定**：这四条事件全部由引擎的 `compactRegion` 写出，本插件**不手工 append**。原因：

- `compaction/summary` 必须带 `shadowedSeqs`（全量集合）与 `shadowedTokenCount`（遮蔽价格），且必须与替换事件**同步相邻**追加；token 计的 `foldSurfaceProjection` 对"有 claim 但区间不匹配"是**抛错**，对"无 claim 的替换"是**静默零增量**（计量从此失真）。
- `shadowedTokenCount` 必须用宿主同一个 `estimateMessage`（`@deepseek-ai/dsh-token-meter/estimate`）算，否则"by construction exact"的前提被破坏。
- 官方实现已经把这些做对了，包括失败路径补 `compaction/end`、稳定性校验、溢出重试。

**代价**：摘要文本存两份（`plugin:tower/block` + `compaction/summary`）。可以接受：摘要是 1–2K token 级，日志成本远小于收益；而且两份的用途不同（前者带块号/层级/覆盖集，是账本；后者是宿主契约要求的快照）。

---

## 5. 编号规则

| 编号 | 含义 | 生成方式 | 稳定性 |
|---|---|---|---|
| `mNNNNN` | 一条消息 | 即事件的 `seq`，5 位补零 | 永不改变（事件写入即固定） |
| `bNNNNN` | 一个块 | 会话内自增 | 永不改变 |

**跳号是常态**，模块不需要修正。`m00012…m00030` 只是给人看的首尾，不是"12 到 30 每条都在"。

### 模型可见的编号位置

| 位置 | 带编号 | 原因 |
|---|---|---|
| 普通消息正文 | **不带** | 模型从不点名可见消息，加了是纯开销 |
| 摘要消息头部 | 带 `bNNNNN` | 否则模型无法展开 |
| `search_context` 命中行 | 带 `mNNNNN` | 否则模型无法描述找到的是哪条 |
| `decompress` 输出 | 带 `mNNNNN` | 否则模型无法二次引用 |

> 这一条与 bili 不同：bili 给每条消息挂 `<acp tokens="…" type="…">m00042</acp>`，因为它让模型自己调 `compress(range=[…])`。本方案模型不压缩，所以不需要。

---

## 6. 摘要头模板

摘要消息的内容 = 头部一行 + 摘要正文。

```
T1（成员全是原文消息，seq 单调递增）：
[b00007 · T1 · 12 条 · m00012…m00030 · 原 8.4K tok]
<摘要正文>

T2+（成员含下层摘要节点，seq 会乱序）：
[b00011 · T2 · 3 条（含 2 个 T1 块）· 原 9.5K tok]
<摘要正文>
```

**为什么 T2 不给区间**：替换产生的摘要节点 seq 比它左边的东西都大，位置顺序与数字顺序脱钩。给区间会让模型误以为区间内全是本块成员。

> Sisyph 对同一问题给出的答案是一致的：T1 的 `covers` 是 m 区间，T2+ 的 `covers` 是**块 id 区间列表**。

`原 X.XK tok` 是成本提示：模型据此决定要不要展开。

---

## 7. 工具规格

### 7.1 `decompress`

```json
{
  "blockId": "b00007",
  "range": ["m00012", "m00030"],
  "inline": false
}
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `blockId` | 二选一 | 精确展开一个块 |
| `range` | 二选一 | 取回日志中 seq 落在两端之间的**全部消息**（数值过滤，与块归属无关） |
| `inline` | 否 | 强制内联；仍受 `hardMaxTokens` 截断 |

**语义分层（必须写进工具描述，否则模型会混用）**：

- `blockId` = "展开这一块"，**精确**，成员就是 `covers` 里那几个；
- `range` = "捞这一段历史"，**按 seq 数值过滤**，可能跨多个块，也可能含未压缩的消息。

**展开深度**：默认**恰好一层**。
- T1 → 原文；
- T2+ → 下一层块的摘要（不是原文）。
- 要原文就继续展开下层块。这是防上下文爆炸的保险。

**边界行为**：

| 情况 | 行为 |
|---|---|
| 区间内全是还在上下文里的消息 | 返回 `这些消息仍在上下文中，无需展开`（≈0 成本） |
| 块不存在 / 未提交（dormant） | 返回错误 `块 b00009 尚不存在` |
| 已提交但被更高层吞掉 | **可以展开**（记录永远在日志里） |

**返回（内联）**：

```
[b00007 · T1 · 12 条 · 原 8.4K tok]
m00012  [user] 把配置改一下
m00015  [bash] File not found: /etc/app.conf
m00017  [assistant] 路径写错了……
```

**返回（落盘）**：

```
[b00007 · T1 · 12 条 · 原 8.4K tok · 已导出]
<tower-file path=".dsh/tower/a3f9c1b2/b00007.md" lines="312" />
前 20 行预览：
m00012  [user] 把配置改一下
…（用文件读工具翻页；未读部分不占上下文）
```

### 7.2 `search_context`

```json
{ "query": "TTL", "limit": 10 }
```

- 扫**全部日志事件**，含已被遮蔽的原文；
- 打分：整串命中加权 + 分词命中数（照 Sisyph `readback.core_search`）；
- `limit` 默认 10、上限 30；
- 命中必须**带覆盖链**，否则模型不知道展开哪个块。

**返回**：

```
3 条命中：
m00015  [bash]      TTL=-1                        ← 被 b00002 覆盖（已并入 b00011）
m00087  [assistant] redis 缓存要设 TTL…           ← 仍在上下文
m00120  [bash]      TTL=3600                      ← 被 b00009 覆盖
```

### 7.3 `advisor`（可选）与 `/advisor`

**来源**：Sisyph 的评审顾问（`sisyph/prompt.py` 的 `ADVISOR_SYSTEM` / `ADVISOR_PROMPT` / `ADVISOR_SECTION`）。它的价值在于"独立性"：执行者看自己的摘要，评审者看**同一份上下文**，但只负责挑毛病、给方向，不负责改代码。

**入口有两个，共用同一条实现**：

| 入口 | 谁触发 | 何时可用 |
|---|---|---|
| `/advisor` 命令 | 用户 | 只要 profile 装了 `dsh-commands` |
| `advisor` 工具 | 模型 | 仅当 `advisorExpose: true` |

**调用形状**：不是在会话里加一条消息，而是**独立旁路请求**——

```
messages = [ {role:'system', text: ADVISOR_SYSTEM} ] + 当前 deriveMessages() 中去掉原 system 的全部消息 + {role:'user', text: ADVISOR_PROMPT}
llm.stream({ provider, model, messages, maxTokens: advisorMaxTokens, purpose: 'advisor' })
```

三点必须守住：

1. **不污染执行者上下文**：问答只写一条 `plugin:tower/advice` 仅日志记录，不进表层；
2. **不占压缩预算**：顾问请求的 token 不进 `tokenMeter`，也不参与提交决策；
3. **provider/model 可单独指定**：默认跟随会话路由；想用更强的模型就把 `advisorProvider/advisorModel` 填上。

**结果处理**：把模型输出原样返回给调用方（`/advisor` 显示在会话里，工具则作为 tool result）。提示词要求它第一行给信号（计划/纠正/叫停），后续是中文说明。

**为什么不做成第二条投影**：Sisyph 的"深优先"渲染是同一本账的另一种折叠，DSH 的 `deriveMessages` 只有一条路径（`registerMessageProjection` 是每会话一条，不是每请求一条），做不成两套渲染，于是退化成独立请求。

### 7.4 Web 界面（`conversation.view` 槽位）

**为什么不做成"第二条投影"却仍然需要一个界面**：压缩对模型是透明的，对用户不应该透明——用户得能看见"哪段历史被折成了什么、塔长到几层、花了多少 token"。

**形态**：会话区的一个视图 tab（与官方 `对话` / `轨迹` 并列），id `tower`，order 40。

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 上下文占用 | 当前 / 窗口 + 触发线 + 目标线 | `tokenMeter.measure()` + `triggerRatio/targetRatio × contextWindow` |
| 块表 | 块号、层、覆盖条数、原 → 摘要 token、状态；点行展开摘要 | `plugin:tower/block` 记录 |
| 塔结构 | 按 `childBlockIds` 递归的缩进树 | 同上 |
| 顾问意见 | 倒序的 `plugin:tower/advice` | 同上 |
| 操作 | 立即蒸馏 / 立即提交 / 合并选中 | `POST /tower/action` |

**客户端半侧**（`lib/client.js`）是**手写的已构建产物**：`window.__ModuleLoader__.load({id, factory})`，`factory` 里 `require('react')`，`exports = {apply, inject: ['slots']}`。不引入任何构建链——宿主的 `buildComboScript` 只是逐字节拼接，不做转译。

**会话号从哪来**：`conversation.view` 的 owner props 只有 `inspectCall / viewRequest / openView / completeViewRequest`，**没有 sessionId**。要用注册项自带的 `inject: (sessionId) => ({ sessionId })`（官方 `trajectory` 视图同款）。

**为什么开 HTTP 路由而不是客户端直读会话事件**：客户端的 `ctx.sessions` 门面是**消息级快照**，拿不到 `plugin:tower/*` 这类仅日志事件；而且"立即蒸馏/提交/合并"必须在宿主侧执行。所以由 host 半侧开两条同源路由（`lib/server.js`）：

| 路由 | 请求 | 响应 |
|---|---|---|
| `GET /tower/state?sessionId=` | sessionId 可省（取最近打开的会话） | 整份状态快照 + `sessions` 列表 |
| `POST /tower/action` | `{kind:'distill'\|'commit'\|'merge', sessionId, blockIds?}` | `{ok, message?, blockId?, queued?}` |

**两条硬约束**（都是实测出来的）：

1. **路由要自己鉴权**：宿主自带的 named route 不套登录，只有它自己的 `/api` 走 `ctx.connection`。所以每条路由先调 `connection.authorizeIndex(req, res)`，未登录直接 401。注意 `ctx.get('connection')` 必须在**首次请求时**取——路由比连接服务先装载。
2. **手动提交不能立刻做**：`compactRegion` 要求事件落在一个打开的回合里（`no open turn`）。所以按钮只置标记 `commitRequests`，等下一个回合开始、`compactIfNeeded` 被调用时按目标 0 全提交。合并不受此限（只写块记录，不产生 compaction 事件），蒸馏同理。

---

## 8. 文件导出

### 路径

```
<项目根>/.dsh/tower/
    ├── .gitignore          ← 内容就一个字符：*
    └── a3f9c1b2/           ← 会话码（sessionId 前 8 位小写 hex）
        ├── b00007.md
        └── b00011.md
```

- **项目根** = 从 cwd 往上找第一个含 `.git` 的目录；找不到就用 cwd 本身 `[实测：dsh-skill-filesystem 的 findProjectRoot]`；
- `.dsh` 是 DSH 自己的项目级约定（`<项目根>/.dsh/skills` 已被宿主使用），不是新发明的名字；
- 会话码用 sessionId 前 8 位，保证不同会话同名块号不冲突；
- 文件名用块号 → 同一块重复导出天然幂等（覆盖无害）。

### 不污染 git

`tower/.gitignore` 内容写 `*`，一次性忽略该目录下的全部内容（含所有会话子目录，也含这个 `.gitignore` 自身）。不需要改用户的根 `.gitignore`，`git status` 里也不会出现任何痕迹。

### 清理

保留最近 20 个会话目录（按 mtime），超了删最旧。会话目录删掉不影响任何数据——文件只是视图，随时可从日志重建。

---

## 9. 配置项

所有阈值用**比例**，随模型上下文窗口自适应。

| 配置 | 默认 | 说明 |
|---|---|---|
| `triggerRatio` | 0.45 | 上下文占用过此线才提交 |
| `targetRatio` | 0.15 | 提交到此处停止（尽力而为，材料不够就停在能到的地方） |
| `distillMinRunRatio` | 0.05 | 观察者认为"值得蒸馏"的最小 run 占比 |
| `retainRecentGroups` | 10 | 最近 N 个用户轮次永不压缩 |
| `observerMaxTokens` | 16000 | 单个块原文的**上限**（预防"特别特别大"），也是单次合并的上限 |
| `observerTimeoutMs` | 120000 | 单次蒸馏的超时 |
| `inlineMaxRatio` | 0.02 | 解压内联的阈值（占预算比例） |
| `hardMaxTokens` | 40000 | 单次解压的绝对上限（绝对兜底） |
| `exportKeepSessions` | 20 | 保留最近 N 个导出会话目录 |
| `mergeMinBlocks` | 2 | 相邻同层 checkpoint 够几个才值得合并成上一层块 |
| `advisorExpose` | false | 是否把 `advisor` 工具暴露给模型；关闭时只能用户手动 `/advisor` |
| `advisorProvider` | `''` | 顾问用的 provider，空 = 跟随当前会话路由 |
| `advisorModel` | `''` | 顾问用的 model，空 = 跟随当前会话 |
| `advisorMaxTokens` | 8000 | 顾问单次回答的 token 上限 |

> `budget = contextWindow − est(systemPrompt + tools)`。`contextWindow` 从宿主模型配置读取。
>
> **口径警告**：必须用宿主的 `tokenMeter`，不要复刻 Sisyph 的 `CJK 字数 + ceil(其他/4)`。两者算出的数不同，阈值必须用宿主口径重新标定。

### 9.1 配置的落点与优先级

配置有三个来源，后者覆盖前者：

1. 内置 `DEFAULTS`（`lib/config.js`）
2. profile 里 `compaction-tower` 条目的 `config:` —— 即 `dsh.bundle.patch.yml` 插入那一行的配置
3. 用户在插件页表单里改的**稀疏覆盖** → `<DSH_HOME>/storages/compaction-tower/config.json`

覆盖层只存改过的键，`reset` 即删除该键（回到 profile 值）。写入走 `.tmp` + `rename`，坏文件不抛错、只在表单上提示。

**为什么不用宿主的 `settings` 服务**：`settings.describe()` 返回的命名空间来自 **profile 文档**，而 `compaction-tower` 这一行是 bundle patch 跑的时候插进去的（`dsh-app-boot` 的 `applyEntryPatches`），不在文档里 ⇒ `describe()` 里没有它，`plugins.bundle.config` 的表单也无处绑定。

### 9.2 表单字段元数据

`lib/config.js` 的 `FIELDS` 是唯一事实来源：`key / group / label / type(ratio|int|bool|text) / min / max / step / unit / hint`。`GET /tower/config` 把这份元数据连同当前值一起发给前端，前端不复制任何默认值、也不自己写校验规则；`POST` 失败时的中文错误由同一份 `resolveConfig` 产出。

---

## 10. 状态机与不变量

### 块状态

```
dormant（plugin:tower/block 已写，不在表层）
   → committed（发生了表层替换，摘要进入上下文）
   → consumed（被更高层块覆盖，不在表层，但记录仍在）
```

状态**单调**，不可逆。

### 不变量

1. **覆盖互斥**：任意两个 committed 块的成员集合不相交。由表层本身保证（一个节点只在一个位置）。
2. **提交即精确**：`covers` 是全量 seq 集合，不是区间。
3. **提交路径上零 LLM**：补丁后的 `compactIfNeeded` 选段必然命中一个已蒸馏块；`summarize` 只做查表。未命中属于实现 bug（若真发生，回落为现场蒸馏 + 记 warning，宁可慢也不出错）。
4. **标记对不跨回合**：`compaction/start` 到 `compaction/end` 由引擎在同一同步段内闭合，天然满足。
5. **正文不加标签**：普通消息内容零改动。
6. **日志是唯一真相**：块的全部状态可从 `plugin:tower/block` + `compaction/*` 事件重建，不依赖内存。
7. **不改宿主消息**：所有表层变更只经由 `surfaceOp: replace`，绝不修改请求对象（它被深冻结）。

---

## 11. 宿主适配点

| 位置 | 用途 | 证据 |
|---|---|---|
| 补丁 `BasicCompactionEngine.prototype.compactIfNeeded` | 我们的触发阈值与选段；内部调 `this.compactRegion(start, end, agent, signal)` 交回引擎做机制 | `dsh-compaction-basic/lib/index.js:831` 注释明写 `compactIfNeeded` 是动态派发，"so subclass overrides are honored at event time" |
| 补丁 `BasicCompactionEngine.prototype.summarize` | 返回预蒸馏摘要（零 LLM）；签名 `(input, agent, signal) => { summary: ContentBlock[] }` | `:893` "Override this sole hook for a template or remote summarizer"；`regionDependencies()` 里 `summarize: (input, owner, abort) => this.summarize(…)`，每次调用都重新读 `this.summarize` |
| `agent/turn-stopping` | 触发观察者（**必须 fire-and-forget**，serial 模式里 await 会阻塞状态机进 idle） | |
| `ctx.tokenMeter.measure(session)` | 逐节点 token，用于触发判断与 `coveredTokens` | |
| `ctx.tools.register` | 两个工具，`output` 必须是 `{schema, render}` 无损 JSON 契约 | `dsh-tools/lib/types/index.d.ts:637` |
| `toolPairingBalancedBefore / After` | 选段不切断工具调用与结果配对 | |
| `appendPluginRecord` / `pluginRecordOf` | 写 / 读块记录 | `dsh-session/lib/index.js` |
| `ctx.llm.stream()` | 观察者蒸馏；`ctx.llm.resolveModelInfo()` 取上下文窗口 | |

### 为什么用原型补丁而不是"换引擎"

- **不能换**：`compaction-basic` 挂在 preset 的 `compaction` 隔离组里（`preset-standard.patch.yml` 的 `- id: compaction / name: cordis:group / isolate: {compaction: true}`），而 preset 的 `config.plugins` 是**对象**不是数组，patch 的 `buildMap` 只递归 `entry.group && Array.isArray(entry.config)` 的节点 → `compaction-basic` 这个 id **在 profile patch 里找不到**（`applyEntryPatches` 会 warn 后跳过）。要换引擎只能整块重写 preset 的 `config`，上游一变就崩。
- **不必换**：两个扩展点都挂在 `this` 上动态派发，原型补丁天然覆盖所有 preset 的隔离实例。
- **代价**：补丁依赖方法名，宿主大版本升级要复查。`apply()` 里先断言 `typeof proto.summarize === 'function' && typeof proto.compactIfNeeded === 'function'`，缺失则记 error 并降级为"不压缩"（绝不让宿主崩）。

### 不需要禁用宿主自带压缩

`dsh-compaction-basic` 继续挂着、继续拥有锁、四事件、计价、溢出恢复；我们只替换它的两个入口。`command-compact`（`/compact` 命令）和 `tool-result-pruner` 因此也继续正常工作。

---

## 12. 验证结果（2026-11-05 实测）

方法：直接 `import` 宿主的 `dsh-session` 库驱动一个 detached `Session`（探针 `_probe_a.mjs`），加静态读码。标注 `[实测]` = 有运行或代码证据。

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | `agent/turn-stopping` 里 fire-and-forget 是否可行 | `[实测]` **不可行，必须 await** | 该事件是 serial 且被 `await`，但回合结束立刻关闭会话：后台任务跑完时 `sessions.flush()` 报 `session "…" is not live in this store`，块记录只留在内存里。改为在监听器里 `return observe(...)` 后，`flush 完成（plugin）` 并落盘 |
| 2 | 未知事件类型在**插件卸载后**加载是否报错 | `[实测]` **会整份拒绝** | `dsh-session-persistence/lib/index.js:184`：`if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(... "refusing to interpret the log" …, location)`。⇒ 必须 `appendPluginRecord` |
| 3 | 工作区外文件能否被模型读 | `[实测]` 当前策略下可读 | 本会话 `read` 工具直读 `%USERPROFILE%\.dsh\profiles\desktop\cordis.yml` 成功。但导出目录在 `<项目根>/.dsh/tower/`，是 cwd 的祖先，正常沙箱也在允许范围内 |
| 4 | 同一回合内连续 `compactRegion` 是否允许 | `[实测·代码]` 允许 | 锁是 `compaction/start` 未配对即拒（`assertCompactionInactive`），每对同步闭合即可连续多次 |
| 5 | 替换后 `user/message` 的实际渲染 | `[实测]` 正确 | 探针：`surfaceOp={op:'replace',startSeq:0,endSeq:1}` → 节点变 `[5,2]`，`deriveMessages()` = `[摘要, "CCC"]`，顺序正确 |
| 6 | tokenMeter 对替换的记账 | `[实测·代码]` 必须带 shadow claim | `foldSurfaceProjection`：有 claim 且区间匹配 → `delta = new − claim.tokens`；**无 claim → `deltaTokens: 0` 静默漂移**；claim 区间不匹配 → 抛 `token surface: replace at seq … has no adjacent shadow price`。⇒ 走引擎即免疫 |
| 7 | 引擎注册冲突 | `[实测·代码]` 不冲突（因为我们不注册） | `BasicCompactionEngine extends Service("compaction")`；`compaction-basic` 已占该槽。我们不 provide 服务，只补丁原型方法 |
| 8 | 替换消息能否是 `system` 角色 | `[实测·代码]` **不能** | `contextBreakdown` 投影：`replace … puts a system message in place of a metered range` 直接抛错 ⇒ 摘要必须是 `user/message`（与 `frameSummary` 一致） |
| 9 | 提交时摘要比原文大怎么办 | `[实测·代码]` 引擎拒 | `summarizeCompaction`：`if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) throw` "summary is not smaller than the shadowed content"。⇒ "提交只缩小"由宿主强制，不是我们的约定 |
| 10 | 插件记录类型命名 | `[实测]` 三个正例三个反例 | ✅ `plugin:tower/block` / `plugin:tower.block` / `plugin:tower/block/v2`；❌ `tower/block`、`plugin:Tower/block`、任意大写 |

**已烟消的旧风险**：原设计里"自己 append 四个 compaction 事件 + 自算 `shadowedTokenCount`"这一整块工作（#6）因为改为复用引擎而消失。

### 12.1 真机联调（沙盒 DSH 0.2.1-rc.2，headless profile `t1`）

> 本节证据来自 **v1**（滚动摘要）。其中"提交链路、工具实测、三 bug"仍然有效；"级联"那一条描述的是 v1 的滚动 tier，已被 §12.2 的分层塔取代。

环境：`dsh-sandbox`（独立 npm 安装）+ `dsh-sandbox-home`（独立 DSH_HOME）；模型路由借桌面 profile 的 `magpie`；测试配置 `triggerRatio 0.005 / targetRatio 0.003 / distillMinRunRatio 0.00001 / retainRecentGroups 0`。

跑通的链路（同一会话连续 12 个回合）：

1. **插件激活**：`request/header` 里 27 个工具含 `decompress`、`search_context` ⇒ host 平面注册的工具确实进模型请求。
2. **观察者触发**：`turn-stopping fired, keys=turn,signal,agent, hasAgent=true` → `写入块 b00001（T1, 4 条, 1799 tok）` → 日志里 `seq 18 plugin:tower/block`。
3. **提交链路**：`compactIfNeeded 被调用：trigger=pressure` → `压力判定：total=9003 触发线=5243` → `run=[8,9,10,15,…] chain=1` → `serveSummary 返回 2 个内容块` → 日志出现 `compaction/start`(seq 88) → `compaction/summary`(seq 89, `shadowed=1799`) → **表层替换 1 次** → `compaction/end`(seq 91, `error=none`)。
4. **工具实测**（模型自己发起调用）：
   - `decompress blockId=b00003` → `[b00003 · T3 · 7 条（含 1 个 T2 块）· 原 2.6K tok]` + 下层块摘要；
   - `decompress range=["m00008","m00015"]` → `区间 m00008…m00015（4 条消息）` + 逐条原文（带 role）；
   - `search_context "收到"` → `8 条命中`，命中行带覆盖链：`← 仍在上下文` / `← 被 b00003 覆盖`。
5. **级联**：T1→T2→T3→T4→T5 自动长出来，`childBlockIds` 链正确（`b00002:[b00001]`、`b00003:[b00002]`…）。

联调中修掉的三个真 bug（离线测试测不出来的）：

| 症状 | 根因 | 修法 |
|---|---|---|
| 块记录写进内存但日志里没有 | 回合结束立刻关会话，`sessions.flush` 报 not live | `turn-stopping` 监听器改为返回 promise（宿主会等），并在写块后显式 `flush` |
| `compaction/end` 报 `session event "compaction/summary" carries non-JSON-serializable data` | 引擎无条件写入 `provider`/`model` 两个键；自定义 `summarize` 只返回 `{summary}` ⇒ `provider: undefined` 不是合法 JSON | `serveSummary` 补 `provider: agent.options.provider`、`model: agent.options.model` |
| 永远 `no-block`，从不提交 | `selectHeadRun` 的裁剪方向反了：`remaining > target` 时反而缩小 run，一路缩到只剩 1 个节点 | 改成「从头部最少地取，直到剩余量 ≤ target」 |

两个设计层面的确认：

- **必须 `await` 观察者**：宿主的持久化检查点只在请求前后，回合结束即关会话。代价是触发蒸馏的那个回合晚几秒收尾；因为触发条件（`distillMinRunRatio`）稀少，可接受。
- **v1 的 tier 是滚动摘要**（已废弃）：提交后表层留下一条 checkpoint，下一轮蒸馏「checkpoint + 新原文」得到 tier+1。这会把深度变成"每压一次深一层"，与 Sisyph 的分层优先相悖，v2 已改为同层合并（见 §3.2）。

### 12.2 分层提交的真机验证（v2）

同一会话 12 个回合（`session-cd7681b1`，配置同 §12.1，另加 `advisorExpose: true`）：

```
b00001 T1 covers=[8,9,10,15]              run      1818 tok
b00002 T1 covers=[29,30,31,33]            run      1784 tok
b00003 T2 covers=[26,43]                  distill   599 tok   ← 两个 T1 checkpoint 合并
b00004 T1 covers=[46,47,48,50,63,65]      run      1819 tok
b00005 T1 covers=[78,79,80,82]            run      1784 tok
b00006 T2 covers=[75,92]                  distill   600 tok   ← 再两个 T1 合并
b00007 T3 covers=[60,109]                 distill   797 tok   ← 两个 T2 合并
b00008 T1 covers=[95,96,97,99,112,114,127,129] run  1856 tok
```

三条证据：

1. **T2/T3 的 covers 是两个 checkpoint 节点的 seq**，不是原文 seq ⇒ 塔是按层长的，不是滚动链；
2. 合并日志只出现同层配对：`合并 2 个相邻 checkpoint（seq 60,109）` → `写入块 b00007（T3, …）`；
3. 一旦最老的那个 checkpoint 是 T3、后面跟着一串 T1，`selectMergeRun` 会跳过够不成的老组，去合并后面那两个 T1（这条有单测：`跳过够不成的老组`）。

顾问链路同批次验证：模型主动调用 `advisor` 工具 → 日志出现 `plugin:tower/advice`（含完整正文）→ 执行者上下文里没有多出任何消息。

### 12.3 Web 界面的真机验证（v2，profile `w1`）

验证手段：`tools/check-ui-live.mjs` 用 CDP 驱动无头 Edge，真的在页面输入框里打字回车，再点开 `Tower` tab 读 `.tw-root` 文本并截图。**静态读代码不算验证，这是唯一能证明客户端 bundle 真的跑起来的方式。**

四条证据：

1. **bundle 被宿主发现并发出**：首页 combo 脚本的 URL 列表里出现 `dsh-compaction-tower/client.js`；抓下来能在 1.93 MB 的组合产物里定位到我们那一段（`id: 'dsh-compaction-tower'`）。
2. **`apply()` 真的执行了**：`.tw-root` 不存在时，`#dsh-compaction-tower-style` 已经在 `<head>` 里——样式注入是 `apply()` 的第一件事。
3. **槽位注册成功**：会话 tab 栏出现 `对话 | 轨迹 | Tower`；点开后面板拿到宿主快照并渲染（4 个块、状态计数、缩进塔结构），页面零 console 错误。
4. **手动操作的语义边界**：`立即提交` 回 `已排队：下一个回合开始时提交`；再发一轮后该块从「待提交」变成「已进入上下文」，当前占用 14.4K → 14.1K。`立即蒸馏` 与 `合并选中` 追踪到直接生效（它们不产生 compaction 事件，不受"必须回合内"的限制）。

一个必须记住的坑：`conversation.view` 的 owner props **没有 sessionId**，要从注册项的 `inject: (sessionId) => ({sessionId})` 拿（官方 trajectory 视图同款）。另一个坑：空的浏览器 profile 看不到这个 tab——`scope: 'session'` 的槽位只在有会话打开时渲染。

**布局与宽度**（`tools/probe-layout.mjs`，16 个块的会话，1440 / 1024 / 800 三档实测）：

| 视口 | 页面横向溢出 | 面板宽 | 表格宽 | 列宽（勾选/块号/层/覆盖/原→摘要/状态） |
|---|---|---|---|---|
| 1440 | 无（docScrollWidth 1440） | 1153 | 1094 | 36 / 186 / 138 / 156 / 275 / 303 |
| 1024 | 无（1024） | 737 | 678 | 36 / 113 / 84 / 95 / 167 / 184 |
| 800（侧栏收成图标） | 无（800） | 737 | 678 | 同上 |

结论：三档都没有横向溢出、没有单元格挤压；块列表与塔结构各自限高（`38vh` / `30vh`）内部滚动，16 个块时面板总高 1129px，不会随块数无限增长。

**`/advisor` 斜杠命令**（同一探针 `TOWER_SLASH=1`）：输入框里打 `/advisor` 回车，命令真的执行——`顾问意见（0）` → `顾问意见（1）`，面板出现 `group/deepseek-flash 2026-11-05T04:52:08.295Z 叫停 …` 的完整正文，页面零 console 错误。这同时反证了旁路请求的形状正确：顾问看到的是执行者的 system + 消息；该会话只有一轮「收到」，所以它按提示词判了「叫停」并说明「没有可评审的内容」——不是空输入，也不是拿错上下文。

### 12.4 配置表单的真机验证（v2，profile `w1`）

验证手段：`tools/probe-config-ui.mjs`（CDP 驱动无头 Edge）进插件页 → 点开本插件卡片 → 读表单 → 改 `触发线` → 保存 → 复查 → 恢复默认 → 截图。

五条证据：

1. **槽位渲染**：表单 14 项按 5 组出现在插件详情页，`已自定义` / `未保存` 徽章与百分比换算（`（= 0.001%）`）正确。
2. **保存落盘**：覆盖层 `dsh-sandbox-home\storages\compaction-tower\config.json` 写成 `{"triggerRatio":0.01}`，面板提示「已保存，立即生效」。
3. **即时生效**：同一进程下一请求 `GET /tower/state` 的 `budget.triggerRatio` 已是 `0.01` ⇒ `ConfigStore.onChange → tower.updateConfig` 链路通。
4. **持久化**：杀掉进程重启后表单与运行时仍是 `0.01`。
5. **恢复默认**：点该项的「恢复默认」→ 覆盖层变 `{}`，面板提示「已恢复 profile 里的值」。

两个必须记住的坑：①插件页的「已安装插件」段只列 profile `package.json` 的 `dependencies` 里声明过的包——沙盒 profile 原本 `dependencies: {}`，加进去才出现；②卡片标题是 `button`（class 含 `cardTitle cardOpen`），点外层 `div` 没反应。此外标题文案来自 `locale/zh.json` 的 `meta.title`，所以按包名做文本匹配的探针会失配（表单字段额外加了 `data-field` 便于精确定位）。

第三个坑（0.2.2 起暴露）：插件页比一屏长，卡片在视口外时 `getBoundingClientRect().top` 落在 `已安装插件` 标题下方但不可点，探针必须先 `scrollIntoView` 再匹配——否则报 `点开本插件卡片: {"ok":false,"count":0}` 这种假阴性。

### 12.5 跨版本兼容性（DSH 0.2.0 / 0.2.1 / 0.2.2）

**结论：插件最低要求 DSH 0.2.1；0.2.0 上不能启用。**

依据是三条可验证事实，不是版本号比对：

1. `appendPluginRecord` / `pluginRecordOf` 在 `dsh-session@0.2.0-rc.2` 的导出表里不存在（0.2.1 才加入）；0.2.0 的 `append(type, data, ...opts)` 只读 `surfaceOp` / `sourceEventSeqs`，**永不写 `ignorable`**。
2. 0.2.0 与 0.2.1 的会话持久化用的是同一条加载期拒绝规则：`if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(...)`（`dsh-session-persistence/lib/index.js:184`）。所以 0.2.0 上硬写 `plugin:tower/block` 会让会话日志**再也打不开**——插件页那句「可能导致崩溃或数据丢失」是真警告。
3. 扩展点在三版之间稳定：`dsh-compaction-basic` 的 `summarize`（0.2.2 的 `lib/index.js:917`）、`compactIfNeeded`（`:932`）、`regionDependencies()` 里 `summarize: (input, owner, abort) => this.summarize(...)`（`:1029-1030`）逐字一致；`dsh-tools` 的 `defineTool`、`dsh-llm` 的 `BlockAssembler`、`dsh-token-meter` 的 `estimateMessage` 也都在。

package.json 的 peer 范围因此写成生态通用的分段式：`>=0.2.1-0 <0.2.1 || >=0.2.1 <0.3.0 || >=0.2.2-0 <0.2.2 || >=0.2.3-0 <0.2.3`（cordis `>=4.0.1 <5`）。node-semver 实测：0.2.0-rc.2 false、0.2.1-rc.1/0.2.1-rc.2/0.2.1 true、0.2.2-rc.1/0.2.2 true、0.2.3-rc.4 true、0.3.0-rc.1 false。

在 0.2.2-rc.1 上的复验（沙盒 `w1`）：headless 一轮 → `plugin:tower/block` seq 19 写入（`covers=[8,9,10,11,16]`，`2761 → 179 tok`）、flush 成功、26 个工具；web 三回合 → `b00001 T1 / b00002 T1 / b00003 T2（合并 2 个 checkpoint）`，面板与树渲染正常、零 console 错误；配置表单在 1440/1024/800 三宽度下 14 项、零挤压零横向溢出，改 `触发线` 为 `0.02` → 覆盖层落盘 → **重启进程后**面板显示 `触发线 21.0K`（0.02 × 1.05M）⇒ 覆盖层在 0.2.2 上仍按预期优先生效。

---

## 13. 未决问题

1. **摘要角色**：宿主契约要求替换事件是 `user/message`（`system` 会被计量投影直接抛错），Sisyph 用 `assistant`。是否影响模型行为，需 A/B。
2. **一个回合提交多块的日志噪音**：每块一对 `compaction/*`，一回合 3 块 = 12 条事件。可接受与否待观察。
3. **T2 蒸馏的信息损失**：蒸馏"摘要的摘要"必然丢细节，级联层数是否需要硬上限（当前建议 3）。
4. **`targetRatio` 达不到时**：材料不够就只能停在能到的地方，这是设计允许的，但需要向用户说明。
5. **`distillMinRunRatio` 与用户给的 0.45**：用户口述的"0.45"更像 `triggerRatio`。两者需要在实际跑起来后各自标定。
6. **原型补丁的升级脆弱性**：`summarize` / `compactIfNeeded` 是官方扩展点，但补丁依赖方法名存在。宿主升级后需回归 §12 的 #7 与本节。
7. **`summarize` 与"我们选的范围"如何对齐**：`summarize` 只收到 `input.messages`，没有 range。做法是在补丁的 `compactIfNeeded` 里把 `{start, end, blockId}` 存进 per-session WeakMap，`summarize` 读它；并用 `input.messages` 的 `id` 集合做一次校验（`deriveEventMessage` 原样返回 `event.data`，所以 host message id 在）。

---

## 14. 移植清单（从 Sisyph 拿什么）

| Sisyph 文件 | 用途 | 处理 |
|---|---|---|
| `context.py`（458 行） | 装配/区间代数 | **只借鉴思路**，DSH 有 `foldSurface` |
| `readback.py` 的 `core_search` | 搜索打分 | 直接搬（纯函数） |
| `readback.py` 的 `block_content_core` | 一层展开 | 直接搬 |
| `store.fold` / id 方案 | 账本 | **不要搬**，宿主已解决 |
| 观察者 prompt | 摘要模板 | 直接搬，改输出格式 |
| `wire.py` 的标签渲染 | 编号标签 | **不要搬**（本方案正文不加标签） |

---

## 15. 实现状态（v2：分层提交塔 + advisor）

代码在仓库根目录。

| 模块 | 文件 | 职责 |
|---|---|---|
| 插件入口 | `lib/index.js` | `name/inject/Config/apply`；装补丁、注册工具、挂 `agent/turn-stopping`、装载 `/advisor` 子插件 |
| 配置 | `lib/config.js` | 14 个键 + 元数据 `FIELDS` + 校验（`targetRatio < triggerRatio`，未知键拒绝） |
| 配置存储 | `lib/config-store.js` | 稀疏覆盖层 `<DSH_HOME>/storages/compaction-tower/config.json`，三级优先级、原子写、`onChange` 推送 |
| 账本 | `lib/core.js` | 事件遍历、块记录/意见记录读写、块号分配、摘要头、token 格式化 |
| 选段 | `lib/select.js` | `headRun` / `planCommits` / `selectRawRun` / `selectMergeRun` / `protectedTail`，全是纯函数 |
| 引擎补丁 | `lib/engine.js` | 换 `BasicCompactionEngine.prototype` 的两个方法，带幂等标记 |
| 核心 | `lib/tower.js` | 压力规划、多块提交、摘要查表、观察者（两份材料）、顾问调用、导出渲染 |
| 工具 | `lib/tools.js` | `decompress` / `search_context` / 可选 `advisor` + 落盘 |
| 命令 | `lib/command.js` | `/advisor`（动态导入，`dsh-commands` 缺失时整块不跑） |
| 提示词 | `lib/prompts.js` | 顾问 system / 请求 / 工具说明（改自 Sisyph） |
| 状态快照 | `lib/state.js` | `buildState()`：给界面用的纯 JSON（块三态、占用、顾问） |
| Web 路由 | `lib/server.js` | `GET /tower/state`、`POST /tower/action`、`GET/POST /tower/config`（自带鉴权） |
| 客户端 | `lib/client.js` | 手写 bundle：`window.__ModuleLoader__.load` + `conversation.view` 与 `plugins.bundle.config` 两个槽位 |
| 文案 | `locale/*.json` | 插件卡片标题与描述（`meta.title` / `meta.description`） |

**提交策略（v2 已按 §3.1/§3.2 改造）**

- `planCommits` 一次算清全部候选，按 `tier` 升序 + 同层最老优先，累加 `summaryTokens - coveredTokens` 到目标即停；
- `compactIfNeeded` 一次请求可连续提交多块（各块 covers 互不相交，`compactRegion` 逐块调用）；
- 观察者的合并材料只取**相邻同层** checkpoint，`tier = max(子块 tier) + 1`，深度 log₂(提交次数)。

**离线测试（全部通过，不启动宿主）**

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `test/smoke.mjs` | 31 | 配置校验、块记录往返、块号递增、摘要头格式、`headRun` 边界、`planCommits` 分层/达标即停/表层过滤、原文段与 checkpoint 段选段、同层合并与上限截断、受保护尾 |
| `test/wire.mjs` | 20 | 插件装载、工具参数/输出契约、补丁安装、事件监听、记录类型语法、`/advisor` 注册、`advisorExpose` 条件注册、四条 Web 路由注册 |
| `test/patch.mjs` | 21 | 压力→选段→`compactRegion`→摘要查表；三条委托路径；多块连续提交；从 checkpoint 消息识别子块；顾问旁路请求（换 system、追加请求、独立 purpose、不走表层） |
| `test/state.mjs` | 13 | 状态快照字段、块三态判定（dormant/committed/consumed）、占用与阈值、顾问记录读取 |
| `test/config.mjs` | 30 | 覆盖层路径跟随 `DSH_HOME`、三级优先级、只存改过的键、重启读回、四类校验拒绝、`reset`、`onChange`、快照形状、配置路由 |

**与设计稿的偏离（仍在的部分）**

1. **budget = 上下文窗口**：没有扣 `reservedCompletionTokens`（宿主自己扣），阈值语义因此比宿主略宽松。
2. **块记录不缓存**：`blocksOf()` 每次遍历全量事件。长会话有优化空间，先求正确。
3. **观察者返回 promise**：`agent/turn-stopping` 是 serial 且被宿主 await，改成 fire-and-forget 会让回合立刻关会话、块落不了盘（已实测，见 §12.1）。

**真机验证结果**：见 §12.1 / §12.2 / §12.3 / §12.4。分层提交、同层合并、advisor 旁路请求、Web 面板、配置表单与持久化都已在沙盒 DSH（headless `t1` + web `w1`）上跑通。

**做真机验证时的一个坑**：`dsh --profile desktop ...` 会被 CLI 拒绝——`desktop` profile 由 Electron 应用独占管理（报错原文 `profile "desktop" is managed exclusively by the Electron application`）。所以不能在命令行上给正在跑的桌面 profile 加 `--patch` 或 `--dump-config`。真机联调要么用桌面应用的插件管理界面装 bundle 并重启，要么另建一个 profile（`dsh <name> --from-default-profile web`）。本次用的是第三种：`npm install @deepseek-ai/dsh` 装一份独立副本 + 独立 `DSH_HOME`，完全不碰桌面 profile。

---

## 附录 A：一次完整提交的时序

```
T   turn-stopping 触发（宿主 await 这个监听器）
    ├─ tokenMeter.measure() → 找早于最近 10 轮的未覆盖 run
    ├─ run.tokens ≥ 0.05 × budget ?
    └─ 是 → 蒸馏：一次旁路 LLM 调用写摘要
        ├─ appendPluginRecord(sess, 'plugin:tower/block', { blockId:'b00007', tier:1,
        │                    covers:[12,15,18,23], summary:[…] })
        ├─ sessions.flush(session)      ← 不 flush 就可能随进程退出丢掉
        └─ 此时模型上下文无任何变化

T+n   下一个请求前，补丁 compactIfNeeded（宿主 pre-step 调它）
    ├─ tokenMeter.measure().surfaceTokens ≥ 0.45 × budget ?
    ├─ 选段：最老的未覆盖 run，跳过最近 10 轮，不切断工具对
    ├─ 命中 dormant 块 b00007 → pendingRange.set(session, {start:12, end:23, blockId:'b00007'})
    └─ this.compactRegion(12, 23, agent, signal)   ← 交回引擎

        引擎内部（我们不再干预）：
        ├─ compaction/start
        ├─ summarize()  ← 补丁命中 pendingRange，直接返回 b00007 的摘要文本（零 LLM）
        ├─ compaction/summary (shadowedSeqs:[12,15,18,23], shadowedTokenCount:8400)
        ├─ user/message { content:[{type:'text', text:'<CHECKPOINT_PREAMBLE>\n<summary>…'}] ,
                           surfaceOp:{op:'replace', startSeq:12, endSeq:23} }
        └─ compaction/end
        └─ 全程 < 10ms，零 LLM 调用
```
