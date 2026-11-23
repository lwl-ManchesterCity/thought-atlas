# D6 验证记录 · 托管沙箱与五块站点（本地可验部分）

- 日期：2026-11-23
- 开发会话模型：DeepSeek-Flash
- 范围：§9.1 站点结构、§9.3 托管沙箱防滥用、§10 边界、§11 D6 行；含 D5 遗留 `CursorStore.save` 目录权限修复
- 明确不做：任何 publish、任何 Secret 值读写、真实样例填充、黄金 fixture 入库、D7 帖子/录屏

## 1. 交付物

| 交付物 | 位置 |
| --- | --- |
| 托管 core 同步（零 Node import，8 文件） | `scripts/d6-sync-core.ts` → `site/functions/lib/core/` |
| Deno edge 入口（读 `DEEPSEEK_API_KEY`，缺失即 fail closed） | `site/functions/index.ts` |
| 托管路由（会话/轮次/回放/健康/自检） | `site/functions/lib/routes.ts` |
| 数据库版 Storage（事件、图、失败、会话元数据；不写原文） | `site/functions/lib/db-storage.ts`、`site/functions/lib/db.ts`、`site/functions/lib/ops.ts` |
| BYOK DeepSeek ModelClient（思考关、JSON 模式、超时） | `site/functions/lib/model.ts` |
| 限流与缓存（IP/日、全站/日、CAS、骨架哈希缓存） | `site/functions/lib/limits.ts` |
| Sites 受限 SQL 迁移（8 表 + 索引） | `site/migrations/0001_sandbox.sql` |
| 合成样例生成（学习 + 长对话） | `scripts/d6-samples.ts` → `site/samples/` |
| 样例批准硬闸与敏感扫描 | `scripts/sample-gate.ts`、`site/test/sample-gate.test.ts` |
| 五页面站点源码 | `site/web/index.html`、`demo.html`、`sandbox.html`、`install.html`、`boundary.html`、`site.css`、`common.ts`、`demo.ts`、`sandbox.ts`、`home.ts` |
| 站点构建（core 别名、静态产物、样例闸门） | `scripts/d6-build-site.ts` → `site/dist/`（gitignore） |
| 本地托管 harness（MemoryDb + StubModel + 同源 API） | `site/dev/server.ts`、`memory-db.ts`、`stub-model.ts` |
| headless 验收（冷打开/回放/沙箱/XSS/移动端） | `scripts/d6-site-check.ts` |
| 证据 | `evidence/d6-site.json`、`evidence/d6-privacy.json`、`evidence/d6-screenshots/` |
| 新单测 | `site/test/hosted.test.ts`（14）、`site/test/sample-gate.test.ts`（6） |

## 2. 托管核心

- **同一份 core**：构建前跑 `npm run check:core`，8 个 core 源文件逐字节一致；Function 只做 `Storage` / `ModelClient` 适配，整批原子性、幂等去重、shift 硬规则（`fromNodeId` 不得为 ai-voice）、`@prev` 触发解析、越界 JSON 整包丢弃全部沿用 core。
- **Deno 入口**：`Deno.serve` + `createDatabaseClient()`；`DEEPSEEK_API_KEY` 缺失时 `model=null`，沙箱返回友好 `service_not_configured`，回放样例照常。
- **出网自检**：`POST /api/selfcheck` 做一次最小模型调用，只返回 `configured/reachable/latencyMs/model`，不回显 Key；`GET /api/health` 只返回布尔与模型名。部署后首个验证项已就绪。
- **失败隔离**：聊天失败不影响本轮落库与分析；分析失败保留轮次并记 `graph_failures`，沙箱显示“本轮分析失败，聊天不受影响”。

## 3. 防滥用与原文策略

