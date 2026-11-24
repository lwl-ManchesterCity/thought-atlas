# 思维星图 / Thought Atlas

长在 AI agent 旁边的本地插件：每轮对话结束做一次轻量分析，把值得记的论点、问题、事实与
认知转变挂到一张持续生长的「思维星图」上。不是事后总结，是思路变化的现场记录。
2026 Qoder 高校创造力大赛 · StudyHack 赛道参赛作品（提交截止 2026-11-30 18:00）。

- 适配器：Codex、Qoder（共用同一 watcher 核心；其他 agent 按 `ParserModule` 注册扩展）
- 公开演示：同一引擎的站点五页——首屏 / 回放样例 / 实时沙箱 / 安装 / 边界与隐私
- 当前状态：**本地可跑，尚未发布**；演示样例全部为合成数据，真实样例需作者逐段批准

## 快速开始

需要 Node 24（原生跑 TS，无构建步骤依赖）。

```bash
npm ci

npm test                # 125 个测试
npm run typecheck       # 根 + packages/web + site
npm run build:web       # daemon 前端
node packages/daemon/src/main.ts        # 守护进程 -> http://127.0.0.1:7788

npm run build:site      # 站点静态产物 -> site/dist
npm run dev:site        # 站点预览 -> http://127.0.0.1:7790（有 key 默认真 DeepSeek）
ATLAS_SITE_MODEL=stub npm run dev:site  # 强制桩模型（沙箱页会标注「非真模型」）
```

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/core` | 环境无关引擎：跳过过滤、图状态机、事件存储、重试 |
| `packages/adapters` | `codex` / `qoder` / `watcher`；`claude-code` 仅存根 |
| `packages/daemon` | 本地守护进程、SSE 传输、BYOK 模型调用 |
| `packages/web` | 共享星图渲染器（daemon 与站点 demo 共用）+ daemon UI |
| `site` | 站点五页、Sites Function、dev server、迁移、合成样例 |
| `scripts` | d1–d6 构建 / 同步 / 验收脚本 |
| `docs` | 开发计划（唯一事实来源）与逐日验证记录 |
| `evidence` | 聚合证据（数值、测量，不含真实对话） |

## 文档索引

- **[AGENTS.md](AGENTS.md)** — 接手必读：铁律、当前状态、命令、验收与汇报格式
- [docs/思维星图-开发计划.md](docs/思维星图-开发计划.md) — 产品定义、架构规范、隐私约束、排期、待补事项
- [CHANGELOG.md](CHANGELOG.md) — 每个阶段做了什么、验证了哪些数字
- `docs/verification-d*.md` — 逐日验收记录

## 边界与隐私

- 原文只存用户本地；发给模型的只有当轮文本 + 图骨架（label/summary 级）
- 仓库与 `evidence/` 不放真实会话内容、真实人名与密钥；公开样例为合成数据并明确标注
- 演示沙箱有每 IP 每日 2 会话、单会话 15 轮、全站每日 100 轮的限额，超限降级回放
- 详见站点的「边界与隐私」页（`site/web/boundary.html`）