import express from 'express';
import { exec, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';

const DB_DIR = `${homedir()}/.config/xray-cli`;
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = `${DB_DIR}/xray-cli.json`;

interface Profile {
  id: number;
  uuid: string;
  username: string;
  enable: number;
  flow: string;
  limit_gb: number;
  upload_bytes: number;
  download_bytes: number;
  expire_days: number;
  expires_at: string;
  sub_uuid: string;
  inbound_tags: string[];
  server_address: string;
  remark: string;
  created_at: string;
  updated_at: string;
}

interface Settings {
  subscription_title: string;
  subscription_domain: string;
  announcement: string;
  inbound_link_remarks: Record<string, string>;
  inbound_remarks: Record<string, string>;
  global_inbound_port: number;
  profile_update_interval: number;
  show_traffic_limit: number;
  show_expiration: number;
  xray_apply_pending: number;
}

interface Database {
  profiles: Profile[];
  settings: Settings;
  nextProfileId: number;
  analytics: AnalyticsStore;
}

interface TrafficSample {
  at: string;
  users: Record<string, number>;
  server_total: number;
}

interface AnalyticsStore {
  version: number;
  step_ms: number;
  samples: TrafficSample[];
}

interface XrayInbound {
  tag: string;
  port: number;
  listen: string;
  protocol: string;
  settings: any;
  stream_settings?: XrayStreamSettings;
  streamSettings?: XrayStreamSettings;
  tlsSettings?: XrayTlsSettings;
  tcpSettings?: XrayTcpSettings;
}

interface XrayTcpSettings {
  acceptProxyProtocol?: boolean;
  header?: Record<string, unknown>;
}

interface XrayTlsSettings {
  serverName?: string;
  sni?: string;
  rejectUnknownSni?: boolean;
  allowInsecure?: boolean;
  alpn?: string[];
  minVersion?: string;
  maxVersion?: string;
  fingerprint?: string;
  certificates?: unknown[];
}

interface XrayStreamSettings {
  network?: string;
  security?: string;
  tlsSettings?: XrayTlsSettings;
  tcpSettings?: XrayTcpSettings;
  rawSettings?: any;
  wsSettings?: any;
  xhttpSettings?: any;
  grpcSettings?: any;
  httpSettings?: any;
  kcpSettings?: any;
  quicSettings?: any;
  realitySettings?: any;
  sni?: string;
  fingerprint?: string;
  alpn?: string | string[];
}

function normalizeStreamSettingsObject(raw: any): XrayStreamSettings {
  const src = raw || {};
  const dst: any = { ...src };
  if (!dst.tlsSettings && src.tls_settings) dst.tlsSettings = src.tls_settings;
  if (!dst.tcpSettings && src.tcp_settings) dst.tcpSettings = src.tcp_settings;
  if (!dst.wsSettings && src.ws_settings) dst.wsSettings = src.ws_settings;
  if (!dst.grpcSettings && src.grpc_settings) dst.grpcSettings = src.grpc_settings;
  if (!dst.httpSettings && src.http_settings) dst.httpSettings = src.http_settings;
  if (!dst.xhttpSettings && src.xhttp_settings) dst.xhttpSettings = src.xhttp_settings;
  if (!dst.kcpSettings && src.kcp_settings) dst.kcpSettings = src.kcp_settings;
  if (!dst.quicSettings && src.quic_settings) dst.quicSettings = src.quic_settings;
  if (!dst.realitySettings && src.reality_settings) dst.realitySettings = src.reality_settings;
  if (!dst.rawSettings && src.tcpSettings) dst.rawSettings = src.tcpSettings;
  if (!dst.rawSettings && src.raw_settings) dst.rawSettings = src.raw_settings;
  if (!dst.httpupgradeSettings && src.httpupgrade_settings) dst.httpupgradeSettings = src.httpupgrade_settings;
  if (!dst.hysteriaSettings && src.hysteria_settings) dst.hysteriaSettings = src.hysteria_settings;
  delete dst.tls_settings;
  delete dst.tcp_settings;
  delete dst.ws_settings;
  delete dst.grpc_settings;
  delete dst.http_settings;
  delete dst.xhttp_settings;
  delete dst.kcp_settings;
  delete dst.quic_settings;
  delete dst.reality_settings;
  delete dst.raw_settings;
  delete dst.httpupgrade_settings;
  delete dst.hysteria_settings;
  return dst as XrayStreamSettings;
}

function getInboundStreamSettings(ib: XrayInbound): XrayStreamSettings {
  const streamSettings = normalizeStreamSettingsObject(ib.streamSettings || ib.stream_settings || {});
  if (!streamSettings.tlsSettings && ib.tlsSettings) streamSettings.tlsSettings = ib.tlsSettings;
  if (!streamSettings.tcpSettings && ib.tcpSettings) streamSettings.tcpSettings = ib.tcpSettings;
  if (!streamSettings.rawSettings && streamSettings.tcpSettings) streamSettings.rawSettings = streamSettings.tcpSettings as any;
  return streamSettings;
}

function loadDB(): Database {
  if (existsSync(DB_PATH)) {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    return {
      profiles: (raw.profiles || []).map((p: any) => {
        const normalized: any = {
          ...p,
        flow: p.flow || 'xtls-rprx-vision',
        limit_gb: Number(p.limit_gb ?? p.total_gb ?? 0) || 0,
        upload_bytes: Number(p.upload_bytes ?? 0) || 0,
        download_bytes: Number(p.download_bytes ?? 0) || 0,
        expire_days: Number(p.expire_days ?? 0) || 0,
        expires_at: p.expires_at || '',
        server_address: p.server_address || '',
        remark: p.remark || p.username || ''
        };
        delete normalized.inbound_remarks;
        delete normalized.server_description;
        return normalized as Profile;
      }),
      settings: {
        subscription_title: raw.settings?.subscription_title || '',
        subscription_domain: raw.settings?.subscription_domain || '',
        announcement: raw.settings?.announcement || raw.settings?.server_description || '',
        inbound_link_remarks: raw.settings?.inbound_link_remarks || {},
        inbound_remarks: raw.settings?.inbound_remarks || {},
        global_inbound_port: Number(raw.settings?.global_inbound_port ?? 0) || 0,
        profile_update_interval: Number(raw.settings?.profile_update_interval ?? 2) || 2,
        show_traffic_limit: raw.settings?.show_traffic_limit === undefined ? 1 : (raw.settings?.show_traffic_limit ? 1 : 0),
        show_expiration: raw.settings?.show_expiration === undefined ? 1 : (raw.settings?.show_expiration ? 1 : 0),
        xray_apply_pending: raw.settings?.xray_apply_pending ? 1 : 0
      },
      nextProfileId: raw.nextProfileId || 1,
      analytics: normalizeAnalytics(raw.analytics)
    };
  }
  return {
    profiles: [],
    settings: {
      subscription_title: '',
      subscription_domain: '',
      announcement: '',
      inbound_link_remarks: {},
      inbound_remarks: {},
      global_inbound_port: 0,
      profile_update_interval: 2,
      show_traffic_limit: 1,
      show_expiration: 1,
      xray_apply_pending: 0
    },
    nextProfileId: 1,
    analytics: normalizeAnalytics(undefined)
  };
}

function saveDB(db: Database) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function normalizeAnalytics(raw: any): AnalyticsStore {
  const samples = Array.isArray(raw?.samples) ? raw.samples : [];
  const normalized: TrafficSample[] = [];
  for (const sample of samples) {
    const at = typeof sample?.at === 'string' ? sample.at : '';
    if (!at) continue;
    const usersRaw = sample?.users && typeof sample.users === 'object' ? sample.users : {};
    const users: Record<string, number> = {};
    for (const [k, v] of Object.entries(usersRaw)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) users[String(k)] = Math.floor(n);
    }
    const serverTotal = Number(sample?.server_total);
    normalized.push({
      at,
      users,
      server_total: Number.isFinite(serverTotal) && serverTotal >= 0 ? Math.floor(serverTotal) : 0
    });
  }
  return {
    version: 1,
    step_ms: Math.max(Number(raw?.step_ms) || XRAY_ANALYTICS_STEP_MS, 5000),
    samples: normalized
  };
}

