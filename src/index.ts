#!/usr/bin/env bun

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import crypto from 'crypto';

const DB_DIR = `${homedir()}/.config/xray-cli`;
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = `${DB_DIR}/xray-cli.json`;
const UI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  border: '\x1b[38;5;244m',
  title: '\x1b[38;5;81m',
  ok: '\x1b[38;5;78m',
  err: '\x1b[38;5;203m'
};

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

interface Database {
  profiles: Profile[];
  settings: Settings;
  nextProfileId: number;
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
        show_expiration: raw.settings?.show_expiration === undefined ? 1 : (raw.settings?.show_expiration ? 1 : 0)
      },
      nextProfileId: raw.nextProfileId || 1
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
      show_expiration: 1
    },
    nextProfileId: 1
  };
}

function saveDB(db: Database) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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

const XRAY_CONFIG_PATH = process.env.XRAY_CONFIG_PATH || '/usr/local/etc/xray/config.json';

function ask(question: string): string {
  const ans = prompt(question);
  return ans || '';
}

function clear() {
  console.clear();
}

const MIN_PANEL_WIDTH = 56;
const MAX_PANEL_WIDTH = 96;

function fitText(value: string, width: number): string {
  const text = value || '';
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width <= 1) return '';
  if (width <= 3) return chars.slice(0, width).join('');
  return `${chars.slice(0, width - 1).join('')}…`;
}

function wrapText(value: string, width: number): string[] {
  const normalized = (value || '').replace(/\t/g, '  ');
  if (width <= 1) return [fitText(normalized, 1)];
  const sourceLines = normalized.split('\n');
  const out: string[] = [];

  for (const rawLine of sourceLines) {
    if (!rawLine.trim()) {
      out.push('');
      continue;
    }
    let remaining = rawLine;
    while (Array.from(remaining).length > width) {
      const slice = Array.from(remaining).slice(0, width + 1).join('');
      const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('-'));
      if (breakAt > Math.floor(width * 0.4)) {
        out.push(slice.slice(0, breakAt).trimEnd());
        remaining = remaining.slice(breakAt + 1).trimStart();
      } else {
        out.push(Array.from(remaining).slice(0, width).join(''));
        remaining = Array.from(remaining).slice(width).join('').trimStart();
      }
    }
    out.push(remaining);
  }
  return out;
}

function panelWidth(): number {
  const columns = process.stdout.columns || 80;
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, columns - 4));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function centerLine(text: string): string {
  const columns = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((columns - Array.from(stripAnsi(text)).length) / 2));
  return ' '.repeat(pad) + text;
}

function renderPanel(title: string, lines: string[] = []) {
  const width = panelWidth();
  const inner = width - 2;
  const fullTitle = title === 'XRAY CLI' ? title : `XRAY CLI | ${title}`;

  const normalized: string[] = [];
  for (const line of lines) {
    normalized.push(...wrapText(line, inner));
  }

  console.log('');
  console.log(centerLine(`${UI.title}${fitText(fullTitle, inner).padEnd(inner, ' ')}${UI.reset}`));
  console.log(centerLine(`${UI.border}${UI.dim}${'─'.repeat(inner)}${UI.reset}`));
  for (const line of normalized) {
    console.log(centerLine(`${fitText(line, inner).padEnd(inner, ' ')}`));
  }
  console.log(centerLine(`${UI.border}${UI.dim}${'─'.repeat(inner)}${UI.reset}`));
  console.log('');
}

function promptCentered(question: string): string {
  return prompt(centerLine(fitText(question, panelWidth() - 2))) || '';
}

