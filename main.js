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
 *  - 双向都改 → 保留本地，远端内容另存 xxx.conflict-<设备>-<时间>.md
 *  - 忽略 .obsidian / .trash / .git，避免配置与设备身份互相污染
 *  - onload 立即返回，索引/扫库/网络发现全部后台进行，避免手机端“插件加载时间过长”
 *  - 零输入配对：手机自动申请，电脑端弹窗点一次「允许」即授权；之后每个请求带设备令牌，
 *    未授权设备读不到索引、拿不到文件，也不能写入或删除
 */
const { Plugin, PluginSettingTab, Setting, Notice, Platform, Modal, requestUrl } = require('obsidian');

const APP_ID = 'lan-sync';
const API = '/lan-sync';
const BASE_PORT = 47800;
const PORT_COUNT = 3;
const POLL_MS = 1200;
const MAX_FILE = 100 * 1024 * 1024;
const LOG_LIMIT = 20000;
const PERSIST_LOG = 2000;      // 索引文件中保留的变更日志条数
const INDEX_VERSION = 2;
const IGNORE = ['.obsidian', '.trash', '.git'];
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
  'notice.enabled': ['已启用，重启 Obsidian 生效', 'Enabled; restart Obsidian to apply'],
  'notice.disabled': ['已关闭，重启 Obsidian 生效', 'Disabled; restart Obsidian to apply'],

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
  'device.authorized': ['已授权设备', 'Authorized device'],
  'device.unknown': ['未知设备', 'Unknown device'],
  'device.rejectedTag': [' · 曾拒绝', ' · previously rejected'],

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
  'settings.enableDesc': ['关闭后需重启 Obsidian 才会完全停止', 'Requires an Obsidian restart to stop completely'],
  'settings.syncNow': ['立即同步', 'Sync now'],
  'settings.syncNowDesc': ['手动触发一次完整对账', 'Run a full reconciliation now'],
  'settings.btnSync': ['同步', 'Sync'],
  'settings.reconnect': ['重新查找电脑', 'Find computer again'],
  'settings.reconnectDesc': ['换 Wi-Fi 或找不到电脑时使用', 'Use after changing Wi-Fi or when the computer cannot be found'],
  'settings.btnFind': ['查找', 'Find'],
  'settings.rescan': ['重新对账索引', 'Recheck index'],
  'settings.rescanDesc': ['只比对元数据，重新哈希有变化的文件；不再全盘重扫', 'Compares metadata only and re-hashes changed files; no full rescan'],
  'settings.btnRescan': ['对账', 'Check'],

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
  'scope.headYes': ['会同步', 'Synced'],
  'scope.headNo': ['不同步', 'Excluded'],
  'scope.yes1': ['所有笔记：.md、.canvas、.base、.excalidraw', 'All notes: .md, .canvas, .base, .excalidraw'],
  'scope.yes2': ['任意附件：图片、PDF、音视频、zip 等二进制（不限制扩展名）', 'Any attachment: images, PDFs, audio, video, zip (no extension whitelist)'],
  'scope.yes3': ['库里的普通 .json / .js / .css 等文件', 'Ordinary .json / .js / .css files inside the vault'],
  'scope.yes4': ['插件生成的 xxx.conflict-*.md 冲突副本', 'xxx.conflict-*.md conflict copies created by the plugin'],
  'scope.no1': ['.obsidian/ 下的一切：所有插件、主题、app.json、workspace.json、community-plugins.json、热键与布局', 'Everything under .obsidian/: plugins, themes, app.json, workspace.json, community-plugins.json, hotkeys and layout'],
  'scope.no2': ['插件自身数据：data.json、index.json、state.json、remote-index.json、debug.log', 'Plugin data: data.json, index.json, state.json, remote-index.json, debug.log'],
  'scope.no3': ['.trash/（删除进回收站的文件不会被拉回来）、.git/', '.trash/ (trashed files are not pulled back) and .git/'],
  'scope.no4': ['~ 开头的临时文件、.tmp / .part、单文件超过 {0}MB', 'Temp files starting with ~, .tmp / .part, and single files over {0}MB'],
  'scope.note': ['过滤依据：{0}（库根目录下按路径前缀）、~ 开头与 .tmp / .part、单文件大小上限。扩展名只决定写入方式，不是同步白名单；子目录里同名的 .obsidian 文件夹仍会被同步。由于 .obsidian 不同步，两端插件需要各自安装与更新。', 'Filter: {0} by path prefix at the vault root, temp files starting with ~ or ending in .tmp / .part, and a per-file size limit. Extensions only affect how files are written, not what syncs. A nested folder named .obsidian is still synced. Because .obsidian is excluded, install and update the plugin on both devices separately.'],
};

