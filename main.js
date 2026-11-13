'use strict';
/*
 * 局域网同步 LanSync
 *
 * 第一性原理：
 *  - 电脑有 Node → 唯一服务端：内存索引 + 变更日志 + HTTP 收发文件
 *  - 手机无 Node（不能监听端口/UDP）→ 纯客户端：扫描局域网找到电脑，轮询变更，按需拉/推
 *  - 索引单独落盘：电脑 index.json（files + rev + 变更日志），手机 state.json / remote-index.json
 *    启动时读索引即就绪，只按 path+size+mtime 对比元数据，仅变化文件读盘重算 SHA-256
 *  - 由索引对比出的候选集决定操作哪些文件；rev 也持久化，重启后继续增量而非全量快照
 *  - 落盘前比较内容，相同不写（避免 mtime 抖动与两端回环）；文本文件走 Vault.process 不覆盖编辑器
 *  - 双向都改 → 电脑端做唯一合并方：能三方合并就直接合，合不了才在正文内插入
 *    彩色 callout 冲突块；旧版本进插件目录的 history/，绝不生成 xxx.conflict-*.md
 *  - .obsidian 只同步“可移植配置”（插件代码/主题/片段/书签/图谱），
 *    workspace、缓存、插件 data.json 与插件自身目录属于设备状态，永不同步
 *  - onload 立即返回，索引/扫库/网络发现全部后台进行，避免手机端“插件加载时间过长”
 *  - 零输入配对：手机自动申请，电脑端弹窗点一次「允许」即授权；之后每个请求带设备令牌，
 *    未授权设备读不到索引、拿不到文件，也不能写入或删除
 */
const { Plugin, PluginSettingTab, Setting, Notice, Platform, Modal, Menu, requestUrl } = require('obsidian');

const APP_ID = 'lan-sync';
const API = '/lan-sync';
const BASE_PORT = 47800;
const PORT_COUNT = 3;
const POLL_MS = 600;
const LOG_LIMIT = 20000;
const PERSIST_LOG = 2000;      // 索引文件中保留的变更日志条数
const INDEX_VERSION = 3;
const SELF_PLUGIN_DIR = '.obsidian/plugins/lan-sync';
// 同步范围：黑名单模式。默认值就是“过去写死不同步”的那些，用户可在设置里增删。
// 支持 * / ** / ? 通配，以及 ! 开头的反向规则（按顺序，后匹配的生效）。
const DEFAULT_IGNORE = [
  '.trash/**',
  '.git/**',
  '.DS_Store',
  '**/.DS_Store',
  '.obsidian/plugins/lan-sync/**',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache/**',
  '.obsidian/appearance.json',
  '.obsidian/hotkeys.json',
  '.obsidian/community-plugins.json',
  '.obsidian/core-plugins.json',
  '.obsidian/plugins/*/*.json',
  '!.obsidian/plugins/*/manifest.json',
  '.obsidian/plugins/*/backups/**',
];
const MERGE_EXT = new Set(['.md', '.txt']);
const MERGE_MAX = 2 * 1024 * 1024;   // 超过这个大小的文本不做三方合并，直接 LWW
const HISTORY_KEEP = 300;            // 冲突历史最多保留的文件数
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.css', '.js', '.ts', '.html', '.xml', '.svg']);

/* ============================ i18n ============================ */
// 单文件插件不能带外部语言包：字典内嵌，每项 [中文, English]，由 LANG 选择。
const I18N = {
  'app.title': ['局域网同步', 'LAN Sync'],

  'cmd.syncNow': ['立即同步', 'Sync now'],
  'cmd.reconnect': ['重新查找电脑', 'Find computer again'],
  'cmd.pairDevices': ['处理待确认的设备', 'Review pending devices'],
  'ribbon.sync': ['局域网同步：立即同步', 'LAN Sync: Sync now'],

  'notice.pairOnDesktop': ['配对在电脑端确认，手机端无需操作', 'Pairing is confirmed on the desktop; nothing to do on mobile'],
  'notice.stillStarting': ['局域网同步：仍在启动，请稍候', 'LAN Sync: still starting, please wait'],
  'notice.status': ['局域网同步：{0}', 'LAN Sync: {0}'],
  'notice.desktopIndex': ['电脑端索引：{0} 个文件', 'Desktop index: {0} files'],
  'notice.noClient': ['仍在启动，或当前是电脑端（无需查找）', 'Still starting, or this is the desktop (no discovery needed)'],
  'notice.deviceRemoved': ['已移除该设备，它将无法再同步', 'Device removed; it can no longer sync'],
  'notice.enabled': ['已启用同步', 'Sync enabled'],
  'notice.disabled': ['已关闭同步', 'Sync disabled'],

  'status.starting': ['启动中…', 'Starting…'],
  'status.bootFailed': ['启动失败：{0}', 'Startup failed: {0}'],
  'status.serverPortTaken': ['服务启动失败：端口被占用', 'Server failed to start: port in use'],
  'status.checkingIndex': ['校验索引…', 'Verifying index…'],
  'status.buildingIndex': ['首次建立索引…', 'Building index for the first time…'],
  'status.indexFailed': ['索引失败: {0}', 'Index failed: {0}'],
  'status.indexing': ['正在建立索引… {0}/{1}', 'Building index… {0}/{1}'],
  'status.rehash': ['增量对账… 重新哈希 {0} 个文件', 'Incremental check… re-hashing {0} files'],
  'status.ready': ['服务已就绪 · 端口 {0} · {1} 个文件{2}', 'Server ready · port {0} · {1} files{2}'],
  'status.pendingTail': [' · {0} 个设备待确认', ' · {0} devices pending'],
  'status.allowed': ['已允许 {0} · 手机端将自动开始同步', 'Allowed {0} · the phone will start syncing automatically'],
  'status.findServer': ['正在查找电脑…', 'Looking for the computer…'],
  'status.findSubnet': ['正在查找电脑… {0}.x', 'Looking for the computer… {0}.x'],
  'status.serverNotFound': ['未找到电脑（确认同一 Wi-Fi 且电脑端 Obsidian 已打开）', 'Computer not found (check the Wi-Fi and that Obsidian is open on the desktop)'],
  'status.connected': ['已连接 {0}:{1} · 同步中…', 'Connected to {0}:{1} · syncing…'],
  'status.connectFailed': ['连接失败：{0}', 'Connection failed: {0}'],
  'status.disconnected': ['连接断开{0}，稍后重试', 'Disconnected{0}, retrying shortly'],
  'status.reason': ['：{0}', ': {0}'],
  'status.upToDate': ['已是最新 · {0}', 'Up to date · {0}'],
  'status.scanning': ['扫描中… {0}/{1}', 'Scanning… {0}/{1}'],
  'status.syncing': ['同步中… 已处理 {0} 个文件', 'Syncing… {0} files processed'],
  'status.synced': ['已同步 {0} 个文件 · {1}', 'Synced {0} files · {1}'],
  'status.waitPair': ['等待电脑确认…（在电脑上点「允许」）', 'Waiting for desktop approval (click Allow on the computer)'],
  'status.paired': ['已配对，开始同步…', 'Paired, starting sync…'],

  'err.timeout': ['超时：{0}', 'Timed out: {0}'],
  'err.timeoutPlain': ['超时', 'Timed out'],
  'err.uploadTimeout': ['上传超时', 'Upload timed out'],
  'err.notLanSync': ['不是局域网同步服务', 'Not a LAN Sync server'],
  'err.rejected': ['电脑拒绝了此设备', 'The computer rejected this device'],
  'err.pairTimeout': ['等待电脑确认超时', 'Timed out waiting for desktop approval'],
  'err.desktopIndexing': ['电脑正在建立索引', 'The computer is still building its index'],
  'task.write': ['写入 {0}', 'Write {0}'],
  'task.read': ['读取 {0}', 'Read {0}'],
  'task.update': ['更新 {0}', 'Update {0}'],
  'task.request': ['请求 {0}', 'Request {0}'],
  'task.download': ['下载 {0}', 'Download {0}'],
  'task.upload': ['上传 {0}', 'Upload {0}'],
  'task.probe': ['探测 {0}', 'Probe {0}'],
  'task.findServer': ['查找电脑', 'Find computer'],
  'task.syncRound': ['本轮同步', 'Sync round'],

  'pair.title': ['局域网同步 · 设备请求', 'LAN Sync · Device request'],
  'pair.body': ['有一台设备请求同步这个笔记库：\n\n设备：{0}\nIP：{1}\n时间：{2}\n\n确认是你本人的设备再点「允许并同步」。手机端不需要填任何东西。', 'A device is requesting access to this vault:\n\nDevice: {0}\nIP: {1}\nTime: {2}\n\nOnly approve if this is your own device. Nothing needs to be entered on the phone.'],
  'pair.allow': ['允许并同步', 'Allow & sync'],
  'pair.reject': ['拒绝', 'Reject'],

  'device.android': ['Android 手机', 'Android phone'],
  'device.mobile': ['移动设备', 'Mobile device'],
  'device.desktop': ['电脑', 'Desktop'],
  'device.authorized': ['已授权设备', 'Authorized device'],
  'device.unknown': ['未知设备', 'Unknown device'],
  'device.rejectedTag': [' · 曾拒绝', ' · previously rejected'],

  'conflict.remoteTitle': ['冲突 · 来自{0} · {1}', 'Conflict · from {0} · {1}'],
  'conflict.localTitle': ['冲突 · 本机版本（{0}）', 'Conflict · this device ({0})'],
  'conflict.keepThis': ['保留这一版', 'Keep this version'],
  'conflict.removed': ['（这一版删除了这段）', '(this version removed this part)'],
  'notice.resolveDone': ['已保留所选版本', 'Kept the selected version'],
  'notice.reloadNeeded': ['插件或主题已同步，重载 Obsidian 后生效', 'Plugins or themes synced; reload Obsidian to apply'],
  'notice.noConflict': ['当前笔记里没有冲突块', 'No conflict block in this note'],
  'cmd.acceptRemote': ['冲突：保留电脑版', 'Conflict: keep desktop version'],
  'cmd.acceptLocal': ['冲突：保留本机版', 'Conflict: keep this device version'],
  'dot.hide': ['隐藏悬浮点', 'Hide the floating dot'],
  'dot.hidden': ['已隐藏，可在设置里重新打开', 'Hidden. Re-enable it in settings.'],
  'dot.settings': ['设置…', 'Settings…'],
  'dot.float': ['悬浮显示', 'Show as floating dot'],
  'dot.dock': ['停靠到状态栏', 'Dock to status bar'],
  'dot.syncNow': ['立即同步', 'Sync now'],
  'dot.pause': ['暂停同步', 'Pause sync'],
  'dot.resume': ['恢复同步', 'Resume sync'],

  'settings.intro': ['同一 Wi-Fi 下自动发现并双向同步。新手机装上插件后会自动申请，在电脑端弹窗点一次「允许」即可；两端都不需要填 IP、端口或密钥。', 'Automatic two-way sync over the same Wi-Fi. A new phone requests access automatically; approve once in the desktop dialog. No IP, port or key to type on either side.'],
  'settings.status': ['状态：{0}', 'Status: {0}'],
  'settings.port': ['服务端口：{0}{1}', 'Server port: {0}{1}'],
  'settings.notStarted': ['未启动', 'not started'],
  'settings.indexingTag': ['（索引中）', ' (indexing)'],
  'settings.indexFiles': ['索引文件：{0}', 'Indexed files: {0}'],
  'settings.lastClient': ['最近连接：{0}', 'Last connection: {0}'],
  'settings.none': ['暂无', 'None'],
  'settings.devicesCount': ['已授权设备：{0} 台{1}', 'Authorized devices: {0}{1}'],
  'settings.pendingCount': [' · 待确认 {0} 台', ' · {0} pending'],
  'settings.pairStatus': ['配对状态：{0}', 'Pairing: {0}'],
  'settings.authorized': ['已授权', 'Authorized'],
  'settings.waitApproval': ['等待电脑确认', 'Waiting for desktop approval'],
  'settings.pcAddr': ['电脑地址：{0}', 'Computer: {0}'],
  'settings.notFound': ['未发现', 'not found'],
  'settings.lastSync': ['上次同步：{0}', 'Last sync: {0}'],
  'settings.session': ['本次会话：拉取 {0} · 推送 {1} · 删除 {2} · 冲突 {3}', 'This session: pulled {0} · pushed {1} · deleted {2} · conflicts {3}'],

  'settings.enable': ['启用同步', 'Enable sync'],
  'settings.enableDesc': ['关闭后立即停止监听和同步，不需要重启 Obsidian。', 'Stops listening and syncing immediately; no restart needed.'],
  'settings.ignore': ['同步范围（黑名单）', 'Sync scope (blacklist)'],
  'settings.ignoreDesc': ['每行一条，支持 * 通配和 ** 递归；以 ! 开头表示重新纳入同步。留空则使用默认规则。', 'One pattern per line; * matches a segment, ** is recursive, ! re-includes. Empty means the defaults.'],
  'settings.ignoreReset': ['恢复默认', 'Restore defaults'],
  'status.disabled': ['同步已停用', 'Sync disabled'],
  'status.waitPeer': ['等待手机连接', 'Waiting for the phone'],
  'settings.tileFiles': ['个文件', 'files'],
  'settings.tileDevices': ['台设备', 'devices'],
  'settings.tileLast': ['最近同步', 'Last sync'],
  'settings.pausedTitle': ['已暂停', 'Paused'],
  'settings.pausedDesc': ['已停止监听与同步，打开开关立即恢复，无需重启 Obsidian', 'Stopped; turn it back on to resume instantly'],
  'settings.runningTitle': ['同步运行中', 'Sync running'],
  'settings.btnSyncing': ['同步中…', 'Syncing…'],
  'settings.btnRescanning': ['对账中…', 'Checking…'],
  'settings.scopeRules': ['{0} 条', '{0} rules'],
  'settings.scopeDefault': ['默认', 'default'],
  'settings.help': ['同步规则与冲突处理', 'Sync rules & conflicts'],
  'settings.helpYes': ['会同步', 'Synced'],
  'settings.helpNo': ['不同步', 'Not synced'],
  'settings.helpYesBody': [
    '- 除下面列出的排除规则外，库内所有文件都会同步\n- 笔记（.md .canvas .base .excalidraw）、任意附件（图片、PDF、音视频、zip）\n- 库里的普通 .json / .js / .css\n- .obsidian 中未被排除的部分：插件代码与样式、主题、CSS 片段、graph.json、bookmarks.json',
    '- Everything except the rules below\n- Notes (.md .canvas .base .excalidraw) and any attachment\n- Plain .json / .js / .css in the vault\n- Non-excluded parts of .obsidian: plugin code & styles, themes, snippets, graph.json, bookmarks.json',
  ],
  'settings.helpNoBody': [
    '- 默认排除项（可在上方「同步范围」里增删）：workspace*.json、cache/、appearance.json、hotkeys.json、community-plugins.json\n- 插件运行时状态：plugins/*/data.json、plugins/*/*.json（manifest.json 除外）、backups/\n- 本插件自身目录 .obsidian/plugins/lan-sync/ （令牌与索引，不可排除此项）\n- .trash/、.git/，以及 ~ 开头、.tmp、.part 的临时文件',
    '- Default exclusions (editable above): workspace*.json, cache/, appearance.json, hotkeys.json, community-plugins.json\n- Plugin runtime state: plugins/*/data.json, plugins/*/*.json (except manifest.json), backups/\n- This plugin\'s own folder .obsidian/plugins/lan-sync/ (tokens & index; cannot be un-excluded)\n- .trash/, .git/, and ~ / .tmp / .part temp files',
  ],
  'settings.helpConflict': [
    '冲突处理：电脑端做三方合并，能自动合的直接写回原文件；只有同一段被两端同时改动时才在正文插入对照 callout（电脑版 / 本机版），点「保留这一版」即可，旧内容保留在插件 history/。',
    'Conflicts: the desktop does a 3-way merge. Non-overlapping edits merge silently; only overlapping paragraphs get a comparison callout with a "keep this version" button. Old content stays in history/.',
  ],
  'settings.syncNow': ['立即同步', 'Sync now'],
  'settings.syncNowDesc': ['手动触发一次完整对账', 'Run a full reconciliation now'],
  'settings.mobileDot': ['显示悬浮状态点', 'Show the floating status dot'],
  'settings.mobileDotDesc': ['手机右下角的小圆点：拖动能换位置，长按打开菜单（同步 / 重连 / 隐藏）。', 'A small dot at the bottom-right: drag to move, long-press for sync / reconnect / hide.'],
  'settings.btnSync': ['同步', 'Sync'],
  'settings.reconnect': ['重新查找电脑', 'Find computer again'],
  'settings.reconnectDesc': ['换 Wi-Fi 或找不到电脑时使用', 'Use after changing Wi-Fi or when the computer cannot be found'],
  'settings.btnFind': ['查找', 'Find'],
  'settings.rescan': ['重新对账索引', 'Recheck index'],
  'settings.rescanDesc': ['只比对元数据，重新哈希有变化的文件；不再全盘重扫', 'Compares metadata only and re-hashes changed files; no full rescan'],
  'settings.btnRescan': ['对账', 'Check'],
  'settings.btnEdit': ['编辑', 'Edit'],
  'settings.btnCollapse': ['收起', 'Collapse'],

  'settings.devices': ['设备授权', 'Device authorization'],
  'settings.mobileAuthorized': ['本机已获授权，之后同步全自动。如需解除，请在电脑端「设备授权」里移除这台设备。', 'This device is authorized and syncs automatically. To revoke, remove it under Device authorization on the desktop.'],
  'settings.mobilePending': ['本机尚未获授权：在电脑端弹出的窗口里点一次「允许并同步」即可，手机端不需要任何输入。', 'Not authorized yet: click "Allow & sync" in the desktop dialog. Nothing to enter on this device.'],
  'settings.serverStarting': ['服务正在启动…', 'Server is starting…'],
  'settings.pendingTitle': ['待确认（{0}）', 'Pending ({0})'],
  'settings.noPending': ['暂无请求。新手机装上插件后会自动出现在这里，同时电脑端会弹窗提示。', 'No requests. New devices appear here automatically and also open a dialog on the desktop.'],
  'settings.allowedTitle': ['已允许的设备（{0}）', 'Allowed devices ({0})'],
  'settings.noDevices': ['还没有设备被允许。', 'No devices allowed yet.'],
  'settings.authorizedAt': ['IP {0} · 授权于 {1}', 'IP {0} · authorized {1}'],
  'settings.btnRemove': ['移除', 'Remove'],

  'settings.scope': ['同步范围', 'Sync scope'],
};

function detectLang() {
  let raw = '';
  try { raw = window.localStorage.getItem('language') || ''; } catch (e) { /* ignore */ }
  // 不用 moment.locale()：它不跟随 Obsidian 界面语言，且在语言设置就绪前会误判成 en
  if (!raw) { try { raw = navigator.language || ''; } catch (e) { /* ignore */ } }
  return /^zh/i.test(String(raw)) ? 'zh' : 'en';
}

let LANG = 'zh';
function tr(key, ...args) {
  const row = I18N[key];
  if (!row) return key;
  const s = row[LANG === 'zh' ? 0 : 1] || row[0] || key;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[+i] === undefined ? m : String(args[+i]))) : s;
}

/* ============================ 基础工具 ============================ */