function showMessage(message: string, ok = true) {
  const prefix = ok ? `${UI.ok}[OK]${UI.reset}` : `${UI.err}[ERR]${UI.reset}`;
  renderPanel('Status', [`${prefix} ${message}`]);
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, Number(value) || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const precision = unit <= 1 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unit]}`;
}

function getProfileByUsername(username: string): Profile | undefined {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return undefined;
  const db = loadDB();
  return db.profiles.find(p => p.username.toLowerCase() === normalized);
}

function normalizeSubscriptionDomain(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function buildSubscriptionUrls(profile: Profile): Record<string, string> {
  const settings = getSettings();
  const customDomain = normalizeSubscriptionDomain(settings.subscription_domain || '');
  const host = process.env.API_HOST || '127.0.0.1';
  const port = Number(process.env.API_PORT) || 2053;
  const base = customDomain ? `https://${customDomain}/${profile.sub_uuid}` : `http://${host}:${port}/${profile.sub_uuid}`;
  return {
    default: base,
    v2rayn: `${base}?v2rayn`,
    clash: `${base}?clash`,
    mihomo: `${base}?mihomo`,
    clash_meta: `${base}?clash-meta`
  };
}

function getProfiles() {
  const db = loadDB();
  return db.profiles.sort((a, b) => b.id - a.id);
}

function getProfile(id: number) {
  const db = loadDB();
  return db.profiles.find(p => p.id === id);
}

function createProfile(
  username: string,
  addAllInbounds?: boolean,
  limitGb?: number,
  expireDays?: number
) {
  const db = loadDB();
  const now = new Date().toISOString();
  const ttlDays = Math.max(0, Math.floor(Number(expireDays || 0)));
  const expiresAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86400000).toISOString() : '';
  
  const profile: Profile = {
    id: db.nextProfileId++,
    uuid: crypto.randomUUID(),
    username,
    enable: 1,
    flow: 'xtls-rprx-vision',
    limit_gb: Math.max(0, Number(limitGb || 0)),
    upload_bytes: 0,
    download_bytes: 0,
    expire_days: ttlDays,
    expires_at: expiresAt,
    sub_uuid: generateUniqueToken(db),
    inbound_tags: addAllInbounds ? getXrayInbounds().map(ib => ib.tag) : [],
    server_address: '',
    remark: username,
    created_at: now,
    updated_at: now
  };
  
  db.profiles.push(profile);
  saveDB(db);
  return profile;
}

function deleteProfile(id: number): boolean {
  const db = loadDB();
  const idx = db.profiles.findIndex(p => p.id === id);
  if (idx === -1) return false;
  
  db.profiles.splice(idx, 1);
  saveDB(db);
  return true;
}

function getProfileInboundTags(profileId: number): string[] {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === profileId);
  return profile?.inbound_tags || [];
}

function setProfileInboundTags(profileId: number, tags: string[]) {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === profileId);
  if (!profile) return;
  profile.inbound_tags = tags;
  profile.updated_at = new Date().toISOString();
  saveDB(db);
}

function setGlobalInboundRemark(tag: string, remark: string) {
  const db = loadDB();
  if (!db.settings.inbound_remarks) db.settings.inbound_remarks = {};
  if (!tag) return;
  if (remark.trim()) db.settings.inbound_remarks[tag] = remark.trim();
  else delete db.settings.inbound_remarks[tag];
  saveDB(db);
}

function updateProfile(id: number, data: { username?: string; enable?: number; flow?: string }) {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === id);
  if (!profile) return;
  
  if (data.username) profile.username = data.username;
  if (data.enable !== undefined) profile.enable = data.enable;
  if (data.flow) profile.flow = data.flow;
  profile.updated_at = new Date().toISOString();
  
  saveDB(db);
}

function getSettings(): Settings {
  const db = loadDB();
  return db.settings || {
    subscription_title: '',
    subscription_domain: '',
    announcement: '',
    inbound_link_remarks: {},
    inbound_remarks: {},
    global_inbound_port: 0,
    profile_update_interval: 2,
    show_traffic_limit: 1,
    show_expiration: 1
  };
}

function updateSettings(newSettings: Partial<Settings>) {
  const db = loadDB();
  db.settings = { ...db.settings, ...newSettings };
  saveDB(db);
}

