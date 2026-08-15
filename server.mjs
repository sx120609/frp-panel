import http from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const GENERATED_DIR = path.join(ROOT, 'generated');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const FRPS_BIN = process.env.FRPS_BIN || 'frps';
const FRP_VERSION = process.env.FRP_VERSION || '0.61.1';
const FRP_OFFICIAL_DOWNLOAD_BASE_URL = 'https://github.com/fatedier/frp/releases/download';
const FRP_DOWNLOAD_BASE_URL = (process.env.FRP_DOWNLOAD_BASE_URL || FRP_OFFICIAL_DOWNLOAD_BASE_URL).replace(/\/$/, '');
const FRP_DEFAULT_MIRROR_BASES = [
  'https://gh-proxy.com/https://github.com/fatedier/frp/releases/download',
  'https://ghproxy.net/https://github.com/fatedier/frp/releases/download',
  'https://github.com/fatedier/frp/releases/download',
];
const sessions = new Map();
let frpsProcess = null;

const defaultDb = () => ({
  version: 1,
  settings: {
    serverAddr: process.env.PUBLIC_BASE_URL || '127.0.0.1',
    serverPort: 7000,
    bindPort: 7000,
    dashboardPort: 7500,
    dashboardHost: '127.0.0.1',
    authToken: crypto.randomBytes(18).toString('hex'),
    logLevel: 'info',
    maxPoolCount: 5,
  },
  clients: [],
  tunnels: [],
  audit: [],
});

let db;
async function loadDb() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(GENERATED_DIR, { recursive: true });
  try {
    db = JSON.parse(await readFile(DB_FILE, 'utf8'));
    db.settings ||= defaultDb().settings;
    db.clients ||= [];
    db.tunnels ||= [];
    db.audit ||= [];
  } catch {
    db = defaultDb();
    await saveDb();
  }
}
let saveQueue = Promise.resolve();
function saveDb() {
  saveQueue = saveQueue.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, DB_FILE);
  });
  return saveQueue;
}

