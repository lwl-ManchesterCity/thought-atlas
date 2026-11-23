# D1 验证报告（2026-11-23）

两项只读验证：Codex 触发机制、Qoder Sites 托管能力。全程未修改 `~/.codex/` 下任何文件，未读取/记录任何用户对话正文（rollout 仅提取事件类型骨架与键名）。

---

## 一、Codex 触发机制实测

### 1.1 本机环境事实

| 项 | 实测值 |
|---|---|
| Codex 形态 | Codex Desktop（originator: `Codex Desktop`，source: `vscode`），cli_version `0.163.0-alpha.10.2` |
| `~/.codex/hooks.json` | 存在，当前内容为 `{"hooks":{}}`（空配置，槽位空闲） |
| `~/.codex/hooks.json.bak` | 含完整事件词表（见 1.2），证明本机版本原生支持 hooks |
| `~/.codex/config.toml` | 顶层 `notify` **已被占用**：argv 指向 SkyComputerUseClient.app（Codex Computer Use 组件），参数 `turn-ended` |
| rollout 文件 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，共 38 个；抽样最新一个：238 行 / 1.4MB |
| codex CLI | 不在 PATH（桌面形态，不影响文件/hooks 机制） |

### 1.2 hooks 事件结构（来自 hooks.json.bak 骨架）

支持的事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`SubagentStart`、`SubagentStop`、**`Stop`**、`Interrupt`。

配置形态（Claude Code 同构）：

```jsonc
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "<脚本>", "timeout": 10 } ] } ] } }
```

- **`Stop` = agent 一轮回复结束**，正是本产品需要的触发时机。
- 当前 hooks.json 为空 → 写入 Stop hook **不与任何现有配置冲突**。
- 未实测项（D2 装探针时确认）：Stop hook 的 stdin payload 是否含 session_id / rollout 路径。兜底方案：hook 只当「该读增量了」的门铃，扫描 sessions 目录最新 rollout 即可，不依赖 payload 内容。

### 1.3 notify 结构

`notify = ["<SkyComputerUseClient 可执行文件>", "turn-ended"]`。notify 是**单槽位** argv 数组：直接写入我们的脚本会顶掉现有 Computer Use 集成。若要用 notify 必须做链式包装（先转发原程序再调自己），复杂度和风险都高于 hooks。

### 1.4 rollout 事件骨架（只取类型与键名）

每行结构：`{ timestamp, ordinal, type, payload }`，`ordinal` 从 0 单调递增（实测全文件单调），追加式写入 → **字节游标增量消费天然幂等**。

record type 分布（抽样文件）：

| type | 条数 | 说明 |
|---|---|---|
| `session_meta` | 1 | 首行；payload 键含 `session_id`、`id`、`cwd`、`cli_version`、`originator`、`source` 等 |
| `event_msg` | 112 | 子类型：`task_started`(12)、`task_complete`(12)、`item_completed`(53)、`token_count`(22)、`thread_settings_applied`(13) |
| `response_item` | 88 | 子类型：`message`(45)、`reasoning`(17)、`custom_tool_call`(10)、`custom_tool_call_output`(10)、`function_call_output`(2) 等 |
| `turn_context` | 12 | 每轮上下文设置 |
| `token_usage_record` | 22 | token 统计 |
| `world_state` | 3 | 环境状态 |

关键结构：

- **`event_msg.task_complete`** payload 键：`root_turn_id`、`turn_id`、`last_agent_message`、`started_at`、`completed_at`、`duration_ms` → **文件内自带「一轮结束」标记与助手最终回复**，turn_id 可直接映射 turnIndex 语义。
- `response_item.message` payload 键：`type`、`id`、`role`、`content`；role 分布 user/assistant/developer（16 条 developer 为环境注入，解析时**必须排除**）；content 项类型 `input_text`（文本在 `content[].text`）。

### 1.5 结论与推荐组合

| 机制 | 可行性 | 判断 |
|---|---|---|
| hooks（Stop） | ✅ 可行且槽位空闲 | **首选触发信号**。与现有配置零冲突；timeout 设 ≤2s，脚本只发通知不做分析 |
| notify | ⚠️ 可行但槽位被占 | 不推荐直接用；除非链式包装现有 Computer Use 程序，风险高 |
| rollout 增量读取 | ✅ 完全可行 | **正文唯一来源**。字节游标 + 只消费新增完整行；`task_complete` 定轮界，`message`(role=user/assistant) 取正文，排除 developer 与工具记录 |

**推荐组合：hooks Stop 门铃 + rollout 字节游标增量读取；watcher 监听 sessions 目录作兜底**（watcher 零配置侵入，可先行开发）。三重保险中 notify 降级为「不启用」，避免破坏用户现有 Computer Use 集成——这是对计划 §7.1「notify 次之」的一处实测修正：本机 notify 槽位非空闲。