function pruneAnalyticsSamples(samples: TrafficSample[]): TrafficSample[] {
  const cutoff = Date.now() - XRAY_ANALYTICS_RETENTION_DAYS * 86400000;
  return samples.filter(s => {
    const t = new Date(s.at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

function recordAnalyticsSnapshot(db: Database, now = new Date()): boolean {
  if (!db.analytics) db.analytics = normalizeAnalytics(undefined);
  if (!Array.isArray(db.analytics.samples)) db.analytics.samples = [];
  db.analytics.step_ms = Math.max(db.analytics.step_ms || XRAY_ANALYTICS_STEP_MS, 5000);

  const users: Record<string, number> = {};
  let total = 0;
  for (const p of db.profiles) {
    const current = Math.max(0, Math.floor((p.upload_bytes || 0) + (p.download_bytes || 0)));
    users[String(p.id)] = current;
    total += current;
  }
  const sample: TrafficSample = { at: now.toISOString(), users, server_total: Math.max(0, total) };

  const prev = db.analytics.samples.length > 0 ? db.analytics.samples[db.analytics.samples.length - 1] : null;
  if (!prev) {
    db.analytics.samples = pruneAnalyticsSamples([sample]);
    return true;
  }

  const prevTime = new Date(prev.at).getTime();
  if (!Number.isFinite(prevTime) || now.getTime()-prevTime >= db.analytics.step_ms) {
    db.analytics.samples = pruneAnalyticsSamples([...db.analytics.samples, sample]);
    return true;
  }

  db.analytics.samples[db.analytics.samples.length - 1] = sample;
  db.analytics.samples = pruneAnalyticsSamples(db.analytics.samples);
  return true;
}

function findPeriodUsage(db: Database, profile: Profile, periodMs: number): { bytes: number; available: boolean } {
  const samples = db.analytics?.samples || [];
  if (!samples.length) return { bytes: 0, available: false };

  const current = Math.max(0, Math.floor((profile.upload_bytes || 0) + (profile.download_bytes || 0)));
  const cutoff = Date.now() - periodMs;
  const key = String(profile.id);
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (!sample) continue;
    const t = new Date(sample.at).getTime();
    if (!Number.isFinite(t) || t > cutoff) continue;
    const pastRaw = sample.users[key];
    const past = Number(pastRaw);
    if (!Number.isFinite(past)) return { bytes: 0, available: false };
    return { bytes: Math.max(0, current - Math.floor(past)), available: true };
  }
  return { bytes: 0, available: false };
}

function buildProfileAnalytics(db: Database, profile: Profile) {
  return {
    user_id: profile.id,
    username: profile.username,
    current_total_bytes: Math.max(0, Math.floor((profile.upload_bytes || 0) + (profile.download_bytes || 0))),
    periods: {
      day: findPeriodUsage(db, profile, 24 * 60 * 60 * 1000),
      week: findPeriodUsage(db, profile, 7 * 24 * 60 * 60 * 1000),
      month: findPeriodUsage(db, profile, 30 * 24 * 60 * 60 * 1000),
      year: findPeriodUsage(db, profile, 365 * 24 * 60 * 60 * 1000)
    }
  };
}

function buildServerAnalytics(db: Database) {
  let total = 0;
  for (const p of db.profiles) {
    total += Math.max(0, Math.floor((p.upload_bytes || 0) + (p.download_bytes || 0)));
  }
  return {
    total_traffic_bytes: total,
    users_count: db.profiles.length,
    samples_count: db.analytics?.samples?.length || 0
  };
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  const started = Date.now();
  logDebug('http.request', { method: req.method, path: req.path });
  res.on('finish', () => {
    logDebug('http.response', { method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - started });
  });
  next();
});

const XRAY_CONFIG_PATH = process.env.XRAY_CONFIG_PATH || '/usr/local/etc/xray/config.json';
const API_PORT = Number(process.env.API_PORT) || 2053;
const API_HOST = process.env.API_HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || '';
const XRAY_API_ADDRESS = process.env.XRAY_API_ADDRESS || '127.0.0.1:8080';
const STATS_CACHE_TTL_MS = Number(process.env.XRAY_STATS_CACHE_TTL_MS || 1000);
const STATS_SYNC_INTERVAL_MS = Number(process.env.XRAY_STATS_SYNC_INTERVAL_MS || 5000);
const XRAY_ANALYTICS_STEP_MS = Math.max(Number(process.env.XRAY_ANALYTICS_STEP_MS || 900000), STATS_SYNC_INTERVAL_MS || 0, 5000);
const XRAY_ANALYTICS_RETENTION_DAYS = Math.max(Number(process.env.XRAY_ANALYTICS_RETENTION_DAYS || 400), 30);
const XRAY_BIN_PATH = process.env.XRAY_BIN_PATH || '';
const XRAY_DYNAMIC_APPLY = process.env.XRAY_DYNAMIC_APPLY === undefined ? '1' : process.env.XRAY_DYNAMIC_APPLY;
const API_DEBUG_LOG = process.env.API_DEBUG_LOG === undefined ? '1' : process.env.API_DEBUG_LOG;

function debugEnabled(): boolean {
  return API_DEBUG_LOG !== '0';
}

function logDebug(event: string, details: Record<string, unknown> = {}) {
  if (!debugEnabled()) return;
  console.log(JSON.stringify({ level: 'DEBUG', event, ...details, time: new Date().toISOString() }));
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) {
    return res.status(503).json({ detail: 'API_KEY is not configured' });
  }

  const key = req.headers['x-api-key'] as string;
  if (key === API_KEY) return next();

  res.status(401).json({ detail: 'Unauthorized - invalid or missing API key' });
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function getProfileById(db: Database, idParam: unknown): Profile | null {
  if (typeof idParam !== 'string') return null;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.profiles.find(p => p.id === id) || null;
}

function setXrayApplyPending(value: boolean): void {
  const db = loadDB();
  db.settings.xray_apply_pending = value ? 1 : 0;
  saveDB(db);
}

function saveConfigAndReload(): void {
  const config = buildXrayConfig();
  mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  logDebug('xray.config.saved', { path: XRAY_CONFIG_PATH });
  // Keep runtime stable: do not auto-reload or auto-restart Xray on each profile change.
  // Changes are queued and applied by explicit restart.
  setXrayApplyPending(true);
}

function xrayDynamicApplyEnabled(): boolean {
  return XRAY_DYNAMIC_APPLY !== '0';
}

function runtimeUserEmail(profile: Profile): string {
  return profile.username;
}

function buildRuntimeAccount(profile: Profile, inbound: XrayInbound): Record<string, unknown> {
  const protocol = String(inbound.protocol || '').toLowerCase();
  const baseEmail = runtimeUserEmail(profile);
  if (protocol === 'vmess') {
    return { id: profile.uuid, alterId: 0, email: baseEmail };
  }
  if (protocol === 'vless') {
    const account: Record<string, unknown> = { id: profile.uuid, email: baseEmail, encryption: 'none' };
    if (profile.flow) account.flow = profile.flow;
    return account;
  }
  if (protocol === 'trojan') {
    return { password: profile.uuid, email: baseEmail };
  }
  if (protocol === 'shadowsocks') {
    const sourceClient = Array.isArray((inbound.settings as any)?.clients) ? (inbound.settings as any).clients[0] : null;
    const method = normalizeText(String(sourceClient?.method || 'aes-256-gcm')) || 'aes-256-gcm';
    return { method, password: profile.uuid, email: baseEmail };
  }
  if (protocol === 'hysteria2' || protocol === 'hysteria') {
    return { auth: profile.uuid, email: baseEmail };
  }
  return { id: profile.uuid, email: baseEmail };
}

function runXrayAPICommand(command: string, args: string[]): boolean {
  const xrayBin = getXrayCommandBinary();
  const fullCommand = [xrayBin, 'api', command, ...args].join(' ');
  logDebug('xray.api.exec.start', { command, fullCommand });
  try {
    const out = execSync(fullCommand, { stdio: 'pipe', encoding: 'utf8' });
    logDebug('xray.api.exec.success', { command, output: normalizeText(out || '') });
    return true;
  } catch (error: any) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : String(error?.stdout || '');
    const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error?.stderr || '');
    const message = normalizeText(String(error?.message || ''));
    logDebug('xray.api.exec.fail', { command, message, stdout: normalizeText(stdout), stderr: normalizeText(stderr) });
    return false;
  }
}

