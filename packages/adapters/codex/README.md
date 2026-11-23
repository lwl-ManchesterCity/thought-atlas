# Codex 适配器（第一优先）

D1 只做只读机制验证，结论见 `docs/verification-d1.md`。
D2 实现：hooks/notify 触发信号 + rollout JSONL 字节游标增量读取 → TurnPayload → POST 守护进程。
约束：只读、幂等、失败静默、绝不阻塞 agent；不改动用户 config.toml 其他内容（追加式修改，先备份）。