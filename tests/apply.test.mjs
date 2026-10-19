/**
 * dsh-cursor-sessions 的 apply() 集成冒烟测试（无浏览器）。
 *
 * 用最小的假 ctx / 假 DOM / 假 snapshot store 跑一遍真实 apply() 的装配链：
 *   样式 → 字典 → 列表投影（影子属性）→ connectBlank 补丁 → DOM 标记 → 快捷键
 * 断言最关键的三件事：
 *   1. 投影把「有文字的 blank」变成 blank:false + 标题行，且原始快照不被改写；
 *   2. connectBlank 被补丁：空草稿被 adopt（sessions.create 带 sessionId），
 *      草稿被占用时 mint 新会话；
 *   3. 卸载后所有影子属性 / 补丁 / 监听器都还原。
 *
 * 运行：node tests/apply.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 假 DOM 元素。 */
function fakeElement(tagName) {
  const element = {
    tagName,
    children: [],
    textContent: '',
    attributes: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false },
    },
    setAttribute(name, value) { element.attributes[name] = String(value) },
    getAttribute(name) { return name in element.attributes ? element.attributes[name] : null },
    hasAttribute(name) { return name in element.attributes },
    removeAttribute(name) { delete element.attributes[name] },
    appendChild(child) { element.children.push(child); return child },
    remove() { element.removed = true },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
  }
  return element
}

function createEnvironment(options = {}) {
  const storage = options.storage ?? new Map()
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }

  const head = fakeElement('head')
  const body = fakeElement('body')
  const document = {
    head,
    body,
    createElement: tagName => fakeElement(tagName),
    querySelector(selector) {
      if (typeof selector === 'string' && selector.startsWith('style[')) {
        const match = /data-plugin-css="([^"]+)"/.exec(selector)
        if (match !== null) {
          const found = head.children.find(child => child.tagName === 'style'
            && child.attributes['data-plugin-css'] === match[1])
          return found ?? null
        }
      }
      return null
    },
    querySelectorAll() { return [] },
  }

  const keydownHandlers = []
  const window = {
    __ModuleLoader__: { load: definition => { window.__definition = definition } },
    addEventListener(type, handler) { if (type === 'keydown') keydownHandlers.push(handler) },
    removeEventListener(type, handler) {
      if (type !== 'keydown') return
      const index = keydownHandlers.indexOf(handler)
      if (index >= 0) keydownHandlers.splice(index, 1)
    },
  }

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback }
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    window,
    document,
    localStorage,
    console,
    navigator: { language: options.language ?? 'zh-CN' },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: handle => clearTimeout(handle),
    MutationObserver: FakeMutationObserver,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const definition = window.__definition
  assert.equal(definition.id, 'dsh-cursor-sessions')
  const module = definition.factory(specifier => { throw new Error('不期望的 require: ' + specifier) })
  return { module, storage, document, head, keydownHandlers, sandbox }
}

/** 假 createSnapshotStore：getSnapshot/subscribe/set 都是自有属性（与内核一致）。 */
function createStore(initial) {
  let state = initial
  const listeners = new Set()
  const store = {
    getSnapshot() { return state },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
    update(updater) {
      state = updater(state)
      for (const fn of [...listeners]) fn()
    },
  }
  return { store, rawState: () => state }
}

