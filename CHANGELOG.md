# CHANGELOG

## v0.8.0 — 星图导出分享卡 + 安装脚本化（2026-11-24）

### 变更
- 渲染器新增 `exportPng()`（强制当帧重绘后 toDataURL）；common.ts 新增 `downloadMapCard`：标题栏 + 星图 + 统计栏 + 来源标注合成分享卡并触发下载
- 回放页时间轴栏与沙箱地图栏各加「导出星图」按钮：回放卡标注「合成演示数据」，沙箱卡标注「只含节点级摘要，不含对话原文」；沙箱空图时提示聊一轮再导出；沙箱渲染同步启用 stepOrder 序号
- 新增 `setup.sh`：Node 22.18+ 检查、npm ci、build:web、生成 600 权限配置模板（apiKey 留空待用户自填）；已有配置跳过不覆盖、不读不打印 Key
- 安装页文案改回现实：命令块 `./setup.sh`（一键脚本 · 当前阶段），npm 发布版明确「赛后再提供」；Node 门槛 24+ 改 22.18+（推荐 24）；「源码方式」改「脚本里做了什么（等价手动命令）」

### 验证
- typecheck 干净；125/125；build:site 通过
- headless 下载实测：回放卡 130328B、沙箱桩卡 92427B，PNG 落盘、Console/页面异常 0；卡片像素复核（标题/序号/起点/统计/标注齐全）
- setup.sh 实跑：npm ci + build:web 成功、已有配置跳过（Key 未触碰），日志 `evidence/d7-install/setup-run.log`
- 桩实例 7791 全量验收绿（health.stub=true 自标注）；发现并纠正一次取证失误：install 文案改动晚于上次 build:site，首张安装页截图为旧文案，重建后重取重验
- 新证据：`evidence/d7-export/`（card-demo-focus.png、card-sandbox-stub.png、demo-export-ui-1280.png）、`evidence/d7-install/`（install-1280.png、setup-run.log）

## v0.7.4 — 沙箱限流收紧：每日 2 会话、单会话 15 轮（2026-11-24）

### 变更
- `LIMITS` 真值：`sessionsPerIpPerDay` 3→2、`turnsPerSession` 20→15（全站每日 100 轮分析不变）；服务端 CAS 强制随之生效
- 同步全部用户可见文案：错误提示（errors.ts）、沙箱页头/硬限制 callout/meta、沙箱系统气泡四条、边界页限流列表、首页模块 02、README
- 单测同步：per-IP 会话上限改 2（第 3 次 429）、单会话上限改 15（last_turn=15 时 429）
- 验收断言同步：边界页「最多 2 次」；历史 CHANGELOG 与 docs/verification-d6.md 保留旧值作为当时记录

### 验证
- typecheck 干净；125/125；build:site 通过
- 桩实例 7791 全量验收绿（见 evidence/d6-site.json，health.stub=true 自标注）

## v0.7.3 — 链路可读性：步序号 / 起点 / 首页生长回放（2026-11-24）

### 变更
- 渲染器新增站点专用开关 `stepOrder`：节点上方画步序号（出生序 1…N）、首节点「起点」徽标、脊柱推进线与箭头加深；默认关闭，本地产品渲染不变
- 渲染器新增 `rowWidth` 选项（默认 1000 不变）：首页迷你星图用 520，蛇形排成 3 行、缩放接近 1，节点与标签回到可读尺寸
- 首页迷你星图从静态完成图改为自动生长回放：每 900ms 长一轮、末轮停 3.2s 后循环；`prefers-reduced-motion` 时直接静态末轮；图例改「样例星图 · 自动生长回放 · 合成演示数据」
- 首页暴露 `__atlasSite.setTurn/turn/nodes/settled/fit` 探针钩子（setTurn 冻结自动循环），供确定性取证
- 回放页启用 `stepOrder`；fit 垂直留白随开关加到 44px，防起点徽标贴边裁剪

