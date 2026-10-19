/**
 * dsh-cursor-sessions 的纯逻辑单元测试。
 *
 * 做法与参考实现一致：把打包后的 client.js 放进 node:vm 沙箱，
 * 用假的 `window.__ModuleLoader__` 捕获 factory，再调用 factory(require)
 * 取出 `__test` 里的纯函数。这样测试的就是真正会进浏览器的那份代码，
 * 不需要构建步骤，也不会在 Node 里触发 DOM/React。
 *
 * 运行：node --test tests/core.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 在 vm 沙箱里加载 bundle，返回 { module, test, storage }。 */
function loadPlugin(options = {}) {
  const storage = options.storage ?? new Map()
  const definitions = []
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }
  const window = { __ModuleLoader__: { load: definition => definitions.push(definition) } }
  const sandbox = {
    window,
    localStorage,
    console,
    setTimeout,
    clearTimeout,
    navigator: { language: options.language ?? 'zh-CN' },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(definitions.length, 1, 'bundle 必须注册且只注册一个模块')
  assert.equal(definitions[0].id, 'dsh-cursor-sessions', '模块 id 必须等于包名')
  const module = definitions[0].factory(specifier => {
    throw new Error('不期望的 require: ' + specifier)
  })
  return { module, test: module.__test, storage }
}

const plugin = loadPlugin().test

// ---------------------------------------------------------------------------
// 预览文本
// ---------------------------------------------------------------------------

test('draftPreview：折叠空白、截断、空文本返回 undefined', () => {
  assert.equal(plugin.draftPreview('  hello   world \n'), 'hello world')
  assert.equal(plugin.draftPreview(''), undefined)
  assert.equal(plugin.draftPreview('   \n\t '), undefined)
  assert.equal(plugin.draftPreview('a'.repeat(10), 5), 'aaaaa\u2026')
  assert.equal(plugin.draftPreview('abc', 40), 'abc')
  assert.equal(plugin.draftPreview(null), undefined)
})

// ---------------------------------------------------------------------------
// 草稿持久化解析
// ---------------------------------------------------------------------------

test('draftTextOf：兼容对象形状与旧字符串形状', () => {
  assert.equal(plugin.draftTextOf({ draft: { text: '对象形状' } }), '对象形状')
  assert.equal(plugin.draftTextOf({ draft: '旧字符串形状' }), '旧字符串形状')
  assert.equal(plugin.draftTextOf({ draft: { text: '' } }), '')
  assert.equal(plugin.draftTextOf({ draft: {} }), '')
  assert.equal(plugin.draftTextOf(null), '')
  assert.equal(plugin.draftTextOf('nope'), '')
})

test('storedDraftText：读内核 localStorage 键，坏数据降级为空串', () => {
  const { test } = loadPlugin({
    storage: new Map([
      ['dsh.conversation.s1', JSON.stringify({ draft: { text: '未发送的文字', references: [] } })],
      ['dsh.conversation.s2', '不是 JSON'],
    ]),
  })
  assert.equal(test.storedDraftText('s1'), '未发送的文字')
  assert.equal(test.storedDraftText('s2'), '')
  assert.equal(test.storedDraftText('missing'), '')
})

// ---------------------------------------------------------------------------
// 草稿判定与当前会话
// ---------------------------------------------------------------------------

test('isDraftSummary：blank / Host metadata / 子代理', () => {
  assert.equal(plugin.isDraftSummary({ id: 'a', blank: true }), true)
  assert.equal(plugin.isDraftSummary({ id: 'a', blank: false, projectionValues: { sessionListMetadata: { blank: true } } }), true)
  assert.equal(plugin.isDraftSummary({ id: 'a', blank: false }), false)
  assert.equal(plugin.isDraftSummary({ id: 'a', blank: true, origin: 'subagent' }), false)
  assert.equal(plugin.isDraftSummary(undefined), false)
})