function uuid() {
  try {
    if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  } catch (e) { /* ignore */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function isConfigPath(path) {
  return path === '.obsidian' || path.startsWith('.obsidian/');
}

function isSelfPath(path) {
  return path === SELF_PLUGIN_DIR || path.startsWith(SELF_PLUGIN_DIR + '/');
}

function pluginIdOf(path) {
  const m = /^\.obsidian\/plugins\/([^/]+)\//.exec(path);
  return m ? m[1] : '';
}

function shouldIgnore(path) {
  if (!path) return true;
  const p = String(path).replace(/^\/+/, '');
  if (p.split('/').some((s) => s === '..')) return true;  // 拒绝越界路径
  // 历史遗留：.obsidian 里又套了一层 .obsidian（旧版镜像的产物），不能当配置同步
  if (p.indexOf('/.obsidian/') >= 0) return true;
  // 插件自身（令牌、索引）永远不同步，这项不给用户改
  if (isSelfPath(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (!base) return true;
  if (base.startsWith('~') || base.endsWith('.tmp') || base.endsWith('.part')) return true;
  return matchIgnore(p);
}

// 黑名单匹配：按顺序求值，! 开头的规则表示“重新纳入同步”
let IGNORE_RULES = compileIgnore(DEFAULT_IGNORE);

function compileIgnore(lines) {
  const out = [];
  for (const raw of lines || []) {
    const s = String(raw).trim();
    if (!s || s.startsWith('#')) continue;
    const neg = s.startsWith('!');
    const pat = neg ? s.slice(1).trim() : s;
    if (!pat) continue;
    out.push({ neg, re: globToRe(pat) });
  }
  return out;
}

function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchIgnore(p) {
  let hit = false;
  for (const r of IGNORE_RULES) {
    if (r.re.test(p)) hit = !r.neg;
  }
  return hit;
}

function setIgnorePatterns(lines) {
  IGNORE_RULES = compileIgnore(lines && lines.length ? lines : DEFAULT_IGNORE);
}

function extOf(path) {
  const b = String(path).slice(String(path).lastIndexOf('/') + 1);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(dot).toLowerCase() : '';
}

function countVault(map) {
  let n = 0;
  for (const p of map.keys()) if (!isConfigPath(p)) n++;
  return n;
}

function fmtStamp(ms) {
  const d = new Date(ms || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function cmpVer(a, b) {
  const pa = String(a || '').split(/[.\-+_]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.\-+_]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function readPluginVersion(app, id) {
  try {
    const text = await app.vault.adapter.read('.obsidian/plugins/' + id + '/manifest.json');
    const j = JSON.parse(text);
    return j && j.version ? String(j.version) : '';
  } catch (e) { return ''; }
}

/* ============================ 行级 diff 与三方合并 ============================ */

function splitLines(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
}

// a→b 的改动区间，坐标基于 a 的行号。中间段过大时退化成“整段替换”，
// 避免在几千行的笔记上跑 O(n*m) 的 DP 把界面卡死。
const DIFF_CELLS = 6e6;

function diffHunks(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p &&
         a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ae = a.length - s, be = b.length - s;
  const n = ae - p, m = be - p;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > DIFF_CELLS) return [{ a0: p, a1: ae, b0: p, b1: be }];

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w, next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[p + i] === b[p + j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }

  const hunks = [];
  let i = 0, j = 0, hA = -1, hB = -1;
  const flush = (endA, endB) => {
    if (hA < 0) return;
    hunks.push({ a0: hA, a1: endA, b0: hB, b1: endB });
    hA = -1; hB = -1;
  };
  while (i < n && j < m) {
    if (a[p + i] === b[p + j]) { flush(p + i, p + j); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      if (hA < 0) { hA = p + i; hB = p + j; }
      i++;
    } else {
      if (hA < 0) { hA = p + i; hB = p + j; }
      j++;
    }
  }
  flush(p + n, p + m);
  return hunks;
}

function applyHunks(base, src, hunks, start, end) {
  const out = [];
  let pos = start;
  for (const h of hunks) {
    if (h.a0 > pos) out.push.apply(out, base.slice(pos, h.a0));
    out.push.apply(out, src.slice(h.b0, h.b1));
    pos = h.a1;
  }
  if (pos < end) out.push.apply(out, base.slice(pos, end));
  return out;
}

// 冲突块：.md 用两个不同配色的 callout（阅读视图与实时预览都能上色），
// 其它纯文本用 git 风格分隔符；两端拿到的是同一份文本，不会来回打架。
function conflictLines(info, localLines, remoteLines) {
  const stamp = fmtStamp(info.remoteAt);
  if (info.ext !== '.md') {
    return ['<<<<<<< ' + info.localName].concat(localLines, ['======='], remoteLines, ['>>>>>>> ' + info.remoteName]);
  }
  const body = (lines) => {
    const real = lines.filter((l) => l && l.trim());
    if (!real.length) return ['> ' + tr('conflict.removed')];
    return lines.map((l) => (l ? '> ' + l : '>'));
  };
  return [''].concat([
    '%% lan-sync:conflict:remote ' + stamp + ' %%',
    '> [!lan-sync-remote] ' + tr('conflict.remoteTitle', info.remoteName, stamp),
  ], body(remoteLines), [
    '',
    '%% lan-sync:conflict:local %%',
    '> [!lan-sync-local] ' + tr('conflict.localTitle', info.localName),
  ], body(localLines), ['%% /lan-sync:conflict %%', '']);
}

function merge3(baseText, localText, remoteText, info) {
  const base = splitLines(baseText);
  const loc = splitLines(localText);
  const rem = splitLines(remoteText);
  if (loc.join('\n') === rem.join('\n')) return { text: localText, conflicts: 0 };
  const all = diffHunks(base, loc).map((h) => Object.assign({ side: 'L' }, h))
    .concat(diffHunks(base, rem).map((h) => Object.assign({ side: 'R' }, h)))
    .sort((x, y) => (x.a0 - y.a0) || (x.a1 - y.a1));

  const out = [];
  let pos = 0, conflicts = 0, idx = 0;
  while (idx < all.length) {
    const first = all[idx];
    if (first.a0 > pos) out.push.apply(out, base.slice(pos, first.a0));
    const cs = first.a0;
    let ce = first.a1;
    const cluster = [first];
    idx++;
    while (idx < all.length && all[idx].a0 <= ce) {
      cluster.push(all[idx]);
      ce = Math.max(ce, all[idx].a1);
      idx++;
    }
    const L = cluster.filter((h) => h.side === 'L');
    const R = cluster.filter((h) => h.side === 'R');
    const lText = L.length ? applyHunks(base, loc, L, cs, ce) : null;
    const rText = R.length ? applyHunks(base, rem, R, cs, ce) : null;
    if (lText && rText) {
      if (lText.join('\n') === rText.join('\n')) out.push.apply(out, lText);
      else {
        out.push.apply(out, conflictLines(info, lText, rText));
        conflicts++;
      }
    } else if (lText) out.push.apply(out, lText);
    else if (rText) out.push.apply(out, rText);
    pos = ce;
  }
  if (pos < base.length) out.push.apply(out, base.slice(pos));
  if (!out.length) return { text: localText, conflicts: 0 };
  return { text: out.join('\n'), conflicts };
}

/* ============================ 基础工具 ============================ */

function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

// 32 字符内容哈希；优先原生 SHA-256，缺失时退回 FNV 混合（两端算法一致即可）
async function hashBytes(buf) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && subtle.digest) {
    try {
      const d = await subtle.digest('SHA-256', buf);
      return toHex(new Uint8Array(d)).slice(0, 32);
    } catch (e) { /* fall through */ }
  }
  const u8 = new Uint8Array(buf);
  let a = 0x811c9dc5, b = 0xcbf29ce4 ^ u8.length, c = 0x9e3779b9, d = 0x85ebca6b;
  for (let i = 0; i < u8.length; i++) {
    const v = u8[i];
    a = Math.imul(a ^ v, 16777619) >>> 0;
    b = Math.imul(b ^ (v + i), 16777619) >>> 0;
    c = Math.imul(c ^ (v << 3), 2246822519) >>> 0;
    d = Math.imul(d ^ (v + 7), 3266489917) >>> 0;
  }
  const part = (n) => n.toString(16).padStart(8, '0');
  return part(a) + part(b) + part(c) + part(d);
}

function toArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  if (buf && buf.buffer) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new ArrayBuffer(0);
}

// 任何一步都不能无限等待，否则整个同步循环会被一个请求锁死
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(label ? tr('err.timeout', label) : tr('err.timeoutPlain')));
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureFolder(app, path) {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return;
  const dir = path.slice(0, idx);
  let cur = '';
  for (const part of dir.split('/')) {
    cur = cur ? cur + '/' + part : part;
    if (!(await app.vault.adapter.exists(cur))) {
      try { await app.vault.adapter.mkdir(cur); } catch (e) { /* 并发创建忽略 */ }
    }
  }
}

async function writeFileBytes(app, path, ab) {
  await ensureFolder(app, path);
  await withTimeout(app.vault.adapter.writeBinary(path, ab), 90000, tr('task.write', path));
}

async function readFileBytes(app, path) {
  return await withTimeout(app.vault.adapter.readBinary(path), 60000, tr('task.read', path));
}

// 大小/时间：.obsidian 里的文件不是 vault 文件，getAbstractFileByPath 拿不到
async function statMeta(app, path) {
  try {
    const af = app.vault.getAbstractFileByPath(path);
    if (af && af.stat) return af.stat;
    const st = await app.vault.adapter.stat(path);
    if (st) return st;
  } catch (e) { /* ignore */ }
  return null;
}

// 枚举 .obsidian 里需要同步的可移植配置。vault.getFiles() 永远看不到这些文件，
// 必须单独走 adapter.list；同时它们也不会触发 vault 的 modify 事件。
async function collectConfig(app) {
  const adapter = app.vault.adapter;
  const out = new Map();
  const push = async (p) => {
    if (shouldIgnore(p)) return;
    try {
      const st = await adapter.stat(p);
      if (!st || st.type === 'folder') return;
      out.set(p, { size: st.size || 0, mtime: st.mtime || 0 });
    } catch (e) { /* 单个文件失败不影响整轮 */ }
  };
  const walk = async (dir, depth) => {
    if (depth < 0) return;
    let list = null;
    try { list = await adapter.list(dir); } catch (e) { return; }
    const files = (list && list.files) || [];
    const folders = (list && list.folders) || [];
    for (const f of files) await push(f);
    // 只跳过插件自身目录（含 history/base），其余子目录照常走
    for (const f of folders) { if (isSelfPath(f)) continue; await walk(f, depth - 1); }
  };
  try {
    await adapter.list('.obsidian/plugins');
  } catch (e) {
    return null;  // 枚举失败：调用方沿用旧索引，绝不当作“配置全被删了”
  }
  await walk('.obsidian/plugins', 3);
  await walk('.obsidian/themes', 3);
  await walk('.obsidian/snippets', 1);
  return out;
}

function abToBase64(ab) {
  const u8 = new Uint8Array(ab);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
  }
  return btoa(s);
}

function base64ToAb(b64) {
  const s = atob(String(b64));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

// 同一个文件的写操作串行化：索引文件较大，并发 write 可能写坏 JSON
const writeChains = new Map();

// 切换显示语言会让 Obsidian 立即重启渲染进程。若此刻正在覆盖 2MB 的索引文件，
// 磁盘上会留下半截 JSON，下次启动只能重建 1.7 万文件索引并把界面拖死。
// 因此先写 .tmp 再原子替换，且允许从残留的 .tmp 读回。
async function writeJsonFile(adapter, path, obj) {
  const text = JSON.stringify(obj);
  const prev = writeChains.get(path) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    if (typeof adapter.rename === 'function') {
      try {
        await adapter.write(path + '.tmp', text);
        try { await adapter.remove(path); } catch (e) { /* 目标不存在 */ }
        await adapter.rename(path + '.tmp', path);
        return;
      } catch (e) { /* 不支持原子替换时退回直接写 */ }
    }
    await adapter.write(path, text);
  });
  writeChains.set(path, job);
  try { await job; }
  finally { if (writeChains.get(path) === job) writeChains.delete(path); }
}

async function readJsonFile(adapter, path) {
  // 主文件可能是上一次重启留下的半截 JSON，此时用原子写残留的 .tmp 兜底
  for (const p of [path, path + '.tmp']) {
    let text = '';
    try { text = await adapter.read(p); } catch (e) { continue; }
    if (!text) continue;
    try { return JSON.parse(text); } catch (e) { /* 半写，继续找下一份 */ }
  }
  return null;
}

function isTextPath(path) {
  const dot = String(path).lastIndexOf('.');
  return dot > 0 && TEXT_EXT.has(String(path).slice(dot).toLowerCase());
}

// 只替换真正变化的那一段（按行的公共前后缀裁剪）。
// 整篇 setValue 会让编辑器重新排版、滚动跳回顶部；局部替换能被 CodeMirror 的滚动锚点接住。
// 返回被替换的行区间（0 基），用于给同步进来的内容加一次高亮动效。
function applyTextToEditor(ed, text) {
  const oldText = ed.getValue();
  if (oldText === text) return null;
  const oldLines = oldText.split('\n');
  const newLines = text.split('\n');
  let s = 0;
  while (s < oldLines.length && s < newLines.length && oldLines[s] === newLines[s]) s++;
  let eo = oldLines.length - 1;
  let en = newLines.length - 1;
  while (eo >= s && en >= s && oldLines[eo] === newLines[en]) { eo--; en--; }
  const lastOld = oldLines.length - 1;
  const rep = newLines.slice(s, en + 1);
  const range = { from: Math.min(s, Math.max(0, newLines.length - 1)), to: Math.max(s, en) };
  // 末尾追加
  if (s >= oldLines.length) {
    const pos = { line: lastOld, ch: oldLines[lastOld].length };
    const ins = (oldLines.length === 1 && oldLines[0] === '' ? '' : '\n') + rep.join('\n');
    ed.replaceRange(ins, pos, pos);
    return range;
  }
  // 删到文末：把上一行的换行也一起删掉
  if (!rep.length && eo === lastOld && s > 0) {
    ed.replaceRange('', { line: s - 1, ch: oldLines[s - 1].length }, { line: lastOld, ch: oldLines[lastOld].length });
    return { from: s - 1, to: s - 1 };
  }
  const from = { line: s, ch: 0 };
  if (eo + 1 <= lastOld) {
    ed.replaceRange(rep.length ? rep.join('\n') + '\n' : '', from, { line: eo + 1, ch: 0 });
  } else {
    ed.replaceRange(rep.join('\n'), from, { line: lastOld, ch: oldLines[lastOld].length });
  }
  return range;
}

// 阅读视图不会因为磁盘变化自己重绘，要显式让它重新渲染
function rerenderPreviews(app, path) {
  try {
    const leaves = (app.workspace.getLeavesOfType && app.workspace.getLeavesOfType('markdown')) || [];
    for (const leaf of leaves) {
      const v = leaf.view;
      if (!v || !v.file || v.file.path !== path) continue;
      const mode = typeof v.getMode === 'function' ? v.getMode() : (v.previewMode ? 'preview' : 'source');
      if (mode !== 'preview') continue;
      if (v.previewMode && typeof v.previewMode.rerender === 'function') v.previewMode.rerender(true);
    }
  } catch (e) { /* ignore */ }
}

// 打开中的笔记必须连编辑器缓冲区一起改：只写磁盘时缓冲区还是旧内容，
// 下一次自动保存就会把同步进来的文本覆盖回去（两台设备都会）。
// 阅读视图例外：那里改缓冲区不会重绘预览，必须走 vault.process 让它重新渲染。
function applyToOpenEditor(app, path, text) {
  let applied = false;
  try {
    const leaves = (app.workspace.getLeavesOfType && app.workspace.getLeavesOfType('markdown')) || [];
    for (const leaf of leaves) {
      const v = leaf.view;
      if (!v || !v.file || v.file.path !== path) continue;
      const mode = typeof v.getMode === 'function' ? v.getMode() : (v.previewMode ? 'preview' : 'source');
      if (mode === 'preview') continue;
      const ed = v.editor;
      if (!ed || typeof ed.setValue !== 'function') continue;
      const cm = ed.cm;
      const scroller = cm && cm.scrollDOM ? cm.scrollDOM : null;
      const top = scroller ? scroller.scrollTop : 0;
      applyTextToEditor(ed, text);
      // 替换后有些版本会重排并丢掉滚动位置，这里当场对齐一次，再补一帧
      if (scroller) {
        const fix = () => {
          try { if (Math.abs(scroller.scrollTop - top) > 2) scroller.scrollTop = top; } catch (e) { /* ignore */ }
        };
        fix();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fix);
      }
      applied = true;
    }
  } catch (e) { /* ignore */ }
  return applied;
}

function openEditorValue(app, path) {  try {
    const leaves = (app.workspace.getLeavesOfType && app.workspace.getLeavesOfType('markdown')) || [];
    for (const leaf of leaves) {
      const v = leaf.view;
      if (!v || !v.file || v.file.path !== path) continue;
      const ed = v.editor;
      if (ed && typeof ed.getValue === 'function') return ed.getValue();
    }
  } catch (e) { /* ignore */ }
  return null;
}

function openEditorPathSet(app) {  const set = new Set();
  try {
    const leaves = (app.workspace.getLeavesOfType && app.workspace.getLeavesOfType('markdown')) || [];
    for (const leaf of leaves) {
      const v = leaf.view;
      if (v && v.file && v.file.path) set.add(v.file.path);
    }
  } catch (e) { /* ignore */ }
  return set;
}

function scrollerEls(app, path) {
  const out = [];
  const seen = new Set();
  try {
    const leaves = (app.workspace.getLeavesOfType && app.workspace.getLeavesOfType('markdown')) || [];
    for (const leaf of leaves) {
      const v = leaf.view;
      if (!v || !v.file || v.file.path !== path) continue;
      const push = (el) => { if (el && !seen.has(el)) { seen.add(el); out.push(el); } };
      const cm = v.editor && v.editor.cm;
      push(cm && cm.scrollDOM);
      const root = v.containerEl;
      if (root && root.querySelectorAll) {
        for (const el of root.querySelectorAll('.cm-scroller, .markdown-preview-view')) push(el);
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

function captureScroll(app, path) {
  const els = scrollerEls(app, path);
  return { path, tops: els.map((el) => el.scrollTop) };
}

function restoreScroll(app, st) {
  if (!st) return;
  // 视图可能被重建，DOM 已经换过，所以每次还原都重新查一遍元素
  const els = scrollerEls(app, st.path);
  const base = st.tops.length ? st.tops[0] : 0;
  els.forEach((el, i) => {
    const top = st.tops[i] != null ? st.tops[i] : base;
    try { if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top; } catch (e) { /* ignore */ }
  });
}

async function writeViaVault(app, path, ab) {
  const af = app.vault.getAbstractFileByPath(path);
  if (af && !af.children && isTextPath(path)) {
    const text = new TextDecoder('utf-8').decode(ab);
    if (applyToOpenEditor(app, path, text)) {
      // 缓冲区已经是最新内容，交给 Obsidian 自己保存。
      // 这里绝不能再 write 一次：那会让视图整体重载，滚动条跳回顶部。
      // 万一没存下去，pull() 会因为“磁盘没确认”而本轮不记状态，下一轮重新来。
      rerenderPreviews(app, path);
      return;
    }
    // 阅读视图 / 没有编辑器：只能重新渲染，滚动位置靠还原兜住
    const scrollState = captureScroll(app, path);
    const restore = () => restoreScroll(app, scrollState);
    if (typeof app.vault.process === 'function') {
      try {
        await withTimeout(app.vault.process(af, () => text), 30000, tr('task.update', path));
        rerenderPreviews(app, path);
        restore();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
        setTimeout(restore, 120);
        setTimeout(restore, 360);
        return;
      } catch (e) { /* 退回直接写盘 */ }
    }
  }
  await writeFileBytes(app, path, ab);
  if (isTextPath(path)) rerenderPreviews(app, path);
}

// 轻量诊断日志：内存缓冲 + 节流落盘，避免手机端每次状态变化都读写文件
let dbgBuffer = [];
let dbgTimer = null;
let LAT_LOGGED = 0;

// 端到端耗时：只记笔记类文件，单次运行最多 200 行，避免刷爆日志
function latLog(app, kind, path, ms) {
  if (!path || path.startsWith('.obsidian/')) return;
  if (LAT_LOGGED >= 200) return;
  LAT_LOGGED++;
  dbg(app, '[耗时] ' + kind + ' ' + path + ' ' + Math.max(0, Math.round(ms)) + 'ms');
}

async function dbg(app, msg) {
  try {
    dbgBuffer.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
    if (dbgBuffer.length > 300) dbgBuffer = dbgBuffer.slice(-300);
    if (dbgTimer) return;
    dbgTimer = setTimeout(async () => {
      dbgTimer = null;
      const lines = dbgBuffer;
      dbgBuffer = [];
      if (!lines.length) return;
      try {
        const dir = '.obsidian/plugins/lan-sync';
        let cur = '';
        try { cur = await app.vault.adapter.read(dir + '/debug.log'); } catch (e) { cur = ''; }
        const tail = cur.split('\n').slice(-300).join('\n');
        await app.vault.adapter.write(dir + '/debug.log', (tail + '\n' + lines.join('\n')).trim());
      } catch (e) { /* ignore */ }
    }, 1500);
  } catch (e) { /* ignore */ }
}

/* ============================ 网络 ============================ */

function baseUrl(ep) {
  return 'http://' + ep.host + ':' + ep.port;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({ cache: 'no-store' }, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function httpError(code) {
  const e = new Error('HTTP ' + code);
  e.isHttp = true;
  e.status = code;
  e.isUnauthorized = code === 401;
  return e;
}

// JSON：优先 fetch（可超时/可控），失败退回 requestUrl（不受 CORS、CSP 限制）
async function httpJson(url, opts, ms) {
  const o = opts || {};
  try {
    const res = await fetchWithTimeout(url, { method: o.method || 'GET', body: o.body, headers: o.headers }, ms || 20000);
    if (!res.ok) throw httpError(res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err && err.isHttp) throw err;
    const req = { url, method: o.method || 'GET', throw: false };
    if (o.body !== undefined) { req.body = o.body; req.contentType = 'application/octet-stream'; }
    if (o.headers) req.headers = o.headers;  // requestUrl 兜底也必须带令牌
    const res = await withTimeout(requestUrl(req), 45000, tr('task.request', url));
    if (res.status >= 400) throw httpError(res.status);
    if (res.json) return res.json;
    return res.text ? JSON.parse(res.text) : {};
  }
}

async function httpBinary(url, ms, headers) {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, ms || 60000);
    if (!res.ok) throw httpError(res.status);
    return await res.arrayBuffer();
  } catch (err) {
    if (err && err.isHttp) throw err;
    const req = { url, method: 'GET', throw: false };
    if (headers) req.headers = headers;
    const res = await withTimeout(requestUrl(req), 120000, tr('task.download', url));
    if (res.status >= 400) throw httpError(res.status);
    return res.arrayBuffer;
  }
}

async function httpPutBinary(url, ab, ms, headers) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      body: ab,
      headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, headers || {}),
    }, ms || 60000);
    if (!res.ok) throw httpError(res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err && err.isHttp) throw err;
    const req = { url, method: 'PUT', body: ab, contentType: 'application/octet-stream', throw: false };
    if (headers) req.headers = headers;
    const res = await withTimeout(requestUrl(req), 120000, tr('task.upload', url));
    if (res.status >= 400) throw httpError(res.status);
    if (res.json) return res.json;
    return res.text ? JSON.parse(res.text) : {};
  }
}

