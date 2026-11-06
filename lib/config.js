/**
 * Tower 的配置：全部是比例，随模型上下文窗口自适应。
 *
 * 这里只做「默认值 + 校验 + 字段元数据」，不做任何 IO。
 * 三处共用同一份事实：DEFAULTS（默认值）、Config（schemastery，给宿主）、
 * FIELDS（配置界面用的标签/说明/范围）。
 */
import z from '@deepseek-ai/schemastery';

/** 默认值。改这里等于改所有未显式配置的部署。 */
export const DEFAULTS = Object.freeze({
  /** 占用超过比例才提交 */
  triggerRatio: 0.45,
  /** 提交到此为止（尽力而为） */
  targetRatio: 0.15,
  /** 观察者认为「值得蒸馏」的最小 run 占比 */
  distillMinRunRatio: 0.05,
  /** 最近 N 个 step 永不提交（蒸馏不受限） */
  retainRecentGroups: 10,
  /**
   * 单个块原文的 token 上限。
   *
   * 这是保险丝，不是常规截断点：正常的上下文窗口（数百 K）里，
   * 一段该被压缩的历史几乎不可能到 200K；真到了就说明模型在刷垃圾输出，
   * 这时截断反而是对的。所以默认给到很大，只拦住失控的情况。
   */
  observerMaxTokens: 200000,
  /** 观察者用的 provider（空 = 跟随当前会话） */
  observerProvider: '',
  /** 观察者用的 model（空 = 跟随当前会话） */
  observerModel: '',
  /**
   * 每层的目标库存（几个单位）。
   *
   * 越线后要能从触发线一路压到目标线，所以库存 = (触发线 − 目标线) / 一个单位，再加 1 个安全垫。
   * 每层各自计数：低层块顶不了高层的缺（提交顺序是低层优先）。
   */
  /** @deprecated 已改为按 (触发线−目标线)/单位 自动推导（见 reserveUnitsOf）；保留键只为兼容已存的旧配置 */
  observerReserveUnits: 4,
  /** 一次最多同时发起几个蒸馏（并发块数，每个都是一次付费调用） */
  observerConcurrency: 10,
  /** 单次蒸馏超时（毫秒） */
  observerTimeoutMs: 120000,
  /** 蒸馏提示词用哪一套：host（宿主英文原文）| zh（中文预设）| custom（自己写） */
  summaryPromptMode: 'host',
  /** 自定义蒸馏提示词（仅 summaryPromptMode === 'custom' 时使用） */
  summaryPrompt: '',
  /** 摘要输出上限（保险丝）：接管那次请求时必须显式给足，否则会被模型的默认上限腰斩 */
  summaryMaxTokens: 200000,
  /** 解压内容内联的阈值（占预算比例） */
  inlineMaxRatio: 0.02,
  /** 单次解压的绝对上限 */
  hardMaxTokens: 40000,
  /** 保留最近 N 个导出会话目录 */
  exportKeepSessions: 20,
  /** 相邻 checkpoint 达到几个才值得合并成上层块 */
  mergeMinBlocks: 2,
  /** 是否把 advisor 作为工具暴露给模型（否则只能用户手动 /advisor） */
  advisorExpose: false,
  /** 顾问用的 provider（空 = 跟随当前会话） */
  advisorProvider: '',
  /** 顾问用的 model（空 = 跟随当前会话） */
  advisorModel: '',
  /**
   * 顾问单次回答的 token 上限。
   *
   * 同样是保险丝而不是限制：顾问正常只答几 K，200K 永远碰不到；
   * 真碰到了说明它在刷无效输出，那时截断才是对的。
   */
  advisorMaxTokens: 200000,
  /** 顾问人设（空 = 内置） */
  advisorSystem: '',
  /** 顾问人设用哪一套：builtin（内置预设）| custom（自己写） */
  advisorSystemMode: 'builtin',
  /** 顾问请求（空 = 内置） */
  advisorPrompt: '',
  /** 顾问请求用哪一套：builtin（内置预设）| custom（自己写） */
  advisorPromptMode: 'builtin',
});

