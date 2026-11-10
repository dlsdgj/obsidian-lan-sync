# Changelog

## 0.1.0

### Added

- **Zero-input pairing** — A new mobile device automatically requests access; the desktop shows a modal and one click on "Allow & sync" authorizes it. No IP, port, PIN or key is entered on either side.
- **Automatic discovery** — Cached endpoints are probed first, with a native `requestUrl` fallback when the mobile WebView blocks plain-HTTP `fetch`, followed by common LAN subnet scanning.
- **Persistent incremental index** — `index.json` on desktop and `state.json` / `remote-index.json` on mobile store hashes, a `rev` counter and a change log, so restarts resume incrementally instead of re-hashing the whole vault.
- **Device authorization** — Every data request carries `X-Lan-Sync-Token`; unpaired devices receive `401`. Tokens are bound to the vault and can be revoked instantly from the settings tab.
- **Binary-safe transfers** — Notes, canvases, bases, images, PDFs, audio, video and archives are transferred without an extension whitelist. Text files are written through the Vault API so open editors are not overwritten.
- **Conflict copies** — When both sides change the same file, the local version is kept and the remote one is saved as `xxx.conflict-<device>-<timestamp>.md`.
- **Bilingual UI** — The interface follows the Obsidian display language automatically (Chinese / English) with an embedded dictionary; no language setting to configure.
- **Sync scope reference** — A table in the settings tab documents exactly what is synced and what is excluded.
- **Non-blocking startup** — `onload()` resolves immediately while indexing, vault scanning and discovery run in the background, avoiding the "plugin took too long to load" warning on mobile.

### Fixed

- **Deleted files no longer resurrect** — A desktop deletion now removes the file on mobile instead of sending a redundant delete request that left the local copy behind and pushed it back on the next cycle.
- **Status bar file count** — The count refreshes on every index change instead of only on a periodic rescan.
- **External deletions** — A lightweight metadata reconciliation runs every minute to catch deletions made outside Obsidian.
- **Mobile "still building" loop** — Startup vault events are no longer treated as user edits, so the 17k-file index is reused without re-hashing every file on each launch.
- **Discovery behind WebView restrictions** — Cached endpoints are reachable through Obsidian's native network API even when `fetch` is blocked.
- **Stable language detection** — The UI follows the Obsidian display language from `localStorage` with a system-locale fallback and a startup recalibration; no manual language option is exposed.
- **Language-switch restarts** — Startup is deferred until the workspace is ready, all heavy index/vault loops yield in batches, `onload()`/`onunload()` errors are contained, and the HTTP server keeps a permanent error handler; changing the display language no longer hangs or blanks Obsidian.
- **Crash-safe index files** — `index.json`, `state.json` and `remote-index.json` are written through a temporary file plus atomic rename and can be recovered from the temp copy; a half-written index or an unreadable `data.json` no longer forces a full 17k-file rebuild.