/* ============================ 零输入配对（电脑端弹窗） ============================ */

class PairModal extends Modal {
  constructor(app, plugin, req, decide) {
    super(app);
    this.plugin = plugin;
    this.req = req;
    this.decide = decide;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: tr('pair.title') });
    const p = contentEl.createEl('p');
    p.style.whiteSpace = 'pre-wrap';
    p.setText(tr('pair.body', this.req.name, this.req.ip, new Date(this.req.at).toLocaleString()));
    const row = contentEl.createDiv();
    row.style.display = 'flex';
    row.style.gap = '10px';
    row.style.marginTop = '16px';
    const ok = row.createEl('button', { text: tr('pair.allow'), cls: 'mod-cta' });
    ok.onclick = () => { this.decide(true); this.close(); };
    const no = row.createEl('button', { text: tr('pair.reject') });
    no.onclick = () => { this.decide(false); this.close(); };
  }

  onClose() {
    this.contentEl.empty();
    const s = this.plugin.server;
    if (s) s.onPairModalClosed();
  }
}

/* ============================ 发现（零配置） ============================ */

// 手机端 WebView 常拦截指向局域网的明文 fetch（CORS / 混合内容 / 虚拟网卡），
// 但 Obsidian 原生 requestUrl 不受限制。一旦确认 fetch 通道不可用，后续统一走原生请求。
let nativeOnly = false;

function pingUrl(host, port) {
  return 'http://' + host + ':' + port + API + '/ping';
}

function pingResult(j, host, port) {
  return (j && j.app === APP_ID) ? { host, port, vault: j.vault } : null;
}

async function probeViaFetch(host, port, ms) {
  const res = await fetchWithTimeout(pingUrl(host, port), { method: 'GET' }, ms || 700);
  if (!res.ok) return null;
  return pingResult(await res.json(), host, port);
}

async function probeViaRequestUrl(host, port, ms) {
  const res = await withTimeout(
    requestUrl({ url: pingUrl(host, port), method: 'GET', throw: false }),
    ms || 2000, tr('task.probe', host)
  );
  if (res.status !== 200) return null;
  let j = res.json;
  if (!j && res.text) { try { j = JSON.parse(res.text); } catch (e) { return null; } }
  return pingResult(j, host, port);
}

async function probe(host, port, ms) {
  const fast = ms || 700;
  if (!nativeOnly) {
    try {
      return await probeViaFetch(host, port, fast);
    } catch (e) {
      // 超时只说明该主机没有响应；其它错误说明整个 fetch 通道被拦
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return null;
      nativeOnly = true;
    }
  }
  try { return await probeViaRequestUrl(host, port, Math.max(1500, fast)); }
  catch (e) { return null; }
}

