# D5 验证记录 · Qoder 适配器 / 通用 watcher 注册制 / 真实回填

- 日期：2026-11-23
- 开发会话模型：DeepSeek-Flash
- 范围：§7.2 适配器层、§7.5 真实接入与回填、§11 D5 行；Qoder watcher（只读、白名单）、通用解析器注册制、真实开发会话回填与回放、新轮实时上图
- 明确不做（属 D6/发布）：发布、Sites、D6 任何功能；未改 core 与 daemon

## 1. 交付物

| 交付物 | 位置 |
| --- | --- |
| 解析器注册接口 | packages/adapters/watcher/src/parser.ts |
| 通用 JSONL watcher（字节游标、快照恢复、截断/换 inode 重放、投递重试） | packages/adapters/watcher/src/jsonl-watcher.ts |
| 游标持久化（`~/.thought-atlas/watcher-cursors/`，0700/0600、原子写） | packages/adapters/watcher/src/cursor-store.ts |
| Codex 模块化（行为不变） | packages/adapters/watcher/src/codex-module.ts、codex-watcher.ts |
| Qoder 解析器（轮界、流式折叠、打断兜底、稳定 id、快照） | packages/adapters/qoder/src/qoder-parser.ts |
| Qoder 白名单（绝对路径或 sessionId，绝不枚举整个 projects） | packages/adapters/qoder/src/qoder-config.ts |
| Qoder 模块 / watcher / 启动入口 | packages/adapters/qoder/src/qoder-module.ts、qoder-watcher.ts、main.ts |
| 合成夹具与 12 个单测 | packages/adapters/qoder/test/fixtures.ts、qoder.test.ts |
| 合成端到端延迟验收（stub 模型 + headless Chrome） | scripts/d5-latency.ts |
| 重启/截断恢复验收 | scripts/d5-recovery.ts |
| 真实回填聚合统计（只读，仅数值） | scripts/d5-real-stats.ts |
| 证据 | evidence/d5-latency.json、d5-recovery.json、d5-real.json、evidence/d5-screenshots/ |

## 2. 通用 watcher

- `TranscriptParser`：`feedLine(line) -> TurnPayload | null`，可选 `snapshot()`；只按完整行喂入，半行留在缓冲区等下一次追加。
- `ParserModule`：`id` + `create(path, seed?)`；Codex 与 Qoder 实现同一接口，watcher 不感知平台。
- `JsonlWatcher` 统一负责：文件发现、按文件独立 tick、字节游标 + 解析器快照、重启恢复、截断或换 inode 时以当前快照 `reparse` 从 0 重放、首次见到文件时的 tail 静默播种、投递失败重试、全部 pending 投递成功后才持久化游标；单文件异常不拖垮其它文件。
- Codex 行为保持：`CodexWatcher` 改为包装 `JsonlWatcher`，构造/start/stop/tick 与递归 `rollout-*.jsonl` 发现不变，tail 模式不变；`postTurn` 仅新增可选超时参数。既有 3 个 watcher 单测与 12 个 Codex 单测全部原样通过。
- Qoder 默认 `from-start`（首启即回填历史），轮询 1s；Codex 默认 tail。

## 3. Qoder 解析规则

- 白名单：`~/.thought-atlas/config.json` 的 `qoderWatch`，元素为绝对 transcript 路径或 sessionId。本次仅配置开发会话一条；缺省/非法配置 = 不监听。sessionId 解析只查 `~/.qoder-cn/projects` 的**直接子目录**下同名文件，不枚举会话。
- 轮界：`origin.kind === "human"` 的 user 行开启一轮；该轮最后一条 `stop_reason === "end_turn"` 的 assistant 正文立即投递；被下一轮 human 打断的未完成轮用最后一条非空正文兜底。
- 流式折叠：同一 `message.id` 或重复行取最新非空文本；`tool_use` / `tool_result` / `thinking` / `attachment` / `isSidechain` / 压缩摘要不参与轮内容。
- 包装标签：`system-reminder`、`environment_context`、`user_instructions`、`qoder_delegated_input_sources` 在入图前剥离（委托输入源等系统元数据不属于人类正文）。
- 时间戳：ISO / epoch 秒 / epoch 毫秒统一为 ISO；按文件顺序推进轮次。
- 稳定映射：会话 `qoder-<sessionId>`；人类轮 id 优先 uuid → promptId → 内容哈希并随游标快照持久化，重放/重启不重复、turnIndex 单调。
- 游标快照包含已见 id、下一轮序号、未完成轮；截断/换 inode 重放时只补新轮。