function updateProfileSettings(
  id: number,
  serverAddress?: string,
  remark?: string,
  limitGb?: number,
  expireDays?: number
) {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === id);
  if (!profile) return;
  
  if (serverAddress !== undefined) profile.server_address = serverAddress;
  if (remark !== undefined) profile.remark = remark;
  if (limitGb !== undefined) profile.limit_gb = Math.max(0, Number(limitGb || 0));
  if (expireDays !== undefined) {
    const ttlDays = Math.max(0, Math.floor(Number(expireDays || 0)));
    profile.expire_days = ttlDays;
    profile.expires_at = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86400000).toISOString() : '';
  }
  profile.updated_at = new Date().toISOString();
  saveDB(db);
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
  } else {
    try {
      execSync('which docker', { stdio: 'ignore' });
      execSync('docker ps --format "{{.Names}}" | grep -Eq "^xray$|^xray-"', { stdio: 'ignore' });
      info.installed = true;
      info.method = 'docker';
      info.configPath = '/var/lib/docker/volumes/xray-config/_data/config.json';
      info.binPath = 'docker';
    } catch {}
  }

  return info;
}

function installXray(): boolean {
  try {
    console.log('Installing xray-core...');
    execSync('bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install', { stdio: 'inherit' });
    return true;
  } catch (e: any) {
    console.log(`✗ Failed to install: ${e.message}`);
    return false;
  }
}

function updateXray(): boolean {
  try {
    console.log('Updating xray-core...');
    execSync('bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install', { stdio: 'inherit' });
    return true;
  } catch (e: any) {
    console.log(`✗ Failed to update: ${e.message}`);
    return false;
  }
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

function reloadXrayService(): boolean {
  try {
    execSync('systemctl reload xray');
    return true;
  } catch {
    try {
      execSync('systemctl restart xray');
      return true;
    } catch {
      return false;
    }
  }
}

function validateXrayConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  try {
    if (!existsSync(XRAY_CONFIG_PATH)) {
      errors.push(`Config file not found: ${XRAY_CONFIG_PATH}`);
      return { valid: false, errors };
    }
    
    const configContent = readFileSync(XRAY_CONFIG_PATH, 'utf8');
    const config = JSON.parse(configContent);
    
    if (!config.inbounds || !Array.isArray(config.inbounds)) {
      errors.push('Missing or invalid "inbounds" array');
    } else {
      for (const ib of config.inbounds) {
        if (!ib.tag) errors.push('Inbound missing "tag"');
        if (!ib.port) errors.push(`Inbound ${ib.tag || 'unknown'} missing "port"`);
        if (!ib.protocol) errors.push(`Inbound ${ib.tag || 'unknown'} missing "protocol"`);
        
        if (ib.protocol === 'vmess' || ib.protocol === 'vless' || ib.protocol === 'trojan' || ib.protocol === 'shadowsocks') {
          if (!ib.settings?.clients || ib.settings.clients.length === 0) {
            errors.push(`Inbound ${ib.tag} has no clients configured`);
          }
        }
      }
    }
    
    if (!config.outbounds || !Array.isArray(config.outbounds)) {
      errors.push('Missing or invalid "outbounds" array');
    }
    
  } catch (e: any) {
    if (e instanceof SyntaxError) {
      errors.push(`Invalid JSON: ${e.message}`);
    } else {
      errors.push(`Error reading config: ${e.message}`);
    }
  }
  
  return { valid: errors.length === 0, errors };
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
    api: { tag: 'api', listen: '127.0.0.1:8080', services: ['StatsService'] },
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
  
  if (config.routing && Array.isArray(config.routing.rules)) {
    config.routing = {
      ...config.routing,
      rules: config.routing.rules.filter((rule: any) => !(Array.isArray(rule?.inboundTag) && rule.inboundTag.includes('api')))
    };
  }
  
  return config;
}

function reloadXray() {
  try {
    const config = buildXrayConfig();
    mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
    writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
    if (!reloadXrayService()) throw new Error('systemctl reload/restart failed');
    console.log('✓ xray config reloaded');
  } catch (e: any) {
    console.log('✗ Failed to reload:', e.message);
  }
}