// WebRTC 取本机局域网 IP（手机端唯一不依赖插件权限的手段）
async function localIps() {
  try {
    if (typeof RTCPeerConnection === 'undefined') return [];
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('probe');
    const ips = new Set();
    const gathered = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      setTimeout(finish, 1500);
      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish();
        const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate || '');
        if (m && m[1] !== '0.0.0.0') ips.add(m[1]);
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered;
    try { pc.close(); } catch (e) { /* ignore */ }
    return [...ips].filter((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  } catch (e) {
    return [];
  }
}

const COMMON_PREFIXES = ['192.168.1', '192.168.0', '192.168.10', '192.168.31', '192.168.2', '10.0.0', '192.168.123'];

function prefixesFor(ips) {
  const list = [];
  const seen = new Set();
  const push = (p) => { if (!seen.has(p)) { seen.add(p); list.push(p); } };
  for (const ip of ips) {
    const parts = ip.split('.');
    if (parts.length === 4) push(parts.slice(0, 3).join('.'));
  }
  COMMON_PREFIXES.forEach(push);
  return list;
}

const CANDIDATE_PORTS = [];
for (let i = 0; i < PORT_COUNT; i++) CANDIDATE_PORTS.push(BASE_PORT + i);

async function scanSubnet(prefix, port) {
  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(prefix + '.' + i);
  for (let i = 0; i < hosts.length; i += 48) {
    const batch = [];
    for (let j = i; j < Math.min(i + 48, hosts.length); j++) batch.push(probe(hosts[j], port));
    const found = (await Promise.all(batch)).find(Boolean);
    if (found) return found;
  }
  return null;
}

async function findServer(cached, onProgress) {
  if (cached && cached.host) {
    const ports = [];
    if (cached.port) ports.push(cached.port);
    for (const p of CANDIDATE_PORTS) if (!ports.includes(p)) ports.push(p);
    // 缓存地址先用原生通道直连：手机 WebView 的 fetch 可能整体不可用
    for (const port of ports) {
      let hit = null;
      try { hit = await probeViaRequestUrl(cached.host, port, 2500); } catch (e) { /* 继续 */ }
      if (hit) return hit;
      hit = await probe(cached.host, port);
      if (hit) return hit;
    }
  }

  const ips = await localIps();
  const prefixes = prefixesFor(ips);
  const primary = prefixes.slice(0, Math.max(1, ips.length));
  // WebRTC 可能只给出虚拟网卡网段（如 172.19.0.x），缓存所在网段必须优先
  const hot = [];
  if (cached && cached.host && /^\d+\.\d+\.\d+\.\d+$/.test(cached.host)) {
    hot.push(cached.host.split('.').slice(0, 3).join('.'));
  }
  for (const p of primary) if (!hot.includes(p)) hot.push(p);

  for (const pre of hot) {
    for (const port of CANDIDATE_PORTS) {
      if (onProgress) onProgress(pre);
      const hit = await scanSubnet(pre, port);
      if (hit) return hit;
    }
  }
  for (const pre of prefixes) {
    if (hot.includes(pre)) continue;
    if (onProgress) onProgress(pre);
    const hit = await scanSubnet(pre, BASE_PORT);
    if (hit) return hit;
  }

  // fetch 通道全部超时（而非被拦）时，再用原生 requestUrl 兜底扫最可能的两个网段
  if (!nativeOnly) {
    for (const pre of hot.slice(0, 2)) {
      if (onProgress) onProgress(pre);
      const hosts = [];
      for (let i = 1; i <= 254; i++) hosts.push(pre + '.' + i);
      for (let i = 0; i < hosts.length; i += 16) {
        const batch = hosts.slice(i, i + 16).map((h) => probeViaRequestUrl(h, BASE_PORT, 1200).catch(() => null));
        const found = (await Promise.all(batch)).find(Boolean);
        if (found) return found;
      }
    }
  }
  return null;
}

/* ============================ 服务端（电脑） ============================ */

class SyncServer {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.files = new Map();      // path -> {hash,size,mtime}，index.json 的内存镜像
    this.hashCache = new Map();  // path -> {size,mtime,hash}，与 files 同源，避免重复读盘
    this.rev = 0;
    this.log = [];
    this.ready = false;
    this.port = 0;
    this.httpServer = null;
    this.pending = new Set();
    this.flushTimer = null;
    this.indexTimer = null;
    this.scanTimer = null;
    this.watchTimer = null;
    this.indexDirty = false;
    this.indexWritten = false;
    this.lastIndexWrite = 0;
    this.scanning = false;
    this.vaultSeen = false;
    this.stopped = false;
    this.lastClient = 0;
    this.lastClientAddr = '';
    this.pendingPairs = new Map();  // deviceId -> {name,ip,at,state,token}
    this.pairModal = null;
    this.statusTimer = null;
    this.cfgTimer = null;
    this.cfgCount = 0;
    this.bases = new Map();      // path -> hash：最后一次与客户端交换过的内容，用于三方合并
    this.baseDirty = false;
    this.baseTimer = null;
  }

  dir() {
    return (this.plugin.manifest && this.plugin.manifest.dir) || '.obsidian/plugins/lan-sync';
  }

  cachePath() { return this.dir() + '/hash-cache.json'; }  // 旧版缓存：仅用于一次性迁移
  indexPath() { return this.dir() + '/index.json'; }

  async start() {
    const restored = await this.loadIndex();
    await this.loadBases();
    const ok = await this.listen();
    if (!ok) {
      this.plugin.setStatus(tr('status.serverPortTaken'), 'error');
      return;
    }
    this.registerEvents();
    // 外部（资源管理器）删除不一定触发 vault 事件，1 分钟做一次纯内存元数据对账兜底
    this.scanTimer = setInterval(() => { this.rescan().catch(() => {}); }, 60000);
    // .obsidian 里的配置不触发 vault 事件，单独用更短的周期轮询
    this.cfgTimer = setInterval(() => { this.scanConfigOnly().catch(() => {}); }, 12000);

    if (restored) {
      // 索引文件已存在：只做一次 stat 对比，仅元数据变化的文件才读盘哈希
      this.plugin.setStatus(tr('status.checkingIndex'), 'syncing');
      const r = await this.scanDiff({ quiet: true });
      this.markReady();
      if (r && r.suspect) this.watchVault();
    } else {
      // 首次运行才全量建索引，之后一律由 index.json + 事件/定时增量接管
      this.plugin.setStatus(tr('status.buildingIndex'), 'syncing');
      this.buildIndex()
        .then(() => this.markReady())
        .catch((e) => this.plugin.setStatus(tr('status.indexFailed', e.message || e), 'error'));
    }
  }

  markReady() {
    this.ready = true;
    this.updateStatus();
    this.saveIndexNow().catch(() => {});
    if (this.pending.size) this.flushPending().catch(() => {});
    setTimeout(() => {
      if (this.stopped) return;
      this.pruneBlobs().catch(() => {});
      this.pruneHistory().catch(() => {});
    }, 6000);
  }

  stop() {
    this.stopped = true;
    if (this.pairModal) { try { this.pairModal.close(); } catch (e) { /* ignore */ } this.pairModal = null; }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.cfgTimer) clearInterval(this.cfgTimer);
    if (this.baseTimer) clearTimeout(this.baseTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.httpServer) {
      try { this.httpServer.close(); } catch (e) { /* ignore */ }
      this.httpServer = null;
    }
    this.saveIndexNow().catch(() => {});
  }

  updateStatus() {
    if (!this.ready) return;
    const n = this.pendingList().length;
    const tail = n ? tr('status.pendingTail', n) : '';
    this.plugin.setFileCount(this.files.size);
    this.plugin.setStatus(tr('status.ready', this.port, this.files.size, tail), n ? 'pending' : 'ready');
  }

  // 建索引/批量对账时会连续改动很多文件，合并成一次状态刷新
  scheduleStatus() {
    if (this.statusTimer || this.stopped) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.updateStatus();
    }, 400);
  }

  async listen() {
    const http = require('http');
    for (let i = 0; i < PORT_COUNT; i++) {
      const port = BASE_PORT + i;
      const srv = http.createServer((req, res) => {
        this.onRequest(req, res).catch((e) => {
          console.error('[lan-sync] request failed', e);
          try {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end('{"error":"internal"}');
          } catch (err) { /* ignore */ }
        });
      });
      const ok = await new Promise((resolve) => {
        let settled = false;
        // 常驻 error handler：运行期端口/连接错误不能被当成未处理异常抛给渲染进程
        const onError = (err) => {
          if (!settled) { settled = true; resolve(false); return; }
          console.error('[lan-sync] server error', err);
        };
        srv.on('error', onError);
        srv.listen(port, '0.0.0.0', () => { if (!settled) { settled = true; resolve(true); } });
      });
      if (ok) {
        this.httpServer = srv;
        this.port = port;
        return true;
      }
      try { srv.close(); } catch (e) { /* ignore */ }
    }
    return false;
  }

  /* ---------- 独立索引文件 ---------- */

  // index.json: {version,vault,rev,savedAt,log,files:{path:[hash,size,mtime]}}
  async loadIndex() {
    const adapter = this.app.vault.adapter;
    try {
      const obj = await readJsonFile(adapter, this.indexPath());
      if (obj && obj.version === INDEX_VERSION && obj.vault === this.plugin.vaultId && obj.files) {
        let n = 0;
        for (const [p, v] of Object.entries(obj.files)) {
          if (shouldIgnore(p) || !Array.isArray(v) || v.length !== 3) continue;
          const meta = { hash: v[0], size: v[1], mtime: v[2] };
          this.files.set(p, meta);
          this.hashCache.set(p, meta);
          if (++n % 1000 === 0) await sleep(0);  // 大索引分批让出主线程，避免启动白屏
        }
        this.rev = obj.rev || 0;
        this.savedRev = this.rev;
        this.log = Array.isArray(obj.log) ? obj.log.slice(-PERSIST_LOG) : [];
        this.indexWritten = true;
        this.indexDirty = false;
        this.lastIndexWrite = obj.savedAt || Date.now();
        if (this.files.size) {
          dbg(this.app, '从 index.json 恢复 ' + this.files.size + ' 个文件 rev=' + this.rev);
          return true;
        }
      }
    } catch (e) { /* 无索引 / 版本不符 / 换了库 → 重新建 */ }

    // 一次性迁移旧版 hash-cache.json（[size,mtime,hash] 已足够构成索引）
    try {
      const obj = await readJsonFile(adapter, this.cachePath());
      let n = 0;
      for (const [p, v] of Object.entries(obj || {})) {
        if (shouldIgnore(p) || !Array.isArray(v) || v.length !== 3) continue;
        const meta = { size: v[0], mtime: v[1], hash: v[2] };
        this.files.set(p, meta);
        this.hashCache.set(p, meta);
        if (++n % 1000 === 0) await sleep(0);
      }
      if (this.files.size) {
        this.saveIndex();
        dbg(this.app, '由旧缓存迁移索引 ' + this.files.size + ' 个文件');
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  saveIndex() {
    this.indexDirty = true;
    // 持续改动时也要有兜底写盘，不能让防抖一直被重置
    if (this.indexTimer) {
      if (Date.now() - this.lastIndexWrite > 15000) {
        clearTimeout(this.indexTimer);
        this.indexTimer = null;
        this.saveIndexNow().catch(() => {});
      }
      return;
    }
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.saveIndexNow().catch(() => {});
    }, 4000);
  }

  async saveIndexNow() {
    if (this.indexWritten && !this.indexDirty && this.savedRev === this.rev) return;
    const obj = {
      version: INDEX_VERSION,
      vault: this.plugin.vaultId,
      rev: this.rev,
      savedAt: Date.now(),
      log: this.log.slice(-PERSIST_LOG),
      files: {},
    };
    for (const [p, m] of this.files) obj.files[p] = [m.hash, m.size, m.mtime];
    try {
      await writeJsonFile(this.app.vault.adapter, this.indexPath(), obj);
      this.indexDirty = false;
      this.indexWritten = true;
      this.savedRev = this.rev;
      this.lastIndexWrite = Date.now();
    } catch (e) { /* ignore */ }
  }

  async hashFor(path, size, mtime) {
    const c = this.hashCache.get(path);
    if (c && c.size === size && c.mtime === mtime) return c.hash;
    const ab = await readFileBytes(this.app, path);
    const hash = await hashBytes(ab);
    this.hashCache.set(path, { size, mtime, hash });
    return hash;
  }

  /* ---------- 三方合并：基准内容库 + 冲突历史 ---------- */

  baseMapPath() { return this.dir() + '/base.json'; }
  blobDir() { return this.dir() + '/base'; }
  blobPath(hash) { return this.blobDir() + '/' + hash; }
  historyDir() { return this.dir() + '/history'; }

  async loadBases() {
    try {
      const obj = await readJsonFile(this.app.vault.adapter, this.baseMapPath());
      for (const [p, h] of Object.entries((obj && obj.map) || {})) {
        if (!shouldIgnore(p) && typeof h === 'string' && h) this.bases.set(p, h);
      }
    } catch (e) { /* 首次运行 */ }
  }

  saveBases() {
    this.baseDirty = true;
    if (this.baseTimer) return;
    this.baseTimer = setTimeout(() => {
      this.baseTimer = null;
      if (!this.baseDirty) return;
      this.baseDirty = false;
      const map = {};
      for (const [p, h] of this.bases) map[p] = h;
      writeJsonFile(this.app.vault.adapter, this.baseMapPath(), { version: 1, map }).catch(() => {});
    }, 2000);
  }

  // 记录“两端最后一次共同持有的内容”，三方合并就靠它当基准。
  // 只在给客户端发文件、收客户端文件时调用，不会去动用户没在同步的文件。
  async rememberBase(path, ab) {
    if (!ab || !MERGE_EXT.has(extOf(path)) || ab.byteLength > MERGE_MAX) return '';
    const hash = await hashBytes(ab);
    if (this.bases.get(path) === hash) return hash;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.blobPath(hash)))) await adapter.writeBinary(this.blobPath(hash), ab);
    } catch (e) { /* 存不下就不存，退化成 LWW */ }
    this.bases.set(path, hash);
    this.saveBases();
    return hash;
  }

  async baseContent(hash) {
    if (!hash) return null;
    try { return await this.app.vault.adapter.readBinary(this.blobPath(hash)); } catch (e) { return null; }
  }

  async pruneBlobs() {
    const adapter = this.app.vault.adapter;
    let list = null;
    try { list = await adapter.list(this.blobDir()); } catch (e) { return; }
    const keep = new Set(this.bases.values());
    for (const f of (list && list.files) || []) {
      const h = f.slice(f.lastIndexOf('/') + 1);
      if (!keep.has(h)) { try { await adapter.remove(f); } catch (e) { /* ignore */ } }
    }
  }

  // 冲突落败方进 history/，不再以 xxx.conflict-*.md 的形式污染笔记目录
  async saveHistory(path, ab, tag) {
    if (!ab || !ab.byteLength) return;
    try {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const safe = String(path).replace(/[\\/:*?"<>|]/g, '_').slice(-120);
      const dir = this.historyDir() + '/' + stamp.slice(0, 8);
      const name = stamp + '-' + String(tag || 'conflict').replace(/[^\w.-]+/g, '_').slice(0, 24) + '-' + safe;
      await writeFileBytes(this.app, dir + '/' + name, ab);
    } catch (e) { /* 历史只是兜底，失败不影响同步 */ }
  }

  async pruneHistory() {
    const adapter = this.app.vault.adapter;
    const all = [];
    let root = null;
    try { root = await adapter.list(this.historyDir()); } catch (e) { return; }
    for (const day of (root && root.folders) || []) {
      let list = null;
      try { list = await adapter.list(day); } catch (e) { continue; }
      for (const f of (list && list.files) || []) all.push(f);
    }
    if (all.length <= HISTORY_KEEP) return;
    all.sort();
    for (const f of all.slice(0, all.length - HISTORY_KEEP)) {
      try { await adapter.remove(f); } catch (e) { /* ignore */ }
    }
  }

  async writeMerged(path, ab) {
    await writeViaVault(this.app, path, ab);
    const st = await statMeta(this.app, path);
    const hash = await hashBytes(ab);
    this.setEntry(path, { hash, size: ab.byteLength, mtime: st && st.mtime ? st.mtime : Date.now() }, true);
    return hash;
  }

  // 电脑端是唯一合并方：两端同时改同一文件时，由这里决定最终内容，
  // 客户端只接收结果，保证两边拿到逐字节相同的文本。
  async mergeFile(rawPath, j) {
    const p = String(rawPath || '');
    const ext = extOf(p);
    const name = String(j.deviceName || tr('device.mobile')).slice(0, 40);
    const localAb = j.encoding === 'base64'
      ? base64ToAb(j.data || '')
      : new TextEncoder().encode(String(j.data == null ? '' : j.data));
    const localHash = await hashBytes(localAb);

    let remoteAb = null;
    try { remoteAb = await readFileBytes(this.app, p); } catch (e) { remoteAb = null; }
    const remoteHash = remoteAb ? await hashBytes(remoteAb) : '';

    if (remoteAb && remoteHash === localHash) return { hash: remoteHash, same: true };

    if (!remoteAb) {
      const hash = await this.writeMerged(p, localAb);
      await this.rememberBase(p, localAb);
      return { hash, same: true };
    }

    const baseAb = await this.baseContent(j.baseHash ? String(j.baseHash) : '');
    const canMerge = !!baseAb && MERGE_EXT.has(ext) && localAb.byteLength <= MERGE_MAX && remoteAb.byteLength <= MERGE_MAX;

    if (!canMerge) {
      // 没有基准或不是文本：时间新者胜，落败方进历史，仍在同一个路径上，不产生副本
      const remoteMeta = this.files.get(p) || {};
      const remoteAt = remoteMeta.mtime || 0;
      const localAt = Number(j.mtime) || 0;
      const localWins = localAt > remoteAt;
      const keep = localWins ? localAb : remoteAb;
      const loser = localWins ? remoteAb : localAb;
      await this.saveHistory(p, loser, localWins ? tr('device.desktop') : name);
      let hash = remoteHash;
      if (localWins) hash = await this.writeMerged(p, keep);
      await this.rememberBase(p, keep);
      const out = { hash, winner: localWins ? 'local' : 'remote' };
      if (!localWins) {
        if (MERGE_EXT.has(ext)) {
          out.encoding = 'text';
          out.data = new TextDecoder('utf-8').decode(keep);
        } else {
          out.encoding = 'base64';
          out.data = abToBase64(keep);
        }
      }
      return out;
    }

    const dec = new TextDecoder('utf-8');
    const info = {
      ext,
      localName: name,
      remoteName: tr('device.desktop'),
      remoteAt: (this.files.get(p) || {}).mtime || Date.now(),
    };
    const r = merge3(dec.decode(baseAb), dec.decode(localAb), dec.decode(remoteAb), info);
    const outAb = new TextEncoder().encode(r.text);
    const outHash = await hashBytes(outAb);
    await this.saveHistory(p, remoteAb, tr('device.desktop'));
    if (r.conflicts) await this.saveHistory(p, localAb, name);
    if (outHash !== remoteHash || !this.files.has(p)) await this.writeMerged(p, outAb);
    await this.rememberBase(p, outAb);
    return { hash: outHash, encoding: 'text', data: r.text, conflicts: r.conflicts };
  }

  // 仅在没有任何可用索引文件时执行一次
  async buildIndex() {
    const next = new Map();
    const list = this.app.vault.getFiles();
    let n = 0;
    for (const f of list) {
      if (shouldIgnore(f.path)) continue;
      const st = f.stat || {};
      const size = st.size || 0;
      const mtime = st.mtime || 0;
      let hash = null;
      try { hash = await this.hashFor(f.path, size, mtime); } catch (e) { continue; }
      next.set(f.path, { hash, size, mtime });
      if (++n % 500 === 0) {
        this.plugin.setStatus(tr('status.indexing', n, list.length), 'syncing');
        await sleep(0);
      }
    }
    await this.addConfigEntries(next);
    this.files = next;
    this.hashCache = new Map(next);
    // 首次建库不逐文件 bump rev，否则变更日志会被撑爆；客户端会走一次 reset 快照
    this.rev = (this.rev || 0) + 1;
    this.log = [];
    this.saveIndex();
  }

  // 把 .obsidian 里可移植的配置并进 next；枚举失败时沿用旧条目，避免误删
  async addConfigEntries(next) {
    const cfg = await collectConfig(this.app);
    if (!cfg || (this.cfgCount && cfg.size < Math.floor(this.cfgCount * 0.5))) {
      for (const [p, m] of this.files) if (isConfigPath(p)) next.set(p, m);
      return 0;
    }
    this.cfgCount = cfg.size;
    let hashed = 0;
    for (const [p, m] of cfg) {
      const known = this.files.get(p);
      let hash;
      if (known && known.size === m.size && known.mtime === m.mtime) hash = known.hash;
      else {
        try { hash = await this.hashFor(p, m.size, m.mtime); } catch (e) { continue; }
        hashed++;
      }
      next.set(p, { hash, size: m.size, mtime: m.mtime });
    }
    return hashed;
  }

  // 只对账 .obsidian：配置改动不触发 vault 事件，靠这个短周期轮询把 rev 推给手机
  async scanConfigOnly() {
    if (!this.ready || this.scanning) return;
    const cfg = await collectConfig(this.app);
    if (!cfg || (this.cfgCount && cfg.size < Math.floor(this.cfgCount * 0.5))) return;
    this.cfgCount = cfg.size;
    let changed = 0;
    for (const [p, m] of cfg) {
      const known = this.files.get(p);
      if (known && known.size === m.size && known.mtime === m.mtime) continue;
      let hash;
      try { hash = await this.hashFor(p, m.size, m.mtime); } catch (e) { continue; }
      this.setEntry(p, { hash, size: m.size, mtime: m.mtime }, true);
      changed++;
    }
    for (const p of [...this.files.keys()]) {
      if (isConfigPath(p) && !cfg.has(p)) { this.removeEntry(p); changed++; }
    }
    if (changed) dbg(this.app, '配置变化 ' + changed + ' 个文件');
  }

  async rescan() {
    if (!this.ready) return;
    const r = await this.scanDiff({ quiet: true });
    if (r && r.suspect) this.watchVault();
    this.updateStatus();
  }

  // 增量对账：只枚举 getFiles() 的元数据（纯内存），只有 size/mtime 变过的文件才读盘哈希
  async scanDiff(opts) {
    const quiet = !!(opts && opts.quiet);
    if (this.scanning) return null;
    this.scanning = true;
    try {
      const next = new Map();
      let hashed = 0, scanned = 0;
      for (const f of this.app.vault.getFiles()) {
        if (shouldIgnore(f.path)) continue;
        if (++scanned % 500 === 0) await sleep(0);  // 每批让出主线程，启动时不卡界面
        const st = f.stat || {};
        const size = st.size || 0;
        const mtime = st.mtime || 0;
        const known = this.files.get(f.path);
        let hash;
        if (known && known.size === size && known.mtime === mtime) hash = known.hash;
        else {
          try { hash = await this.hashFor(f.path, size, mtime); } catch (e) { continue; }
          hashed++;
        }
        next.set(f.path, { hash, size, mtime });
      }
      hashed += await this.addConfigEntries(next);
      // 库还没扫完时 getFiles() 会缺一大半，绝不能当成“用户删光了”
      if (countVault(next) > 0) this.vaultSeen = true;
      const suspect = (this.files.size > 0 && !this.vaultSeen && countVault(next) === 0)
        || (this.files.size > 20 && countVault(next) < Math.floor(countVault(this.files) * 0.9));
      let applied = 0;
      for (const [path, meta] of next) {
        if (!sameMeta(this.files.get(path), meta)) this.setEntry(path, meta, true);
        if (++applied % 500 === 0) await sleep(0);
      }
      if (!suspect) {
        let checked = 0;
        for (const path of [...this.files.keys()]) {
          if (!next.has(path)) this.removeEntry(path);
          if (++checked % 500 === 0) await sleep(0);
        }
      }
      if (!quiet && hashed) this.plugin.setStatus(tr('status.rehash', hashed), 'syncing');
      return { hashed, suspect };
    } finally {
      this.scanning = false;
    }
  }

  // 库扫描完成前的轻量等待：只比较文件数，不再反复全量 scanDiff
  watchVault() {
    if (this.watchTimer) return;
    let tries = 0;
    const check = () => {
      this.watchTimer = null;
      if (this.stopped) return;
      const n = this.app.vault.getFiles().length;
      if (n >= Math.max(1, Math.floor(this.files.size * 0.9))) {
        this.scanDiff({ quiet: true }).catch(() => {});
        return;
      }
      if (++tries > 100) { this.vaultSeen = true; return; } // 5 分钟后不再阻止删除
      this.watchTimer = setTimeout(check, 3000);
    };
    this.watchTimer = setTimeout(check, 3000);
  }

  setEntry(path, meta, bump) {
    const old = this.files.get(path);
    this.files.set(path, meta);
    this.scheduleStatus();
    this.hashCache.set(path, { size: meta.size, mtime: meta.mtime, hash: meta.hash });
    this.saveIndex();
    if (!bump) return;
    if (old && old.hash === meta.hash) return; // 内容没变，不打扰手机
    this.bumpRev({ path, hash: meta.hash, size: meta.size, mtime: meta.mtime });
  }

  removeEntry(path) {
    if (!this.files.has(path)) return;
    this.files.delete(path);
    this.scheduleStatus();
    this.hashCache.delete(path);
    if (this.bases.delete(path)) this.saveBases();
    this.saveIndex();
    this.bumpRev({ path, deleted: true });
  }

  bumpRev(change) {
    this.rev++;
    this.log.push(change);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    // rev 与最近变更日志随索引一起落盘，电脑重启后手机仍能接着增量同步
    this.saveIndex();
  }

  registerEvents() {
    const v = this.app.vault;
    this.plugin.registerEvent(v.on('modify', (f) => this.queue(f.path)));
    this.plugin.registerEvent(v.on('create', (f) => this.queue(f.path)));
    this.plugin.registerEvent(v.on('delete', (f) => this.onDelete(f.path)));
    this.plugin.registerEvent(v.on('rename', (f, oldPath) => {
      this.onDelete(oldPath);
      if (f && f.children) this.rescan().catch(() => {});
      else if (f) this.queue(f.path);
    }));
  }

  queue(path) {
    if (shouldIgnore(path)) return;
    this.pending.add(path);
    // 索引校验/首次建库期间先攒着，ready 后由 markReady 统一补哈希，不丢编辑
    if (!this.ready) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending().catch(() => {});
    }, 150);
  }

  async flushPending() {
    const paths = [...this.pending];
    this.pending.clear();
    let n = 0;
    for (const path of paths) {
      if (++n % 200 === 0) await sleep(0);
      const af = this.app.vault.getAbstractFileByPath(path);
      if (!af || af.children) continue;
      const st = af.stat || {};
      let hash = null;
      try { hash = await this.hashFor(path, st.size || 0, st.mtime || 0); } catch (e) { continue; }
      const old = this.files.get(path);
      this.setEntry(path, { hash, size: st.size || 0, mtime: st.mtime || 0 }, true);
      if (!old || old.hash !== hash) latLog(this.app, '本机写入→索引', path, Date.now() - (st.mtime || Date.now()));
    }
  }

  onDelete(path) {
    if (shouldIgnore(path)) return;
    if (this.files.has(path)) {
      this.removeEntry(path);
      return;
    }
    let changed = false;
    for (const p of [...this.files.keys()]) {
      if (p === path || p.startsWith(path + '/')) {
        this.files.delete(p);
        this.hashCache.delete(p);
        this.bumpRev({ path: p, deleted: true });
        changed = true;
      }
    }
    if (changed) { this.saveIndex(); this.scheduleStatus(); }
  }

  /* ---------- 设备授权（零输入配对） ---------- */

  authorized(req) {
    const t = (req.headers && req.headers['x-lan-sync-token']) || '';
    if (!t) return false;
    for (const d of Object.values(this.plugin.settings.devices || {})) {
      if (d && d.token && d.token === t) { this.plugin.peerSeenAt = Date.now(); return true; }
    }
    return false;
  }

  async waitDisk(p, hash, timeout) {
    const end = Date.now() + (timeout || 1000);
    do {
      try {
        const cur = await readFileBytes(this.app, p);
        if (await hashBytes(cur) === hash) return true;
      } catch (e) { /* 还没落盘 */ }
      await sleep(100);
    } while (Date.now() < end);
    return false;
  }

  pendingList() {
    return [...this.pendingPairs.values()].filter((r) => r.state !== 'approved');
  }

  showNextPair() {
    if (this.stopped) return;
    const next = this.pendingList().find((r) => r.state === 'pending');
    if (!next) { this.updateStatus(); return; }
    this.pairModal = new PairModal(this.app, this.plugin, next, (ok) => {
      if (ok) this.approvePair(next.deviceId);
      else this.rejectPair(next.deviceId);
    });
    this.pairModal.open();
    this.updateStatus();
  }

  onPairModalClosed() {
    this.pairModal = null;
    if (!this.stopped) setTimeout(() => this.showNextPair(), 200);
  }

  approvePair(id) {
    const r = this.pendingPairs.get(id);
    if (!r) return;
    const token = uuid() + uuid();
    const s = this.plugin.settings;
    if (!s.devices) s.devices = {};
    s.devices[id] = { name: r.name, ip: r.ip, at: Date.now(), token };
    this.plugin.saveData(s).catch(() => {});
    r.state = 'approved';
    r.token = token;
    r.approvedAt = Date.now();
    dbg(this.app, '已允许设备 ' + r.name + ' ' + r.ip);
    this.plugin.setStatus(tr('status.allowed', r.name), 'ready');
    this.updateStatus();
  }

  rejectPair(id) {
    const r = this.pendingPairs.get(id);
    if (!r) return;
    r.state = 'rejected';
    dbg(this.app, '已拒绝设备 ' + r.name + ' ' + r.ip);
    this.updateStatus();
  }

  removeDevice(id) {
    const s = this.plugin.settings;
    if (!s.devices || !s.devices[id]) return;
    delete s.devices[id];
    this.plugin.saveData(s).catch(() => {});
    this.pendingPairs.delete(id);
    dbg(this.app, '已移除设备 ' + id.slice(0, 6));
    this.updateStatus();
  }

  /* ---------- HTTP ---------- */

  async onRequest(req, res) {
    const send = (code, body, type) => {
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      res.writeHead(code, {
        'Content-Type': type || 'application/json; charset=utf-8',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj));

    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { send(400, '{}'); return; }
    const path = url.pathname;

    if (req.method === 'OPTIONS') { send(204, ''); return; }

    this.lastClient = Date.now();
    this.lastClientAddr = (req.socket && req.socket.remoteAddress) || '';

    if (path === API + '/ping') {
      // 只暴露发现所需的最小信息，不再向全网广播 rev / 文件数
      json(200, { app: APP_ID, vault: this.plugin.vaultId, auth: true, ready: this.ready });
      return;
    }

    if (path === API + '/pair/request' && req.method === 'POST') {
      const ip = ((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
      try {
        const j = JSON.parse((await this.readBody(req)).toString('utf8') || '{}');
        const id = String(j.deviceId || '');
        if (!id) { json(400, { error: 'bad request' }); return; }
        // 已授权设备重新申请（换 Wi-Fi、清过缓存等）：直接下发原令牌，不用电脑再点一次
        const granted = (this.plugin.settings.devices || {})[id];
        if (granted && granted.token) {
          this.pendingPairs.set(id, {
            deviceId: id, name: granted.name || tr('device.authorized'), ip,
            at: Date.now(), state: 'approved', token: granted.token, approvedAt: Date.now(),
          });
          json(200, { ok: true });
          return;
        }
        const old = this.pendingPairs.get(id);
        if (!old || old.state === 'pending') {
          this.pendingPairs.set(id, {
            deviceId: id,
            name: String(j.name || tr('device.unknown')).slice(0, 60),
            ip, at: Date.now(), state: 'pending',
          });
        }
        json(200, { ok: true });
        if (!this.pairModal) this.showNextPair();
        else this.updateStatus();
      } catch (e) { json(400, { error: 'bad request' }); }
      return;
    }

    if (path === API + '/pair/status') {
      const id = url.searchParams.get('deviceId') || '';
      const r = this.pendingPairs.get(id);
      if (!r) { json(200, { state: 'unknown' }); return; }
      if (r.state === 'approved') {
        // 令牌只在批准后 60 秒内、且只对该 deviceId 下发
        if (Date.now() - r.approvedAt > 60000) { this.pendingPairs.delete(id); json(200, { state: 'unknown' }); return; }
        json(200, { state: 'approved', token: r.token, vault: this.plugin.vaultId });
        return;
      }
      json(200, { state: r.state });
      return;
    }

    // 其余接口一律需要已授权设备的令牌；未授权设备读不到索引，也拿不到/改不了文件
    if (!this.authorized(req)) { json(401, { error: 'unauthorized' }); return; }

    if (path === API + '/index') {
      if (!this.ready) { json(503, { ready: false }); return; }
      json(200, { rev: this.rev, files: this.snapshotRows() });
      return;
    }

    if (path === API + '/changes') {
      if (!this.ready) { json(503, { ready: false }); return; }
      const since = parseInt(url.searchParams.get('rev') || '0', 10) || 0;
      if (since === this.rev) { json(200, { rev: this.rev, changes: [] }); return; }
      const logStart = this.rev - this.log.length;
      if (since > this.rev || since < logStart) {
        json(200, { rev: this.rev, reset: true, files: this.snapshotRows() });
        return;
      }
      json(200, { rev: this.rev, changes: this.log.slice(this.log.length - (this.rev - since)) });
      return;
    }

    if (path === API + '/file' && req.method === 'GET') {
      const p = url.searchParams.get('path') || '';
      if (!p || shouldIgnore(p)) { json(403, { error: 'forbidden' }); return; }
      try {
        const ab = await readFileBytes(this.app, p);
        const meta = this.files.get(p);
        // 把文件发给手机也算一次传输，让状态点在中转期间动起来
        this.plugin.pulseFor(800);
        // 客户端拿到的内容就是它下次的基准，这里顺手记下来供三方合并用
        this.rememberBase(p, ab).catch(() => {});
        const buf = Buffer.from(ab);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.length,
          'x-hash': meta ? meta.hash : '',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      } catch (e) {
        json(404, { error: 'not found' });
      }
      return;
    }

    if (path === API + '/file' && req.method === 'PUT') {
      const p = url.searchParams.get('path') || '';
      if (!p || shouldIgnore(p)) { json(403, { error: 'forbidden' }); return; }
      try {
        const buf = await this.readBody(req);
        const ab = toArrayBuffer(buf);
        const hash = await hashBytes(ab);
        const exist = this.files.get(p);
        const sameContent = exist && exist.hash === hash;
        const onDisk = this.app.vault.getAbstractFileByPath(p) || await statMeta(this.app, p);
        // 插件代码只允许“升版本”，防止旧设备把新版本覆盖回去
        const pid = pluginIdOf(p);
        if (pid) {
          const incoming = String(req.headers['x-plugin-version'] || '');
          const cur = await readPluginVersion(this.app, pid);
          if (incoming && cur && cmpVer(incoming, cur) < 0) {
            json(200, { hash: (exist && exist.hash) || '', skipped: true });
            return;
          }
        }
        // 配置里的文本走 adapter 直写：它们不是 vault 文件，vault.process 拿不到句柄
        if (!sameContent || !onDisk) {
          this.plugin.pulseFor(800);
          await writeViaVault(this.app, p, ab);
          // 开了编辑器的情况下 writeViaVault 不重复写盘，靠 Obsidian 自己保存。
          // 这里必须确认磁盘真的变了，否则索引会记成新内容、磁盘还是旧的，
          // 下一轮扫描就把旧内容当成“本地修改”推回手机。
          let onDiskNow = await this.waitDisk(p, hash, 2000);
          if (!onDiskNow) {
            try {
              const af2 = this.app.vault.getAbstractFileByPath(p);
              if (af2 && !af2.children) await this.app.vault.modify(af2, new TextDecoder('utf-8').decode(ab));
            } catch (e) { /* ignore */ }
            onDiskNow = await this.waitDisk(p, hash, 1500);
          }
          if (onDiskNow) {
            const st = await statMeta(this.app, p);
            this.setEntry(p, { hash, size: buf.length, mtime: st && st.mtime ? st.mtime : Date.now() }, true);
          }
          this.rememberBase(p, ab).catch(() => {});
        }
        const savedAt = Number(req.headers['x-save-mtime']) || 0;
        if (savedAt) latLog(this.app, '接收 保存→落盘', p, Date.now() - savedAt);
        json(200, { hash });
      } catch (e) {
        json(500, { error: String((e && e.message) || e) });
      }
      return;
    }

    if (path === API + '/merge' && req.method === 'POST') {
      let j = null;
      try { j = JSON.parse((await this.readBody(req)).toString('utf8') || '{}'); }
      catch (e) { json(400, { error: 'bad request' }); return; }
      const p = String((j && j.path) || '');
      if (!p || shouldIgnore(p)) { json(403, { error: 'forbidden' }); return; }
      try {
        json(200, await this.mergeFile(p, j));
      } catch (e) {
        json(500, { error: String((e && e.message) || e) });
      }
      return;
    }

    if (path === API + '/delete') {
      const p = url.searchParams.get('path') || '';
      if (!p || shouldIgnore(p)) { json(403, { error: 'forbidden' }); return; }
      try {
        const af = this.app.vault.getAbstractFileByPath(p);
        if (af) {
          try { await this.app.vault.trash(af, false); } catch (e) { await this.app.vault.adapter.remove(p); }
        } else if (isConfigPath(p)) {
          await this.app.vault.adapter.remove(p);
        }
        this.onDelete(p);
        json(200, { ok: true });
      } catch (e) {
        json(500, { error: String((e && e.message) || e) });
      }
      return;
    }

    json(404, { error: 'unknown' });
  }

  snapshotRows() {
    const rows = [];
    for (const [p, m] of this.files) rows.push([p, m.hash, m.size, m.mtime]);
    return rows;
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } reject(new Error(tr('err.uploadTimeout'))); }, 120000);
      const finish = (fn) => (v) => { clearTimeout(timer); fn(v); };
      req.on('data', (c) => {
        size += c.length;
        chunks.push(c);
      });
      req.on('end', finish(() => resolve(Buffer.concat(chunks))));
      req.on('error', finish(reject));
    });
  }

  info() {
    return {
      port: this.port,
      files: this.files.size,
      ready: this.ready,
      lastClientAddr: this.lastClientAddr,
      lastClient: this.lastClient,
      pending: this.pendingList().length,
      devices: Object.keys(this.plugin.settings.devices || {}).length,
    };
  }
}