function id(prefix) { return `${prefix}_${crypto.randomBytes(7).toString('hex')}`; }
function now() { return new Date().toISOString(); }
function clean(value, fallback = '') { return String(value ?? fallback).trim(); }
function safeName(value) { return clean(value).replace(/[^\w\-一-龥 ]/g, '').slice(0, 64) || '未命名'; }
function frpDownloadBases() {
  const custom = clean(process.env.FRP_DOWNLOAD_MIRRORS).split(',').map(x => x.trim()).filter(Boolean);
  const customBase = process.env.FRP_DOWNLOAD_BASE_URL && FRP_DOWNLOAD_BASE_URL !== FRP_OFFICIAL_DOWNLOAD_BASE_URL ? [FRP_DOWNLOAD_BASE_URL] : [];
  return [...new Set([...custom, ...customBase, ...FRP_DEFAULT_MIRROR_BASES, ...(customBase.length ? [] : [FRP_DOWNLOAD_BASE_URL])])];
}
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
function text(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': contentType, ...headers });
  res.end(body);
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i).trim(), decodeURIComponent(x.slice(i + 1).trim())];
  }));
}
function sessionFor(req) {
  const token = parseCookies(req).frp_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) { sessions.delete(token); return null; }
  return session;
}
function requireAuth(req, res) {
  if (sessionFor(req)) return true;
  json(res, 401, { error: '需要登录' });
  return false;
}
function logAudit(action, detail = {}) {
  db.audit.unshift({ id: id('audit'), action, detail, at: now() });
  db.audit = db.audit.slice(0, 100);
}
async function readBody(req) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > 1024 * 1024) throw new Error('请求体过大'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}
function validateTunnel(input) {
  const type = clean(input.type, 'tcp').toLowerCase();
  const allowed = ['tcp', 'udp', 'http', 'https', 'stcp', 'xtcp'];
  if (!allowed.includes(type)) throw new Error('不支持的隧道类型');
  const localPort = Number(input.localPort); if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('本地端口无效');
  const remotePort = input.remotePort === '' || input.remotePort == null ? null : Number(input.remotePort);
  if (['tcp', 'udp'].includes(type) && (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)) throw new Error('远端端口无效');
  return { name: safeName(input.name || `${type}-${localPort}`), type, localIP: clean(input.localIP, '127.0.0.1'), localPort, remotePort,
    customDomains: clean(input.customDomains).split(',').map(x => x.trim()).filter(Boolean), subdomain: clean(input.subdomain), enabled: input.enabled !== false };
}
function getClient(clientId) { return db.clients.find(c => c.id === clientId); }
function renderFrpsConfig() {
  const s = db.settings;
  return `# Generated by frp-panel at ${now()}\nbindAddr = "0.0.0.0"\nbindPort = ${s.bindPort}\nauth.method = "token"\nauth.token = "${s.authToken}"\ntransport.maxPoolCount = ${s.maxPoolCount}\nlog.to = "console"\nlog.level = "${s.logLevel}"\n\n[webServer]\naddr = "${s.dashboardHost}"\nport = ${s.dashboardPort}\n# 建议在反向代理层增加 HTTPS 和访问控制\n`;
}
function renderFrpcConfig(client) {
  const s = db.settings;
  const tunnels = db.tunnels.filter(t => t.clientId === client.id && t.enabled);
  const quote = value => JSON.stringify(String(value ?? ''));
  const lines = [`serverAddr = ${quote(s.serverAddr.replace(/^https?:\/\//, '').replace(/:\d+$/, ''))}`, `serverPort = ${s.serverPort}`, '', 'auth.method = "token"', `auth.token = ${quote(s.authToken)}`, '', 'log.to = "console"', 'log.level = "info"', ''];
  for (const t of tunnels) {
    lines.push('[[proxies]]', `name = ${quote(t.name || t.id)}`, `type = ${quote(t.type)}`, `localIP = ${quote(t.localIP)}`, `localPort = ${t.localPort}`);
    if (t.remotePort) lines.push(`remotePort = ${t.remotePort}`);
    if (t.customDomains?.length) lines.push(`customDomains = [${t.customDomains.map(quote).join(', ')}]`);
    if (t.subdomain) lines.push(`subdomain = ${quote(t.subdomain)}`);
    lines.push('');
  }
  return lines.join('\n');
}
function installScript(client) {
  const base = process.env.PUBLIC_BASE_URL || `http://YOUR_PANEL_HOST:${PORT}`;
  const configUrl = `${base.replace(/\/$/, '')}/client/${client.id}/frpc.toml?token=${encodeURIComponent(client.token)}`;
  const downloadBases = frpDownloadBases();
  const name = client.name.replace(/\n/g, ' ').replace(/\r/g, ' ');
  return [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    `# frp-panel Linux client bootstrap for ${name}`,
    'if [ "$(id -u)" -ne 0 ]; then echo "请用 root 或 sudo 执行此命令。" >&2; exit 1; fi',
    `INSTALL_DIR="/opt/frp-panel/${client.id}"`,
    `SERVICE_NAME="frpc-${client.id}.service"`,
    'CONFIG_PATH="$INSTALL_DIR/frpc.toml"',
    'FRPC_BIN="$INSTALL_DIR/frpc"',
    `FRP_VERSION='${FRP_VERSION}'`,
    `DOWNLOAD_BASES=(${downloadBases.map(shellQuote).join(' ')})`,
    'mkdir -p "$INSTALL_DIR"',
    `curl -fsSL '${configUrl}' -o "$CONFIG_PATH"`,
    'MACHINE_ARCH="$(uname -m)"',
    'case "$MACHINE_ARCH" in',
    '  x86_64|amd64) ARCH="amd64" ;;',
    '  aarch64|arm64) ARCH="arm64" ;;',
    '  armv7l|armv6l|arm) ARCH="arm" ;;',
    '  i386|i686|x86) ARCH="386" ;;',
    '  riscv64) ARCH="riscv64" ;;',
    '  *) echo "不支持的 Linux 架构: $MACHINE_ARCH" >&2; exit 2 ;;',
    'esac',
    'TMP_DIR="$(mktemp -d)"',
    'trap \'rm -rf "$TMP_DIR"\' EXIT',
    'ARCHIVE="$TMP_DIR/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz"',
    'DOWNLOADED=0',
    'for DOWNLOAD_BASE in "${DOWNLOAD_BASES[@]}"; do',
    '  DOWNLOAD_URL="$DOWNLOAD_BASE/v$FRP_VERSION/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz"',
    '  echo "正在下载 frpc $FRP_VERSION ($ARCH): $DOWNLOAD_BASE"',
    '  if curl --connect-timeout 10 --max-time 180 --retry 1 -fL "$DOWNLOAD_URL" -o "$ARCHIVE"; then DOWNLOADED=1; break; fi',
    'done',
    'if [ "$DOWNLOADED" -ne 1 ]; then echo "所有下载源均失败，请设置 FRP_DOWNLOAD_MIRRORS 后重试。" >&2; exit 3; fi',
    'tar -xzf "$ARCHIVE" -C "$TMP_DIR"',
    'FRPC_SOURCE="$(find "$TMP_DIR" -type f -name frpc -perm -u+x -print -quit)"',
    'if [ -z "$FRPC_SOURCE" ]; then echo "下载的 FRP 压缩包中未找到 frpc。" >&2; exit 3; fi',
    'install -m 0755 "$FRPC_SOURCE" "$FRPC_BIN"',
    '"$FRPC_BIN" verify -c "$CONFIG_PATH"',
    'cat > "/etc/systemd/system/$SERVICE_NAME" <<UNIT',
    '[Unit]',
    `Description=frpc (${name})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/sh -c "$FRPC_BIN -c $CONFIG_PATH"',
    'Restart=always',
    'RestartSec=3',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    'systemctl daemon-reload',
    '# restart is intentional: rerunning this command must apply newly-added tunnels',
    'systemctl enable "$SERVICE_NAME"',
    'systemctl restart "$SERVICE_NAME"',
    'if ! systemctl is-active --quiet "$SERVICE_NAME"; then systemctl --no-pager --full status "$SERVICE_NAME" || true; exit 4; fi',
    'echo "frpc Linux 客户端已安装并启动：$SERVICE_NAME"',
    'systemctl --no-pager --full status "$SERVICE_NAME" | sed -n \'1,12p\'',
  ].join('\n');
}
function windowsInstallScript(client) {
  const base = process.env.PUBLIC_BASE_URL || `http://YOUR_PANEL_HOST:${PORT}`;
  const configUrl = `${base.replace(/\/$/, '')}/client/${client.id}/frpc.toml?token=${encodeURIComponent(client.token)}`;
  const downloadBases = frpDownloadBases();
  const name = client.name.replace(/'/g, "''");
  const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
  return [
    '#requires -Version 5.1',
    "$ErrorActionPreference = 'Stop'",
    `# frp-panel Windows client bootstrap for ${name}`,
    '$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    "if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator before executing this command.' }",
    `$installDir = Join-Path $env:ProgramData 'frp-panel\\${client.id}'`,
    'New-Item -ItemType Directory -Force -Path $installDir | Out-Null',
    "$configPath = Join-Path $installDir 'frpc.toml'",
    "$frpcPath = Join-Path $installDir 'frpc.exe'",
    `Invoke-WebRequest -UseBasicParsing -Uri '${configUrl}' -OutFile $configPath`,
    'if (-not (Test-Path $frpcPath)) {',
    '  $machineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }',
    "  $arch = switch ($machineArch.ToUpperInvariant()) { 'AMD64' { 'amd64'; break } 'ARM64' { 'arm64'; break } 'X86' { '386'; break } default { throw \"Unsupported Windows architecture: $machineArch\" } }",
    `  $version = '${FRP_VERSION}'`,
    '  $zipPath = Join-Path $env:TEMP "frp_${version}_windows_${arch}.zip"',
    '  $downloaded = $false',
    '  $downloadUrls = @(',
    ...downloadBases.map(baseUrl => `    ${psQuote(baseUrl)} + "/v$version/frp_$version_windows_$arch.zip"`),
    '  )',
    '  foreach ($downloadUrl in $downloadUrls) {',
    '    try { Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zipPath; if ((Get-Item -LiteralPath $zipPath).Length -gt 1024) { $downloaded = $true; break } } catch { Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }',
    '  }',
    '  if (-not $downloaded) { throw "所有 FRP 下载源均失败，请检查网络或设置 FRP_DOWNLOAD_MIRRORS。" }',
    '  $extractDir = Join-Path $env:TEMP ("frp-panel-" + [Guid]::NewGuid().ToString("N"))',
    '  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force',
    '  $candidate = Get-ChildItem -Path $extractDir -Filter frpc.exe -Recurse | Select-Object -First 1',
    "  if (-not $candidate) { throw 'frpc.exe was not found in the downloaded FRP archive.' }",
    '  Copy-Item $candidate.FullName $frpcPath -Force',
    '  Remove-Item $extractDir, $zipPath -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    '& $frpcPath verify -c $configPath',
    'if ($LASTEXITCODE -ne 0) { throw "frpc config validation failed: $configPath" }',
    `$taskName = 'frpc-${client.id}'`,
    '$oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue',
    'if ($oldTask) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }',
    '$oldService = Get-Service -Name $taskName -ErrorAction SilentlyContinue',
    'if ($oldService) { Stop-Service -Name $taskName -Force -ErrorAction SilentlyContinue; sc.exe delete $taskName | Out-Null; Start-Sleep -Seconds 1 }',
    '$action = New-ScheduledTaskAction -Execute $frpcPath -Argument "-c `"$configPath`""',
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$principal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest',
    `Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description "frpc (${name}) managed by frp-panel" -Force | Out-Null`,
    'Start-ScheduledTask -TaskName $taskName',
    'Start-Sleep -Seconds 2',
    'if (-not (Get-Process -Name frpc -ErrorAction SilentlyContinue)) { throw "frpc did not start. Check Scheduled Task $taskName or run: $frpcPath -c $configPath" }',
    'Write-Host "frpc Windows client installed and started (startup task): $taskName" -ForegroundColor Green',
    'Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State'
  ].join('\n');
}
async function startFrps() {
  if (frpsProcess && !frpsProcess.killed) return { running: true, pid: frpsProcess.pid };
  const cfg = path.join(GENERATED_DIR, 'frps.toml'); await writeFile(cfg, renderFrpsConfig());
  try { await access(FRPS_BIN); } catch { if (FRPS_BIN.includes(path.sep)) throw new Error(`找不到 frps：${FRPS_BIN}`); }
  frpsProcess = spawn(FRPS_BIN, ['-c', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  frpsProcess.on('exit', () => { frpsProcess = null; });
  return { running: true, pid: frpsProcess.pid };
}
function stopFrps() { if (frpsProcess && !frpsProcess.killed) { frpsProcess.kill('SIGTERM'); frpsProcess = null; } return { running: false }; }

async function api(req, res, pathname, method) {
  if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, time: now(), frps: !!frpsProcess });
  if (pathname === '/api/login' && method === 'POST') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, { error: '无效请求' }); }
    if (!ADMIN_PASSWORD) return json(res, 503, { error: '服务端未设置 ADMIN_PASSWORD' });
    const provided = clean(body.password);
    const providedBuf = Buffer.from(provided); const expectedBuf = Buffer.from(ADMIN_PASSWORD);
    const valid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) return json(res, 401, { error: '密码错误' });
    const token = crypto.createHmac('sha256', SESSION_SECRET).update(`${Date.now()}:${crypto.randomBytes(12).toString('hex')}`).digest('hex');
    sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 24 });
    return json(res, 200, { ok: true }, { 'set-cookie': `frp_session=${token}; HttpOnly; SameSite=Strict; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  }
  if (pathname === '/api/logout' && method === 'POST') { const c = parseCookies(req).frp_session; if (c) sessions.delete(c); return json(res, 200, { ok: true }, { 'set-cookie': 'frp_session=; Max-Age=0; HttpOnly; SameSite=Strict' }); }
  if (!requireAuth(req, res)) return;
  try {
    if (pathname === '/api/bootstrap' && method === 'GET') return json(res, 200, { settings: db.settings, clients: db.clients.map(({ token, ...c }) => c), tunnels: db.tunnels, audit: db.audit.slice(0, 20), frps: { running: !!frpsProcess, pid: frpsProcess?.pid || null } });
    if (pathname === '/api/config/frps' && method === 'GET') return text(res, 200, renderFrpsConfig(), 'text/plain; charset=utf-8', { 'content-disposition': 'attachment; filename="frps.toml"' });
    if (pathname === '/api/settings' && method === 'PATCH') { const b = await readBody(req); for (const k of ['serverAddr','serverPort','bindPort','dashboardPort','dashboardHost','authToken','logLevel','maxPoolCount']) if (b[k] !== undefined) db.settings[k] = ['serverPort','bindPort','dashboardPort','maxPoolCount'].includes(k) ? Number(b[k]) : clean(b[k]); logAudit('更新服务设置'); await saveDb(); return json(res, 200, { settings: db.settings }); }
    if (pathname === '/api/clients' && method === 'POST') { const b = await readBody(req); const client = { id: id('cli'), name: safeName(b.name || '新客户端'), description: clean(b.description), token: crypto.randomBytes(24).toString('hex'), createdAt: now(), lastSeenAt: null }; db.clients.push(client); logAudit('创建客户端', { id: client.id }); await saveDb(); return json(res, 201, client); }
    const clientMatch = pathname.match(/^\/api\/clients\/([^/]+)$/); const clientId = clientMatch?.[1];
    if (clientId && method === 'PATCH') { const c = getClient(clientId); if (!c) return json(res, 404, { error: '客户端不存在' }); const b = await readBody(req); if (b.name !== undefined) c.name = safeName(b.name); if (b.description !== undefined) c.description = clean(b.description); logAudit('更新客户端', { id: clientId }); await saveDb(); return json(res, 200, { ...c, token: undefined }); }
    if (clientId && method === 'DELETE') { const i = db.clients.findIndex(c => c.id === clientId); if (i < 0) return json(res, 404, { error: '客户端不存在' }); if (db.tunnels.some(t => t.clientId === clientId)) return json(res, 409, { error: '请先删除该客户端的隧道' }); db.clients.splice(i, 1); logAudit('删除客户端', { id: clientId }); await saveDb(); return json(res, 200, { ok: true }); }
    const configMatch = pathname.match(/^\/api\/clients\/([^/]+)\/config$/);
    if (configMatch && method === 'GET') { const c = getClient(configMatch[1]); if (!c) return json(res, 404, { error: '客户端不存在' }); return text(res, 200, renderFrpcConfig(c), 'text/plain; charset=utf-8', { 'content-disposition': `attachment; filename="frpc-${c.id}.toml"` }); }
    const commandMatch = pathname.match(/^\/api\/clients\/([^/]+)\/install-command$/);
    if (commandMatch && method === 'GET') { const c = getClient(commandMatch[1]); if (!c) return json(res, 404, { error: '客户端不存在' }); const base = process.env.PUBLIC_BASE_URL || `http://YOUR_PANEL_HOST:${PORT}`; const scriptUrl = `${base.replace(/\/$/, '')}/install/${c.id}.sh?token=${encodeURIComponent(c.token)}`; const windowsScriptUrl = `${base.replace(/\/$/, '')}/install/${c.id}.ps1?token=${encodeURIComponent(c.token)}`; return json(res, 200, { command: `curl -fsSL '${scriptUrl}' | sudo bash`, windowsCommand: `irm '${windowsScriptUrl}' | iex`, config: renderFrpcConfig(c) }); }
    if (pathname === '/api/tunnels' && method === 'POST') { const b = await readBody(req); if (!getClient(clean(b.clientId))) return json(res, 400, { error: '客户端不存在' }); const tunnel = { id: id('tun'), clientId: clean(b.clientId), ...validateTunnel(b), createdAt: now() }; db.tunnels.push(tunnel); logAudit('创建隧道', { id: tunnel.id }); await saveDb(); return json(res, 201, tunnel); }
    const tunnelMatch = pathname.match(/^\/api\/tunnels\/([^/]+)$/); const tunnelId = tunnelMatch?.[1];
    if (tunnelId && method === 'PATCH') { const t = db.tunnels.find(x => x.id === tunnelId); if (!t) return json(res, 404, { error: '隧道不存在' }); Object.assign(t, validateTunnel({ ...t, ...(await readBody(req)) })); logAudit('更新隧道', { id: tunnelId }); await saveDb(); return json(res, 200, t); }
    if (tunnelId && method === 'DELETE') { const i = db.tunnels.findIndex(t => t.id === tunnelId); if (i < 0) return json(res, 404, { error: '隧道不存在' }); db.tunnels.splice(i, 1); logAudit('删除隧道', { id: tunnelId }); await saveDb(); return json(res, 200, { ok: true }); }
    if (pathname === '/api/service/status' && method === 'GET') return json(res, 200, { running: !!frpsProcess, pid: frpsProcess?.pid || null, binary: FRPS_BIN });
    if (pathname === '/api/service/start' && method === 'POST') { const result = await startFrps(); logAudit('启动 frps'); return json(res, 200, result); }
    if (pathname === '/api/service/stop' && method === 'POST') { const result = stopFrps(); logAudit('停止 frps'); return json(res, 200, result); }
    if (pathname === '/api/service/restart' && method === 'POST') { stopFrps(); const result = await startFrps(); logAudit('重启 frps'); return json(res, 200, result); }
    return json(res, 404, { error: '接口不存在' });
  } catch (e) { console.error(e); return json(res, 400, { error: e.message || '请求失败' }); }
}

