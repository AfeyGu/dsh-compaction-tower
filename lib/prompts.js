/**
 * 观察者的提示词。
 *
 * 三档：留空或选 host = 不接管，交给宿主的 `summarize` 用它自己的常量；
 * zh = 同一副骨架的中文版；custom = 用户自己写。
 */

/**
 * 宿主 `COMPACTION_INSTRUCTION` 的**展示副本**。
 *
 * 宿主的指令是包内常量、没有导出，插件拿不到正文；而界面上「选了宿主档就要能看见
 * 它写了什么」是要的。所以这里抄一份**只供展示**。真正执行时仍然是宿主的 summarize
 * 用它自己的常量 —— 这份副本即使落后于宿主版本，也只影响面板上显示的文字，
 * 不影响压缩结果。
 */
export const SUMMARY_PROMPT_HOST_DISPLAY = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n');

/**
 * 观察者的中文预设。
 *
 * 骨架与宿主 `COMPACTION_INSTRUCTION` 逐节对应（8 个英文小节标题一字不改），
 * 只把「用简洁英文写」换成「用简洁中文写」。不是另起炉灶：小节结构是「另一个模型
 * 能立刻接手」的保证，改骨架等于改协议。
 */
export const SUMMARY_PROMPT_ZH = [
  '你现在充当这个 AI 编码助手的压缩引擎。把上面的对话浓缩成一份结构化检查点，让另一个模型能在不丢失关键上下文的前提下接手这项工作。',
  '',
  '严格按下面的 Markdown 结构输出：保留每一节、保持顺序。使用简短的项目符号，不要写成段落。某一节为空就写 "(none)" —— 任何一节都不许删。',
  '',
  '## Primary Request and Intent',
  '- [用户最初的目标与不断演变的目标；措辞本身重要时逐字引用]',
  '',
  '## Key Technical Concepts',
  '- [涉及的技术、框架、模式与约定]',
  '',
  '## Files and Code',
  '- [精确路径：为什么重要、关键改动或代码片段]',
  '',
  '## Errors and Fixes',
  '- [错误：如何解决，以及相关的用户反馈]',
  '',
  '## Pending Jobs',
  '- [明确要求但尚未完成的工作]',
  '',
  '## Current Work',
  '- [到这一刻为止，正在做的事情到底是什么]',
  '',
  '## Next Step',
  '- [唯一的下一个动作，必须直接对齐最近一次请求；没有就写 "(none)"]',
  '',
  '## Critical Context',
  '- [决定及其理由、约束、用户偏好、未解的问题、继续推进所需的数据]',
  '',
  '规则：',
  '- 用简洁的中文技术叙述来写；上面 8 个小节标题保持英文原样，不要翻译或改写。',
  '- 精确保留文件路径、命令、错误原文、标识符、数值、函数签名与语法片段。',
  '- 忠实记录用户的反馈与明确指令，尤其是纠正。',
  '- 不要提及这次摘要请求，也不要提到上下文被压缩过。',
  '- 只输出检查点文本：不要调用任何工具，也不要做别的动作。',
  '- 如果对话里已经存在 <compacted-summary> 块，那是之前的检查点：不要原样照抄，保留仍然成立的事实、丢掉过期的，把新信息并进同一结构下的一份合并摘要。',
].join('\n');

/** 观察者提示词三档：留空/宿主 = 用宿主英文原文，zh = 中文预设，custom = 自己写。 */
export const SUMMARY_PROMPT_MODES = Object.freeze([
  { value: 'host', label: '宿主（英文原文）' },
  { value: 'zh', label: '中文版（同结构）' },
  { value: 'custom', label: '自定义' },
]);

/** 面板里只读展示用：预设名 → 正文。随 /tower/config 一起下发。 */
export const PROMPT_PRESETS = Object.freeze({
  summaryHost: SUMMARY_PROMPT_HOST_DISPLAY,
  summaryZh: SUMMARY_PROMPT_ZH,
});

/**
 * 这次蒸馏该用哪段指令。
 * @param {object} config 生效配置
 * @returns {string|null} null 表示「交给宿主的 summarize」，即不接管这次调用
 */
export function summaryInstruction(config) {
  if (config.summaryPromptMode === 'zh') return SUMMARY_PROMPT_ZH;
  if (config.summaryPromptMode === 'custom') {
    const text = String(config.summaryPrompt ?? '').trim();
    // 选了自定义却没写内容：退回宿主，别让蒸馏发一条空指令出去。
    return text.length === 0 ? null : text;
  }
  return null;
}