function addUserRuntimeToInbound(profile: Profile, inbound: XrayInbound): boolean {
  const account = buildRuntimeAccount(profile, inbound);
  const payload = {
    tag: inbound.tag,
    users: [account]
  };
  const filePath = `/tmp/xray-adu-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(filePath, JSON.stringify(payload));
  try {
    return runXrayAPICommand('adu', [`--server=${XRAY_API_ADDRESS}`, filePath]);
  } finally {
    try {
      unlinkSync(filePath);
    } catch {}
  }
}

function removeUserRuntimeFromInbound(profile: Profile, inboundTag: string): boolean {
  const email = runtimeUserEmail(profile);
  logDebug('xray.runtime.remove.request', { inbound: inboundTag, email });
  return runXrayAPICommand('rmu', [`--server=${XRAY_API_ADDRESS}`, email]);
}

function applyUserRuntimeState(profile: Profile): { ok: boolean; message: string } {
  logDebug('xray.runtime.apply.begin', {
    user_id: profile.id,
    username: profile.username,
    enable: profile.enable,
    inbound_tags: profile.inbound_tags || []
  });
  if (!xrayDynamicApplyEnabled()) {
    logDebug('xray.runtime.apply.skip', { reason: 'dynamic apply disabled by env' });
    return { ok: false, message: 'dynamic apply disabled by XRAY_DYNAMIC_APPLY=0' };
  }
  const inbounds = getXrayInbounds();
  if (!inbounds.length) {
    logDebug('xray.runtime.apply.skip', { reason: 'no managed inbounds found in xray config' });
    return { ok: false, message: 'no managed inbounds found in xray config' };
  }

  let failures = 0;
  for (const ib of inbounds) {
    const shouldBeEnabled = profile.enable === 1 && (profile.inbound_tags || []).includes(ib.tag);
    logDebug('xray.runtime.apply.inbound', {
      user_id: profile.id,
      username: profile.username,
      inbound: ib.tag,
      operation: shouldBeEnabled ? 'adu' : 'rmu'
    });
    const applied = shouldBeEnabled
      ? addUserRuntimeToInbound(profile, ib)
      : removeUserRuntimeFromInbound(profile, ib.tag);
    if (!applied) failures++;
  }
  if (failures > 0) {
    logDebug('xray.runtime.apply.failed', { user_id: profile.id, failures });
    return { ok: false, message: `runtime apply failed for ${failures} inbound(s)` };
  }
  logDebug('xray.runtime.apply.success', { user_id: profile.id });
  return { ok: true, message: 'runtime apply completed' };
}

function generateShortToken(length = 10): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function generateUniqueToken(db: Database, maxAttempts = 10): string {
  for (let i = 0; i < maxAttempts; i++) {
    const token = generateShortToken();
    if (!db.profiles.find(p => p.sub_uuid === token)) return token;
  }
  throw new Error('Failed to generate unique token');
}

function getXrayInbounds(): XrayInbound[] {
  try {
    if (!existsSync(XRAY_CONFIG_PATH)) return [];
    const config = JSON.parse(readFileSync(XRAY_CONFIG_PATH, 'utf8'));
    return (config.inbounds || [])
      .filter((ib: any) => ib.tag !== 'api')
      .map((ib: any) => {
        const streamSettings = normalizeStreamSettingsObject(ib.streamSettings || ib.stream_settings || {});
        const next = { ...ib, streamSettings } as any;
        delete next.stream_settings;
        return next;
      });
  } catch {
    return [];
  }
}

interface XrayInstallInfo {
  installed: boolean;
  method: 'official' | 'docker' | 'manual' | 'none';
  version: string;
  configPath: string;
  binPath: string;
}

function detectXray(): XrayInstallInfo {
  const info: XrayInstallInfo = {
    installed: false,
    method: 'none',
    version: '',
    configPath: XRAY_CONFIG_PATH,
    binPath: '/usr/local/bin/xray'
  };

  if (existsSync(info.binPath)) {
    try {
      info.installed = true;
      info.method = 'official';
      info.version = execSync('xray version', { encoding: 'utf8' }).trim().split('\n')[0] || '';
    } catch {
      info.installed = true;
      info.method = 'manual';
    }
  } else if (existsSync('/usr/bin/xray')) {
    info.binPath = '/usr/bin/xray';
    info.installed = true;
    info.method = 'official';
    try {
      info.version = execSync('xray version', { encoding: 'utf8' }).trim().split('\n')[0] || '';
    } catch {}
  }

  return info;
}

function startXray(): boolean {
  try {
    execSync('systemctl enable xray 2>/dev/null || true');
    execSync('systemctl start xray');
    return true;
  } catch {
    return false;
  }
}

function isXrayRunning(): boolean {
  try {
    const result = execSync('systemctl is-active xray', { encoding: 'utf8' });
    return result.trim() === 'active';
  } catch {
    return false;
  }
}

function restartXray(): boolean {
  logDebug('xray.restart.start');
  try {
    execSync('systemctl restart xray');
    logDebug('xray.restart.success');
    return true;
  } catch (error: any) {
    logDebug('xray.restart.fail', { message: normalizeText(String(error?.message || '')) });
    return false;
  }
}

function reloadXray(): { ok: boolean; method: string; detail: string } {
  const attempts: Array<{ method: string; cmd: string }> = [
    { method: 'systemctl reload', cmd: 'systemctl reload xray' }
  ];

  let lastError = 'unknown error';
  for (const attempt of attempts) {
    try {
      execSync(attempt.cmd, { stdio: 'pipe' });
      logDebug('xray.reload.success', { method: attempt.method });
      return { ok: true, method: attempt.method, detail: '' };
    } catch (error: any) {
      const stdout = typeof error?.stdout === 'string' ? error.stdout : String(error?.stdout || '');
      const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error?.stderr || '');
      const message = normalizeText(String(error?.message || ''));
      lastError = normalizeText([message, stdout, stderr].filter(Boolean).join(' | ')) || 'unknown error';
      logDebug('xray.reload.fail.attempt', { method: attempt.method, detail: lastError });
    }
  }

  return { ok: false, method: 'reload/hup', detail: lastError };
}

let statsCache: { at: number; values: Record<string, number> } = { at: 0, values: {} };

function parseXrayStatsOutput(raw: string): Record<string, number> {
  const stats: Record<string, number> = {};
  const trimmed = raw.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as any;
      const statItems = Array.isArray(parsed?.stat)
        ? parsed.stat
        : (Array.isArray(parsed) ? parsed : []);
      for (const item of statItems) {
        const name = typeof item?.name === 'string' ? item.name : '';
        const rawValue = item?.value;
        const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
        if (name && Number.isFinite(value)) {
          stats[name] = Math.max(0, Math.floor(value));
        }
      }
      if (Object.keys(stats).length > 0) return stats;
    } catch {
      // Fall through to plain/proto parsing for older or non-JSON output formats.
    }
  }

  for (const line of raw.split('\n')) {
    const plain = line.match(/^([^"\s][^:]*?)\s+(\d+)$/);
    if (plain && plain[1] && plain[2]) {
      stats[plain[1].trim()] = parseInt(plain[2], 10);
      continue;
    }
    const proto = line.match(/name:\s*"([^"]+)"\s+value:\s*(\d+)/);
    if (proto && proto[1] && proto[2]) {
      stats[proto[1]] = parseInt(proto[2], 10);
    }
  }
  return stats;
}

function runXrayStatsCommand(cmd: string): Record<string, number> {
  try {
    const out = execSync(cmd, { encoding: 'utf8' });
    return parseXrayStatsOutput(out);
  } catch {
    return {};
  }
}

function getXrayCommandBinary(): string {
  if (XRAY_BIN_PATH && existsSync(XRAY_BIN_PATH)) return XRAY_BIN_PATH;
  if (existsSync('/usr/local/bin/xray')) return '/usr/local/bin/xray';
  if (existsSync('/usr/bin/xray')) return '/usr/bin/xray';
  return 'xray';
}

function getXrayStats(forceFresh = false): Record<string, number> {
  const now = Date.now();
  if (!forceFresh && statsCache.at > 0 && now - statsCache.at < STATS_CACHE_TTL_MS) {
    return statsCache.values;
  }

  const xrayBin = getXrayCommandBinary();
  const commands = [
    `${xrayBin} api statsquery --server=${XRAY_API_ADDRESS} --pattern "user>>>"`,
    `${xrayBin} api stats --server=${XRAY_API_ADDRESS}`,
    `${xrayBin} api stats`
  ];
  for (const cmd of commands) {
    const stats = runXrayStatsCommand(cmd);
    if (Object.keys(stats).length > 0) {
      statsCache = { at: now, values: stats };
      return stats;
    }
  }

  statsCache = { at: now, values: {} };
  return {};
}

function refreshAndPersistProfileUsage(forceFresh = false): { stats: Record<string, number>; updated: boolean } {
  const stats = getXrayStats(forceFresh);
  const db = loadDB();
  const usageUpdated = syncProfileUsageFromStats(db, stats);
  const analyticsUpdated = recordAnalyticsSnapshot(db);
  const updated = usageUpdated || analyticsUpdated;
  if (updated) saveDB(db);
  return { stats, updated };
}

function normalizeInboundSettings(settings: any): any {
  const next = { ...(settings || {}) };
  if ('clients' in next) delete next.clients;
  return next;
}

function resolveInboundPort(ib: XrayInbound, settings: Settings): number {
  const port = Number(settings?.global_inbound_port || 0);
  if (Number.isFinite(port) && port >= 1 && port <= 65535) return Math.floor(port);
  return Number(ib.port);
}

function setIfPresent(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  const s = String(value).trim();
  if (s) params.set(key, s);
}

function buildRemarkFragment(title: string, serverDescriptionBase64: string): string {
  const remark = encodeURIComponent(title);
  if (!serverDescriptionBase64) return remark;
  return `${remark}?serverDescription=${encodeURIComponent(serverDescriptionBase64)}`;
}

function toHeaderSafeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function pickRandomString(values: unknown[]): string {
  const pool = values.filter(v => typeof v === 'string' && String(v).trim()).map(v => String(v).trim());
  if (pool.length === 0) return '';
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

function pickRealityShortId(realitySettings: any): string {
  if (!realitySettings) return '';
  if (Array.isArray(realitySettings.shortIds)) {
    const random = pickRandomString(realitySettings.shortIds);
    if (random) return random;
  }
  if (typeof realitySettings.shortId === 'string' && realitySettings.shortId.trim()) return realitySettings.shortId.trim();
  return '';
}

function pickRealityServerName(realitySettings: any): string {
  if (!realitySettings) return '';
  if (Array.isArray(realitySettings.serverNames)) {
    const random = pickRandomString(realitySettings.serverNames);
    if (random) return random;
  }
  if (typeof realitySettings.serverName === 'string' && realitySettings.serverName.trim()) return realitySettings.serverName.trim();
  if (typeof realitySettings.dest === 'string' && realitySettings.dest.trim()) {
    return realitySettings.dest.trim().split(':')[0] || '';
  }
  return '';
}

function applyCommonStreamParams(params: URLSearchParams, streamSettings: XrayStreamSettings) {
  setIfPresent(params, 'security', streamSettings.security);
  setIfPresent(params, 'type', streamSettings.network);
  setIfPresent(
    params,
    'sni',
    streamSettings.tlsSettings?.sni
      || streamSettings.tlsSettings?.serverName
      || pickRealityServerName(streamSettings.realitySettings)
      || streamSettings.sni
  );
  setIfPresent(
    params,
    'fp',
    streamSettings.tlsSettings?.fingerprint
      || streamSettings.realitySettings?.fingerprint
      || streamSettings.fingerprint
  );
  if (streamSettings.tlsSettings?.alpn?.length) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
  else if (Array.isArray(streamSettings.alpn)) params.set('alpn', streamSettings.alpn.join(','));
  else setIfPresent(params, 'alpn', streamSettings.alpn);

  setIfPresent(params, 'pbk', streamSettings.realitySettings?.publicKey);
  setIfPresent(params, 'sid', pickRealityShortId(streamSettings.realitySettings));
  setIfPresent(params, 'spx', streamSettings.realitySettings?.spiderX);

  if (streamSettings.network === 'ws') {
    setIfPresent(params, 'path', streamSettings.wsSettings?.path);
    setIfPresent(params, 'host', streamSettings.wsSettings?.headers?.Host || streamSettings.wsSettings?.host);
    setIfPresent(params, 'eh', streamSettings.wsSettings?.headers ? JSON.stringify(streamSettings.wsSettings.headers) : '');
  } else if (streamSettings.network === 'http' || streamSettings.network === 'h2') {
    const httpPath = Array.isArray(streamSettings.httpSettings?.path)
      ? streamSettings.httpSettings.path[0]
      : streamSettings.httpSettings?.path;
    const httpHost = Array.isArray(streamSettings.httpSettings?.host)
      ? streamSettings.httpSettings.host[0]
      : streamSettings.httpSettings?.host;
    setIfPresent(params, 'path', httpPath);
    setIfPresent(params, 'host', httpHost);
  } else if (streamSettings.network === 'xhttp') {
    setIfPresent(params, 'path', streamSettings.xhttpSettings?.path);
    setIfPresent(params, 'host', streamSettings.xhttpSettings?.host);
    setIfPresent(params, 'mode', streamSettings.xhttpSettings?.mode);
    setIfPresent(params, 'xmux', streamSettings.xhttpSettings?.xmux ? JSON.stringify(streamSettings.xhttpSettings.xmux) : '');
  } else if (streamSettings.network === 'grpc') {
    setIfPresent(params, 'serviceName', streamSettings.grpcSettings?.serviceName);
    setIfPresent(params, 'mode', streamSettings.grpcSettings?.mode);
    setIfPresent(params, 'authority', streamSettings.grpcSettings?.authority);
  } else if (streamSettings.network === 'tcp' || streamSettings.network === 'raw') {
    setIfPresent(params, 'headerType', streamSettings.tcpSettings?.header?.type);
  } else if (streamSettings.network === 'kcp') {
    setIfPresent(params, 'headerType', streamSettings.kcpSettings?.header?.type);
    setIfPresent(params, 'seed', streamSettings.kcpSettings?.seed);
  } else if (streamSettings.network === 'quic') {
    setIfPresent(params, 'quicSecurity', streamSettings.quicSettings?.security);
    setIfPresent(params, 'key', streamSettings.quicSettings?.key);
    setIfPresent(params, 'headerType', streamSettings.quicSettings?.header?.type);
  }
}

function extractHysteriaShareSettings(inboundSettings: any): {
  obfsType: string;
  obfsPassword: string;
  upMbps?: number;
  downMbps?: number;
} {
  const settings = inboundSettings || {};
  const obfsType =
    settings?.obfs?.type
    || settings?.obfs
    || '';
  const obfsPassword =
    settings?.obfs?.password
    || settings?.obfsPassword
    || '';
  const upRaw = settings?.upMbps ?? settings?.up_mbps ?? settings?.up ?? settings?.upstream;
  const downRaw = settings?.downMbps ?? settings?.down_mbps ?? settings?.down ?? settings?.downstream;
  const upMbps = Number(upRaw);
  const downMbps = Number(downRaw);

  return {
    obfsType: typeof obfsType === 'string' ? obfsType.trim() : '',
    obfsPassword: typeof obfsPassword === 'string' ? obfsPassword.trim() : '',
    upMbps: Number.isFinite(upMbps) && upMbps > 0 ? upMbps : undefined,
    downMbps: Number.isFinite(downMbps) && downMbps > 0 ? downMbps : undefined
  };
}

function syncProfileUsageFromStats(db: Database, stats: Record<string, number>): boolean {
  let changed = false;
  for (const p of db.profiles) {
    const uplink = stats[`user>>>${p.username}>>>traffic>>>uplink`] ?? stats[`user>>>${p.username}>>>uplink`] ?? 0;
    const downlink = stats[`user>>>${p.username}>>>traffic>>>downlink`] ?? stats[`user>>>${p.username}>>>downlink`] ?? 0;
    if (p.upload_bytes !== uplink || p.download_bytes !== downlink) {
      p.upload_bytes = uplink;
      p.download_bytes = downlink;
      p.updated_at = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

function buildXrayConfig() {
  const db = loadDB();
  const xrayInbounds = getXrayInbounds();
  let existing: any = {};
  try {
    if (existsSync(XRAY_CONFIG_PATH)) {
      existing = JSON.parse(readFileSync(XRAY_CONFIG_PATH, 'utf8')) || {};
    }
  } catch {}
  
  const config: any = {
    ...existing,
    log: { access: '/var/log/xray/access.log', error: '/var/log/xray/error.log', loglevel: 'warning' },
    api: { tag: 'api', listen: XRAY_API_ADDRESS, services: ['HandlerService', 'StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [] as any[],
    outbounds: (Array.isArray(existing.outbounds) && existing.outbounds.length > 0) ? existing.outbounds : [
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'blocked', protocol: 'blackhole', settings: {} }
    ]
  };

  const existingInboundByTag = new Map<string, any>();
  if (Array.isArray(existing.inbounds)) {
    for (const inbound of existing.inbounds) {
      if (inbound && typeof inbound.tag === 'string') existingInboundByTag.set(inbound.tag, inbound);
    }
  }

  for (const ib of xrayInbounds) {
    const previous = existingInboundByTag.get(ib.tag);
    const inbound: any = {
      tag: ib.tag,
      // Keep address/port from existing config; never overwrite these fields.
      port: previous?.port ?? ib.port,
      listen: previous?.listen ?? ib.listen ?? '0.0.0.0',
      protocol: ib.protocol,
      settings: normalizeInboundSettings(ib.settings),
      allocate: { strategy: 'always' }
    };

    const streamSettings = getInboundStreamSettings(ib);
    if (Object.keys(streamSettings).length > 0) inbound.streamSettings = streamSettings;

    const clients: any[] = [];
    for (const profile of db.profiles.filter(p => p.enable && p.inbound_tags?.includes(ib.tag))) {
      if (ib.protocol === 'vmess') {
        clients.push({ id: profile.uuid, email: profile.username });
      } else if (ib.protocol === 'vless') {
        clients.push({ id: profile.uuid, email: profile.username, flow: profile.flow || 'xtls-rprx-vision' });
      } else if (ib.protocol === 'trojan') {
        const pass = (ib.settings as any)?.clients?.[0]?.password || profile.uuid;
        clients.push({ password: pass, email: profile.username });
      } else if (ib.protocol === 'shadowsocks') {
        const ssSettings = (ib.settings as any)?.clients?.[0] || {};
        clients.push({ method: ssSettings.method || 'aes-256-gcm', password: ssSettings.password || profile.uuid, email: profile.username });
      } else if (ib.protocol === 'hysteria2' || ib.protocol === 'hysteria') {
        clients.push({ auth: profile.uuid, email: profile.username });
      }
    }
    if (clients.length > 0) inbound.settings = { ...inbound.settings, clients };
    config.inbounds.push(inbound);
  }
  
  return config;
}

function getServerAddress(): string {
  try {
    const ip = execSync('curl -s https://api.ipify.org 2>/dev/null || curl -s https://ifconfig.me 2>/dev/null || hostname -I | awk "{print \$1}"', { encoding: 'utf8' }).trim();
    return ip || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

interface SubscriptionPayload {
  meta: string[];
  links: string[];
}

type SubscriptionClient =
  | 'default'
  | 'v2rayn'
  | 'clash'
  | 'mihomo'
  | 'clash-meta';

interface RenderedSubscription {
  contentType: string;
  body: string;
  format: 'base64' | 'uri' | 'text';
}

const SUPPORTED_SUBSCRIPTION_CLIENTS: SubscriptionClient[] = [
  'default',
  'v2rayn',
  'clash',
  'mihomo',
  'clash-meta'
];

const SUBSCRIPTION_CLIENT_ALIASES: Record<string, SubscriptionClient> = {
  default: 'default',
  base64: 'default',
  v2rayn: 'v2rayn',
  clash: 'clash',
  mihomo: 'mihomo',
  'clash-meta': 'clash-meta',
  clashmeta: 'clash-meta'
};

function toBase64Subscription(lines: string[]): string {
  return Buffer.from(lines.join('\n')).toString('base64');
}

function buildSubscriptionPayload(profile: Profile, db: Database): SubscriptionPayload {
  const settingsRoot = db.settings;
  const p = db.profiles.find(v => v.id === profile.id) || profile;
  const globalTitle = settingsRoot.subscription_title || '';
  const globalAnnouncement = settingsRoot.announcement || '';
  const xrayInbounds = getXrayInbounds();
  const fallbackAddress = getServerAddress();
  const serverAddress = p.server_address || fallbackAddress;
  const links: string[] = [];
  const meta: string[] = [];
  meta.push('#subscription-auto-update-enable: 1');
  meta.push(`#profile-update-interval: ${Math.max(1, settingsRoot.profile_update_interval || 2)}`);
  if (globalAnnouncement) meta.push(`#announce: ${globalAnnouncement}`);
  if (settingsRoot.show_traffic_limit || settingsRoot.show_expiration) {
    const total = settingsRoot.show_traffic_limit ? Math.max(0, Math.floor((p.limit_gb || 0) * 1024 * 1024 * 1024)) : 0;
    const upload = settingsRoot.show_traffic_limit ? Math.max(0, Math.floor(p.upload_bytes || 0)) : 0;
    const download = settingsRoot.show_traffic_limit ? Math.max(0, Math.floor(p.download_bytes || 0)) : 0;
    const expire = settingsRoot.show_expiration && p.expires_at ? Math.floor(new Date(p.expires_at).getTime() / 1000) : 0;
    meta.push(`#subscription-userinfo: upload=${upload}; download=${download}; total=${total}; expire=${expire}`);
  }
  
  for (const ib of xrayInbounds) {
    if (!p.inbound_tags?.includes(ib.tag)) continue;
    
    const streamSettings = getInboundStreamSettings(ib);
    const settings = ib.settings as any || {};
    const effectivePort = resolveInboundPort(ib, settingsRoot);
    
    const params = new URLSearchParams();
    const inboundServerDescription = settingsRoot.inbound_remarks?.[ib.tag];
    const inboundRemark = settingsRoot.inbound_link_remarks?.[ib.tag];
    const title = `${inboundRemark || ib.tag}`;
    let serverDescription = '';
    
    if (ib.protocol === 'vmess') {
      const vmess: any = {
        v: '2',
        ps: title,
        add: serverAddress,
        port: effectivePort,
        id: p.uuid,
        aid: 0,
        net: streamSettings.network || 'tcp',
        tls: streamSettings.security || ''
      };
      
      if (streamSettings.tlsSettings) {
        if (streamSettings.tlsSettings.sni) vmess.sni = streamSettings.tlsSettings.sni;
        if (streamSettings.tlsSettings.serverName) vmess.sni = streamSettings.tlsSettings.serverName;
        if (streamSettings.tlsSettings.fingerprint) vmess.fp = streamSettings.tlsSettings.fingerprint;
        if (streamSettings.tlsSettings.alpn) vmess.alpn = streamSettings.tlsSettings.alpn;
      }
      
      if (streamSettings.network === 'ws') {
        if (streamSettings.wsSettings?.path) vmess.path = streamSettings.wsSettings.path;
        if (streamSettings.wsSettings?.headers?.Host) vmess.host = streamSettings.wsSettings.headers.Host;
      } else if (streamSettings.network === 'http' || streamSettings.network === 'h2') {
        const httpPath = Array.isArray(streamSettings.httpSettings?.path) ? streamSettings.httpSettings.path[0] : streamSettings.httpSettings?.path;
        const httpHost = Array.isArray(streamSettings.httpSettings?.host) ? streamSettings.httpSettings.host[0] : streamSettings.httpSettings?.host;
        if (httpPath) vmess.path = httpPath;
        if (httpHost) vmess.host = httpHost;
      } else if (streamSettings.network === 'xhttp') {
        if (streamSettings.xhttpSettings?.path) vmess.path = streamSettings.xhttpSettings.path;
        if (streamSettings.xhttpSettings?.host) vmess.host = streamSettings.xhttpSettings.host;
        if (streamSettings.xhttpSettings?.mode) vmess.mode = streamSettings.xhttpSettings.mode;
      } else if (streamSettings.network === 'grpc') {
        if (streamSettings.grpcSettings?.serviceName) vmess.path = streamSettings.grpcSettings.serviceName;
        if (streamSettings.grpcSettings?.authority) vmess.host = streamSettings.grpcSettings.authority;
      } else if (streamSettings.network === 'tcp' || streamSettings.network === 'raw') {
        if (streamSettings.tcpSettings?.header?.type) vmess.type = streamSettings.tcpSettings.header.type;
      } else if (streamSettings.network === 'kcp') {
        if (streamSettings.kcpSettings?.header?.type) vmess.type = streamSettings.kcpSettings.header.type;
        if (streamSettings.kcpSettings?.seed) vmess.path = streamSettings.kcpSettings.seed;
      } else if (streamSettings.network === 'quic') {
        if (streamSettings.quicSettings?.header?.type) vmess.type = streamSettings.quicSettings.header.type;
      }

      const effectiveDesc = inboundServerDescription || '';
      if (effectiveDesc) vmess.meta = { serverDescription: effectiveDesc };
      
      const encoded = Buffer.from(JSON.stringify(vmess)).toString('base64').replace(/=+$/, '');
      links.push(`vmess://${encoded}`);
      
    } else if (ib.protocol === 'vless') {
      applyCommonStreamParams(params, streamSettings);
      
      params.set('flow', 'xtls-rprx-vision');
      params.set('encryption', 'none');
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      links.push(`vless://${p.uuid}@${serverAddress}:${effectivePort}?${params.toString()}#${remark}`);
      
    } else if (ib.protocol === 'trojan') {
      const password = settings.clients?.[0]?.password || p.uuid;
      applyCommonStreamParams(params, streamSettings);
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      links.push(`trojan://${password}@${serverAddress}:${effectivePort}?${params.toString()}#${remark}`);
      
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = settings.clients?.[0] || {};
      const method = ssSettings.method || 'aes-256-gcm';
      const password = ssSettings.password || p.uuid;
      
      const ssPart = `${method}:${password}`;
      const ssEncoded = Buffer.from(ssPart).toString('base64').replace(/=+$/, '');
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      links.push(`ss://${ssEncoded}@${serverAddress}:${effectivePort}#${remark}`);
      
    } else if (ib.protocol === 'hysteria2' || ib.protocol === 'hysteria') {
      const auth = p.uuid;
      const hySettings = extractHysteriaShareSettings(settings);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      else if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      else if (streamSettings.sni) params.set('sni', streamSettings.sni);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      else if (streamSettings.fingerprint) params.set('fp', streamSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn?.length) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      if (streamSettings.tlsSettings?.allowInsecure) params.set('insecure', '1');
      if (hySettings.obfsType && hySettings.obfsPassword) {
        params.set('obfs', hySettings.obfsType);
        params.set('obfs-password', hySettings.obfsPassword);
      }
      if (hySettings.upMbps) params.set('upmbps', String(hySettings.upMbps));
      if (hySettings.downMbps) params.set('downmbps', String(hySettings.downMbps));
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      links.push(`hy2://${auth}@${serverAddress}:${effectivePort}?${params.toString()}#${remark}`);
      
    } else if (ib.protocol === 'wireguard') {
      const wgSettings = settings || {};
      const privateKey = wgSettings.privateKey || '';
      const peer = wgSettings.peers?.[0] || {};
      const publicKey = peer.publicKey || '';
      const allowedIPs = peer.allowedIPs?.join(',') || '0.0.0.0/0';
      const endpoint = peer.endpoint || `${serverAddress}:${effectivePort}`;
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      const paramsWg = new URLSearchParams();
      paramsWg.set('publicKey', publicKey);
      paramsWg.set('allowedIPs', allowedIPs);
      paramsWg.set('endpoint', endpoint);
      links.push(`wireguard://${privateKey}@${serverAddress}:${effectivePort}?${paramsWg.toString()}#${remark}`);
    }
  }
  
  return { meta, links };
}

