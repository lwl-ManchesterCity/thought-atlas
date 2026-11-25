# CHANGELOG

## v0.8.9 — 同线程多续段下拉加日期后缀（2026-11-25）

### 变更
- 作者点选 A（仅 A）：Codex 恢复/压缩会为新续段另开 rollout 文件，同线程多段同步标题后重名；web 启动时按线程 uuid 计数，>1 段且有标题的会话下拉加「· MM-DD 段」后缀（日期取自 sessionId），SSE 更新同口径
- 单段、无标题会话文案不变；合成会话标签（C）与本机清理（D）未点不做；同线程合并为大改，赛前不做

### 验证
- 130/130；typecheck 三套全绿；build:web 重建（daemon 按请求读盘，无需重启）
- 真机探针布尔-only evidence/d7-segments/check.json：2 条多段会话后缀与各自日期/节点数逐字匹配，单段与无标题均无后缀，错误 0
- 合成双段实例（7794）：下拉「合成同线程标题 · 11-19 段 / 11-17 段」，synthetic-1280.png 像素复核

### 待办
- 再发布批准（站点文案 v0.8.5–v0.8.7）；push 待批准（本地已至 v0.8.9）

## v0.8.8 — 会话下拉同步 Codex 重命名标题（2026-11-25）

### 变更
- 新增 `packages/adapters/codex/src/session-titles.ts`：只读解析 `~/.codex/session_index.jsonl`（尊重 `CODEX_HOME`），同 id 末行胜出（重命名语义），坏行/空名跳过，缺文件空映射，mtime 缓存
- `threadIdFromSessionId`：rollout 型 sessionId 提取线程 uuid；Qoder/合成会话不匹配→无标题
- daemon `/sessions` 每条附 `title`（daemon 新增 workspace 依赖 adapter-codex）；web 下拉与 SSE 更新文案统一走 `sessionLabel`：标题优先「标题 · N 节点」，无标题保持截断 id 兜底
- 不改 analyzer、不改 watcher；真实标题只在本机 UI 出现，不进仓库/证据

### 验证
- 130/130（新增 5：末行胜出/坏行空名/缺文件/mtime 缓存刷新/threadId 匹配）；typecheck 三套全绿；build:web 重建
- 真机探针（布尔-only，无真实标题入证据）evidence/d7-titles/check.json：9 会话 4 有标题，下拉文案与索引末行逐字一致，无标题兜底正确，错误 0
- 合成实例（CODEX_HOME/THOUGHT_ATLAS_HOME 指向 /tmp 合成目录，7793）：重命名末行胜出显示「合成重命名后的标题 · 2 节点」，synthetic-1280.png 像素复核
- daemon 7788 已重启生效（服务端代码变更）

### 待办
- 再发布批准（v0.8.5–v0.8.7 站点文案未上线；本轮为本地 daemon/UI，不影响站点）；push 待批准
- 未点不做：新会话实时进下拉（SSE 补选项）仍搁置

## v0.8.7 — 安装页第 4 步补会话切换说明（2026-11-25）

### 变更
- 第 4 步「本机看星图」补两句：顶部会话选择器可切换各条 Codex / Qoder 会话；已分析过的历史会话不起 watcher 也能直接回看（作者批准，对应其 Codex 实测路径）

### 验证
- 125/125；typecheck 三套全绿；build:site 通过（gateReason approval-invalid 为预期）
- 探针 evidence/d7-install-step4/check.json：第 4 步两句在、watcher 命令与 GitHub 链接仍在、1280/390 溢出 0、错误 0；install-1280.png 像素复核

### 待办
- 再发布批准（v0.8.5–v0.8.7 文案未上线）；本提交 push 待批准

## v0.8.6 — GitHub 公开推送 + 链接回填 + 过时状态纠正（2026-11-24）

### 变更
- git 全历史推送至 https://github.com/lwl-ManchesterCity/thought-atlas （作者批准）；推送前扫描 547 个历史 blob：精确 Key / sk- 模式 / 注册邮箱全 0 命中；origin/main 建立跟踪
- 帖子草稿回填 GitHub 链接（状态行 + 用法段，占位符清除）；安装页加「源码公开在 GitHub…克隆后跑 ./setup.sh」一句
- 过时公开状态纠正：README「本地可跑，尚未发布」→ 公网站点已发布 + 源码公开本仓库，intro 补日常开发用途句与公网 URL；AGENTS.md 阶段行同步（线上文案至 v0.8.3 + 500 修复，v0.8.5/0.8.6 待再发布）
- 历史 CHANGELOG 与 verification-d* 的「未发布」为当时记录，不改