/** 组装最小 ctx。effect 立即执行并收集清理函数（等价 Cordis effect 语义）。 */
function createContext(options = {}) {
  const { store } = createStore(options.list)
  const created = []
  const archived = []
  const started = []
  const effects = []
  const locale = {
    register() {},
    bind() {
      return key => (key === 'rowTitle' ? '新会话' : key === 'discard' ? '丢弃草稿' : key)
    },
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'w1', path: 'C:\\ws', sessionIds: options.sessionIds ?? [] }],
        archivedSessionIds: options.archivedSessionIds ?? [],
        pinnedSessionIds: [],
      }),
    },
    archiveSession: async sessionId => { archived.push(sessionId) },
  }
  const sessions = {
    list: store,
    create: async opts => { created.push(opts); return opts.sessionId ?? 'minted-session' },
    // options.retained 时模拟「当前会话已被 retain」：sessions.scope 返回一个作用域。
    scope: options.retained === true ? () => ({}) : () => undefined,
  }
  const uiWorkspace = {
    connectBlank: async () => 'stock-session',
    startSession: () => { started.push('start') },
    archiveSession: async sessionId => { archived.push(sessionId) },
  }
  const conversation = {
    input: {
      for: () => ({
        state: options.shellState ?? {
          subscribe: () => () => {},
          getSnapshot: () => ({ draft: '' }),
        },
      }),
    },
  }
  const ctx = {
    sessions,
    workspaces,
    uiWorkspace,
    conversation,
    get(name) { return name === 'locale' ? locale : undefined },
    effect(setup) { effects.push(setup()) },
  }
  // 测试统一卸载用；真实 Cordis ctx 不会有这个字段。
  ctx.effects = effects
  return { ctx, store, created, archived, started, effects }
}

const draftStore = text => JSON.stringify({ draft: { text, references: [] }, view: null, viewRequest: null })

/** 插件代码在 vm 沙箱（另一个 realm）里建对象，跨 realm 不能直接 deepStrictEqual。 */
const plain = value => JSON.parse(JSON.stringify(value))

const baseList = () => ({
  ids: ['s1'],
  byId: { s1: { id: 's1', blank: true, updatedAt: 1, cwd: 'C:\\ws' } },
  phase: 'ready',
  projectionsBySession: {},
})

test('apply：投影让有文字的 blank 变成带标题的普通行，原始快照不被改写', () => {
  const env = createEnvironment({ storage: new Map([['dsh.conversation.s1', draftStore('未发送的文字')]]) })
  const { ctx, store } = createContext({ list: baseList(), sessionIds: ['s1'] })
  const rawGet = store.getSnapshot
  env.module.apply(ctx)

  const projected = store.getSnapshot()
  assert.equal(projected.byId.s1.blank, false)
  assert.equal(projected.byId.s1.title, '未发送的文字')
  assert.equal(projected.byId.s1.displayTitle, '未发送的文字')
  assert.equal(store.getSnapshot(), projected, 'memo 必须让同一 state 返回同一引用')

  // 插件内部只读原始快照：内核数据必须保持 blank:true
  assert.equal(rawGet().byId.s1.blank, true)
  assert.equal(rawGet().byId.s1.title, undefined)

  for (const off of ctx.effects) off()
})

test('apply：空草稿被 adopt（create 带 sessionId），占用中的草稿不会被复用', async () => {
  // 场景 A：草稿里已经有字 → 普通新建必须 mint 新会话
  const envA = createEnvironment({ storage: new Map([['dsh.conversation.s1', draftStore('写了一半')]]) })
  const a = createContext({ list: baseList(), sessionIds: ['s1'] })
  envA.module.apply(a.ctx)
  const idA = await a.ctx.uiWorkspace.connectBlank('w1')
  assert.equal(idA, 'minted-session')
  assert.deepEqual(plain(a.created.at(-1)), { workspaceId: 'w1' })
  for (const off of a.ctx.effects) off()

  // 场景 B：草稿为空 → 普通新建必须复用这枚空草稿（Host adoption）
  const envB = createEnvironment()
  const b = createContext({ list: baseList(), sessionIds: ['s1'] })
  envB.module.apply(b.ctx)
  const idB = await b.ctx.uiWorkspace.connectBlank('w1')
  assert.equal(idB, 's1')
  assert.deepEqual(plain(b.created.at(-1)), { workspaceId: 'w1', sessionId: 's1' })
  for (const off of b.ctx.effects) off()
})

test('apply：带 options 的路径保持内核语义（可复用带文字的 blank）', async () => {
  const env = createEnvironment({ storage: new Map([['dsh.conversation.s1', draftStore('草稿保留')]]) })
  const { ctx, created } = createContext({ list: baseList(), sessionIds: ['s1'] })
  env.module.apply(ctx)
  const id = await ctx.uiWorkspace.connectBlank('w1', { agentPreset: 'cordis' })
  assert.equal(id, 's1')
  assert.deepEqual(plain(created.at(-1)), { workspaceId: 'w1', agentPreset: 'cordis', sessionId: 's1' })
  for (const off of ctx.effects) off()
})

