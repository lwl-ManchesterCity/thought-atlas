# D3 验证记录 · 星图渲染 / 聚焦 / 实时增长

- 日期：2026-11-23
- 开发会话模型：DeepSeek-Flash（作者于 D3 起切换，CHANGELOG 按日记录）
- 范围：§8.2 视觉编码全集、d3-force + Canvas 渲染、增量布局与收敛冻结、聚焦模式、SSE 实时增长与基础详情面板、转义硬门槛、300 节点性能、390px 可用性、黄金样本标注草稿
- 明确不做（属 D4）：时间回放、shift 脉冲、簇命名、LOD、原文锚点面板、搜索、手动标记/删除

## 1. 交付物

| 交付物 | 位置 |
| --- | --- |
| 渲染器（d3-force + Canvas，增量布局，收敛冻结，D4 回放预留） | packages/web/src/renderer.ts |
| 纯函数层（视觉编码 / 邻域 / diff，可单测） | packages/web/src/graph-model.ts |
| 详情面板（textContent 渲染） | packages/web/src/panel.ts |
| 页面与数据/SSE 装配 | packages/web/index.html、styles.css、src/main.ts |
| 构建（esbuild 单文件 bundle，28KB） | packages/web/package.json `npm run build:web`（dist/ 不入库） |
| 守护进程静态页 + GET /sessions | packages/daemon/src/server.ts |
| 浏览器验收脚本（headless Chrome + CDP） | scripts/d3-browser-check.ts |
| 性能/XSS 夹具服务（300 节点 600 边、XSS 会话） | scripts/d3-perf-daemon.ts |
| 黄金样本标注脚本 | scripts/d3-annotations.ts |
| 证据 | evidence/d3-browser.json、evidence/d3-golden.json、evidence/d3-screenshots/ |

## 2. §8.2 视觉编码对照

| 规则 | 实现 |
| --- | --- |
| 用户节点大而亮（主色） | claim/question/fact：半径 9，填充 `#4c8dff`，亮描边；标签常显 |
| AI 观点小而淡（辅色） | ai-voice：半径 ×0.72，填充 `#586079`，整体透明度 0.75，低缩放时默认隐藏标签 |
| 认知转变特殊形状 | shift：菱形 + 暖色 `#f0a24a`，描边 2.5，标签暖色 |
| 已被取代置灰 + 删除线 | superseded/merged：填充 `#454c5e`，节点斜线 + 标签删除线 |
| 年轮半径微增 | `1 + min(rings-1,5) × 0.07`，上限防失控 |
| influence 高亮虚线 | `#ffb45e`，宽 1.8，虚线 [6,4] |
| related 细灰线 | `#39415a`，宽 1.1，实线，透明度 0.55 |
| supersede 灰虚线 | `#8b93a7`，宽 1.3，虚线 [3,5] |

渲染顺序：边（按样式批量 Path2D，单次 stroke/样式）→ 节点 → 标签（屏幕坐标固定 12px）。边批量化是达到 60fps 的关键优化。

## 3. 增量布局与收敛冻结

- `setMap` 对新节点按「已有连线的邻居位置 + 抖动」落点，复用既有坐标；重跑仿真时 `alpha=0.3`（首屏为 1），只扰动局部。
- 仿真由渲染循环手动 `tick()`，不依赖 d3 内置定时器；`alpha < 0.02` 且生长动画结束后冻结，之后仅在交互（拖拽/缩放/聚焦）、增量数据、resize 时重绘。
- 无变化地图（例如仅 lastTurn 前进）通过 `mapSignature` 跳过重排。
- 首屏收敛后自动 fitView 一次；后续增量不再重置视口。
- D4 预留：渲染器只消费 `GraphMap` 快照（含 `lastTurn`），与 SSE/回放数据源解耦；回放只需按时序喂快照，无需改渲染器（本轮不实现回放 UI）。

## 4. 聚焦模式与交互

- 点击节点：`computeNeighborhood`（自身 + 一跳邻居，双向边）→ 非邻居节点/边透明度 0.1，邻居保留标签，右侧面板展示 label/type/summary/rings/status/bornTurn。
- 点击空白：恢复全图并关闭面板。
- 拖拽节点（临时固定 fx/fy）与空白平移、滚轮缩放；位移 > 4px 不算点击。
- 实测（headless Chrome）：`focused=true, selected=n_0002, 面板标题=问题-002`；点空白后 `focused=false, 面板隐藏`（evidence/d3-browser.json `focusMode`）。

## 5. SSE 实时增长

- 页面连接 `GET /events`，按 `sessionId` 过滤 `GraphUpdate`；新节点以 450ms 生长动画出现，会话下拉里的节点数同步刷新。
- 实测：真实 daemon（7788）+ 真实模型，合成轮投递后 **节点在 POST 返回后 1ms 内可见**（SSE 帧先于 HTTP 响应抵达），POST 往返 673ms，观测到动画态（`sawAnimating=true`），节点 1→2（新增 shift，旧主张 supersede 置灰）；预算 §8.4 为 ≤8s。
- 证据：evidence/d3-screenshots/live-growth.png（面板显示 shift 类型与年轮）。

## 6. 转义硬门槛

- Canvas 标签一律 `fillText`；DOM 面板一律 `textContent`，无 `innerHTML`。
- XSS 夹具节点含 `<script>`、`<img onerror>`、`<svg onload>`、`<iframe srcdoc>`、事件属性与 `javascript:` 文本。打开会话并点击节点后：
  - `window.__xssFired` 未定义；`document.images=0`；`iframe=0`；`script` 仅页面自身 1 个；
  - 面板标题按字面显示 `<script>window.__xssFired=1</script>`，面板 HTML 不含 `<img`/`<script`；
  - 证据：evidence/d3-browser.json `xss`、evidence/d3-screenshots/xss-fixture-inert.png。