function getServerAddress(): string {
  try {
    const ip = execSync('curl -s https://api.ipify.org 2>/dev/null || curl -s https://ifconfig.me 2>/dev/null || hostname -I | awk "{print \\$1}"', { encoding: 'utf8' }).trim();
    return ip || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

function generateSubscription(profile: Profile): string {
  const db = loadDB();
  const settings = db.settings || getSettings();
  const p = db.profiles.find(v => v.id === profile.id) || profile;
  const xrayInbounds = getXrayInbounds();
  const fallbackAddress = getServerAddress();
  const serverAddress = p.server_address || fallbackAddress;
  const links: string[] = [];
  const meta: string[] = [];
  meta.push('#subscription-auto-update-enable: 1');
  meta.push(`#profile-update-interval: ${Math.max(1, settings.profile_update_interval || 2)}`);
  if (settings.announcement) meta.push(`#announce: ${settings.announcement}`);
  if (settings.show_traffic_limit || settings.show_expiration) {
    const total = settings.show_traffic_limit ? Math.max(0, Math.floor((p.limit_gb || 0) * 1024 * 1024 * 1024)) : 0;
    const upload = settings.show_traffic_limit ? Math.max(0, Math.floor(p.upload_bytes || 0)) : 0;
    const download = settings.show_traffic_limit ? Math.max(0, Math.floor(p.download_bytes || 0)) : 0;
    const expire = settings.show_expiration && p.expires_at ? Math.floor(new Date(p.expires_at).getTime() / 1000) : 0;
    meta.push(`#subscription-userinfo: upload=${upload}; download=${download}; total=${total}; expire=${expire}`);
  }
  const titlePrefix = '';
  
  for (const ib of xrayInbounds) {
    if (!p.inbound_tags?.includes(ib.tag)) continue;
    const streamSettings = getInboundStreamSettings(ib);
    const inboundSettings = (ib.settings as any) || {};
    const effectivePort = resolveInboundPort(ib, settings);
    const inboundServerDescription = settings.inbound_remarks?.[ib.tag];
    const inboundRemark = settings.inbound_link_remarks?.[ib.tag];
    const title = `${titlePrefix}${inboundRemark || ib.tag}`;
    const effectiveDesc = inboundServerDescription || '';
    const serverDescription = effectiveDesc || '';
    const remarkFragment = buildRemarkFragment(title, serverDescription);
    
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
      if (effectiveDesc) vmess.meta = { serverDescription: effectiveDesc };
      const encoded = Buffer.from(JSON.stringify(vmess)).toString('base64');
      links.push(`vmess://${encoded}`);
    } else if (ib.protocol === 'vless') {
      const params = new URLSearchParams();
      applyCommonStreamParams(params, streamSettings);
      params.set('flow', profile.flow || 'xtls-rprx-vision');
      params.set('encryption', 'none');
      links.push(`vless://${p.uuid}@${serverAddress}:${effectivePort}?${params.toString()}#${remarkFragment}`);
    } else if (ib.protocol === 'trojan') {
      const params = new URLSearchParams();
      const pass = inboundSettings?.clients?.[0]?.password || p.uuid;
      applyCommonStreamParams(params, streamSettings);
      links.push(`trojan://${pass}@${serverAddress}:${effectivePort}?${params.toString()}#${remarkFragment}`);
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = inboundSettings?.clients?.[0] || {};
      const ss = `${ssSettings.method || 'aes-256-gcm'}:${ssSettings.password || p.uuid}@${serverAddress}:${effectivePort}`;
      links.push(`ss://${Buffer.from(ss).toString('base64')}#${remarkFragment}`);
    } else if (ib.protocol === 'hysteria2' || ib.protocol === 'hysteria') {
      const params = new URLSearchParams();
      const auth = p.uuid;
      const hySettings = extractHysteriaShareSettings(inboundSettings);
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
      links.push(`hy2://${auth}@${serverAddress}:${effectivePort}?${params.toString()}#${remarkFragment}`);
    }
  }
  
  return Buffer.from([...meta, ...links].join('\n')).toString('base64');
}

async function dashboard() {
  clear();

  let xrayStatus = 'Unknown';
  try {
    xrayStatus = execSync('systemctl is-active xray', { encoding: 'utf8' }).trim();
  } catch {}
  
  const db = loadDB();
  const profiles = db.profiles;
  const xrayInbounds = getXrayInbounds();

  const lines: string[] = [
    `Status: ${xrayStatus === 'active' ? 'RUNNING' : 'STOPPED'}`,
    `Profiles: ${profiles.length}`,
    `Inbounds: ${xrayInbounds.length}`,
    '',
    'Profiles',
  ];

  if (profiles.length === 0) {
    lines.push('No profiles found.');
  } else {
    profiles.forEach((p, idx) => {
      const state = p.enable ? 'Enabled' : 'Disabled';
      const usedBytes = Math.max(0, Number(p.upload_bytes || 0) + Number(p.download_bytes || 0));
      const limitBytes = Math.max(0, Number(p.limit_gb || 0) * 1024 * 1024 * 1024);
      const usageLabel = limitBytes > 0
        ? `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}`
        : `${formatBytes(usedBytes)} used`;
      const usagePercent = limitBytes > 0 ? ` (${Math.min(100, Math.floor((usedBytes / limitBytes) * 100))}%)` : '';
      lines.push(`${idx + 1}. ${p.username} (${state})`);
      lines.push(`   Inbounds: ${(p.inbound_tags || []).length}  |  Limit: ${p.limit_gb} GB  |  Expire: ${p.expire_days || 0}d`);
      lines.push(`   Traffic: ${usageLabel}${usagePercent}  |  Up ${formatBytes(p.upload_bytes || 0)}  Down ${formatBytes(p.download_bytes || 0)}`);
      lines.push('');
    });
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
  }

  renderPanel('Dashboard', lines);
  promptCentered('Press Enter to continue...');
}

async function listProfiles() {
  const profiles = getProfiles();

  const lines = ['Profiles', ''];
  if (profiles.length === 0) {
    lines.push('No profiles found.');
  } else {
    profiles.forEach((p, idx) => {
      const state = p.enable ? 'Enabled' : 'Disabled';
      const usedBytes = Math.max(0, Number(p.upload_bytes || 0) + Number(p.download_bytes || 0));
      const limitBytes = Math.max(0, Number(p.limit_gb || 0) * 1024 * 1024 * 1024);
      const usageLabel = limitBytes > 0
        ? `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}`
        : `${formatBytes(usedBytes)} used`;
      const usagePercent = limitBytes > 0 ? ` (${Math.min(100, Math.floor((usedBytes / limitBytes) * 100))}%)` : '';
      lines.push(`${idx + 1}. ${p.username} (${state})`);
      lines.push(`   Token: ${(p.sub_uuid || '').slice(0, 10)}  |  Limit: ${p.limit_gb} GB  |  Expire: ${p.expire_days || 0}d`);
      lines.push(`   Inbounds: ${(p.inbound_tags || []).length}`);
      lines.push(`   Traffic: ${usageLabel}${usagePercent}  |  Up ${formatBytes(p.upload_bytes || 0)}  Down ${formatBytes(p.download_bytes || 0)}`);
      lines.push('');
    });
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
  }
  renderPanel('Profiles', lines);
}

async function manageInbounds(profileId: number) {
  if (!getProfile(profileId)) return;
  
  while (true) {
    clear();
    
    const profile = getProfile(profileId);
    if (!profile) return;
    const xrayInbounds = getXrayInbounds();
    const settingsRoot = getSettings();
    const currentTags = profile.inbound_tags || [];
    const lines = ['Available Inbounds', ''];

    const globalInboundRemarks = getSettings().inbound_link_remarks || {};
    for (const ib of xrayInbounds) {
      const selected = currentTags.includes(ib.tag) ? '[x]' : '[ ]';
      const inboundRemark = globalInboundRemarks[ib.tag] || '-';
      lines.push(`${selected} ${ib.tag}  |  ${ib.protocol}:${resolveInboundPort(ib, settingsRoot)}  |  ${inboundRemark}`);
    }
    lines.push('');
    lines.push(`Current tags: ${currentTags.length > 0 ? currentTags.join(', ') : 'none'}`);
    lines.push('');
    lines.push('1. Add inbound by tag');
    lines.push('2. Remove inbound by tag');
    lines.push('3. Add all inbounds');
    lines.push('4. Remove all inbounds');
    lines.push('0. Back');
    renderPanel(`Inbounds | ${profile.username}`, lines);
    
    const choice = promptCentered('Select: ');
    
    if (choice === '1') {
      const tag = promptCentered('Inbound tag to add: ');
      if (!tag) continue;
      
      const exists = xrayInbounds.find(ib => ib.tag === tag);
      if (!exists) {
        showMessage('Inbound tag not found in Xray config', false);
        promptCentered('Press Enter to continue...');
        continue;
      }
      
      if (!currentTags.includes(tag)) {
        setProfileInboundTags(profileId, [...currentTags, tag]);
        showMessage('Inbound added');
        reloadXray();
      } else {
        showMessage('Inbound already added', false);
      }
    } else if (choice === '2') {
      const tag = promptCentered('Inbound tag to remove: ');
      if (!tag) continue;
      
      if (currentTags.includes(tag)) {
        setProfileInboundTags(profileId, currentTags.filter(t => t !== tag));
        showMessage('Inbound removed');
        reloadXray();
      } else {
        showMessage('Inbound tag not assigned to this username', false);
      }
    } else if (choice === '3') {
      setProfileInboundTags(profileId, xrayInbounds.map(ib => ib.tag));
      showMessage('All inbounds added');
      reloadXray();
    } else if (choice === '4') {
      setProfileInboundTags(profileId, []);
      showMessage('All inbounds removed');
      reloadXray();
    } else {
      break;
    }
  }
}

async function subscriptionUrl(profileId: number) {
  const profile = getProfile(profileId);
  if (!profile) return;
  const urls = buildSubscriptionUrls(profile);
  const lines = [
    `Username: ${profile.username}`,
    '',
    'Default',
    urls.default || '',
    '',
    'Client Specific',
    `v2rayN: ${urls.v2rayn}`,
    `Clash: ${urls.clash}`,
    `Mihomo (alias): ${urls.mihomo}`,
    `Clash Meta: ${urls.clash_meta}`
  ];
  
  clear();
  renderPanel(`Subscription URLs | ${profile.username}`, lines);
  promptCentered('Press Enter to continue...');
}

async function xrayManagement() {
  while (true) {
    clear();
    const info = detectXray();
    const lines = [
      `Status: ${info.installed ? 'INSTALLED' : 'NOT INSTALLED'}`,
      `Method: ${info.method}`,
      info.version ? `Version: ${info.version}` : 'Version: unknown',
      `Config: ${info.configPath}`,
      '',
      '1. Install Xray',
      '2. Update Xray',
      '3. Start/Restart',
      '4. Stop',
      '5. Validate Config',
      '0. Back'
    ];
    renderPanel('Xray Management', lines);
    
    const choice = promptCentered('Select: ') || '';
    
    if (choice === '1') {
      if (installXray()) {
        console.log('✓ Xray installed');
        startXray();
      }
    } else if (choice === '2') {
      if (updateXray()) {
        console.log('✓ Xray updated');
        startXray();
      }
    } else if (choice === '3') {
      if (startXray()) {
        console.log('✓ Xray started/restarted');
      } else {
        console.log('✗ Failed to start Xray');
      }
    } else if (choice === '4') {
      try {
        execSync('systemctl stop xray');
        console.log('✓ Xray stopped');
      } catch {
        console.log('✗ Failed to stop Xray');
      }
    } else if (choice === '5') {
      clear();
      const lines: string[] = [];
      const result = validateXrayConfig();
      if (result.valid) {
        lines.push('Config is valid');
      } else {
        lines.push('Config has errors');
        lines.push('');
        for (const err of result.errors) {
          lines.push(`- ${err}`);
        }
      }
      renderPanel('Config Validation', lines);
      promptCentered('Press Enter to continue...');
    } else {
      break;
    }
    promptCentered('Press Enter to continue...');
  }
}

async function main() {
  while (true) {
    clear();
    const info = detectXray();
    renderPanel('Main Menu', [
      `Xray: ${info.installed ? (info.version || 'Installed') : 'Not installed'}`,
      '',
      '1. Dashboard',
      '2. Profiles',
      '3. Xray Management',
      '4. Settings',
      '0. Exit'
    ]);
    
    const choice = promptCentered('Select: ') || '';
    
    if (choice === '1') {
      await dashboard();
    } else if (choice === '2') {
      await listProfiles();
      
      renderPanel('Profile Actions', [
        '1. Add Profile',
        '2. Delete by Username',
        '3. Toggle by Username',
        '4. Manage Inbounds',
        '5. View Subscription',
        '6. Edit Profile',
        '0. Back'
      ]);
      
      const sub = promptCentered('Select: ') || '';
      
      if (sub === '1') {
        const username = promptCentered('Username: ');
        if (username) {
          const addAllInbounds = promptCentered('Add all inbounds now? (y/n): ');
          const limitGb = Number(promptCentered('Traffic limit GB (0 = no limit): ') || '0');
          const expireDays = Number(promptCentered('Expiration period in days (0 = none): ') || '0');
          const profile = createProfile(
            username,
            addAllInbounds.toLowerCase() === 'y',
            limitGb || 0,
            expireDays || 0
          );
          showMessage(`Profile created: ${profile.username}`);
          if (addAllInbounds.toLowerCase() === 'y') {
            reloadXray();
          } else {
            const add = promptCentered('Manage inbounds now? (y/n): ');
            if (add.toLowerCase() === 'y') {
              await manageInbounds(profile.id);
            }
          }
        }
      } else if (sub === '2') {
        const username = promptCentered('Username to delete: ');
        const profile = getProfileByUsername(username);
        if (profile && deleteProfile(profile.id)) {
          showMessage(`Profile deleted: ${profile.username}`);
          reloadXray();
        } else {
          showMessage('Username not found', false);
        }
      } else if (sub === '3') {
        const username = promptCentered('Username to toggle: ');
        const profile = getProfileByUsername(username);
        if (profile) {
          profile.enable = profile.enable ? 0 : 1;
          updateProfile(profile.id, { enable: profile.enable });
          showMessage(`Username ${profile.username} ${profile.enable ? 'enabled' : 'disabled'}`);
          reloadXray();
        } else {
          showMessage('Username not found', false);
        }
      } else if (sub === '4') {
        const username = promptCentered('Username: ');
        const profile = getProfileByUsername(username);
        if (!profile) {
          showMessage('Username not found', false);
        } else {
          await manageInbounds(profile.id);
        }
      } else if (sub === '5') {
        const username = promptCentered('Username: ');
        const profile = getProfileByUsername(username);
        if (!profile) {
          showMessage('Username not found', false);
        } else {
          await subscriptionUrl(profile.id);
        }
      } else if (sub === '6') {
        const username = promptCentered('Username: ');
        const profile = getProfileByUsername(username);
        if (profile) {
          const newAddr = promptCentered(`Server address (${profile.server_address || 'auto'}): `);
          const newRemark = promptCentered(`Remark (${profile.remark || profile.username}): `);
          const newLimitGb = promptCentered(`Traffic limit GB (${profile.limit_gb || 0}): `);
          const newExpireDays = promptCentered(`Expiration days (${profile.expire_days || 0}): `);
          if (newAddr !== '' || newRemark !== '' || newLimitGb !== '' || newExpireDays !== '') {
            updateProfileSettings(
              profile.id,
              newAddr || profile.server_address,
              newRemark || profile.remark,
              newLimitGb === '' ? profile.limit_gb : Number(newLimitGb),
              newExpireDays === '' ? profile.expire_days : Number(newExpireDays)
            );
            showMessage(`Profile updated: ${profile.username}`);
          }
        } else {
          showMessage('Username not found', false);
        }
      }
    } else if (choice === '3') {
      await xrayManagement();
    } else if (choice === '4') {
      while (true) {
        clear();
        const settings = getSettings();
        renderPanel('Settings', [
          `API Port: 2053`,
          `Subscription Title: ${settings.subscription_title || '(default)'}`,
          `Subscription Domain: ${settings.subscription_domain || '(not set)'}`,
          `Global Inbound Port: ${settings.global_inbound_port || '(original per inbound)'}`,
          `Announcement: ${settings.announcement || '(none)'}`,
          `Auto Update Interval (h): ${settings.profile_update_interval || 2}`,
          `Show Traffic Limit: ${settings.show_traffic_limit ? 'ON' : 'OFF'}`,
          `Show Expiration: ${settings.show_expiration ? 'ON' : 'OFF'}`,
          '',
          '1. Set Subscription Title',
          '2. Set Subscription Domain (domain:port)',
          '3. Set Announcement (global)',
          '4. Set Auto Update Interval (hours)',
          '5. Set Global Inbound Port (1-65535, 0 to disable)',
          '6. Toggle Show Traffic Limit',
          '7. Toggle Show Expiration',
          '8. Set Global Inbound ServerDescription',
          '9. Set Global Inbound Remark',
          '0. Back'
        ]);

        const s = promptCentered('Select: ');
        if (s === '1') {
          const title = promptCentered('Subscription title: ');
          updateSettings({ subscription_title: title });
          showMessage('Subscription title updated');
        } else if (s === '2') {
          const domain = promptCentered('Subscription domain (example.com:6000, empty to unset): ');
          updateSettings({ subscription_domain: domain.trim() });
          showMessage('Subscription domain updated');
        } else if (s === '3') {
          const desc = promptCentered('Announcement: ');
          updateSettings({ announcement: desc });
          showMessage('Announcement updated');
        } else if (s === '4') {
          const hours = Number(promptCentered(`Auto update interval hours (${settings.profile_update_interval || 2}): `) || '2');
          updateSettings({ profile_update_interval: Math.max(1, Math.floor(hours || 2)) });
          showMessage('Auto update interval saved');
        } else if (s === '5') {
          const rawPort = Number(promptCentered(`Global inbound port (${settings.global_inbound_port || 0}): `) || '0');
          const normalizedPort = Math.max(0, Math.floor(Number.isFinite(rawPort) ? rawPort : 0));
          updateSettings({ global_inbound_port: normalizedPort > 65535 ? 65535 : normalizedPort });
          showMessage('Global inbound port updated');
          reloadXray();
        } else if (s === '6') {
          updateSettings({ show_traffic_limit: settings.show_traffic_limit ? 0 : 1 });
          showMessage('Traffic-limit display updated');
        } else if (s === '7') {
          updateSettings({ show_expiration: settings.show_expiration ? 0 : 1 });
          showMessage('Expiration display updated');
        } else if (s === '8') {
          const tag = promptCentered('Inbound tag: ');
          const xrayInbounds = getXrayInbounds();
          if (!tag || !xrayInbounds.find(ib => ib.tag === tag)) {
            showMessage('Inbound tag not found', false);
          } else {
            const current = settings.inbound_remarks?.[tag] || '';
            const value = promptCentered(`ServerDescription for ${tag} (${current || 'empty'}): `);
            setGlobalInboundRemark(tag, value);
            showMessage('Per-inbound serverDescription updated');
          }
        } else if (s === '9') {
          const tag = promptCentered('Inbound tag: ');
          const xrayInbounds = getXrayInbounds();
          if (!tag || !xrayInbounds.find(ib => ib.tag === tag)) {
            showMessage('Inbound tag not found', false);
          } else {
            const current = settings.inbound_link_remarks?.[tag] || '';
            const value = promptCentered(`Remark for ${tag} (${current || 'empty'}): `);
            const db = loadDB();
            if (!db.settings.inbound_link_remarks) db.settings.inbound_link_remarks = {};
            if (value.trim()) db.settings.inbound_link_remarks[tag] = value.trim();
            else delete db.settings.inbound_link_remarks[tag];
            saveDB(db);
            showMessage('Per-inbound remark updated');
          }
        } else {
          break;
        }
        promptCentered('Press Enter to continue...');
      }
    } else if (choice === '0') {
      break;
    }
  }
}

main();
