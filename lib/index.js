/**
 * DSH Tower：分层压缩后端。
 *
 * 三件事：
 *   1. 补丁 dsh-compaction-basic 的两个扩展点（见 engine.js）；
 *   2. 回合结束后台蒸馏（观察者）；
 *   3. 注册 decompress / search_context 两个只读工具。
 *
 * 模型不参与压缩决策：没有 compress 工具，也没有提示它去压缩。
 *
 * 配置有三个来源，优先级从高到低：界面写入的覆盖层
 * （`<DSH_HOME>/storages/compaction-tower/config.json`）→ profile 条目里的
 * `config:`（cordis.patch.yml）→ DEFAULTS。见 config-store.js。
 */
import { Config } from './config.js';
import { ConfigStore } from './config-store.js';
import { enginePatched, installEnginePatches } from './engine.js';
import { registerTools } from './tools.js';
import { Tower } from './tower.js';

export const name = 'compaction-tower';

/** 没有这四样就什么都做不了：工具注册表、token 尺子、模型信息、会话落盘。 */
export const inject = ['tools', 'tokenMeter', 'llm', 'sessions'];

export { Config };

/**
 * 装载插件。
 * @param {object} ctx 宿主 context
 * @param {object} config 宿主传入的配置（profile 条目里写的那份）
 */
export function apply(ctx, config) {
  const store = new ConfigStore(config ?? {});
  const tower = new Tower(ctx, store.config);

  // 界面保存后立刻换值：Tower 所有读配置的地方都走 this.config，无需重启。
  store.onChange = (next) => {
    tower.updateConfig(next);
    if (process.env.TOWER_DEBUG === '1') console.error('tower[debug]: 配置已更新并生效');
  };
  if (store.loadProblem !== undefined) ctx.logger?.warn(`tower: ${store.loadProblem}`);

  const patch = installEnginePatches(tower);
  if (patch === 'unavailable') {
    ctx.logger?.warn('tower: dsh-compaction-basic 没有暴露 compactIfNeeded/summarize，跳过引擎补丁；压缩将完全交给宿主');
  } else if (patch === 'patched') {
    ctx.logger?.info('tower: 已接管 compaction-basic 的触发与摘要扩展点');
  }

  ctx.effect(function* registerTowerTools() {
    const dispose = registerTools(ctx, tower);
    yield () => dispose?.();
  }, 'compaction-tower tools');

  // 请求前：补一批观察（分层库存算法见 select.js 的 planObservation）。
  //
  // 这里**不等**它：发起即返回，块写进内存后由这次请求前后的持久化检查点落盘。
  // 所以它不会拖慢请求，只是让「下一次越线时手里有货」。
  ctx.on('agent/pre-step', ({ agent, signal, turn }, next) => {
    void tower.pump(agent, signal, turn, { wait: false });
    return next();
  });

  ctx.on('agent/turn-stopping', (payload) => {
    if (process.env.TOWER_DEBUG === '1') {
      console.error(`tower[debug]: turn-stopping fired, keys=${Object.keys(payload ?? {}).join(',')}, hasAgent=${Boolean(payload?.agent)}`);
    }
    // 故意返回 promise：宿主会等它再把回合关掉。回合结束立刻关会话，
    // 不等的话后台写进来的块落不了盘（详见 tower.js 的 observe）。
    return tower.observe(payload?.agent, payload?.turn, payload?.signal);
  });

  // `/advisor` 是可选能力：没装 dsh-commands 的 profile 照常工作，
  // 用子插件持有 inject，服务不在就整块不跑。
  ctx.plugin({
    name: 'compaction-tower-command',
    inject: ['commands'],
    async apply(commandCtx) {
      const { registerAdvisorCommand } = await import('./command.js');
      commandCtx.effect(function* registerAdvisor() {
        const dispose = registerAdvisorCommand(commandCtx, tower);
        yield () => dispose?.();
      }, 'compaction-tower /advisor');
    },
  });

  // Web 界面要用的状态与配置路由：只有 web 组合里有 webServer，其余 profile 整块不跑。
  ctx.plugin({
    name: 'compaction-tower-routes',
    inject: ['webServer', 'sessions', 'agents', 'llm'],
    async apply(webCtx) {
      if (process.env.TOWER_DEBUG === '1') console.error('tower[debug]: routes 子插件已激活');
      const { registerTowerRoutes } = await import('./server.js');
      webCtx.effect(function* registerRoutes() {
        let dispose;
        try {
          dispose = registerTowerRoutes(webCtx, { tower, store });
        } catch (error) {
          console.error(`tower: 注册 Web 路由失败：${error?.message ?? error}`);
          return;
        }
        if (process.env.TOWER_DEBUG === '1') {
          console.error('tower[debug]: 已注册 /tower/state、/tower/action、/tower/config');
        }
        yield () => dispose?.();
      }, 'compaction-tower routes');
    },
  });

  return tower;
}

/** 诊断用：补丁状态。 */
export { enginePatched };
