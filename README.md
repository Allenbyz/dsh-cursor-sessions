# dsh-cursor-sessions

> 给 DeepSeek Harness（DSH）侧边栏加上 Cursor 式「草稿聊天」：未发送的输入不再消失，而是成为可看见、可点回、可丢弃的会话行。

> **改编声明**：本项目的设计思路与部分实现改编自 [ne-ilyxa/dsh-session-drafts](https://github.com/ne-ilyxa/dsh-session-drafts)（**BSD-3-Clause**）。针对 DSH `0.2.1-rc.2` 的补丁点迁移、投影策略调整与标题时序修复为本项目新增。完整第三方许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

- 适用：DSH Desktop / Web `0.2.1-rc.2`（已验证基线）
- 形态：纯 Web 客户端插件（Host 半边空实现，不改内核文件）
- 运行时依赖：无 ｜ 许可证：MIT（自有代码）

## 功能

- **草稿即会话行**：未发送文字实时成为标题（60 字符预览）；有未发送编辑时标题变灰、前面带一个「编辑中」铅笔标志（轻微呼吸动画），空占位保持常规颜色。
- **不堆空占位**：点「新建会话」先跳到本工作区已有的空草稿（adopt 同一 sessionId），只有所有草稿都有文字时才真正新建。
- **切走保留、切回继续**：草稿行不会消失；点回时内核自动恢复未发送文字，继续实时跟随输入（区别于 @ne-ilyxa/dsh-session-drafts 0.6.1）。
- **删光即回「新会话」**：清空输入后标题立即回退，灰色与铅笔同时消失。
- **一键丢弃**：悬停草稿行，尾部出现唯一操作 `×`（归档，session log 保留）。
- **快捷键**：`Ctrl+Alt+N` 从任意位置新建（与按钮同一规则）。

## 交互

| 操作 | 行为 |
|---|---|
| 新建会话（本工作区有空草稿） | 跳到该空草稿，不新增 |
| 新建会话（所有草稿都有文字） | 新建一个 blank 会话 |
| 在草稿里输入 | 标题逐键更新，行变灰并显示铅笔 |
| 切到别的会话 | 草稿行与标题保留 |
| 点回草稿行 | 未发送文字由内核自动恢复 |
| 删光输入 | 标题立即回到「新会话」 |
| 悬停草稿行 → 点 × | 归档丢弃（日志保留） |
| 发出一条消息 | 草稿「毕业」为普通聊天，⋯ 菜单恢复 |
| `Ctrl+Alt+N` | 任意位置新建（同上规则） |

## 安装

```powershell
# 从 GitHub
dsh plugin --profile desktop add github:Allenbyz/dsh-cursor-sessions

# 卸载
dsh plugin --profile desktop remove dsh-cursor-sessions
```

安装后随 Host 重启 / HMR 进入 Web boot graph；界面没变化时刷新一次（`Ctrl+R`）。

## 兼容性

| DSH | 状态 |
|---|---|
| `0.2.1-rc.2` | 已验证；New Session 补丁点为本机真实漏斗 `connectBlank` |
| `0.2.0-rc.2` 及更早 | 未验证 |

## 实现方式

插件只在运行时做三件事，不修改任何内核文件：

1. **列表投影**：影子 `sessions.list.getSnapshot`，把「无已发送 turn」的会话投影成 `blank:false` + 实时标题；按 stock 引用/版本 memo，保证引用稳定。
2. **新建规则**：影子 `uiWorkspace.connectBlank`，普通新建先 adopt 空草稿、全占用才 mint；带 options 的入口保持内核原有语义。
3. **行标记**：MutationObserver + `data-dcs-draft` 属性 + 行内颜色 + CSS `::before`。

内部推导只读原始快照、不写编辑器、不新建持久化；所有影子属性可逆，卸载时逐项还原。

## 开发与测试

```powershell
node --check client.js
node tests/core.test.mjs     # 21/21
node tests/apply.test.mjs    # 7/7
```

## 已知边界

- 空且非当前的历史 blank 不列出（避免脏行），但新建时仍会复用它们。
- 图片/文件附件不持久化（内核行为），只有文字会被恢复。
- 草稿文字在浏览器 localStorage，按 origin 隔离（桌面端与远程网页端不共享）。
- 无网络请求、无遥测；只读内核 localStorage 键与 DOM。

## 致谢

- **[ne-ilyxa/dsh-session-drafts](https://github.com/ne-ilyxa/dsh-session-drafts)** —— 设计思路来源（草稿行投影、空草稿复用、DOM 标记、HMR 幂等纪律）；上游为 **BSD-3-Clause**，本仓库改编部分按同一许可授权，全文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- **[KannaKuron/dsh-better-workspace](https://github.com/KannaKuron/dsh-better-workspace)** —— 感谢这个侧边栏工作区树插件。
- **DeepSeek V4.1 Flash 1017** —— 感谢在插件设计、实现、调试与文档撰写过程中的辅助。

## License

自有代码 [MIT](LICENSE)；改编自上游的部分同时适用 **BSD-3-Clause**，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。© Allenjsgs
