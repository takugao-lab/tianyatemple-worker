# 天涯心安寺 · 多人版部署包（GitHub 自动部署用）

已验证：`npx wrangler deploy --dry-run` 通过（2026-11-11 11:35 PT，
Total Upload 61.81 KiB，绑定 `env.Main (TemplePartyServer)` Durable Object 识别正常）。

## 文件（共 4 个，72K，不含 node_modules）

- `wrangler.jsonc` — Worker 名 `tianya-temple`，Durable Object 绑定
  `Main` → 类 `TemplePartyServer`，migration v1 已写好
- `src/server.ts` — PartyServer 服务端源码
- `package.json` / `package-lock.json` — 依赖 `partyserver` 0.5.10，
  `wrangler` 4.160.1（部署机上 `npm install` 后可用）

## 用法

把这 4 个文件传到 GitHub 仓库（例如 `takugao-lab/tianya-temple-worker`），
再到 Cloudflare 控制台 → Workers → `tianya-temple` → Settings → Builds
→ Connect，选该仓库、分支 `main`，部署命令填 `npx wrangler deploy`
（构建命令留空；如必填，填 `npm install`）。推一次代码就自动部署，
`wrangler.jsonc` 里的 Durable Object 绑定会自动生效，不用手动加绑定。

部署成功后 Worker 地址仍是 `tianya-temple.xiang5528.workers.dev`
（更新已建好的 Worker，不会新建）。验证：打开根路径应回 404
"Not Found"（正常，接口在 `/parties/main/<殿id>`）。
Gao.
