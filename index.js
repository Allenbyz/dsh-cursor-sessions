/**
 * dsh-cursor-sessions —— Host 半边（刻意留空）。
 *
 * 这个包的全部行为都在浏览器半边（`exports["./client"]` → client.js）。
 * 本模块存在的唯一理由是让包成为一个可加载的 Cordis 插件：Loader 中一条
 * 「已启用」的条目，才会让 @deepseek-ai/dsh-client-modules 把包的 dsh.client
 * 声明编译进 Web boot graph，浏览器随后才会执行 client.js 的 factory。
 *
 * 设计取舍：
 * - 不注册任何 Host Service / Tool / Event，避免扩大影响面；
 * - 真正的会话读写全部复用 Harness 已有的公开面（sessions / workspaces /
 *   uiWorkspace / conversation），插件不修改任何内核文件，也不接管持久化。
 *
 * @module dsh-cursor-sessions
 */

/**
 * Host 插件入口。不注册任何资源，因此无需清理函数。
 * @returns {void}
 */
export function apply() {
  // 浏览器半边拥有全部行为。
}
