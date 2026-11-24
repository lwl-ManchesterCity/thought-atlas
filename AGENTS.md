# AGENTS.md — 思维星图 / Thought Atlas

2026 Qoder 高校创造力大赛 · StudyHack 赛道参赛作品。提交截止 **2026-11-30 18:00**，
交付物 = 公网可访问的 Qoder Sites 链接 + 论坛作品帖。

**本仓库是唯一事实来源。** 聊天记录、会话记忆都可能过期；冲突时以代码、`git log`、
`docs/思维星图-开发计划.md` 和 `CHANGELOG.md` 最新一节为准。接手前先读这三处，
再用自己的话复述「产品是什么 / 现在做到哪 / 下一步算什么 / 哪些事绝对不做」，复述得到确认后再动手。

## 1. 铁律（作者原话，逐条执行）

> 铁律：本任务书不含任何 publish（私有/公网都等中枢另行请批）；Secret 只声明名字不碰值；
> 真实会话内容不进仓库/证据/发布产物；黄金 fixture 不入库；不改 analyzer 凑边；
> ~/.codex 与 ~/.qoder-cn 只读。

展开：

- 不做任何 Sites 云操作（prepare / publish / backend / 迁移 / Secret），除非作者在当轮明确批准；默认只做本地改动 + 本地 git 提交，不 push、不建 PR。
- 仓库、`evidence/`、样例、发布产物里只允许出现**合成数据**。真实对话、真实人名、密钥、截图中的原文一律不进。
- 密钥只在 `~/.thought-atlas/config.json`（600）或环境变量里；文档、代码、日志、截图都不得出现值。
- 不为「图更好看」去改 analyzer 的判定逻辑。分析器的真实输出差也要如实呈现。
- `~/.codex`、`~/.qoder-cn` 只读：不修改 hooks、config、会话文件，不往里写任何东西。
- `site/.思维星图 Thought Atlas.qoder.site` 是本机设计工作台描述符，保持 untracked，不要提交。

## 2. 产品一句话

一个长在 AI agent 旁边的本地插件：每轮对话结束做一次轻量分析，把值得记的论点、问题、事实与
认知转变挂到一张持续生长的「思维星图」上——不是事后总结，是思路变化的现场记录。
公开演示 = 同一引擎的站点五页（首屏 / 回放样例 / 实时沙箱 / 安装 / 边界与隐私）。

## 3. 当前状态（具体数字以 `git log`、CHANGELOG 最新一节、实际运行结果为准）

- 阶段：D7 完成（CHANGELOG v0.8.6）。公网站点已发布 https://thought-atlas-njl1tep74um.qoder.zone/ （线上文案至 v0.8.3 + 线上 500 修复；v0.8.5 用途叙事与 GitHub 链接待再发布批准）；源码公开在 https://github.com/lwl-ManchesterCity/thought-atlas 。
- 测试：`npm test` 125/125；三套 tsconfig typecheck 全绿；`npm run check:core` 8 文件一致。
- 本地服务：7788 = 守护进程（按请求服务 `packages/web/dist`）；7790 = 站点 dev server（`site/dev/server.ts`，`Cache-Control: no-store`）。
- 站点模型：7790 默认走真 DeepSeek（读 `~/.thought-atlas/config.json`，不打印 key）；`ATLAS_SITE_MODEL=stub` 强制桩模型；无 key 时自动降级桩。`/api/health` 与 `/api/selfcheck` 返回真实 label 与 `stub` 标记，沙箱页对桩模型明确提示「非真模型」。
- 适配器：Codex、Qoder 已实现，共用 watcher 核心；Claude Code 只有 README 存根，**不得声称支持**。
- 样例：`site/samples/` 全部为合成演示数据，页面必须标注「合成」；真实样例需作者逐段批准后放入。
- 站点文案口径：只承诺 Codex / Qoder 两个适配器；解析器是注册制的，其他 agent 需实现 `ParserModule`。

## 4. 常用命令

```bash
npm test                 # node --test，125 个
npm run typecheck        # 根 + packages/web + site 三套 tsconfig
npm run check:core       # site/functions/lib/core 与 packages/core 同步校验
npm run build:web        # daemon 前端产物 -> packages/web/dist/app.js
npm run build:site       # 站点静态产物 -> site/dist（样例闸门，gateReason 非空是预期）
npm run dev:site         # 7790，默认真 DeepSeek（有 key 时）；ATLAS_SITE_MODEL=stub 强制桩模型
npm run check:site       # headless Chrome 站点验收（冷开、回放、沙箱、限流、XSS、390/320）
```

守护进程：`node packages/daemon/src/main.ts`（7788）。改 core 后需重启守护进程。

## 5. 目录地图

- `packages/core/` — 环境无关引擎：跳过过滤、图状态机、event store、retry（不 import 平台代码）
- `packages/adapters/` — `codex`、`qoder`、`watcher`（字节游标/重放/去重/`ParserModule` 注册）；`claude-code` 仅 README
- `packages/daemon/` — 本地守护进程 + SSE 传输 + BYOK 模型调用
- `packages/web/` — 共享渲染器 `src/renderer.ts`（daemon 与站点 demo 共用）+ daemon UI
- `site/` — 站点五页（`web/`）、Sites Function（`functions/`，core 为逐字节同步产物）、dev server、migrations
- `site/samples/` — 合成样例与 manifest（构建时经闸门拷到 `site/dist/samples/`）；真实样例批准文件在 `~/.thought-atlas/sample-approvals.json`，不入库
- `scripts/` — d1…d6 构建/同步/验收脚本；`docs/` — 开发计划与逐日验证；`evidence/` — 聚合证据

## 6. 验收与证据规范

- 每项改动汇报固定格式：**commit hash + 改动清单 + 测试计数 + 证据路径**。没跑过的验证不许写成通过。
- 视觉改动：用 headless Chrome（CDP）截图 + 像素/几何测量；渲染器像素 A/B 用固定种子替换
  `Math.random`（播种点在 `packages/web/src/renderer.ts` 布局初始化处）保证可重复。
- 「被遮挡 / 显示异常」类问题先查祖先 `overflow` 裁剪链、计算样式与环境（浏览器 auto-dark 是环境问题，不是页面 bug），rect 重叠本身不算证据。
- 行为/渲染改动后至少跑 `npm test` + `npm run typecheck`，并给出实际数字。

## 7. 工作方式（作者偏好）

- 讨论先行：新需求先复述理解 + 给方案（必要时给样张/选项），确认后再写代码；大改先出规格。
- 不做范围外重构；视觉批评按「结构意图」修，不逐像素调参。
- 中文汇报，结论直给：做得到 / 做不到，不粉饰、不认领未验证的说法。

## 8. 待办与禁区

- **待作者批准**：Sites 公网发布、论坛作品帖（硬性五部分见计划书 §13）、可选 3 分钟录屏。
  Sites 云操作必须在**本仓库所属的会话/工作区**执行，其他会话会返回 `design_forbidden` /
  `sites_current_session_required`；且没有当轮批准一律不做。
- **已推迟**：supersede（取代）边箭头——作者原话「看效果再说」。
- **永不**：提交真实会话内容、黄金 fixture、密钥；未批准的云资源；`--no-verify`；改写 git 历史。