export const Config = z.object({
  triggerRatio: z.number().min(0.001).max(0.95).default(DEFAULTS.triggerRatio),
  targetRatio: z.number().min(0.0001).max(0.9).default(DEFAULTS.targetRatio),
  distillMinRunRatio: z.number().min(0.00001).max(0.5).default(DEFAULTS.distillMinRunRatio),
  retainRecentGroups: z.number().step(1).min(0).default(DEFAULTS.retainRecentGroups),
  observerMaxTokens: z.number().step(1).min(1000).default(DEFAULTS.observerMaxTokens),
  observerProvider: z.string().default(DEFAULTS.observerProvider),
  observerModel: z.string().default(DEFAULTS.observerModel),
  observerReserveUnits: z.number().step(1).min(0).default(DEFAULTS.observerReserveUnits),
  observerConcurrency: z.number().step(1).min(1).max(16).default(DEFAULTS.observerConcurrency),
  observerTimeoutMs: z.number().step(1000).min(1000).default(DEFAULTS.observerTimeoutMs),
  summaryPromptMode: z.string().default(DEFAULTS.summaryPromptMode),
  summaryPrompt: z.string().default(DEFAULTS.summaryPrompt),
  summaryMaxTokens: z.number().step(1).min(0).default(DEFAULTS.summaryMaxTokens),
  inlineMaxRatio: z.number().min(0.001).max(0.5).default(DEFAULTS.inlineMaxRatio),
  hardMaxTokens: z.number().step(1).min(1000).default(DEFAULTS.hardMaxTokens),
  exportKeepSessions: z.number().step(1).min(1).default(DEFAULTS.exportKeepSessions),
  mergeMinBlocks: z.number().step(1).min(2).default(DEFAULTS.mergeMinBlocks),
  advisorExpose: z.boolean().default(DEFAULTS.advisorExpose),
  advisorProvider: z.string().default(DEFAULTS.advisorProvider),
  advisorModel: z.string().default(DEFAULTS.advisorModel),
  advisorMaxTokens: z.number().step(1).min(500).default(DEFAULTS.advisorMaxTokens),
  advisorSystem: z.string().default(DEFAULTS.advisorSystem),
  advisorSystemMode: z.string().default(DEFAULTS.advisorSystemMode),
  advisorPrompt: z.string().default(DEFAULTS.advisorPrompt),
  advisorPromptMode: z.string().default(DEFAULTS.advisorPromptMode),
});

/**
 * 配置界面的字段元数据。数组顺序即显示顺序，`group` 决定分栏。
 * `type`：ratio 是 0..1 的比例，int 是整数，bool 开关，text 自由文本，
 * textarea 多行文本（提示词用，`rows` 是行数），
 * select 是下拉——`options` 是固定的候选项；`source: 'provider' | 'model'` 表示候选项
 * 从宿主的模型目录里取，`pairKey` 指向它跟随的 provider 字段（选 provider 后只列该家的模型）。
 */