test('currentSessionIdOf：retainedBy.mainView 优先，旧字段兜底', () => {
  const list = {
    ids: ['a', 'b'],
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } },
  }
  assert.equal(plugin.currentSessionIdOf(list), 'b')
  assert.equal(plugin.currentSessionIdOf({ ids: [], byId: {}, current: 'c' }), 'c')
  assert.equal(plugin.currentSessionIdOf(undefined), undefined)
})

// ---------------------------------------------------------------------------
// 列表投影
// ---------------------------------------------------------------------------

function snapshot(rows, extra = {}) {
  const ids = rows.map(row => row.id)
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return { ids, byId, phase: 'ready', projectionsBySession: {}, ...extra }
}

test('projectDraftList：有文字的草稿成为带标题的普通行', () => {
  const stock = snapshot([
    { id: 's1', blank: true, updatedAt: 10 },
    { id: 's3', blank: false, updatedAt: 30, title: '真实会话' },
  ])
  const previews = new Map([['s1', '为什么 better-sidebar']])
  const projected = plugin.projectDraftList(stock, previews, '新会话', { currentId: undefined })
  assert.notEqual(projected, stock)
  assert.equal(projected.byId.s1.blank, false)
  assert.equal(projected.byId.s1.title, '为什么 better-sidebar')
  assert.equal(projected.byId.s1.displayTitle, '为什么 better-sidebar')
  // 非草稿行保持原对象引用
  assert.equal(projected.byId.s3, stock.byId.s3)
})

test('projectDraftList：空的历史 blank 不投影，当前空草稿投影为「新会话」', () => {
  const stock = snapshot([
    { id: 'old-empty', blank: true, updatedAt: 10 },
    { id: 'current-empty', blank: true, updatedAt: 20 },
  ])
  const hidden = plugin.projectDraftList(stock, new Map(), '新会话', { currentId: undefined })
  assert.equal(hidden, stock, '没有可投影行时必须返回原快照（引用稳定）')

  const shown = plugin.projectDraftList(stock, new Map(), '新会话', { currentId: 'current-empty' })
  assert.equal(shown.byId['old-empty'], stock.byId['old-empty'])
  assert.equal(shown.byId['current-empty'].blank, false)
  assert.equal(shown.byId['current-empty'].title, '新会话')
})

test('projectDraftList：已打开未发消息的草稿（blank:false + Host metadata:true）仍投影', () => {
  const stock = snapshot([
    { id: 'engaged', blank: false, updatedAt: 10, projectionValues: { sessionListMetadata: { blank: true } } },
  ])
  const projected = plugin.projectDraftList(stock, new Map(), '新会话', { currentId: undefined })
  assert.equal(projected.byId.engaged.blank, false)
  assert.equal(projected.byId.engaged.title, '新会话')
})

test('projectDraftList：子代理行与用户显式重命名', () => {
  const stock = snapshot([
    { id: 'sub', blank: true, origin: 'subagent', updatedAt: 1 },
    { id: 'renamed', blank: true, updatedAt: 2, title: '我自己起的名字', displayTitle: '我自己起的名字' },
  ])
  const projected = plugin.projectDraftList(stock, new Map([['renamed', '草稿预览']]), '新会话', {})
  assert.equal(projected.byId.sub, stock.byId.sub)
  assert.equal(projected.byId.renamed.title, '我自己起的名字')
})

test('projectDraftList：启动守卫命中的会话暂不投影，解除后恢复', () => {
  const stock = snapshot([{ id: 'boot', blank: true, updatedAt: 5 }])
  const previews = new Map([['boot', '启动时的草稿']])
  const guarded = plugin.projectDraftList(stock, previews, '新会话', {
    currentId: undefined,
    bootGuardId: 'boot',
    bootGuardActive: true,
  })
  assert.equal(guarded, stock)
  const released = plugin.projectDraftList(stock, previews, '新会话', {
    currentId: undefined,
    bootGuardId: 'boot',
    bootGuardActive: false,
  })
  assert.equal(released.byId.boot.title, '启动时的草稿')
})

