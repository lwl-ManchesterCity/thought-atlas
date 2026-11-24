#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22.18+（推荐 24）：https://nodejs.org"
  exit 1
fi
major=$(node -p 'Number(process.versions.node.split(".")[0])')
minor=$(node -p 'Number(process.versions.node.split(".")[1])')
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
  echo "Node.js 版本过低（当前 $(node -v)，需要 22.18+，推荐 24）。"
  exit 1
fi

echo "==> 安装依赖（npm ci）"
npm ci
echo "==> 构建本地星图前端（npm run build:web）"
npm run build:web

config="$HOME/.thought-atlas/config.json"
if [ -f "$config" ]; then
  echo "==> 配置已存在：$config（跳过写入，不改动你的 Key）"
else
  mkdir -p "$HOME/.thought-atlas"
  umask 077
  cat > "$config" <<'JSON'
{
  "apiKey": "",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash"
}
JSON
  chmod 600 "$config"
  echo "==> 已生成配置模板：$config（权限 600）"
  echo "    请把 apiKey 填为你自己的模型 Key 后再启动；Key 只留在本机，不进 git 与日志。"
fi

echo "==> 完成。启动守护进程："
echo "    node packages/daemon/src/main.ts"
echo "    然后浏览器打开 http://127.0.0.1:7788"