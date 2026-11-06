/**
 * dsh-longsession — browser half.
 *
 * Hand-written DSH client bundle in the lazy-CJS factory form the web module
 * loader consumes (`window.__ModuleLoader__.load({ id, factory })`): executing
 * this script only registers the factory; the body runs when the plugin is
 * materialized.
 *
 * Measured problem (see .tav/perf/reports/baseline-bench.md and session-data.md)
 * ----------------------------------------------------------------------------
 * DSH's Chat transcript never unloads history it has already loaded:
 *
 * - opening a long session renders the last two turns in one batch: measured
 *   892 ms to ready with an 808 ms max long task, DOM 1,240 -> 9,218 nodes,
 *   heap 36.6 -> 57.6 MB;
 * - each "load earlier" click then adds a page in one main-thread task of
 *   300-630 ms, growing the transcript 368 -> 1,330 rows, 9k -> 30k DOM nodes
 *   and 58 -> 121 MB heap.
 *
 * Scrolling itself is 60 fps in that renderer, and CSS containment measured
 * neutral, so this plugin does not touch rendering. It bounds the *window*:
 *
 * 1. `trimWindow()` asks the app's own Session Controller to rebuild the window
 *    (`SessionFace.resync()` — the same call the app makes when a subagent
 *    address changes): the loaded window drops back to the ordinary opening
 *    page without a page reload and without touching React-owned state.
 * 2. A toggle in the app's own session header row
 *    (`conversation.session.header.actions`, next to agent team / mode)
 *    collapses the loaded window. It is host-owned, not an overlay.
 * 3. The same call restores the saved window through `loadOlder()`; after a
 *    manual restore auto-collapse stays off for that session.
 * 4. Auto-collapse runs when the reader is at the live tail, no turn is
 *    running, and the window exceeded `autoTrimRows` (default 600).
 * 4. Optional wire cap: the history page request is a WebSocket `open` frame
 *    on `/api/remote.mux` with `payload.args.request{maxMessages, turnWindow}`,
 *    and older pages may use the unary `/api` RPC (`payload.args`). When
 *    `historyMaxMessages` / `historyMinTurns` are configured, the plugin lowers
 *    those fields before send. Defaults only cap `maxMessages` at 200 (no effect
 *    when the two-turn window is smaller), so opening behaviour is unchanged.
 *
 * Everything fails open: when the Session service, the slot service, or a frame
 * shape is absent, the corresponding feature does nothing.
 */

