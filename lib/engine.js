/**
 * 引擎补丁。
 *
 * DSH 的压缩后端 `dsh-compaction-basic` 挂在每个 preset 的隔离组里，
 * profile 的 patch 层按 id 打不到那些嵌套行（buildMap 只递归 group + 数组 config）。
 * 但它把两个扩展点挂在 `this` 上动态派发：
 *
 *   - `compactIfNeeded(agent, trigger, signal)` —— 什么时候压、压哪一段；
 *   - `summarize(input, agent, signal)`         —— 摘要从哪来。
 *   - `compactNow(agent, signal, commandId)`    —— `/compact` 命令，绕过前者。
 *
 * 三个都在调用点重新读 `this.xxx`（见 regionDependencies 的
 * `summarize: (input, owner, abort) => this.summarize(...)`），
 * 所以换原型方法等于换掉全部隔离实例的行为，且不需要动 preset。
 */
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';

/** 幂等标记：同一进程内重复加载不会叠加补丁。 */
const PATCHED = Symbol.for('dsh-compaction-tower.patched');

/**
 * 补丁当前指向的实例，**存在原型上**。
 *
 * 不能存在模块级变量里：重新安装插件时 cordis 会重建插件模块，原型上的补丁还在
 * （`PATCHED` 标记挡住重复安装），但方法闭包捕获的是**旧模块**的变量 —— 新模块
 * 换自己的变量，旧闭包读不到，于是补丁永远捏着旧实例。表现就是面板上
 * 「内容越线了却没有任何判定」「观察者说引擎实例还没露面」。
 *
 * 原型的对象是共享的，把实例挂在它上面，任何一次 install 都能被旧闭包读到。
 */
const TOWER = Symbol.for('dsh-compaction-tower.tower');

/**
 * 安装补丁。
 * @param {object} tower Tower 实例（提供 compactIfNeeded / serveSummary / manualCompact）
 * @returns {'patched'|'already'|'unavailable'}
 */
export function installEnginePatches(tower) {
  const proto = BasicCompactionEngine?.prototype;
  if (proto === undefined) return 'unavailable';
  if (typeof proto.compactIfNeeded !== 'function' || typeof proto.summarize !== 'function') return 'unavailable';
  if (proto[PATCHED] === true) {
    // 已经打过补丁：只把原型上的引用换成新实例，方法体不动。
    proto[TOWER] = tower;
    return 'already';
  }

  const originalSummarize = proto.summarize;

  proto.compactIfNeeded = function patchedCompactIfNeeded(agent, trigger, signal) {
    const bound = proto[TOWER];
    if (bound === undefined || bound === null) return null;
    // 顺手记下「这个 agent 用的引擎实例」：某些组合（web）从 agent.ctx 取不到它。
    bound.rememberEngine?.(agent, this);
    // 不传原方法：塔不交回宿主，溢出也一样（见 Tower.compactIfNeeded）。
    return bound.compactIfNeeded(this, agent, trigger, signal);
  };
  proto.summarize = function patchedSummarize(input, agent, signal) {
    const bound = proto[TOWER];
    if (bound === undefined || bound === null) return originalSummarize.call(this, input, agent, signal);
    bound.rememberEngine?.(agent, this);
    return bound.serveSummary(this, originalSummarize, input, agent, signal);
  };
  // `/compact` 走的是 compactNow，它直接调 compactSurfaceRegion、绕过 compactIfNeeded。
  // 不接管的话，用户敲一次命令就会压出一个没有块号的 checkpoint，把账本打出洞。
  if (typeof proto.compactNow === 'function') {
    proto.compactNow = function patchedCompactNow(agent, signal, commandId) {
      const bound = proto[TOWER];
      if (bound === undefined || bound === null) return Promise.resolve(null);
      bound.rememberEngine?.(agent, this);
      return bound.manualCompact(this, agent, signal, commandId);
    };
  }

  Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  proto[TOWER] = tower;
  return 'patched';
}

/** 补丁是否已经装上（供诊断）。 */
export function enginePatched() {
  return BasicCompactionEngine?.prototype?.[PATCHED] === true;
}