function sameMeta(a, b) {
  if (!a || !b) return false;
  return a.hash === b.hash && a.size === b.size && a.mtime === b.mtime;
}

/* ============================ 客户端（手机） ============================ */

class SyncClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.endpoint = plugin.settings.endpoint || null;
    this.remoteIndex = new Map();
    this.remoteRev = 0;
    this.haveSnapshot = false;
    this.localIndex = new Map();
    this.base = new Map();
    this.state = new Map();
    this.dirty = new Set();
    this.candidates = new Set();  // 由索引对比得出的待操作文件，取代每轮遍历全库
    this.needFull = true;         // 启动时做一次纯内存全量对账（不读盘）
    this.vaultReady = false;      // 库是否扫完：只用于避免把“还没加载”当成删除
    this.remoteVault = '';
    this.remoteDirty = false;
    this.remoteTimer = null;
    this.vaultTimer = null;
    this.fullTimer = null;
    this.busy = false;
    this.rerun = false;
    this.connected = false;
    this.discovering = false;
    this.stopped = false;
    this.stateDirty = false;
    this.stateTimer = null;
    this.tickTimer = null;
    this.retryTimer = null;
    this.tickPending = false;
    this.lastSyncAt = 0;
    this.remoteDeletes = new Set();  // 本轮收到的「电脑端删除」，用来区分手机端新建文件
    this.stats = { pulled: 0, pushed: 0, deleted: 0, conflicts: 0 };
    this.cfgCount = 0;
    this.cfgTimer = null;
    this.configDirty = true;   // 首次对账要把 .obsidian 走一遍
    this.skipPlugins = new Set();      // 本会话内因版本更旧而跳过的插件
    this.remoteVerCache = new Map();   // pluginId -> 远端 manifest.version
    this.reloadNoticeAt = 0;
    this.opSeen = new Map();           // 诊断用：同一文件被反复传输时会写日志
    this.justWrote = new Map();        // 刚写入的远端内容，用来拦住写盘延迟导致的错误回推
    this.seenAt = new Map();           // 远端变更被感知的时间，用于统计“通知 → 落盘”耗时
    this.landRetry = new Map();        // 连续几轮磁盘没落稳，超过阈值才强制写盘
    this.lastSweep = 0;
  }

  // 增量变更一旦漏掉就再也不会重试，所以定期把两边索引整体比对一次，把差异补成候选
  sweepRemote() {
    const now = Date.now();
    if (now - this.lastSweep < 30000) return;
    this.lastSweep = now;
    for (const [p, jw] of this.justWrote) if (now - jw.at > 60000) this.justWrote.delete(p);
    let n = 0;
    for (const [p, r] of this.remoteIndex) {
      if (shouldIgnore(p)) continue;
      const l = this.localIndex.get(p);
      if (!l || l.hash !== r.hash) { this.candidates.add(p); n++; }
    }
    for (const [p] of this.localIndex) {
      if (shouldIgnore(p)) continue;
      if (!this.remoteIndex.has(p)) { this.candidates.add(p); n++; }
    }
    if (n) dbg(this.app, 'sweep: 补入 ' + n + ' 个差异文件');
  }

  dir() {
    return (this.plugin.manifest && this.plugin.manifest.dir) || '.obsidian/plugins/lan-sync';
  }

  statePath() { return this.dir() + '/state.json'; }          // 本地索引 + 冲突基准
  remotePath() { return this.dir() + '/remote-index.json'; }  // 远端索引 + rev

  async start() {
    await this.loadState();
    await this.loadRemoteIndex();
    this.registerEvents();
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') this.tick(true);
      else { this.saveStateNow(); this.saveRemoteNow(); }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.plugin.register(() => document.removeEventListener('visibilitychange', this.onVisibility));

    this.tickTimer = window.setInterval(() => this.tick(false), POLL_MS);
    this.plugin.registerInterval(this.tickTimer);
    this.retryTimer = window.setInterval(() => {
      if (!this.connected && !this.discovering && !this.stopped) this.connect();
    }, 15000);
    this.plugin.registerInterval(this.retryTimer);
    // 兜底：隔一段时间做一次纯内存全量对账，补上没触发 vault 事件的外部改动
    this.fullTimer = window.setInterval(() => { this.needFull = true; }, 300000);
    this.plugin.registerInterval(this.fullTimer);
    // .obsidian 里的改动不会触发 vault 事件，单独轮询本地配置
    this.cfgTimer = window.setInterval(() => { this.pollConfig(); }, 9000);
    this.plugin.registerInterval(this.cfgTimer);

    // 索引文件已在手，不必等库扫完：先按索引工作，删除判定等 vaultReady 再放开
    this.scheduleVaultReady();
    this.connect();
  }

  // 本地文件数远少于索引记录：说明库还没扫完（或用户真的删了一大批）
  vaultLooksIncomplete() {
    const expect = Math.max(countVault(this.state), countVault(this.remoteIndex));
    if (expect <= 20) return false;
    return this.app.vault.getFiles().length < Math.floor(expect * 0.9);
  }

  // 后台轻量探测：只看文件数是否稳定，不阻塞启动、不反复全量扫描
  scheduleVaultReady() {
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    this.vaultReady = false;
    let last = -1, stable = 0, tries = 0;
    const check = () => {
      this.vaultTimer = null;
      if (this.stopped || this.vaultReady) return;
      const n = this.app.vault.getFiles().length;
      stable = (n > 0 && n === last) ? stable + 1 : 0;
      last = n;
      if ((stable >= 3 && !this.vaultLooksIncomplete()) || ++tries >= 60) {
        this.vaultReady = true;
        this.needFull = true;
        this.tick(false);
        return;
      }
      this.vaultTimer = setTimeout(check, 1500);
    };
    this.vaultTimer = setTimeout(check, 1000);
  }

  stop() {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.remoteTimer) clearTimeout(this.remoteTimer);
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
    if (this.cfgTimer) clearInterval(this.cfgTimer);
    this.saveStateNow();
    this.saveRemoteNow();
  }

  /* ---------- 状态持久化 ---------- */

  async loadState() {
    try {
      const obj = await readJsonFile(this.app.vault.adapter, this.statePath());
      if (!obj) return;
      let n = 0;
      for (const [p, v] of Object.entries(obj.files || {})) {
        if (shouldIgnore(p) || !Array.isArray(v) || v.length !== 3) continue;
        this.state.set(p, v);
        this.localIndex.set(p, { hash: v[2], size: v[0], mtime: v[1] });
        if (++n % 1000 === 0) await sleep(0);
      }
      let b = 0;
      for (const [p, h] of Object.entries(obj.base || {})) {
        this.base.set(p, h);
        if (++b % 1000 === 0) await sleep(0);
      }
    } catch (e) { /* 首次运行 */ }
  }

  // 远端索引单独落盘：手机重启后从保存的 rev 继续增量，不必再拉 1.7 万行全量快照
  async loadRemoteIndex() {
    try {
      const obj = await readJsonFile(this.app.vault.adapter, this.remotePath());
      if (!obj || !obj.files) return;
      let n = 0;
      for (const [p, v] of Object.entries(obj.files)) {
        if (!shouldIgnore(p) && Array.isArray(v) && v.length === 3)
          this.remoteIndex.set(p, { hash: v[0], size: v[1], mtime: v[2] });
        if (++n % 1000 === 0) await sleep(0);
      }
      this.remoteRev = obj.rev || 0;
      this.remoteVault = obj.vault || '';
      this.haveSnapshot = true;
      dbg(this.app, '从 remote-index.json 恢复 ' + this.remoteIndex.size + ' 个文件 rev=' + this.remoteRev);
    } catch (e) { /* 首次运行 */ }
  }

  resetRemote() {
    this.remoteIndex.clear();
    this.remoteDeletes.clear();
    this.base.clear();
    this.remoteRev = 0;
    this.remoteVault = '';
    this.haveSnapshot = false;
    this.needFull = true;
    this.remoteDirty = true;
    this.stateDirty = true;
    this.saveRemoteNow();
  }

  saveRemote() {
    this.remoteDirty = true;
    if (this.remoteTimer) return;
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null;
      this.saveRemoteNow();
    }, 2500);
  }

  async saveRemoteNow() {
    if (!this.remoteDirty) return;
    this.remoteDirty = false;
    const files = {};
    for (const [p, m] of this.remoteIndex) files[p] = [m.hash, m.size, m.mtime];
    try {
      await writeJsonFile(this.app.vault.adapter, this.remotePath(), {
        vault: this.remoteVault, rev: this.remoteRev, savedAt: Date.now(), files,
      });
    } catch (e) { /* ignore */ }
  }

  saveState() {
    this.stateDirty = true;
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.saveStateNow();
    }, 2500);
  }

  async saveStateNow() {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    const files = {};
    for (const [p, v] of this.state) files[p] = v;
    const base = {};
    for (const [p, h] of this.base) base[p] = h;
    try {
      await writeJsonFile(this.app.vault.adapter, this.statePath(), { files, base, rev: this.remoteRev });
    } catch (e) { /* ignore */ }
  }

  /* ---------- vault 事件 ---------- */

  registerEvents() {
    const v = this.app.vault;
    const mark = (f) => {
      if (!f || !f.path || shouldIgnore(f.path)) return;
      // Obsidian 启动时补扫库会为每个文件发 create/modify，那不是用户改动。
      // 若全塞进 dirty，每次启动都会把 1.7 万个文件重新读盘+哈希一遍（表现为“一直在构建”）。
      // 库就绪后统一做一次纯内存对账，由 state.json 的 size/mtime 找出真正的变化。
      if (!this.vaultReady) { this.needFull = true; return; }
      this.dirty.add(f.path);
      this.candidates.add(f.path);
      this.scheduleTick();
    };
    this.plugin.registerEvent(v.on('modify', mark));
    this.plugin.registerEvent(v.on('create', mark));
    this.plugin.registerEvent(v.on('delete', mark));
    this.plugin.registerEvent(v.on('rename', (f, oldPath) => {
      if (!this.vaultReady) { this.needFull = true; return; }
      if (oldPath) { this.dirty.add(oldPath); this.candidates.add(oldPath); }
      mark(f);
    }));
  }

  scheduleTick() {
    if (this.tickPending) return;
    this.tickPending = true;
    setTimeout(() => { this.tickPending = false; this.tick(false); }, 150);
  }

  /* ---------- 零输入配对 ---------- */

  authHeaders() {
    const t = this.plugin.settings.pairToken;
    return t ? { 'X-Lan-Sync-Token': t } : {};
  }

  // 手机端全自动：发现服务 → 自动申请 → 等电脑点「允许」→ 自动保存令牌并继续同步
  async ensurePairing() {
    const base = baseUrl(this.endpoint);
    const ping = await httpJson(base + API + '/ping', {}, 8000);
    if (!ping || ping.app !== APP_ID) throw new Error(tr('err.notLanSync'));
    dbg(this.app, '配对检查 auth=' + !!ping.auth + ' 通道=' + (nativeOnly ? '原生' : 'fetch'));
    const s = this.plugin.settings;
    if (!ping.auth) { s.pairToken = ''; return; }             // 兼容旧版电脑端
    if (s.pairToken && s.pairVault === ping.vault) return;    // 已配对，之后永久免操作
    const id = this.plugin.deviceId;
    const kind = Platform.isIosApp ? 'iPhone/iPad' : (Platform.isAndroidApp ? tr('device.android') : tr('device.mobile'));
    const name = kind + ' · ' + id.slice(0, 6);
    await httpJson(base + API + '/pair/request', {
      method: 'POST', body: JSON.stringify({ deviceId: id, name }),
    }, 8000);
    this.plugin.setStatus(tr('status.waitPair'), 'pending');
    dbg(this.app, '已发出配对请求 ' + name);
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      let st;
      try { st = await httpJson(base + API + '/pair/status?deviceId=' + encodeURIComponent(id), {}, 8000); }
      catch (e) { continue; }
      if (st && st.state === 'approved' && st.token) {
        s.pairToken = st.token;
        s.pairVault = ping.vault;
        await this.plugin.saveData(s);
        this.plugin.setStatus(tr('status.paired'), 'syncing');
        dbg(this.app, '配对成功');
        return;
      }
      if (st && st.state === 'rejected') throw new Error(tr('err.rejected'));
    }
    throw new Error(tr('err.pairTimeout'));
  }

  // 令牌被电脑端撤销后，自动清掉并重新进入配对流程
  handleError(e) {
    if (e && e.isUnauthorized) {
      const s = this.plugin.settings;
      s.pairToken = '';
      s.pairVault = '';
      this.plugin.saveData(s).catch(() => {});
      this.needFull = true;
      dbg(this.app, '授权已失效，将自动重新配对');
    }
  }

  /* ---------- 发现与连接 ---------- */

  async connect() {
    if (this.discovering || this.stopped) return;
    this.discovering = true;
    this.plugin.setStatus(tr('status.findServer'), 'connecting');
    try {
      const ep = await withTimeout(
        findServer(this.endpoint, (pre) => this.plugin.setStatus(tr('status.findSubnet', pre), 'connecting')),
        120000, tr('task.findServer')
      );
      if (!ep) {
        this.connected = false;
        dbg(this.app, '未找到电脑（已扫描）');
        this.plugin.setStatus(tr('status.serverNotFound'), 'error');
        return;
      }
      dbg(this.app, '找到电脑 ' + ep.host + ':' + ep.port + (nativeOnly ? '（原生通道）' : ''));
      this.endpoint = { host: ep.host, port: ep.port, vault: ep.vault };
      this.plugin.settings.endpoint = this.endpoint;
      this.plugin.saveSoon();
      await this.ensurePairing();  // 未配对时自动申请，手机端无需任何输入
      // 只有换了库才丢弃已落盘的远端索引；换 IP/端口照旧从保存的 rev 增量
      if (ep.vault && this.remoteVault && this.remoteVault !== ep.vault) this.resetRemote();
      else if (ep.vault && !this.remoteVault) { this.remoteVault = ep.vault; this.saveRemote(); }
      this.connected = true;
      this.plugin.setStatus(tr('status.connected', ep.host, ep.port), 'syncing');
      this.plugin.setFileCount(this.state.size);
      await this.tick(true);
    } catch (e) {
      this.handleError(e);
      this.connected = false;
      this.plugin.setStatus(tr('status.connectFailed', e.message || e), 'error');
    } finally {
      this.discovering = false;
    }
  }

  markDisconnected(reason) {
    this.connected = false;
    // 索引已落盘：重连后从保存的 rev 继续增量，不再丢弃快照重拉全量
    this.plugin.setStatus(tr('status.disconnected', reason ? tr('status.reason', reason) : ''), 'offline');
  }

  /* ---------- 主循环 ---------- */

  async tick(force) {
    if (this.stopped) return;
    if (this.busy) { this.rerun = true; return; }
    if (!this.connected) return;
    if (document.visibilityState === 'hidden' && !force) return;
    this.busy = true;
    try {
      await withTimeout(this.runOnce(force), 600000, tr('task.syncRound'));
    } catch (e) {
      dbg(this.app, 'tick 失败: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
      this.handleError(e);
      this.markDisconnected(e.message || String(e));
    } finally {
      this.busy = false;
      if (this.rerun) { this.rerun = false; setTimeout(() => this.tick(false), 30); }
    }
  }

  async runOnce(force) {
    let changed = false;
    if (!this.haveSnapshot) {
      await this.loadSnapshot();
      changed = true;
      this.needFull = true;
    } else {
      changed = await this.loadChanges();
    }
    // 候选集为空时，连 1.7 万条的内存遍历都省掉
    const forceAll = !!force || this.needFull;
    this.sweepRemote();  // 放在判断之前：增量漏掉的差异也要能被补回来
    if (changed || forceAll || this.dirty.size > 0 || this.candidates.size > 0) {
      this.remoteVerCache.clear();  // 插件版本每轮重新确认，避免一直拿着旧判断
      this.skipPlugins.clear();
      await this.reconcile(forceAll);
    } else if (force) this.plugin.setStatus(tr('status.upToDate', this.endpoint ? this.endpoint.host : ''), 'ready');
  }

  async loadSnapshot() {
    const j = await httpJson(baseUrl(this.endpoint) + API + '/index', { headers: this.authHeaders() }, 30000);
    if (!j || j.ready === false) throw new Error(tr('err.desktopIndexing'));
    this.remoteIndex.clear();
    for (const row of j.files || []) this.remoteIndex.set(row[0], { hash: row[1], size: row[2], mtime: row[3] });
    this.remoteRev = j.rev || 0;
    this.remoteVault = (this.endpoint && this.endpoint.vault) || this.remoteVault || '';
    this.haveSnapshot = true;
    this.needFull = true;
    // 刚拿到全量远端索引，重新确认本地库是否已扫完，避免误把文件全部拉/删一遍
    if (this.remoteIndex.size > 20) this.scheduleVaultReady();
    this.saveRemote();
    dbg(this.app, '快照: ' + this.remoteIndex.size + ' 个文件 rev=' + this.remoteRev);
  }

  async loadChanges() {
    const j = await httpJson(baseUrl(this.endpoint) + API + '/changes?rev=' + this.remoteRev, { headers: this.authHeaders() }, 20000);
    if (!j) return false;
    if (j.ready === false) throw new Error(tr('err.desktopIndexing'));
    if (j.reset) {
      this.remoteIndex.clear();
      for (const row of j.files || []) this.remoteIndex.set(row[0], { hash: row[1], size: row[2], mtime: row[3] });
      this.remoteRev = j.rev || 0;
      this.needFull = true;
      if (this.remoteIndex.size > 20) this.scheduleVaultReady();
      this.saveRemote();
      return true;
    }
    if (j.rev === this.remoteRev) return false;
    for (const c of j.changes || []) this.applyRemoteChange(c);
    this.remoteRev = j.rev;
    this.saveRemote();
    return (j.changes || []).length > 0;
  }

  applyRemoteChange(c) {
    if (shouldIgnore(c.path)) return;
    if (c.deleted) {
      this.remoteIndex.delete(c.path);
      this.remoteDeletes.add(c.path);
      this.candidates.add(c.path);
      const pre = c.path + '/';
      for (const p of [...this.remoteIndex.keys()]) {
        if (p.startsWith(pre)) {
          this.remoteIndex.delete(p);
          this.remoteDeletes.add(p);
          this.candidates.add(p);
        }
      }
      return;
    }
    this.remoteDeletes.delete(c.path);
    this.remoteIndex.set(c.path, { hash: c.hash, size: c.size, mtime: c.mtime });
    this.candidates.add(c.path);
    if (!this.seenAt.has(c.path)) this.seenAt.set(c.path, Date.now());
  }

  /* ---------- 本地扫描 ---------- */

  async scanLocal() {
    const dirty = new Set(this.dirty);
    const prev = this.localIndex;
    const next = new Map();
    const todo = [];
    const failed = new Set();
    const files = this.app.vault.getFiles();
    // 库尚未扫完时 getFiles() 会缺一大半，先按索引当它还在，避免把“没加载”当删除
    const suspicious = !this.vaultReady && this.vaultLooksIncomplete();
    let total = 0;
    for (const f of files) {
      if (shouldIgnore(f.path)) continue;
      total++;
      const st = f.stat || {};
      const size = st.size || 0;
      const mtime = st.mtime || 0;
      const known = this.state.get(f.path);
      // 事件标记只是提示，最终以索引里的 size+mtime 为准：元数据没变就直接用缓存哈希
      if (known && known[0] === size && known[1] === mtime && known[2]) {
        next.set(f.path, { hash: known[2], size, mtime });  // 命中索引：不读盘、不重算哈希
      } else {
        todo.push({ path: f.path, size, mtime });
      }
    }

    // .obsidian 里的配置不在 getFiles() 里：只有轮询发现变化时才重新走一遍 adapter.list，
    // 否则沿用本地索引，避免每 1.2 秒就 stat 几百个配置文件
    const cfg = this.configDirty ? await collectConfig(this.app) : null;
    const cfgOk = !!cfg && !(this.cfgCount && cfg.size < Math.floor(this.cfgCount * 0.5));
    if (cfgOk) {
      this.configDirty = false;
      this.cfgCount = cfg.size;
      total += cfg.size;
      for (const [p, m] of cfg) {
        if (shouldIgnore(p)) continue;
        const known = this.state.get(p);
        if (known && known[0] === m.size && known[1] === m.mtime && known[2]) {
          next.set(p, { hash: known[2], size: m.size, mtime: m.mtime });
        } else {
          todo.push({ path: p, size: m.size, mtime: m.mtime });
        }
      }
    } else {
      // 没到轮询点或枚举失败：沿用已有配置条目，绝不当成删除
      for (const [p, m] of this.localIndex) {
        if (isConfigPath(p) && !shouldIgnore(p)) next.set(p, { hash: m.hash, size: m.size, mtime: m.mtime });
      }
    }

    // 并发读+哈希：只处理索引里 size/mtime 变化或没有索引记录的文件
    let cursor = 0;
    let hashed = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= todo.length) return;
        const item = todo[i];
        try {
          const ab = await readFileBytes(this.app, item.path);
          const h = await hashBytes(ab);
          this.state.set(item.path, [item.size, item.mtime, h]);
          next.set(item.path, { hash: h, size: item.size, mtime: item.mtime });
          this.stateDirty = true;
          if (++hashed % 300 === 0) {
            this.plugin.setStatus(tr('status.scanning', hashed, todo.length));
            this.saveState(); // 保存进度，中断后不必重扫
          }
        } catch (e) { failed.add(item.path); /* 读失败的下轮再试 */ }
      }
    };
    const workers = [];
    for (let w = 0; w < Math.min(6, todo.length); w++) workers.push(worker());
    await Promise.all(workers);

    for (const p of dirty) if (!failed.has(p)) this.dirty.delete(p);

    // 索引里有、磁盘上没有 → 删除候选；库未就绪或本次读取失败时先按原样保留
    for (const [p, v] of [...this.state]) {
      if (next.has(p)) continue;
      if (suspicious || failed.has(p)) {
        next.set(p, { hash: v[2], size: v[0], mtime: v[1] });
        continue;
      }
      this.state.delete(p);
      this.stateDirty = true;
      this.candidates.add(p);
    }
    // 只有内容哈希与上一份索引不同的文件才进入待操作集合
    for (const [p, m] of next) {
      const old = prev.get(p);
      if (!old || old.hash !== m.hash) this.candidates.add(p);
    }
    this.localIndex = next;
    dbg(this.app, 'scanLocal: ' + next.size + '/' + total + ' 个文件，本次哈希 ' + hashed);
    return total;
  }

  // .obsidian 的改动不会有 vault 事件：定时对比元数据，发现变化再让 scanLocal 重扫配置
  async pollConfig() {
    if (this.busy || this.stopped || !this.vaultReady) return;
    const cfg = await collectConfig(this.app);
    if (!cfg || (this.cfgCount && cfg.size < Math.floor(this.cfgCount * 0.5))) return;
    this.cfgCount = cfg.size;
    let changed = false;
    for (const [p, m] of cfg) {
      const known = this.localIndex.get(p);
      if (known && known.size === m.size && known.mtime === m.mtime) continue;
      this.candidates.add(p);
      changed = true;
    }
    for (const p of [...this.localIndex.keys()]) {
      if (isConfigPath(p) && !cfg.has(p)) { this.candidates.add(p); changed = true; }
    }
    if (changed) {
      this.configDirty = true;
      this.scheduleTick();
    }
  }

  /* ---------- 对账 ---------- */

  async reconcile(forceAll) {
    await this.scanLocal();
    if (this.localIndex.size === 0 && this.remoteIndex.size > 0) {
      dbg(this.app, '本地库尚未加载完成，跳过本轮');
      return;
    }
    // 库没扫完时绝不批量拉取/删除：索引文件里的 1.7 万个文件此时可能被误判为“本地没有”
    if (!this.vaultReady && this.vaultLooksIncomplete()) {
      dbg(this.app, '本地库文件数未达索引规模，跳过本轮');
      return;
    }
    this.needFull = false;  // 在 reconcile 开头清，后台置起的 needFull 不会被本轮吞掉
    let todo;
    if (forceAll) {
      todo = new Set();
      for (const p of this.localIndex.keys()) todo.add(p);
      for (const p of this.remoteIndex.keys()) todo.add(p);
      for (const p of this.base.keys()) todo.add(p);
    } else {
      todo = new Set(this.candidates);
    }
    this.candidates.clear();

    let ops = 0;
    // 先取一次“当前打开的笔记”集合：对账动辄上万个文件，逐个查视图太慢
    const openSet = openEditorPathSet(this.app);
    for (const p of todo) {
      if (shouldIgnore(p)) continue;
      const L = this.localIndex.get(p);
      const R = this.remoteIndex.get(p);
      const B = this.base.get(p);
      const Lh = L ? L.hash : undefined;
      const Rh = R ? R.hash : undefined;
      // 只有“要把远端写入本地”才需要避让正在编辑的文件；推送不受影响
      let defer = false;
      if (Rh !== undefined && Lh !== Rh && openSet.has(p)) defer = await this.shouldDeferPull(p, Lh);
      // 刚把远端内容写进来、磁盘还没落稳时，读到的“旧内容”不是本地修改，
      // 推回去会把对方刚写好的文本覆盖掉，必须拦住
      if (Lh !== Rh) {
        const jw = this.justWrote.get(p);
        // 只有“本地又变回写入前那份内容”才说明磁盘还没落稳；用户接着改出的新内容必须立刻推
        if (jw && jw.hash === Rh && Lh === jw.prev && Date.now() - jw.at < 30000) {
          await this.waitWritten(p, Rh, 1200);
          this.candidates.add(p);
          continue;
        }
      }
      // 从电脑拉插件时只升不降：远端版本更旧就整包跳过，避免把新设备覆盖回去。
      // 反过来“本机更新、要推给电脑”是允许的，交给服务端的 x-plugin-version 判断。
      if (isConfigPath(p) && Rh !== undefined && Lh !== Rh) {
        const pid = pluginIdOf(p);
        if (pid) {
          if (this.skipPlugins.has(pid)) continue;
          const wouldPull = B === undefined || Lh === undefined || B === Lh;
          if (wouldPull && !(await this.pluginVersionAllowed(pid))) { this.skipPlugins.add(pid); continue; }
        }
      }
      try {
        if (Lh === Rh) {
          if (Lh) this.base.set(p, Lh);
          else this.base.delete(p);
          continue;
        }

        if (Rh === undefined) {
          // 电脑端没有这个文件
          if (Lh === undefined) { this.base.delete(p); continue; }
          const remoteDeleted = this.remoteDeletes.has(p);
          if ((B !== undefined && B === Lh) || (B === undefined && remoteDeleted)) {
            // 电脑删了、本地没改过 → 真正删掉本地文件。
            // 旧版这里发 /delete 给电脑，本地文件还在，下一轮就被 push 回去「复活」。
            await this.deleteLocal(p);
            this.base.delete(p);
            this.stats.deleted++;
          } else {
            // 手机端新建，或本地改过而电脑删了 → 保留本地内容
            if (remoteDeleted) dbg(this.app, '电脑已删除但本地有改动，保留：' + p);
            await this.push(p, L);
            this.base.set(p, Lh);
            this.stats.pushed++;
          }
          ops++;
          continue;
        }

        if (Lh === undefined) {
          // 本地没有这个文件
          if (B === undefined) {
            if (defer) { this.candidates.add(p); continue; }
            await this.pull(p, R);
            this.base.set(p, Rh);
            this.stats.pulled++;
          } else if (B === Rh) {
            // 电脑没改过而本地删了 → 电脑端同步删除
            await this.deleteRemote(p);
            this.base.delete(p);
            this.stats.deleted++;
          } else {
            // 电脑改过，本地删了 → 拉回来
            if (defer) { this.candidates.add(p); continue; }
            await this.pull(p, R);
            this.base.set(p, Rh);
            this.stats.pulled++;
          }
          ops++;
          continue;
        }

        // 两边都有且内容不同
        if (B !== undefined && B === Lh) {
          if (defer) { this.candidates.add(p); continue; }
          await this.pull(p, R);
          this.base.set(p, Rh);
          this.stats.pulled++;
        } else if (B !== undefined && B === Rh) {
          await this.push(p, L);
          this.base.set(p, Lh);
          this.stats.pushed++;
        } else if (B === undefined) {
          // 首次配对、没有基准：按修改时间新者胜
          const lm = (L && L.mtime) || 0;
          const rm = (R && R.mtime) || 0;
          if (lm > rm + 2000) {
            await this.push(p, L);
            this.base.set(p, Lh);
            this.stats.pushed++;
          } else {
            if (defer) { this.candidates.add(p); continue; }
            await this.pull(p, R);
            this.base.set(p, Rh);
            this.stats.pulled++;
          }
        } else {
          // 两端都改过 → 交给电脑端做唯一合并，结果写回同一路径
          if (defer) { this.candidates.add(p); continue; }
          const mode = await this.mergeWithServer(p, L);
          if (mode === 'conflict') this.stats.conflicts++;
        }
        ops++;
      } catch (e) {
        console.error('[lan-sync] sync failed for file', p, e);
        this.candidates.add(p);  // 失败的文件留在候选集，下轮重试
      }
      if (ops % 10 === 0) this.plugin.setStatus(tr('status.syncing', ops), 'syncing');
    }

    this.lastSyncAt = Date.now();
    this.plugin.setFileCount(this.state.size);
    if (ops > 0) this.plugin.setStatus(tr('status.synced', ops, this.endpoint.host), 'ready');
    else if (this.connected) this.plugin.setStatus(tr('status.upToDate', this.endpoint ? this.endpoint.host : ''), 'ready');
    dbg(this.app, 'reconcile: 操作 ' + ops + ' 拉取=' + this.stats.pulled + ' 推送=' + this.stats.pushed + ' 删除=' + this.stats.deleted + ' 冲突=' + this.stats.conflicts);
    this.remoteDeletes.clear();
    this.saveState();
  }

  /* ---------- 传输 ---------- */

  // 只避让“刚保存、可能还在打字”的文件；光标留在文档里但已经停手，就该立刻应用。
  // 关键一条：编辑器缓冲区里只要有还没落盘的内容，就绝不覆盖——那是用户正在写的东西。
  async shouldDeferPull(path, localHash) {
    const af = this.app.vault.getAbstractFileByPath(path);
    const st = af && af.stat;
    if (st && Date.now() - st.mtime < 1500) return true;
    const buf = openEditorValue(this.app, path);
    if (buf !== null) {
      try {
        const bh = await hashBytes(new TextEncoder().encode(buf));
        if (bh !== localHash) return true;
      } catch (e) { /* ignore */ }
    }
    return this.dirty.has(path);   // 本地还有没推出去的改动，先让它推完
  }

  async pull(p, R) {
    this.plugin.pulseFor(800);
    this.noteOp('pull', p);
    const ab = await httpBinary(baseUrl(this.endpoint) + API + '/file?path=' + encodeURIComponent(p), 60000, this.authHeaders());
    // 磁盘上已是同样内容就不写，避免无意义的 mtime 抖动
    let existing = null;
    let prevHash = '';
    try { existing = await readFileBytes(this.app, p); } catch (e) { existing = null; }
    if (existing) { try { prevHash = await hashBytes(existing); } catch (e) { prevHash = ''; } }
    let hash;
    if (existing && existing.byteLength === ab.byteLength) {
      const a = await hashBytes(existing);
      if (a === R.hash) {
        hash = a;
        // 磁盘一致，但编辑器缓冲区可能还是旧内容，补一次避免它稍后把旧内容写回磁盘
        if (isTextPath(p)) {
          try { applyToOpenEditor(this.app, p, new TextDecoder('utf-8').decode(ab)); } catch (e) { /* ignore */ }
        }
        this.justWrote.set(p, { hash, prev: hash, at: Date.now() });
        this.localIndex.set(p, { hash, size: ab.byteLength, mtime: R.mtime });
        this.base.set(p, hash);
        this.dirty.delete(p);
        latLog(this.app, '拉取 通知→已是最新', p, Date.now() - (this.seenAt.get(p) || Date.now()));
        this.seenAt.delete(p);
        return;
      }
    }
    await writeViaVault(this.app, p, ab);
    hash = await hashBytes(ab);
    this.justWrote.set(p, { hash, prev: prevHash, at: Date.now() });
    // 手机上写入是异步的。必须确认磁盘真的变成新内容再记状态：
    // 如果编辑器缓冲区把旧内容又存了回去，却把索引记成新 hash，
    // 下一轮就会把旧内容当成“本地修改”推给电脑——这就是文字消失的来源。
    let landed = await this.waitWritten(p, hash, 3000);
    if (!landed) {
      // 已经改过编辑器缓冲区，正常情况 Obsidian 几秒内会自己保存。
      // 连续 3 轮都没落盘才强制写一次（会重载视图，属于最后手段）。
      const tries = (this.landRetry.get(p) || 0) + 1;
      this.landRetry.set(p, tries);
      if (tries >= 3) {
        try {
          const af2 = this.app.vault.getAbstractFileByPath(p);
          if (af2 && !af2.children) await this.app.vault.modify(af2, new TextDecoder('utf-8').decode(ab));
        } catch (e) { /* ignore */ }
        landed = await this.waitWritten(p, hash, 1500);
        this.landRetry.delete(p);
      }
    } else {
      this.landRetry.delete(p);
    }
    if (landed) {
      this.localIndex.set(p, { hash, size: ab.byteLength, mtime: R.mtime });
      await this.setLocalState(p, ab, hash);
    } else {
      // 没落盘就别声称自己有新内容：清掉本地记录，让它下一轮重新哈希、重新拉
      this.localIndex.delete(p);
      this.candidates.add(p);
    }
    this.stateDirty = true;
    this.dirty.delete(p);
    latLog(this.app, '拉取 通知→落盘', p, Date.now() - (this.seenAt.get(p) || Date.now()));
    this.seenAt.delete(p);
    if (isConfigPath(p)) this.noteConfigApplied();
  }

  async waitWritten(p, hash, timeout) {
    const end = Date.now() + (timeout || 1000);
    do {
      try {
        const cur = await readFileBytes(this.app, p);
        if (await hashBytes(cur) === hash) return true;
      } catch (e) { /* 还没写出来 */ }
      await sleep(100);
    } while (Date.now() < end);
    return false;
  }

  async setLocalState(p, ab, hash) {
    const st = await statMeta(this.app, p);
    if (st) this.state.set(p, [st.size || ab.byteLength, st.mtime || Date.now(), hash]);
    else this.state.set(p, [ab.byteLength, Date.now(), hash]);
  }

  async push(p, L) {
    this.plugin.pulseFor(800);
    this.noteOp('push', p);
    const ab = await readFileBytes(this.app, p);
    const headers = Object.assign({}, this.authHeaders());
    if (L && L.mtime) headers['x-save-mtime'] = String(L.mtime);   // 让电脑端能算“保存 → 落盘”耗时
    const pid = pluginIdOf(p);
    if (pid) {
      // 让电脑端能判断“这是不是旧版本”，避免回退覆盖
      const ver = await readPluginVersion(this.app, pid);
      if (ver) headers['x-plugin-version'] = ver;
    }
    const res = await httpPutBinary(
      baseUrl(this.endpoint) + API + '/file?path=' + encodeURIComponent(p),
      ab, 60000, headers
    );
    if (res && res.skipped) {
      if (pid) this.skipPlugins.add(pid);
      return;
    }
    const hash = (res && res.hash) || (L && L.hash);
    if (hash) {
      this.remoteIndex.set(p, { hash, size: ab.byteLength, mtime: Date.now() });
      this.saveRemote();
    }
    latLog(this.app, '推送 保存→已送达', p, Date.now() - ((L && L.mtime) || Date.now()));
    if (isConfigPath(p)) this.noteConfigApplied();
  }

  // 电脑端删除 → 手机端真正删掉本地文件（而不是请电脑再删一次）
  async deleteLocal(p) {
    const af = this.app.vault.getAbstractFileByPath(p);
    if (af && !af.children) {
      try { await this.app.vault.trash(af, false); }
      catch (e) {
        try { await this.app.vault.adapter.remove(p); } catch (e2) { /* 已不存在 */ }
      }
    } else if (!af && isConfigPath(p)) {
      try { await this.app.vault.adapter.remove(p); } catch (e) { /* 已不存在 */ }
    }
    this.localIndex.delete(p);
    this.state.delete(p);
    this.dirty.delete(p);
    this.candidates.delete(p);
    this.stateDirty = true;
    this.saveState();
  }

  async deleteRemote(p) {
    await httpJson(baseUrl(this.endpoint) + API + '/delete?path=' + encodeURIComponent(p), { method: 'POST', headers: this.authHeaders() }, 15000);
    this.remoteIndex.delete(p);
    this.saveRemote();
  }

  // 插件版本只升不降：远端 manifest 更旧时整包跳过，避免旧设备把新版本写回去
  async pluginVersionAllowed(id) {
    const local = await readPluginVersion(this.app, id);
    if (!local) return true;
    let remote = this.remoteVerCache.get(id);
    if (remote === undefined) {
      remote = '';
      try {
        const ab = await httpBinary(
          baseUrl(this.endpoint) + API + '/file?path=' + encodeURIComponent('.obsidian/plugins/' + id + '/manifest.json'),
          15000, this.authHeaders()
        );
        const j = JSON.parse(new TextDecoder('utf-8').decode(ab));
        remote = j && j.version ? String(j.version) : '';
      } catch (e) { remote = ''; }
      this.remoteVerCache.set(id, remote);
    }
    return !(remote && cmpVer(remote, local) < 0);
  }

  // 同一文件被反复拉取/推送是数据回退的典型征兆，只在重复时记日志，避免日志爆掉
  noteOp(kind, p) {
    const n = (this.opSeen.get(p) || 0) + 1;
    this.opSeen.set(p, n);
    if (n > 1 && (n <= 4 || n % 20 === 0)) dbg(this.app, kind + ' 重复 #' + n + ': ' + p);
  }

  noteConfigApplied() {
    const now = Date.now();
    // 插件代码偶尔更新，不需要每隔几秒提醒一次；一分钟内只提示一次
    if (now - this.reloadNoticeAt < 60000) return;
    this.reloadNoticeAt = now;
    new Notice(tr('notice.reloadNeeded'));
  }

  // 两端都改过 → 交给电脑端合并。电脑端是唯一决策方，这里只负责发送与落盘，
  // 因此两边最终拿到的文本逐字节相同，不会来回产生新冲突。
  async mergeWithServer(p, L) {
    this.plugin.pulseFor(800);
    this.noteOp('merge', p);
    const ext = extOf(p);
    const ab = await readFileBytes(this.app, p);
    const textMode = MERGE_EXT.has(ext) && ab.byteLength <= MERGE_MAX;
    // 超大二进制不进合并通道：base64 会把内存顶爆，直接推送本地版本
    if (!textMode && ab.byteLength > 8 * 1024 * 1024) {
      await this.push(p, L);
      this.base.set(p, (L && L.hash) || '');
      return 'merged';
    }
    const body = {
      path: p,
      baseHash: this.base.get(p) || '',
      deviceId: this.plugin.deviceId,
      deviceName: this.deviceLabel(),
      mtime: (L && L.mtime) || Date.now(),
      encoding: textMode ? 'text' : 'base64',
      data: textMode ? new TextDecoder('utf-8').decode(ab) : abToBase64(ab),
    };
    const res = await httpJson(baseUrl(this.endpoint) + API + '/merge', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders()),
    }, 60000);
    if (!res || !res.hash) throw new Error('merge failed');

    if (typeof res.data === 'string' && (res.encoding === 'text' || res.encoding === 'base64')) {
      const out = res.encoding === 'text' ? new TextEncoder().encode(res.data) : base64ToAb(res.data);
      await writeViaVault(this.app, p, out);
      const hash = await hashBytes(out);
      this.justWrote.set(p, { hash, prev: await hashBytes(ab), at: Date.now() });
      this.localIndex.set(p, { hash, size: out.byteLength, mtime: Date.now() });
      await this.waitWritten(p, hash, 1200);
      await this.setLocalState(p, out, res.hash);
      this.stateDirty = true;
      this.dirty.delete(p);
    } else {
      // 本机版本胜出：电脑端已经写成同样内容，本地无需写盘
      this.localIndex.set(p, { hash: res.hash, size: ab.byteLength, mtime: (L && L.mtime) || Date.now() });
      await this.setLocalState(p, ab, res.hash);
      this.stateDirty = true;
      this.dirty.delete(p);
    }
    this.remoteIndex.set(p, { hash: res.hash, size: ab.byteLength, mtime: Date.now() });
    this.base.set(p, res.hash);
    this.saveRemote();
    this.saveState();
    if (isConfigPath(p)) this.noteConfigApplied();
    return res.conflicts ? 'conflict' : 'merged';
  }

  deviceLabel() {
    if (Platform.isIosApp) return 'iPhone/iPad';
    if (Platform.isAndroidApp) return tr('device.android');
    return tr('device.mobile');
  }
}