### 验证
- typecheck 干净；125/125；build:site 通过
- 桩实例 7791 全量验收绿：focus 9/1、冷 2544ms、health.stub=true 自标注、五页 × 390/320 无溢出、Console/页面异常 0
- headless 探针：首页生长中段 turn5=5 节点、末段 turn10=9 节点；回放 9/1；1280/390 溢出 0、错误 0
- 新证据：`evidence/d7-layout/home-grow-mid-1280.png`、`home-grow-end-1280.png`、`demo-order-1280.png`、`demo-order-390.png`、`home-order-390.png`

## v0.7.2 — 单链样例替换（2026-11-24）

### 变更
- 长对话样例重写为「人生决策：毕业先工作还是读研」：10 轮单链（纠结 → 顾虑 → 倾向 → 硬约束 → 立场转变 → 行动与兜底），替换原 12 轮多主题跳转样例；9 节点 / 1 次转折
- 链路方向由时间轴蛇形脊柱的推进箭头承担：节点保持独立站点按出生序排布；曾尝试用 related 边串联，但渲染器把语义连通分量视为一个簇（簇内螺旋布局）导致整链缩成一团，遂移除链边、不改渲染器与 core 不变量（influence 仍仅 ai-voice → shift）
- 验收断言同步 9/1 与 10 轮；回放页小提示与图例「同轮关联」改「关联」

### 验证
- typecheck 干净；125/125；build:site 通过
- 桩实例 7791 全量验收绿：focus 9/1、冷 2516ms、沙箱 stub 标注诚实、3 轮 1→2→3、XSS 字面、DB 仅哈希、五页 × 390/320 无溢出、Console/页面异常 0
- 今日真模型验收记录存档至 `evidence/d7-real-acceptance/`（d6-site.json + 截图）；当前 `evidence/d6-site.json` 为桩运行（health.stub=true 自标注）
- 清洁截图：`evidence/d7-layout/demo-chain-1280.png`、`home-chain-1280.png`（单链 + 箭头 + 琥珀转变可见）

## v0.7.1 — 首页模块收敛 + 回放对话列（2026-11-24）

### 变更
- 首页删除「评委 3 分钟路线」与重复功能卡，收敛为三模块：01 看示例（回放）/ 02 自己试（亲手聊一段，看星图长出来）/ 03 带回家（本地安装）；hero 次按钮同步改为「亲手聊一段」
- 回放页地图左侧新增同步对话列：复用沙箱 bubble 样式，逐轮展示「你 / AI」原文，随时间轴推进、最新轮高亮、自动滚到当前轮；0 轮显示引导提示
- 回放页「评委路线小提示」改为面向同学的小提示；清理 route-grid / entry-grid 样式
- 品牌头升级：「思维星图」16px → 19px；12px 渐变圆点换成 26px 星座徽标（蓝节点 + 虚线影响边 + 琥珀转变菱形，CSS data-URI SVG，五页共用）
- 头部改通栏：左右 28px 贴边（原居中容器在宽屏下左侧留白过大），正文容器不动；移动端 14px 不变

### 验证
- typecheck 干净；125/125 单测；build:site 通过
- headless 复验：首页三模块在 1280/390 无溢出；回放 0 轮=引导气泡、4 轮=8 气泡/4 节点、12 轮=24 气泡/12 节点，最新轮高亮与自动滚动成立；桌面并排、390/320 单列；Console 0、页面异常 0
- 证据：`evidence/d7-layout/`（home-1280/390、demo-1280/390/320、brand-1280/390）
- 品牌头复验：19px 字号、26px SVG 徽标加载成立，1280/390 无溢出、Console 0

## v0.7.0 — D7（2026-11-24，真模型验收 + 模型标注诚实化）