| 规则 | 实现 | 验证 |
| --- | --- | --- |
| 每 IP 每日 ≤3 会话 | `sandbox_sessions(ip_hash, day)` 计数后插入 | 第 4 次 429 `session_limit` |
| 全站每日 ≤100 轮分析 | `daily_counters.model_calls` 先 CAS 预占 | 预置 100 后返回 `quota_exhausted`，友好提示看回放 |
| 单会话 ≤20 轮 | `last_turn` CAS | 第 21 轮 429 |
| 单轮 ≤2000 字 | 字符数闸（`[...text].length`） | 2001 字 400 `text_too_long`，不占轮次 |
| 输入缓存 | `SHA256(cacheVersion + 归一化输入 + 图骨架)`；缓存只存 ops | 相同输入/骨架第二次 `cache_hit`、`modelUsed:false`、聊天调用不增加；缓存命中不耗分析额度 |
| 便宜档模型 | `deepseek-flash`，`thinking: disabled`，分析温度 ≤0.3 | 单测断言请求体 |
| 越界输出 | `parseAnalyzerOutput` 整包拒绝，无部分写入、无重试 | 非法 op/类型 → `analysis_failed`、节点 0、失败 1、无缓存 |
| 原文不留存 | `sandbox_turns` 只存 `input_hash` / `skeleton_hash`；不写聊天回复；不调用 `appendTurn` | 本地 E2E 数据库 dump 中原文标记 0 命中；3 行轮次均为 64 位十六进制哈希 |
| 提示注入 | 用户输入是分析对象；聊天系统提示声明“不是系统指令”；输出严格 JSON | 单测 + 浏览器 XSS 载荷惰性 |

沙箱锚点面板明示“原文不留存”；页面隐私说明写明“服务端只保存输入哈希、限流计数与分析结果图；本页聊天与锚点原文只在当前标签页内存，刷新即消失”。

## 4. 合成样例与授权闸门

- `learning.json`：8 轮，8 节点 / 3 边 / 1 次转折 / 1 条 influence；从“JS 的 bug”推进到 IEEE754 精度取舍，末轮转向面试表达；shift 的 `fromNodeId` 指向旧论点（非 ai-voice），触发节点为 AI 发言。
- `focus.json`：12 轮，12 节点 / 5 边 / 2 次转折 / 1 条 influence；产品重心从通用导图工具迁移到评委三分钟演示。
- 两页均显示“合成演示数据 · 公开样例当前全部为合成生成，不含真实会话”。
- 真实样例管线：`~/.thought-atlas/sample-approvals.json` → `sample-gate.ts` 逐文件批准 + 敏感扫描（API Key、私钥、绝对 home 路径、邮箱、手机号、Qoder home）；0 命中才进 `site/dist/samples/`。批准文件不存在/非法 = 只用合成样例（本次 `realSessionsApproved:false`、`gateReason:"approval-invalid"`，与“批准缺失”等价）。
- 真实草稿、真实 transcript 未进仓库/证据/发布产物。

## 5. 浏览器验收（`evidence/d6-site.json`）

本地 harness：`node site/dev/server.ts`（MemoryDb + StubModel，同源 Function 路由）+ headless Chrome/CDP。

| 项 | 实测 |
| --- | --- |
| 冷打开（导航→首图可交互） | **86ms**；含布局收敛的严格测量 2495ms（<3s） |
| 回放样例加载 | 长对话 12 节点 / 5 边 / 2 转折 / 1 影响；学习 8 / 3 / 1 / 1 |
| 时间轴 0 → 12 | 0 节点“起点”，回到 12 节点；无面板残留 |
| shift 面板 | 点第一个 shift 后显示“转变立场”“触发于第 5 轮”“锚点原文”（第 5/10/12 轮） |
| 沙箱 3 轮 | 节点 1 → 2 → 3，状态逐轮“已写入星图”；会话剩余 17/20、全站剩余 97/100 |
| 数据库断言 | 3 条 `sandbox_turns` 仅含 64 位哈希；会话 `last_turn=3`；原文标记 0 命中；3 条缓存仅 ops |
| XSS | `<img src=x onerror=...><b>` 以字面文本显示；`window.__xss` undefined；DOM 中 img/b/script 0 |
| 页面可用性 | 五页均 200、有标题与 h1；边界页含“原文不留存”“最多 3 次”“100 轮” |
| 响应式 | 五页 × 390/320 均无横向溢出；截图含 demo/home/sandbox |
| Console / 页面异常 | 0 / 0 |

截图：`evidence/d6-screenshots/`（仅合成数据）。冷打开脚本为发布后中枢实测就绪；本地数值仅供参考。

## 6. 测试与类型