/* ============================ 插件 ============================ */

// 冲突块的配色：电脑版蓝、本机版橙；正文里直接看得见，不用打开任何面板
const CONFLICT_CSS = [
  '.callout[data-callout="lan-sync-remote"] { --callout-color: 68, 138, 255; --callout-icon: lucide-monitor; }',
  '.callout[data-callout="lan-sync-local"] { --callout-color: 255, 149, 0; --callout-icon: lucide-smartphone; }',
  '.cm-line.lan-sync-cf-remote { background: rgba(68, 138, 255, 0.10); box-shadow: inset 2px 0 0 rgb(68, 138, 255); }',
  '.cm-line.lan-sync-cf-local { background: rgba(255, 149, 0, 0.10); box-shadow: inset 2px 0 0 rgb(255, 149, 0); }',
  '.lan-sync-keep-row { margin-top: 6px; }',
  '.lan-sync-keep { font-size: var(--font-ui-smaller); }',
  // 状态点：绿=正常 黄=同步中 红=出错/断开 灰=未启用
  '.lan-sync-status { display: inline-flex; align-items: center; gap: 6px; }',
  '.lan-sync-dot { width: 8px; height: 8px; border-radius: 50%; background: #8b949e; display: inline-block; }',
  '.lan-sync-dot.is-ready, .lan-sync-float.is-ready { background: #2ea043; }',
  '.lan-sync-dot.is-syncing, .lan-sync-float.is-syncing { background: #d29922; }',
  '.lan-sync-dot.is-writing, .lan-sync-float.is-writing { background: #d29922; }',
  '.lan-sync-dot.is-pending, .lan-sync-float.is-pending { background: #d29922; }',
  '.lan-sync-dot.is-connecting, .lan-sync-float.is-connecting { background: #d29922; }',
  '.lan-sync-dot.is-error, .lan-sync-float.is-error { background: #f85149; }',
  '.lan-sync-dot.is-offline, .lan-sync-float.is-offline { background: #f85149; }',
  '.lan-sync-float { position: fixed; right: 16px; bottom: 92px; width: 10px; height: 10px; border-radius: 50%;',
  '  background: #8b949e; z-index: 9999; touch-action: none; cursor: grab;',
  '  box-shadow: 0 0 0 2px var(--background-primary), 0 1px 2px rgba(0, 0, 0, 0.35); }',
  '.lan-sync-float.is-writing { animation: lan-sync-pulse 1s ease-in-out infinite; }',
  // 电脑端悬浮点：稍大一点、加大右键热区
  '.is-desktop .lan-sync-float, .lan-sync-float.is-floating-desktop { width: 12px; height: 12px; cursor: pointer; }',
  '.is-desktop .lan-sync-float::before, .lan-sync-float.is-floating-desktop::before { content: ""; position: absolute; inset: -8px; border-radius: 50%; }',
  '.lan-sync-dot.is-syncing, .lan-sync-dot.is-writing { animation: lan-sync-pulse 1.1s ease-in-out infinite; }',
  '.lan-sync-float.is-syncing { animation: lan-sync-pulse 1.1s ease-in-out infinite; }',
  '@keyframes lan-sync-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.6); opacity: 0.5; } }',
  // 设置页：状态卡 + 数字瓦片 + 规则 chips
  '.lan-sync-card { border-radius: 12px; background: var(--background-secondary); padding: 16px 18px; margin: 10px 0 18px; }',
  '.lan-sync-card.is-off { opacity: .55; }',
  '.lan-sync-card-head { display: flex; align-items: center; gap: 12px; }',
  '.lan-sync-card-head .setting-item { border: none; padding: 0; margin: 0 0 0 auto; background: none; box-shadow: none; }',
  '.lan-sync-card-head .setting-item-info { display: none; }',
  '.lan-sync-card-head .setting-item-control { padding: 0; }',
  '.lan-sync-card-head .checkbox-container { box-shadow: none; }',
  '.lan-sync-card-title { font-weight: 600; }',
  '.lan-sync-card-sub { color: var(--text-muted); font-size: var(--font-ui-smaller); }',
  '.lan-sync-card-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-faint); flex: none; }',
  '.lan-sync-card-dot.is-ready { background: #2ea043; }',
  '.lan-sync-card-dot.is-syncing, .lan-sync-card-dot.is-writing { background: #d29922; animation: lan-sync-pulse 1.1s ease-in-out infinite; }',
  '.lan-sync-card-dot.is-error, .lan-sync-card-dot.is-offline { background: #f85149; }',
  '.lan-sync-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 14px 0 12px; }',
  '.lan-sync-tile { background: var(--background-primary); border-radius: 8px; padding: 8px 10px; }',
  '.lan-sync-tile b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }',
  '.lan-sync-tile span { color: var(--text-muted); font-size: var(--font-ui-smaller); }',
  '.lan-sync-actions { display: flex; gap: 8px; flex-wrap: wrap; }',
  '.lan-sync-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }',
  '.lan-sync-chip { font-family: var(--font-monospace); font-size: 11.5px; background: var(--background-secondary); padding: 2px 7px; border-radius: 5px; }',
  '.lan-sync-help-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }',
  '.lan-sync-help-pre { white-space: pre-wrap; font-size: 12px; margin: 6px 0 0; color: var(--text-muted); }',
  '.lan-sync-row-pending { background: var(--background-modifier-hover); border-radius: 8px; }',
  '@media (max-width: 560px) { .lan-sync-help-cols { grid-template-columns: 1fr; } }',
].join('\n');

