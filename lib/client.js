/**
 * Tower 的浏览器半侧：会话面板里的一个 tab，显示压缩状态并提供手动操作。
 *
 * 这个文件是**已构建产物**的形态（`window.__ModuleLoader__.load` + 惰性 factory），
 * 不是源码：DSH 的客户端插件必须这样声明，宿主才知道怎么把它装进页面。
 * 所以这里直接用 `React.createElement`，不依赖任何构建链。
 *
 * 数据来自宿主半侧的三条路由（同源，相对路径即可）：
 *   GET  /tower/state  → 快照
 *   POST /tower/action → 手动蒸馏 / 提交 / 合并
 *   GET  /tower/config · POST /tower/config → 配置读写
 *
 * 两个挂载点：会话里的 `conversation.view` tab（Tower），
 * 插件页里插件卡片下的配置表单（`plugins.bundle.config`，键是包名）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-compaction-tower',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;

    const NS = 'compaction-tower';
    const inject = ['slots'];
    const REFRESH_MS = 3000;

    // ── 样式：一次性注入，类名前缀避免与宿主冲突 ──────────────────────
    const STYLE_ID = 'dsh-compaction-tower-style';
    const CSS = [
      '.tw-root{display:flex;flex-direction:column;gap:14px;padding:14px 14px 180px;font-size:13px;line-height:1.5;color:inherit;overflow:auto;height:100%}',
      '.tw-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.tw-title{font-weight:600;font-size:14px}',
      '.tw-muted{opacity:.62}',
      '.tw-statline{font-size:11px;opacity:.6;display:flex;gap:14px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid rgba(127,127,127,.18)}',
      '.tw-btn{border:1px solid rgba(127,127,127,.38);background:transparent;color:inherit;border-radius:7px;padding:4px 11px;font-size:12.5px;cursor:pointer}',
      '.tw-btn:hover:not(:disabled){background:rgba(127,127,127,.14)}',
      '.tw-btn:active:not(:disabled){transform:translateY(1px)}',
      '.tw-btn:disabled{opacity:.42;cursor:not-allowed}',
      '.tw-btn-primary{border-color:transparent;background:rgba(64,150,255,.92);color:#fff;font-weight:600}',
      '.tw-btn-primary:hover:not(:disabled){background:rgba(64,150,255,1)}',
      '.tw-card{border:1px solid rgba(127,127,127,.24);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.tw-card-title{font-weight:600;font-size:12.5px;letter-spacing:.02em;opacity:.85;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}',
      // 占用读数行：徽章（状态）+ 内容/可用/固定（口径数字）。
      '.tw-readout{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;font-size:12.5px}',
      '.tw-badge{font-size:11.5px;font-weight:600;padding:1px 9px;border-radius:999px;border:1px solid transparent;flex:none}',
      '.tw-badge-calm{color:rgba(64,150,255,.95);border-color:rgba(64,150,255,.4);background:rgba(64,150,255,.1)}',
      '.tw-badge-hot{color:#e05555;border-color:rgba(224,85,85,.45);background:rgba(224,85,85,.1)}',
      // 压力计：平面纯色 + 顶部 1px 内嵌亮线（现代用量条的做法，不做大跨度渐变）；
      // 段类名沿用旧名（tw-bar-real 等），语义不变：实心（已用）→ 斜纹（当前→触发）→ 灰刻度（触发之后，到不了）。
      // 颜色跨浅色/深色主题都能读：填充用中明度 hex，中性段用 rgba 半透明。
      '.tw-gauge{position:relative;height:20px;border-radius:6px;background:rgba(127,127,127,.14);overflow:hidden;border:1px solid rgba(127,127,127,.18)}',
      '.tw-bar-fixed{position:absolute;left:0;top:0;bottom:0;background:#15181c;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.08) 0 3px,transparent 3px 8px)}',
      '.tw-bar-real{position:absolute;top:0;bottom:0;background:#4d8fd6;box-shadow:inset 0 1px 0 rgba(255,255,255,.22);transition:width .5s cubic-bezier(.2,.7,.2,1),left .5s cubic-bezier(.2,.7,.2,1)}',
      // 越过触发线之后多出来的那一截：朱红，一眼看出「已经越界、下次请求就会压」。
      '.tw-bar-over{position:absolute;top:0;bottom:0;background:#d65548;box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}',
      '.tw-bar-stripes{position:absolute;top:0;bottom:0;background-color:rgba(64,150,255,.05);background-image:repeating-linear-gradient(135deg,rgba(64,150,255,.16) 0 3px,transparent 3px 8px);transition:left .5s cubic-bezier(.2,.7,.2,1),width .5s cubic-bezier(.2,.7,.2,1)}',
      '.tw-bar-dead{position:absolute;top:0;bottom:0;right:0;background:repeating-linear-gradient(90deg,transparent 0 26px,rgba(127,127,127,.14) 26px 27px)}',
      // 刻度线：触发线（琥珀，换班哨）与目标线（绿虚线，落点）。越线本身由朱红段表达，不靠线的颜色。
      '.tw-tick{position:absolute;top:-3px;bottom:-3px;width:0}',
      '.tw-tick-trigger{width:2px;background:#d99b35}',
      '.tw-tick-target{width:2px;background:repeating-linear-gradient(180deg,#4ea87a 0 5px,transparent 5px 10px)}',
      '.tw-axis{position:relative;height:16px;font-size:11px;opacity:.7}',
      '.tw-axis>span{position:absolute;top:1px;white-space:nowrap}',
      '.tw-axis-0{left:0}',
      '.tw-axis-window{right:0;opacity:.7}',
      '.tw-axis-mid{transform:translateX(-50%)}',
      // 判定读数：一行一判定，回答「为什么没动」。
      '.tw-verdicts{display:flex;flex-direction:column}',
      '.tw-verdict{display:grid;grid-template-columns:88px 1fr;gap:10px;align-items:baseline;padding:7px 0;font-size:12.5px}',
      '.tw-verdict+.tw-verdict{border-top:1px dashed rgba(127,127,127,.18)}',
      '.tw-v-label{opacity:.55;font-weight:600;font-size:12px}',
      '.tw-v-text{opacity:.85}',
      '.tw-verdict.hot .tw-v-text{color:#e05555;opacity:1}',
      // 组装芯片与层标签：同族色阶（T1 青 → T4 紫）编码「越老越粗」，文字色继承宿主主题。
      '.tw-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
      '.tw-chip-raw{display:inline-block;padding:0 8px;border-radius:5px;font-size:11px;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08)}',
      '.tw-tag{display:inline-block;padding:0 6px;border-radius:5px;font-size:11px;border:1px solid transparent;font-weight:600}',
      '.tw-tag-t1{background:rgba(95,190,205,.15);border-color:rgba(95,190,205,.35)}',
      '.tw-tag-t2{background:rgba(80,140,220,.15);border-color:rgba(80,140,220,.35)}',
      '.tw-tag-t3{background:rgba(120,130,225,.15);border-color:rgba(120,130,225,.35)}',
      '.tw-tag-t4{background:rgba(150,110,225,.15);border-color:rgba(150,110,225,.35)}',
      '.tw-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.tw-table-wrap{max-height:38vh;overflow:auto;border-radius:8px;border:1px solid rgba(127,127,127,.14)}',
      '.tw-table th{text-align:left;font-weight:600;opacity:.6;padding:5px 8px;border-bottom:1px solid rgba(127,127,127,.24)}',
      '.tw-table td{padding:5px 8px;border-bottom:1px solid rgba(127,127,127,.12);vertical-align:top}',
      '.tw-num{text-align:right;white-space:nowrap}',
      '.tw-row{cursor:pointer}',
      '.tw-row:hover{background:rgba(127,127,127,.09)}',
      '.tw-row-selected{background:rgba(64,150,255,.13)}',
      '.tw-row-consumed td:not(:first-child){opacity:.55}',
      '.tw-row-consumed td:first-child{opacity:.85}',
      // 正在总结的块：斜纹微光扫过，让人知道后台在干活；文字仍是「总结中」。
      '.tw-row-ghost{cursor:default;opacity:.75;font-style:italic;background-image:linear-gradient(100deg,transparent 30%,rgba(64,150,255,.08) 50%,transparent 70%);background-size:220% 100%;animation:tw-shimmer 2.4s linear infinite}',
      '@keyframes tw-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}',
      '.tw-chev{display:inline-block;width:0;height:0;margin-left:6px;border:3.5px solid transparent;border-top-color:currentColor;opacity:.45;border-bottom-width:0;vertical-align:1px;transition:transform .15s}',
      '.tw-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:11.5px;opacity:.85}',
      '.tw-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.tw-dot-committed{background:#2f8f5b}',
      '.tw-dot-dormant{background:transparent;border:1.5px solid rgba(64,150,255,.8)}',
      '.tw-dot-consumed{background:rgba(127,127,127,.55)}',
      '.tw-dot-inflight{background:rgba(64,150,255,.9);animation:tw-pulse 1.2s ease-in-out infinite}',
      '@keyframes tw-pulse{50%{opacity:.25}}',
      '.tw-summary{white-space:pre-wrap;font-family:inherit;font-size:12px;opacity:.86;background:rgba(127,127,127,.08);border-radius:6px;padding:8px 10px;margin-top:4px}',
      '.tw-sum-t1{border-left:2px solid rgba(95,190,205,.8)}',
      '.tw-sum-t2{border-left:2px solid rgba(80,140,220,.8)}',
      '.tw-sum-t3{border-left:2px solid rgba(120,130,225,.8)}',
      '.tw-sum-t4{border-left:2px solid rgba(150,110,225,.8)}',
      // 塔结构：层级引线 + 同款层标签，块的家谱。
      '.tw-tree{list-style:none;margin:0;padding-left:2px;max-height:30vh;overflow:auto;font-size:12px}',
      '.tw-tree ul{list-style:none;margin:0;padding:0}',
      '.tw-tree ul ul{margin-left:14px;padding-left:14px;border-left:1px solid rgba(127,127,127,.2)}',
      '.tw-tree li{padding:3px 0}',
      '.tw-tree li.tw-tree-child::before{content:"";display:inline-block;width:8px;height:1px;background:rgba(127,127,127,.35);vertical-align:4px;margin-left:-14px;margin-right:6px}',
      '.tw-tree .tw-node{display:inline-flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      // 视图切换：列表 ⟷ 塔结构，同一份数据的两个镜头。
      '.tw-viewseg{display:inline-flex;border:1px solid rgba(127,127,127,.38);border-radius:7px;overflow:hidden;font-size:11.5px}',
      '.tw-viewseg button{border:0;background:transparent;color:inherit;opacity:.6;padding:3px 10px;cursor:pointer}',
      '.tw-viewseg button+button{border-left:1px solid rgba(127,127,127,.24)}',
      '.tw-viewseg button[aria-pressed="true"]{background:rgba(127,127,127,.14);opacity:1;font-weight:600}',
      '.tw-err{color:#e05555;font-size:12px}',
      '.tw-note{color:#2f8f5b;font-size:12px}',
      '.tw-empty{opacity:.55;font-size:12px}',
      '@media (prefers-reduced-motion:reduce){.tw-row-ghost,.tw-dot-inflight{animation:none}.tw-bar-real,.tw-bar-stripes{transition:none}}',
      // 配置表单
      '.tw-cfg{display:flex;flex-direction:column;gap:12px;font-size:13px}',
      '.tw-cfg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.tw-cfg-path{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.55;word-break:break-all}',
      '.tw-cfg-group{border:1px solid rgba(127,127,127,.24);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
      '.tw-cfg-group-title{font-weight:600;font-size:12px;opacity:.82}',
      '.tw-cfg-field{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:4px 12px;align-items:start}',
      '.tw-cfg-label{font-weight:500;padding-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.tw-cfg-body{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.tw-cfg-input{border:1px solid rgba(127,127,127,.38);background:transparent;color:inherit;border-radius:6px;padding:3px 7px;font-size:12px;font-family:inherit;width:150px;max-width:100%}',
      '.tw-cfg-input-wide{width:100%}',
      '.tw-cfg-select{width:auto;min-width:220px}',
      '.tw-cfg-textarea{width:100%;min-height:96px;resize:vertical;line-height:1.5;font-family:var(--ui-mono,ui-monospace,Consolas,monospace);padding:6px 8px}',
      '.tw-cfg-readonly{background:rgba(127,127,127,.07);cursor:default}',
      '.tw-cfg-hint{font-size:11px;opacity:.62}',
      '.tw-cfg-badge{font-size:10px;padding:0 4px;border-radius:3px;background:rgba(64,150,255,.18);border:1px solid rgba(64,150,255,.3)}',
      '.tw-cfg-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    ].join('\n');

    function ensureStyle() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) return () => {};
      const node = document.createElement('style');
      node.id = STYLE_ID;
      node.textContent = CSS;
      document.head.appendChild(node);
      return () => node.remove();
    }

    // ── 数据 ────────────────────────────────────────────────────────────
    async function loadState(sessionId) {
      const query = sessionId === null ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
      const response = await fetch(`/tower/state${query}`, { headers: { accept: 'application/json' } });
      const body = await response.json();
      if (body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    async function runAction(action) {
      const response = await fetch('/tower/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
      });
      const body = await response.json();
      if (body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    async function loadConfig() {
      const response = await fetch('/tower/config', { headers: { accept: 'application/json' } });
      const body = await response.json();
      if (body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    async function writeConfig(payload) {
      const response = await fetch('/tower/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    // ── 小工具 ──────────────────────────────────────────────────────────
    function fmt(tokens) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—';
      if (tokens < 1000) return String(Math.round(tokens));
      if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
      return `${(tokens / 1000000).toFixed(1)}M`;
    }

    /** 比例转百分比：小值保留有效位，别把 0.00001 显示成 0%。 */
    function formatPercent(ratio) {
      const percent = ratio * 100;
      if (percent === 0) return '0%';
      if (percent < 0.01) return `${percent.toFixed(3)}%`;
      if (percent < 1) return `${percent.toFixed(2)}%`;
      return `${Math.round(percent * 10) / 10}%`;
    }

    function tierTag(tier) {
      return h('span', { className: `tw-tag tw-tag-t${Math.min(tier, 4)}` }, `T${tier}`);
    }

    function statusLabel(status) {
      if (status === 'committed') return '已进入上下文';
      if (status === 'consumed') return '已并入上层';
      return '待提交';
    }

    /**
     * 上下文占用：一条压力计 + 一根刻度轴，两种状态。
     *
     * 轴仍然是整个窗口。实心（钢青，平面纯色 + 顶部 1px 微高光）= 内容；最前面那截
     * 深色 hatch = 永远压不掉的固定开销；斜纹 = 当前到触发线之间还能涨的空间；
     * 灰刻度 = 触发线之后（到不了）。触发线/目标线按内容算，画在 fixed + 阈值 的位置上。
     *
     * 已越线（当前 > 触发线）：实心被触发线截断，越出去的一截染朱红（下次请求就会压缩），
     * 斜纹宽度本来就归零，所以换「朱红一截」表达，而不是让条上凭空少一段。
     * 触发线本身是琥珀色「换班哨」——越线不是故障，是机器该转了；朱红只表示真的越界。
     */
    /**
     * 上一次压力判定翻译成一句人话 —— 面板上直接回答「为什么没压」。
     * @param {object|null} pressure
     * @returns {string}
     */
    function describePressure(pressure) {
      if (pressure === null || pressure === undefined) return '上次判定：还没跑过';
      const text = (value) => (value === null || value === undefined ? '?' : fmt(value));
      const times = pressure.calls === null || pressure.calls === undefined ? '' : `（第 ${pressure.calls} 次判定）`;
      switch (pressure.kind) {
        case 'below-trigger':
          return `上次判定：未到触发线（内容 ${text(pressure.content ?? pressure.total)} / ${text(pressure.trigger)}）${times}`;
        case 'no-window':
          return '上次判定：量不到上下文窗口，这次不压';
        case 'no-range':
          return '上次判定：可压区为空（老材料都在保护区里，或已经进了块）';
        case 'no-block':
          return `上次判定：没有可提交的块（账本 ${pressure.blocks ?? 0} 块，可压区 ${pressure.run ?? 0} 条）`;
        case 'commit': {
          // 关键：这里要报「实际成功几块」，只报计划会让人以为已经压下去了。
          const outcome = pressure.outcome;
          if (outcome !== null && outcome !== undefined) {
            if (outcome.succeeded === 0) {
              return `上次判定：计划提交 ${outcome.planned} 块，实际 0 块（${outcome.error ?? 'compactRegion 返回空'}）`;
            }
            return `上次判定：提交 ${outcome.succeeded}/${outcome.planned} 块${outcome.error === null || outcome.error === undefined ? '' : `，中途失败：${outcome.error}`}`;
          }
          return `上次判定：计划提交 ${pressure.blockCount ?? 0} 块（${(pressure.blockIds ?? []).join(' ')}）${pressure.projected === null || pressure.projected === undefined ? '' : ` → ${fmt(pressure.projected)}`}`;
        }
        default:
          return `上次判定：${pressure.kind ?? '未知'}`;
      }
    }


    /**
     * 上一次观察判定翻译成一句人话 —— 面板上回答「为什么没蒸」。
     * @param {object|null} observation
     * @param {object} budget
     * @returns {string}
     */
    function describeObservation(observation, budget) {
      if (observation === null || observation === undefined) return '上次观察：还没跑过';
      switch (observation.kind) {
        case 'no-material':
          return `上次观察：没有可总结的材料（不够一个单位 ${fmt(observation.unit ?? 0)} tok，或已经进了块）`;
        case 'stocked':
          return '上次观察：库存已够，先不总结（防浪费）';
        case 'no-quota':
          return '上次观察：并发名额已被排在前面的层占满';
        case 'no-engine':
          // 进程刚起来时宿主还没调过一次 compactIfNeeded，引擎实例自然还没露面；
          // 第一次请求走完就有了。这是启动瞬间的正常状态，不是故障。
          return '上次观察：等首次请求（引擎实例还没露面）';
        case 'no-window':
          return '上次观察：量不到上下文窗口';
        case 'launched': {
          const jobs = (observation.plan ?? []).map((job) => `T${(job.level ?? 0) + 1}×${job.count}`).join(' ');
          const planned = (observation.plan ?? []).reduce((sum, job) => sum + job.count, 0);
          const material = (observation.available ?? []).reduce((sum, item) => sum + (item[1] ?? 0), 0);
          // 发起数少于计划时，多半是材料只够这么多份 —— 直接说出来，省得以为并发没生效。
          const short = material > 0 && material <= planned ? ` · 材料只够 ${material} 份` : '';
          const budget = typeof observation.target === 'number'
            ? `，目标 ${fmt(observation.target)} 还差 ${fmt(observation.need ?? 0)}`
            : '';
          return `上次观察：发起 ${jobs || '一批'}（单位 ${observation.unit ?? '?'} tok${budget}）${short}`;
        }
        default:
          return `上次观察：${observation.kind ?? '未知'}`;
      }
    }

    /**
     * 「当前组装」的芯片：上下文此刻由什么拼成。
     *
     * 只报表层上的东西：已提交的块按层计数，其余（还没被压掉的消息）算原文；
     * 待提交的块不在上下文里，不算。块号不写进来 —— 列表点一下就有，
     * 这一行的任务是回答「谁占得多」，不是「具体是哪一块」。
     * @param {{tiers?: Array<{tier:number,count:number}>, raw?: number}|null} composition
     * @returns {Array<object>}
     */
    function compositionChips(composition) {
      const tiers = composition?.tiers ?? [];
      const raw = Number(composition?.raw ?? 0);
      const nodes = tiers.map((item) => h('span', {
        key: `t${item.tier}`,
        className: `tw-tag tw-tag-t${Math.min(item.tier, 4)}`,
      }, `T${item.tier} ×${item.count}`));
      if (raw > 0) nodes.push(h('span', { key: 'raw', className: 'tw-chip-raw' }, `原文 ×${raw}`));
      return nodes;
    }

    function UsageBar({ budget, pressure, observation, composition }) {
      const limit = budget.contextWindow;
      if (typeof limit !== 'number' || limit <= 0) {
        return h('div', { className: 'tw-empty' }, '拿不到模型上下文窗口');
      }
      // 轴仍然是整个窗口：最前面那截黑色是永远压不掉的固定开销（system + 工具 schema），
      // 后面的实心才是「内容」。触发线按内容算，所以画在 fixed + trigger 的位置上。
      const fixed = typeof budget.fixed?.total === 'number' ? budget.fixed.total : 0;
      const content = typeof budget.content === 'number' ? budget.content : budget.total;
      const usable = typeof budget.usable === 'number' ? budget.usable : Math.max(1, limit - fixed);
      const used = Math.min(limit, fixed + content);
      const percent = Math.min(100, (used / limit) * 100);
      const fixedPct = Math.max(0, Math.min(100, (fixed / limit) * 100));
      const triggerAt = typeof budget.triggerTokens === 'number' ? fixed + budget.triggerTokens : null;
      const trigger = triggerAt === null ? null : Math.min(100, (triggerAt / limit) * 100);
      const targetAt = typeof budget.targetTokens === 'number' ? fixed + budget.targetTokens : null;
      const target = targetAt === null ? null : Math.min(100, (targetAt / limit) * 100);
      const over = trigger !== null && percent > trigger;
      const bandFrom = trigger === null ? percent : Math.min(percent, trigger);
      const bandWidth = over || trigger === null ? 0 : Math.max(0, trigger - bandFrom);
      const solid = over ? Math.max(0, trigger - fixedPct) : Math.max(0, percent - fixedPct);
      // 徽章：一眼读出「离危险多远」；数字在轴标签上，这里不重复。
      const badge = trigger === null ? null : over
        ? h('span', { key: 'badge', className: 'tw-badge tw-badge-hot' }, `已越过触发线 ${fmt(Math.max(0, content - budget.triggerTokens))}`)
        : h('span', { key: 'badge', className: 'tw-badge tw-badge-calm' }, `未越线 · 余量 ${fmt(Math.max(0, budget.triggerTokens - content))}`);
      const hot = pressure?.kind === 'commit' && (pressure?.outcome === null || pressure?.outcome === undefined);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
        h('div', { key: 'readout', className: 'tw-readout' }, [
          badge,
          h('span', { key: 'now' }, fixed > 0
            ? `内容 ${fmt(content)} / 可用 ${fmt(usable)} · 固定 ${fmt(fixed)}`
            : `内容 ${fmt(content)} / 可用 ${fmt(usable)}`),
        ]),
        h('div', { key: 'bar', className: 'tw-gauge' }, [
          fixedPct <= 0 ? null : h('div', {
            key: 'fixed',
            className: 'tw-bar-fixed',
            style: { width: `${fixedPct}%` },
          }),
          trigger === null ? null : h('div', {
            key: 'dead',
            className: 'tw-bar-dead',
            style: { left: `${over ? percent : trigger}%` },
          }),
          bandWidth <= 0 ? null : h('div', {
            key: 'stripes',
            className: 'tw-bar-stripes',
            style: { left: `${bandFrom}%`, width: `${bandWidth}%` },
          }),
          h('div', {
            key: 'real',
            className: 'tw-bar-real',
            style: { left: `${fixedPct}%`, width: `${solid}%` },
          }),
          over ? h('div', {
            key: 'over',
            className: 'tw-bar-over',
            style: { left: `${trigger}%`, width: `${percent - trigger}%` },
          }) : null,
          trigger === null ? null : h('div', {
            key: 'tick-trigger',
            className: 'tw-tick tw-tick-trigger',
            style: { left: `${trigger}%` },
          }),
          target === null ? null : h('div', {
            key: 'tick-target',
            className: 'tw-tick tw-tick-target',
            style: { left: `${target}%` },
          }),
        ]),
        h('div', { key: 'axis', className: 'tw-axis' }, [
          h('span', { key: 'z', className: 'tw-axis-0' }, '0'),
          target === null ? null : h('span', {
            key: 't',
            className: 'tw-axis-mid',
            style: { left: `${target}%` },
          }, `目标线 ${fmt(budget.targetTokens)}（内容）`),
          trigger === null ? null : h('span', {
            key: 'g',
            className: 'tw-axis-mid',
            style: { left: `${trigger}%` },
          }, `触发线 ${fmt(budget.triggerTokens)}（内容）`),
          h('span', { key: 'w', className: 'tw-axis-window' }, `窗口 ${fmt(limit)}`),
        ]),
        h('div', { key: 'verdicts', className: 'tw-verdicts' }, [
          h('div', { key: 'assembly', className: 'tw-verdict' }, [
            h('span', { key: 'l', className: 'tw-v-label' }, '当前组装'),
            h('span', { key: 'c', className: 'tw-chips' }, compositionChips(composition)),
          ]),
          h('div', { key: 'pressure', className: `tw-verdict${hot ? ' hot' : ''}` }, [
            h('span', { key: 'l', className: 'tw-v-label' }, '上次判定'),
            h('span', { key: 't', className: 'tw-v-text' }, describePressure(pressure)),
          ]),
          h('div', { key: 'observer', className: 'tw-verdict' }, [
            h('span', { key: 'l', className: 'tw-v-label' }, '上次观察'),
            h('span', { key: 't', className: 'tw-v-text' }, describeObservation(observation, budget)),
          ]),
        ]),
      ]);
    }

    function BlockRows({ block, selected, onToggle }) {
      const [open, setOpen] = React.useState(false);
      return h(Fragment, null, [
        h('tr', {
          key: `${block.blockId}-row`,
          className: `tw-row${selected ? ' tw-row-selected' : ''}${block.status === 'consumed' ? ' tw-row-consumed' : ''}`,
          onClick: () => setOpen(!open),
        }, [
          h('td', {
            key: 'sel',
            onClick: (event) => { event.stopPropagation(); onToggle(block); },
          }, h('input', {
            type: 'checkbox',
            checked: selected,
            'aria-label': `选择 ${block.blockId}`,
            onChange: () => {},
          })),
          h('td', { key: 'id' }, [
            h('code', { key: 'c' }, block.blockId),
            h('span', { key: 'chev', className: 'tw-chev' }),
          ]),
          h('td', { key: 'tier' }, tierTag(block.tier)),
          h('td', { key: 'cover' }, `${block.covers.length} 条`),
          h('td', { key: 'size', className: 'tw-num' }, `${block.coveredLabel} → ${block.summaryLabel}`),
          h('td', { key: 'status' }, h('span', { className: 'tw-status' }, [
            h('span', { key: 'd', className: `tw-dot tw-dot-${block.status}` }),
            statusLabel(block.status),
          ])),
        ]),
        open
          ? h('tr', { key: `${block.blockId}-body` }, h('td', { colSpan: 6, style: { padding: 0 } },
            h('div', { className: `tw-summary tw-sum-t${Math.min(block.tier, 4)}` }, block.summary)))
          : null,
      ]);
    }

    function TreeView({ blocks }) {
      if (blocks.length === 0) return h('div', { className: 'tw-empty' }, '空');
      const byId = new Map(blocks.map((block) => [block.blockId, block]));
      const childIds = new Set();
      for (const block of blocks) for (const id of block.childBlockIds ?? []) childIds.add(id);
      const roots = blocks.filter((block) => !childIds.has(block.blockId));
      // 塔是自下而上合并出来的：一个块的 children 就是它合并掉的那些块。
      const childrenOf = (block) => (block.childBlockIds ?? [])
        .map((id) => byId.get(id))
        .filter((child) => child !== undefined);
      const render = (block) => {
        const kids = childrenOf(block);
        return h('li', {
          key: `${block.blockId}-${block.tier}`,
          className: childIds.has(block.blockId) ? 'tw-tree-child' : '',
        }, [
          h('span', { key: 'node', className: `tw-node${block.status === 'consumed' ? ' tw-muted' : ''}` }, [
            h('code', { key: 'id' }, block.blockId),
            ' ',
            tierTag(block.tier),
            h('span', { key: 'meta', className: 'tw-muted' }, ` ${block.covers.length} 条 · ${block.coveredLabel} → ${block.summaryLabel}`),
            h('span', { key: 'dot', className: `tw-dot tw-dot-${block.status}`, style: { alignSelf: 'center' } }),
          ]),
          kids.length === 0 ? null : h('ul', { key: 'kids' }, kids.map((child) => render(child))),
        ]);
      };
      return h('ul', { className: 'tw-tree' }, roots.map((block) => render(block)));
    }

    /**
     * 渲染兜底。
     *
     * 面板里任何一处抛错，都变成一段可读的错误文本，而不是整块空白 ——
     * 空白既查不出原因，也看不出是哪一层坏掉的。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        const { error } = this.state;
        if (error !== null && error !== undefined) {
          return h('div', { className: 'tw-root' }, [
            h('div', { key: 'h', className: 'tw-err' }, `压缩面板渲染失败：${error?.message ?? String(error)}`),
            h('pre', { key: 's', className: 'tw-summary', style: { whiteSpace: 'pre-wrap', fontSize: 11 } }, String(error?.stack ?? '').slice(0, 1500)),
          ]);
        }
        return this.props?.children ?? null;
      }
    }

    function SafeTowerView(props) {
      return h(PanelBoundary, null, h(TowerView, props));
    }

    function SafeConfigPanel(props) {
      return h(PanelBoundary, null, h(ConfigPanel, props));
    }

    function Panel({ state, selected, toggle, onAction, busy, error, note, showConfig, onToggleConfig, view, onView }) {
      const blocks = state.blocks ?? [];
      const inflight = state.inflight ?? [];
      const chosen = blocks.filter((block) => selected.has(block.blockId));
      const canMerge = chosen.length >= 2
        && new Set(chosen.map((block) => block.tier)).size === 1
        && chosen.every((block) => block.status === 'committed');
      const stats = state.stats ?? {};
      const countOf = (status) => blocks.filter((b) => b.status === status).length;

      const tableView = blocks.length === 0 && inflight.length === 0
        ? h('div', { key: 'empty', className: 'tw-empty' }, '还没有块。回合结束后会自动总结，也可以点「立即总结」。')
        : h('div', { key: 'wrap', className: 'tw-table-wrap' }, h('table', { className: 'tw-table' }, [
          h('thead', { key: 'thead' }, h('tr', null, [
            h('th', { key: 'sel', style: { width: 26 } }, ''),
            h('th', { key: 'id' }, '块号'),
            h('th', { key: 'tier' }, '层'),
            h('th', { key: 'cover' }, '覆盖'),
            h('th', { key: 'size', style: { textAlign: 'right' } }, '原 → 摘要'),
            h('th', { key: 'status' }, '状态'),
          ])),
          h('tbody', { key: 'tbody' }, [
            ...blocks.map((block) => h(BlockRows, {
              key: block.blockId,
              block,
              selected: selected.has(block.blockId),
              onToggle: toggle,
            })),
            // 正在总结的块：块号在派发时就定了，所以这里画得出来。虚线行、不可选、不可提交。
            ...inflight.map((item) => h('tr', { key: `ghost-${item.blockId}`, className: 'tw-row tw-row-ghost' }, [
              h('td', { key: 'sel' }, '·'),
              h('td', { key: 'id' }, h('code', null, item.blockId)),
              h('td', { key: 'tier' }, tierTag(item.tier)),
              h('td', { key: 'cover' }, `${item.count} 条`),
              h('td', { key: 'size', className: 'tw-num' }, `${item.coveredLabel} → 总结中…`),
              h('td', { key: 'status' }, h('span', { className: 'tw-status' }, [
                h('span', { key: 'd', className: 'tw-dot tw-dot-inflight' }),
                '总结中',
              ])),
            ])),
          ]),
        ]));

      const body = [
        h('div', { key: 'usage', className: 'tw-card' }, [
          h('div', { key: 'title', className: 'tw-card-title' }, '上下文占用'),
          h(UsageBar, { key: 'bar', budget: state.budget ?? {}, pressure: state.pressure ?? null, observation: state.observation ?? null, composition: state.composition ?? null }),
        ]),

        h('div', { key: 'blocks', className: 'tw-card' }, [
          h('div', { key: 'title', className: 'tw-card-title' }, [
            h('span', { key: 'a' }, `块（${blocks.length}）`),
            h('span', { key: 'b', className: 'tw-muted' },
              `已进入 ${countOf('committed')} · 已并入 ${countOf('consumed')} · 待提交 ${countOf('dormant')}${inflight.length > 0 ? ` · 总结中 ${inflight.length}` : ''}`),
            h('span', { key: 'sp', style: { flex: 1 } }),
            h('div', { key: 'seg', className: 'tw-viewseg' }, [
              h('button', { key: 'list', type: 'button', 'aria-pressed': view === 'list', onClick: () => onView('list') }, '列表'),
              h('button', { key: 'tree', type: 'button', 'aria-pressed': view === 'tree', onClick: () => onView('tree') }, '塔结构'),
            ]),
          ]),
          view === 'tree' ? h(TreeView, { key: 'tree', blocks }) : tableView,
        ]),
      ];

      return h('div', { className: 'tw-root' }, [
        h('div', { key: 'head', className: 'tw-head' }, [
          h('span', { key: 't', className: 'tw-title' }, showConfig ? '压缩参数' : '压缩记录'),
          h('span', { key: 's', className: 'tw-muted' }, showConfig ? '' : (state.session?.id ?? '')),
          h('span', { key: 'sp', style: { flex: 1 } }),
          showConfig ? null : h('button', { key: 'distill', className: 'tw-btn', disabled: busy, onClick: () => onAction({ kind: 'distill' }) }, '立即总结'),
          showConfig ? null : h('button', { key: 'commit', className: 'tw-btn', disabled: busy, onClick: () => onAction({ kind: 'commit' }) }, '立即提交'),
          showConfig ? null : h('button', {
            key: 'merge',
            className: 'tw-btn',
            disabled: busy || !canMerge,
            title: canMerge ? '' : '勾选两个同层且已进入上下文的块',
            onClick: () => onAction({ kind: 'merge', blockIds: chosen.map((block) => block.blockId) }),
          }, '合并选中'),
          h('button', {
            key: 'config',
            className: 'tw-btn',
            title: showConfig ? '回到压缩记录' : '打开压缩参数',
            onClick: () => onToggleConfig(),
          }, showConfig ? '返回' : '设置'),
        ]),
        showConfig ? null : h('div', { key: 'statline', className: 'tw-statline' },
          `总结 ${stats.distilled ?? 0} · 提交 ${stats.committed ?? 0} · 摘要查表 ${stats.served ?? 0} · 失败 ${stats.failures ?? 0}`),
        error === null ? null : h('div', { key: 'err', className: 'tw-err' }, error),
        note === null ? null : h('div', { key: 'note', className: 'tw-note' }, note),
        ...(showConfig ? [h(ConfigPanel, { key: 'config', embedded: true })] : body),
      ]);
    }

    // ── 配置表单（挂在插件页的 plugins.bundle.config 槽上） ──────────────
    function ConfigField({ field, value, options, dirty, presetText, busy, onChange, onReset }) {
      const isBool = field.type === 'bool';
      const isText = field.type === 'text';
      const isSelect = field.type === 'select';
      const isTextarea = field.type === 'textarea';
      // 选了预设时，文本框换成「只读展示那段预设」；只有自定义档才可编辑。
      const showingPreset = isTextarea && typeof presetText === 'string';
      const blocked = busy;
      const percent = field.type === 'ratio' && typeof value === 'number' && Number.isFinite(value)
        ? `（= ${formatPercent(value)}）`
        : '';
      const current = showingPreset ? presetText : (value === undefined || value === null ? '' : String(value));
      // 目录里没有当前值（例如旧的手填值、或 provider 暂时不可用）也要能看见，别默默显示成第一项。
      const choices = (options ?? []).slice();
      if (isSelect && choices.every((option) => option.value !== current)) {
        choices.push({ value: current, label: current === '' ? '跟随当前会话' : `${current}（目录里没有）` });
      }

      const control = isBool
        ? h('input', {
          type: 'checkbox',
          checked: value === true,
          disabled: blocked,
          onChange: (event) => onChange(event.target.checked),
        })
        : isSelect
          ? h('select', {
            className: 'tw-cfg-input tw-cfg-select',
            value: current,
            disabled: blocked,
            onChange: (event) => onChange(event.target.value),
          }, choices.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
          : isTextarea
            ? h('textarea', {
              className: `tw-cfg-input tw-cfg-textarea${showingPreset ? ' tw-cfg-readonly' : ''}`,
              rows: field.rows ?? 6,
              value: current,
              readOnly: showingPreset,
              disabled: blocked,
              placeholder: field.placeholder ?? '',
              onChange: (event) => onChange(event.target.value),
            })
            : h('input', {
              className: `tw-cfg-input${isText ? ' tw-cfg-input-wide' : ''}`,
              type: isText ? 'text' : 'number',
              value: current,
              min: field.min,
              max: field.max,
              step: field.step,
              disabled: blocked,
              onChange: (event) => onChange(event.target.value),
            });

      return h('div', { className: 'tw-cfg-field', 'data-field': field.key }, [
        h('div', { key: 'label', className: 'tw-cfg-label' }, [
          field.label,
          showingPreset ? h('span', { key: 'preset', className: 'tw-cfg-badge' }, '预设（只读）') : null,
          dirty ? h('span', { key: 'badge', className: 'tw-cfg-badge' }, '未保存') : null,
          field.override && !dirty && !showingPreset ? h('span', { key: 'ov', className: 'tw-cfg-badge' }, '已自定义') : null,
        ]),
        h('div', { key: 'body', className: 'tw-cfg-body' }, [
          h('div', { key: 'row', style: { display: 'flex', alignItems: isTextarea ? 'flex-start' : 'center', gap: 8, flexWrap: 'wrap' } }, [
            control,
            h('span', { key: 'unit', className: 'tw-muted', style: { fontSize: 11 } },
              [percent, field.unit ?? ''].filter(Boolean).join(' ')),
            field.override && !showingPreset
              ? h('button', {
                key: 'reset',
                className: 'tw-btn',
                style: { padding: '1px 6px', fontSize: 11 },
                disabled: blocked,
                onClick: () => onReset(field.key),
              }, '恢复默认')
              : null,
          ]),
          h('div', { key: 'hint', className: 'tw-cfg-hint' }, field.hint ?? ''),
        ]),
      ]);
    }

    function ConfigPanel(props) {
      // 嵌在「压缩」面板里时，外层已经有标题和返回按钮，这里不再重复一行标题。
      const embedded = props?.embedded === true;
      const [data, setData] = React.useState(null);
      const [draft, setDraft] = React.useState({});
      const [error, setError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const refresh = React.useCallback(() => {
        loadConfig()
          .then((next) => { setData(next); setDraft({}); setError(null); })
          .catch((cause) => setError(String(cause?.message ?? cause)));
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      React.useEffect(() => {
        if (note === null) return undefined;
        const timer = setTimeout(() => setNote(null), 8000);
        return () => clearTimeout(timer);
      }, [note]);

      const fields = React.useMemo(
        () => (data?.groups ?? []).flatMap((group) => group.fields.map((field) => ({ ...field, group: group.title }))),
        [data],
      );
      const byKey = React.useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
      const valueOf = (field) => (Object.hasOwn(draft, field.key) ? draft[field.key] : field.value);

      if (data === null) {
        return h('div', { className: 'tw-cfg' }, error === null ? '加载中…' : h('div', { className: 'tw-err' }, error));
      }

      const dirty = Object.keys(draft).length > 0;

      // 模型下拉的候选来自宿主的模型目录（服务端汇总后随配置一起下发）。
      const catalog = data.catalog ?? { providers: [], models: [] };
      const optionValue = (key) => {
        const field = byKey.get(key);
        if (field === undefined) return '';
        const raw = Object.hasOwn(draft, key) ? draft[key] : field.value;
        return raw === undefined || raw === null ? '' : String(raw);
      };
      const optionsFor = (field) => {
        // 固定候选项（例如提示词三档）直接来自字段元数据。
        if (Array.isArray(field.options)) return field.options.map((option) => ({ value: option.value, label: option.label }));
        if (field.source === 'provider') {
          return [
            { value: '', label: '跟随当前会话' },
            ...(catalog.providers ?? []).map((provider) => ({
              value: provider.id,
              label: provider.name === provider.id ? provider.id : `${provider.name}（${provider.id}）`,
            })),
          ];
        }
        const provider = field.pairKey === undefined ? '' : optionValue(field.pairKey);
        const models = (catalog.models ?? []).filter((model) => provider === '' || model.provider === provider);
        return [
          { value: '', label: '跟随当前会话' },
          ...models.map((model) => ({
            value: model.id,
            label: provider === ''
              ? `${model.provider} / ${model.name === model.id ? model.id : model.name}`
              : (model.name === model.id ? model.id : model.name),
          })),
        ];
      };

      /**
       * 这个输入框此刻该以只读方式展示哪段预设正文。
       * 返回字符串 = 只读展示它；返回 null = 可编辑（自定义档，或本来就不是提示词字段）。
       */
      const presetTextFor = (field) => {
        if (field.modeKey === undefined || field.presetFor === undefined) return null;
        const presetKey = field.presetFor[optionValue(field.modeKey)];
        if (presetKey === undefined) return null;
        const text = data.presets?.[presetKey];
        return typeof text === 'string' ? text : null;
      };

      const change = (field, value) => {
        // 从预设切到「自定义」时，把刚才只读展示的那段正文复制进草稿，
        // 用户是在一份已知可用的文本上改，而不是对着空白框重写。
        const prefill = {};
        if (field.targetKey !== undefined && value === 'custom') {
          const target = byKey.get(field.targetKey);
          const presetKey = target?.presetFor?.[optionValue(field.key)];
          const text = presetKey === undefined ? '' : (data.presets?.[presetKey] ?? '');
          if (text !== '' && optionValue(field.targetKey) === '') prefill[field.targetKey] = text;
        }
        setDraft((previous) => {
          const next = { ...previous, [field.key]: value, ...prefill };
          if (field.source === 'provider') {
            // 换了 provider，旧的 model 未必还在目录里：退回「跟随会话」，让用户重选。
            for (const other of fields) if (other.pairKey === field.key) next[other.key] = '';
          } else if (field.source === 'model' && field.pairKey !== undefined && value !== '') {
            // 从「全部模型」里挑，就把 provider 一起定下来，避免存出半截路由。
            const picked = (catalog.models ?? []).find((model) => model.id === value);
            if (picked !== undefined) next[field.pairKey] = picked.provider;
          }
          return next;
        });
      };

      const save = () => {
        const patch = {};
        for (const [key, raw] of Object.entries(draft)) {
          const field = byKey.get(key);
          if (field === undefined) continue;
          if (field.type === 'bool') patch[key] = raw === true;
          else if (field.type === 'text' || field.type === 'select' || field.type === 'textarea') patch[key] = String(raw ?? '');
          else {
            const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
            if (!Number.isFinite(numeric)) {
              setError(`「${field.label}」不是有效数字`);
              return;
            }
            patch[key] = numeric;
          }
        }
        setBusy(true);
        setError(null);
        writeConfig({ patch })
          .then((next) => {
            setData(next);
            setDraft({});
            setNote('已保存，立即生效');
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false));
      };

      const resetOne = (key) => {
        setBusy(true);
        setError(null);
        writeConfig({ reset: [key] })
          .then((next) => {
            setData(next);
            setDraft((previous) => {
              const copy = { ...previous };
              delete copy[key];
              return copy;
            });
            setNote('已恢复 profile 里的值');
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false));
      };

      return h('div', { className: 'tw-cfg' }, [
        h('div', { key: 'head', className: 'tw-cfg-head' }, [
          h('span', { key: 't', className: 'tw-title' }, embedded ? '' : '压缩参数'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('button', {
            key: 'save',
            className: 'tw-btn tw-btn-primary',
            disabled: busy || !dirty,
            onClick: save,
          }, busy ? '保存中…' : dirty ? `保存 ${Object.keys(draft).length} 项` : '保存'),
          h('button', {
            key: 'reload',
            className: 'tw-btn',
            disabled: busy,
            onClick: refresh,
          }, '重新读取'),
        ]),
        h('div', { key: 'path', className: 'tw-cfg-path' }, `覆盖层写入 ${data.path}`),
        error === null ? null : h('div', { key: 'err', className: 'tw-err' }, error),
        note === null ? null : h('div', { key: 'note', className: 'tw-note' }, note),
        data.problem === undefined || data.problem === null
          ? null
          : h('div', { key: 'problem', className: 'tw-err' }, data.problem),
        ...(data.groups ?? []).map((group) => h('div', { key: group.title, className: 'tw-cfg-group' }, [
          h('div', { key: 'title', className: 'tw-cfg-group-title' }, group.title),
          ...group.fields.map((field) => h(ConfigField, {
            key: field.key,
            field,
            options: optionsFor(field),
            value: valueOf(field),
            dirty: Object.hasOwn(draft, field.key),
            presetText: presetTextFor(field),
            busy,
            onChange: (value) => change(field, value),
            onReset: resetOne,
          })),
        ])),
        h('div', { key: 'foot', className: 'tw-cfg-hint' },
          '优先级：这里写的值 > profile 里 cordis.patch.yml 的 config > 内置默认。保存后立刻生效，不需要重启。'),
      ]);
    }

    function TowerView(props) {
      const hostSessionId = typeof props?.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : null;
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [selected, setSelected] = React.useState(() => new Set());
      const [note, setNote] = React.useState(null);
      /** 面板内切换：压缩记录 ⟷ 压缩参数（右上角「设置」） */
      const [showConfig, setShowConfig] = React.useState(false);
      /** 块的两种镜头：列表 ⟷ 塔结构。必须排在 showConfig 之后 —— test/client.mjs 按索引抓钩子。 */
      const [view, setView] = React.useState('list');

      const refresh = React.useCallback(() => {
        loadState(hostSessionId)
          .then((next) => { setState(next); setError(null); })
          .catch((cause) => setError(String(cause?.message ?? cause)));
      }, [hostSessionId]);

      React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      // 提示只用来回一句「已排队」，过一会儿自己消失，避免看起来像状态。
      React.useEffect(() => {
        if (note === null) return undefined;
        const timer = setTimeout(() => setNote(null), 20000);
        return () => clearTimeout(timer);
      }, [note]);

      const toggle = React.useCallback((block) => {
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(block.blockId)) next.delete(block.blockId);
          else next.add(block.blockId);
          return next;
        });
      }, []);

      const onAction = React.useCallback((action) => {
        setBusy(true);
        setNote(null);
        runAction({ ...action, sessionId: state?.session?.id ?? hostSessionId ?? undefined })
          .then((result) => {
            setSelected(new Set());
            setNote(typeof result?.message === 'string' ? result.message : null);
            refresh();
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setBusy(false));
      }, [state, hostSessionId, refresh]);

      // 钩子必须全部在早退之前：第一次渲染 state 还是 null，若这一行放在 return 之后，
      // 数据到位后的第二次渲染就会多出一个钩子，React 直接报 #310（Rendered more hooks…）。
      const onToggleConfig = React.useCallback(() => setShowConfig((previous) => !previous), []);

      if (state === null) {
        return h('div', { className: 'tw-root' }, error === null ? '加载中…' : h('div', { className: 'tw-err' }, error));
      }

      return h(Panel, { state, selected, toggle, onAction, busy, error, note, showConfig, onToggleConfig, view, onView: setView });
    }

    function apply(ctx) {
      ctx.effect(() => ensureStyle(), `${NS}: styles`);
      // `conversation.view` 的 owner props 里没有 sessionId（只有 inspectCall / viewRequest /
      // openView / completeViewRequest），所以用注册项自带的 inject(sessionId) 把会话号
      // 补进组件 props —— 官方 trajectory 视图就是这么拿的。
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'tower',
        order: 40,
        label: () => '压缩',
        inject: (sessionId) => ({ sessionId }),
      }, SafeTowerView));

      // 插件页的配置表单：keyed 槽，键是 profile 里列的 bundle 包名。
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-compaction-tower',
        label: () => '压缩参数',
        inject: () => ({}),
      }, SafeConfigPanel));
    }

    return { apply, inject, TowerView, ConfigPanel };
  },
});