function detectLang() {
  let raw = '';
  try { raw = window.localStorage.getItem('language') || ''; } catch (e) { /* ignore */ }
  if (!raw) { try { raw = (typeof moment !== 'undefined' && moment.locale) ? moment.locale() : ''; } catch (e) { /* ignore */ } }
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

function shouldIgnore(path) {
  if (!path) return true;
  const p = String(path).replace(/^\/+/, '');
  for (const pre of IGNORE) {
    if (p === pre || p.startsWith(pre + '/')) return true;
  }
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (!base) return true;
  if (base.startsWith('~') || base.endsWith('.tmp') || base.endsWith('.part')) return true;
  return false;
}

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

// 同一个文件的写操作串行化：索引文件较大，并发 write 可能写坏 JSON
const writeChains = new Map();
async function writeJsonFile(adapter, path, obj) {
  const prev = writeChains.get(path) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => adapter.write(path, JSON.stringify(obj)));
  writeChains.set(path, job);
  try { await job; }
  finally { if (writeChains.get(path) === job) writeChains.delete(path); }
}

function isTextPath(path) {
  const dot = String(path).lastIndexOf('.');
  return dot > 0 && TEXT_EXT.has(String(path).slice(dot).toLowerCase());
}

function isOpenInEditor(app, path) {
  try {
    const ws = app.workspace;
    const active = ws.getActiveFile && ws.getActiveFile();
    if (active && active.path === path) return true;
    if (ws.getLeavesOfType) {
      for (const leaf of ws.getLeavesOfType('markdown')) {
        const v = leaf.view;
        if (v && v.file && v.file.path === path) return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

// 文本文件走 Vault.process：打开中的编辑器会同步刷新，不再用 adapter 直接覆盖磁盘
async function writeViaVault(app, path, ab) {
  const af = app.vault.getAbstractFileByPath(path);
  if (af && !af.children && isTextPath(path) && typeof app.vault.process === 'function') {
    try {
      const text = new TextDecoder('utf-8').decode(ab);
      await withTimeout(app.vault.process(af, () => text), 30000, tr('task.update', path));
      return;
    } catch (e) { /* 退回直接写盘 */ }
  }
  await writeFileBytes(app, path, ab);
}

// 轻量诊断日志：内存缓冲 + 节流落盘，避免手机端每次状态变化都读写文件
let dbgBuffer = [];
let dbgTimer = null;
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
  }

  dir() {
    return (this.plugin.manifest && this.plugin.manifest.dir) || '.obsidian/plugins/lan-sync';
  }

  cachePath() { return this.dir() + '/hash-cache.json'; }  // 旧版缓存：仅用于一次性迁移
  indexPath() { return this.dir() + '/index.json'; }

  async start() {
    const restored = await this.loadIndex();
    const ok = await this.listen();
    if (!ok) {
      this.plugin.setStatus(tr('status.serverPortTaken'));
      return;
    }
    this.registerEvents();
    // 外部（资源管理器）删除不一定触发 vault 事件，1 分钟做一次纯内存元数据对账兜底
    this.scanTimer = setInterval(() => { this.rescan().catch(() => {}); }, 60000);

    if (restored) {
      // 索引文件已存在：只做一次 stat 对比，仅元数据变化的文件才读盘哈希
      this.plugin.setStatus(tr('status.checkingIndex'));
      const r = await this.scanDiff({ quiet: true });
      this.markReady();
      if (r && r.suspect) this.watchVault();
    } else {
      // 首次运行才全量建索引，之后一律由 index.json + 事件/定时增量接管
      this.plugin.setStatus(tr('status.buildingIndex'));
      this.buildIndex()
        .then(() => this.markReady())
        .catch((e) => this.plugin.setStatus(tr('status.indexFailed', e.message || e)));
    }
  }

  markReady() {
    this.ready = true;
    this.updateStatus();
    this.saveIndexNow().catch(() => {});
    if (this.pending.size) this.flushPending().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.pairModal) { try { this.pairModal.close(); } catch (e) { /* ignore */ } this.pairModal = null; }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
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
    this.plugin.setStatus(tr('status.ready', this.port, this.files.size, tail));
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
        srv.once('error', () => resolve(false));
        srv.listen(port, '0.0.0.0', () => resolve(true));
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
    try {
      const obj = JSON.parse(await this.app.vault.adapter.read(this.indexPath()));
      if (obj && obj.version === INDEX_VERSION && obj.vault === this.plugin.vaultId && obj.files) {
        for (const [p, v] of Object.entries(obj.files)) {
          if (shouldIgnore(p) || !Array.isArray(v) || v.length !== 3) continue;
          const meta = { hash: v[0], size: v[1], mtime: v[2] };
          this.files.set(p, meta);
          this.hashCache.set(p, meta);
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
      const obj = JSON.parse(await this.app.vault.adapter.read(this.cachePath()));
      for (const [p, v] of Object.entries(obj || {})) {
        if (shouldIgnore(p) || !Array.isArray(v) || v.length !== 3) continue;
        const meta = { size: v[0], mtime: v[1], hash: v[2] };
        this.files.set(p, meta);
        this.hashCache.set(p, meta);
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
      if (++n % 500 === 0) this.plugin.setStatus(tr('status.indexing', n, list.length));
    }
    this.files = next;
    this.hashCache = new Map(next);
    // 首次建库不逐文件 bump rev，否则变更日志会被撑爆；客户端会走一次 reset 快照
    this.rev = (this.rev || 0) + 1;
    this.log = [];
    this.saveIndex();
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
      let hashed = 0;
      for (const f of this.app.vault.getFiles()) {
        if (shouldIgnore(f.path)) continue;
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
      // 库还没扫完时 getFiles() 会缺一大半，绝不能当成“用户删光了”
      if (next.size > 0) this.vaultSeen = true;
      const suspect = (this.files.size > 0 && !this.vaultSeen && next.size === 0)
        || (this.files.size > 20 && next.size < Math.floor(this.files.size * 0.9));
      for (const [path, meta] of next) {
        if (!sameMeta(this.files.get(path), meta)) this.setEntry(path, meta, true);
      }
      if (!suspect) {
        for (const path of [...this.files.keys()]) if (!next.has(path)) this.removeEntry(path);
      }
      if (!quiet && hashed) this.plugin.setStatus(tr('status.rehash', hashed));
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
    }, 350);
  }

  async flushPending() {
    const paths = [...this.pending];
    this.pending.clear();
    for (const path of paths) {
      const af = this.app.vault.getAbstractFileByPath(path);
      if (!af || af.children) continue;
      const st = af.stat || {};
      let hash = null;
      try { hash = await this.hashFor(path, st.size || 0, st.mtime || 0); } catch (e) { continue; }
      this.setEntry(path, { hash, size: st.size || 0, mtime: st.mtime || 0 }, true);
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
      if (d && d.token && d.token === t) return true;
    }
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
    this.plugin.setStatus(tr('status.allowed', r.name));
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
        const onDisk = this.app.vault.getAbstractFileByPath(p);
        if (!sameContent || !onDisk) {
          await writeViaVault(this.app, p, ab);
          const af2 = this.app.vault.getAbstractFileByPath(p);
          const st = af2 && af2.stat;
          this.setEntry(p, { hash, size: buf.length, mtime: st && st.mtime ? st.mtime : Date.now() }, true);
        }
        json(200, { hash });
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
        if (size > MAX_FILE) { clearTimeout(timer); req.destroy(); reject(new Error('too large')); return; }
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

    // 索引文件已在手，不必等库扫完：先按索引工作，删除判定等 vaultReady 再放开
    this.scheduleVaultReady();
    this.connect();
  }

  // 本地文件数远少于索引记录：说明库还没扫完（或用户真的删了一大批）
  vaultLooksIncomplete() {
    const expect = Math.max(this.state.size, this.remoteIndex.size);
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
    this.saveStateNow();
    this.saveRemoteNow();
  }

  /* ---------- 状态持久化 ---------- */

  async loadState() {
    try {
      const text = await this.app.vault.adapter.read(this.statePath());
      const obj = JSON.parse(text);
      for (const [p, v] of Object.entries(obj.files || {})) {
        if (shouldIgnore(p) || !Array.isArray(v) || v.length !== 3) continue;
        this.state.set(p, v);
        this.localIndex.set(p, { hash: v[2], size: v[0], mtime: v[1] });
      }
      for (const [p, h] of Object.entries(obj.base || {})) this.base.set(p, h);
    } catch (e) { /* 首次运行 */ }
  }

  // 远端索引单独落盘：手机重启后从保存的 rev 继续增量，不必再拉 1.7 万行全量快照
  async loadRemoteIndex() {
    try {
      const obj = JSON.parse(await this.app.vault.adapter.read(this.remotePath()));
      if (!obj || !obj.files) return;
      for (const [p, v] of Object.entries(obj.files)) {
        if (!shouldIgnore(p) && Array.isArray(v) && v.length === 3)
          this.remoteIndex.set(p, { hash: v[0], size: v[1], mtime: v[2] });
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
    setTimeout(() => { this.tickPending = false; this.tick(false); }, 500);
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
    this.plugin.setStatus(tr('status.waitPair'));
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
        this.plugin.setStatus(tr('status.paired'));
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
    this.plugin.setStatus(tr('status.findServer'));
    try {
      const ep = await withTimeout(
        findServer(this.endpoint, (pre) => this.plugin.setStatus(tr('status.findSubnet', pre))),
        120000, tr('task.findServer')
      );
      if (!ep) {
        this.connected = false;
        dbg(this.app, '未找到电脑（已扫描）');
        this.plugin.setStatus(tr('status.serverNotFound'));
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
      this.plugin.setStatus(tr('status.connected', ep.host, ep.port));
      await this.tick(true);
    } catch (e) {
      this.handleError(e);
      this.connected = false;
      this.plugin.setStatus(tr('status.connectFailed', e.message || e));
    } finally {
      this.discovering = false;
    }
  }

  markDisconnected(reason) {
    this.connected = false;
    // 索引已落盘：重连后从保存的 rev 继续增量，不再丢弃快照重拉全量
    this.plugin.setStatus(tr('status.disconnected', reason ? tr('status.reason', reason) : ''));
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
    if (changed || forceAll || this.dirty.size > 0 || this.candidates.size > 0) {
      await this.reconcile(forceAll);
    } else if (force) this.plugin.setStatus(tr('status.upToDate', this.endpoint ? this.endpoint.host : ''));
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
    for (const p of todo) {
      if (shouldIgnore(p)) continue;
      const L = this.localIndex.get(p);
      const R = this.remoteIndex.get(p);
      const B = this.base.get(p);
      const Lh = L ? L.hash : undefined;
      const Rh = R ? R.hash : undefined;
      if (Lh !== Rh && Rh !== undefined && this.shouldDeferPull(p)) {
        this.candidates.add(p);  // 正在编辑：这轮不覆盖编辑器，下轮再试
        continue;
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
            await this.pull(p, R);
            this.base.set(p, Rh);
            this.stats.pulled++;
          }
          ops++;
          continue;
        }

        // 两边都有且内容不同
        if (B !== undefined && B === Lh) {
          await this.pull(p, R);
          this.base.set(p, Rh);
          this.stats.pulled++;
        } else if (B !== undefined && B === Rh) {
          await this.push(p, L);
          this.base.set(p, Lh);
          this.stats.pushed++;
        } else if (B === undefined) {
          // 首次配对、没有基准：按修改时间新者胜，不产生冲突副本
          const lm = (L && L.mtime) || 0;
          const rm = (R && R.mtime) || 0;
          if (lm > rm + 2000) {
            await this.push(p, L);
            this.base.set(p, Lh);
            this.stats.pushed++;
          } else {
            await this.pull(p, R);
            this.base.set(p, Rh);
            this.stats.pulled++;
          }
        } else {
          await this.conflict(p, L, R);
          this.stats.conflicts++;
        }
        ops++;
      } catch (e) {
        console.error('[lan-sync] sync failed for file', p, e);
        this.candidates.add(p);  // 失败的文件留在候选集，下轮重试
      }
      if (ops % 10 === 0) this.plugin.setStatus(tr('status.syncing', ops));
    }

    this.lastSyncAt = Date.now();
    if (ops > 0) this.plugin.setStatus(tr('status.synced', ops, this.endpoint.host));
    else if (this.connected) this.plugin.setStatus(tr('status.upToDate', this.endpoint ? this.endpoint.host : ''));
    dbg(this.app, 'reconcile: 操作 ' + ops + ' 拉取=' + this.stats.pulled + ' 推送=' + this.stats.pushed + ' 删除=' + this.stats.deleted + ' 冲突=' + this.stats.conflicts);
    this.remoteDeletes.clear();
    this.saveState();
  }

  /* ---------- 传输 ---------- */

  // 编辑器里正在写的文件：先别用远端内容覆盖，等本地保存后由 modify 事件重新入队
  shouldDeferPull(path) {
    if (!isOpenInEditor(this.app, path)) return false;
    if (this.dirty.has(path)) return true;
    const af = this.app.vault.getAbstractFileByPath(path);
    const st = af && af.stat;
    return !!(st && Date.now() - st.mtime < 5000);
  }

  async pull(p, R) {
    const ab = await httpBinary(baseUrl(this.endpoint) + API + '/file?path=' + encodeURIComponent(p), 60000, this.authHeaders());
    if (ab.byteLength > MAX_FILE) return;
    // 磁盘上已是同样内容就不写，避免无意义的 mtime 抖动
    let existing = null;
    try { existing = await readFileBytes(this.app, p); } catch (e) { existing = null; }
    let hash;
    if (existing && existing.byteLength === ab.byteLength) {
      const a = await hashBytes(existing);
      if (a === R.hash) {
        hash = a;
        this.localIndex.set(p, { hash, size: ab.byteLength, mtime: R.mtime });
        this.base.set(p, hash);
        this.dirty.delete(p);
        return;
      }
    }
    await writeViaVault(this.app, p, ab);
    hash = await hashBytes(ab);
    this.localIndex.set(p, { hash, size: ab.byteLength, mtime: R.mtime });
    const af = this.app.vault.getAbstractFileByPath(p);
    if (af && af.stat) this.state.set(p, [af.stat.size, af.stat.mtime, hash]);
    else this.state.set(p, [ab.byteLength, Date.now(), hash]);
    this.stateDirty = true;
    this.dirty.delete(p);
  }

  async push(p, L) {
    const ab = await readFileBytes(this.app, p);
    if (ab.byteLength > MAX_FILE) return;
    const res = await httpPutBinary(
      baseUrl(this.endpoint) + API + '/file?path=' + encodeURIComponent(p),
      ab, 60000, this.authHeaders()
    );
    const hash = (res && res.hash) || (L && L.hash);
    if (hash) {
      this.remoteIndex.set(p, { hash, size: ab.byteLength, mtime: Date.now() });
      this.saveRemote();
    }
  }

  // 电脑端删除 → 手机端真正删掉本地文件（而不是请电脑再删一次）
  async deleteLocal(p) {
    const af = this.app.vault.getAbstractFileByPath(p);
    if (af && !af.children) {
      try { await this.app.vault.trash(af, false); }
      catch (e) {
        try { await this.app.vault.adapter.remove(p); } catch (e2) { /* 已不存在 */ }
      }
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

  async conflict(p, L, R) {
    // 电脑版本另存冲突副本；本地版本保留并推送回电脑
    const remoteAb = await httpBinary(baseUrl(this.endpoint) + API + '/file?path=' + encodeURIComponent(p), 60000, this.authHeaders());
    const cp = conflictPath(p, this.plugin.deviceId.slice(0, 6));
    await writeFileBytes(this.app, cp, remoteAb);
    const remoteHash = await hashBytes(remoteAb);
    const afc = this.app.vault.getAbstractFileByPath(cp);
    if (afc && afc.stat) this.state.set(cp, [afc.stat.size, afc.stat.mtime, remoteHash]);
    else this.state.set(cp, [remoteAb.byteLength, Date.now(), remoteHash]);
    this.stateDirty = true;
    const meta = { hash: remoteHash, size: remoteAb.byteLength, mtime: Date.now() };
    this.localIndex.set(cp, meta);
    this.remoteIndex.set(cp, meta);
    this.base.set(cp, remoteHash);
    await this.push(cp, meta);
    await this.push(p, L);
    this.base.set(p, L.hash);
  }
}

function conflictPath(path, tag) {
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = '' + ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const baseName = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return dir + baseName + '.conflict-' + tag + '-' + stamp + ext;
}

/* ============================ 插件 ============================ */

const DEFAULT_SETTINGS = {
  enabled: true,
  deviceId: '',
  vaultId: '',
  endpoint: null,
  devices: {},      // 电脑端：已授权设备 deviceId -> {name,ip,at,token}
  pairToken: '',    // 手机端：配对得到的令牌
  pairVault: '',    // 手机端：令牌对应的库，换库自动重新配对
};

class LanSyncPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    delete this.settings.language;  // 旧版残留字段，语言一律跟随 Obsidian
    LANG = detectLang();
    if (!this.settings.deviceId) this.settings.deviceId = uuid();
    if (!this.settings.vaultId) this.settings.vaultId = uuid();
    this.deviceId = this.settings.deviceId;
    this.vaultId = this.settings.vaultId;
    if (!this.settings.devices) this.settings.devices = {};

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('lan-sync-status');
    this.setStatus(tr('status.starting'));

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

    if (this.settings.enabled) {
      this.saveData(this.settings).catch(() => {});
      // 关键：onload 必须立刻 resolve。读索引、扫库、网络发现全部放到后台，
      // 否则 Obsidian 的加载看门狗会把插件判定为“加载时间过长”。
      setTimeout(() => {
        if (this.unloaded) return;
        this.boot().catch((e) => this.setStatus(tr('status.bootFailed', e && e.message ? e.message : e)));
      }, 0);
    }
  }

  async boot() {
    if (this.booting || this.unloaded) return;
    this.booting = true;
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
    if (this.server) { this.server.stop(); this.server = null; }
    if (this.client) { this.client.stop(); this.client = null; }
  }

  setStatus(text) {
    this.statusText = text;
    if (this.statusEl) this.statusEl.setText('⇄ ' + text);
    if (text !== this.lastLogged) { this.lastLogged = text; dbg(this.app, 'status: ' + text); }
  }

  saveSoon() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveData(this.settings).catch(() => {});
    }, 1500);
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

    const info = containerEl.createEl('div');
    info.style.whiteSpace = 'pre-wrap';
    info.style.margin = '8px 0 16px';
    info.style.fontFamily = 'var(--font-monospace)';
    info.style.fontSize = '12px';

    const refresh = () => {
      const lines = [tr('settings.status', this.plugin.statusText || '—')];
      if (this.plugin.server) {
        const i = this.plugin.server.info();
        lines.push(tr('settings.port', i.port || tr('settings.notStarted'), i.ready ? '' : tr('settings.indexingTag')));
        lines.push(tr('settings.indexFiles', i.files));
        lines.push(tr('settings.lastClient', i.lastClient ? i.lastClientAddr.replace('::ffff:', '') + ' · ' + new Date(i.lastClient).toLocaleTimeString() : tr('settings.none')));
        lines.push(tr('settings.devicesCount', i.devices, i.pending ? tr('settings.pendingCount', i.pending) : ''));
      }
      if (this.plugin.client) {
        const c = this.plugin.client;
        lines.push(tr('settings.pairStatus', this.plugin.settings.pairToken ? tr('settings.authorized') : tr('settings.waitApproval')));
        lines.push(tr('settings.pcAddr', c.endpoint ? c.endpoint.host + ':' + c.endpoint.port : tr('settings.notFound')));
        lines.push(tr('settings.lastSync', c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : '—'));
        lines.push(tr('settings.session', c.stats.pulled, c.stats.pushed, c.stats.deleted, c.stats.conflicts));
      }
      info.setText(lines.join('\n'));
    };
    refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = window.setInterval(refresh, 1000);

    new Setting(containerEl)
      .setName(tr('settings.enable'))
      .setDesc(tr('settings.enableDesc'))
      .addToggle((t) => t.setValue(!!this.plugin.settings.enabled).onChange(async (v) => {
        this.plugin.settings.enabled = v;
        await this.plugin.saveData(this.plugin.settings);
        new Notice(v ? tr('notice.enabled') : tr('notice.disabled'));
      }));

    new Setting(containerEl)
      .setName(tr('settings.syncNow'))
      .setDesc(tr('settings.syncNowDesc'))
      .addButton((b) => b.setButtonText(tr('settings.btnSync')).setCta().onClick(() => this.plugin.manualSync()));

    if (this.plugin.client) {
      new Setting(containerEl)
        .setName(tr('settings.reconnect'))
        .setDesc(tr('settings.reconnectDesc'))
        .addButton((b) => b.setButtonText(tr('settings.btnFind')).onClick(async () => {
          await this.plugin.reconnect();
          refresh();
        }));
    } else {
      new Setting(containerEl)
        .setName(tr('settings.rescan'))
        .setDesc(tr('settings.rescanDesc'))
        .addButton((b) => b.setButtonText(tr('settings.btnRescan')).onClick(async () => {
          await this.plugin.server.rescan();
          refresh();
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

    containerEl.createEl('h3', { text: tr('settings.scope') });
    const table = containerEl.createEl('table');
    table.style.width = '100%';
    table.style.tableLayout = 'fixed';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = 'var(--font-ui-smaller)';
    table.style.lineHeight = '1.5';

    const headTr = table.createEl('thead').createEl('tr');
    for (const label of [tr('scope.headYes'), tr('scope.headNo')]) {
      const th = headTr.createEl('th');
      th.setText(label);
      th.style.textAlign = 'left';
      th.style.padding = '8px 10px';
      th.style.background = 'var(--background-secondary)';
      th.style.border = '1px solid var(--background-modifier-border)';
    }

    const scopeYes = [
      tr('scope.yes1'),
      tr('scope.yes2'),
      tr('scope.yes3'),
      tr('scope.yes4'),
    ];
    const scopeNo = [
      tr('scope.no1'),
      tr('scope.no2'),
      tr('scope.no3'),
      tr('scope.no4', MAX_FILE / 1048576),
    ];
    const tbody = table.createEl('tbody');
    for (let i = 0; i < Math.max(scopeYes.length, scopeNo.length); i++) {
      const rowEl = tbody.createEl('tr');
      for (const text of [scopeYes[i] || '', scopeNo[i] || '']) {
        const td = rowEl.createEl('td');
        td.setText(text);
        td.style.padding = '8px 10px';
        td.style.verticalAlign = 'top';
        td.style.wordBreak = 'break-word';
        td.style.border = '1px solid var(--background-modifier-border)';
      }
    }

    const scopeNote = containerEl.createEl('p', { cls: 'setting-item-description' });
    scopeNote.style.marginTop = '10px';
    scopeNote.setText(tr('scope.note', IGNORE.join(' / ')));
  }
}

module.exports = LanSyncPlugin;