function normalizeClientName(raw: string): string {
  return raw.trim().toLowerCase();
}

function resolveSubscriptionClient(raw: string | undefined): SubscriptionClient {
  if (!raw) return 'default';
  return SUBSCRIPTION_CLIENT_ALIASES[normalizeClientName(raw)] || 'default';
}

function detectRequestedClient(req: express.Request): string | undefined {
  const query = req.query as Record<string, unknown>;
  const direct = typeof query.client === 'string'
    ? query.client
    : (typeof query.format === 'string' ? query.format : undefined);
  if (direct) return direct;

  const key = Object.keys(query).find(k => normalizeClientName(k) in SUBSCRIPTION_CLIENT_ALIASES);
  return key;
}

function renderSubscriptionByClient(client: SubscriptionClient, payload: SubscriptionPayload): RenderedSubscription {
  const uriOnly = payload.links;
  const withMeta = [...payload.meta, ...payload.links];
  const formatters: Record<SubscriptionClient, () => RenderedSubscription> = {
    // Keep backward-compatible default output with metadata comments + URI links encoded as base64 text.
    default: () => ({
      contentType: 'text/plain; charset=utf-8',
      body: toBase64Subscription(withMeta),
      format: 'base64'
    }),
    // v2ray-family import expects share links, not comment metadata lines.
    v2rayn: () => ({
      contentType: 'text/plain; charset=utf-8',
      body: toBase64Subscription(uriOnly),
      format: 'base64'
    }),
    // Mihomo/Clash supports URI-type providers directly as plain URI lists.
    clash: () => ({
      contentType: 'text/plain; charset=utf-8',
      body: uriOnly.join('\n'),
      format: 'uri'
    }),
    mihomo: () => ({
      contentType: 'text/plain; charset=utf-8',
      body: uriOnly.join('\n'),
      format: 'uri'
    }),
    'clash-meta': () => ({
      contentType: 'text/plain; charset=utf-8',
      body: uriOnly.join('\n'),
      format: 'uri'
    })
  };

  return (formatters[client] || formatters.default)();
}

function normalizeSubscriptionDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function buildSubscriptionUrls(profile: Profile, settings: Settings): Record<string, string> {
  const customDomain = normalizeSubscriptionDomain(settings.subscription_domain || '');
  const base = customDomain
    ? `https://${customDomain}/${profile.sub_uuid}`
    : `http://${API_HOST || '127.0.0.1'}:${API_PORT}/${profile.sub_uuid}`;
  return {
    default: base,
    v2rayn: `${base}?v2rayn`,
    clash: `${base}?clash`,
    mihomo: `${base}?mihomo`,
    clash_meta: `${base}?clash-meta`
  };
}

app.get('/health', requireAuth, (req, res) => {
  res.json({ status: 'ok', xray_running: isXrayRunning() });
});

app.get('/stats', requireAuth, (req, res) => {
  const { stats } = refreshAndPersistProfileUsage(true);
  const db = loadDB();
  
  const profileStats = db.profiles.map(p => {
    const uplink = stats[`user>>>${p.username}>>>traffic>>>uplink`] ?? stats[`user>>>${p.username}>>>uplink`] ?? p.upload_bytes ?? 0;
    const downlink = stats[`user>>>${p.username}>>>traffic>>>downlink`] ?? stats[`user>>>${p.username}>>>downlink`] ?? p.download_bytes ?? 0;
    
    return { username: p.username, uuid: p.uuid, uplink, downlink };
  });
  
  res.json({ xray: stats, profiles: profileStats });
});

