/**
 * 引擎补丁。
 *
 * DSH 的压缩后端 `dsh-compaction-basic` 挂在每个 preset 的隔离组里，
 * profile 的 patch 层按 id 打不到那些嵌套行（buildMap 只递归 group + 数组 config）。
 * 但它把两个扩展点挂在 `this` 上动态派发：
 *
 *   - `compactIfNeeded(agent, trigger, signal)` —— 什么时候压、压哪一段；
 *   - `summarize(input, agent, signal)`         —— 摘要从哪来。
 *
 * 两个方法都在调用点重新读 `this.xxx`（见 regionDependencies 的
 * `summarize: (input, owner, abort) => this.summarize(...)`），
 * 所以换原型方法等于换掉全部隔离实例的行为，且不需要动 preset。
 */
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';

/** 幂等标记：同一进程内重复加载不会叠加补丁。 */
const PATCHED = Symbol.for('dsh-compaction-tower.patched');

/**
 * 安装补丁。
 * @param {object} tower Tower 实例（提供 compactIfNeeded / serveSummary）
 * @returns {'patched'|'already'|'unavailable'}
 */
export function installEnginePatches(tower) {
  const proto = BasicCompactionEngine?.prototype;
  if (proto === undefined) return 'unavailable';
  if (typeof proto.compactIfNeeded !== 'function' || typeof proto.summarize !== 'function') return 'unavailable';
  if (proto[PATCHED] === true) return 'already';

  const originalSummarize = proto.summarize;

  proto.compactIfNeeded = function patchedCompactIfNeeded(agent, trigger, signal) {
    // 顺手记下「这个 agent 用的引擎实例」：某些组合（web）从 agent.ctx 取不到它。
    tower.rememberEngine?.(agent, this);
    // 不传原方法：塔不交回宿主，溢出也一样（见 Tower.compactIfNeeded）。
    return tower.compactIfNeeded(this, agent, trigger, signal);
  };
  proto.summarize = function patchedSummarize(input, agent, signal) {
    tower.rememberEngine?.(agent, this);
    return tower.serveSummary(this, originalSummarize, input, agent, signal);
  };

  Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  return 'patched';
}

/** 补丁是否已经装上（供诊断）。 */
export function enginePatched() {
  return BasicCompactionEngine?.prototype?.[PATCHED] === true;
}
