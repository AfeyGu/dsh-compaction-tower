# dsh-compaction-tower

DSH 的分块自动压缩工具：**无需主动压缩** —— 旧历史提前蒸成块，越线时自动换进上下文，让占用一直待在设定的「青壮年区间」（如 15%~45%），也不打断对话。

**一句话**：旧历史在后台被蒸成块（只进日志，模型看不见）；占用越过触发线时，整块换进上下文、落回目标线，所以上下文一直在区间里来回。

![压缩逻辑](https://cdn.jsdelivr.net/gh/AfeyGu/dsh-compaction-tower@main/docs/compression.png)

## 它做什么

- **压缩由它自己决定，不用模型操心**：观察者在后台把早期历史蒸成「块」写进日志 —— 只进日志不进上下文，模型看不见。每次请求前和每个回合结束前各判定一次，按「每层库存」决定蒸几块，并发发起（默认 10 个）。**每层库存 =（触发线 − 目标线）÷ 一个单位，再留 1 块当安全垫**，默认 45% / 15% / 5% 时是 **7 块**。
- **越线那一刻不等模型**：块是提前蒸好的，提交就是一次查表，再交给宿主的压缩引擎换进表层 —— 不卡顿。
- **压过的内容还能取回来**：`decompress` 看回被压缩的历史，`search_context` 在含已压缩内容的全部历史里搜。

## 它不做什么

- 不注册 `compress` 工具，不做 nudge 提示——压缩决策与模型无关。
- 不自己写 `compaction/*` 事件、不自己算遮蔽价格——那些由 `dsh-compaction-basic` 负责，我们只替换它的两个扩展点。
- 不禁用宿主自带压缩，不改任何 preset，不碰 system prompt。
- 不改请求对象（它被深冻结）；所有表层变更只经 `surfaceOp: replace`。

## 术语

| 词 | 意思 | 在哪能看到 |
|---|---|---|
| **块**（block） | 一次蒸馏产出的摘要记录，带块号 `b00007`、层号、覆盖范围。**只写在日志里，不进上下文** | 面板「块」列表；日志事件 `plugin:tower/block` |
| **checkpoint** | 提交之后替换进上下文的那条消息，正文 = 块头 `[b00007 · T1 · 104 条 · …]` + 摘要。它**在表层上**，会占 token | 对话里被折叠的那段；日志 `compaction/end` |
| **层**（tier） | T1 由原文蒸馏；T2 由同层 checkpoint 合并；T3 再往上。代码按 `max(子块层)+1` 算，不设上限 | 面板「层」列、`T1` 标签 |
| **覆盖**（covers） | 这个块覆盖了哪些消息（seq 列表）。提交时就是把这段换成一条 checkpoint | 面板「覆盖」列 |
| **单位**（U） | 一块的材料量 = `distillMinRunRatio × 可用预算`（默认 5%）。每层一块都约等于一个单位换一个单位 | 配置「单块分量」 |
| **可压区**（head run） | 表层上从最老的非 system 节点起、到第一个受保护节点之前的那段连续区间。只有落在里面的块才能提交 | 不在界面上，看「上次判定」 |
| **保护区** | 最近 `retainRecentGroups` 个 step（一次模型请求 = 一步）。**只在提交时生效**：覆盖它的块先不提交，蒸馏照样可以做 | 配置「保留最近步数」 |
| **固定开销**（F） | system 提示词 + 工具 schema 的 token。恒占窗口、永不压缩，阈值分母先把它扣掉 | 占用条最前面那一截黑色 |
| **可用预算**（B） | `窗口 − 固定开销`。触发线、目标线、单位、库存全部以它为分母 | 占用条图例里的「可用」 |
| **库存** | 每层「已蒸馏、材料还在表层、还没进上下文」的块还能回收多少 token。够了就不再多蒸 | 内部；可看「块」列表里「待提交」的数量 |
| **提交记录** | 块号 ↔ 它换进来的 checkpoint 节点。**块身份的唯一权威来源**；正文里的块头只给没有提交记录的老会话兜底 | 日志事件 `plugin:tower/commit` |
| **蒸馏**（distill） | 一次旁路 LLM 调用，产出一个块 | 按钮「立即蒸馏」 |
| **提交**（commit） | 把块换成 checkpoint，**零 LLM 调用** | 按钮「立即提交」；日志 `compaction/end` |

**块和 checkpoint 的区别最容易混**：块是账本（日志里），checkpoint 是上下文里那条消息。压缩省下的空间只发生在**提交**那一刻——块再多，不提交也不省空间。

## 怎么确认它在工作

1. 面板出现 **压缩** tab，能看「当前 / 窗口」和块列表 → 插件已装载；
2. 占用越线后，块列表里「待提交」的块变成「已进入上下文」→ 提交生效；
3. 会话日志里出现 `compaction/end` 事件 → 表层真的被替换了。

**面板底部那行「上次判定」就是排障入口**，它会明确告诉你上一次为什么没压：

| 显示 | 含义 | 怎么办 |
|---|---|---|
| `未到触发线（内容 X / Y）` | 还没到线（X 是内容，Y 是触发线，都按可用预算算） | 正常，等它涨 |
| `量不到上下文窗口，这次不压` | `llm.resolveModelInfo` 拿不到窗口 | 检查该 provider/model 是否可用 |
| `可压区为空` | 老材料全在保护区里，或都已经进了块 | 减小 `retainRecentGroups`，或等新回合把老料挤出保护区 |
| `没有可提交的块（账本 N 块，可压区 M 条）` | 有块，但没一块的覆盖区间完整落在可压区 | 常见于块刚蒸完还没提交；点「立即提交」并随便发一句 |
| `提交 N 块（b0000x …）→ Y` | 刚刚提交过 | 正常 |

**观察者那一行同样会说明原因**：刚开的新会话总量还不到一个单位（默认 5% 可用预算），可蒸材料为 0 —— 这是设计如此，不是观察者没跑。攒够一个单位就会开始蒸。注意保护区**不拦蒸馏**（蒸馏不改上下文），只拦提交。

打开调试日志：启动应用前设环境变量 `TOWER_DEBUG=1`，插件会把每一步判定写到 stderr。**默认关闭**，因为每个 step 都会打印。

## 安装

已发布到 npm：**`dsh-compaction-tower`**。

> 别直接 `npm i dsh-compaction-tower` —— 那只会把包装进当前目录的 `node_modules`，DSH 启动时不看那里。插件得装进 **profile**，由宿主的插件管理来做。

走宿主的插件管理，不要手改清单。装的是 tarball 或包名，宿主会自己跑 `pnpm add` 并把它加进 `~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles`：

- **插件页**：设置 → 插件 → 安装，填 `dsh-compaction-tower` 或 tarball 路径；
- **接口**：`plugin_manager install_bundle`（就是插件页背后的同一条路）。

装完**重启一次应用**：宿主半侧是启动时装载的，客户端半侧随页面加载，不重启只会看到半旧状态。

`package.json` 里最终是这两处，手工维护时两处都得对（漏了 `bundles`，插件页就看不到它）：

```json
{
  "dependencies": { "dsh-compaction-tower": "0.1.39" },
  "dsh": { "profile": { "bundles": ["…", "dsh-compaction-tower"] } }
}
```

离线安装时把版本换成 tarball 路径即可：`"file:…/dsh-compaction-tower-<version>.tgz"`。

插件的 `dsh.bundle.patch.yml` 只插自己一行，不覆盖任何已有配置。

### 版本要求：DSH ≥ 0.2.1

块账本写在会话日志里（`plugin:tower/block`），靠的是 `appendPluginRecord()` 打的 `ignorable: true` 标记。这个 API 是 **0.2.1 才有的**；0.2.0 的 `session.append()` 只认 `surfaceOp`/`sourceEventSeqs`，永远写不出 `ignorable`。而 0.2.0 的会话持久化在加载时就会拒绝未知事件类型（`dsh-session-persistence/lib/index.js:184`），所以硬写进去会让那条会话**再也打不开**。

插件页因此会显示「与 DSH 0.2.0-rc.2 不兼容」——这是真限制，不是版本号洁癖。把桌面应用更新到 0.2.2 或更高即可（插件页的「异常」标记随之消失）。

## 配置

主要是比例，随上下文窗口自适应（也可以在插件页的表单里改，见「配置界面」）：

| 键 | 默认 | 含义 |
|---|---|---|
| `triggerRatio` | 0.45 | 请求压力过此比例才提交 |
| `targetRatio` | 0.15 | 提交后希望降到的水平（尽力而为） |
| `distillMinRunRatio` | 0.05 | 一个「单位」：一次蒸馏/合并的材料量占**可用预算**的比例。不足不动手，够了就切一块 |
| `retainRecentGroups` | 10 | 最近 N 个 **step**（一次模型请求 = 一步）永不压缩 |
| `observerMaxTokens` | 200000 | 绝对保险丝（单块上限）；正常单块等于上面的单位，只有单个节点超大时才会碰到它 |
| `observerProvider` | `''` | 观察者（蒸馏）用的 provider，空 = 跟随会话 |
| `observerModel` | `''` | 观察者（蒸馏）用的 model，空 = 跟随会话 |
| `observerTimeoutMs` | 120000 | 单次蒸馏超时 |
| `summaryPromptMode` | `host` | 蒸馏提示词三档：`host`（宿主英文原文）/ `zh`（中文同结构）/ `custom`（自己写） |
| `summaryPrompt` | `''` | 自定义蒸馏提示词，仅 `custom` 档生效；留空退回宿主 |
| `summaryMaxTokens` | 200000 | 中文版 / 自定义档那次摘要请求的输出上限（保险丝）；**别调小**，撞上限会让整块作废。0 = 不传，用模型自己的输出上限 |
| `observerConcurrency` | 10 | 一次最多同时发起几个蒸馏 |
| `inlineMaxRatio` | 0.02 | 解压内容内联的阈值（占窗口比例） |
| `hardMaxTokens` | 40000 | 单次解压的绝对上限 |
| `exportKeepSessions` | 20 | 保留最近 N 个导出会话目录 |
| `mergeMinBlocks` | 2 | 一次合并的块数下限；真正的门槛是同层 checkpoint 要累加到窗口的 5% |

## 压缩怎么工作

```text
平时（后台，不打扰对话）
  早期原文 ──观察者──▶ 块 b00001 / b00002 / b00003      只进日志，模型看不见

越线那一刻（提交 = 查表，零 LLM 调用）
  [b1 原文][b2 原文][b3 原文][最近 N 步]          内容 ≥ 触发线
  ───────────── 换进表层 ─────────────▶
  [b1 摘要][b2 摘要][b3 摘要][最近 N 步]          落到目标线

压过的内容不会消失
  decompress(b00001) 取回原文 · search_context("关键词") 在全部历史里搜
```

块还能继续合并成更高的层（T2、T3…），层数不设上限；最近 N 步受保护区保护，不会被换走。

设计推导、两种 token 口径、提示词的细节见 [docs/design/compaction.md](docs/design/compaction.md)。

## 界面

![Tower 面板](https://cdn.jsdelivr.net/gh/AfeyGu/dsh-compaction-tower@main/docs/panel.png)

装进 `web` 组合后，会话区多一个 **压缩** 视图 tab（`conversation.view` 槽位），只读展示 + 三个手动操作：

- **上下文占用**：一条四段 —— **黑 = 固定开销**（system + 工具 schema，永远压不掉），实心 = 内容，斜纹 = 当前到触发线之间还能涨的空间，灰 = 触发线之后（永远到不了）。越线后多出一截更深的表示「已经越界」。触发线画在「固定开销 + 触发线」的位置上，所以图例里的数字标着「（内容）」。**底部两行直接回答「为什么没动」**：

- 上次判定：未到线 / 没窗口 / 可压区空 / 没有可提交的块 / 计划提交 N 块→实际成功几块；
- 上次观察：没有可蒸材料（都在保护区内）/ 库存已够 / 并发名额占满 / 发起了几块。
- **块列表**：块号、层、覆盖条数、原 → 摘要 token、状态（待提交 / 已进入上下文 / 已并入上层），点一行展开摘要正文，勾选用于合并。
- **塔结构**：按 `childBlockIds` 递归，能看出「哪两个 T1 合并成了这个 T2」。
- **按钮**：立即蒸馏（跑一次观察者）、立即提交（排队）、合并选中（≥2 个同层且已进入上下文的块）、**设置**（就地切到压缩参数，再点一次返回记录）。

块列表和塔结构各自有高度上限、各自内部滚动（`.tw-table-wrap` / `.tw-tree-wrap`），块多到几十个也不会把页面顶长；面板本身不产生横向滚动。窄到 800px（侧栏收成图标）时表格与表单仍然不挤压、不折行溢出：

![窄屏](https://cdn.jsdelivr.net/gh/AfeyGu/dsh-compaction-tower@main/docs/panel-narrow.png)

数据走宿主同源的四个路由（`lib/server.js`）：

| 路由 | 说明 |
|---|---|
| `GET /tower/state?sessionId=` | 返回整份状态快照；省略 sessionId 时取最近打开的那个会话 |
| `POST /tower/action` | `{kind:'distill'\|'commit'\|'merge', sessionId, blockIds?}` |
| `GET /tower/config` | 配置表单的初值：字段元数据、当前值、是否被覆盖、覆盖层路径 |
| `POST /tower/config` | `{patch:{…}}` 保存稀疏覆盖，或 `{reset:[key…]}` 恢复某一项 |

两条状态路由自己调 `ctx.connection.authorizeIndex()` 做登录校验，未登录回 401——宿主自带的 named route 不套鉴权。

> 为什么「立即提交」是排队而不是立刻：把块换成 checkpoint 必须落在**一个打开的回合**里，
> 空闲时 `compactRegion` 会拒绝（`no open turn`）。所以按钮只置一个标记，下一个回合开始、
> 引擎来问的时候按目标 0 一次提交完。合并不受此限（它只写块记录，不产生 compaction 事件）。

### 配置界面

![配置表单](https://cdn.jsdelivr.net/gh/AfeyGu/dsh-compaction-tower@main/docs/config.png)

插件页里点开本插件卡片，表单直接渲染在描述下方（`plugins.bundle.config` 槽位），**17 项**按「触发与目标(2) / 观察者(11) / 塔(2) / 解压(2)」分组，每项带说明、百分比换算与「恢复默认」。观察者的 provider / model 是下拉框，候选直接取自宿主的模型目录（`llm.listProviders` + `llm.listModels`），和对话框里的模型选择是同一份数据；留空即跟随当前会话。提示词字段是三档下拉 + 只读展示。

改完点保存即时生效，不用重启。存的是**稀疏覆盖**，落在：

```
<DSH_HOME>/storages/compaction-tower/config.json
```

优先级：覆盖层 > profile 里的 `compaction-tower` 条目 > 内置默认。所以「恢复默认」是把那一项从覆盖层删掉，回到 profile 写的值，而不是回到出厂值。

> 为什么不用宿主的 settings 服务：`settings.describe()` 只列出 **profile 文档里**的条目，
> 由 bundle patch 插入的行不在其中——我们这条 `compaction-tower` 正是被插进去的，拿不到表单。

## 已知限制

- **原型补丁依赖方法名**：`compactIfNeeded` / `summarize` 是官方扩展点，但宿主大版本升级后需要复查。缺失时插件会记 warning 并降级为「只提供工具」。
- **块记录每次现读**：`blocksOf()` 遍历会话全量事件。请求前的排程有 5 秒节流、回合尾才无条件跑一次，所以长会话下是「偶尔 O(事件数)」，不是每个 step。
- **默认比例未经长会话标定**：`triggerRatio 0.45` 按 1M 窗口推；`distillMinRunRatio 0.05` 是单块分量（≈52K @ 1M），实际频率与块大小待多轮观察。

## 测试

```bash
node test/smoke.mjs   # 纯逻辑：配置、块记录、摘要头、选段、分层提交、同层合并、checkpoint 身份、分层库存
node test/wire.mjs    # 接线：插件装载、工具契约、补丁安装与四条路由注册
node test/patch.mjs   # 链路：压力→选段→compactRegion→摘要查表、多块提交、合并块可提交、溢出强压
node test/state.mjs   # 界面数据：状态快照、块状态判定
node test/config.mjs  # 配置存储：路径跟随 DSH_HOME、三级优先级、校验拒绝、原子写、路由、提示词三档
node test/client.mjs  # 客户端渲染：加载态→数据态→设置态切换，守住每次渲染的钩子数量一致
node test/prompts.mjs # 提示词：三档指令、接管请求的形状（toolHistory/purpose/maxTokens）、截断即失败
```

七个测试都不启动宿主。`client.mjs` 用一个会记账的假 React 跑组件首帧与数据帧：钩子数量一旦前后不一致，真实 React 会抛 #310、面板整块空白，所以这条必须在测试阶段炸出来。`prompts.mjs` 用一个假 `llm.stream` 捕获请求，确保接管摘要时那四条形状约定一条不少。

## 真机验证

在独立安装的 DSH 0.2.1-rc.2 与 0.2.2-rc.1 上各跑通一遍全链路：观察者写块 → 分层提交 → 表层替换 → 模型真实调用 `decompress` / `search_context`；Web 面板在 1440 / 1024 / 800 三个宽度下零横向溢出、无元素挤压，配置改值 → 保存 → 重启后仍生效。

复现方式与逐条证据见[设计规格](docs/design/DSH-Tower-插件设计规格.md) §12（独立 DSH 副本 + 独立 `DSH_HOME`，用 `tools/check-ui-live.mjs`、`tools/probe-*.mjs` 经 CDP 驱动真实页面，用 `tools/inspect-*.mjs` 读会话日志核对块记录）。