app.get('/api/analytics', requireAuth, (req, res) => {
  refreshAndPersistProfileUsage(true);
  const db = loadDB();
  res.json({
    server: buildServerAnalytics(db)
  });
});

app.get('/api/profiles/:id/analytics', requireAuth, (req, res) => {
  refreshAndPersistProfileUsage(true);
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  res.json({
    profile: buildProfileAnalytics(db, profile),
    server: buildServerAnalytics(db)
  });
});

app.post('/reload', requireAuth, (req, res) => {
  const reload = reloadXray();
  if (reload.ok) {
    setXrayApplyPending(false);
    return res.json({ status: 'ok', method: reload.method });
  }
  res.status(409).json({
    detail: `Reload is not supported in current systemd/xray setup (${reload.method} failed). Use explicit restart.`,
    apply_pending: true
  });
});

app.get('/:token', (req, res) => {
  const db = loadDB();
  const profile = db.profiles.find(p => p.sub_uuid === req.params.token && p.enable);
  
  if (!profile) {
    return res.status(404).json({ detail: 'Profile not found' });
  }
  
  const userinfoTotal = Math.max(0, Math.floor((profile.limit_gb || 0) * 1024 * 1024 * 1024));
  const userinfoUpload = Math.max(0, Math.floor(profile.upload_bytes || 0));
  const userinfoDownload = Math.max(0, Math.floor(profile.download_bytes || 0));
  const userinfoExpire = profile.expires_at ? Math.floor(new Date(profile.expires_at).getTime() / 1000) : 0;
  const userinfo = `upload=${userinfoUpload}; download=${userinfoDownload}; total=${userinfoTotal}; expire=${userinfoExpire}`;
  const profileTitle = db.settings?.subscription_title || '';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('subscription-auto-update-enable', '1');
  res.setHeader('profile-update-interval', String(Math.max(1, db.settings?.profile_update_interval || 2)));
  if (profileTitle) res.setHeader('profile-title', `base64:${Buffer.from(profileTitle).toString('base64')}`);
  if (db.settings?.announcement) {
    const encoded = toHeaderSafeBase64(db.settings.announcement);
    res.setHeader('announce', encoded);
    res.setHeader('announcement', encoded);
  }
  res.setHeader('subscription-userinfo', userinfo);
  const requestedClient = detectRequestedClient(req);
  const resolvedClient = resolveSubscriptionClient(requestedClient);
  const payload = buildSubscriptionPayload(profile, db);
  const rendered = renderSubscriptionByClient(resolvedClient, payload);
  res.setHeader('x-subscription-client-requested', requestedClient || 'default');
  res.setHeader('x-subscription-client-resolved', resolvedClient);
  res.setHeader('x-subscription-format', rendered.format);
  res.setHeader('Content-Type', rendered.contentType);
  res.send(rendered.body);
});