test('projectDraftList：幂等（不吃自己的输出），预览变化后标题跟随', () => {
  const stock = snapshot([{ id: 's1', blank: true, updatedAt: 1 }])
  const first = plugin.projectDraftList(stock, new Map([['s1', '第一版']]), '新会话', {})
  assert.equal(first.byId.s1.title, '第一版')
  // 模拟 HMR：把投影结果当成输入再投影一次
  const again = plugin.projectDraftList(first, new Map([['s1', '第二版']]), '新会话', {})
  assert.equal(again.byId.s1.title, '第二版', '品牌符号必须让预览继续胜出，而不是冻结成“用户重命名”')
})

test('titlesOfProjection：只收集真正被改写的行', () => {
  const stock = snapshot([
    { id: 'd', blank: true, updatedAt: 1 },
    { id: 'c', blank: false, updatedAt: 2, title: '聊天' },
  ])
  const projected = plugin.projectDraftList(stock, new Map([['d', '预览']]), '新会话', {})
  const titles = plugin.titlesOfProjection(stock, projected)
  // 注意：vm 沙箱里的 Map 属于另一个 realm，不能对 entries() 直接 deepStrictEqual。
  assert.deepEqual(Array.from(titles.keys()), ['d'])
  assert.equal(titles.get('d'), '预览')
  assert.equal(plugin.titlesOfProjection(stock, stock).size, 0)
})

// ---------------------------------------------------------------------------
// 复用扫描
// ---------------------------------------------------------------------------

test('findReusableDraft：普通新建只复用最新空草稿（写字的草稿原样保留）', () => {
  const stock = snapshot([
    { id: 'empty-old', blank: true, updatedAt: 10, cwd: 'C:\\ws' },
    { id: 'occupied', blank: true, updatedAt: 50, cwd: 'C:\\ws' },
    { id: 'empty-new', blank: true, updatedAt: 30, cwd: 'C:\\ws' },
  ])
  const workspaces = {
    items: [{ workspaceId: 'w1', path: 'C:\\ws', sessionIds: ['empty-old', 'occupied', 'empty-new'] }],
    archivedSessionIds: [],
  }
  const previews = new Map([['occupied', '写了一半']])
  const hit = plugin.findReusableDraft(stock, workspaces, previews, 'w1', { onlyEmpty: true })
  assert.equal(hit.id, 'empty-new', '必须跳过被占用的草稿，取最新空草稿')
})

test('findReusableDraft：带 options 的路径保持内核语义（可复用带文字的 blank）', () => {
  const stock = snapshot([
    { id: 'empty', blank: true, updatedAt: 10, cwd: 'C:\\ws' },
    { id: 'occupied', blank: true, updatedAt: 50, cwd: 'C:\\ws' },
  ])
  const workspaces = {
    items: [{ workspaceId: 'w1', path: 'C:\\ws', sessionIds: ['empty', 'occupied'] }],
    archivedSessionIds: [],
  }
  const previews = new Map([['occupied', '写了一半']])
  const hit = plugin.findReusableDraft(stock, workspaces, previews, 'w1', { onlyEmpty: false })
  assert.equal(hit.id, 'occupied')
})

test('findReusableDraft：排除归档 / 非成员 / 不同 cwd / 子代理 / 其它工作区', () => {
  const stock = snapshot([
    { id: 'archived', blank: true, updatedAt: 90, cwd: 'C:\\ws' },
    { id: 'foreign', blank: true, updatedAt: 80, cwd: 'C:\\other' },
    { id: 'outsider', blank: true, updatedAt: 70, cwd: 'C:\\ws' },
    { id: 'sub', blank: true, updatedAt: 60, cwd: 'C:\\ws', origin: 'subagent' },
  ])
  const workspaces = {
    items: [{ workspaceId: 'w1', path: 'C:\\ws', sessionIds: ['archived', 'foreign', 'sub'] }],
    archivedSessionIds: ['archived'],
  }
  const hit = plugin.findReusableDraft(stock, workspaces, new Map(), 'w1', { onlyEmpty: true })
  assert.equal(hit, undefined)
  assert.equal(plugin.findReusableDraft(stock, workspaces, new Map(), 'nope', { onlyEmpty: true }), undefined)
})