### 新增
- 模型标注诚实化：`/api/health` 与 `/api/selfcheck` 返回注入的真实 label 与 `stub` 标记（此前无条件报 `deepseek-flash`，桩模型被误报成真模型）；沙箱页对桩模型明确提示「本地演示桩模型（非真模型）」
- 本地预览默认走真 DeepSeek：`site/dev/server.ts` 读 `~/.thought-atlas/config.json`（不打印 key），有 key 即真模型；`ATLAS_SITE_MODEL=stub` 强制桩；无 key 自动降级桩；`ATLAS_SITE_MODEL=deepseek` 缺配置时 fail closed
- 验收脚本按模式断言：不再硬断言 `deepseek-flash`；桩模式断言逐轮 +1 节点，真模式断言轮次状态与至少 1 节点；沙箱话术换成真实学习讨论（原测试话术被分析器真实判定 SKIP）
- 单测 +1（health/selfcheck label 透传与默认值），全量 125 个

### 验证
- 真模型（deepseek-flash）：selfcheck reachable 858ms；沙箱 3 轮节点 1→2→3（第三轮为 XSS 载荷，字面显示不执行）；限额 17/20 与 97/100；数据库 3 条轮次仅 64 位哈希、原文 0 命中
- 冷打开 2616ms（<3s）；回放 12 节点/5 边/2 转折/1 影响；五页 × 390/320 无横向溢出；Console 0、页面异常 0
- 桩模式（7791 独立实例）：health `stub:true`、沙箱页提示与状态行均标注「非真模型」，Console 0
- 分析器真实产出记录：两句元测试话术（「第一轮讨论浮点误差」等）被判定 SKIP，换成实质学习问句后正常长节点；未改 analyzer 凑节点
- 证据：`evidence/d6-site.json`（真模型运行）与 `evidence/d6-screenshots/` 重拍

### 安全与边界
- 未发布、未读写 Secret 值、未创建云资源；key 仅本地 config 读取，不进日志/仓库/截图
- 仓库已迁至 `~/Desktop/thought-atlas`；新增 `AGENTS.md` / `README.md` 交接文档（commit 8f932c3）

## v0.6.0 — D6（2026-11-23，开发会话模型 DeepSeek-Flash）

### 新增
- 托管核心：`scripts/d6-sync-core.ts` 把零 Node import 的 core 逐字节同步进 `site/functions/lib/core/`；Deno 入口读 `DEEPSEEK_API_KEY`（缺失 fail closed）；数据库版 `Storage` 只写事件/图/失败/会话元数据；BYOK `DeepSeekModel` 直调 `api.deepseek.com`（`deepseek-flash`、思考关、JSON 模式、超时），`/api/selfcheck` 只回布尔与耗时
- 沙箱防滥用：每 IP 每日 ≤3 会话、单会话 ≤20 轮、全站每日 ≤100 轮分析（CAS 预占）、单轮 ≤2000 字、输入+骨架哈希缓存（只存 ops、不耗分析额度）、越界分析整包丢弃；`site/migrations/0001_sandbox.sql` 8 表 + 索引
- 五块站点：首屏 + 评委 3 分钟路线；回放样例（时间轴 0–末轮、shift 快捷入口、锚点原文）；实时沙箱分屏；安装一条命令；边界与隐私全文（原文不留存、限流、注入防护、授权流程）
- 合成样例：学习场景 8 轮（8 节点/3 边/1 转折/1 influence）与长对话 12 轮（12/5/2/1），页面明确标注合成；真实样例管线 `sample-approvals.json` + 敏感扫描硬闸就绪，缺批准只用合成
- 构建/本地验收：`scripts/d6-build-site.ts`（core 别名、样例闸门、静态产物）；`site/dev/server.ts`（MemoryDb + StubModel 同源 API）；`scripts/d6-site-check.ts`（headless Chrome：冷打开、回放、3 轮沙箱、限流、数据库无原文、XSS、390/320）
- D5 遗留：`CursorStore.save` 对已存在目录补 `chmod 0o700`，单测先造 755 再断言 700
- 单测新增 20 个（托管 14 + 样例闸门 6），全量 124 个

