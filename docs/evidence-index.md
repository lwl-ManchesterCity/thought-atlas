# 证据链索引（公开声明 → 证据）

用途：帖子/验收里每一句对外声明，对应到仓库内可复核的证据。
数据模式三类：**real**（真实 DeepSeek 调用）、**stub**（本地桩模型，产物自标 stub:true）、**synthetic**（合成演示样例）。
铁律回顾：真实会话原文不进仓库/证据/发布产物；real 验收证据仅含节点级摘要与统计，且不用于公开配图。

| # | 对外声明 | 证据路径 | 数据模式 | 复核方式 |
| --- | --- | --- | --- | --- |
| 1 | 沙箱接真实模型，逐轮分析可用 | evidence/d7-real-acceptance/d6-site.json + d6-screenshots/ | real | 2026-11-24 全量验收存档；当前默认验收已切 stub（额度保护） |
| 2 | 当前可复跑的站点验收 | evidence/d6-site.json + evidence/d6-screenshots/ | stub（sandbox.health.stub:true 自标） | `npm run check:site`（ATLAS_D6_BASE 指向 7790/7791） |
| 3 | 原文不落库 | evidence/d6-privacy.json；d6-site.json 内 db 断言（turn 行仅 64 位 hex 哈希，originalTextStored:false） | real+stub 各跑一次 | scripts/d6-site-check.ts:388-403 |
| 4 | 每 IP 每日 2 会话，超限 429 | evidence/d7-limits/session3-429.json；site/test/hosted.test.ts「per-IP daily session cap is two」 | real（live curl）+ 单测 | 第 3 次建会话实测返回 session_limit |
| 5 | 单会话 15 轮上限 | site/test/hosted.test.ts「per-session 15-turn cap」；site/functions/lib/limits.ts | 单测 | LIMITS 单一事实源，routes.ts CAS 强制 |
| 6 | 全站每日 100 次分析 | d6-site.json 内「97 / 100」断言；limits.ts analysesPerDay | real 存档时的计数 | 验收断言额度计数展示 |
| 7 | 链路可读：步序号/起点/脊柱箭头/生长回放 | evidence/d7-layout/demo-order-1280.png、home-grow-mid-1280.png、home-grow-end-1280.png、demo-order-390.png、home-order-390.png | synthetic | 截图像素复核；renderer stepOrder/rowWidth 仅站点启用 |
| 8 | 样例为「人生决策单链」且有方向 | evidence/d7-layout/demo-chain-1280.png、home-chain-1280.png；site/samples/focus.json | synthetic | 9 节点、influence+supersede 边、无 related 塌缩 |
| 9 | 导出分享卡真实可下载 | evidence/d7-export/card-demo-focus.png（130328B）、card-sandbox-stub.png（92427B）、demo-export-ui-1280.png | synthetic / stub | CDP setDownloadBehavior 实收文件；沙箱卡只含节点级摘要 |
| 10 | 安装一条脚本，Key 不被改动 | evidence/d7-install/setup-run.log、install-1280.png | 本机实跑 | 日志含「配置已存在…跳过写入」；setup.sh 755 |
| 11 | XSS 输入按字面渲染 | d6-site.json 内 xssState 断言 | stub | 验收注入脚本串，断言未执行 |
| 12 | 窄屏可用 | evidence/d7-layout/*-390.png、demo-320.png | synthetic | 390/320px 截图 |
| 13 | 测试与类型全绿 | npm test = 125 tests；npm run typecheck（3 tsconfigs） | — | 每个 commit 前实跑，计数记入 CHANGELOG |

## 版本对应

- v0.7.3（a0c6e19）：#7 #8 的可读性改造
- v0.7.4（5266867）：#4 #5 限额收紧
- v0.8.0（8a6acbd + 5d011ba）：#9 #10；并记录了一次陈旧 dist 证据的纠正（install 截图重拍）

## 公开使用限制

- 公开帖子配图只允许 synthetic / stub 来源（见 docs/post-draft.md 配图表）。
- real 验收存档（#1）仅作内部复核与「真实模型可用」声明的依据，不整页公开。
- 黄金 fixture 不入库；本索引不指向任何真实会话原文。