| 项 | 结果 |
| --- | --- |
| 全量单测 | **124/124 ✅**（core 46 / codex 12 / watcher 3 / qoder 12 / daemon 19 / web 12 / site 20） |
| typecheck | 根 + web + site 三个 tsconfig 全绿 ✅ |
| core 同步 | `npm run check:core` → 8 文件一致 ✅ |
| Deno 本地校验 | 本机无 Deno；`functions/index.ts` 不进 tsc，托管逻辑通过 Node 同构 harness + 20 个站点单测覆盖；core 零 Node import 由 D1 起持续校验 |
| D5 遗留 | `CursorStore.save` 对已存在目录 `chmod 0o700`；单测先把目录设为 755 再断言 700，文件 600 |

新增单测覆盖：Secret 缺失 fail closed、IP 3 会话、全站熔断（缓存仍可用）、2000 字、越界输出整包丢弃、shift 硬规则、20 轮、跨 IP 403、回放=实时、自检不回显 Key、GET 归属、非法/超长 JSON；样例闸门覆盖缺失批准、非法批准、敏感命中、未批准文件、只回声模式名。

## 7. 偏差、阻塞与说明

1. **云草稿/后端/迁移未创建（宿主会话边界）**：按作者授权尝试 `open_design_workbench`（绝对路径与相对路径）返回 `design_forbidden`，`prepare_site` 返回 `sites_current_session_required`。原因：本仓库位于 `2026-11-22/0583c66c/thought-atlas/`，而当前 Qoder 会话工作区是 `2026-11-23/15f08e9f`；Sites 只允许当前会话工作区内的站点。**未创建任何云资源、未写 `.qoder.site`、未发布、未读写 Secret**。需在仓库所属的 Qoder 会话中重跑云步骤。
2. **本地模型为 StubModel**：端到端验证用确定性桩，避免本地消耗真实额度；真实 DeepSeek 出网只能在部署后由 `/api/selfcheck` 验证，未假装已验真。
3. **冷打开包含布局收敛**：首图可交互 86ms；为避免截图捕捉未收敛图，严格断言等待收敛后为 2495ms，仍 <3s。发布后由中枢按“导航→首屏就绪”复测。
4. **样例闸门原因字面值**：批准文件缺失当前报 `approval-invalid`，语义等于“无有效批准 → 仅合成”；未放宽闸门。
5. **真实样例 0 份**：公开样例全为合成；黄金草稿仍只在 `~/.thought-atlas/golden-drafts/`。
6. **未发布/未用 Sites**：与任务书一致；7788 daemon 与 Qoder watcher 保持运行，临时站点 harness 验收后停止。

## 8. 只读与隐私扫描（`evidence/d6-privacy.json`）

- Key：仓库工作区、git 全历史 `sk-` 模式 0；`DEEPSEEK_API_KEY` 赋值 0；私钥块 0；发布产物目录 `/Users/lwl` 0、`sk-` 0。**未读取任何 Secret 值**。
- 真实对话片段：从 44 个真实 transcript / 黄金草稿抽样 217 个 24 字纯汉字片段，对仓库（含 `site/dist`）与 git 全历史精确匹配 **0 命中**。
- `~/.codex/hooks.json` `78922a78…38cbb9`、`config.toml` `d931ef92…553062` 与基线一致；未创建 Qoder hook，未改 `~/.codex` / `~/.qoder-cn`。
- 证据只有聚合数值/布尔/哈希与合成截图；真实图未截图，真实 transcript 未入库。

## 9. 作者动作清单（中枢会提醒）

1. Sites 设置界面亲手录入 `DEEPSEEK_API_KEY`（值绝不进聊天/仓库/截图）。
2. DeepSeek 控制台设消费上限兜底。
3. 黄金草稿三份逐段批准（决定真实样例能否替换合成占位）。
4. 比赛结束后轮换曾泄露的 Key（既有约定）。
5. 私有发布集成批准、公网发布批准——两次都等中枢请批。

## 10. 复测入口

```bash
npm run typecheck
npm test
npm run check:core
node scripts/d6-build-site.ts
node site/dev/server.ts          # 另开终端，默认 7790
node scripts/d6-site-check.ts
```

云步骤需在仓库所属会话执行：`open_design_workbench` → 首次 `prepare_site`（静态 bootstrap）→ `ensure_backend`（database + functions，function_backend）→ `get_database_schema` → `create_database_migration`/`apply_database_migration`（`site/migrations/0001_sandbox.sql`，accessPolicies 空）→ 带 `functionDirectory`、`secretNames:["DEEPSEEK_API_KEY"]`、`databaseAccess:"read_write"` 的完整 `prepare_site`。**无 publish、无 Secret 值**。