### 验证
- 类型：根 + web + site 三个 tsconfig 全绿；`check:core` 8 文件一致
- 冷打开：导航→首图可交互 86ms；含布局收敛严格测量 2495ms（<3s）
- 回放：长对话 12 节点/5 边/2 转折/1 影响，学习 8/3/1/1；时间轴 0↔12、shift 面板“锚点原文”正常
- 沙箱：3 轮节点 1→2→3，17/20 轮、97/100 分析；数据库 3 条轮次仅 64 位哈希、原文 0 命中、缓存仅 ops；XSS 载荷字面显示且不执行
- 五页 × 390/320 无横向溢出；Console 0、页面异常 0

### 安全与边界
- 未发布、未读写 Secret 值、未创建真实样例/黄金 fixture；发布样例全合成
- Key/私钥模式：工作区、git 全历史、`site/dist` 均 0；真实对话 217 个 24 字片段对仓库与历史 0 命中
- `~/.codex` / `~/.qoder-cn` 只读，hooks/config 指纹与基线一致；7788 daemon 与 Qoder watcher 保持运行
- **云草稿/后端/迁移未创建**：Sites 要求当前会话工作区，本仓库在另一会话目录，`open_design_workbench` 返回 `design_forbidden`、`prepare_site` 返回 `sites_current_session_required`；未产生任何云资源，需在仓库所属会话重跑，仍无 publish
- 本地出网未验真：E2E 用 StubModel，部署后先跑 `/api/selfcheck`

## v0.5.0 — D5（2026-11-23，开发会话模型 DeepSeek-Flash）

### 新增
- watcher 通用化：新增 `TranscriptParser` / `ParserModule` 注册接口、`JsonlWatcher`（每文件字节游标 + 解析器快照、重启恢复、截断/换 inode 重放、投递失败重试、全部投递成功后才持久化）与 `CursorStore`（`~/.thought-atlas/watcher-cursors/`，0700/0600 原子写）；CodexWatcher 改为包装通用 watcher，`CodexWatcher` 构造/发现/tail 行为不变，`postTurn` 仅增可选超时
- `packages/adapters/qoder`：零配置侵入 watcher。白名单仅读 `~/.thought-atlas/config.json` 的 `qoderWatch`（绝对路径或 sessionId，sessionId 只查 projects 直接子目录）；不配不监听，绝不枚举整个 projects
- Qoder 解析器：`origin.kind==="human"` 开轮、同 message.id 流式折叠、`end_turn` 立即投递、被下一人类轮打断时兜底、排除 tool_use/tool_result/thinking/attachment/sidechain/压缩摘要、剥离 system-reminder/environment/user_instructions/qoder_delegated_input_sources、时间戳归一、稳定人类 id 与单调 turnIndex、游标快照/重放
- 会话映射 `qoder-<sessionId>`；默认从文件头回填历史，轮询 1s
- 脚本：d5-latency.ts（合成 transcript + stub 模型 + headless Chrome 端到端延迟）、d5-recovery.ts（停机追加/截断重放）、d5-real-stats.ts（真实回填只读聚合）
- 单测 104 个全绿（core 46 / codex 12 / watcher 3 / qoder 12 / daemon 19 / web 12）

### 验证
- 真实开发会话回填 7 个完成轮（复跑采样 8 人类轮/4172 行），23 节点/0 边，回放末态与实时图签名一致；3 个 Codex 会话图不变
- 合成实时：新轮写入→浏览器节点增长 213ms（≤8s），Console 零错误
- 合成恢复：重启按 [1,2] 无重复；截断重放 [1,2,3]，pass
- 第 8 轮（D5 任务）采样时未 end_turn，按设计保留 pending；真实图 0 边为分析器真实输出，未改 analyzer

### 安全
- `~/.qoder-cn` / `~/.codex` 只读：hooks.json 78922a78…38cbb9、config.toml d931ef92…553062 与基线一致；未装 hook
- Key：仓库与 git 全历史精确 Key / sk- 模式 0 命中；真实 164 个中文 24 字片段对仓库与历史 0 命中
- 真实 transcript 不入仓库/夹具/证据，真实图不截图；证据仅聚合数值；黄金 fixture 未入库
- 未实现 D6、未发布、未使用 Sites

## v0.4.0 — D4（2026-11-23，开发会话模型 DeepSeek-Flash）

