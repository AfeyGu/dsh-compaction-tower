# dsh-compaction-tower

DeepSeek Harness 的压缩插件：观察者在后台把早期历史蒸成「块」，越线时把整块换进上下文。
提交路径零 LLM 调用，模型可以用 `decompress` / `search_context` 回读原文。

完整设计见 `README.md`；本文只写「不看代码就得踩一遍」的部分。

## 命令

仓库没有 npm scripts，全部直接跑 Node。用宿主自带的运行时（不在 PATH 上）：

```
node  %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
pnpm  %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs
```

七个测试文件都以 `node test/<name>.mjs` 运行，最后一行必须是 `✅ <name>: N 项全部通过`：

```powershell
foreach ($t in 'smoke','patch','state','config','prompts','wire','client') { node "test/$t.mjs" }
```

- `smoke` 纯逻辑（选段、提交计划、库存、标定、差分）
- `patch` 补丁链路（假 engine/agent/session 走完压力→提交→摘要查表）
- `wire` 装配（工具契约、补丁安装、路由注册）
- 其余是面板数据、配置存储、提示词、客户端渲染

## 打包与安装（改源码不会生效）

装进 profile 的是 **tgz**，不是源码目录。改完必须走完这四步，否则跑的还是旧版本：

1. `package.json` 升版本号；
2. `node <pnpm.mjs> pack --pack-destination ..`（tgz 落到上级目录）；
3. 用宿主的插件管理装：`plugin_manager` → `install_bundle` → target 填 **绝对路径** 的 tgz；
4. 重启应用。

不要手改 profile 的 `package.json`（`%USERPROFILE%\.dsh\profiles\<name>\package.json`）。安装前的全量测试必须全绿。

## 验证环境

真机验证走工作区里的一套独立环境（**不进本仓库**，属于本机设施）：

- `..\_dev\tools\SANDBOX.md` —— 独立 DSH 副本 + 独立 `DSH_HOME`（profile `t1`/`w1` 用 junction 指回本仓库）
- `..\_dev\tools\run-turns.ps1` —— 无头跑 N 个回合并汇报 Tower 活动
- `..\_dev\tools\borrow-route.mjs` —— 把桌面 profile 的模型路由搬到沙盒 profile

不碰日常的 desktop profile。

## 架构

**事件日志是唯一真相。** 块不是内存对象，是日志里的记录：

| 记录 | 作用 |
|---|---|
| `plugin:tower/block` | 块本体（covers、摘要、层级、大小） |
| `plugin:tower/commit` | 块号 ↔ checkpoint 节点。块身份**只能**从这里读，不允许正则反推正文 |
| `plugin:tower/advice` | 顾问输出 |

表层替换仍由宿主的 `compactRegion` 做，插件只决定「提哪一块、什么时候提」。

**补丁点只有三个**（`lib/engine.js` 换原型方法）：`compactIfNeeded`（压不压、压哪段）、
`summarize`（有现成块就零成本返回，否则转发宿主）、以及提交成功后写 commit 记录。
插件从不关闭宿主压缩，也不碰 system prompt。

**模块分工**：

- `tower.js` 策略与执行（压力判定、排程、蒸馏、提交、标定）
- `select.js` 纯决策函数（选段、提交计划、库存配额），无 session 访问，测试主要打这里
- `core.js` 账本读写与块头格式
- `state.js` / `client.js` 面板快照与渲染；`server.js` 的 `/tower/*` 路由
- `tools.js` 模型能调的三个工具；`summarize.js` 旁路 LLM 调用

## 三个容易踩的坑

**1. 两种 token 口径不能混。** 判定的「内容」来自 provider 的 `usage`（真实），
而 `tokenMeter` 的 `nodes[].tokens` 是 `字符数 ÷ 4` 的估算，中文被低估三成。
混用的后果是「以为还剩 160K，其实已经压到 56K」。统一口径靠 `calibration()`
（标定固定开销与系数）、`realTokensOf()`（用两次请求的 prompt 差测块的真实大小）、
以及块记录里的 `tokBasis`（`real` / `scaled`）。新增任何按 token 判断的逻辑，
先确认自己站在哪把尺子上。

**2. 提交闸门是工具配对平衡，不是 step 边界。** 宿主的报错文案写着 step，实际校验的是
「工具调用与结果不跨切点」。按 step 去卡会让合并块（checkpoint 节点落在 step 之外）
永远提交不了。

**3. 保护区只拦提交，不拦蒸馏。** 蒸馏不改上下文，随时可以做；最近 `retainRecentGroups`
个 step 只是不允许被替换。

## 约定

- 判定和面板必须用同一套数字（同一函数算），否则面板会出现自相矛盾的两行。
- `client.js` 的钩子数量在加载态与数据态之间必须一致，否则 React 会抛 #310 整块白屏；
  `test/client.mjs` 专门守这条。
- 面板上的 action（立即蒸馏 / 立即提交）只排队，真正的压缩必须在回合内由引擎发起。
- 配置项加在 `lib/config.js` 的 `FIELDS` 里（含中文 hint），`locale/*.json` 两语同步。
- 文档：`docs/design/` 放本项目的设计规格与界面草图；DSH / Sisyph 的逆向研究属于内部资料，留在仓库外（`..\_dev\research\`）。