// ---------------------------------------------------------------------------
// 快捷键与行身份
// ---------------------------------------------------------------------------

test('matchNewSessionHotkey：Ctrl+Alt+N，拒绝 auto-repeat / 组合键 / IME', () => {
  const base = { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyN' }
  assert.equal(plugin.matchNewSessionHotkey(base), true)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, code: undefined, key: 'N' }), true)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, code: undefined, key: '\u0442' }), false)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, repeat: true }), false)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, isComposing: true }), false)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, shiftKey: true }), false)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, metaKey: true }), false)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, altKey: false }), false)
  assert.equal(plugin.matchNewSessionHotkey({ ...base, code: 'KeyM' }), false)
})

test('sessionIdOfRow：只认 data-row-key="session:<id>"', () => {
  const row = key => ({ getAttribute: name => (name === 'data-row-key' ? key : null) })
  assert.equal(plugin.sessionIdOfRow(row('session:s1')), 's1')
  assert.equal(plugin.sessionIdOfRow(row('workspace:w1')), undefined)
  assert.equal(plugin.sessionIdOfRow(row('session:')), undefined)
  assert.equal(plugin.sessionIdOfRow(row(null)), undefined)
})

test('draftRowState：只有「有未发送文字」的草稿才是 dirty（灰色+编辑标志）', () => {
  const titles = new Map([['dirty', '写了一半'], ['empty', '新会话']])
  const previews = new Map([['dirty', '写了一半']])
  assert.equal(plugin.draftRowState('dirty', titles, previews), 'dirty')
  assert.equal(plugin.draftRowState('empty', titles, previews), 'empty')
  assert.equal(plugin.draftRowState('chat', titles, previews), 'none')
  assert.equal(plugin.draftRowState(undefined, titles, previews), 'none')
  // 预览被清掉（用户删光）后回到 empty，标题恢复默认颜色
  previews.delete('dirty')
  assert.equal(plugin.draftRowState('dirty', titles, previews), 'empty')
})

test('findSessionIdFromFiber：沿 return 链取 memoizedProps.node.id（better-workspace 行）', () => {
  const hostFiber = {
    memoizedProps: { className: 'bw-row bw-session-row', role: 'treeitem' },
    return: {
      memoizedProps: { node: { id: 'session-abc' }, depth: 0 },
      return: { memoizedProps: {}, return: null },
    },
  }
  assert.equal(plugin.findSessionIdFromFiber(hostFiber), 'session-abc')
  assert.equal(plugin.findSessionIdFromFiber(undefined), undefined)
  assert.equal(plugin.findSessionIdFromFiber({ memoizedProps: {}, return: null }), undefined)
  assert.equal(plugin.findSessionIdFromFiber({ return: null }, 3), undefined)
})

test('rowSessionId：原生 data-row-key 优先，缺失时退回 fiber', () => {
  const stockRow = { getAttribute: name => (name === 'data-row-key' ? 'session:s1' : null) }
  assert.equal(plugin.rowSessionId(stockRow), 's1')
  const bwRow = {
    getAttribute: () => null,
    __reactFiber$test: {
      memoizedProps: {},
      return: { memoizedProps: { node: { id: 's2' } }, return: null },
    },
  }
  assert.equal(plugin.rowSessionId(bwRow), 's2')
})

// ---------------------------------------------------------------------------
// 包契约
// ---------------------------------------------------------------------------

test('插件导出契约：inject 声明与 apply 函数', () => {
  const { module } = loadPlugin()
  assert.deepEqual([...module.inject], ['sessions', 'workspaces', 'uiWorkspace', 'conversation'])
  assert.equal(typeof module.apply, 'function')
})