### 新增
- core 回放：`createReplayState` / `replayApply` / `replayMap` / `foldEvents` 纯函数折叠事件日志；沿用事件内已解析节点 id，支持 DELETE、supersede、手动事件；核心零平台依赖
- core 手动操作：`MANUAL_TURN_BASE=1e6` 独立轮次空间、`applyManual` 整批原子追加、`MARK_SHIFT.manual` 标记；对 ai-voice 执行转变直接拒绝；删除保持事件日志软删除语义，回放可见
- core 簇计算：related 边并查集连通分量、孤立散点、稳定 key（FNV-1a）与排序
- daemon：`GET /replay`（时间轴步骤+事件）、`GET /replay/snapshot?turn`（服务端折叠）、`GET /anchors`（本地 turns.jsonl 只读，8000 字截断）、`GET/POST /clusters`（缓存、标签哈希失效、`簇 #n` 降级、刷新互斥）、`POST /manual`（mark-shift/delete，409/404/400 校验，追加事件并 SSE 广播）；新增 +10 active 自动命名
- daemon 簇命名器：合成标签交现有 DeepSeekClient（deepseek 系思考关），严格 JSON 解析、8 字截断、未知 key 丢弃、提示注入防护、20s 超时与失败降级
- web 时间回放：底部时间轴播放/暂停/拖动/0.5–3×；core 折叠喂给 D3 同一渲染器；回放中 SSE 仅提示不打断，点「实时」恢复；shift 新出现时 1300ms 脉冲
- web LOD 三档：远=簇大陆凸包+簇名+shift 节点；中=全部节点圆点；近=标签；远档命中仅 shift 节点
- web 锚点原文面板（逐轮用户/助手原话，本地闭环提示，纯 textContent）、手动「标记为转变」「删除节点」、label/summary 搜索命中金环并居中
- 多端：≤640px 面板底部抽屉、时间轴窄屏换行、320px 无溢出
- 脚本：d4-daemon.ts（合成 300/600 回放夹具、XSS 锚点、手动会话）、d4-browser-check.ts（headless Chrome + CDP 全链路验收）、d4-cluster-real.ts（合成标签→真实 DeepSeek 命名）
- 单测 92 个全绿（core 46 / codex 12 / watcher 3 / daemon 19 / web 12）

### 验证与返工
- 回放：初始 122/122；拖到 30 → 150 节点/145 边；60 → 300/290；末轮 300/600；3× 播放推进、暂停生效；末态 rAF 60/60/60 fps（headless SwiftShader）
- 冷打开 236ms；LOD 0.4/0.75/1.2 三档截图；远档 10 簇带名；搜索 6 命中且首个居中；shift 脉冲 pulsing=1；Console 零错误
- 锚点面板展示合成原文；XSS 五类载荷惰性（images/iframes 0，script 仅页面自身）；手动标记/删除追加事件且回放反映
- 真实命名：合成夹具 10/10 簇成功，1930ms，1031/158 tokens，HTTP 200
- 返工1：MARK_SHIFT 既有路径允许把 ai-voice 转成 shift → 补硬校验并加回放/手动双路径单测
- 返工2：手动会话夹具仅有 map.json 导致回放折叠悬空 DELETE → 改由 ThoughtGraph.applyTurn 写入事件后重测

### 安全
- 只读指纹：hooks.json 78922a78…38cbb9、config.toml d931ef92…553062 与基线一致
- Key：仓库 97 文本文件与 git 全历史精确 Key / sk- 模式均 0 命中
- 真实对话：522 个中文 24 字片段对仓库 0 命中；证据与截图仅合成夹具；锚点原文经本地 daemon 只读，不上传；黄金 fixture 未入库
- 未实现 D5 功能（Qoder 适配器、通用 watcher、真实会话接入）

## v0.3.0 — D3（2026-11-23，开发会话模型 DeepSeek-Flash）