## 4. 真实回填与实时

### 4.1 真实开发会话（`evidence/d5-real.json`，只读聚合）

| 项 | 实测 |
| --- | --- |
| transcript 行数（复跑采样） | 4172 行 / 8 人类轮 / 8.7MB |
| 回填轮次 | 7 个完成轮（turn 1–7），ops 5/5/3/1/5/1/5 |
| 图规模 | 23 节点 / 0 边；fact 12 / claim 10 / question 1 |
| lastTurn | 7 |
| 回放一致性 | 回放末态图与实时图签名一致（2cb3e556493a） |
| 进行中轮 | 1（D5 任务轮，尚未 end_turn，按设计不投递） |
| Codex 回归 | 3 个既有会话节点/边与哈希不变 |

### 4.2 合成实时延迟（`evidence/d5-latency.json`）

- 路径：合成 transcript → QoderWatcher（250ms 轮询）→ 嵌入式 daemon（stub 模型，5ms）→ headless Chrome。
- 新轮写入到浏览器节点增长：**213ms**，≤8s 达标；初始/末态步骤 1→2，Console 0 error、0 未捕获异常。
- 截图为合成会话，仅存放 evidence/d5-screenshots/。

### 4.3 合成恢复（`evidence/d5-recovery.json`）

- 游标偏移 687；daemon 停止→追加一轮→重启后按 [1,2] 顺序投递，重复 0。
- 将 transcript 截断到第 3 轮后，重放序列 [1,2,3]，无重复，持久化轮数 3，pass。

## 5. 测试与类型

| 项 | 结果 |
| --- | --- |
| 全量单测 | 104/104 ✅（core 46 / codex 12 / watcher 3 / qoder 12 / daemon 19 / web 12） |
| typecheck | 根 + web 两个 tsconfig 均无错误 ✅ |
| 新增 Qoder 单测覆盖 | 流式折叠与排除、tool_result 不产生轮、打断兜底、sidechain/包装标签（含委托输入源）、时间戳归一与顺序、快照中途恢复、重放只补新轮、watcher 回填/重启/截断、半行、sessionId 白名单/未列入忽略、缺配置不监听、游标 0600 与解析器状态 |

## 6. 只读与安全

- `~/.qoder-cn` 与 `~/.codex` 严格只读：Codex hooks.json `78922a78…38cbb9`、config.toml `d931ef92…553062` 与基线一致；未创建 `~/.qoder-cn/hooks.json`，未安装任何 hook。
- Key：仓库文本精确 Key 0 命中、`sk-` 模式 0 命中；git 全历史同样 0；真实配置未复制进仓库。
- 真实对话片段：从真实草稿提取 164 个含 ≥18 个汉字的 24 字片段，对仓库与 git 全历史扫描均 0 命中。
- 真实 transcript 未进仓库、未做夹具、未入证据；`evidence/d5-real.json` 仅聚合数值与布尔/哈希；真实图未截图入库；黄金 fixture 未入库。
- 监听面严格白名单：仅开发会话一条；未扫描其它 projects 会话，未默认监听目录。

## 7. 偏差与说明

1. **真实图 0 边**：开发会话前 7 轮为工程流程记录，分析器提取出孤立 fact/claim，没有产生 influence/related 边。这是模型真实输出，未为凑边修改 analyzer/core/提示词。
2. **第 8 个人类轮（D5 任务本身）在采样时仍在进行**：该轮被上下文压缩打断，尚无 `end_turn` 行，解析器按设计保留 pending、不投递；证据记录 `inProgressTurnExcluded=1`。下一人类轮到来时用兜底正文收尾并投递，实时 watcher 无需人工干预。
3. **证据为采样快照**：d5-real.json 复跑采集时 transcript 4172 行（会话仍在增长），stats 脚本从 `~/.thought-atlas/config.json` 的 `qoderWatch` 取 transcript，不硬编码路径。
4. **Qoder 从文件头回填、Codex 从尾部起步**：平台用途不同（历史开发会话需要完整回放；Codex 适配器保持 D2 行为不回退）。
5. **外部改动**：`evidence/d4-fixture.json` 存在中枢复测留下的 home 路径改动（`/tmp/atlas-d4-recheck-home`），非本阶段产物，未纳入 D5 提交。
6. **进程**：7788 真实 daemon（PID 30142）与 Qoder watcher（PID 31207）保持运行供复测；游标目录 `~/.thought-atlas/watcher-cursors/`（0700/0600）。
7. 未实现 D6、未发布、未使用 Sites。