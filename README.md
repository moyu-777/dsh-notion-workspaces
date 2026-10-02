# dsh-notion-workspaces

Bind each DSH workspace to its own Notion workspace over the official Notion
MCP. / 把每个 DSH 工作区绑定到各自的 Notion 工作区（走官方 Notion MCP）。

English | [中文](#中文)

## The gap this fills

`dsh-notion-mcp` connects dsh to Notion, but it holds **one** Notion grant for a
whole DSH environment: it hardcodes the credential ref `NOTION_OAUTH`, one
`serverName`, and mounts its MCP client in the profile's global scope. Authorize
a second Notion workspace and it overwrites the first. DSH itself offers no
per-workspace settings or credential scope to layer on top — `<cwd>/.env` ranks
below the managed credential store, and a desktop host boots once for every
workspace it serves.

This plugin expresses the mapping in the one place DSH does offer the
granularity: the **agent scope**.

## How it works

- A binding maps a workspace path to a Notion grant: its own credential ref, its
  own `serverName`, its own OAuth callback port.
- On `agent/created`, the session's `header.cwd` decides which binding applies.
- The MCP client is mounted under **that agent's** context, so the
  `mcp__<serverName>__*` tools exist only in sessions of that workspace. A
  session in an unbound workspace sees no Notion tools at all.

Bindings are stored in `$DSH_HOME/notion-workspaces.json`; each grant is a
secret in the DSH credential store under its own ref. Access tokens are
refreshed in the background, and the agents holding a rotated token are
remounted so they never authenticate with a retired one.

## Install

```sh
dsh plugin --profile desktop add github:moyu-777/dsh-notion-workspaces
```

`desktop` is the profile your agent runs in — swap it for `web`, `headless`, or
whatever you use. The repository ships plain JavaScript (`lib/`, `client/`) and
declares no build scripts, so there is no `allowBuilds` approval step.

## Configure

1. Click **Notion** at the sidebar foot, next to Settings. (The same editor is
   also a page under Settings → **Notion 工作区**.)
2. Add a binding and pick the DSH workspace from the list.
3. Press **授权 / Authorize**. A browser tab opens on Notion's consent screen;
   approve the workspace you want this DSH workspace connected to. The callback
   lands on `127.0.0.1:<port>` in the running host.
4. Repeat for each workspace. Tools appear in that workspace's sessions as
   `mcp__notion_study__*` and so on.

## Where state lives

| What | Where |
|---|---|
| Bindings (workspace path → grant) | `$DSH_HOME/notion-workspaces.json` |
| Per-binding OAuth grant | DSH credential store (`$DSH_HOME/.credentials.yaml`), one ref per binding |
| Diagnostics | `$DSH_HOME/notion-workspaces-diag.log` (safe to delete) |

## Requirements

- DSH with the `desktop` or `web` profile (any profile that has a web server
  gets the dialog; a minimal profile still gets `dsh notion-workspaces login`).
- Node 22.13+.
- Network access to `https://mcp.notion.com`.

## What it touches

- **Credentials**: reads and writes its own refs in the DSH credential store.
- **Network**: `https://mcp.notion.com` only — OAuth discovery, dynamic client
  registration, token exchange/refresh, and the MCP stream.
- **Files**: `$DSH_HOME/notion-workspaces.json` and the diagnostics log.
- No telemetry, no other hosts, no install-time scripts.

## Known limitation

The per-workspace **hover menu** (`…` next to a workspace in the sidebar) has no
extension point: `sidebar.workspaces` is a `single` seat already claimed by the
shipped browser, and its menu items are hardcoded. Across the client's 69 slot
keys there is no per-workspace menu seat, so the entry point is the sidebar-foot
button and the settings page instead.

## Attribution

The OAuth flow in `lib/notion-oauth.js` is adapted from
[`dsh-notion-mcp`](https://github.com/mingzeng21/dsh-notion) by mingzeng
([@mingzeng21](https://github.com/mingzeng21)), MIT licensed — the retained
copyright notice is in [NOTICE](NOTICE). The differences here are that the
callback port and the credential ref are per binding, and the module is
restructured into named exports.

## Disclaimer

An independent community plugin. It is **not affiliated with, endorsed by, or
sponsored by Notion Labs, Inc.** "Notion" is a trademark of Notion Labs, Inc.,
used here only to describe what the plugin connects to. Your use of Notion's
services remains governed by Notion's own terms.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

## 中文

把每个 DSH 工作区绑定到各自的 Notion 工作区，走官方 Notion MCP。

### 它补的是什么缺口

`dsh-notion-mcp` 能把 dsh 接到 Notion，但它对**整个 DSH 环境只持有一份** Notion
授权：凭证引用 `NOTION_OAUTH`、`serverName` 都是写死的，MCP 客户端挂在 profile 的全局
作用域里。再授权第二个 Notion 工作区会覆盖掉第一个。而 DSH 本身没有工作区级的设置或
凭证作用域可用——`<cwd>/.env` 的优先级低于可写凭证存储，桌面宿主也是一次启动服务所有
工作区。

本插件把「工作区 → Notion 工作区」这个映射做在 DSH 唯一提供该粒度的地方：**agent 作用域**。

### 工作原理

- 一条绑定把一个工作区路径映射到一份 Notion 授权：各自的凭证引用、各自的
  `serverName`、各自的 OAuth 回调端口。
- 在 `agent/created` 时，用会话的 `header.cwd` 决定该用哪条绑定。
- MCP 客户端挂在**该 agent 自己的**上下文里，所以 `mcp__<serverName>__*` 工具只存在于
  那个工作区的会话中。未绑定的工作区完全看不到 Notion 工具。

绑定存在 `$DSH_HOME/notion-workspaces.json`；每份授权是 DSH 凭证存储里一个独立的密钥。
访问令牌会在后台刷新，持有旧令牌的 agent 会被重新挂载，不会拿着已失效的令牌继续请求。

### 安装

```sh
dsh plugin --profile desktop add github:moyu-777/dsh-notion-workspaces
```

`desktop` 换成你实际跑 agent 的 profile。仓库里是纯 JavaScript（`lib/`、`client/`），
且没有声明任何构建脚本，所以不需要 `allowBuilds` 授权。

### 配置

1. 点侧栏底部、设置旁边的 **Notion** 按钮（设置页里的「Notion 工作区」是同一个编辑器）。
2. 新增一条绑定，从列表里选 DSH 工作区。
3. 点「授权」。浏览器会打开 Notion 的授权页，批准你要连接的那个工作区即可；回调打到运行中
   宿主的 `127.0.0.1:<端口>`。
4. 每个工作区重复一次。之后该工作区的会话里就会出现 `mcp__notion_study__*` 这类工具。

### 状态存放位置

| 内容 | 位置 |
|---|---|
| 绑定表（工作区路径 → 授权） | `$DSH_HOME/notion-workspaces.json` |
| 每条绑定的 OAuth 授权 | DSH 凭证存储（`$DSH_HOME/.credentials.yaml`），一条绑定一个 ref |
| 诊断日志 | `$DSH_HOME/notion-workspaces-diag.log`（可随时删除） |

### 它触碰了什么

- **凭证**：读写自己在 DSH 凭证存储里的 ref。
- **网络**：仅 `https://mcp.notion.com`（OAuth 发现、动态客户端注册、令牌换取与刷新、MCP 流）。
- **文件**：`$DSH_HOME/notion-workspaces.json` 与诊断日志。
- 无遥测、无其他主机、无安装期脚本。

### 已知限制

工作区的**悬停菜单**（侧栏工作区行上的「…」）没有扩展点：`sidebar.workspaces` 是
`single` 座位且已被内置组件占用，菜单项是硬编码的。客户端 69 个 slot 里没有任何
「单个工作区菜单项」座位，因此入口只能是侧栏底部按钮和设置页。

### 致谢

`lib/notion-oauth.js` 的 OAuth 流程改编自 mingzeng
（[@mingzeng21](https://github.com/mingzeng21)）的
[`dsh-notion-mcp`](https://github.com/mingzeng21/dsh-notion)（MIT），保留的版权声明见
[NOTICE](NOTICE)。此处改动是回调端口与凭证引用都改为按绑定分配，并把模块重构为具名导出。

### 免责声明

独立的社区插件，**与 Notion Labs, Inc. 无隶属、无背书、无赞助关系**。「Notion」是
Notion Labs, Inc. 的商标，此处仅用于说明本插件连接的对象。你使用 Notion 服务仍受
Notion 自身条款约束。

### 许可

MIT，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