window.__ModuleLoader__.load({
  id: 'dsh-longsession',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    /** React is a platform module in the browser composition; absent elsewhere. */
    var react = null
    try {
      react = require('react')
    } catch (error) {
      react = null
    }

    /** Version reported by the probe; keep in sync with package.json. */
    var VERSION = '0.0.1'

    var CONFIG_KEY = 'dsh-longsession.config'
    var GLOBAL_KEY = '__DSH_LONGSESSION__'
    var WS_PATCH_KEY = '__DSH_LONGSESSION_WS__'
    var DOCK_ID = 'longsession'

    /** Below this many loaded rows the dock control stays hidden. */
    var DEFAULT_TRIM_MIN_ROWS = 120
    /** Loaded rows at which an idle, tail-reading client trims itself. 0 = off. */
    var DEFAULT_AUTO_TRIM_ROWS = 600
    /** Cap applied to history `maxMessages` in the wire request. 0 = off. */
    var DEFAULT_HISTORY_MAX_MESSAGES = 200
    /** Cap applied to `turnWindow.minTurns` in the wire request. 0 = off. */
    var DEFAULT_HISTORY_MIN_TURNS = 0
    /** Whether wire caps apply to every session; default: current session only. */
    var DEFAULT_HISTORY_CAPS_ALL_SESSIONS = false
    /** Do not auto-trim more often than this. */
    /** After an explicit restore, keep auto-compaction off for the rest of this session. */
    var AUTO_TRIM_COOLDOWN_MS = 15000
    /** Viewport distance (px) that still counts as "at the live tail". */
    var BOTTOM_TOLERANCE_PX = 48
    var OBSERVE_DELAY_MS = 180

    var TEXT = {
      zh: {
        compactAction: '收起历史',
        compactedAction: '已收起历史',
        compactingAction: '收起中…',
        failed: '收起失败',
        needsOlderShort: '先加载更早',
        blockedShort: '回合运行中',
        unavailableShort: '当前不可用',
        restoringAction: '还原中…',
        compactTitle: '把页面里已加载的旧历史收起来，只保留最近两轮，减少卡顿；聊天记录不会删除。',
        restoreTitle: '展开之前加载到的历史（会从磁盘重新读取页面）。',
        blocked: '有回合在运行，结束后才能操作',
        unavailable: '当前页面未暴露会话服务，无法操作',
        small: '页面还没有加载更早的历史，无需收起',
        needsOlder: '当前只加载了最近两轮；先点「加载更早」，再收起。',
        noOlderHint: '（只加载了最近两轮，先点「加载更早」再收起）',
        done: '已收起，回到最近两轮',
        currentStatus: '当前页面已加载：{rows} 行（约 {turns} 轮）',
        compactedSuffix: ' · 已收起',
        autoTrimOffSuffix: ' · 本会话自动收起已关闭',
        noSession: '当前没有打开的会话。',
        settingsNav: '长会话',
        settingsTitle: '长会话',
        settingsIntro: '这里只控制“浏览器里已加载的页面历史”的收起，不会删除聊天记录。',
        settingsEyebrow: 'DSH · 长会话',
        groupBehavior: '行为',
        groupBehaviorDesc: '插件开关与标题栏按钮',
        groupThresholds: '收起时机',
        groupThresholdsDesc: '手动与自动收起的门槛',
        groupRequests: '历史请求',
        groupRequestsDesc: '打开会话或加载更早时的请求上限',
        statusPage: '当前页面',
        statusLoadedShort: '{rows} 行 · 约 {turns} 轮',
        statusCompacted: '已收起',
        statusOpen: '未收起',
        statusAutoOff: '自动收起已关闭',
        statusNoSession: '没有打开的会话',
        unsaved: '有未保存的修改',
        unitRows: '行',
        unitTurns: '轮',
        unitMessages: '条',
        decrease: '减少',
        increase: '增加',
        enabled: '启用插件',
        enabledDesc: '关闭后不再自动收起，也不再改写历史请求。',
        trimMinRows: '显示按钮门槛',
        trimMinRowsDesc: '页面已加载超过这个行数时，标题栏出现「收起历史」；只有已经加载更早历史时才可点击。',
        autoTrimRows: '自动收起门槛',
        autoTrimRowsDesc: '页面在底部、没有回合运行时，已加载历史超过这个行数并且有更早历史，就自动收起一次。填 0 关闭自动收起。',
        historyMaxMessages: '历史请求上限',
        historyMaxMessagesDesc: '每次打开会话或加载更早时，把 maxMessages 压到这个值。填 0 表示不改写。',
        historyMinTurns: '历史最少轮数上限',
        historyMinTurnsDesc: '把 turnWindow.minTurns 压到这个值；填 1 可以让打开页小一半，填 0 表示不改写。',
        historyCapsAllSessions: '应用到所有会话',
        historyCapsAllSessionsDesc: '默认只改当前会话的历史请求；打开后也会改子代理和其他会话的请求。',
        autoCollapseOffTitle: '本会话自动收起已关闭',
        autoCollapseOffDesc: '手动还原历史后，本会话不再自动收起。',
        enableAutoCollapse: '重新开启',
        autoCollapseEnabled: '已重新开启自动收起',
        viewUnsupported: '当前视图缺少轮次信息，暂不支持收起。',
        viewUnsupportedShort: '当前视图不支持',
        showDock: '显示标题栏按钮',
        showDockDesc: '在会话标题栏（智能体团队、标准模式那一行）显示「收起历史」。关闭后只能通过配置或接口操作。',
        save: '保存',
        saved: '已保存',
        reset: '恢复默认',
        persisted: '设置保存在当前浏览器，换浏览器不会同步。',
      },
      en: {
        compactAction: 'Collapse history',
        compactedAction: 'History collapsed',
        compactingAction: 'Collapsing…',
        failed: 'Collapse failed',
        needsOlderShort: 'Load earlier first',
        blockedShort: 'Turn running',
        unavailableShort: 'Unavailable',
        restoringAction: 'Restoring…',
        compactTitle: 'Collapse the history already rendered by the page and keep only the last two turns; chat records are not deleted.',
        restoreTitle: 'Expand the history that was loaded before collapsing (reloads pages from disk).',
        blocked: 'A turn is running; try again after it finishes',
        unavailable: 'The session service is not exposed; cannot do that',
        small: 'No older history is loaded yet, nothing to collapse',
        needsOlder: 'Only the last two turns are loaded; use “Load earlier” first.',
        noOlderHint: ' (only the last two turns are loaded; use “Load earlier” first)',
        done: 'Collapsed back to the last two turns',
        currentStatus: 'Loaded in this page: {rows} rows (~{turns} turns)',
        compactedSuffix: ' · collapsed',
        autoTrimOffSuffix: ' · auto-collapse off for this session',
        noSession: 'No session is open.',
        settingsNav: 'Long session',
        settingsTitle: 'Long session',
        settingsIntro: 'This only affects whether the page history already loaded in this browser is collapsed; chat records are not deleted.',
        settingsEyebrow: 'DSH · LONG SESSION',
        groupBehavior: 'Behavior',
        groupBehaviorDesc: 'Plugin switch and header button',
        groupThresholds: 'When to collapse',
        groupThresholdsDesc: 'Manual and automatic thresholds',
        groupRequests: 'History requests',
        groupRequestsDesc: 'Caps when opening or loading earlier',
        statusPage: 'This page',
        statusLoadedShort: '{rows} rows · ~{turns} turns',
        statusCompacted: 'Collapsed',
        statusOpen: 'Expanded',
        statusAutoOff: 'Auto-collapse off',
        statusNoSession: 'No session open',
        unsaved: 'Unsaved changes',
        unitRows: 'rows',
        unitTurns: 'turns',
        unitMessages: 'messages',
        decrease: 'Decrease',
        increase: 'Increase',
        enabled: 'Enable plugin',
        enabledDesc: 'When off, auto-collapse stops and history requests are left untouched.',
        trimMinRows: 'Show / manual-collapse threshold',
        trimMinRowsDesc: 'The “Collapse history” button appears once this many rows are loaded; it becomes clickable only after older history is loaded.',
        autoTrimRows: 'Auto-collapse threshold',
        autoTrimRowsDesc: 'Collapse once when the reader is at the tail, no turn is running, more than this many rows are loaded, and older history exists. 0 disables auto-collapse.',
        historyMaxMessages: 'History request cap',
        historyMaxMessagesDesc: 'Lower maxMessages to this value when opening a session or loading earlier pages. 0 leaves the request untouched.',
        historyMinTurns: 'Minimum-turns cap',
        historyMinTurnsDesc: 'Lower turnWindow.minTurns to this value; 1 halves the opening page. 0 leaves it untouched.',
        historyCapsAllSessions: 'Apply to all sessions',
        historyCapsAllSessionsDesc: 'By default only the current session is capped; enable this to also cap subagents and other sessions.',
        autoCollapseOffTitle: 'Auto-collapse is off for this session',
        autoCollapseOffDesc: 'Auto-collapse stays off after a manual restore.',
        enableAutoCollapse: 'Turn it back on',
        autoCollapseEnabled: 'Auto-collapse is back on',
        viewUnsupported: 'This view has no turn metadata, so collapsing is unavailable.',
        viewUnsupportedShort: 'Unsupported view',
        showDock: 'Show the header button',
        showDockDesc: 'Show “Collapse history” in the session header row. When off, collapsing is only available through config or the API.',
        save: 'Save',
        saved: 'Saved',
        reset: 'Reset to defaults',
        persisted: 'Stored in this browser only; not synced across browsers.',
      },
    }

    function currentText() {
      var lang = ''
      try {
        lang = (document.documentElement.lang || navigator.language || '').toLowerCase()
      } catch (error) {
        lang = ''
      }
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    function text(key, params) {
      var template = currentText()[key] || TEXT.en[key] || key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      })
    }

    function positiveInt(value, fallback) {
      return Number.isInteger(value) && value >= 0 ? value : fallback
    }

    function readStoredConfig() {
      try {
        var raw = window.localStorage.getItem(CONFIG_KEY)
        if (!raw) return {}
        var parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    function writeStoredConfig(config) {
      try {
        window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
      } catch (error) {
        /* storage may be unavailable in hardened contexts; keep running */
      }
    }

    function normalizeConfig(config) {
      var stored = readStoredConfig()
      var merged = {}
      var key
      for (key in stored) merged[key] = stored[key]
      if (config && typeof config === 'object') {
        for (key in config) merged[key] = config[key]
      }
      return {
        enabled: merged.enabled !== false,
        trimMinRows: positiveInt(merged.trimMinRows, DEFAULT_TRIM_MIN_ROWS),
        autoTrimRows: positiveInt(merged.autoTrimRows, DEFAULT_AUTO_TRIM_ROWS),
        historyMaxMessages: positiveInt(merged.historyMaxMessages, DEFAULT_HISTORY_MAX_MESSAGES),
        historyMinTurns: positiveInt(merged.historyMinTurns, DEFAULT_HISTORY_MIN_TURNS),
        historyCapsAllSessions: merged.historyCapsAllSessions === true,
        showDock: merged.showDock !== false,
      }
    }

    /**
     * Lower the history window fields of one request object. Returns true when
     * something changed. The app validates `turnWindow.minMessages <=
     * maxMessages`, so a lowered maxMessages also lowers minMessages.
     */
    function requestSessionId(request) {
      if (request === null || typeof request !== 'object') return null
      var address = request.address
      if (address !== null && typeof address === 'object') {
        if (typeof address.sessionId === 'string' && address.sessionId !== '') return address.sessionId
        if (typeof address.id === 'string' && address.id !== '') return address.id
      }
      if (typeof request.sessionId === 'string' && request.sessionId !== '') return request.sessionId
      return null
    }

    function tuneRequest(request, settings, scope) {
      if (request === null || typeof request !== 'object') return false
      if (settings.historyCapsAllSessions !== true) {
        var targetSession = requestSessionId(request)
        var currentSession = scope !== null && scope !== undefined ? scope.sessionId : null
        if (targetSession !== null && currentSession !== null && targetSession !== currentSession) return false
      }
      var changed = false
      if (settings.historyMaxMessages > 0 && typeof request.maxMessages === 'number' && request.maxMessages > settings.historyMaxMessages) {
        request.maxMessages = settings.historyMaxMessages
        changed = true
      }
      var window = request.turnWindow
      if (window !== null && typeof window === 'object') {
        if (settings.historyMinTurns > 0 && typeof window.minTurns === 'number' && window.minTurns > settings.historyMinTurns) {
          window.minTurns = settings.historyMinTurns
          changed = true
        }
        if (typeof request.maxMessages === 'number' && typeof window.minMessages === 'number' && window.minMessages > request.maxMessages) {
          window.minMessages = request.maxMessages
          changed = true
        }
      }
      return changed
    }

    /** One wire message with its request at `payload.args.request`. */
    function tuneFrame(frame, settings, scope) {
      if (frame === null || typeof frame !== 'object') return false
      if (frame.type !== 'open') return false
      var payload = frame.payload
      if (payload === null || typeof payload !== 'object') return false
      var args = payload.args
      if (args === null || typeof args !== 'object') return false
      return tuneRequest(args.request, settings, scope)
    }

    /**
     * One page-level WebSocket send patch shared by every plugin instance.
     * Wrap once, keep the newest state in the registry: a plugin reload swaps
     * state without stacking wrappers, and an inactive state passes bytes
     * through untouched.
     */
    function ensureWebSocketPatch() {
      var existing = window[WS_PATCH_KEY]
      if (existing !== undefined && existing !== null) return existing
      var registry = {
        state: null,
        rewritten: 0,
        inspected: 0,
      }
      if (typeof window.WebSocket !== 'function' || window.WebSocket.prototype === undefined) {
        window[WS_PATCH_KEY] = registry
        return registry
      }
      var original = window.WebSocket.prototype.send
      if (typeof original !== 'function') {
        window[WS_PATCH_KEY] = registry
        return registry
      }
      window.WebSocket.prototype.send = function (data) {
        var state = registry.state
        if (state !== null && state.enabled && typeof data === 'string' && data.length > 0 && data.length < 1024 * 1024) {
          try {
            var frame = JSON.parse(data)
            registry.inspected++
            if (tuneFrame(frame, state.settings, state)) {
              data = JSON.stringify(frame)
              registry.rewritten++
              state.rewrites = registry.rewritten
            }
          } catch (error) {
            /* not a JSON frame (or settings not ready yet): leave it untouched */
          }
        }
        return original.call(this, data)
      }
      window[WS_PATCH_KEY] = registry
      return registry
    }

    /**
     * Older history pages may be read through the unary `/api` RPC
     * (`{type:"client-request", method, payload:{args}}`). Clamp those too; an
     * unparsable body passes through byte-identically.
     */
    function ensureFetchPatch(registry) {
      if (registry.fetchPatched === true) return registry
      if (typeof window.fetch !== 'function') return registry
      var original = window.fetch
      window.fetch = function (input, init) {
        var state = registry.state
        if (state !== null && state.enabled && init !== undefined && init !== null && init.method === 'POST' && typeof init.body === 'string' && init.body.length > 0 && init.body.length < 8 * 1024 * 1024) {
          var url = typeof input === 'string' ? input : input && input.url ? input.url : ''
          if (url.indexOf('/api/') !== -1 || url.indexOf('api/') === 0) {
            try {
              var message = JSON.parse(init.body)
              var args = message && message.payload ? message.payload.args : null
              registry.inspected++
              var target = args && typeof args === 'object' && args.request !== null && typeof args.request === 'object' ? args.request : args
              if (tuneRequest(target, state.settings, state)) {
                registry.rewritten++
                state.rewrites = registry.rewritten
                init = Object.assign({}, init, { body: JSON.stringify(message) })
              }
            } catch (error) {
              /* not our RPC shape: forward the original request untouched */
            }
          }
        }
        return original.call(this, input, init)
      }
      registry.fetchPatched = true
      window[WS_PATCH_KEY] = registry
      return registry
    }

    function apply(ctx, config) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      var settings = normalizeConfig(config)

      var previous = window[GLOBAL_KEY]
      if (previous && typeof previous.dispose === 'function') {
        try {
          previous.dispose()
        } catch (error) {
          /* a stale instance that cannot dispose is still displaced below */
        }
      }

      var disposed = false
      var state = {
        enabled: settings.enabled,
        settings: settings,
        rows: 0,
        turns: 0,
        trims: 0,
        rewrites: 0,
        sessions: null,
        sessionId: null,
        compacted: false,
        compactSnapshot: null,
        restoring: false,
        lastFailure: null,
        lastAutoTrimAt: 0,
        lastCompactAt: 0,
        autoTrimDisabled: false,
        trimming: false,
        turnsKnown: false,
        subscribers: [],
      }
      var root = null
      var treeObserver = null
      var observeTimer = 0
      var attachTimer = 0
      var autoTrimScrollTimer = 0
      var bodyObserver = null
      var dotStyleElement = null

      function ensureDotStyles() {
        if (dotStyleElement !== null && dotStyleElement.parentNode !== null) return
        var style = document.createElement('style')
        style.setAttribute('data-dsh-longsession-style', '')
        style.textContent = [
          '[data-dsh-longsession-dot]{transition:background .15s ease,box-shadow .15s ease}',
          'body[data-ds-dark-theme] [data-dsh-longsession-dot="amber"]{background:#fbbf24;box-shadow:0 0 0 1px rgba(251,191,36,.30)}',
          'body:not([data-ds-dark-theme]) [data-dsh-longsession-dot="amber"]{background:#d97706;box-shadow:0 0 0 1px rgba(217,119,6,.22)}',
          'body[data-ds-dark-theme] [data-dsh-longsession-dot="green"]{background:#4ade80;box-shadow:0 0 0 1px rgba(74,222,128,.30)}',
          'body:not([data-ds-dark-theme]) [data-dsh-longsession-dot="green"]{background:#16a34a;box-shadow:0 0 0 1px rgba(22,163,74,.22)}',
          'body[data-ds-dark-theme] [data-dsh-longsession-dot="gray"]{background:#94a3b8;box-shadow:0 0 0 1px rgba(148,163,184,.24)}',
          'body:not([data-ds-dark-theme]) [data-dsh-longsession-dot="gray"]{background:#64748b;box-shadow:0 0 0 1px rgba(100,116,139,.18)}',
          '[data-dsh-longsession-settings]{--dsh-ls-fg:var(--dsw-alias-label-primary,#111827);--dsh-ls-fg2:var(--dsw-alias-label-secondary,#4b5563);--dsh-ls-fg3:var(--dsw-alias-label-tertiary,#6b7280);--dsh-ls-border:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--dsh-ls-surface:var(--dsw-alias-bg-layer-1,#fff);--dsh-ls-surface2:var(--dsw-alias-bg-layer-2,#f6f7f9);--dsh-ls-accent:var(--dsw-alias-state-business-primary,#3b5bdb);--dsh-ls-success:var(--dsw-alias-state-success-primary,#16a34a);display:flex;flex-direction:column;gap:18px;max-width:620px;padding:2px 0 16px;color:var(--dsh-ls-fg);font-size:13px;line-height:1.5}',
          '.dsh-ls-head{display:flex;flex-direction:column;gap:6px}',
          '.dsh-ls-title{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em;line-height:1.3;color:var(--dsh-ls-fg)}',
          '.dsh-ls-intro{margin:0;max-width:56ch;font-size:12.5px;line-height:1.6;color:var(--dsh-ls-fg2)}',
          '.dsh-ls-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;color:var(--dsh-ls-fg3);font-size:11.5px}',
          '.dsh-ls-summary-label{font-weight:500}',
          '.dsh-ls-summary-value{font-size:12.5px;font-weight:600;color:var(--dsh-ls-fg);font-variant-numeric:tabular-nums}',
          '.dsh-ls-summary-sub{color:var(--dsh-ls-fg3)}',
          '.dsh-ls-badges{display:flex;flex-wrap:wrap;gap:6px}',
          '.dsh-ls-badge{display:inline-flex;align-items:center;min-height:20px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsh-ls-border);font-size:10.5px;line-height:16px;color:var(--dsh-ls-fg2);background:var(--dsh-ls-surface)}',
          '.dsh-ls-badge-success{color:var(--dsh-ls-success);border-color:color-mix(in srgb,var(--dsh-ls-success) 30%,transparent);background:color-mix(in srgb,var(--dsh-ls-success) 10%,transparent)}',
          '.dsh-ls-badge-muted{color:var(--dsh-ls-fg3);background:var(--dsh-ls-surface2)}',
          '.dsh-ls-section{display:flex;flex-direction:column;gap:6px}',
          '.dsh-ls-section-title{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsh-ls-fg2)}',
          '.dsh-ls-card{border:1px solid var(--dsh-ls-border);border-radius:12px;background:var(--dsh-ls-surface);overflow:hidden}',
          '.dsh-ls-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:24px;padding:14px 16px;border-top:1px solid var(--dsh-ls-border)}',
          '.dsh-ls-row:first-child{border-top:0}',
          '.dsh-ls-row-copy{min-width:0}',
          '.dsh-ls-label{font-size:13px;font-weight:500;color:var(--dsh-ls-fg)}',
          '.dsh-ls-desc{max-width:48ch;margin:3px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsh-ls-fg3)}',
          '.dsh-ls-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:1px solid var(--dsh-ls-border);border-radius:999px;background:var(--dsh-ls-surface2);cursor:pointer;transition:background .18s ease,border-color .18s ease}',
          '.dsh-ls-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .18s ease}',
          '.dsh-ls-switch[aria-checked="true"]{background:var(--dsh-ls-accent);border-color:var(--dsh-ls-accent)}',
          '.dsh-ls-switch[aria-checked="true"]::after{transform:translateX(16px)}',
          '.dsh-ls-number{display:flex;align-items:center;width:132px;height:32px;padding:0 9px;border:1px solid var(--dsh-ls-border);border-radius:8px;background:var(--dsh-ls-surface2);transition:border-color .15s ease,box-shadow .15s ease}',
          '.dsh-ls-number:focus-within{border-color:var(--dsh-ls-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsh-ls-accent) 18%,transparent)}',
          '[data-dsh-longsession-settings] .dsh-ls-number .dsh-ls-input{width:100% !important;min-width:0;height:100%;border:0 !important;border-radius:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important;padding:0 !important;margin:0 !important;color:var(--dsh-ls-fg) !important;font:inherit !important;font-size:13px !important;line-height:32px !important;text-align:right !important;font-variant-numeric:tabular-nums;appearance:textfield;caret-color:var(--dsh-ls-accent)}',
          '[data-dsh-longsession-settings] .dsh-ls-number .dsh-ls-input:focus,[data-dsh-longsession-settings] .dsh-ls-number .dsh-ls-input:focus-visible{border:0 !important;outline:0 !important;box-shadow:none !important;background:transparent !important}',
          '.dsh-ls-unit{flex:none;margin-left:6px;font-size:11px;font-weight:500;line-height:1;color:var(--dsh-ls-fg2);white-space:nowrap}',
          '.dsh-ls-input::-webkit-inner-spin-button,.dsh-ls-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
          '.dsh-ls-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:16px 0 0;margin-top:2px}',
          '.dsh-ls-action-state{margin-right:auto;font-size:11.5px;color:var(--dsh-ls-fg3)}',
          '.dsh-ls-btn{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 14px;border-radius:8px;font-size:12.5px;font-weight:500;cursor:pointer;transition:background .15s ease,border-color .15s ease,opacity .15s ease}',
          '.dsh-ls-btn-primary{border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;font-weight:600}',
          'body[data-ds-dark-theme] .dsh-ls-btn-primary{border-color:#3b82f6;background:#3b82f6}',
          '.dsh-ls-btn-primary:disabled{opacity:.6;cursor:not-allowed}',
          '.dsh-ls-btn-secondary{border:1px solid var(--dsh-ls-border);background:transparent;color:var(--dsh-ls-fg2)}',
          '.dsh-ls-btn-secondary:disabled{opacity:.5;cursor:not-allowed}',
          '.dsh-ls-btn:focus-visible,.dsh-ls-switch:focus-visible,.dsh-ls-input:focus-visible{outline:2px solid var(--dsh-ls-accent);outline-offset:2px}',
          '.dsh-ls-switch:hover,.dsh-ls-btn-secondary:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsh-ls-surface2))}',
          '.dsh-ls-btn-primary:hover:not(:disabled){filter:brightness(.96)}',
          '.dsh-ls-foot{margin:0;font-size:11px;color:var(--dsh-ls-fg3)}',
          '@media (max-width:560px){.dsh-ls-row{grid-template-columns:1fr;gap:10px}.dsh-ls-number{width:100%}}',
          '@media (prefers-reduced-motion:reduce){.dsh-ls-switch,.dsh-ls-switch::after,.dsh-ls-btn,.dsh-ls-number{transition:none}}',
        ].join('')
        ;(document.head || document.documentElement).appendChild(style)
        dotStyleElement = style
      }
      var wsRegistry = ensureWebSocketPatch()
      wsRegistry = ensureFetchPatch(wsRegistry)
      ensureDotStyles()
      var headerRegistration = null
      var settingsRegistration = null

      function emit() {
        if (disposed) return
        state.rewrites = wsRegistry.rewritten
        var listeners = state.subscribers.slice()
        var index
        for (index = 0; index < listeners.length; index++) {
          try {
            listeners[index]()
          } catch (error) {
            /* dock render errors must not break the transcript */
          }
        }
      }

      /** The Session root currently rendering a transcript, if any. */
      function isVisibleElement(element) {
        if (element === null || element === undefined || !element.isConnected) return false
        if (element.getClientRects().length === 0) return false
        var style
        try {
          style = window.getComputedStyle(element)
        } catch (error) {
          style = null
        }
        if (style === null) return true
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      }

      function currentRoot() {
        if (root !== null && root.isConnected && isVisibleElement(root) && root.querySelector('[data-chat-flow-key]') !== null) return root
        var candidates = document.querySelectorAll('[data-conversation-scroll]')
        var fallback = null
        var visible = null
        for (var index = 0; index < candidates.length; index++) {
          var candidate = candidates.item(index)
          if (candidate.querySelector('[data-chat-flow-key]') === null) continue
          if (fallback === null) fallback = candidate
          if (!isVisibleElement(candidate)) continue
          if (visible === null) visible = candidate
          if (document.activeElement !== null && candidate.contains(document.activeElement)) return candidate
        }
        if (visible !== null) return visible
        if (fallback !== null) return fallback
        var row = document.querySelector('[data-chat-flow-key]')
        return row === null ? null : row.parentElement
      }

      function rows() {
        var container = currentRoot()
        if (container === null) return []
        return container.querySelectorAll('[data-chat-flow-key]')
      }

      /** The scrollport the transcript scrolls in (shared Conversation shell or Chat's own). */
      function scrollport() {
        var container = currentRoot()
        if (container === null) return null
        var known = container.closest('[data-conversation-scroll]')
        if (known !== null) return known
        var node = container.parentElement
        while (node !== null && node !== document.body) {
          var style
          try {
            style = window.getComputedStyle(node)
          } catch (error) {
            style = null
          }
          if (style !== null && /(auto|scroll|overlay)/.test(style.overflowY) && node.clientHeight > 0) return node
          node = node.parentElement
        }
        return null
      }

      function atBottom() {
        var port = scrollport()
        if (port === null) return false
        var distance = port.scrollHeight - port.scrollTop - port.clientHeight
        if (!Number.isFinite(distance)) return false
        return distance <= BOTTOM_TOLERANCE_PX
      }

      function sessionFace() {
        var sessions = state.sessions
        var sessionId = currentSessionId()
        if (sessions === null || sessionId === null || sessionId === '') return null
        var manager = sessions.manager
        if (manager === undefined || manager === null || typeof manager.get !== 'function') return null
        try {
          var face = manager.get(sessionId)
          if (face !== null && face !== undefined && typeof face.resync === 'function') return face
        } catch (error) {
          return null
        }
        return null
      }

      /** The Session id currently rendered by the page. */
      function currentSessionId() {
        var container = currentRoot()
        if (container !== null) {
          var own = container.closest('[data-conversation-session]')
          if (own !== null) return own.getAttribute('data-conversation-session')
        }
        var elements = document.querySelectorAll('[data-conversation-session]')
        var fallback = null
        var firstVisible = null
        for (var index = 0; index < elements.length; index++) {
          var element = elements.item(index)
          if (fallback === null) fallback = element
          if (!isVisibleElement(element)) continue
          if (firstVisible === null) firstVisible = element
          if (document.activeElement !== null && element.contains(document.activeElement)) return element.getAttribute('data-conversation-session')
        }
        var chosen = firstVisible === null ? fallback : firstVisible
        return chosen === null ? null : chosen.getAttribute('data-conversation-session')
      }

      function compactKey(sessionId) {
        return 'dsh-longsession.compacted:' + sessionId
      }

      function readCompactSnapshot(sessionId) {
        if (sessionId === null || typeof window.sessionStorage === 'undefined') return null
        try {
          var raw = window.sessionStorage.getItem(compactKey(sessionId))
          if (!raw) return null
          var parsed = JSON.parse(raw)
          if (parsed === null || typeof parsed !== 'object') return null
          if (!Number.isFinite(parsed.turns) || parsed.turns <= 0) return null
          return {
            turns: parsed.turns,
            rows: Number.isFinite(parsed.rows) ? parsed.rows : 0,
            scrollTop: Number.isFinite(parsed.scrollTop) ? parsed.scrollTop : 0,
          }
        } catch (error) {
          return null
        }
      }

      function writeCompactSnapshot(sessionId, snapshot) {
        if (sessionId === null || typeof window.sessionStorage === 'undefined') return
        try {
          window.sessionStorage.setItem(compactKey(sessionId), JSON.stringify(snapshot))
        } catch (error) {
          /* sessionStorage may be unavailable; restore then stays in-memory only */
        }
      }

      function clearCompactSnapshot(sessionId) {
        if (sessionId === null || typeof window.sessionStorage === 'undefined') return
        try {
          window.sessionStorage.removeItem(compactKey(sessionId))
        } catch (error) {
          /* ignore */
        }
      }

      function autoTrimOffKey(sessionId) {
        return 'dsh-longsession.autoTrimOff:' + sessionId
      }

      function readAutoTrimOff(sessionId) {
        if (sessionId === null || typeof window.sessionStorage === 'undefined') return false
        try {
          return window.sessionStorage.getItem(autoTrimOffKey(sessionId)) === '1'
        } catch (error) {
          return false
        }
      }

      function writeAutoTrimOff(sessionId) {
        if (sessionId === null || typeof window.sessionStorage === 'undefined') return
        try {
          window.sessionStorage.setItem(autoTrimOffKey(sessionId), '1')
        } catch (error) {
          /* sessionStorage may be unavailable; keep it in memory only */
        }
      }

      function clearAutoTrimOff(sessionId) {
        if (sessionId === null || typeof window.sessionStorage === 'undefined') return
        try {
          window.sessionStorage.removeItem(autoTrimOffKey(sessionId))
        } catch (error) {
          /* ignore */
        }
      }

      /**
       * Keep the button state aligned with the active Session and the stored
       * snapshot. A snapshot older than the rows currently loaded means the
       * reader has manually loaded past it, so the toggle no longer applies.
       */
      function syncCompactState() {
        var sessionId = currentSessionId()
        if (sessionId !== state.sessionId) {
          state.sessionId = sessionId
          state.compactSnapshot = sessionId === null ? null : readCompactSnapshot(sessionId)
          state.autoTrimDisabled = sessionId === null ? false : readAutoTrimOff(sessionId)
        }
        if (state.sessionId === null) {
          state.compacted = false
          state.compactSnapshot = null
          return
        }
        if (state.restoring) return
        if (state.compactSnapshot === null) {
          state.compacted = false
          return
        }
        if (state.turns > state.compactSnapshot.turns || (state.turns === state.compactSnapshot.turns && Date.now() - state.lastCompactAt > 2000)) {
          clearCompactSnapshot(state.sessionId)
          state.compactSnapshot = null
          state.compacted = false
          return
        }
        state.compacted = true
      }

      /**
       * Rebuild this Session's loaded window through the app's own controller:
       * it disposes the opened history source and re-opens the ordinary opening
       * page, so rows, DOM nodes, and heap return to the opening-page baseline.
       * The page and the composer survive.
       *
       * @returns whether a trim was actually performed.
       */
      async function waitForRowShrink(previousRows) {
        var startedAt = Date.now()
        while (Date.now() - startedAt < 3000) {
          var current = rows().length
          if (current < previousRows) return current
          await new Promise(function (resolve) {
            window.setTimeout(resolve, 100)
          })
        }
        return rows().length
      }

      async function trimWindow(reason) {
        if (disposed || state.restoring || state.trimming) return false
        if (!state.turnsKnown || state.turns <= 2) return false
        var total = rows().length
        var minimumRows = reason === 'auto' ? settings.autoTrimRows : settings.trimMinRows
        if (total <= minimumRows) return false
        var face = sessionFace()
        if (face === null) return false
        if (face.running === true) return false
        var sessionId = currentSessionId()
        var snapshot = {
          turns: state.turns,
          rows: state.rows,
          scrollTop: (function () {
            var port = scrollport()
            return port === null ? 0 : port.scrollTop
          })(),
        }
        try {
          state.trimming = true
          emit()
          await face.resync()
          if (currentSessionId() !== sessionId) {
            state.lastFailure = 'compact cancelled: session changed'
            emit()
            return false
          }
          var shrunk = await waitForRowShrink(total)
          if (currentSessionId() !== sessionId) {
            state.lastFailure = 'compact cancelled: session changed'
            emit()
            return false
          }
          if (shrunk >= total) {
            state.lastFailure = 'compact failed: resync did not unload rows'
            emit()
            return false
          }
          state.trims++
          state.lastFailure = null
          state.lastTrimReason = reason || 'manual'
          if (sessionId !== null) {
            var stored = readCompactSnapshot(sessionId)
            if (stored === null) {
              writeCompactSnapshot(sessionId, snapshot)
              state.compactSnapshot = snapshot
            }
            state.sessionId = sessionId
            state.compacted = true
            state.lastCompactAt = Date.now()
          }
          emit()
          return true
        } catch (error) {
          state.lastFailure = 'compact failed: ' + String(error && error.message ? error.message : error)
          emit()
          return false
        } finally {
          state.trimming = false
          emit()
        }
      }

      /**
       * Restore the window that was loaded before the last compaction. The old
       * pages are not kept in memory, so this asks the app's own controller for
       * them again, one page at a time, until the saved turn count is reached.
       */
      async function restoreWindow() {
        if (disposed || state.restoring) return false
        var sessionId = currentSessionId()
        var snapshot = state.compactSnapshot || (sessionId === null ? null : readCompactSnapshot(sessionId))
        var face = sessionFace()
        if (snapshot === null || face === null || face.running === true) return false
        state.restoring = true
        emit()
        try {
          var guard = 0
          while (state.turns < snapshot.turns && guard < 40) {
            if (currentSessionId() !== sessionId) {
              state.lastFailure = 'restore cancelled: session changed'
              emit()
              return false
            }
            if (face.hasMore === false) break
            var beforeTurns = state.turns
            var beforeRows = state.rows
            await face.loadOlder()
            var startedAt = Date.now()
            while (Date.now() - startedAt < 5000) {
              await new Promise(function (resolve) {
                window.setTimeout(resolve, 100)
              })
              if (state.turns !== beforeTurns || state.rows !== beforeRows) break
            }
            guard++
            if (state.turns === beforeTurns && state.rows === beforeRows) break
          }
          var reached = state.turns >= snapshot.turns || face.hasMore === false
          if (currentSessionId() !== sessionId) {
            state.lastFailure = 'restore cancelled: session changed'
            emit()
            return false
          }
          if (!reached) {
            state.lastFailure = 'restore incomplete: ' + String(state.turns) + '/' + String(snapshot.turns) + ' turns'
            emit()
            return false
          }
          var port = scrollport()
          if (port !== null && Number.isFinite(snapshot.scrollTop)) {
            try {
              port.scrollTop = snapshot.scrollTop
            } catch (error) {
              /* best-effort scroll restore */
            }
          }
          if (sessionId !== null) clearCompactSnapshot(sessionId)
          state.compactSnapshot = null
          state.compacted = false
          state.lastTrimReason = 'restore'
          state.autoTrimDisabled = true
          if (sessionId !== null) writeAutoTrimOff(sessionId)
          emit()
          return true
        } catch (error) {
          state.lastFailure = 'restore failed: ' + String(error && error.message ? error.message : error)
          emit()
          return false
        } finally {
          state.restoring = false
          emit()
        }
      }

      function enableAutoCollapse() {
        if (disposed) return false
        var sessionId = currentSessionId()
        state.autoTrimDisabled = false
        state.lastAutoTrimAt = 0
        if (sessionId !== null) clearAutoTrimOff(sessionId)
        emit()
        autoTrim()
        return true
      }

      function autoTrim() {
        if (disposed || !state.enabled || state.compacted || state.restoring || state.trimming) return
        if (document.querySelector('[role="dialog"]') !== null) return
        if (state.autoTrimDisabled) return
        if (settings.autoTrimRows === 0) return
        if (state.lastAutoTrimAt !== 0 && Date.now() - state.lastAutoTrimAt < AUTO_TRIM_COOLDOWN_MS) return
        if (!state.turnsKnown || state.turns <= 2 || state.rows < settings.autoTrimRows) return
        if (!atBottom()) return
        trimWindow('auto').then(function (trimmed) {
          state.lastAutoTrimAt = Date.now()
          if (trimmed) {
            state.lastAutoTrimReason = 'auto'
            emit()
          } else {
            emit()
          }
        })
      }

      var trimInFlight = false
      function manualTrim() {
        if (disposed || trimInFlight) return Promise.resolve(false)
        trimInFlight = true
        return trimWindow('manual').then(function (trimmed) {
          trimInFlight = false
          return trimmed
        }, function () {
          trimInFlight = false
          return false
        })
      }

      function scheduleScan() {
        if (disposed || observeTimer !== 0) return
        observeTimer = window.setTimeout(function () {
          observeTimer = 0
          scan()
        }, OBSERVE_DELAY_MS)
      }

      function onTranscriptScroll(event) {
        if (disposed) return
        var port = scrollport()
        if (port === null || event.target !== port) return
        if (!atBottom()) return
        if (autoTrimScrollTimer !== 0) return
        autoTrimScrollTimer = window.setTimeout(function () {
          autoTrimScrollTimer = 0
          autoTrim()
        }, 220)
      }

      function scan() {
        if (disposed) return
        var container = currentRoot()
        if (container === null) {
          state.rows = 0
          state.turns = 0
          state.turnsKnown = false
          syncCompactState()
          emit()
          return
        }
        if (root !== container) {
          if (treeObserver !== null) treeObserver.disconnect()
          root = container
          treeObserver = new window.MutationObserver(function () {
            scheduleScan()
          })
          treeObserver.observe(root, { childList: true, subtree: true })
        }
        var rowList = rows()
        state.rows = rowList.length
        var turnSet = new Set()
        for (var index = 0; index < rowList.length; index++) {
          var turn = rowList[index].getAttribute('data-chat-turn')
          if (turn !== null && turn !== '') turnSet.add(turn)
        }
        state.turns = turnSet.size
        state.turnsKnown = turnSet.size > 0
        syncCompactState()
        emit()
        autoTrim()
      }

      function attach() {
        if (disposed) return
        if (currentRoot() !== null) {
          scan()
          return
        }
        if (attachTimer === 0) {
          attachTimer = window.setTimeout(function () {
            attachTimer = 0
            attach()
          }, 300)
        }
      }

      /**
       * The dock control. It lives inside the app's own composer dock list next
       * to the token/usage pills, so it never floats over the sidebar account
       * row or the transcript text. It is the only visible surface the plugin
       * adds.
       */
      var LongSessionHeaderAction = null
      if (react !== null && typeof react.createElement === 'function') {
        LongSessionHeaderAction = react.memo(function LongSessionHeaderAction() {
          var api = window[GLOBAL_KEY]
          var [snapshot, setSnapshot] = react.useState(function () {
            return api && typeof api.probe === 'function' ? api.probe() : null
          })
          var [feedback, setFeedback] = react.useState('')
          function showFeedback(message) {
            setFeedback(message)
            window.setTimeout(function () {
              setFeedback(function (previous) {
                return previous === message ? '' : previous
              })
            }, 1800)
          }
          react.useEffect(function () {
            if (!api || typeof api.subscribe !== 'function') return undefined
            var unsubscribe = api.subscribe(function () {
              setSnapshot(api.probe())
            })
            setSnapshot(api.probe())
            return unsubscribe
          }, [api])
          if (api === null || api === undefined) return null
          var headerConfig = typeof api.getConfig === 'function' ? api.getConfig() : null
          if (headerConfig !== null && headerConfig.showDock === false) return null
          if (snapshot === null) return null
          var compacted = snapshot.compacted === true
          var restoring = snapshot.restoring === true
          var turnsKnown = snapshot.turnsKnown === true
          var trimming = snapshot.trimming === true
          if (!compacted && !restoring && snapshot.rows < snapshot.trimMinRows) return null
          var unsupported = !compacted && !restoring && !turnsKnown
          var needsOlder = !compacted && !restoring && turnsKnown && snapshot.turns <= 2
          var blocked = snapshot.running === true
          var unavailable = snapshot.trimAvailable === false
          var inactive = blocked || unavailable || restoring || needsOlder || unsupported || trimming || feedback !== ''
          var dotState = restoring || trimming || feedback !== ''
            ? 'gray'
            : compacted
              ? 'green'
              : inactive
                ? 'gray'
                : 'amber'
          var label = feedback !== ''
            ? feedback
            : restoring
              ? text('restoringAction')
              : trimming
                ? text('compactingAction')
                : compacted
                  ? text('compactedAction')
                  : text('compactAction')
          var title = restoring
            ? text('restoringAction')
            : unavailable
              ? text('unavailable')
              : blocked
                ? text('blocked')
                : needsOlder
                  ? text('needsOlder')
                  : compacted
                    ? text('restoreTitle')
                    : text('compactTitle')
          return react.createElement(
            'button',
            {
              type: 'button',
              'data-dsh-longsession-header': '',
              title: title,
              'aria-label': title,
              'aria-disabled': inactive ? 'true' : 'false',
              onClick: function (event) {
                event.preventDefault()
                if (restoring || trimming) return
                if (unsupported) {
                  showFeedback(text('viewUnsupportedShort'))
                  return
                }
                if (needsOlder) {
                  showFeedback(text('needsOlderShort'))
                  return
                }
                if (blocked) {
                  showFeedback(text('blockedShort'))
                  return
                }
                if (unavailable) {
                  showFeedback(text('unavailableShort'))
                  return
                }
                if (compacted) {
                  restoreWindow().then(function (restored) {
                    if (!restored) showFeedback(text('failed'))
                  })
                  return
                }
                manualTrim().then(function (trimmed) {
                  if (!trimmed) showFeedback(text('failed'))
                })
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                minHeight: '28px',
                maxWidth: '180px',
                padding: '3px 7px',
                margin: '0',
                borderRadius: '6px',
                border: '0',
                background: 'transparent',
                color: inactive ? 'var(--dsw-alias-label-caption, currentColor)' : 'var(--dsw-alias-label-tertiary, currentColor)',
                font: 'var(--dsw-font-xs-13, 12px/16px ui-sans-serif, system-ui, sans-serif)',
                cursor: restoring || trimming ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                opacity: inactive ? '0.65' : '1',
              },
            },
            react.createElement('span', {
              'aria-hidden': 'true',
              'data-dsh-longsession-dot': dotState,
              style: {
                width: '5px',
                height: '5px',
                flex: 'none',
                borderRadius: '50%',
              },
            }),
            label,
          )
        })
      }

      /**
       * Settings page contributed as a `settings.section`. It edits the same
       * localStorage-backed config the client runtime reads; the dock control
       * and the wire patch observe the new values immediately.
       */
      var LongSessionSettings = null
      if (react !== null && typeof react.createElement === 'function') {
        var SETTINGS_KEYS = ['enabled', 'trimMinRows', 'autoTrimRows', 'historyMaxMessages', 'historyMinTurns', 'showDock']

        function sameConfig(a, b) {
          if (a === null || b === null || a === undefined || b === undefined) return false
          for (var index = 0; index < SETTINGS_KEYS.length; index++) {
            if (a[SETTINGS_KEYS[index]] !== b[SETTINGS_KEYS[index]]) return false
          }
          return true
        }

        var NumberRow = react.memo(function NumberRow(props) {
          var [textValue, setTextValue] = react.useState(String(props.value))
          react.useEffect(function () {
            setTextValue(String(props.value))
          }, [props.value])
          function handleChange(event) {
            var next = event.target.value
            setTextValue(next)
            var parsed = parseInt(next, 10)
            if (Number.isFinite(parsed) && parsed >= 0) props.onChange(parsed)
          }
          function handleBlur() {
            var parsed = parseInt(textValue, 10)
            if (!Number.isFinite(parsed) || parsed < 0) {
              setTextValue(String(props.value))
              return
            }
            if (parsed !== props.value) props.onChange(parsed)
            setTextValue(String(parsed))
          }
          return react.createElement(
            'div',
            { className: 'dsh-ls-row' },
            react.createElement(
              'div',
              { className: 'dsh-ls-row-copy' },
              react.createElement('label', { htmlFor: props.id, className: 'dsh-ls-label' }, props.label),
              react.createElement('p', { id: props.id + '-desc', className: 'dsh-ls-desc' }, props.description),
            ),
            react.createElement(
              'div',
              { className: 'dsh-ls-number' },
              react.createElement('input', {
                id: props.id,
                type: 'number',
                min: '0',
                step: '1',
                inputMode: 'numeric',
                className: 'dsh-ls-input',
                value: textValue,
                'aria-describedby': props.id + '-desc',
                onChange: handleChange,
                onBlur: handleBlur,
                onKeyDown: function (event) {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleBlur()
                    event.currentTarget.blur()
                  }
                },
              }),
              react.createElement('span', { className: 'dsh-ls-unit' }, props.unit),
            ),
          )
        })

        LongSessionSettings = react.memo(function LongSessionSettings() {
          var api = window[GLOBAL_KEY]
          var initial = api && typeof api.getConfig === 'function' ? api.getConfig() : null
          var defaults = api && typeof api.getDefaults === 'function' ? api.getDefaults() : initial
          var [draft, setDraft] = react.useState(function () {
            return initial
          })
          var [baseline, setBaseline] = react.useState(function () {
            return initial
          })
          var [stats, setStats] = react.useState(function () {
            return api && typeof api.probe === 'function' ? api.probe() : null
          })
          var [status, setStatus] = react.useState('')
          react.useEffect(function () {
            if (!api || typeof api.subscribe !== 'function') return undefined
            var unsubscribe = api.subscribe(function () {
              setStats(api.probe())
            })
            setStats(api.probe())
            return unsubscribe
          }, [api])
          if (api === null || api === undefined || draft === null) return null

          var dirty = !sameConfig(draft, baseline)
          var isDefault = sameConfig(draft, defaults)

          function update(key, value) {
            var next = Object.assign({}, draft)
            next[key] = value
            setDraft(next)
            setStatus('')
          }

          function save() {
            api.setConfig(draft)
            setBaseline(draft)
            setStatus(text('saved'))
          }

          function reset() {
            setDraft(Object.assign({}, defaults))
            setStatus('')
          }

          function enableAuto() {
            if (api && typeof api.enableAutoTrim === 'function') api.enableAutoTrim()
            setStatus(text('autoCollapseEnabled'))
          }

          function switchRow(key, label, description) {
            var id = 'dsh-ls-' + key
            return react.createElement(
              'div',
              { className: 'dsh-ls-row', key: key },
              react.createElement(
                'div',
                { className: 'dsh-ls-row-copy' },
                react.createElement('div', { id: id + '-label', className: 'dsh-ls-label' }, label),
                react.createElement('p', { id: id + '-desc', className: 'dsh-ls-desc' }, description),
              ),
              react.createElement('button', {
                type: 'button',
                role: 'switch',
                className: 'dsh-ls-switch',
                'aria-checked': draft[key] !== false,
                'aria-labelledby': id + '-label',
                'aria-describedby': id + '-desc',
                onClick: function () {
                  update(key, draft[key] === false)
                },
              }),
            )
          }

          function numberRow(key, label, description, unit) {
            return react.createElement(NumberRow, {
              key: key,
              id: 'dsh-ls-' + key,
              label: label,
              description: description,
              unit: unit,
              value: draft[key],
              onChange: function (value) {
                update(key, value)
              },
            })
          }

          function section(title, children) {
            return react.createElement(
              'section',
              { className: 'dsh-ls-section' },
              react.createElement('h3', { className: 'dsh-ls-section-title' }, title),
              children,
            )
          }

          var pageStats = stats !== null && stats !== undefined ? stats : api.probe()
          var hasSession = pageStats !== null && pageStats.rows > 0
          var statusMain = hasSession
            ? text('statusLoadedShort', { rows: pageStats.rows, turns: pageStats.turns || 0 })
            : text('statusNoSession')
          var statusUnsupported = hasSession && pageStats.turnsKnown !== true && !pageStats.compacted
          var statusSub = statusUnsupported ? text('viewUnsupported') : hasSession && !pageStats.compacted && pageStats.turnsKnown === true && pageStats.turns <= 2 ? text('noOlderHint') : ''
          var badges = []
          if (hasSession) {
            badges.push(
              react.createElement(
                'span',
                {
                  className: 'dsh-ls-badge ' + (pageStats.compacted ? 'dsh-ls-badge-success' : 'dsh-ls-badge-muted'),
                  key: 'state',
                },
                pageStats.compacted ? text('statusCompacted') : text('statusOpen'),
              ),
            )
            if (pageStats.autoTrimDisabled) {
              badges.push(
                react.createElement('span', { className: 'dsh-ls-badge dsh-ls-badge-muted', key: 'auto' }, text('statusAutoOff')),
              )
            }
          }
          var actionState = status !== '' ? status : dirty ? text('unsaved') : ''

          return react.createElement(
            'div',
            { 'data-dsh-longsession-settings': '' },
            react.createElement(
              'header',
              { className: 'dsh-ls-head' },
              react.createElement('h2', { className: 'dsh-ls-title' }, text('settingsTitle')),
              react.createElement('p', { className: 'dsh-ls-intro' }, text('settingsIntro')),
              react.createElement(
                'div',
                { className: 'dsh-ls-summary' },
                react.createElement('span', { className: 'dsh-ls-summary-label' }, text('statusPage')),
                react.createElement('span', { className: 'dsh-ls-summary-value' }, statusMain),
                badges.length === 0 ? null : react.createElement('span', { className: 'dsh-ls-badges' }, badges),
                statusSub === '' ? null : react.createElement('span', { className: 'dsh-ls-summary-sub' }, statusSub),
              ),
            ),
            section(
              text('groupBehavior'),
              react.createElement(
                'div',
                { className: 'dsh-ls-card' },
                switchRow('enabled', text('enabled'), text('enabledDesc')),
                switchRow('showDock', text('showDock'), text('showDockDesc')),
                pageStats !== null && pageStats.autoTrimDisabled
                  ? react.createElement(
                    'div',
                    { className: 'dsh-ls-row', key: 'auto-collapse-off' },
                    react.createElement(
                      'div',
                      { className: 'dsh-ls-row-copy' },
                      react.createElement('div', { className: 'dsh-ls-label' }, text('autoCollapseOffTitle')),
                      react.createElement('p', { className: 'dsh-ls-desc' }, text('autoCollapseOffDesc')),
                    ),
                    react.createElement(
                      'button',
                      { type: 'button', className: 'dsh-ls-btn dsh-ls-btn-secondary', onClick: enableAuto },
                      text('enableAutoCollapse'),
                    ),
                  )
                  : null,
              ),
            ),
            section(
              text('groupThresholds'),
              react.createElement(
                'div',
                { className: 'dsh-ls-card' },
                numberRow('trimMinRows', text('trimMinRows'), text('trimMinRowsDesc'), text('unitRows')),
                numberRow('autoTrimRows', text('autoTrimRows'), text('autoTrimRowsDesc'), text('unitRows')),
              ),
            ),
            section(
              text('groupRequests'),
              react.createElement(
                'div',
                { className: 'dsh-ls-card' },
                numberRow('historyMaxMessages', text('historyMaxMessages'), text('historyMaxMessagesDesc'), text('unitMessages')),
                numberRow('historyMinTurns', text('historyMinTurns'), text('historyMinTurnsDesc'), text('unitTurns')),
                switchRow('historyCapsAllSessions', text('historyCapsAllSessions'), text('historyCapsAllSessionsDesc')),
              ),
            ),
            react.createElement(
              'div',
              { className: 'dsh-ls-actions' },
              react.createElement('span', { className: 'dsh-ls-action-state', 'aria-live': 'polite' }, actionState),
              react.createElement(
                'button',
                { type: 'button', className: 'dsh-ls-btn dsh-ls-btn-secondary', disabled: isDefault, onClick: reset },
                text('reset'),
              ),
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ls-btn dsh-ls-btn-primary',
                  onClick: function () {
                    if (dirty) save()
                    else setStatus(text('saved'))
                  },
                },
                text('save'),
              ),
            ),
            react.createElement('p', { className: 'dsh-ls-foot' }, text('persisted')),
          )
        })
      }

      function probe() {
        var face = sessionFace()
        return {
          version: VERSION,
          sessionId: state.sessionId,
          enabled: state.enabled,
          rows: state.rows,
          turns: state.turns,
          turnsKnown: state.turnsKnown,
          compacted: state.compacted,
          restoring: state.restoring,
          trimming: state.trimming,
          autoTrimDisabled: state.autoTrimDisabled,
          trims: state.trims,
          rewrites: state.rewrites,
          trimAvailable: face !== null,
          running: face !== null && face.running === true,
          trimMinRows: settings.trimMinRows,
          autoTrimRows: settings.autoTrimRows,
          historyMaxMessages: settings.historyMaxMessages,
          historyMinTurns: settings.historyMinTurns,
          headerRegistered: headerRegistration !== null,
          settingsRegistered: settingsRegistration !== null,
          lastTrimReason: state.lastTrimReason || null,
          lastFailure: state.lastFailure,
        }
      }

      function dispose() {
        if (disposed) return
        disposed = true
        if (observeTimer !== 0) {
          window.clearTimeout(observeTimer)
          observeTimer = 0
        }
        if (attachTimer !== 0) {
          window.clearTimeout(attachTimer)
          attachTimer = 0
        }
        if (autoTrimScrollTimer !== 0) {
          window.clearTimeout(autoTrimScrollTimer)
          autoTrimScrollTimer = 0
        }
        window.removeEventListener('scroll', onTranscriptScroll, true)
        if (treeObserver !== null) {
          treeObserver.disconnect()
          treeObserver = null
        }
        if (bodyObserver !== null) {
          bodyObserver.disconnect()
          bodyObserver = null
        }
        if (dotStyleElement !== null && dotStyleElement.parentNode !== null) {
          dotStyleElement.parentNode.removeChild(dotStyleElement)
        }
        dotStyleElement = null
        if (headerRegistration !== null) {
          try {
            headerRegistration()
          } catch (error) {
            /* slot disposal is owned by the fiber; a stale call is harmless */
          }
          headerRegistration = null
        }
        if (settingsRegistration !== null) {
          try {
            settingsRegistration()
          } catch (error) {
            /* slot disposal is owned by the fiber; a stale call is harmless */
          }
          settingsRegistration = null
        }
        state.subscribers = []
        if (wsRegistry.state === state) wsRegistry.state = null
        if (window[GLOBAL_KEY] && window[GLOBAL_KEY].dispose === dispose) {
          try {
            delete window[GLOBAL_KEY]
          } catch (error) {
            window[GLOBAL_KEY] = undefined
          }
        }
      }

      wsRegistry.state = state
      window.addEventListener('scroll', onTranscriptScroll, true)
      attach()
      bodyObserver = new window.MutationObserver(function () {
        if (disposed) return
        if (currentRoot() !== null) scheduleScan()
        else attach()
      })
      bodyObserver.observe(document.body, { childList: true, subtree: true })

      if (ctx && typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sessions'], function (scoped) {
            if (disposed) return
            var sessions = null
            if (scoped !== null && scoped !== undefined) {
              sessions = scoped.sessions
              if (sessions === undefined && typeof scoped.get === 'function') {
                try {
                  sessions = scoped.get('sessions')
                } catch (error) {
                  sessions = null
                }
              }
            }
            state.sessions = sessions === undefined ? null : sessions
            emit()
          })
        } catch (error) {
          state.sessions = null
        }
        if (LongSessionHeaderAction !== null || LongSessionSettings !== null) {
          try {
            ctx.inject(['slots'], function (scoped) {
              if (disposed) return
              var slots = scoped.slots
              if (slots === undefined && typeof scoped.get === 'function') {
                try {
                  slots = scoped.get('slots')
                } catch (error) {
                  slots = null
                }
              }
              if (slots === null || slots === undefined || typeof slots.inject !== 'function') return
              if (LongSessionHeaderAction !== null) {
                try {
                  slots.inject('conversation.session.header.actions', function* () {
                    if (disposed) return
                    var registration = yield slots.register({
                      name: 'conversation.session.header.actions',
                      id: DOCK_ID,
                      order: 5,
                    }, LongSessionHeaderAction)
                    headerRegistration = function () {
                      try {
                        registration()
                      } catch (error) {
                        /* already disposed */
                      }
                    }
                  })
                } catch (error) {
                  headerRegistration = null
                }
              }
              if (LongSessionSettings !== null) {
                try {
                  slots.inject('settings.section', function* () {
                    if (disposed) return
                    var registration = yield slots.register({
                      name: 'settings.section',
                      id: DOCK_ID,
                      order: 20,
                      label: function () {
                        return text('settingsNav')
                      },
                    }, LongSessionSettings)
                    settingsRegistration = function () {
                      try {
                        registration()
                      } catch (error) {
                        /* already disposed */
                      }
                    }
                  })
                } catch (error) {
                  settingsRegistration = null
                }
              }
            })
          } catch (error) {
            headerRegistration = null
            settingsRegistration = null
          }
        }
      }

      window[GLOBAL_KEY] = {
        version: VERSION,
        dispose: dispose,
        probe: probe,
        trim: function () {
          return manualTrim()
        },
        restore: function () {
          return restoreWindow()
        },
        enableAutoTrim: function () {
          return enableAutoCollapse()
        },
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          state.subscribers.push(listener)
          return function () {
            var index = state.subscribers.indexOf(listener)
            if (index >= 0) state.subscribers.splice(index, 1)
          }
        },
        refresh: function () {
          attach()
          scan()
        },
        getConfig: function () {
          return normalizeConfig()
        },
        getDefaults: function () {
          return {
            enabled: true,
            trimMinRows: DEFAULT_TRIM_MIN_ROWS,
            autoTrimRows: DEFAULT_AUTO_TRIM_ROWS,
            historyMaxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
            historyMinTurns: DEFAULT_HISTORY_MIN_TURNS,
            historyCapsAllSessions: DEFAULT_HISTORY_CAPS_ALL_SESSIONS,
            showDock: true,
          }
        },
        setConfig: function (next) {
          var merged = normalizeConfig(next)
          var stored = readStoredConfig()
          stored.enabled = merged.enabled
          stored.trimMinRows = merged.trimMinRows
          stored.autoTrimRows = merged.autoTrimRows
          stored.historyMaxMessages = merged.historyMaxMessages
          stored.historyMinTurns = merged.historyMinTurns
          stored.historyCapsAllSessions = merged.historyCapsAllSessions
          stored.showDock = merged.showDock
          writeStoredConfig(stored)
          settings = merged
          state.settings = merged
          state.enabled = merged.enabled
          state.lastAutoTrimAt = 0
          emit()
        },
      }

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return dispose
        }, 'dsh-longsession: bounded history window')
      } else {
        window.addEventListener('pagehide', dispose, { once: true })
      }
    }

    exports.apply = apply
    exports.inject = []
    exports.version = VERSION
    return module.exports
  },
})