export const FIELDS = Object.freeze([
  {
    key: 'triggerRatio',
    group: '触发与目标',
    label: '触发线',
    type: 'ratio',
    min: 0.001,
    max: 0.95,
    step: 0.01,
    hint: '内容占用超过「可用预算」的这个比例才开始提交。0.45 即 45%。可用预算 = 窗口 − system 提示词 − 工具 schema（它们恒占窗口、永不压缩，所以不进分母）。',
  },
  {
    key: 'targetRatio',
    group: '触发与目标',
    label: '目标线',
    type: 'ratio',
    min: 0.0001,
    max: 0.9,
    step: 0.01,
    hint: '提交做到可用预算的这个比例就停。必须小于触发线；材料不够时停在能到的位置。',
  },
  {
    key: 'distillMinRunRatio',
    group: '观察者',
    label: '单块分量',
    type: 'ratio',
    min: 0.00001,
    max: 0.5,
    step: 0.005,
    hint: '一次蒸馏（或一次合并）的材料量，占可用预算的比例。材料不足这份量就不动手；够了就切这么一块，剩下的原文留在表层等下一回合。0.05 即 5%。',
  },
  {
    key: 'retainRecentGroups',
    group: '观察者',
    label: '保留最近步数',
    type: 'int',
    min: 0,
    max: 200,
    step: 1,
    unit: '步',
    hint: '最近 N 个 step（一次模型请求 = 一步）永不进入蒸馏候选。按用户轮次算会把整段新对话都圈进保护区，所以按步算。0 表示不保护（仅调试用）。',
  },
  {
    key: 'observerMaxTokens',
    group: '观察者',
    label: '单块原文上限',
    type: 'int',
    min: 1000,
    max: 400000,
    step: 1000,
    unit: 'token',
    hint: '绝对保险丝：单块绝不会超过它。正常单块 = 可用预算的「单块分量」（5%），只有单个节点本身就超过分量时才会碰到它；也用来把分量封顶（设得比分量小就以它为准）。',
  },
  {
    key: 'observerTimeoutMs',
    group: '观察者',
    label: '蒸馏超时',
    type: 'int',
    min: 1000,
    max: 600000,
    step: 1000,
    unit: '毫秒',
    hint: '回合结束会等蒸馏完成再关会话；超过这个时间就放弃这一次，块不写入。',
  },
  {
    key: 'observerProvider',
    group: '观察者',
    label: '观察者 provider',
    type: 'select',
    source: 'provider',
    hint: '蒸馏用哪个 provider。留空跟随当前会话。',
  },
  {
    key: 'observerModel',
    group: '观察者',
    label: '观察者 model',
    type: 'select',
    source: 'model',
    pairKey: 'observerProvider',
    hint: '蒸馏用哪个模型。留空跟随当前会话；选了 provider 时只列出那个 provider 的模型。',
  },
  
  {
    key: 'observerConcurrency',
    group: '观察者',
    label: '并发蒸馏',
    type: 'int',
    min: 1,
    max: 16,
    step: 1,
    unit: '个',
    hint: '一次最多同时发起几个蒸馏。从最底层开始发名额，发满就停：低层有料就先蒸低层。',
  },
  {
    key: 'summaryPromptMode',
    group: '观察者',
    label: '蒸馏提示词',
    type: 'select',
    targetKey: 'summaryPrompt',
    options: [
      { value: 'host', label: '宿主（英文原文）' },
      { value: 'zh', label: '中文版（同结构）' },
      { value: 'custom', label: '自定义' },
    ],
    hint: '宿主：调用宿主的 summarize，用它的英文指令（默认，格式与宿主原生压缩一致）。中文版：同样的 8 段结构，正文改中文。自定义：用下面那段文本，自己发这次请求；改之前先切成自定义。',
  },
  {
    key: 'summaryPrompt',
    group: '观察者',
    label: '自定义蒸馏提示词',
    type: 'textarea',
    rows: 10,
    placeholder: '留空 = 用宿主英文原文',
    modeKey: 'summaryPromptMode',
    presetFor: { host: 'summaryHost', zh: 'summaryZh' },
    hint: '选了预设时这里只读显示那段预设的原文；切到「自定义」才可编辑。建议保留 8 个英文小节标题——它是「下一个模型能接手」的结构约定。',
  },
  {
    key: 'summaryMaxTokens',
    group: '观察者',
    label: '摘要输出上限',
    type: 'int',
    min: 0,
    max: 400000,
    step: 1000,
    unit: 'token',
    hint: '只管中文版 / 自定义档这一次请求的输出上限（宿主档仍用宿主自己的 65536）。它是防失控的保险丝，不是用来剪摘要的：正常摘要几 K 就停笔，200000 永远碰不到。调小会让摘要撞上限 → 这一块整块作废（宁可这次不压，也不拿半截摘要覆盖原文）。0 = 不传上限，交给适配器的默认值。',
  },
  {
    key: 'mergeMinBlocks',
    group: '塔',
    label: '合并块数下限',
    type: 'int',
    min: 2,
    max: 16,
    step: 1,
    unit: '个',
    hint: '一次合并至少要几个同层 checkpoint。真正决定「什么时候值得合并」的是材料总量要攒到可用预算的 5%（与蒸馏共用 distillMinRunRatio）；这个数只是下限。',
  },
  {
    key: 'exportKeepSessions',
    group: '塔',
    label: '导出目录保留',
    type: 'int',
    min: 1,
    max: 200,
    step: 1,
    unit: '个会话',
    hint: '解压内容落盘到 <项目>/.dsh/tower/ 时，只保留最近几个会话的目录。',
  },
  {
    key: 'inlineMaxRatio',
    group: '解压',
    label: '内联阈值',
    type: 'ratio',
    min: 0.001,
    max: 0.5,
    step: 0.005,
    hint: '解压内容小于窗口的这个比例就直接回给模型，否则写文件并给路径。',
  },
  {
    key: 'hardMaxTokens',
    group: '解压',
    label: '硬上限',
    type: 'int',
    min: 1000,
    max: 400000,
    step: 1000,
    unit: 'token',
    hint: '单次解压返回的绝对上限，超过就截断并说明。',
  },
  {
    key: 'advisorExpose',
    group: '顾问',
    label: '把 advisor 作为工具暴露',
    type: 'bool',
    hint: '关掉时模型看不到 advisor 工具，只有你能用 /advisor 手动调用。',
  },
  {
    key: 'advisorProvider',
    group: '顾问',
    label: '顾问 provider',
    type: 'select',
    source: 'provider',
    hint: '留空表示跟随当前会话的 provider。',
  },
  {
    key: 'advisorModel',
    group: '顾问',
    label: '顾问 model',
    type: 'select',
    source: 'model',
    pairKey: 'advisorProvider',
    hint: '留空表示跟随当前会话的 model；选了 provider 时只列出那个 provider 的模型。',
  },
  {
    key: 'advisorMaxTokens',
    group: '顾问',
    label: '顾问回答上限',
    type: 'int',
    min: 500,
    max: 400000,
    step: 1000,
    unit: 'token',
    hint: '保险丝，不是限制：顾问正常只答几 K，200000 碰不到；真碰到说明它在刷无效输出。个别 provider 会拒绝超过模型输出上限的 max_tokens，遇到报错就往回调。',
  },
  {
    key: 'advisorSystemMode',
    group: '顾问',
    label: '顾问人设',
    type: 'select',
    targetKey: 'advisorSystem',
    options: [
      { value: 'builtin', label: '内置预设' },
      { value: 'custom', label: '自定义' },
    ],
    hint: '内置：用插件自带的评审员人设（顾问没有「宿主版」可退）。自定义：用下面那段。',
  },
  {
    key: 'advisorSystem',
    group: '顾问',
    label: '自定义顾问人设',
    type: 'textarea',
    rows: 4,
    placeholder: '留空 = 用内置人设',
    modeKey: 'advisorSystemMode',
    presetFor: { builtin: 'advisorSystem' },
    hint: '选内置时只读显示内置人设；切到「自定义」才可编辑。',
  },
  {
    key: 'advisorPromptMode',
    group: '顾问',
    label: '顾问请求',
    type: 'select',
    targetKey: 'advisorPrompt',
    options: [
      { value: 'builtin', label: '内置预设' },
      { value: 'custom', label: '自定义' },
    ],
    hint: '内置：追加在会话末尾的那条请求（计划 / 纠正 / 叫停 三选一）。自定义：用下面那段。',
  },
  {
    key: 'advisorPrompt',
    group: '顾问',
    label: '自定义顾问请求',
    type: 'textarea',
    rows: 6,
    placeholder: '留空 = 用内置请求',
    modeKey: 'advisorPromptMode',
    presetFor: { builtin: 'advisorPrompt' },
    hint: '选内置时只读显示内置请求；切到「自定义」才可编辑。',
  },
]);

