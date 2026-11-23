# Vendored core（生成目录）

`packages/core/src/*.ts` 的逐字副本，供 Deno edge Function 打包使用（Sites Function 只能打包自身目录，不能引用仓库上层）。

- 重新生成：`npm run sync:core`
- 一致性校验：`npm run check:core`（逐字节比较，不一致即失败）
- 不要手改本目录；改 core 后重新同步并提交。