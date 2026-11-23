# CHANGELOG

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