const KEYS = new Set(Object.keys(DEFAULTS));

/**
 * 校验并冻结配置。
 * @param {object} raw 宿主传入的原始配置（通常已经和用户覆盖合并过）。
 * @returns {object} 深冻结的配置。
 */
export function resolveConfig(raw = {}) {
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) {
      throw new Error(`tower: unknown config key "${key}" (allowed: ${[...KEYS].join(', ')})`);
    }
  }
  const resolved = { ...DEFAULTS, ...raw };
  if (!(resolved.targetRatio < resolved.triggerRatio)) {
    throw new Error(`tower: 目标线（${resolved.targetRatio}）必须小于触发线（${resolved.triggerRatio}）`);
  }
  if (!Number.isFinite(resolved.hardMaxTokens) || resolved.hardMaxTokens <= 0) {
    throw new Error(`tower: hardMaxTokens（${resolved.hardMaxTokens}）必须是正数`);
  }
  for (const field of FIELDS) {
    const value = resolved[field.key];
    if (field.type === 'int') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`tower: ${field.label}（${field.key}）必须是整数`);
      }
    }
    if (field.type === 'ratio' && (!Number.isFinite(value) || value <= 0 || value >= 1)) {
      throw new Error(`tower: ${field.label}（${field.key}）必须在 0 与 1 之间`);
    }
    if (typeof field.min === 'number' && value < field.min) {
      throw new Error(`tower: ${field.label}（${field.key}）不能小于 ${field.min}`);
    }
    if (typeof field.max === 'number' && value > field.max) {
      throw new Error(`tower: ${field.label}（${field.key}）不能大于 ${field.max}`);
    }
    if (field.type === 'bool' && typeof value !== 'boolean') {
      throw new Error(`tower: ${field.label}（${field.key}）必须是 true / false`);
    }
    if ((field.type === 'text' || field.type === 'select' || field.type === 'textarea') && typeof value !== 'string') {
      throw new Error(`tower: ${field.label}（${field.key}）必须是字符串`);
    }
    if (field.type === 'select' && Array.isArray(field.options) && !field.options.some((option) => option.value === value)) {
      throw new Error(`tower: ${field.label}（${field.key}）只能是 ${field.options.map((option) => option.value).join(' / ')}`);
    }
    if (field.type === 'textarea' && value.length > 100000) {
      throw new Error(`tower: ${field.label}（${field.key}）太长了（上限 100000 字符）`);
    }
  }
  return Object.freeze(resolved);
}

/** 只接受已知字段的补丁（配置界面用；未知键直接拒，别静默丢掉）。 */
export function pickPatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('tower: 配置补丁必须是一个对象');
  }
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KEYS.has(key)) throw new Error(`tower: 未知配置项 "${key}"`);
    patch[key] = value;
  }
  return patch;
}