app.get('/api/profiles', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.profiles);
});

app.get('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  res.json(profile);
});

app.post('/api/profiles', requireAuth, (req, res) => {
  const db = loadDB();
  const username = normalizeText(req.body.username);
  const server_address = normalizeText(req.body.server_address);
  const remark = normalizeText(req.body.remark);
  const add_all_inbounds = !!req.body.add_all_inbounds;
  const limit_gb = Number(req.body.limit_gb ?? 0) || 0;
  const expire_days = Number(req.body.expire_days ?? 0) || 0;
  if (!username) return res.status(400).json({ detail: 'Username required' });
  if (db.profiles.some(p => p.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ detail: 'Username already exists' });
  }
  
  const now = new Date().toISOString();
  const profile: Profile = {
    id: db.nextProfileId++,
    uuid: crypto.randomUUID(),
    username,
    enable: 1,
    flow: 'xtls-rprx-vision',
    limit_gb: Math.max(0, limit_gb),
    upload_bytes: 0,
    download_bytes: 0,
    expire_days: Math.max(0, Math.floor(expire_days)),
    expires_at: expire_days > 0 ? new Date(Date.now() + Math.floor(expire_days) * 86400000).toISOString() : '',
    sub_uuid: generateUniqueToken(db),
    inbound_tags: add_all_inbounds ? getXrayInbounds().map(ib => ib.tag) : [],
    server_address: server_address || '',
    remark: remark || username,
    created_at: now,
    updated_at: now
  };

  const previousNextProfileID = db.nextProfileId;
  db.profiles.push(profile);
  try {
    saveDB(db);
    saveConfigAndReload();
    const runtime = applyUserRuntimeState(profile);
    if (runtime.ok) setXrayApplyPending(false);
    res.json({ ...profile, apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
  } catch (error: any) {
    const idx = db.profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) db.profiles.splice(idx, 1);
    db.nextProfileId = previousNextProfileID;
    saveDB(db);
    return res.status(500).json({ detail: error?.message || 'Failed to create profile' });
  }
});

app.delete('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  const idx = db.profiles.findIndex(p => p.id === profile.id);
  if (idx === -1) return res.status(404).json({ detail: 'Profile not found' });
  
  const removed = db.profiles[idx];
  db.profiles.splice(idx, 1);
  saveDB(db);
  saveConfigAndReload();

  const runtime = removed ? applyUserRuntimeState({ ...removed, enable: 0, inbound_tags: removed.inbound_tags || [] }) : { ok: false, message: 'removed profile not found' };
  if (runtime.ok) setXrayApplyPending(false);
  res.json({ status: 'ok', apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
});

app.get('/api/inbounds', requireAuth, (req, res) => {
  res.json(getXrayInbounds());
});

app.get('/api/inbounds/remarks', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.settings?.inbound_remarks || {});
});

app.patch('/api/inbounds/remarks/:tag', requireAuth, (req, res) => {
  const db = loadDB();
  const tag = normalizeText(req.params.tag);
  const xrayInbounds = getXrayInbounds();
  if (!tag || !xrayInbounds.find(ib => ib.tag === tag)) {
    return res.status(400).json({ detail: 'Tag not found in Xray config' });
  }
  const value = normalizeText(req.body.remark);
  if (!db.settings.inbound_remarks) db.settings.inbound_remarks = {};
  if (value) db.settings.inbound_remarks[tag] = value;
  else delete db.settings.inbound_remarks[tag];
  saveDB(db);
  res.json(db.settings.inbound_remarks);
});

app.get('/api/inbounds/link-remarks', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.settings?.inbound_link_remarks || {});
});

app.patch('/api/inbounds/link-remarks/:tag', requireAuth, (req, res) => {
  const db = loadDB();
  const tag = normalizeText(req.params.tag);
  const xrayInbounds = getXrayInbounds();
  if (!tag || !xrayInbounds.find(ib => ib.tag === tag)) {
    return res.status(400).json({ detail: 'Tag not found in Xray config' });
  }
  const value = normalizeText(req.body.remark);
  if (!db.settings.inbound_link_remarks) db.settings.inbound_link_remarks = {};
  if (value) db.settings.inbound_link_remarks[tag] = value;
  else delete db.settings.inbound_link_remarks[tag];
  saveDB(db);
  res.json(db.settings.inbound_link_remarks);
});

app.get('/api/profiles/:id/inbounds', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  res.json(profile.inbound_tags || []);
});