### 验证
- 125/125；build:site 通过；探针 evidence/d7-github/check.json：安装页 GitHub 链接 href/文本正确、克隆句在、溢出 0、错误 0；install-1280.png 存档
- GitHub 公网页复核：Public、描述正确、推送时 main=4b5c6a7

### 待办
- 再发布批准：v0.8.5 用途叙事 + v0.8.6 安装页链接尚未上线

## v0.8.5 — 用途叙事：日常开发复盘插件，不是参赛 demo（2026-11-24）

### 变更（仅文案，无功能改动）
- 帖子草稿开篇改动机叙事：每天和 agent 聊开发（debug/讨论方案），想在想法被推翻/转向的当下留痕、日后回看；结构改「我真正想用它做什么」（三个日常场景 + GitHub 自取源码 + setup.sh）在前、「想先看看它怎么长图（在线）」在后；新增占位符【GitHub 仓库链接】——作者自行上传仓库、同学自取，不附源码包
- 首屏 kicker 改「本地插件 · 接你日常开发的 agent 对话」、lead 改本地插件视角、hero 主按钮改「装到自己电脑上」（次按钮「先在线聊一段」）、模块 03 改「03 · 日常开发用 / 接上你每天的 agent 对话」；meta/og description 同步
- 回放/沙箱各加一句定位：回放里是合成样例、装本地后长的是你自己日常开发对话的星图；沙箱是同引擎体验窗口、日常长期用装本地版接自己的 agent；kicker 改「看示例 / 免门槛体验」
- h1 保留品牌句：日常开发措辞两版均超 hero 列宽产生孤行，回退；定位由 kicker/lead/按钮/模块 03 承担

### 验证
- typecheck 干净；125/125；build:site 通过
- 探针 evidence/d7-purpose/check.json：三页新文案在、旧 framing 清零、hero 主按钮指向 install；1280/390/320 溢出 0；Console/页面错误 0
- 截图像素复核：home-1280、home-390、demo-1280、sandbox-1280
- 探针误判纠正记录：.kicker 有 text-transform:uppercase，innerText 大小写不匹配致首跑 kicker=false（断言改小写比较）；一次 npm run 误在会话工作区执行致 build 未跑、截图为旧 dist，重建后重拍

### 待办
- 公网仍为旧文案：需作者在仓库会话批准再发布才生效；GitHub 上传后把链接填进帖子与安装页，随再发布一起上线

## v0.8.4 — 线上沙箱 500 修复 + 公网 live 验收归档（2026-11-24）

### 修复（线上，f773758）
- 沙箱 500：DbStorage 图事件查询 `limit 5000` 超平台 SDK 上限 → 降为 1000（site/functions/lib/db-storage.ts:70）；未知错误补安全日志（仅 name/message，不含原文与 Key）
- 线上已含该修复：修复后公网恢复与轮次写入均绿（见下）

### 验证与归档（公网 live，作者全程目击）
- 公网地址 https://thought-atlas-njl1tep74um.qoder.zone/ ；验证通道为 Qoder 内置真实浏览器；headless CDP 被平台反自动化拦截（「Access denied. Automated tools are not allowed.」，非本项目代码），拦截记录诚实归档 check-headless-blocked.json
- 真模型冒烟：/api/health `deepseek-flash / stub:false`；合成冒烟输入 1 轮写入 2 节点（起点蓝节点 → 琥珀 shift 菱形 + influence 虚线箭头 + 步序号 1/2）；配额 14/15 与 97/100；节点面板锚点原文可见
- 跨页导航恢复：回沙箱页自动恢复 2 节点 + 恢复气泡；恢复后锚点标题隐藏（与 v0.8.3 修复一致，内存原文已失）
- 五页 meta / favicon / og.png 线上复核 200（check-real.json static）
- 新证据 `evidence/d7-live/`：check-real.json、sandbox-real-1280.png、sandbox-real-full.png（星图+聚焦面板）、sandbox-real-map.png（关面板完整星图）、check-headless-blocked.json、sandbox-headless-blocked.png
- 索引新增 #17（公网真模型+恢复），#15 复核方式更新为已公网复核；d7-live 为 real 通道验收（合成冒烟输入），仅内部复核，不作帖子配图

### 验证
- typecheck 干净；125/125（HEAD f773758 复跑）；三张 live 截图像素复核：星图/面板/配额/恢复气泡/导出按钮齐全
- 本 commit 仅证据与文档，无新产品代码改动

## v0.8.3 — 审计修复：承诺对齐实现 + 分享 meta（2026-11-24）

