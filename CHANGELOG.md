# CHANGELOG

## v0.2.0 — D2（2026-11-23）

### 新增
- 模型迁移：deepseek-chat（弃用别名）→ deepseek-flash 正名；DeepSeekClient 对 deepseek 系显式关闭思考模式（官方 thinking 参数），JSON 空白内容守卫触发重试
- adapters/codex：rollout 解析器（task_complete 轮界、user/assistant 正文、排除 developer/reasoning/工具记录、turn_id 幂等、环境包裹剥离）+ 字节游标增量读取器（只消费完整行、截断归零）
- adapters/watcher：只读轮询监听 ~/.codex/sessions/ 增长，tail 模式静默 seeding 历史保证轮次连续，投递失败静默重试；对 watched 目录零写入
- daemon：AtlasDaemon HTTP 服务（POST /turn 每会话串行+幂等、GET /events SSE、GET /map、GET /health，127.0.0.1:7788）；retry.jsonl 持久重试队列（空闲补跑、attempts 上限 5、耗尽转 failures.jsonl）
- 可运行入口：daemon src/main.ts（读 config 端口）、watcher src/main.ts（tail 模式）
- 状态机硬规则：shift.fromNodeId 不得指向 ai-voice（MARK_SHIFT 与 ADD_NODE 双路径，整批原子拒绝）
- scripts/d2-real-dryrun.ts（真实会话干跑，证据仅聚合统计）、scripts/d2-e2e-latency.ts（/tmp 副本追加合成轮测端到端延迟）
- 单测 57 个全绿（core 36 / codex 12 / watcher 3 / daemon 6）
- docs/verification-d2.md：迁移数据、解析器结论、端到端延迟、干跑统计、只读证明

### 验证与返工
- 模型迁移 A/B：思考关 vs 开输出 ops 一致，延迟 -22%、completion -28%；合成场景语义无劣化（evidence/d2-model-migration.json、d2-thinking-probe.json）
- 真实干跑 2 会话 60 轮：59 applied + 1 skipped，23 节点 3 shift 2 influence，平均 837ms/轮，成本上界 ¥0.25；1 次网络波动 retry 自动恢复（evidence/d2-real-dryrun.json）
- 端到端：追加轮 → 节点可见 2479ms ≤ 8s；重复投递图不变（evidence/d2-e2e-latency.json）
- 返工1：续写 rollout 共享 thread session_id 导致轮次冲突 → sessionId 按文件映射（文件名唯一稳定），单测覆盖
- 返工2：previous-turn 相似度跟踪在分析前更新，失败轮补跑被误判复读而 SKIP → 改为轮次真正处理后更新，单测覆盖

### 安全
- Key 仅存 ~/.thought-atlas/config.json（600）；仓库精确 Key / sk- 模式 / git 全历史扫描均 0 命中
- ~/.codex 全程只读（不写文件、不装 hooks、不碰 notify）；hooks.json 哈希与基线一致；config.toml 哈希偏差归因为作者 Codex 客户端活跃使用自行重写（mtime 10:04，详见 verification-d2.md §5）
- 真实对话正文只存 ~/.thought-atlas/（本机）；黄金草稿目录 700 文件 600，待作者 §10.5 逐段授权；evidence 仅聚合统计

## v0.1.0 — D1（2026-11-23）

### 新增
- 仓库脚手架：npm workspaces + TypeScript（Node 24 原生 TS，零运行时依赖），packages/core、daemon、adapters（codex/qoder/claude-code/watcher 占位）、web、site、samples、evidence、docs
- core/types.ts：§5 全部数据结构（TurnPayload/Node/Edge/MapOp/EventRecord/GraphMap）
- core/graph.ts：图状态机——应用 MapOp、整批原子性、拒绝非法/悬空操作、幂等去重、events.jsonl 事件日志 + map.json 物化视图、@new/@prev 批内占位符、influence 边方向校验
- core/filter.ts：跳过过滤器（<20 字 / 纯确认词 / 相似度>0.95）
- core/schema.ts：分析器输出严格 JSON schema 校验，非法整包丢弃
- core/analyzer.ts：§6 契约（输入预算 4000 字符/3000 token/500 token、四判断优先级、宁合并少新建、few-shot 3 正例+4 反例、注入防护分隔符、20s 超时重试 1 次）
- core/ports.ts：Storage/ModelClient/Transport 注入接口（core 零平台 import）
- daemon：FsStorage（~/.thought-atlas/sessions/ 布局，map.json 原子写）、DeepSeekClient（读本地 config.json，JSON output，温度≤0.3）
- scripts/d1-synthetic.ts：合成学习场景（浮点误差理解转变）端到端管线
- 单测 34 个全绿（graph 状态机 / 非法输出丢弃 / 幂等 / 过滤器 / 预算截断）
- docs/verification-d1.md：Codex 触发机制 + Qoder Sites 托管能力两项只读验证结论

### 验证与返工
- DeepSeek 真实调用 3 轮迭代（证据 evidence/d1-deepseek-run{1,2}.json 为返工记录，run.json 为终版）：
  - run1：转变过早判定（turn1 抢跑）+ fromNodeId 误指 ai-voice → prompt 增加「转变须已表现、fromNodeId 须为用户节点」约束与反例4
  - run2：MARK_SHIFT 与 SUPERSEDE 批内冗余被状态机正确拒绝（失败隔离生效）→ prompt 明确「fromNodeId 已自动 supersede，勿重复」
  - run3（终版）：4 轮合成对话全通过，5 节点 2 边 1 shift 1 influence，重述轮正确 REINFORCE 不加新节点；总耗时 4148ms，4928 prompt + 281 completion tokens
- Codex 实测关键发现：hooks.json 空闲可用（Stop 事件）；**notify 槽位已被 Computer Use 组件占用**，推荐组合修正为 hooks Stop 门铃 + rollout 字节游标，notify 不启用（详见验证文档 §1.5，建议中枢更新计划 §7.1）

### 安全
- API Key 仅存 ~/.thought-atlas/config.json（600），全仓库扫描 0 命中
- Codex 验证全程只读，未改 ~/.codex 任何文件；rollout 仅提取事件类型骨架，未记录任何用户对话正文