app.post('/api/profiles/:id/inbounds', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  
  const xrayInbounds = getXrayInbounds();
  const assignAll = !!req.body.all;
  if (assignAll) {
    profile.inbound_tags = xrayInbounds.map(ib => ib.tag);
    profile.updated_at = new Date().toISOString();
    saveDB(db);
    saveConfigAndReload();
    const runtime = applyUserRuntimeState(profile);
    if (runtime.ok) setXrayApplyPending(false);
    return res.json({ tags: profile.inbound_tags, apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
  }

  const tag = normalizeText(req.body.tag);
  if (!tag) return res.status(400).json({ detail: 'tag required' });
  if (!xrayInbounds.find(ib => ib.tag === tag)) {
    return res.status(400).json({ detail: 'Tag not found in Xray config' });
  }
  
  if (!profile.inbound_tags) profile.inbound_tags = [];
  if (!profile.inbound_tags.includes(tag)) {
    profile.inbound_tags.push(tag);
    profile.updated_at = new Date().toISOString();
    saveDB(db);
    saveConfigAndReload();
    const runtime = applyUserRuntimeState(profile);
    if (runtime.ok) setXrayApplyPending(false);
    return res.json({ tags: profile.inbound_tags, apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
  }
  
  res.json({ tags: profile.inbound_tags, apply_pending: db.settings?.xray_apply_pending ? 1 : 0 });
});

app.put('/api/profiles/:id/inbounds', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });

  const xrayInbounds = getXrayInbounds();
  const allowedTags = new Set(xrayInbounds.map(ib => ib.tag));
  const input: unknown[] = Array.isArray(req.body?.tags) ? req.body.tags : [];
  const normalized = input
    .map((v: unknown) => normalizeText(v))
    .filter((tag: string) => tag.length > 0);
  const nextTags: string[] = [...new Set(normalized)];
  if (nextTags.some(tag => !allowedTags.has(tag))) {
    return res.status(400).json({ detail: 'One or more inbound tags were not found in Xray config' });
  }

  profile.inbound_tags = nextTags;
  profile.updated_at = new Date().toISOString();
  saveDB(db);
  saveConfigAndReload();
  const runtime = applyUserRuntimeState(profile);
  if (runtime.ok) setXrayApplyPending(false);
  res.json({ tags: profile.inbound_tags, apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
});

app.delete('/api/profiles/:id/inbounds/:tag', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  
  if (!profile.inbound_tags) profile.inbound_tags = [];
  profile.inbound_tags = profile.inbound_tags.filter(t => t !== req.params.tag);
  profile.updated_at = new Date().toISOString();
  saveDB(db);
  saveConfigAndReload();
  const runtime = applyUserRuntimeState(profile);
  if (runtime.ok) setXrayApplyPending(false);
  res.json({ tags: profile.inbound_tags, apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
});

app.post('/api/xray/install', requireAuth, (req, res) => {
  try {
    execSync('bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install', { stdio: 'inherit' });
    startXray();
    res.json({ status: 'ok', message: 'Xray installed' });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

app.post('/api/xray/update', requireAuth, (req, res) => {
  try {
    execSync('bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install', { stdio: 'inherit' });
    startXray();
    res.json({ status: 'ok', message: 'Xray updated' });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

app.get('/api/xray/status', requireAuth, (req, res) => {
  const info = detectXray();
  const db = loadDB();
  res.json({ ...info, apply_pending: db.settings?.xray_apply_pending ? 1 : 0 });
});

app.post('/api/xray/start', requireAuth, (req, res) => {
  if (startXray()) {
    res.json({ status: 'ok' });
  } else {
    res.status(500).json({ detail: 'Failed to start xray' });
  }
});

app.post('/api/xray/restart', requireAuth, (req, res) => {
  if (restartXray()) {
    setXrayApplyPending(false);
    res.json({ status: 'ok' });
  } else {
    res.status(500).json({ detail: 'Failed to restart xray' });
  }
});

app.post('/api/xray/stop', requireAuth, (req, res) => {
  try {
    execSync('systemctl stop xray');
    res.json({ status: 'ok' });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

app.patch('/api/profiles/:id/toggle', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  
  profile.enable = profile.enable ? 0 : 1;
  profile.updated_at = new Date().toISOString();
  saveDB(db);
  saveConfigAndReload();

  const runtime = applyUserRuntimeState(profile);
  if (runtime.ok) setXrayApplyPending(false);
  res.json({ status: 'ok', enable: profile.enable, apply_pending: runtime.ok ? 0 : 1, apply_message: runtime.message });
});

app.patch('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  const previous = { ...profile, inbound_tags: [...(profile.inbound_tags || [])] };

  const username = req.body.username === undefined ? undefined : normalizeText(req.body.username);
  const server_address = req.body.server_address === undefined ? undefined : normalizeText(req.body.server_address);
  const remark = req.body.remark === undefined ? undefined : normalizeText(req.body.remark);
  const limit_gb = req.body.limit_gb === undefined ? undefined : Number(req.body.limit_gb);
  const expire_days = req.body.expire_days === undefined ? undefined : Number(req.body.expire_days);
  const flow = req.body.flow === undefined ? undefined : normalizeText(req.body.flow);

  if (username !== undefined) {
    if (!username) return res.status(400).json({ detail: 'Username cannot be empty' });
    if (db.profiles.some(p => p.id !== profile.id && p.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ detail: 'Username already exists' });
    }
    profile.username = username;
  }
  if (server_address !== undefined) profile.server_address = server_address;
  if (remark !== undefined) profile.remark = remark || profile.username;
  if (limit_gb !== undefined && !Number.isNaN(limit_gb)) profile.limit_gb = Math.max(0, limit_gb);
  if (expire_days !== undefined && !Number.isNaN(expire_days)) {
    const days = Math.max(0, Math.floor(expire_days));
    profile.expire_days = days;
    profile.expires_at = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : '';
  }
  if (flow !== undefined) profile.flow = flow;
  if (req.body.enable !== undefined) profile.enable = req.body.enable ? 1 : 0;

  profile.updated_at = new Date().toISOString();
  saveDB(db);
  saveConfigAndReload();
  const runtimeOld = applyUserRuntimeState({ ...previous, enable: 0 });
  const runtimeNew = applyUserRuntimeState(profile);
  const runtimeOK = runtimeOld.ok && runtimeNew.ok;
  if (runtimeOK) setXrayApplyPending(false);
  res.json({ ...profile, apply_pending: runtimeOK ? 0 : 1, apply_message: runtimeOK ? 'runtime apply completed' : 'runtime apply failed for one or more inbounds' });
});

app.get('/api/settings', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.settings);
});

app.patch('/api/settings', requireAuth, (req, res) => {
  const db = loadDB();
  const subscription_title =
    req.body.subscription_title === undefined ? undefined : normalizeText(req.body.subscription_title);
  const subscription_domain =
    req.body.subscription_domain === undefined ? undefined : normalizeText(req.body.subscription_domain);
  const announcement =
    req.body.announcement === undefined
      ? (req.body.server_description === undefined ? undefined : normalizeText(req.body.server_description))
      : normalizeText(req.body.announcement);
  const inbound_remarks =
    req.body.inbound_remarks === undefined ? undefined : (typeof req.body.inbound_remarks === 'object' && req.body.inbound_remarks ? req.body.inbound_remarks : {});
  const inbound_link_remarks =
    req.body.inbound_link_remarks === undefined ? undefined : (typeof req.body.inbound_link_remarks === 'object' && req.body.inbound_link_remarks ? req.body.inbound_link_remarks : {});
  const profile_update_interval =
    req.body.profile_update_interval === undefined ? undefined : Number(req.body.profile_update_interval);
  const global_inbound_port =
    req.body.global_inbound_port === undefined ? undefined : Number(req.body.global_inbound_port);
  const show_traffic_limit =
    req.body.show_traffic_limit === undefined ? undefined : (req.body.show_traffic_limit ? 1 : 0);
  const show_expiration =
    req.body.show_expiration === undefined ? undefined : (req.body.show_expiration ? 1 : 0);

  if (subscription_title !== undefined) db.settings.subscription_title = subscription_title;
  if (subscription_domain !== undefined) db.settings.subscription_domain = subscription_domain;
  if (announcement !== undefined) db.settings.announcement = announcement;
  if (inbound_remarks !== undefined) db.settings.inbound_remarks = inbound_remarks as Record<string, string>;
  if (inbound_link_remarks !== undefined) db.settings.inbound_link_remarks = inbound_link_remarks as Record<string, string>;
  if (profile_update_interval !== undefined && !Number.isNaN(profile_update_interval)) {
    db.settings.profile_update_interval = Math.max(1, Math.floor(profile_update_interval));
  }
  if (global_inbound_port !== undefined && !Number.isNaN(global_inbound_port)) {
    const normalizedPort = Math.max(0, Math.floor(global_inbound_port));
    db.settings.global_inbound_port = normalizedPort > 65535 ? 65535 : normalizedPort;
  }
  if (show_traffic_limit !== undefined) db.settings.show_traffic_limit = show_traffic_limit;
  if (show_expiration !== undefined) db.settings.show_expiration = show_expiration;
  saveDB(db);
  res.json(db.settings);
});

app.get('/api/profiles/:id/subscription', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  const payload = buildSubscriptionPayload(profile, db);
  const userinfo = {
    upload: Math.max(0, Math.floor(profile.upload_bytes || 0)),
    download: Math.max(0, Math.floor(profile.download_bytes || 0)),
    total: Math.max(0, Math.floor((profile.limit_gb || 0) * 1024 * 1024 * 1024)),
    expire: profile.expires_at ? Math.floor(new Date(profile.expires_at).getTime() / 1000) : 0
  };
  res.json({
    profile_title: db.settings?.subscription_title || '',
    userinfo,
    links: payload.links,
    urls: buildSubscriptionUrls(profile, db.settings),
    supported_clients: SUPPORTED_SUBSCRIPTION_CLIENTS
  });
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const detail = normalizeText(String(error?.message || 'Internal server error')) || 'Internal server error';
  console.error('Unhandled API error:', detail);
  if (res.headersSent) return;
  res.status(500).json({ detail });
});

app.listen(API_PORT, API_HOST, () => {
  console.log(`API server running on ${API_HOST}:${API_PORT}`);

  if (Number.isFinite(STATS_SYNC_INTERVAL_MS) && STATS_SYNC_INTERVAL_MS > 0) {
    const timer = setInterval(() => {
      try {
        refreshAndPersistProfileUsage(false);
      } catch {}
    }, STATS_SYNC_INTERVAL_MS);
    timer.unref?.();
    console.log(`Traffic sync loop enabled: every ${STATS_SYNC_INTERVAL_MS} ms`);
  } else {
    console.log('Traffic sync loop disabled (XRAY_STATS_SYNC_INTERVAL_MS <= 0)');
  }
});
