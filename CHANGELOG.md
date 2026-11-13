# Changelog

## 0.1.2

### Fixed

- **Marketplace manifest description** — The plugin description no longer contains the word "Obsidian", which the community plugin validator rejects as redundant. No functional changes.

## 0.1.1

### Added

- **Desktop floating status dot** — Right-click the status-bar dot for a menu with sync now, pause/resume, "show as floating dot" and settings. The floating dot can be dragged anywhere, remembers its position across restarts, and offers the same menu on right-click so it can be docked back to the status bar.
- **Bi-directional plugin and theme sync** — Plugin files, themes and CSS snippets now sync in both directions. The scope is limited to `main.js`, `manifest.json`, `styles.css`, themes and `snippets/*.css`, so runtime files such as `highlight-db.json` no longer trigger endless "reload to apply" notices.
- **Blacklist sync scope** — The sync scope is now a blacklist with an editable rule list, pre-filled with the previously excluded paths; the per-file size limit was removed.
- **Inline conflict view** — Conflicting paragraphs are shown in place as colored callouts marked with the source device and time, plus commands to keep the desktop or the phone version. Losing versions are kept in the plugin `history/` folder.
- **Status activity indicator** — The dot pulses while files are being written, and also on the side that serves a file to the other device. On mobile the dot is a small draggable floating point with a long-press menu.
- **Latency logging** — End-to-end per-file timing is written to the debug log (`[耗时]` lines) to measure the real sync delay.

### Changed

- **Conflicts are merged, not copied** — The desktop now performs a three-way merge against a base-content store and writes the result back to the original note; no more `xxx.conflict-<device>-<time>.md` files cluttering folders.
- **Settings page redesign** — Status card, metric tiles, busy-aware buttons and rule chips replace the old form; the enable toggle starts and stops sync live without restarting Obsidian, and "starting…" is only shown while sync is actually enabled.
- **Status bar** — Shows only a colored dot and the file count.

### Fixed

- **Synced text disappearing** — A pull no longer records a new hash until the file on disk really contains it; if the write does not land, the index entry is dropped and the file is pulled again instead of pushing stale content back to the other side.
- **Scroll jump and flicker during sync** — Remote text is applied to the open editor with a minimal line-level diff instead of `setValue`, reading-mode leaves are skipped in favour of `vault.process`, and the scroll position is restored synchronously rather than with several delayed timers.
- **Reading view not refreshing** — Preview leaves are re-rendered after a remote write, so newly synced trailing text appears without switching notes.
- **Mobile edits blocked after a pull** — The anti-clobber guard now only skips a push when the local content still equals the last pulled version, so new edits sync immediately.
- **Reload prompt spam** — Narrowing the plugin sync scope stopped 200 KB+ runtime JSON files from being rewritten and re-triggering the notice every minute.
- **Mobile device count always 0** — The client reports one paired desktop instead of reading the desktop-only device map.
- **Settings toggle shadow and duplicated "sync scope" title** — Removed.

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
