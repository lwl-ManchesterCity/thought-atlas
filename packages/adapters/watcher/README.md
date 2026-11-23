# 通用文件监听适配器

按白名单/目录发现 JSONL 文件，文件增长 → 按行喂解析器 → TurnPayload 投递 daemon。

- 注册制：平台实现 `ParserModule`（`id` + `create(path, seed)`），返回 `TranscriptParser`（`feedLine`，可选 `snapshot`）。Codex 用 `codexParserModule`，Qoder 用 `qoderParserModule`。
- `JsonlWatcher`：每文件独立字节游标 + 解析器快照；半行缓冲；重启恢复；截断或换 inode 时 `reparse` 从 0 重放；tail 模式仅首次见到文件时静默播种；投递失败重试，全部 pending 成功后才持久化游标。
- 游标落在 `~/.thought-atlas/watcher-cursors/`（目录 0700、文件 0600，原子写）。
- 新平台 = 新解析器 + 新模块，watcher 核心不改。