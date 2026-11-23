# Qoder 适配器（开发证据链来源）

watcher 形态，零配置侵入：只读监听白名单中的 Qoder transcript，增量折叠为 TurnPayload 投递 daemon。

- 白名单：`~/.thought-atlas/config.json` 的 `qoderWatch` 数组，元素为绝对文件路径或 sessionId。不配 = 不监听，绝不扫描整个 `~/.qoder-cn/projects`。
- 轮界：`origin.kind === "human"` 的 user 行开启一轮；该轮最后一条 `stop_reason === "end_turn"` 的 assistant 回复正文作为助手文本。被下一轮打断的未完成轮次用最后一条非空正文兜底。
- 排除：tool_result / tool_use / thinking / attachment / 系统提醒 / `isSidechain`。
- 游标：字节游标与解析器状态落在 `~/.thought-atlas/watcher-cursors/`；文件截断或换 inode 时归零重放，已投递的人类轮按稳定 id 去重并保持 turnIndex 单调。
- 启动：`node packages/adapters/qoder/src/main.ts`（`ATLAS_DAEMON_URL` 默认 `http://127.0.0.1:7788`）。