async function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/install/') && pathname.endsWith('.sh')) {
    const clientId = path.basename(pathname, '.sh'); const c = getClient(clientId); const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    if (!c || !token || token !== c.token) return text(res, 404, 'not found');
    return text(res, 200, installScript(c), 'text/x-shellscript; charset=utf-8', { 'content-disposition': `attachment; filename="frpc-${clientId}.sh"` });
  }
  if (pathname.startsWith('/install/') && pathname.endsWith('.ps1')) {
    const clientId = path.basename(pathname, '.ps1'); const c = getClient(clientId); const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    if (!c || !token || token !== c.token) return text(res, 404, 'not found');
    return text(res, 200, windowsInstallScript(c), 'text/plain; charset=utf-8', { 'content-disposition': `attachment; filename="frpc-${clientId}.ps1"` });
  }
  if (pathname.startsWith('/client/') && pathname.endsWith('/frpc.toml')) {
    const clientId = pathname.split('/')[2]; const c = getClient(clientId); const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    if (!c || token !== c.token) return text(res, 404, 'not found');
    return text(res, 200, renderFrpcConfig(c), 'text/plain; charset=utf-8', { 'content-disposition': `attachment; filename="frpc-${clientId}.toml"` });
  }
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''); const target = path.normalize(path.join(PUBLIC_DIR, file));
  if (!target.startsWith(PUBLIC_DIR)) return text(res, 403, 'forbidden');
  try { const data = await readFile(target); const ext = path.extname(target); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }; text(res, 200, data, types[ext] || 'application/octet-stream'); } catch { text(res, 404, 'not found'); }
}

await loadDb();
await writeFile(path.join(GENERATED_DIR, 'frps.toml'), renderFrpsConfig());
if (process.env.FRPS_AUTO_START === 'true') {
  try { await startFrps(); console.log('frps auto-started'); }
  catch (error) { console.error('frps auto-start failed:', error.message); }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const pathname = url.pathname;
    if (pathname.startsWith('/api/')) return await api(req, res, pathname, req.method);
    return await serveStatic(req, res, pathname);
  } catch (e) { json(res, 500, { error: '服务器错误' }); }
});
server.listen(PORT, () => console.log(`frp-panel listening on http://0.0.0.0:${PORT}`));

process.on('SIGTERM', () => { stopFrps(); server.close(() => process.exit(0)); });