### 变更（A 组：公开承诺与代码对齐）
- 补跑承诺生效：daemon 入口启用 `retryIntervalMs: 30_000`（此前重试只积压 retry.jsonl，「恢复后补跑」文案失实）；机制本身已有单测覆盖
- 边界页「hook 脚本 ≤2 秒」改为 watcher 上报超时（全仓无 hook 脚本，2 秒实为 codex-watcher postTurn 超时）
- 安装页「注册只读适配器 / 守护进程本地轮询」改为独立 watcher 可选步骤并给出启动命令；h1「一条命令接到 agent」改「一条脚本装到自己电脑上」；meta description 同步；README 快速开始补 watcher 可选行
- 边界页额度口径改「分析轮次计数」，注明每轮聊天+分析两次模型调用、自检占 1 轮额度
- `evidence/d7-install/setup-run.log` 强制入库（此前被 .gitignore 的 *.log 挡在库外，索引与 v0.8.0 均引用）

### 变更（B 组：一致性与体验）
- README Node 门槛 24 → 22.18+（推荐 24）；AGENTS.md「124 个」→125、阶段 D6 → D7（v0.8.3）
- 回放页导出：第 0 轮空图禁用按钮并给 title 提示（与沙箱一致）；notice 改读 `doc.synthetic`，真实样例上线不再错标合成
- 沙箱恢复：空会话不再弹「已恢复」气泡；节点面板无可用锚点时隐藏「锚点原文」标题（恢复后内存消息已失）
- 新增 favicon.svg（品牌星座标）+ 五页 link icon 与 og:title/og:description/og:type/og:site_name/twitter:card；build 复制清单加入 favicon.svg；og:image/og:url 待公网发布 URL 确定后补

### 验证
- typecheck 干净；125/125；build:site 通过；daemon 重启后 /health ok
- 桩实例 7791 全量验收绿（health.stub=true 自标，0 console/page 错误）
- 修复探针 evidence/d7-fixes/check.json：五页 icon/og/twitter 齐全、favicon 200、安装新文案在旧文案清零；demo 第 0 轮导出禁用+提示、第 10 轮恢复可用；沙箱恢复有节点才弹气泡、恢复后锚点标题隐藏、空会话 0 恢复气泡
- 截图刷新：install-1280、demo-export-ui-1280、boundary-1280/390（0 溢出 0 报错）
- 未选做：B11 样例 notice 双口径、C 组（版本同步/空目录/赛后项）保持不动

## v0.8.2 — 边界页改访客视角：清内部备注、删「还差什么」（2026-11-24）

### 变更
- 边界页重写为对访客的公开承诺：kicker「规范 · 原样公开」→「公开承诺」；删 10.1–10.5 章节号；节题改访客视角（你的原文去哪了 / 密钥怎么放 / 聊天内容只是分析数据 / 失败时会怎样 / 公开样例从哪来 / 只读与不可越界），「同一个引擎」移末尾作技术附录
- 删除不应公开的内部备注：作者 Key 明文历史与轮换 TODO、「模型便宜档 + 作者控制台消费上限」、「黄金样本作者确认后入库」；样例授权改写为对访客的承诺（只读读取 → 脱敏 → 逐段同意 → 扫描 0 命中）
- 按作者指示整节删除「还差什么（诚实清单）」；其中限量体验 / 失败标记 / 合成样例三条已在限流、失败隔离、样例当前状态节覆盖
- 纠正一处与 UI 不符的措辞：「原文不留存」告知位置改为沙箱页内隐私提示与系统气泡（锚点面板本身只展示内存锚点原文）
- 保留全部事实与验收断言串：原文不留存 / 最多 2 次 / 100 轮 / #samples 锚点（回放页引用）

### 验证
- typecheck 干净；125/125；build:site 通过；7790 实服文案核对：新文案 3 处命中、旧内部串 0 命中
- 边界页专用探针 1280/390 全页截图：0 溢出、0 console/page 错误、断言串与锚点齐全 → `evidence/d7-boundary/`
- 桩实例 7791 全量验收绿（health.stub=true 自标），d6-site.json 与 d6-screenshots 刷新

## v0.8.1 — 提交链准备：帖子初稿 + 证据链索引（2026-11-24）

### 变更
- 新增 `docs/post-draft.md`：面向同学的论坛帖子初稿（标题候选 3 个、正文、配图建议表）；署名/参赛形式/公网 URL/版块格式留【】占位符待作者填写；发布动作仍等作者另行批准
- 新增 `docs/evidence-index.md`：13 条对外声明 → 证据路径 → 数据模式（real/stub/synthetic）→ 复核方式；明确 real 验收存档不用于公开配图
- 归档 live 限流证据 `evidence/d7-limits/session3-429.json`（第 3 次建会话实测 429 响应体）

### 验证
- 索引逐条对文件复核：hosted.test.ts 两条限流单测、d6-site-check.ts:388-403 哈希断言、focus.json 9 节点/2 边/10 轮/1 转折、导出卡字节数 130328/92427
- 125/125；纯文档与证据归档，无产品代码改动

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