D2 待确认：Stop hook stdin payload 字段；`task_complete.last_agent_message` 与 `response_item.message` 最终回复的一致性（优先用后者，前者作校验）。

---

## 二、Qoder Sites 托管能力验证

调研方式：只读。`sites.get_context`（平台运行时上下文）+ sites 官方 skill 参考文档（functions.md / api.md / diagnostics.md）。未创建站点、未分配后端、未创建 PAT。

### 2.1 本机运行时上下文（get_context 实测）

| 项 | 值 |
|---|---|
| 产品 / 区域 / 环境 | qoder-cn / cn / prod |
| Cloud Agents | `configured: true`，apiOrigin `https://api.qoder.com.cn`，路径前缀 `/api/v1/cloud` |
| Secret 录入 | `secretValueInput: true`（值只在站点设置界面录入，不进聊天/命令行） |
| 现有站点 | 无（sites 与 developmentSites 均为空） |

### 2.2 Function 能力

- 运行时：**Deno edge runtime**，入口 `index.ts`（打包为 `runtime/app.zip`），`Deno.serve(handler)` 形态；**不允许常驻后台进程**。逻辑名 `app`，浏览器走同源 `/functions/v1/app`（支持子路径与 query 路由），支持 SSE 与 WebSocket Upgrade。
- **允许服务端调用固定可信的第三方 API**（文档明确要求固定目标 + 超时 + 过滤响应）→ Function 内直接 `fetch https://api.deepseek.com` 合规。
- 配套能力：Function backend 数据库（限流计数/哈希缓存可用）、Storage、访客身份（网关注入 `x-qoder-user-context`，公开站可匿名）——§9.3 防滥用所需的计数与身份基础都有落点。
- **核心引擎可移植性**：打包器不做 Node 模块转换、不装依赖。本项目 core 零 Node import（存储/模型/传输全走 ports 注入），只用标准 TS + fetch + structuredClone → 可直接在 Deno 跑；托管模式只需另写一个 Storage 实现（数据库版）与 DeepSeek ModelClient（读 Secret 版）。**结论：托管核心可行。**

### 2.3 Secret 机制

- **应用 Secret**（放 DeepSeek Key 用这个）：在 `prepare_site.secretNames` 声明名字（如 `DEEPSEEK_API_KEY`；`QODER_`/`SUPABASE_`/`POSTGRES_` 前缀与 `DATABASE_URL` 为平台保留），值**只在站点设置专用输入框录入**，Function 内 `Deno.env.get(...)` 读取；值永不进源码、工具参数、聊天、前端产物。缺失时返回稳定的 `service_not_configured` 错误。
- **平台 Secret `QODER_PAT`**：开启 `qoder` 后端能力时平台自动创建并注入，专供 Function 调 Qoder Cloud Agents（QCA）；需用户明确确认后才创建。不可当应用 Secret 使用。
- 结论：§9.3「Key 存 Sites Secret、绝不进前端」**机制上完全成立**。

### 2.4 模型调用额度归属

两条路线，归属不同：

| 路线 | 认证 | 额度/成本归属 | 适配分析任务？ |
|---|---|---|---|
| A. 平台 QCA | Function 持 `QODER_PAT` 调 `/api/v1/cloud/*`，模型经 `GET /models` 选择 | 记在**站点 Owner 的 Qoder 账号额度**（文档有 `quota_unavailable` 与 owner credits 语义；具体计费数字未公开在 skill 文档中） | 未验证 JSON output/温度控制；Agent/Session/Environment 资源链较重 |
| B. 自带 Key（BYOK） | Function 持应用 Secret 直调 DeepSeek | 记在**作者自己的 DeepSeek 账户**，与平台额度无关，消费上限可在 DeepSeek 侧设置 | ✅ 与本地模式同一 ModelClient 契约，JSON output + 温度 0.2 已实测 |

**推荐：托管分析器走路线 B（DeepSeek Key 进应用 Secret）**——成本可控（单轮实测约 1700 prompt + 100 completion tokens，远低于 ¥0.01/轮目标）、与本地引擎完全同构、不依赖 QCA 资源链。QCA 留作沙箱聊天回复的可选升级，不作为 D6 关键路径。

### 2.5 诚实边界（未实测项）

1. edge runtime 到 `api.deepseek.com` 的实际出网连通性未测（文档允许，D6 部署后首个验证项）。
2. QCA 具体额度数字/计费规则未实测（需真实开后端 + 创建 PAT，属 D6 动作且需作者确认）。
3. 本次未创建任何站点/后端资源，全部结论基于平台上下文 + 官方 skill 文档。