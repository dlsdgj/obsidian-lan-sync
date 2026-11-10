# LAN Sync / 局域网同步
<img width="736" height="247" alt="26-11-11_02-49-47" src="https://github.com/user-attachments/assets/4b9fb42a-ab2a-4722-85fc-f4e811fb6bdc" />

<img width="1747" height="1216" alt="20261111024650" src="https://github.com/user-attachments/assets/d72ad35f-1bef-4f2c-8875-f4a4b42a0c98" />

| English | 中文 |
| --- | --- |
| Zero-configuration, LAN-only, two-way sync for Obsidian. Your desktop serves the vault; phones and tablets are pure clients. No account, no cloud, no relay, and nothing to type. | 零配置、仅在局域网内工作的 Obsidian 双向同步插件。电脑做服务端，手机/平板做纯客户端；不需要账号、云端或中转，也不需要填任何东西。 |
| Not affiliated with Obsidian. Tested on Windows (desktop) + Android (mobile); iOS is untested. | 与 Obsidian 官方无关。已在 Windows 桌面端 + Android 手机端验证，iOS 未测试。 |

---

## Features / 功能

| English | 中文 |
| --- | --- |
| **Zero-input pairing** — a new phone requests access automatically; the desktop shows a dialog, click **Allow & sync** once. No IP, port, PIN or key on either side. | **零输入配对** — 新手机自动申请，电脑端弹窗点一次「允许并同步」即可；两端都不用填 IP、端口、PIN 或密钥。 |
| **Automatic discovery** — cached endpoint first, with a native `requestUrl` fallback when the mobile WebView blocks plain-HTTP `fetch`, then common LAN subnet scanning. | **自动发现** — 优先直连缓存地址（手机 WebView 拦截明文 `fetch` 时自动切原生 `requestUrl`），再扫描常见局域网网段。 |
| **Incremental by index** — `index.json` on desktop, `state.json` / `remote-index.json` on mobile store hashes, `rev` and a change log. Restarts resume incrementally instead of re-hashing the whole vault. | **索引化增量** — 电脑 `index.json`、手机 `state.json` / `remote-index.json` 保存哈希、`rev` 与变更日志；重启后继续增量，不会全库重算。 |
| **Token authorization** — every data request carries `X-Lan-Sync-Token`. Unpaired devices get `401` and cannot read, overwrite or delete anything. Devices can be revoked instantly. | **令牌鉴权** — 所有数据请求带 `X-Lan-Sync-Token`；未授权设备返回 `401`，读不到索引、改不了也删不了文件；可随时移除设备使令牌立即失效。 |
| **Any file type** — notes, canvases, bases, images, PDFs, audio, video and archives; no extension whitelist. Text files are written through the Vault API so open editors are not overwritten. | **任意文件类型** — 笔记、画布、Base、图片、PDF、音视频、压缩包均可同步，没有扩展名白名单；文本文件走 Vault API 写入，不覆盖打开中的编辑器。 |
| **Conflict copies** — when both sides edit the same file, the local version is kept and the remote one is saved as `xxx.conflict-<device>-<timestamp>.md`. | **冲突副本** — 两端同时修改同一文件时保留本地版本，把远端内容另存为 `xxx.conflict-<设备>-<时间>.md`。 |
| **Bilingual UI** — the interface follows the Obsidian display language (Chinese / English) automatically. No language setting exists. | **双语界面** — 界面自动跟随 Obsidian 显示语言（中文 / English），无需任何语言设置。 |

---

## How it works / 工作原理

| English | 中文 |
| --- | --- |
| Obsidian on desktop has Node, so it runs a small HTTP server on ports `47800`–`47802`, backed by an in-memory index and a persisted change log. | 桌面端 Obsidian 有 Node，因此在 `47800`–`47802` 端口起一个轻量 HTTP 服务，背后是内存索引与落盘的变更日志。 |
| Mobile has no Node and cannot listen on a port, so it is a pure client: it discovers the desktop, polls `/changes`, and pulls / pushes only the files that differ. | 手机端没有 Node、不能监听端口，因此只做纯客户端：发现电脑、轮询 `/changes`，只拉取/推送有差异的文件。 |
| Reconciliation compares `path + size + mtime` first and re-hashes only changed files with SHA-256; content that is already identical is never rewritten. | 对账先比对 `path + size + mtime`，只对变化文件重算 SHA-256；内容相同就不写盘，避免无意义的 mtime 抖动与两端回环。 |
| `onload()` returns immediately; indexing, vault scanning and discovery run in the background so mobile Obsidian never reports "plugin took too long to load". | `onload()` 立即返回，索引、扫库、网络发现全部后台执行，手机端不会报「插件加载时间过长」。 |