### 新增
- packages/web：d3-force + Canvas 星图渲染器——§8.2 视觉编码全集（用户节点大亮 / AI 观点小淡 / shift 菱形暖色描边 / superseded 置灰删除线 / influence 高亮虚线 / related 细灰线 / 年轮半径微增）；增量布局（新节点按邻居落点、alpha 0.3 局部扰动、不复算首屏）；收敛冻结（手动 tick，alpha<0.02 停止，仅交互/增量/resize 重绘）；结构按 GraphMap 快照解耦，为 D4 回放预留
- 聚焦模式：点击节点非邻居透明度 0.1、邻居保留标签，点击空白恢复；节点拖拽、空白平移、滚轮缩放
- SSE 实时增长：/events 按 sessionId 过滤，新节点 450ms 生长动画，会话下拉节点数同步刷新；基础详情面板（label/type/summary/rings/status，纯 textContent）
- daemon：静态页白名单（index.html / app.js / styles.css，防目录穿越）、GET /sessions（按 map.json mtime 倒序，含节点/连线/轮数）；webDir 默认 packages/web/dist，可用 ATLAS_WEB_DIR 覆盖
- 构建：esbuild 单文件 bundle（28KB），`npm run build:web`；dist 保持不入库
- 脚本：d3-perf-daemon.ts（300 节点/600 边与 XSS 夹具）、d3-browser-check.ts（headless Chrome + CDP：冷启动、帧率、点击聚焦、XSS、390px、真实 SSE 增长）、d3-annotations.ts（三样本逐轮标注草稿）
- 黄金样本标注：新增 2026-10-19（42 轮，线程 01a15219）候选；三份 `<fileId>.annotation.md`（600，本机）含每轮应记/应合并重述/转变点与一行理由
- 单测 76 个全绿（core 36 / codex 12 / watcher 3 / daemon 15 / web 10，含转义防回归）

### 验证与返工
- 300 节点/600 边 rAF 实测 60/59/60 fps（初版 38fps：600 条边逐条 stroke + 每帧字体状态重建 → 按样式批量 Path2D + 状态缓存后达标）；冷打开 54ms；390px 无横向溢出、面板底部抽屉
- 真实 daemon + DeepSeek-Flash 直播：合成轮 POST 返回后 1ms 节点可见（SSE 先于响应），观测到生长动画；XSS 五类载荷在 Canvas 与面板均惰性；Console 零错误
- 返工1：`.empty-hint` 的 display:flex 覆盖 hidden 属性导致空态提示叠加 → 全局 `[hidden]{display:none!important}`
- 返工2：首轮 headless 验收连接失败（守护进程随父 shell 退出被回收）→ 改长驻后台任务；Qoder 内置浏览器页面 hidden 时 rAF 挂起无法测帧率 → 验收改用 headless Chrome + CDP，交互与截图仍为真实浏览器路径
- 返工3：移动端/直播态首次点击发生在布局收敛前导致漏点 → 验收脚本等待 converged 后再点击；移动端面板与聚焦截图复测通过

### 安全
- 只读指纹：hooks.json 78922a78…38cbb9 与基线一致；config.toml d931ef92…553062 与 D2 归因一致
- Key：仓库 89 文本文件、git 全历史精确 Key 与 sk- 模式均 0 命中；真实对话 226 个片段对仓库扫描 0 命中
- 黄金标注与全文草稿仅存 ~/.thought-atlas/golden-drafts（目录 700 / 文件 600）；evidence 仅聚合统计与合成数据截图；未做 fixture 入库（待作者逐段授权）
- 未实现任何 D4 功能（回放 / shift 脉冲 / 簇命名 / LOD / 原文锚点 / 搜索 / 手动标记删除）

## v0.2.0 — D2（2026-11-23）

### 新增
- 模型迁移：deepseek-chat（弃用别名）→ deepseek-flash 正名；DeepSeekClient 对 deepseek 系显式关闭思考模式（官方 thinking 参数），JSON 空白内容守卫触发重试。thinking-off 与空白守卫源自被叫停并行会话的未提交残稿，中枢评审后由 D2 接管：对照官方文档核实并补单测（含空白→失败→分析器重试链路）
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