## 7. 性能实测（§8.4）

夹具：合成会话 300 节点 / 600 边（含 superseded、merged、shift、rings 1–5），数据仅用于压测。

| 指标 | 结果 | 判定 |
| --- | --- | --- |
| 桌面 300 节点 rAF 帧率 | 60 / 59 / 60 fps（三次 1.2s 窗口，min 59，median 60） | ≥50 ✅ |
| 冷打开（导航→首图渲染完成） | 54ms（domContentLoaded 37ms，load 38ms） | <3s ✅ |
| 直播轮次→节点可见 | 1ms（相对 POST 返回）/ 673ms 往返 | ≤8s ✅ |
| 390px 视口 | innerWidth 390，scrollWidth 390，无横向溢出；面板变底部抽屉（宽 374，贴底 836/844） | 可用 ✅ |
| Console | 无 error、无未捕获异常（含全部阶段） | ✅ |

过程记录：首版 38fps（600 条边逐条 stroke、每帧重建字体/填充状态），改为按（kind, alpha）批量 Path2D + 缓存字体/填充/透明度状态后稳定 60fps。验证环境为 headless Chrome（SwiftShader 软件光栅），真实桌面 GPU 只会更好。

截图：perf-300-nodes.png、perf-focus-mode.png、xss-fixture-inert.png、mobile-390.png、mobile-390-panel.png、live-growth.png。

## 8. 黄金样本标注

作者确认的三份候选（只存本机 `~/.thought-atlas/golden-drafts/`，目录 700、文件 600）：

| 样本 | 轮数 | 标注要点 | 文件 |
| --- | --- | --- | --- |
| 2026-11-19…01a1f397 | 44 | 应记 17；应合并重述 8；转变点 1；跳过 23；节点 18 | `<fileId>.annotation.md` + 已有 `.md` |
| 2026-11-17…01a1e782 | 16 | 应记 4；应合并重述 0；转变点 1；跳过 12；节点 5 | `<fileId>.annotation.md` + 已有 `.md` |
| 2026-10-19…01a15219（新增候选，不同线程） | 42 | 应记 16；应合并重述 3；转变点 0；跳过 31；节点 16；1 次网络重试自动恢复 | `<fileId>.annotation.md` + 新生成 `.md` |

标注由事件日志反推（每轮列出应记节点、应合并重述、转变点及一行理由），文件头注明「草稿，待作者逐轮确认」。真实对话原文仅在 `.md` 草稿内，标注文件本身不含原文。

fixture 入库未执行：按计划需作者按 §10.5 逐段授权后另行安排。

## 9. 只读与安全

- `~/.codex` 全程只读：hooks.json `78922a78…38cbb9` 与基线一致；config.toml `d931ef92…553062` 与 D2 归因结论一致（作者 Codex 客户端活跃重写，非本会话写入）。
- Key：仅读 `~/.thought-atlas/config.json`；仓库文本 89 文件精确 Key 0 命中、`sk-` 模式 0 命中；git 全历史 0 命中。
- 真实对话片段：以三个样本的 226 个 24 字片段对仓库 89 个文本文件扫描，0 命中。
- daemon 静态路由采用固定白名单（`/`、`/index.html`、`/app.js`、`/styles.css`），不做任意路径拼接，目录穿越请求 404（单测覆盖）。

## 10. 验收清单

| 项 | 结果 |
| --- | --- |
| 旧 63 测 + 新增全绿 | 76/76 ✅（core 36 / codex 12 / watcher 3 / daemon 15 / web 10，含转义防回归） |
| typecheck | 根 tsconfig + web tsconfig 均无错误 ✅ |
| localhost:7788 星图页可打开 | ✅（真实 daemon + 真实会话列表；证据截图来自该服务与 7802 夹具服务） |
| 300 节点 fps ≥50 | 60/59/60 ✅ |
| 聚焦模式点击行为 | 正确 ✅ |
| 实时增长 | 1ms 可见，含动画 ✅ |
| XSS 惰性 | ✅ |
| Console 无红色错误 | ✅ |
| 黄金标注 3 份、600、仓库无真实对话 | ✅ |
| 只读指纹 | hooks.json 一致；config.toml 与 D2 归因一致 ✅ |
| 未做 D4 功能 | ✅ |

## 11. 偏差与遗留

1. **浏览器验收载体**：Qoder 内置浏览页面在后台时 `visibilityState=hidden`，rAF 被浏览器挂起，无法测帧率；改用本地 headless Chrome + CDP（scripts/d3-browser-check.ts）完成点击、截图与指标采集。交互路径与真实浏览器一致（原生 pointer/键盘事件、真实 Canvas 光栅）。
2. **首版帧率不达标**：38fps → 边批量绘制 + 状态缓存后 60fps（见 §7）。
3. **`[hidden]` 覆盖问题**：`.empty-hint` 的 `display:flex` 覆盖了 hidden 属性，导致空态提示叠在星图上；补 `[hidden]{display:none!important}` 并复测。
4. **dist/ 不入库**：web bundle 为构建产物，运行前执行 `npm run build:web`；daemon 默认从 `packages/web/dist` 读取，可用 `ATLAS_WEB_DIR` 覆盖。
5. **标签密度**：300 节点全量标签在自动缩放下较密；聚焦模式已按邻域收敛标签，完整 LOD/聚类留待 D4。
6. D4 待办：回放时间轴、shift 脉冲、簇命名、LOD、原文锚点面板、搜索、手动标记/删除；黄金 fixture 入库需作者逐段授权。