---

## Install / 安装

| English | 中文 |
| --- | --- |
| Install on **both** devices. Because `.obsidian/` is never synced, each side needs its own copy of the plugin. | **两端都要安装**。由于 `.obsidian/` 不同步，每端都要各自放一份插件。 |
| From a [GitHub Release](../../releases): download `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/lan-sync/`, then reload Obsidian and enable the plugin. | 从 [GitHub Release](../../releases) 下载 `main.js` 与 `manifest.json`，放入 `<库>/.obsidian/plugins/lan-sync/`，重载 Obsidian 并启用插件。 |
| Once published: Settings → Community plugins → browse → search for **LAN Sync** → Install → Enable. | 上架之后：设置 → 社区插件 → 浏览 → 搜索 **LAN Sync** → 安装 → 启用。 |
| There is no build step and no dependency installation: `main.js` is the whole plugin. | 无需构建、无需安装依赖，`main.js` 就是完整插件。 |

---

## First sync / 首次同步

| English | 中文 |
| --- | --- |
| Open Obsidian on the desktop with the vault you want to serve, and connect the phone to the same Wi-Fi. | 在电脑上打开要同步的库，并让手机连到同一 Wi-Fi。 |
| The phone finds the server and sends a pairing request automatically. A dialog appears on the desktop — click **Allow & sync** if it is your own device. | 手机会自动找到服务并发出配对申请，电脑端弹出窗口；确认是自己的设备后点「允许并同步」。 |
| The phone receives its token automatically and starts syncing. Nothing needs to be typed, and later restarts / Wi-Fi changes require no action. | 手机自动拿到令牌并开始同步；全程无需输入，之后重启或换 Wi-Fi 也不用再操作。 |
| The first run builds an index of all files; later runs are incremental. Keep `state.json` and `remote-index.json` on the phone — deleting them forces a full re-scan. | 首次会建立全库索引，之后都是增量。请保留手机端的 `state.json` 与 `remote-index.json`，删掉会导致全量重扫。 |

---

## Sync scope / 同步范围

| Type | English | 中文 |
| --- | --- | --- |
| Synced | All notes: `.md`, `.canvas`, `.base`, `.excalidraw` | 所有笔记：`.md`、`.canvas`、`.base`、`.excalidraw` |
| Synced | Any attachment: images, PDFs, audio, video, zip (no extension whitelist) | 任意附件：图片、PDF、音视频、zip 等二进制（不限制扩展名） |
| Synced | Ordinary `.json` / `.js` / `.css` files inside the vault | 库里的普通 `.json` / `.js` / `.css` 等文件 |
| Synced | `xxx.conflict-*.md` copies created by the plugin | 插件生成的 `xxx.conflict-*.md` 冲突副本 |
| Excluded | Everything under `.obsidian/`: plugins, themes, `app.json`, `workspace.json`, `community-plugins.json`, hotkeys and layout | `.obsidian/` 下的一切：所有插件、主题、`app.json`、`workspace.json`、`community-plugins.json`、热键与布局 |
| Excluded | Plugin data: `data.json`, `index.json`, `state.json`, `remote-index.json`, `debug.log` | 插件自身数据：`data.json`、`index.json`、`state.json`、`remote-index.json`、`debug.log` |
| Excluded | `.trash/` (trashed files are not pulled back) and `.git/` | `.trash/`（删除进回收站的文件不会被拉回来）与 `.git/` |
| Excluded | Temp files starting with `~` or ending in `.tmp` / `.part`, and single files over 100 MB | `~` 开头的临时文件、`.tmp` / `.part`，以及单文件超过 100 MB |

Extensions only affect how a file is written, not whether it syncs. A nested folder named `.obsidian` (not at the vault root) is still synced. Excluding `.obsidian/` is deliberate: syncing device IDs, tokens, layouts and plugin lists would corrupt the other side's configuration.

扩展名只决定写入方式，不是同步白名单；库根以外、子目录里同名的 `.obsidian` 文件夹仍会被同步。排除 `.obsidian/` 是刻意的：设备身份、令牌、布局与插件启用列表若互相同步，会污染另一端的配置。