// 冲突块的定位与解析：两端写入的是同一份文本，所以这里只做“留一版、删另一版”
const CONFLICT_RE = /%% lan-sync:conflict:remote([^\n]*)%%\n([\s\S]*?)\n?%% lan-sync:conflict:local([^\n]*)%%\n([\s\S]*?)\n?%% \/lan-sync:conflict %%/g;

function findConflicts(text) {
  const out = [];
  CONFLICT_RE.lastIndex = 0;
  let m;
  while ((m = CONFLICT_RE.exec(text))) {
    out.push({
      start: m.index,
      end: CONFLICT_RE.lastIndex,
      remote: m[2],
      local: m[4],
      stamp: (m[1] + ' ' + m[3]).trim(),
    });
  }
  return out;
}

function unquoteCallout(block) {
  const lines = String(block || '').split('\n');
  lines.shift();  // 去掉 > [!lan-sync-*] 标题行
  return lines.map((l) => l.replace(/^> ?/, '')).join('\n').replace(/\s+$/, '');
}

// 保留其中一版后，把冲突块连同两侧多余空行一起收掉，避免留下一串空行
function resolveConflictText(text, hit, keep) {
  const chosen = keep === 'remote' ? hit.remote : hit.local;
  let before = text.slice(0, hit.start).replace(/\n+$/, '\n');
  let after = text.slice(hit.end).replace(/^\n+/, '\n');
  if (!before.trim()) before = '';
  if (!after.trim()) after = '';
  return before + unquoteCallout(chosen) + after;
}

const DEFAULT_SETTINGS = {
  enabled: true,
  deviceId: '',
  vaultId: '',
  endpoint: null,
  devices: {},      // 电脑端：已授权设备 deviceId -> {name,ip,at,token}
  pairToken: '',    // 手机端：配对得到的令牌
  pairVault: '',    // 手机端：令牌对应的库，换库自动重新配对
  mobileDot: true,  // 手机端：右下角悬浮状态点
  dotPos: null,     // 手机端：悬浮点位置 {x, y}（拖过才记录）
  desktopFloat: false,   // 电脑端：状态点改为悬浮显示
  desktopDotPos: null,   // 电脑端：悬浮点位置 {x, y}
  ignorePatterns: null,  // 同步范围黑名单；null = 用 DEFAULT_IGNORE
};

class LanSyncPlugin extends Plugin {
  async onload() {
    // 插件自身抛出的异常会中断 Obsidian 的启动流程（表现为卡住、白屏），这里全部兜住
    try {
      let data = null, loadFailed = false;
      try { data = await this.loadData(); }
      catch (e) { loadFailed = true; console.error('[lan-sync] loadData failed', e); }
      const safe = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
      this.settings = Object.assign({}, DEFAULT_SETTINGS, safe);
      const hadLanguage = Object.prototype.hasOwnProperty.call(this.settings, 'language');
      delete this.settings.language;  // 旧版残留字段，语言一律跟随 Obsidian
      LANG = detectLang();
      if (!this.settings.deviceId) this.settings.deviceId = uuid();
      if (!this.settings.vaultId) this.settings.vaultId = uuid();
      this.deviceId = this.settings.deviceId;
      this.vaultId = this.settings.vaultId;
      if (!this.settings.devices) this.settings.devices = {};
      setIgnorePatterns(this.settings.ignorePatterns);

      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('lan-sync-status');
      this.statusEl.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.showStatusMenu();
      });
      this.ensureDot();
      if (Platform.isDesktopApp) {
        const st = window.setInterval(() => this.renderStatus(), 15000);
        this.register(() => clearInterval(st));
      }
      this.setStatus(this.settings.enabled ? tr('status.starting') : tr('status.disabled'), this.settings.enabled ? 'connecting' : 'off');

      this.addRibbonIcon('refresh-cw', tr('ribbon.sync'), () => this.manualSync());
      this.addCommand({ id: 'sync-now', name: tr('cmd.syncNow'), callback: () => this.manualSync() });
      this.addCommand({ id: 'reconnect', name: tr('cmd.reconnect'), callback: () => this.reconnect() });
      this.addCommand({
        id: 'pair-devices', name: tr('cmd.pairDevices'), callback: () => {
          if (this.server && !this.server.pairModal) this.server.showNextPair();
          else if (!this.server) new Notice(tr('notice.pairOnDesktop'));
        },
      });
      this.addSettingTab(new LanSyncSettingTab(this.app, this));

      // 冲突块的行内配色 + 阅读视图里的「保留这一版」
      this.ensureStyle();
      this.registerMarkdownPostProcessor((el, ctx) => this.decorateConflicts(el, ctx));
      this.registerInlineDecorations();
      this.addCommand({
        id: 'conflict-keep-desktop',
        name: tr('cmd.acceptRemote'),
        checkCallback: (checking) => this.resolveInActive(checking, 'remote'),
      });
      this.addCommand({
        id: 'conflict-keep-device',
        name: tr('cmd.acceptLocal'),
        checkCallback: (checking) => this.resolveInActive(checking, 'local'),
      });

