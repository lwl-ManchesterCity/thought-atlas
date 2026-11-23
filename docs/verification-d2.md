# D2 验证记录（2026-11-23）

> 实现会话产出，供中枢评审。对应计划 v1.3 §11 D2 交付物。
> 证据文件：`evidence/d2-model-migration.json`、`d2-thinking-probe.json`、`d2-flash-deepseek-run.json`、`d2-real-dryrun.json`、`d2-e2e-latency.json`

## 1. 模型别名迁移（D2 首任务）

- `~/.thought-atlas/config.json` model：`deepseek-chat`（弃用别名）→ `deepseek-flash`（V4.1-Flash 正名）。仅改 model 字段，Key 未动，文件权限 600 保持。
- 官方文档确认（api-docs.deepseek.com）：
  - flash 思考模式**默认开启**（effort high），思考模式下 temperature 失效；请求体 `thinking: { type: "disabled" }` 可关闭
  - JSON output（`response_format: { type: "json_object" }`）要求 prompt 含 "json"；无法识别为 JSON 时 API 会把内容替换为空格 → 客户端加空白内容守卫，按调用失败触发重试
- 代码同步：`DeepSeekClient` 对 deepseek 系模型显式关闭思考；仓库内无其他硬编码模型名。

### 迁移前后对比（同一 4 轮合成学习场景）

| 指标 | 迁移前（别名，思考默认开） | 迁移后（flash，思考关） |
|---|---|---|
| 总延迟 | 4148ms | 5180ms（1977/1776/1427） |
| prompt tokens | 4928 | 4873 |
| completion tokens | 281 | 258 |
| 图结果 | 5 节点 2 边 1 shift 1 influence | 4 节点 2 边 1 shift 1 influence |

语义对比：shift / influence / supersede / REINFORCE 全部一致；flash 少建 1 个边缘 fact 节点（「正在学JavaScript」），符合「宁少新建」原则。**结论：质量无劣化**，延迟同量级波动。

### 思考开/关 A/B（同一 turn-3 分析请求）

| | 思考开 | 思考关 |
|---|---|---|
| 延迟 | 2201ms | 1722ms（-22%） |
| completion tokens | 173（含 113 推理字符） | 124（-28%） |
| 输出 ops | [ADD_NODE, MARK_SHIFT] | [ADD_NODE, MARK_SHIFT]（一致） |

关闭思考的决策依据：输出一致、更省更快。真实干跑 60 轮平均 837ms/轮（§4），远优于 20s 超时预算。

## 2. Codex rollout 解析器结论

结构确认（合成 fixture 单测 + 真实文件只读解析）：

- 每行 `{timestamp, ordinal, type, payload}`；`session_meta` 携带会话 ID
- 轮界 = `event_msg.task_complete`（含 `turn_id`、`last_agent_message`、`completed_at`）；`turn_id` 去重保证幂等
- 正文只取 `response_item.message` 的 user/assistant 角色 `content[].text`；**developer 角色、reasoning、一切工具记录全部排除**；user 文本剥离 `<environment_context>`/`<user_instructions>` 包裹
- assistant 正文缺失时回退 `last_agent_message`；空轮也推进 turnIndex（不重不漏）
- 字节游标增量读取：只消费新增完整行（到最后一个 `\n`），文件截断时游标归零

### D2 新发现：续写 rollout 共享 thread session_id（重要）

真实干跑首轮暴露：同一 Codex 线程的多个续写 rollout 文件（文件名带 `_` 后缀）`session_meta.session_id` **完全相同**，且各文件轮次从 1 重新计数。直接按 session_id 投递会导致第二个文件全部撞幂等去重被丢弃。

**处理（§5.1 适配器映射职责内）**：sessionId 按 rollout **文件**映射——取文件名去掉 `rollout-` 前缀与 `.jsonl` 后缀（含时间戳+线程 UUID+续写 UUID，唯一且稳定）。每个 rollout 文件一张图，符合「单会话一张图、不跨会话合并」的产品决策。已加单测覆盖 override 与文件名推导。此映射规则建议中枢回写计划 §7.1。

## 3. watcher + daemon 端到端

- watcher：轮询（1500ms）`~/.codex/sessions/` 目录增长 → 字节游标读增量 → 解析 → POST daemon `/turn`（2s 超时）。tail 模式启动时静默消费全部历史（建立 sessionId/轮次计数/turn_id 去重），只投递启动后的新轮。投递失败进内存 pending 队列下轮重试。**对 watched 目录零写入**（单测断言文件内容前后一致）。
- daemon：`POST /turn`（校验+每会话串行队列+幂等）、`GET /events`（SSE 广播+15s 心跳）、`GET /map`、`GET /health`；绑定 127.0.0.1，端口来自 config（默认 7788）。
- retry：分析失败 → `failures.jsonl` + `retry.jsonl`（attempts 上限 5）；空闲补跑（activeIngests=0 时），恢复后清队列，耗尽转 failures 诚实可见。
- **修复的返工 bug**：previous-turn 相似度跟踪原本在分析前更新，导致失败轮补跑时被误判为「与上一轮相似度>0.95」而 SKIP。改为仅在轮次真正处理（applied/skipped）后更新。单测覆盖。