---

## Security / 安全

| English | 中文 |
| --- | --- |
| `/ping` exposes only the app id, vault id, auth flag and readiness — never the file list or revision. | `/ping` 只返回应用标识、库 ID、鉴权标志与就绪状态，不暴露文件列表或版本号。 |
| `/index`, `/changes`, `/file` and `/delete` all require an authorized device token; unpaired devices on the same Wi-Fi receive `401`. | `/index`、`/changes`、`/file`、`/delete` 全部需要已授权设备的令牌；同一 Wi-Fi 下的陌生设备只会收到 `401`。 |
| Tokens are bound to the desktop vault id. Removing a device in Settings → Device authorization invalidates its token immediately; the phone then re-requests access automatically. | 令牌绑定电脑端库 ID。在「设置 → 设备授权」移除设备后令牌立即失效，手机端会自动重新申请。 |
| The allowed-device list lives on the desktop in `data.json` and is never synced to other devices. | 已授权设备列表只存在电脑端 `data.json`，不会同步到其它设备。 |

---

## Limitations / 限制

| English | 中文 |
| --- | --- |
| Both devices must be on the same LAN and the desktop Obsidian must stay open. There is no cloud relay or remote access. | 两端必须在同一局域网，且电脑端 Obsidian 要保持打开；没有云端中继，也不能远程访问。 |
| No version history, no end-to-end encryption and no selective sync. This is a two-way mirror, not a backup. | 没有版本历史、端到端加密或选择性同步。这是双向镜像，不是备份方案。 |
| Single files larger than 100 MB are skipped silently. | 单文件超过 100 MB 会被静默跳过。 |
| Plugins, themes and settings are not synced, so keep both sides on the same plugin version manually. | 插件、主题与设置不同步，两端插件版本需要手动保持一致。 |
| iOS is untested. Not an official Obsidian plugin. | iOS 未测试；非 Obsidian 官方插件。 |

---

## Troubleshooting / 故障排查

| Symptom | What to check / 处理办法 |
| --- | --- |
| Computer not found / 找不到电脑 | Same Wi-Fi, desktop Obsidian open, firewall allowing `47800`–`47802`; run the **Find computer again** command on the phone. / 同一 Wi-Fi、电脑端 Obsidian 已打开、防火墙放行 `47800`–`47802`；手机端执行「重新查找电脑」命令。 |
| No pending device / 待确认里没有设备 | Check the phone's pairing status in settings; on the desktop run **Review pending devices**. / 在手机设置页查看配对状态；电脑端执行「处理待确认的设备」。 |
| Stuck on "Scanning…" / 一直显示「扫描中…」 | Only the first run hashes the whole vault. Do not delete `state.json` / `remote-index.json`; if they are gone, allow one full scan. / 仅首次会全库哈希。不要删 `state.json` / `remote-index.json`；若已删除，请等待一次全量扫描完成。 |
| `401` or authorization lost / `401` 或授权失效 | Remove the device on the desktop and allow it again, or clear `pairToken` on the phone to re-pair. / 在电脑端移除该设备后重新允许，或清掉手机端 `pairToken` 重新配对。 |
| Deleted files come back / 删除的文件又出现 | Fixed in `0.1.0`; make sure both devices run `0.1.0` or newer. / `0.1.0` 已修复，请确认两端都是 `0.1.0` 或更新版本。 |

---

## Development / 开发

| English | 中文 |
| --- | --- |
| No bundler: `main.js` is the source. Validate with `node --check main.js`. | 无打包步骤，`main.js` 即源码；用 `node --check main.js` 做语法检查。 |
| The bilingual dictionary is the `I18N` constant at the top of `main.js`; each entry is `[Chinese, English]` and the language is detected from Obsidian at runtime. | 双语字典是 `main.js` 顶部的 `I18N` 常量，每项为 `[中文, English]`，运行时按 Obsidian 语言自动选择。 |
| A release contains `main.js` and `manifest.json`; the tag must match `manifest.json` version exactly. | Release 只包含 `main.js` 与 `manifest.json`，tag 必须与 `manifest.json` 的版本号完全一致。 |

---

## License / 许可

MIT — see [LICENSE](LICENSE). / MIT，详见 [LICENSE](LICENSE)。