      // 切换显示语言会立刻重启 Obsidian；若此刻配置读取失败，绝不能带着新的
      // vaultId 去启动，否则 2MB 索引失效、1.7 万文件全量重建会把界面拖死。
      if (loadFailed) {
        this.setStatus(tr('status.bootFailed', 'data.json'), 'error');
        return;
      }
      if (this.settings.enabled) {
        // 只有配置真的变化才写盘，避免每次启动都与 Obsidian 抢 data.json
        if (hadLanguage || !safe.deviceId || !safe.vaultId) this.saveData(this.settings).catch(() => {});
        this.scheduleStartup();
      }
    } catch (e) {
      console.error('[lan-sync] onload failed', e);
    }
  }

  // 开关是实时的：开启即启动服务/客户端，关闭即断开，不需要重启 Obsidian
  async setEnabled(v) {
    this.settings.enabled = !!v;
    await this.saveData(this.settings);
    if (v) {
      this.unloaded = false;
      this.setStatus(tr('status.starting'), 'connecting');
      this.scheduleStartup();
      return;
    }
    if (this.bootTimer) clearTimeout(this.bootTimer);
    try { if (this.server) this.server.stop(); } catch (e) { /* ignore */ }
    try { if (this.client) this.client.stop(); } catch (e) { /* ignore */ }
    this.server = null;
    this.client = null;
    this.setStatus(tr('status.disabled'), 'off');
  }

  scheduleStartup() {
    let scheduled = false;
    const start = () => {
      if (scheduled || this.unloaded) return;
      scheduled = true;
      // 语言设置到 workspace 就绪后才稳定：此时重取一次即可，无需任何手动选项
      LANG = detectLang();
      this.langTimer = window.setTimeout(() => { if (!this.unloaded) LANG = detectLang(); }, 1500);
      this.register(() => { if (this.langTimer) clearTimeout(this.langTimer); });
      // onload 立刻 resolve；读索引/扫库/监听端口都等界面首帧渲染完再开始
      this.bootTimer = window.setTimeout(() => {
        if (this.unloaded) return;
        this.boot().catch((e) => this.setStatus(tr('status.bootFailed', e && e.message ? e.message : e)));
      }, 1200);
      this.register(() => { if (this.bootTimer) clearTimeout(this.bootTimer); });
    };
    const ws = this.app && this.app.workspace;
    if (ws && typeof ws.onLayoutReady === 'function') {
      ws.onLayoutReady(start);
      // 个别版本 onLayoutReady 未触发时保底启动
      this.fallbackTimer = window.setTimeout(start, 3000);
      this.register(() => { if (this.fallbackTimer) clearTimeout(this.fallbackTimer); });
    } else {
      start();
    }
  }

  async boot() {
    if (this.booting || this.unloaded) return;
    if (this.server || this.client) return;   // 已经启动过，开关重复打开时不要重入
    this.booting = true;
    this.peerSeenAt = this.peerSeenAt || Date.now();
    try {
      if (Platform.isDesktopApp) {
        this.server = new SyncServer(this);
        await this.server.start();
      } else {
        this.client = new SyncClient(this);
        await this.client.start();
      }
    } finally {
      this.booting = false;
    }
  }

  onunload() {
    this.unloaded = true;
    // 卸载过程（尤其是语言切换引发的重启）不能被插件的清理逻辑打断
    try { if (this.server) this.server.stop(); } catch (e) { console.error('[lan-sync] server stop failed', e); }
    try { if (this.client) this.client.stop(); } catch (e) { console.error('[lan-sync] client stop failed', e); }
    this.server = null;
    this.client = null;
  }

  /* ---------- 状态指示：桌面状态栏 / 手机悬浮点 ---------- */

  setStatus(text, phase) {
    this.statusText = text;
    if (phase) this.phase = phase;
    if (text !== this.lastLogged) { this.lastLogged = text; dbg(this.app, 'status: ' + text); }
    this.renderStatus();
  }

  setPhase(phase) {
    if (!phase || this.phase === phase) return;
    this.phase = phase;
    this.renderStatus();
  }

  // 实际传输通常只有几十毫秒，直接切 phase 一闪就过去了，肉眼看不出在动。
  // 用一段时间窗口把“脉冲”状态撑住，让同步过程始终可见。
  pulseFor(ms) {
    const until = Date.now() + (ms || 700);
    if (until <= (this.pulseUntil || 0)) return;
    this.pulseUntil = until;
    this.renderStatus();
    setTimeout(() => this.renderStatus(), ms + 60);
  }

  setFileCount(n) {
    if (!n || this.fileCount === n) return;
    this.fileCount = n;
    this.renderStatus();
  }

  renderStatus() {
    const base = this.phase || 'idle';
    let phase = Date.now() < (this.pulseUntil || 0) ? 'writing' : base;
    let text = this.statusText;
    // 电脑端：有配对设备但长时间没有任何请求，说明对方关了同步/离线，别再显示“正常”绿点
    if (Platform.isDesktopApp && this.settings.enabled && phase === 'ready'
      && Object.keys(this.settings.devices || {}).length
      && this.peerSeenAt && Date.now() - this.peerSeenAt > 120000) {
      phase = 'pending';
      text = tr('status.waitPeer');
    }
    if (this.statusEl) {
      const el = this.statusEl;
      el.style.display = (!Platform.isMobileApp && this.settings.desktopFloat) ? 'none' : '';
      el.empty();
      el.title = text || '';
      el.setAttribute('aria-label', text || '');
      el.createSpan({ cls: 'lan-sync-dot is-' + phase });
      el.createSpan({ cls: 'lan-sync-count', text: this.fileCount ? String(this.fileCount) : '—' });
    }
    if (this.dotEl) {
      this.dotEl.className = 'lan-sync-float' + (Platform.isDesktopApp ? ' is-floating-desktop' : '') + ' is-' + phase;
      this.dotEl.title = text || '';
    }
  }

  // 手机端没有状态栏，用一个可拖动的悬浮点代替；长按出菜单，可以关掉
  // 手机端没有状态栏，电脑端则可以选择把状态点悬浮出来（右键状态栏切换）
  dotEnabled() {
    return Platform.isMobileApp ? !!this.settings.mobileDot : !!this.settings.desktopFloat;
  }

  dotPosField() {
    return Platform.isMobileApp ? 'dotPos' : 'desktopDotPos';
  }

  ensureDot() {
    if (!this.dotEnabled()) { this.removeDot(); return; }
    if (this.dotEl) return;
    const el = document.createElement('div');
    el.className = 'lan-sync-float is-' + (this.phase || 'idle');
    this.applyDotPos(el);
    this.attachDotHandlers(el);
    document.body.appendChild(el);
    this.dotEl = el;
    this.register(() => this.removeDot());
    this.renderStatus();
  }

  removeDot() {
    if (!this.dotEl) return;
    try { this.dotEl.remove(); } catch (e) { /* ignore */ }
    this.dotEl = null;
  }

  applyDotPos(el) {
    const pos = this.settings[this.dotPosField()];
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      el.style.left = Math.max(4, Math.min(window.innerWidth - 26, pos.x)) + 'px';
      el.style.top = Math.max(4, Math.min(window.innerHeight - 26, pos.y)) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }
  }

  attachDotHandlers(el) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false, timer = null;
    const point = (ev) => (ev.touches && ev.touches[0]) || ev;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    // 电脑端：右键出菜单；手机端没有右键，用长按代替
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      clearTimer();
      dragging = false;
      this.showDotMenu(el);
    });
    el.addEventListener('pointerdown', (ev) => {
      const p = point(ev);
      sx = p.clientX; sy = p.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      moved = false; dragging = true;
      try { if (ev.pointerId != null) el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      clearTimer();
      if (Platform.isMobileApp) {
        timer = setTimeout(() => {
          timer = null;
          if (!moved) { dragging = false; this.showDotMenu(el); }
        }, 550);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const p = point(ev);
      const dx = p.clientX - sx, dy = p.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 6) { moved = true; clearTimer(); }
      if (!moved) return;
      const x = Math.max(4, Math.min(window.innerWidth - 26, ox + dx));
      const y = Math.max(4, Math.min(window.innerHeight - 26, oy + dy));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      if (ev.cancelable) ev.preventDefault();
    });
    const finish = () => {
      clearTimer();
      if (!dragging) return;
      dragging = false;
      if (!moved) return;
      const rect = el.getBoundingClientRect();
      this.settings[this.dotPosField()] = { x: Math.round(rect.left), y: Math.round(rect.top) };
      this.saveSoon();
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  dotMenuItems(menu, forStatusBar) {
    const enabled = !!this.settings.enabled;
    menu.addItem((i) => i.setTitle(tr('dot.syncNow')).setIcon('refresh-cw').onClick(() => this.manualSync()));
    if (Platform.isMobileApp) {
      menu.addItem((i) => i.setTitle(tr('cmd.reconnect')).setIcon('wifi').onClick(() => this.reconnect()));
    }
    menu.addItem((i) => i.setTitle(enabled ? tr('dot.pause') : tr('dot.resume')).setIcon(enabled ? 'pause' : 'play')
      .onClick(() => this.setEnabled(!enabled)));
    menu.addSeparator();
    if (forStatusBar) {
      menu.addItem((i) => i.setTitle(tr('dot.float')).setIcon('move').onClick(() => {
        this.settings.desktopFloat = true;
        this.saveSoon();
        this.ensureDot();
        this.renderStatus();
      }));
    } else if (!Platform.isMobileApp) {
      menu.addItem((i) => i.setTitle(tr('dot.dock')).setIcon('panel-bottom').onClick(() => {
        this.settings.desktopFloat = false;
        this.settings.desktopDotPos = null;
        this.saveSoon();
        this.removeDot();
        this.renderStatus();
      }));
    } else {
      menu.addItem((i) => i.setTitle(tr('dot.hide')).setIcon('eye-off').onClick(() => {
        this.settings.mobileDot = false;
        this.settings.dotPos = null;
        this.saveSoon();
        this.removeDot();
        new Notice(tr('dot.hidden'));
      }));
    }
    menu.addItem((i) => i.setTitle(tr('dot.settings')).setIcon('settings').onClick(() => {
      this.app.setting.open();
      this.app.setting.openTabById(this.manifest.id);
    }));
  }

  showStatusMenu() {
    try {
      const menu = new Menu();
      this.dotMenuItems(menu, true);
      const r = this.statusEl ? this.statusEl.getBoundingClientRect() : null;
      if (r) menu.showAtPosition({ x: r.left, y: r.top - 8 });
      else menu.showAtMouseEvent(new MouseEvent('contextmenu'));
    } catch (e) { /* ignore */ }
  }

  showDotMenu(el) {
    try {
      const menu = new Menu();
      this.dotMenuItems(menu, false);
      const rect = el.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.top });
    } catch (e) { /* ignore */ }
  }

  saveSoon() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveData(this.settings).catch(() => {});
    }, 1500);
  }

  /* ---------- 冲突块的行内呈现 ---------- */

  ensureStyle() {
    if (this.styleEl) return;
    try {
      const el = document.createElement('style');
      el.id = 'lan-sync-conflict-style';
      el.textContent = CONFLICT_CSS;
      document.head.appendChild(el);
      this.styleEl = el;
      this.register(() => { try { el.remove(); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  }

  // 实时预览里给冲突行加底色：只做行级装饰，出错也只影响观感，不影响编辑
  registerInlineDecorations() {
    try {
      const view = require('@codemirror/view');
      const state = require('@codemirror/state');
      if (!view || !view.Decoration || !view.ViewPlugin || !state || !state.RangeSetBuilder) return;
      const app = this.app;
      const remoteLine = view.Decoration.line({ class: 'lan-sync-cf-remote' });
      const localLine = view.Decoration.line({ class: 'lan-sync-cf-local' });
      const build = (v) => {
        const builder = new state.RangeSetBuilder();
        try {
          const doc = v.state.doc;
          const ranges = v.visibleRanges && v.visibleRanges.length ? v.visibleRanges : [{ from: 0, to: doc.length }];
          let mode = '';
          let n = doc.lineAt(ranges[0].from).number;
          const last = doc.lineAt(ranges[ranges.length - 1].to).number;
          for (; n <= last; n++) {
            const line = doc.line(n);
            const t = line.text;
            if (t.startsWith('%% lan-sync:conflict:remote')) mode = 'remote';
            else if (t.startsWith('%% lan-sync:conflict:local')) mode = 'local';
            else if (t.startsWith('%% /lan-sync:conflict')) mode = '';
            if (mode && t.startsWith('>')) builder.add(line.from, line.from, mode === 'remote' ? remoteLine : localLine);
          }
          // 刚同步进来的那几行不再做高亮动效
        } catch (e) { /* ignore */ }
        return builder.finish();
      };
      const ext = view.ViewPlugin.fromClass(class {
        constructor(v) { this.decorations = build(v); }
        update(u) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
      }, { decorations: (v) => v.decorations });
      this.registerEditorExtension(ext);
    } catch (e) { /* 没有 CodeMirror 模块时只用 callout 配色 */ }
  }

  // 阅读视图：每个冲突 callout 下面挂一个「保留这一版」按钮
  decorateConflicts(el, ctx) {
    let calls;
    try {
      calls = el.querySelectorAll('.callout[data-callout="lan-sync-remote"], .callout[data-callout="lan-sync-local"]');
    } catch (e) { return; }
    if (!calls.length || !ctx || !ctx.sourcePath) return;
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!file) return;
    calls.forEach((call) => {
      if (call.querySelector('.lan-sync-keep')) return;
      const keep = call.getAttribute('data-callout') === 'lan-sync-remote' ? 'remote' : 'local';
      const titleEl = call.querySelector('.callout-title-inner');
      const m = /(\d{2}-\d{2} \d{2}:\d{2})/.exec(titleEl ? titleEl.textContent || '' : '');
      const btn = document.createElement('button');
      btn.className = 'lan-sync-keep';
      btn.textContent = tr('conflict.keepThis');
      btn.onclick = async (ev) => {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        const ok = await this.resolveConflict(file, keep, m ? m[1] : '');
        new Notice(ok ? tr('notice.resolveDone') : tr('notice.noConflict'));
      };
      const row = document.createElement('div');
      row.className = 'lan-sync-keep-row';
      row.appendChild(btn);
      call.appendChild(row);
    });
  }

  async resolveConflict(file, keep, stamp) {
    let done = false;
    await this.app.vault.process(file, (text) => {
      const list = findConflicts(text);
      if (!list.length) return text;
      const hit = (stamp && list.find((c) => c.stamp.indexOf(stamp) >= 0)) || list[0];
      done = true;
      return resolveConflictText(text, hit, keep);
    });
    return done;
  }

  resolveInActive(checking, keep) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return false;
    if (checking) return true;
    this.resolveConflict(file, keep, '').then((ok) => {
      new Notice(ok ? tr('notice.resolveDone') : tr('notice.noConflict'));
    }).catch(() => {});
    return true;
  }

  async manualSync() {
    if (!this.client && !this.server) { new Notice(tr('notice.stillStarting')); return; }
    if (this.client) {
      if (!this.client.connected) { await this.client.connect(); return; }
      await this.client.tick(true);
      new Notice(tr('notice.status', this.statusText));
    } else if (this.server) {
      await this.server.rescan();
      new Notice(tr('notice.desktopIndex', this.server.files.size));
    }
  }

  async reconnect() {
    if (!this.client) { new Notice(tr('notice.noClient')); return; }
    this.client.endpoint = null;
    this.client.connected = false;
    // 远端索引已落盘，重连后从保存的 rev 继续增量，不再重拉全量快照
    this.settings.endpoint = null;
    await this.client.connect();
    new Notice(tr('notice.status', this.statusText));
  }
}

class LanSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.timer = null;
    this.plugin.register(() => { if (this.timer) clearInterval(this.timer); });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: tr('app.title') });
    containerEl.createEl('p', {
      text: tr('settings.intro'),
      cls: 'setting-item-description',
    });

    // ---- 状态卡：开关、状态、数字瓦片、操作按钮同屏 ----
    const card = containerEl.createDiv({ cls: 'lan-sync-card' });
    const head = card.createDiv({ cls: 'lan-sync-card-head' });
    const cardDot = head.createDiv({ cls: 'lan-sync-card-dot' });
    const headTxt = head.createDiv();
    const titleEl = headTxt.createDiv({ cls: 'lan-sync-card-title' });
    const subEl = headTxt.createDiv({ cls: 'lan-sync-card-sub' });
    new Setting(head).addToggle((t) => t.setValue(!!this.plugin.settings.enabled).onChange(async (v) => {
      await this.plugin.setEnabled(v);
      refresh();
      new Notice(v ? tr('notice.enabled') : tr('notice.disabled'));
    }));

    const tiles = card.createDiv({ cls: 'lan-sync-tiles' });
    const mkTile = (label) => {
      const el = tiles.createDiv({ cls: 'lan-sync-tile' });
      return { b: el.createEl('b'), s: el.createEl('span', { text: label }) };
    };
    const tFiles = mkTile(tr('settings.tileFiles'));
    const tDev = mkTile(tr('settings.tileDevices'));
    const tLast = mkTile(tr('settings.tileLast'));

    const actions = card.createDiv({ cls: 'lan-sync-actions' });
    const btnSync = actions.createEl('button', { cls: 'mod-cta' });
    const btnSide = actions.createEl('button');

    const refresh = () => {
      const on = !!this.plugin.settings.enabled;
      card.toggleClass('is-off', !on);
      cardDot.className = 'lan-sync-card-dot is-' + (on ? (this.plugin.phase || 'idle') : 'off');
      titleEl.setText(on ? tr('settings.runningTitle') : tr('settings.pausedTitle'));
      subEl.setText(on ? (this.plugin.statusText || '—') : tr('settings.pausedDesc'));
      const srv = this.plugin.server;
      const files = this.plugin.fileCount || (srv && srv.files ? srv.files.size : 0);
      tFiles.b.setText(files ? String(files) : '—');
      tDev.b.setText(String(this.plugin.client
        ? (this.plugin.settings.pairToken ? 1 : 0)
        : Object.keys(this.plugin.settings.devices || {}).length));
      const c = this.plugin.client;
      const at = (c && c.lastSyncAt) || this.plugin.peerSeenAt;
      tLast.b.setText(at ? fmtStamp(at) : '—');
      const side = () => (this.plugin.client ? tr('settings.btnFind') : tr('settings.btnRescan'));
      btnSync.setText(this.busySync ? tr('settings.btnSyncing') : tr('settings.btnSync'));
      btnSide.setText(this.busySide ? (this.plugin.client ? tr('settings.btnSyncing') : tr('settings.btnRescanning')) : side());
      btnSync.disabled = btnSide.disabled = !on || this.busySync || this.busySide;
    };

    const runSide = async () => {
      if (this.busySide) return;
      this.busySide = true; refresh();
      try {
        if (this.plugin.client) await this.plugin.reconnect();
        else if (this.plugin.server) await this.plugin.server.rescan();
      } finally { this.busySide = false; refresh(); }
    };
    btnSync.onclick = async () => {
      if (this.busySync) return;
      this.busySync = true; refresh();
      try { await this.plugin.manualSync(); } finally { this.busySync = false; refresh(); }
    };
    btnSide.onclick = runSide;

    refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = window.setInterval(refresh, 1000);

    if (Platform.isMobileApp) {
      new Setting(containerEl)
        .setName(tr('settings.mobileDot'))
        .setDesc(tr('settings.mobileDotDesc'))
        .addToggle((t) => t.setValue(!!this.plugin.settings.mobileDot).onChange(async (v) => {
          this.plugin.settings.mobileDot = v;
          if (!v) this.plugin.settings.dotPos = null;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.ensureDot();
        }));
    }

    containerEl.createEl('h3', { text: tr('settings.devices') });
    const deviceBox = containerEl.createDiv();
    const renderDevices = () => {
      deviceBox.empty();
      if (!Platform.isDesktopApp) {
        deviceBox.createEl('p', {
          text: this.plugin.settings.pairToken
            ? tr('settings.mobileAuthorized')
            : tr('settings.mobilePending'),
          cls: 'setting-item-description',
        });
        return;
      }
      const srv = this.plugin.server;
      if (!srv) { deviceBox.createEl('p', { text: tr('settings.serverStarting'), cls: 'setting-item-description' }); return; }

      const pending = srv.pendingList();
      deviceBox.createEl('h4', { text: tr('settings.pendingTitle', pending.length) });
      if (!pending.length) {
        deviceBox.createEl('p', { text: tr('settings.noPending'), cls: 'setting-item-description' });
      }
      for (const r of pending) {
        new Setting(deviceBox)
          .setName(r.name)
          .setDesc('IP ' + r.ip + ' · ' + new Date(r.at).toLocaleString() + (r.state === 'rejected' ? tr('device.rejectedTag') : ''))
          .addButton((b) => b.setButtonText(tr('pair.allow')).setCta().onClick(() => { srv.approvePair(r.deviceId); renderDevices(); refresh(); }))
          .addButton((b) => b.setButtonText(tr('pair.reject')).onClick(() => { srv.rejectPair(r.deviceId); renderDevices(); refresh(); }));
      }

      const devices = this.plugin.settings.devices || {};
      const ids = Object.keys(devices);
      deviceBox.createEl('h4', { text: tr('settings.allowedTitle', ids.length) });
      if (!ids.length) deviceBox.createEl('p', { text: tr('settings.noDevices'), cls: 'setting-item-description' });
      for (const id of ids) {
        const d = devices[id];
        new Setting(deviceBox)
          .setName(d.name || id.slice(0, 6))
          .setDesc(tr('settings.authorizedAt', d.ip || '—', new Date(d.at || 0).toLocaleString()))
          .addButton((b) => b.setButtonText(tr('settings.btnRemove')).setWarning().onClick(() => {
            srv.removeDevice(id);
            renderDevices();
            refresh();
            new Notice(tr('notice.deviceRemoved'));
          }));
      }
    };
    renderDevices();

    // ---- 同步范围：默认折叠成 chips，点「编辑」才展开 ----
    containerEl.createEl('h3', { text: tr('settings.ignore') });
    const scopeCard = containerEl.createDiv({ cls: 'lan-sync-card' });
    const sHead = scopeCard.createDiv({ cls: 'lan-sync-card-head' });
    const sTxt = sHead.createDiv();
    const sCount = sTxt.createDiv({ cls: 'lan-sync-card-sub' });
    const sBtns = sHead.createDiv();
    sBtns.style.marginLeft = 'auto';
    sBtns.style.display = 'flex';
    sBtns.style.gap = '6px';
    const editBtn = sBtns.createEl('button', { text: tr('settings.btnEdit') });
    const resetBtn = sBtns.createEl('button', { text: tr('settings.ignoreReset') });
    const chips = scopeCard.createDiv({ cls: 'lan-sync-chips' });
    const editorBox = scopeCard.createDiv();
    editorBox.style.display = 'none';

    const curRules = () => {
      const s = this.plugin.settings.ignorePatterns;
      return s && s.length ? s : DEFAULT_IGNORE;
    };
    const renderScope = () => {
      const lines = curRules();
      sCount.setText(tr('settings.ignoreDesc'));
      chips.empty();
      for (const l of lines.slice(0, 6)) chips.createEl('span', { cls: 'lan-sync-chip', text: l });
      if (lines.length > 6) chips.createEl('span', { cls: 'lan-sync-chip', text: '+' + (lines.length - 6) });
    };
    renderScope();

    let taEl = null;
    editBtn.onclick = () => {
      const open = editorBox.style.display === 'none';
      editorBox.style.display = open ? 'block' : 'none';
      editBtn.setText(open ? tr('settings.btnCollapse') : tr('settings.btnEdit'));
      if (open && !taEl) {
        new Setting(editorBox).addTextArea((t) => {
          taEl = t.inputEl;
          t.setValue(curRules().join('\n'));
          t.inputEl.rows = 9;
          t.inputEl.style.width = '100%';
          t.inputEl.style.fontFamily = 'var(--font-monospace)';
          t.onChange(async (v) => {
            const ls = v.split('\n').map((s) => s.trim()).filter(Boolean);
            this.plugin.settings.ignorePatterns = ls.length ? ls : null;
            setIgnorePatterns(ls);
            await this.plugin.saveData(this.plugin.settings);
            renderScope();
          });
        });
      }
    };
    resetBtn.onclick = async () => {
      this.plugin.settings.ignorePatterns = null;
      setIgnorePatterns(null);
      await this.plugin.saveData(this.plugin.settings);
      if (taEl) taEl.value = DEFAULT_IGNORE.join('\n');
      renderScope();
    };

    // ---- 规则说明：折叠，避免一进设置就被大段文字糊脸 ----
    const help = containerEl.createEl('details', { cls: 'lan-sync-card' });
    help.createEl('summary', { text: tr('settings.help') }).style.cursor = 'pointer';
    const cols = help.createDiv({ cls: 'lan-sync-help-cols' });
    cols.style.marginTop = '10px';
    const yes = cols.createDiv();
    yes.createEl('b', { text: tr('settings.helpYes') });
    yes.createEl('div', { cls: 'lan-sync-help-pre', text: tr('settings.helpYesBody') });
    const no = cols.createDiv();
    no.createEl('b', { text: tr('settings.helpNo') });
    no.createEl('div', { cls: 'lan-sync-help-pre', text: tr('settings.helpNoBody') });
    help.createEl('div', { cls: 'lan-sync-help-pre', text: tr('settings.helpConflict') }).style.marginTop = '10px';
  }
}

module.exports = LanSyncPlugin;