test('apply：双击去重（同一工作区只发一次 create）', async () => {
  const env = createEnvironment()
  const { ctx, created } = createContext({ list: baseList(), sessionIds: ['s1'] })
  env.module.apply(ctx)
  const [first, second] = await Promise.all([
    ctx.uiWorkspace.connectBlank('w1'),
    ctx.uiWorkspace.connectBlank('w1'),
  ])
  assert.equal(first, second)
  assert.equal(created.length, 1)
  for (const off of ctx.effects) off()
})

test('apply：Ctrl+Alt+N 触发 startSession，卸载时移除监听', () => {
  const env = createEnvironment()
  const { ctx, started } = createContext({ list: baseList(), sessionIds: [] })
  env.module.apply(ctx)
  assert.equal(env.keydownHandlers.length, 1)
  const event = {
    ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyN',
    preventDefault() {}, stopPropagation() {},
  }
  env.keydownHandlers[0](event)
  assert.equal(started.length, 1)
  for (const off of ctx.effects) off()
  assert.equal(env.keydownHandlers.length, 0)
})

test('apply：卸载后 sessions.list / connectBlank / 样式全部还原', () => {
  const env = createEnvironment({ storage: new Map([['dsh.conversation.s1', draftStore('文字')]]) })
  const { ctx, store } = createContext({ list: baseList(), sessionIds: ['s1'] })
  const rawGet = store.getSnapshot
  const rawSubscribe = store.subscribe
  const rawConnect = ctx.uiWorkspace.connectBlank
  env.module.apply(ctx)
  assert.notEqual(store.getSnapshot, rawGet)
  assert.equal(env.head.children.length, 1, '样式已注入')

  for (const off of ctx.effects.slice().reverse()) off()

  assert.equal(store.getSnapshot, rawGet, '影子 getSnapshot 必须还原')
  assert.equal(store.subscribe, rawSubscribe, '影子 subscribe 必须还原')
  assert.equal(ctx.uiWorkspace.connectBlank, rawConnect, 'connectBlank 补丁必须还原')
  assert.equal(env.head.children[0].removed, true, '样式必须移除')
})

test('apply：删光输入后标题立即回到「新会话」，不会被 localStorage 旧值复活', () => {
  // 复现真实时序：内核 publish() 是先 state.set 再 persistDraft，所以「清空」通知
  // 到达插件时，localStorage 里仍是上一版文字。标题必须立刻回到「新会话」。
  const storage = new Map([['dsh.conversation.s1', draftStore('旧文字差')]])
  const env = createEnvironment({ storage })
  const shellState = createStore({ draft: '旧文字差' }).store
  const list = {
    ids: ['s1'],
    byId: {
      s1: {
        id: 's1',
        blank: false, // 当前会话已被 engage（内核投影 blank:false）
        updatedAt: 1,
        cwd: 'C:\\ws',
        retainedBy: { mainView: 1 },
        projectionValues: { sessionListMetadata: { blank: true } }, // Host 真相：没有 turn
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const { ctx, store } = createContext({ list, sessionIds: ['s1'], retained: true, shellState })
  env.module.apply(ctx)

  // 初始：当前 shell 里的草稿文字成为行标题
  assert.equal(store.getSnapshot().byId.s1.title, '旧文字差')

  // 用户删光：shell state 先变空，localStorage 还是旧文字
  shellState.set({ draft: '' })
  assert.equal(storage.get('dsh.conversation.s1'), draftStore('旧文字差'), '测试前提：持久化仍是旧值')
  assert.equal(store.getSnapshot().byId.s1.title, '新会话', '清空后标题必须立即回到「新会话」')

  // 重新输入：标题恢复实时跟随
  shellState.set({ draft: '新的内容' })
  assert.equal(store.getSnapshot().byId.s1.title, '新的内容')

  // 只输入空白字符：等价于空
  shellState.set({ draft: '   \n ' })
  assert.equal(store.getSnapshot().byId.s1.title, '新会话')

  for (const off of ctx.effects) off()
})