### ≤8s 端到端验收（真实 rollout 副本法）

把真实 rollout（6 轮）**复制**到 /tmp，watcher tail 模式静默 seeding 后向**副本**追加 1 个合成轮（绝不改真实文件）：

- 追加 → 节点可见：**2479ms**（预算 8000ms，含 1.5s 轮询 + 真实 DeepSeek 分析）✅
- 同轮重复 POST：`duplicate`，map JSON 前后完全一致 ✅

## 4. 真实会话干跑（聚合统计）

两个近期真实 rollout，只读解析 + 真实 DeepSeek 分析，星图真实生长。原文只存 `~/.thought-atlas/sessions/`（本机产品存储），**仓库/evidence 只含聚合统计**。

| 会话（文件映射 ID 略写） | 轮数 | applied | skipped | 节点 | shift | influence | 平均/最大延迟 | tokens（prompt/completion） | 成本上界* |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-19T19-35-57-…_01a1f397… | 44 | 43 | 1 | 18（claim 8 / question 5 / fact 3 / ai-voice 1 / shift 1） | 1 | 1 | 834 / 1299ms | 88874 / 1473 | ¥0.19 |
| 2026-11-17T11-18-01-…_01a1e782… | 16 | 16 | 0 | 5（question 1 / claim 1 / ai-voice 1 / shift 2） | 2 | 1 | 841 / 1551ms | 28573 / 404 | ¥0.06 |

\* 成本上界按保守费率 ¥2/M prompt + ¥8/M completion 估算（flash 实际费率更低），60 轮合计 ≤ ¥0.25，远低于「100 轮 ≤ ¥1」目标。

- ops 分布：ADD_NODE 21 / REINFORCE 8 / MARK_SHIFT 2 / SKIP 35（分析器自判 SKIP 34 + 过滤器 1）——「宁合并少新建」在真实数据上生效：60 轮仅 23 个新节点
- 首轮干跑曾出现 1 次 retry_queued（网络波动），空闲补跑自动恢复（retryRecovered=1）——失败隔离在真实环境验证
- 黄金候选（仅 ID + 轮数 + 结构推测，正文草稿在 `~/.thought-atlas/golden-drafts/`，目录 700 文件 600，待作者按 §10.5 逐段标注授权）：
  1. `2026-11-19T19-35-57-01a175c9-8f74-7052-a1b7-1b9cc7ef1360_01a1f397-8b60-7503-9286-8979f9fbfae0` · 44 轮 · 学习/讨论型
  2. `2026-11-17T11-18-01-01a175c9-8f74-7052-a1b7-1b9cc7ef1360_01a1e782-f5c4-79e1-ad81-7e71f6e45585` · 16 轮 · 学习/讨论型

## 5. 只读证明与偏差记录

| 文件 | 中枢基线 sha256 | D2 收工实测 | 结论 |
|---|---|---|---|
| ~/.codex/hooks.json | 78922a78…38cbb9 | 78922a784ee78e9e50587e93628cd3b9d4dfbe49087adc4514e6781cea38cbb9 | **一致** ✅ |
| ~/.codex/config.toml | 8f612ae5…67fa64 | d931ef927426e41afb45708153f67cfcf922b9bfbafc9d501e7c08f0fa553062 | **不一致** ⚠️ 见下 |

config.toml 偏差说明：本会话对 `~/.codex` 的全部操作均为只读（shasum/find/ls/stat/解析读取），未执行任何写入、未装 hooks、未碰 notify。该文件 mtime 为 **2026-11-23 10:04**（D2 开工基线核对之后），同期 `.codex-global-state.json` 于 10:13 更新——与作者本人正在活跃使用 Codex 客户端的行为一致（Codex 会自行重写 config.toml）。**归因：作者客户端自然写入，非本会话所为**，请中枢知悉并更新基线快照。

其他只读承诺兑现：真实干跑与 e2e 测试均只读真实 rollout；e2e 的追加写入只发生在 /tmp 副本；黄金草稿与原文仅存 `~/.thought-atlas/`（仓库外）。

## 6. 验收清单

- [x] 旧 34 + 新增测试全绿：**57/57**（core 36 / codex 12 / watcher 3 / daemon 6），typecheck 干净
- [x] 端到端轮末 → 节点可见 2479ms ≤ 8s（/tmp 副本法）
- [x] 重复投递图不变（daemon 单测 + e2e 实测）
- [x] 模拟分析器失败 → retry 队列 → 恢复补跑成功（单测）；真实干跑亦出现 1 次自动恢复
- [x] retry 上限耗尽转 failures（单测）
- [x] shift.fromNodeId 指向 ai-voice 被拒（MARK_SHIFT 与 ADD_NODE 双路径 + 整批原子性单测）
- [x] 仓库 Key 扫描：精确 Key 0 命中、`sk-` 模式 0 命中、git 全历史 -S 0 命中
- [x] hooks.json 哈希一致；config.toml 偏差已归因记录（§5）
- [x] 未公开发布、未创建其他会话、未修改计划文档