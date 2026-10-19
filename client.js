/*
 * Portions of this file are derived from ne-ilyxa/dsh-session-drafts
 * (https://github.com/ne-ilyxa/dsh-session-drafts), BSD-3-Clause.
 * See THIRD-PARTY-NOTICES.md for the full license text.
 */

/**
 * dsh-cursor-sessions —— 浏览器半边（Cursor 式会话管理）。
 *
 * 目标（对标 Cursor / Telegram 的会话列表）：
 *   1. 侧边栏里「未发送的草稿会话」显示成一条普通聊天行：标题 = 草稿首行预览
 *      （实时跟随输入），尾随创建时间，灰色标题 + 铅笔标记；
 *   2. 「新建会话」绝不无限堆空占位：先跳到本工作区已有的空草稿，只有所有
 *      草稿都被占用（都写了字）时才真正 mint 一个新会话；
 *   3. 点开任意草稿 → 内核 `shellFor()` 自动从 localStorage 读回未发送文字
 *      （插件不往编辑器里写一个字，因此不碰 Lexical/chip/undo）；
 *   4. 每条草稿行只有一个尾部操作「×」：丢弃草稿（归档会话，日志保留）。
 *
 * 实现要点（与参考实现 @ne-ilyxa/dsh-session-drafts 同一思路，但适配本机
 * Harness 0.2.1-rc.2 的调用链）：
 *
 *   A. 列表投影：把 `sessions.list.getSnapshot()` 的影子方法装到活的 store
 *      对象上（identity 稳定，HMR 安全），把「无已发送 turn」的会话投影成
 *      `blank:false` + 标题。内核私有的 `sessionVisible()` 只读 `session.blank`，
 *      于是草稿自然渲染成原生行；`getSnapshot` 必须保持引用稳定
 *      （同一 state 两次调用返回同一对象），否则 useSyncExternalStore 会无限重渲染，
 *      所以投影按 (stock 快照引用, 投影版本, 语言, 当前会话, 启动守卫) 做 memo。
 *
 *   B. 新建规则：本机 0.2.1 的 New Session 漏斗是
 *      `startSession → openWorkspaceSession → connectBlank`（`connectWorkspace`
 *      只剩启动恢复一处调用）。因此补丁点放在实例方法 `connectBlank` 上：
 *      普通点击（无 options）先找本工作区「最新的空草稿」并 adopt；带 options
 *      的路径保持内核语义（复用第一个 blank，Creator 的草稿保留因此不受影响）。
 *
 *   C. 草稿文字来源：全局真相在内核的 `localStorage["dsh.conversation.<id>"]`
 *      （`{draft:{text,...}}`）。插件只为「当前会话」订阅 `conversation.input`
 *      的 shell state 以获得逐键实时预览（非当前会话没有输入焦点，文字不会变，
 *      读取持久化值即可）。绝不主动为其它会话 `for(scope)`：那会物化一个空
 *      shell 并把持久化草稿抹成空串。
 *
 *   D. 行标识只用 `data-row-key="session:<id>"`（0.2 起内核行上稳定存在）；
 *      文本前缀匹配只作为「染色」兜底，绝不用于功能替换，避免误伤真实会话行。
 *
 * 兼容性降级：任何一步运行时形状不符都只 console.warn 并保持内核原行为，
 * 不抛异常、不阻塞启动。卸载（HMR / 停用插件）时逐个还原影子属性。
 *
 * 本文件是 dsh-client-modules 的浏览器模块格式：`__ModuleLoader__.load({id, factory})`，
 * factory 返回 `{ inject, apply }`。id 必须等于 package.json 的包名。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cursor-sessions',
  factory: function factory(require) {
    'use strict'

    // =========================================================================
    // 0. 常量
    // =========================================================================

    var PLUGIN_ID = 'dsh-cursor-sessions'
    /** 进度注册表：Symbol.for 保证 HMR 换代码后仍共享同一份数据。 */
    var REGISTRY_KEY = Symbol.for(PLUGIN_ID + '/registry')
    /** `uiWorkspace.connectBlank` 的幂等标记（实例自有属性）。 */
    var CONNECT_PATCH = Symbol.for(PLUGIN_ID + '/connect-blank-patch')
    /** `sessions.list` 两个读面的幂等标记（活 store 对象上的自有属性）。 */
    var STORE_PATCH = Symbol.for(PLUGIN_ID + '/sessions-list-patch')
    /** 投影行品牌符号：值是「原始（未投影）行对象」，防止投影吃自己的输出。 */
    var PROJECTED_ROW = Symbol.for(PLUGIN_ID + '/projected-row')

    var STYLE_ID = PLUGIN_ID
    /** 样式标签的归属属性（与内核插件同一约定，便于识别/去重）。 */
    var STYLE_ATTR = 'data-plugin-css'
    /**
     * 草稿行的视觉标记属性。用自定义 data 属性而不是 class：
     * React 每次重渲染都会重写行的 className（selected/menuOpen 等状态变化），
     * 但不会碰它不认识的 data-* 属性 —— 标记因此不会被 React 洗掉。
     * 值：'dirty'（有未发送编辑）| 'empty'（空的当前占位）。
     */
    var DRAFT_ATTR = 'data-dcs-draft'
    var DISCARD_ATTR = 'data-dcs-discard'
    var ROW_KEY_PREFIX = 'session:'

    /** 内核会话草稿的持久化键前缀（ui-conversation 的私有契约，读取失败即降级）。 */
    var CONVERSATION_KEY_PREFIX = 'dsh.conversation.'
    /** 主视图选择指针（ui-workspace 的私有持久化键，仅用于启动守卫）。 */
    var SELECTION_KEY = 'dsh.sessions.current'

    var DICTIONARY_NS = 'cursorSessions'
    var WORD_ROW_TITLE = { en: 'New Session', zh: '新会话' }
    var WORD_DISCARD = { en: 'Discard draft', zh: '丢弃草稿' }

    var PREVIEW_MAX = 60

    /** 共享样式表（用 data 属性防 HMR 重复注入）。 */
    var STYLES = [
      /* 有未发送编辑的草稿：标题从内核的 label-primary（黑/白）降为灰色。
         两重保障：这里用主题 token + 固定灰兜底；installRowMarker 还会写行内样式，
         这样即使样式表选择器被主题/皮肤插件的规则盖掉，颜色依然生效。 */
      '[role="treeitem"][data-dcs-draft="dirty"] > span:nth-child(2){',
      'color:var(--dsw-alias-label-secondary,#8b8b8b);opacity:.72}',
      /* 标题前的「编辑中」小标志：铅笔，轻微呼吸动画（像编辑中/加载中的简化指示）。 */
      '[role="treeitem"][data-dcs-draft="dirty"] > span:nth-child(2)::before{',
      'content:"";display:inline-block;width:12px;height:12px;margin-right:5px;vertical-align:-1px;',
      'background-color:currentColor;',
      '-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3E%3Cpath d=\'M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L5.2 13.6l-3.2.8.8-3.2z\' fill=\'none\' stroke=\'%23000\' stroke-width=\'1.4\' stroke-linejoin=\'round\' stroke-linecap=\'round\'/%3E%3C/svg%3E") center/12px 12px no-repeat;',
      'mask:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3E%3Cpath d=\'M11.3 2.7a1.7 1.7 0 0 1 2.4 2.4L5.2 13.6l-3.2.8.8-3.2z\' fill=\'none\' stroke=\'%23000\' stroke-width=\'1.4\' stroke-linejoin=\'round\' stroke-linecap=\'round\'/%3E%3C/svg%3E") center/12px 12px no-repeat;',
      'animation:dcs-draft-pulse 1.6s ease-in-out infinite}',
      '@keyframes dcs-draft-pulse{0%,100%{opacity:.4}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){',
      '[role="treeitem"][data-dcs-draft="dirty"] > span:nth-child(2)::before{animation:none;opacity:.75}}',
      /* 草稿（有字或空占位）不是聊天：隐藏内核的 ⋯ 菜单 / 归档 / 置顶等所有行内按钮。 */
      '[role="treeitem"][data-dcs-draft] button:not([' + DISCARD_ATTR + ']){display:none!important}',
      /* 唯一的尾部操作：×（与 ⋯ 同一 16px 席位的悬停单元）。 */
      '[role="treeitem"][data-dcs-draft] button[' + DISCARD_ATTR + ']{',
      'flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'width:16px;height:16px;border:0;border-radius:4px;padding:0;background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#9a9a9a);cursor:pointer}',
      '[role="treeitem"][data-dcs-draft] button[' + DISCARD_ATTR + ']:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '[role="treeitem"][data-dcs-draft] button[' + DISCARD_ATTR + ']:focus-visible{',
      'outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:-2px}',
    ].join('')

    /** × 图标：与内核 ⋯ 同尺寸的原生 16px 路径。 */
    var DISCARD_ICON
      = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">'
      + '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.4" '
      + 'stroke-linecap="round"/></svg>'

    // =========================================================================
    // 1. 纯函数区（无 ctx / 无 DOM 副作用；导出给单元测试）
    // =========================================================================

    /** 安全告警：插件任何降级都只走这里，绝不打断宿主。 */
    function warn(message, detail) {
      try {
        if (detail === undefined) console.warn('[cursor-sessions] ' + message)
        else console.warn('[cursor-sessions] ' + message, detail)
      } catch (_) { /* console 不可用时静默 */ }
    }

    function noop() {}

    /**
     * 草稿首行预览：空白折叠成单空格、截断到 max 个字符并在截断处加省略号。
     * 空文本返回 undefined（没有可显示的内容）。
     * @param {string} text 草稿原文
     * @param {number} [max] 最大字符数
     * @returns {string|undefined}
     */
    function draftPreview(text, max) {
      if (typeof text !== 'string') return undefined
      var limit = typeof max === 'number' && max > 0 ? max : PREVIEW_MAX
      var collapsed = text.replace(/\s+/g, ' ').trim()
      if (collapsed === '') return undefined
      return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit).trimEnd() + '\u2026'
    }

    /**
     * 解析内核持久化的草稿对象，取出纯文本。
     * 形状（0.2.x）：`{draft:{text,references,command?},view,viewRequest}`；
     * 兼容更早的字符串形状 `{draft:"..."}`。任何异常都视为没有草稿。
     * @param {unknown} stored JSON.parse 后的值
     * @returns {string}
     */
    function draftTextOf(stored) {
      if (typeof stored !== 'object' || stored === null) return ''
      var draft = stored.draft
      if (typeof draft === 'string') return draft
      if (typeof draft === 'object' && draft !== null && typeof draft.text === 'string') return draft.text
      return ''
    }

    /**
     * 读取某个会话已持久化的草稿文本（同步，失败降级为空串）。
     * 只读内核私有键；读不到时功能降级（标题回退「新会话」、复用视为空），
     * 绝不会因为格式变化抛错。
     * @param {string} sessionId 会话 id
     * @returns {string}
     */
    function storedDraftText(sessionId) {
      try {
        if (typeof localStorage === 'undefined') return ''
        var raw = localStorage.getItem(CONVERSATION_KEY_PREFIX + sessionId)
        if (raw === null) return ''
        return draftTextOf(JSON.parse(raw))
      } catch (_) {
        return ''
      }
    }

    /**
     * 判断一行是否是「草稿」：没有已发送 turn 的会话（子代理会话永远不是）。
     *
     * 三个信息源，按可信度排序：
     * - `summary.blank === true`：客户端认为它从未被 engage（本页从未打开过）；
     * - `projectionValues.sessionListMetadata.blank === true`：Host 的真相
     *   （「折叠前缀里没有任何 turn」），已打开但没发过消息的会话靠它识别；
     * - 两者都没有 → 不投影（保守：不知道就不动内核数据）。
     *
     * @param {object|undefined} summary sessions.list 快照中的一行
     * @returns {boolean}
     */
    function isDraftSummary(summary) {
      if (summary === undefined || summary === null) return false
      if (summary.origin === 'subagent') return false
      if (summary.blank === true) return true
      var metadata = summary.projectionValues ? summary.projectionValues.sessionListMetadata : undefined
      return metadata !== undefined && metadata !== null && metadata.blank === true
    }

    /**
     * 当前（主视图正在 retain 的）会话 id：与内核 `mainSessionId()` 同一判据
     * ——`retainedBy.mainView > 0` 的那一行；旧快照的 `current` 字段做兜底。
     * @param {object} list sessions.list 快照
     * @returns {string|undefined}
     */
    function currentSessionIdOf(list) {
      if (list === undefined || list === null) return undefined
      var byId = list.byId || {}
      var ids = list.ids || []
      for (var i = 0; i < ids.length; i += 1) {
        var summary = byId[ids[i]]
        if (summary === undefined) continue
        var retained = summary.retainedBy ? summary.retainedBy.mainView : undefined
        if (typeof retained === 'number' && retained > 0) return summary.id
      }
      if (typeof list.current === 'string') return list.current
      return undefined
    }

    /**
     * 投影单行：草稿行需要的全部字段改写。
     * @param {object} base 原始（未投影）行
     * @param {string} title 投影标题
     * @returns {object} 投影后的新行（携带品牌符号）
     */
    function projectedRowOf(base, title) {
      var row = {}
      var key
      for (key in base) {
        if (Object.prototype.hasOwnProperty.call(base, key)) row[key] = base[key]
      }
      row.blank = false
      row.title = title
      row.displayTitle = title
      row[PROJECTED_ROW] = base // 品牌：再投影时用原始行，而不是自己的输出
      return row
    }

    /**
     * 把内核快照投影成「草稿聊天列表」。
     *
     * 规则（Cursor 语义 + 本机历史包袱的折中）：
     * - 草稿且「有文字 / 已被打开过 / 就是当前会话」→ 投影成普通行；
     * - 草稿但为空且不是当前会话 → 不投影（内核本来就会隐藏它；本机历史上有
     *   大量遗留空 blank，全部列出来会像垃圾行。新建会话时仍会「复用」它，
     *   复用后成为当前会话即重新可见）；
     * - 启动守卫命中的会话先不投影：让内核 `restoreSelection` 走
     *   `restoreBlank → sessions.create({sessionId})` 的正式恢复通道
     *   （直接打开冷 blank 不走 claim/resume，首条消息可能失败）；
     * - 其余行原样返回；没有可投影行时返回**原快照对象**，保证引用稳定。
     *
     * @param {object} stock 内核原始快照
     * @param {Map<string,string>} previews sessionId → 草稿预览
     * @param {string} fallbackTitle 「新会话」的本地化标题
     * @param {{currentId?: string, bootGuardId?: string, bootGuardActive?: boolean}} view
     * @returns {object} 投影后的快照（或原快照）
     */
    function projectDraftList(stock, previews, fallbackTitle, view) {
      if (stock === undefined || stock === null) return stock
      var options = view || {}
      var currentId = options.currentId
      var changed = false
      var byId = {}
      var ids = stock.ids || []
      var stockById = stock.byId || {}
      var index
      for (index = 0; index < ids.length; index += 1) byId[ids[index]] = stockById[ids[index]]
      for (index = 0; index < ids.length; index += 1) {
        var id = ids[index]
        var summary = stockById[id]
        if (summary === undefined) continue
        // HMR 情况下输入可能已经是本插件的投影结果：一律回到原始行再算。
        var base = summary[PROJECTED_ROW] !== undefined ? summary[PROJECTED_ROW] : summary
        if (!isDraftSummary(base)) continue
        var preview = previews ? previews.get(id) : undefined
        var hasText = typeof preview === 'string' && preview !== ''
        var engaged = base.blank === false // 本页已打开过：内核自己会显示它
        var isCurrent = id === currentId
        if (options.bootGuardActive === true && id === options.bootGuardId && !isCurrent && base.blank === true) continue
        if (!hasText && !engaged && !isCurrent) continue
        // 用户显式重命名过草稿 → 用用户标题；否则预览；再否则「新会话」。
        var pinned = typeof base.title === 'string' && base.title !== ''
          ? (base.displayTitle || base.title)
          : undefined
        var title = pinned !== undefined ? pinned : (hasText ? preview : fallbackTitle)
        byId[id] = projectedRowOf(base, title)
        changed = true
      }
      if (!changed) return stock
      var output = {}
      for (var key in stock) {
        if (Object.prototype.hasOwnProperty.call(stock, key)) output[key] = stock[key]
      }
      output.byId = byId
      return output
    }

    /**
     * 从投影结果里提取「sessionId → 标题」映射，供 DOM 标记匹配行。
     * 只统计真正被改写过的行（其余保持原引用）。
     * @param {object} stock 原始快照
     * @param {object} projected 投影结果
     * @returns {Map<string,string>}
     */
    function titlesOfProjection(stock, projected) {
      var titles = new Map()
      if (projected === stock || projected === undefined || projected === null) return titles
      var ids = projected.ids || []
      for (var i = 0; i < ids.length; i += 1) {
        var id = ids[i]
        if (projected.byId[id] !== stock.byId[id]) titles.set(id, projected.byId[id].title)
      }
      return titles
    }

    /**
     * 在某个工作区里找「可复用的草稿」。
     *
     * 守卫（与内核 createInWorkspace 对齐）：必须是该工作区成员、未归档、
     * cwd 与工作区路径一致（双方都已知时）、非子代理会话。
     *
     * 两种模式：
     * - `onlyEmpty: true`（普通「新建会话」）：只接受**没有未发送文字**的草稿，
     *   取最新一枚（updatedAt 降序，id 升序做确定性 tiebreak）。这就是
     *   「空占位永不堆叠」：写字的草稿原地保留，点击新建才另起一枚。
     * - `onlyEmpty: false`（带 options 的路径，如 Creator 的
     *   clearPreviousDraft:false）：保持内核语义，复用第一个 blank（不论文字），
     *   从而不破坏内核自己的草稿保留能力。
     *
     * @param {object} stock 原始会话快照
     * @param {object} workspaceSnapshot workspaces.list 快照
     * @param {Map<string,string>} previews 草稿预览
     * @param {string} workspaceId 目标工作区
     * @param {{onlyEmpty: boolean}} options
     * @returns {object|undefined} 命中的原始行
     */
    function findReusableDraft(stock, workspaceSnapshot, previews, workspaceId, options) {
      if (stock === undefined || stock === null) return undefined
      if (workspaceSnapshot === undefined || workspaceSnapshot === null) return undefined
      var items = workspaceSnapshot.items || []
      var workspace
      for (var i = 0; i < items.length; i += 1) {
        if (items[i] !== undefined && items[i].workspaceId === workspaceId) { workspace = items[i]; break }
      }
      if (workspace === undefined) return undefined
      var archived = new Set(workspaceSnapshot.archivedSessionIds || [])
      var members = new Set(workspace.sessionIds || [])
      var onlyEmpty = options === undefined || options.onlyEmpty !== false
      var best
      var ids = stock.ids || []
      for (var index = 0; index < ids.length; index += 1) {
        var id = ids[index]
        var summary = stock.byId ? stock.byId[id] : undefined
        if (summary === undefined || summary === null) continue
        if (!members.has(id) || archived.has(id)) continue
        if (summary.origin === 'subagent') continue
        if (workspace.path !== undefined && summary.cwd !== workspace.path) continue
        if (onlyEmpty) {
          if (!isDraftSummary(summary)) continue
          // 有未发送文字 = 被占用：它的内容留在原地，这一行继续作为草稿行展示。
          if (previews !== undefined && previews !== null && previews.has(id)) continue
        } else if (summary.blank !== true) {
          // 与内核 createInWorkspace 完全一致的 blank 判定（不看投影/engagement）
          continue
        }
        if (best === undefined
          || summary.updatedAt > best.updatedAt
          || (summary.updatedAt === best.updatedAt && summary.id < best.id)) {
          best = summary
        }
      }
      return best
    }

    /**
     * 新建会话快捷键：Ctrl+Alt+N。
     *
     * 细节：
     * - 按物理键 `event.code === 'KeyN'` 匹配（俄语等布局下 event.key 不是 n）；
     * - 拒绝 auto-repeat（按住键会每 ~30ms 触发一次 mint）；
     * - 跳过 IME 组合中的按键；
     * - 故意不判断 AltGraph：Linux/Firefox 把 AltGr 报成 Ctrl+Alt。
     *
     * @param {KeyboardEvent|object} event
     * @returns {boolean}
     */
    function matchNewSessionHotkey(event) {
      if (event === undefined || event === null) return false
      if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return false
      if (event.isComposing === true || event.repeat === true) return false
      if (event.code === 'KeyN') return true
      if (event.code !== undefined) return false
      return String(event.key || '').toLowerCase() === 'n'
    }

    /**
     * 从实际 DOM 行上解析会话 id：只用内核 0.2 起渲染的显式
     * `data-row-key="session:<id>"`（行身份不依赖文案，换语言也不受影响）。
     * @param {Element} row
     * @returns {string|undefined}
     */
    function sessionIdOfRow(row) {
      try {
        var key = row.getAttribute('data-row-key')
        if (key === null || key.indexOf(ROW_KEY_PREFIX) !== 0) return undefined
        var id = key.slice(ROW_KEY_PREFIX.length)
        return id === '' ? undefined : id
      } catch (_) {
        return undefined
      }
    }

    /**
     * 一条已渲染的会话行应该如何标记（纯函数，供 DOM 标记与测试共用）。
     *
     * - `none`：不是草稿行（普通聊天/子代理/未投影行）→ 不标记；
     * - `dirty`：草稿且**有未发送文字** → 灰色标题 + 「编辑中」小标志（用户要的区分）；
     * - `empty`：草稿但没有文字（当前「新会话」占位）→ 保持正常颜色，只保留草稿语义
     *   （隐藏 ⋯ 菜单、提供 ×；见 installRowMarker）。
     *
     * @param {string|undefined} sessionId 行身份
     * @param {Map<string,string>} titles 投影标题集合（registry.titles）
     * @param {Map<string,string>} previews 有未发送文字的草稿集合（registry.previews）
     * @returns {'none'|'dirty'|'empty'}
     */
    function draftRowState(sessionId, titles, previews) {
      if (sessionId === undefined || titles === undefined || !titles.has(sessionId)) return 'none'
      return previews !== undefined && previews.has(sessionId) ? 'dirty' : 'empty'
    }

    /**
     * 取 DOM 节点上的 React fiber（渲染器私有键 `__reactFiber$<hash>`）。
     * 第三方面板（如 dsh-better-workspace）的行不带 `data-row-key`，只能像参考实现
     * 那样从 fiber 的组件 props 里拿会话 id。任何形状漂移都返回 undefined。
     * @param {Element} node
     * @returns {object|undefined}
     */
    function reactFiberOf(node) {
      try {
        var keys = Object.keys(node)
        for (var i = 0; i < keys.length; i += 1) {
          if (keys[i].indexOf('__reactFiber$') === 0) return node[keys[i]]
        }
      } catch (_) { /* ignore */ }
      return undefined
    }

    /**
     * 沿 fiber return 链向上找 `memoizedProps.node.id`（内核 SessionNodeItem 与
     * dsh-better-workspace 的 SessionRow 都把派生节点放在 `props.node` 上）。
     * 纯函数：可对假 fiber 链测试。
     * @param {object|undefined} start
     * @param {number} [maxHops]
     * @returns {string|undefined}
     */
    function findSessionIdFromFiber(start, maxHops) {
      var fiber = start
      var limit = typeof maxHops === 'number' && maxHops > 0 ? maxHops : 18
      for (var hops = 0; hops < limit && fiber !== undefined && fiber !== null; hops += 1) {
        try {
          var props = fiber.memoizedProps
          var node = props !== undefined && props !== null ? props.node : undefined
          var id = node !== undefined && node !== null ? node.id : undefined
          if (typeof id === 'string' && id !== '') return id
        } catch (_) { /* ignore */ }
        fiber = fiber.return
      }
      return undefined
    }

    /**
     * 行的会话 id：优先原生 `data-row-key`，否则走 fiber。
     * @param {Element} row
     * @returns {string|undefined}
     */
    function rowSessionId(row) {
      var fromKey = sessionIdOfRow(row)
      if (fromKey !== undefined) return fromKey
      try {
        return findSessionIdFromFiber(reactFiberOf(row))
      } catch (_) {
        return undefined
      }
    }

    // =========================================================================
    // 2. 跨代注册表（Symbol.for：HMR 后仍共享）
    // =========================================================================

    /**
     * 注册表字段：
     * - `previews`：sessionId → 草稿预览（当前会话逐键更新；其它会话来自 localStorage）
     * - `version`：投影数据版本，投影 memo 的键之一
     * - `titles`：sessionId → 投影标题（DOM 标记的匹配集合）
     * - `listeners`：影子 subscribe 之后的订阅者（内核旧订阅者走原始 subscribe）
     * - `cache`：getSnapshot 的 memo（引用稳定的关键）
     * - `stockGet`：原始（未投影）快照读取口——插件内部推导只看原始数据
     * - `restoreStore`：影子还原器（卸载/HMR 最后一代离开时调用）
     * - `storeInstalls` / `connectInstalls`：多代并存时的引用计数
     * - `restoreConnect` / `restoreConnectFor`：connectBlank 补丁还原
     * - `rescan`：DOM 标记的重扫入口
     * - `bump`：投影数据变化后的统一通知（retitle + 唤醒 + 重扫）
     * - `bootGuard`：启动恢复保护（见 projectDraftList）
     * @returns {object}
     */
    function draftRegistry() {
      var holder = globalThis
      if (holder[REGISTRY_KEY] === undefined) {
        holder[REGISTRY_KEY] = {
          previews: new Map(),
          titles: new Map(),
          version: 0,
          listeners: new Set(),
          cache: { stock: undefined, version: -1, title: '', currentId: undefined, bootActive: true, output: undefined },
          stockGet: undefined,
          restoreStore: undefined,
          storeInstalls: 0,
          connectInstalls: 0,
          restoreConnect: undefined,
          rescan: undefined,
          bump: undefined,
          bootGuard: { id: undefined, active: false },
        }
      }
      return holder[REGISTRY_KEY]
    }

    /** 读取启动时保存的会话选择指针（私有键；读不到就当作没有守卫目标）。 */
    function readBootSelectionId() {
      try {
        if (typeof localStorage === 'undefined') return undefined
        var raw = localStorage.getItem(SELECTION_KEY)
        if (raw === null) return undefined
        var parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return undefined
        return typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : undefined
      } catch (_) {
        return undefined
      }
    }

    // =========================================================================
    // 3. 列表投影安装（影子 sessions.list.getSnapshot/subscribe）
    // =========================================================================

    /**
     * 在活的 sessions service 上安装草稿投影。
     *
     * 为什么是「影子实例方法」而不是包裹 service：
     * - `sessions.list` 在服务构造时创建一次，所有读者（React bridge、内核
     *   自己的 `mainSessionId`、搜索、分组……）都持有同一个 store 引用；
     * - store 是普通对象字面量，`getSnapshot`/`subscribe` 是自有属性，可原地替换；
     * - 被冻结的是快照 state，不是 store。
     *
     * 注意：投影会改变内核内部读者看到的数据（这正是让私有 `sessionVisible`
     * 放行草稿行的办法），因此插件自己的一切推导都必须走 `registry.stockGet`。
     *
     * @param {{sessions: object, conversation: object, workspaces: object, fallbackTitle: function}} deps
     * @returns {function} 卸载函数
     */
    function installDraftProjection(deps) {
      var sessions = deps.sessions
      var conversation = deps.conversation
      var workspaces = deps.workspaces
      var store = sessions === undefined || sessions === null ? undefined : sessions.list
      if (store === undefined || store === null
        || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') {
        warn('sessions.list 形状不支持，草稿行保持内核默认（隐藏）')
        return noop
      }

      var registry = draftRegistry()
      if (registry.bootGuard.id === undefined && !registry.bootGuard.active) {
        var bootId = readBootSelectionId()
        if (bootId !== undefined) {
          registry.bootGuard.id = bootId
          registry.bootGuard.active = true
        }
      }
      registry.storeInstalls += 1

      // ---- 3.1 影子 store（只装一次；多代并存时引用计数） -------------------
      if (store[STORE_PATCH] === undefined) {
        var record = { getSnapshot: store.getSnapshot, subscribe: store.subscribe }
        var wasOwnGet = Object.prototype.hasOwnProperty.call(store, 'getSnapshot')
        var wasOwnSub = Object.prototype.hasOwnProperty.call(store, 'subscribe')
        var originalGet = record.getSnapshot.bind(store)
        var originalSubscribe = record.subscribe.bind(store)

        /** 投影后的 getSnapshot：memo 保证同一 state 返回同一引用。 */
        var projectedGet = function projectedGet() {
          var stock = originalGet()
          var title = deps.fallbackTitle()
          var currentId = currentSessionIdOf(stock)
          var bootActive = registry.bootGuard.active === true
          var memo = registry.cache
          if (memo.stock === stock && memo.version === registry.version
            && memo.title === title && memo.currentId === currentId && memo.bootActive === bootActive) {
            return memo.output
          }
          var output = projectDraftList(stock, registry.previews, title, {
            currentId: currentId,
            bootGuardId: registry.bootGuard.id,
            bootGuardActive: bootActive,
          })
          registry.cache = {
            stock: stock,
            version: registry.version,
            title: title,
            currentId: currentId,
            bootActive: bootActive,
            output: output,
          }
          return output
        }

        /** 投影后的 subscribe：额外把订阅者登进 registry.listeners（供 bump 唤醒）。 */
        var projectedSubscribe = function projectedSubscribe(fn) {
          registry.listeners.add(fn)
          var off = originalSubscribe(fn)
          var done = false
          return function unsubscribe() {
            if (done) return
            done = true
            registry.listeners.delete(fn)
            off()
          }
        }

        store[STORE_PATCH] = record
        store.getSnapshot = projectedGet
        store.subscribe = projectedSubscribe
        registry.stockGet = originalGet
        registry.restoreStore = function restoreStore() {
          if (store[STORE_PATCH] !== record) return
          if (wasOwnGet) store.getSnapshot = record.getSnapshot
          else delete store.getSnapshot
          if (wasOwnSub) store.subscribe = record.subscribe
          else delete store.subscribe
          delete store[STORE_PATCH]
          // 保留 registry.stockGet：HMR 的新一代仍需要它读原始快照。
        }
      }

      /** 原始快照：插件内部的一切推导都必须从这里读。 */
      var stockSnapshot = function stockSnapshot() {
        return registry.stockGet !== undefined ? registry.stockGet() : store.getSnapshot()
      }

      /** 原始快照的工作区视图（归档集合/成员关系）。 */
      var workspacesSnapshot = function workspacesSnapshot() {
        try {
          return workspaces.list.getSnapshot()
        } catch (_) {
          return { items: [], archivedSessionIds: [] }
        }
      }

      /** 只读取原始快照、不用投影数据的重算入口。 */
      var computeTitles = function computeTitles(stock) {
        var projected = projectDraftList(stock, registry.previews, deps.fallbackTitle(), {
          currentId: currentSessionIdOf(stock),
          bootGuardId: registry.bootGuard.id,
          bootGuardActive: registry.bootGuard.active === true,
        })
        return titlesOfProjection(stock, projected)
      }

      /** 唤醒内核的原始订阅者：overlay-only 变化（比如打字）不会触发 store.set。 */
      var wakeRaw = function wakeRaw() {
        try {
          var raw = registry.stockGet !== undefined ? registry.stockGet() : undefined
          if (raw !== undefined && typeof store.set === 'function') {
            // 内容与原始真相一致，只是换一个引用：这是一次通知，不是一次写。
            store.set(Object.assign({}, raw))
          }
        } catch (_) {
          // store 拒绝外部写时只损失「逐键实时」延迟，下一次宿主更新照样刷新。
        }
      }

      /** 数据变化：bump 版本 → 重算标题 → 唤醒引擎/DOM。 */
      var bump = function bump() {
        registry.version += 1
        registry.titles = computeTitles(stockSnapshot())
        wakeRaw()
        registry.listeners.forEach(function (fn) {
          try { fn() } catch (error) { warn('投影订阅者抛错', error) }
        })
        if (typeof registry.rescan === 'function') registry.rescan()
      }
      registry.bump = bump

      // ---- 3.2 预览同步（只订阅「当前会话」的输入 shell） --------------------
      var shell = { id: undefined, off: undefined }

      var syncPreview = function syncPreview(id, state) {
        var text
        try {
          text = state.getSnapshot().draft
        } catch (_) {
          return
        }
        var preview = draftPreview(text)
        var previous = registry.previews.get(id)
        if (preview === undefined) {
          if (previous !== undefined) {
            registry.previews.delete(id)
            bump()
          }
          return
        }
        if (previous !== preview) {
          registry.previews.set(id, preview)
          bump()
        }
      }

      /** 把 shell 订阅对齐到「当前会话是草稿」这一事实。 */
      var syncShell = function syncShell(stock) {
        var currentId = currentSessionIdOf(stock)
        var summary = currentId === undefined ? undefined : stock.byId[currentId]
        var wanted = summary !== undefined && isDraftSummary(summary) ? currentId : undefined
        if (wanted === shell.id) return
        // 先解绑旧的（session 不再是草稿 / 切换了会话）。
        if (shell.off !== undefined) {
          try { shell.off() } catch (_) { /* ignore */ }
          shell.off = undefined
          shell.id = undefined
        }
        if (wanted === undefined) return
        try {
          // 只有当前会话有输入焦点：其它会话的文字不会变，读持久化值即可。
          // 绝不能对非保留会话调用 for(scope)：会物化空 shell 并抹掉持久化草稿。
          var scope = typeof sessions.scope === 'function' ? sessions.scope(wanted) : undefined
          if (scope === undefined) return
          var facade = conversation !== undefined && conversation !== null && conversation.input !== undefined
            ? conversation.input.for(scope)
            : undefined
          if (facade === undefined || facade.state === undefined) return
          shell.id = wanted
          shell.off = facade.state.subscribe(function () { syncPreview(wanted, facade.state) })
          syncPreview(wanted, facade.state) // 立即播种一次
        } catch (error) {
          // 输入 shell 还没物化（启动竞态）：下一次列表变化再试。
          warn('无法订阅输入框预览（下一次列表变化会重试）', error)
        }
      }

      // ---- 3.3 种子 / 修剪：从 localStorage 恢复所有草稿预览 ----------------
      /**
       * 草稿文字的内核真相在 localStorage；列表阶段先把它们读进 previews，
       * 这样：刷新后标题立即可用（不等 shell 物化）、复用判定也能识别「被占用」。
       * 修剪只依据「正面知识」：行存在且已不再是草稿（首条消息发出），才删预览；
       * 行暂时缺失（启动竞态/RPC 空档）一律保留，避免把持久化草稿误删。
       */
      var seedAndPrune = function seedAndPrune(stock) {
        var workspaceSnapshot = workspacesSnapshot()
        var archived = new Set(workspaceSnapshot.archivedSessionIds || [])
        var drafts = new Set()
        var ids = stock.ids || []
        var index
        for (index = 0; index < ids.length; index += 1) {
          var id = ids[index]
          var summary = stock.byId ? stock.byId[id] : undefined
          if (summary !== undefined && isDraftSummary(summary) && !archived.has(id)) drafts.add(id)
        }
        var dirty = false
        drafts.forEach(function (id) {
          if (registry.previews.has(id)) return
          /**
           * 当前会话的输入 shell 才是实时权威，不能用持久化值回填。
           *
           * 内核 `publish()` 的顺序是「先 state.set(新内容)，再 persistDraft(新内容)」，
           * 而本函数跑在 state.set 的同步通知链里（bump → wakeRaw → 列表订阅者）。
           * 用户「删光」时：我们刚把 previews 里的旧预览删掉，localStorage 里却还
           * 躺着上一版文字 —— 若此时按持久化值回填，旧标题就会被「复活」，并且
           * 之后没有任何事件再把它清掉（persistDraft 写空串不会触发列表变化）。
           * 结果就是标题永远回不到「新会话」。shell.id === id 说明这枚草稿正被
           * 我们实时订阅，跳过种子即可（它自己的 syncPreview 已经处理了空值）。
           */
          if (shell.id === id) return
          var preview = draftPreview(storedDraftText(id))
          if (preview !== undefined) {
            registry.previews.set(id, preview)
            dirty = true
          }
        })
        Array.prototype.slice.call(registry.previews.keys()).forEach(function (id) {
          var summary = stock.byId ? stock.byId[id] : undefined
          if (summary === undefined) return // 未知：保留
          if (!isDraftSummary(summary) || archived.has(id)) {
            registry.previews.delete(id)
            dirty = true
          }
        })
        return dirty
      }

      // ---- 3.4 启动守卫解除 ------------------------------------------------
      /**
       * 启动恢复只对「保存的选择指针」生效。投影把 blank 改成 false 会让内核
       * restoreSelection 走「直接 replaceMain」而不是 restoreBlank（claim/resume），
       * 冷 blank 直接打开可能拿不到 agent。守卫在三种情况下解除：
       * 该会话被 retain 为主视图（说明恢复已完成）、blank 已翻 false（已发消息）、
       * 或安装 4 秒后（兜底，避免坏数据把草稿永久藏起来）。
       */
      var maybeReleaseBootGuard = function maybeReleaseBootGuard(stock) {
        var guard = registry.bootGuard
        if (guard.active !== true) return
        var summary = guard.id === undefined ? undefined : (stock.byId ? stock.byId[guard.id] : undefined)
        var retained = summary !== undefined && summary.retainedBy !== undefined
          && typeof summary.retainedBy.mainView === 'number' && summary.retainedBy.mainView > 0
        var graduated = summary !== undefined && !isDraftSummary(summary)
        if (guard.id === undefined || retained || graduated) {
          guard.active = false
          bump()
        }
      }

      // ---- 3.5 汇总一次「列表变了」的响应 --------------------------------
      var reconcile = function reconcile() {
        var stock = stockSnapshot()
        var seeded = seedAndPrune(stock)
        registry.titles = computeTitles(stock)
        syncShell(stock)
        maybeReleaseBootGuard(stock)
        if (seeded) bump()
        if (typeof registry.rescan === 'function') registry.rescan()
      }

      // 内核列表变化：新 blank、首条消息发出（blank 翻 false）、归档等。
      // 用影子 subscribe 订阅：同时把 reconcile 登进 listeners，bump 时也会同步。
      var offStock = store.subscribe(reconcile)
      reconcile()

      var bootTimer = setTimeout(function () {
        if (registry.bootGuard.active === true) {
          registry.bootGuard.active = false
          bump()
        }
      }, 4000)
      try { if (typeof bootTimer === 'object' && bootTimer !== null && typeof bootTimer.unref === 'function') bootTimer.unref() } catch (_) { /* 浏览器无 unref */ }

      return function disposeProjection() {
        try { clearTimeout(bootTimer) } catch (_) { /* ignore */ }
        offStock()
        if (shell.off !== undefined) {
          try { shell.off() } catch (_) { /* ignore */ }
          shell.off = undefined
          shell.id = undefined
        }
        if (registry.bump === bump) registry.bump = undefined
        registry.storeInstalls = Math.max(0, registry.storeInstalls - 1)
        if (registry.storeInstalls === 0 && registry.restoreStore !== undefined) {
          registry.restoreStore()
          registry.restoreStore = undefined
        }
      }
    }

    // =========================================================================
    // 4. 新建会话规则安装（补丁 connectBlank）
    // =========================================================================

    /**
     * 在 uiWorkspace 实例上补丁 `connectBlank`（本机 0.2.1 的 New Session 漏斗）。
     *
     * 为什么不用参考仓库补丁的 `connectWorkspace`：0.2.1 中
     * `startSession → openWorkspaceSession → connectBlank`，`connectWorkspace`
     * 只剩启动恢复一处调用点，补它等于没补。
     *
     * 规则：
     * - 普通「新建会话」（reuse === undefined）：先 adopt 本工作区最新空草稿；
     *   所有草稿都有文字才 `sessions.create({workspaceId})` mint 新会话。
     * - 带 options 的路径（Creator 的草稿保留等）：保持内核语义（复用第一个
     *   blank），避免破坏内核既有能力。
     * - `session/writer-held`（并发点击/另一个标签页已占用写句柄）→ 直接返回
     *   该草稿 id：调用方随后 replaceMain 打开它，与内核 restoreBlank 的兜底一致。
     *
     * @param {{uiWorkspace: object, sessions: object, workspaces: object}} deps
     * @returns {function} 卸载函数
     */
    function installNewSessionRule(deps) {
      var uiWorkspace = deps.uiWorkspace
      var sessions = deps.sessions
      var workspaces = deps.workspaces
      if (uiWorkspace === undefined || uiWorkspace === null
        || typeof uiWorkspace.connectBlank !== 'function'
        || sessions === undefined || sessions === null || typeof sessions.create !== 'function') {
        warn('连接/创建 API 形状不支持，新建会话保持内核默认行为')
        return noop
      }

      var registry = draftRegistry()
      if (uiWorkspace[CONNECT_PATCH] !== undefined) {
        registry.connectInstalls += 1
        return function disposeAdopted() {
          registry.connectInstalls = Math.max(0, registry.connectInstalls - 1)
          if (registry.connectInstalls === 0 && registry.restoreConnect !== undefined) {
            registry.restoreConnect()
            registry.restoreConnect = undefined
          }
        }
      }

      var wasOwn = Object.prototype.hasOwnProperty.call(uiWorkspace, 'connectBlank')
      // 保存原始方法对象（不 bind）：卸载时原样放回，保证引用等价。
      var original = uiWorkspace.connectBlank
      var inflight = new Map()

      var stockSnapshot = function stockSnapshot() {
        return registry.stockGet !== undefined ? registry.stockGet() : sessions.list.getSnapshot()
      }
      var workspacesSnapshot = function workspacesSnapshot() {
        try { return workspaces.list.getSnapshot() } catch (_) { return { items: [], archivedSessionIds: [] } }
      }
      var writerHeld = function writerHeld(error) {
        return typeof error === 'object' && error !== null
          && error.rpcError !== undefined && error.rpcError !== null
          && error.rpcError.code === 'session/writer-held'
      }

      /** 一次连接的完整规则。 */
      var connectOnce = function connectOnce(workspaceId, reuse) {
        var workspaceSnapshot = workspacesSnapshot()
        var workspace
        var items = workspaceSnapshot.items || []
        for (var i = 0; i < items.length; i += 1) {
          if (items[i] !== undefined && items[i].workspaceId === workspaceId) { workspace = items[i]; break }
        }
        if (workspace === undefined) {
          // 与内核同文案，调用方在 UI 上已有对应错误展示。
          return Promise.reject(new Error('uiWorkspace.connectWorkspace: unknown workspace ' + workspaceId))
        }
        var preset = reuse !== undefined && reuse !== null && typeof reuse === 'object' ? reuse.agentPreset : undefined
        var request = { workspaceId: workspaceId }
        if (preset !== undefined) request.agentPreset = preset
        var candidate = findReusableDraft(
          stockSnapshot(),
          workspaceSnapshot,
          registry.previews,
          workspaceId,
          { onlyEmpty: reuse === undefined },
        )
        if (candidate === undefined) return sessions.create(request)
        var adoption = Object.assign({}, request, { sessionId: candidate.id })
        return sessions.create(adoption).then(function (sessionId) {
          // Host 拒绝采用时可能返回一个新 id；照常返回即可（旧草稿保持原样）。
          return sessionId
        }, function (error) {
          if (writerHeld(error)) return candidate.id
          throw error
        })
      }

      /** 每工作区 + 每 preset 的在途去重：双击折叠成一次连接。 */
      var patched = function patchedConnectBlank(workspaceId, reuse) {
        var preset = reuse !== undefined && reuse !== null && typeof reuse === 'object' ? reuse.agentPreset : undefined
        var key = String(workspaceId) + '\u0000' + String(preset === undefined ? '' : preset)
        var pending = inflight.get(key)
        if (pending !== undefined) return pending
        var attempt = connectOnce(workspaceId, reuse).then(function (value) {
          inflight.delete(key)
          return value
        }, function (error) {
          inflight.delete(key)
          throw error
        })
        inflight.set(key, attempt)
        return attempt
      }

      uiWorkspace[CONNECT_PATCH] = { original: original, patched: patched }
      uiWorkspace.connectBlank = patched
      registry.connectInstalls += 1
      registry.restoreConnect = function restoreConnect() {
        if (uiWorkspace[CONNECT_PATCH] === undefined) return
        if (wasOwn) uiWorkspace.connectBlank = original
        else delete uiWorkspace.connectBlank
        delete uiWorkspace[CONNECT_PATCH]
      }

      return function disposeNewSessionRule() {
        registry.connectInstalls = Math.max(0, registry.connectInstalls - 1)
        if (registry.connectInstalls === 0 && registry.restoreConnect !== undefined) {
          registry.restoreConnect()
          registry.restoreConnect = undefined
        }
      }
    }

    // =========================================================================
    // 5. DOM 行标记（灰色标题 + 铅笔 + 唯一 ×）
    // =========================================================================

    /**
     * 行渲染器在 bundle 内部、没有行级 Slot，因此视觉身份只能从外部画。
     *
     * 本机侧边栏有两套可能的行 DOM：
     * - 内核原生行：`div[role=treeitem][data-row-key="session:<id>"]`，标题是第 2 个 span；
     * - `dsh-better-workspace` 接管后的行（本机桌面 profile 正在用它）：
     *   `div[role=treeitem].bw-row.bw-session-row`，标题是 `.bw-row-label`，
     *   操作区是 `.bw-row-actions`，且**没有** data-row-key —— 会话 id 只能从
     *   React fiber 的 `memoizedProps.node.id` 取。
     *
     * 标记方式：
     * - `data-dcs-draft="dirty|empty"` 自定义属性（React 不重写 data-*，不会被洗掉）；
     * - 标题 span 上写行内颜色（即使主题/皮肤 CSS 覆盖样式表，灰色也一定生效）；
     * - 「有未发送编辑」的行：灰色 + 标题前一个「编辑中」铅笔小标志（CSS ::before）；
     * - 在行尾操作单元里挂一个 ×（继承两套行各自的 hover 显隐）。
     * 纯装饰 + 一个动作；DOM 形状变化时行照常工作，只丢装饰。
     *
     * @param {{archiveSession: function, discardLabel: function}} deps
     * @returns {function} 卸载函数
     */
    function installRowMarker(deps) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return noop
      var registry = draftRegistry()
      var frame

      /** 是否为 dsh-better-workspace 渲染的会话行（它的 class 是稳定的公开契约）。 */
      var isBetterWorkspaceRow = function isBetterWorkspaceRow(row) {
        try {
          return row.classList !== undefined && row.classList.contains('bw-session-row')
        } catch (_) {
          return false
        }
      }

      /**
       * 行里的标题 span：
       * - better-workspace：`.bw-row-label`（显式类名，最可靠）；
       * - 内核原生行：子节点顺序 [状态槽, 标题, 时间?, 置顶?, 操作?]，标题固定第 2 个。
       * 形状漂移时返回 undefined（只丢装饰）。
       */
      var titleSpanOf = function titleSpanOf(row) {
        try {
          var label = row.querySelector !== undefined ? row.querySelector('.bw-row-label') : null
          if (label !== null && label !== undefined) return label
          var direct = row.children !== undefined ? row.children[1] : undefined
          if (direct !== undefined && direct !== null && direct.tagName === 'SPAN') return direct
          var spans = row.querySelectorAll('span')
          return spans !== undefined && spans.length > 1 ? spans[1] : undefined
        } catch (_) {
          return undefined
        }
      }

      /**
       * 行尾操作单元的落点（× 与 ⋯ 共用同一席位，天然继承 hover 显隐）：
       * - better-workspace：`.bw-row-actions`；
       * - 内核原生行：第一个行内按钮（⋯）的父元素。
       * 找不到时返回 null：better-workspace 行退化为直接挂在行尾，原生行只染色。
       */
      var actionsSeatOf = function actionsSeatOf(row) {
        try {
          var actions = row.querySelector !== undefined ? row.querySelector('.bw-row-actions') : null
          if (actions !== null && actions !== undefined) return actions
          var buttons = row.querySelectorAll('button')
          for (var i = 0; i < buttons.length; i += 1) {
            if (!buttons[i].hasAttribute(DISCARD_ATTR)) return buttons[i].parentElement
          }
        } catch (_) { /* ignore */ }
        return null
      }

      /** 还原一行：去掉标记属性、行内颜色与注入的 ×。 */
      var undress = function undress(row) {
        row.removeAttribute(DRAFT_ATTR)
        var title = titleSpanOf(row)
        if (title !== undefined && title !== null && title.style !== undefined) {
          title.style.color = ''
          title.style.opacity = ''
        }
        var discards = row.querySelectorAll('button[' + DISCARD_ATTR + ']')
        for (var i = 0; i < discards.length; i += 1) discards[i].remove()
      }

      var undressAll = function undressAll() {
        var rows = document.querySelectorAll('[' + DRAFT_ATTR + ']')
        for (var i = 0; i < rows.length; i += 1) undress(rows[i])
      }

      var discardOf = function discardOf(sessionId) {
        // 先删预览（丢弃后该会话仍是 host 的 blank，若不清预览会一直「占用」名字），
        // 再归档（= 从树里隐藏；session log 保留）。
        if (registry.previews.delete(sessionId) && typeof registry.bump === 'function') registry.bump()
        var task
        try {
          task = deps.archiveSession(sessionId)
        } catch (error) {
          warn('丢弃草稿失败', error)
          return
        }
        if (task !== undefined && task !== null && typeof task.catch === 'function') {
          task.catch(function (error) { warn('丢弃草稿失败', error) })
        }
      }

      /** 给一行上视觉标记；state 来自 {@link draftRowState}。 */
      var dress = function dress(row, sessionId, state) {
        row.setAttribute(DRAFT_ATTR, state)
        var title = titleSpanOf(row)
        if (title !== undefined && title !== null && title.style !== undefined) {
          if (state === 'dirty') {
            // 行内样式兜底：不依赖样式表选择器命中；token 缺失时退回固定灰。
            title.style.color = 'var(--dsw-alias-label-secondary, #8b8b8b)'
            title.style.opacity = '0.72'
          } else {
            // 空的「新会话」占位保持正常颜色（用户只想区分「有未发送编辑」的会话）。
            title.style.color = ''
            title.style.opacity = ''
          }
        }
        var discard = row.querySelector('button[' + DISCARD_ATTR + ']')
        if (discard === null) {
          var seat = actionsSeatOf(row)
          if (seat === null || seat === undefined) {
            // 原生行没有操作单元（异常形状）→ 只保留视觉标记；
            // better-workspace 行找不到 .bw-row-actions 时直接挂行尾（行是 flex）。
            if (!isBetterWorkspaceRow(row)) return
            seat = row
          }
          discard = document.createElement('button')
          discard.type = 'button'
          discard.setAttribute(DISCARD_ATTR, '')
          discard.innerHTML = DISCARD_ICON
          discard.addEventListener('click', function (event) {
            // 行本身 onClick 会打开会话；× 必须拦掉它。
            event.stopPropagation()
            event.preventDefault()
            var hostRow = discard.parentElement !== null && discard.parentElement !== undefined
              ? discard.parentElement.closest('[role="treeitem"]')
              : null
            var id = hostRow !== null ? rowSessionId(hostRow) : undefined
            if (id === undefined) id = discard.getAttribute('data-dcs-session') || undefined
            if (id === undefined) {
              warn('丢弃草稿：解析不到会话 id，已跳过本次点击')
              return
            }
            discardOf(id)
          })
          seat.appendChild(discard)
        }
        var label = deps.discardLabel()
        discard.setAttribute('aria-label', label)
        discard.title = label
        discard.setAttribute('data-dcs-session', sessionId)
      }

      var scan = function scan() {
        frame = undefined
        var titles = registry.titles
        var previews = registry.previews
        // 两套行 DOM 一起扫：原生 [data-row-key="session:..."] 与 better-workspace 的
        // .bw-session-row。workspace/group 行不在其中（无 session id → state none）。
        var rows = document.querySelectorAll('[role="treeitem"]')
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i]
          if (!isBetterWorkspaceRow(row) && sessionIdOfRow(row) === undefined) {
            if (row.hasAttribute(DRAFT_ATTR)) undress(row)
            continue
          }
          var id = rowSessionId(row)
          var state = draftRowState(id, titles, previews)
          if (state === 'none') {
            if (row.hasAttribute(DRAFT_ATTR)) undress(row)
            continue
          }
          dress(row, id, state)
        }
      }

      var schedule = function schedule() {
        if (frame !== undefined) return
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(scan)
        else frame = setTimeout(scan, 16)
      }

      registry.rescan = schedule
      var observer = new MutationObserver(schedule)
      // 不监听 attributes：本插件自己 setAttribute（data-dcs-draft / data-dcs-session）
      // 会触发属性变更，监听它会形成自激循环；行身份与标题文本变化都在 childList /
      // characterData 里，足够驱动重扫。
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      schedule()

      return function disposeMarker() {
        if (registry.rescan === schedule) registry.rescan = undefined
        observer.disconnect()
        if (frame !== undefined) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          else clearTimeout(frame)
          frame = undefined
        }
        undressAll()
      }
    }

    // =========================================================================
    // 6. 快捷键
    // =========================================================================

    /**
     * Ctrl+Alt+N：从任何位置新建草稿，走的是和按钮同一个入口（因此同样遵守
     * 「先复用空草稿」规则）。window 的捕获阶段注册，任何容器都 stop 不掉。
     * @param {function} startSession uiWorkspace.startSession
     * @returns {function} 卸载函数
     */
    function installHotkey(startSession) {
      var onKey = function onKey(event) {
        if (!matchNewSessionHotkey(event)) return
        event.preventDefault()
        event.stopPropagation()
        try {
          startSession()
        } catch (error) {
          warn('Ctrl+Alt+N 新建会话失败', error)
        }
      }
      window.addEventListener('keydown', onKey, true)
      return function disposeHotkey() {
        window.removeEventListener('keydown', onKey, true)
      }
    }

    // =========================================================================
    // 7. 插件入口
    // =========================================================================

    /** 需要的客户端服务：缺任何一个，Cordis 会等它就绪后再执行 apply。 */
    var inject = ['sessions', 'workspaces', 'uiWorkspace', 'conversation']

    /** 文案：优先走内核 locale，失败时按浏览器语言兜底。 */
    function makeTranslator(ctx) {
      return function translate(key, words) {
        try {
          if (ctx !== undefined && typeof ctx.get === 'function') {
            var locale = ctx.get('locale')
            if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
              var t = locale.bind(DICTIONARY_NS)
              var value = t(key)
              if (typeof value === 'string' && value !== '' && value !== key) return value
            }
          }
        } catch (_) { /* 降级到浏览器语言 */ }
        var language = 'en'
        try {
          var tag = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
            ? navigator.language.toLowerCase()
            : 'en'
          if (tag.indexOf('zh') === 0) language = 'zh'
        } catch (_) { /* ignore */ }
        return words[language] !== undefined ? words[language] : words.en
      }
    }

    /** 注册字典（locale 服务可选：没有它也能工作）。 */
    function installDictionaries(ctx) {
      try {
        if (ctx === undefined || typeof ctx.get !== 'function') return noop
        var locale = ctx.get('locale')
        if (locale === undefined || locale === null || typeof locale.register !== 'function') return noop
        locale.register(DICTIONARY_NS, 'en', { rowTitle: WORD_ROW_TITLE.en, discard: WORD_DISCARD.en })
        locale.register(DICTIONARY_NS, 'zh', { rowTitle: WORD_ROW_TITLE.zh, discard: WORD_DISCARD.zh })
      } catch (error) {
        warn('locale 字典注册失败，使用内置中英文兜底', error)
      }
      return noop
    }

    /** 注入共享样式，返回清理函数。 */
    function installStyles() {
      if (typeof document === 'undefined') return noop
      if (document.querySelector('style[' + STYLE_ATTR + '="' + STYLE_ID + '"]') !== null) return noop
      var tag = document.createElement('style')
      tag.setAttribute(STYLE_ATTR, STYLE_ID)
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return function removeStyles() { tag.remove() }
    }

    /**
     * 浏览器插件入口：样式 → 字典 → 列表投影 → 新建规则 → 行标记 → 快捷键。
     * 顺序有意义：投影先装，新建规则才能读到 registry.stockGet / previews；
     * 行标记最后装，它只消费 registry.titles。
     *
     * @param {object} ctx 客户端根 Context
     */
    function apply(ctx) {
      var translate = makeTranslator(ctx)

      ctx.effect(function () { return installStyles() }, 'cursor-sessions: styles')
      ctx.effect(function () { return installDictionaries(ctx) }, 'cursor-sessions: dictionaries')

      ctx.effect(function () {
        return installDraftProjection({
          sessions: ctx.sessions,
          conversation: ctx.conversation,
          workspaces: ctx.workspaces,
          fallbackTitle: function () { return translate('rowTitle', WORD_ROW_TITLE) },
        })
      }, 'cursor-sessions: draft projection')

      ctx.effect(function () {
        return installNewSessionRule({
          uiWorkspace: ctx.uiWorkspace,
          sessions: ctx.sessions,
          workspaces: ctx.workspaces,
        })
      }, 'cursor-sessions: reuse empty draft on New Session')

      ctx.effect(function () {
        return installRowMarker({
          discardLabel: function () { return translate('discard', WORD_DISCARD) },
          archiveSession: function (sessionId) {
            // uiWorkspace.archiveSession 会在被丢弃的正是当前会话时清理主选择；
            // 控制器方法是 0.1 时代的兜底。
            if (ctx.uiWorkspace !== undefined && ctx.uiWorkspace !== null
              && typeof ctx.uiWorkspace.archiveSession === 'function') {
              return ctx.uiWorkspace.archiveSession(sessionId)
            }
            return ctx.workspaces.archiveSession(sessionId)
          },
        })
      }, 'cursor-sessions: draft row marker')

      ctx.effect(function () {
        return installHotkey(function () {
          if (ctx.uiWorkspace !== undefined && ctx.uiWorkspace !== null
            && typeof ctx.uiWorkspace.startSession === 'function') {
            ctx.uiWorkspace.startSession()
          }
        })
      }, 'cursor-sessions: Ctrl+Alt+N')
    }

    var plugin = {
      inject: inject,
      apply: apply,
    }
    // 单元测试通道：用不可枚举属性挂内部纯函数。Cordis 只读 apply/inject，
    // 不可枚举保证它不会被当成插件声明字段（也不会被任何 spread 复制）。
    Object.defineProperty(plugin, '__test', {
      value: {
        draftPreview: draftPreview,
        draftTextOf: draftTextOf,
        storedDraftText: storedDraftText,
        isDraftSummary: isDraftSummary,
        currentSessionIdOf: currentSessionIdOf,
        projectDraftList: projectDraftList,
        titlesOfProjection: titlesOfProjection,
        findReusableDraft: findReusableDraft,
        matchNewSessionHotkey: matchNewSessionHotkey,
        sessionIdOfRow: sessionIdOfRow,
        rowSessionId: rowSessionId,
        reactFiberOf: reactFiberOf,
        findSessionIdFromFiber: findSessionIdFromFiber,
        draftRowState: draftRowState,
        PROJECTED_ROW: PROJECTED_ROW,
      },
      enumerable: false,
    })
    return plugin
  },
})
