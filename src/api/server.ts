import express from 'express';
import { exec, execSync } from 'child_process';
import { writeFileSync } from 'fs';
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
  announcement: string;
  inbound_link_remarks: Record<string, string>;
  inbound_remarks: Record<string, string>;
  profile_update_interval: number;
  show_traffic_limit: number;
  show_expiration: number;
}

interface Database {
  profiles: Profile[];
  settings: Settings;
  nextProfileId: number;
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
        announcement: raw.settings?.announcement || raw.settings?.server_description || '',
        inbound_link_remarks: raw.settings?.inbound_link_remarks || {},
        inbound_remarks: raw.settings?.inbound_remarks || {},
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
      announcement: '',
      inbound_link_remarks: {},
      inbound_remarks: {},
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

const app = express();
app.use(express.json({ limit: '256kb' }));

const XRAY_CONFIG_PATH = process.env.XRAY_CONFIG_PATH || '/usr/local/etc/xray/config.json';
const API_PORT = Number(process.env.API_PORT) || 2053;
const API_HOST = process.env.API_HOST || '127.0.0.1';
const API_KEY = process.env.API_KEY || '';

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

function saveConfigAndReload(): void {
  const config = buildXrayConfig();
  mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  reloadXray();
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
  try {
    execSync('systemctl restart xray');
    return true;
  } catch {
    return false;
  }
}

function reloadXray(): boolean {
  try {
    execSync('systemctl reload xray');
    return true;
  } catch {
    return restartXray();
  }
}

function getXrayStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  try {
    const result = execSync('xray api stats', { encoding: 'utf8' });
    for (const line of result.split('\n')) {
      const match = line.match(/(.+?) (\d+)$/);
      if (match && match[1] && match[2]) stats[match[1]] = parseInt(match[2], 10);
    }
  } catch {}
  return stats;
}

function normalizeInboundSettings(settings: any): any {
  const next = { ...(settings || {}) };
  if ('clients' in next) delete next.clients;
  return next;
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
    api: { tag: 'api', services: ['LoggerService', 'StatsService'] },
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
  
  for (const ib of xrayInbounds) {
    const inbound: any = {
      tag: ib.tag,
      port: ib.port,
      listen: ib.listen || '0.0.0.0',
      protocol: ib.protocol,
      settings: normalizeInboundSettings(ib.settings),
      allocate: { strategy: 'always' }
    };
    
    const streamSettings = getInboundStreamSettings(ib);
    if (Object.keys(streamSettings).length > 0) {
      inbound.streamSettings = streamSettings;
    }
    
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
  
  config.inbounds.push({
    tag: 'api',
    port: 62789,
    listen: '127.0.0.1',
    protocol: 'dokodemo-door',
    settings: { address: '127.0.0.1' }
  });
  
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

function generateSubscription(profile: Profile): string {
  const db = loadDB();
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
        port: ib.port,
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
      links.push(`vless://${p.uuid}@${serverAddress}:${ib.port}?${params.toString()}#${remark}`);
      
    } else if (ib.protocol === 'trojan') {
      const password = settings.clients?.[0]?.password || p.uuid;
      applyCommonStreamParams(params, streamSettings);
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      links.push(`trojan://${password}@${serverAddress}:${ib.port}?${params.toString()}#${remark}`);
      
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = settings.clients?.[0] || {};
      const method = ssSettings.method || 'aes-256-gcm';
      const password = ssSettings.password || p.uuid;
      
      const ssPart = `${method}:${password}`;
      const ssEncoded = Buffer.from(ssPart).toString('base64').replace(/=+$/, '');
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      links.push(`ss://${ssEncoded}@${serverAddress}:${ib.port}#${remark}`);
      
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
      links.push(`hy2://${auth}@${serverAddress}:${ib.port}?${params.toString()}#${remark}`);
      
    } else if (ib.protocol === 'wireguard') {
      const wgSettings = settings || {};
      const privateKey = wgSettings.privateKey || '';
      const peer = wgSettings.peers?.[0] || {};
      const publicKey = peer.publicKey || '';
      const allowedIPs = peer.allowedIPs?.join(',') || '0.0.0.0/0';
      const endpoint = peer.endpoint || `${serverAddress}:${ib.port}`;
      
      const effectiveDesc = inboundServerDescription || '';
      serverDescription = effectiveDesc || '';
      const remark = buildRemarkFragment(title, serverDescription);
      const paramsWg = new URLSearchParams();
      paramsWg.set('publicKey', publicKey);
      paramsWg.set('allowedIPs', allowedIPs);
      paramsWg.set('endpoint', endpoint);
      links.push(`wireguard://${privateKey}@${serverAddress}:${ib.port}?${paramsWg.toString()}#${remark}`);
    }
  }
  
  return Buffer.from([...meta, ...links].join('\n')).toString('base64');
}

app.get('/health', requireAuth, (req, res) => {
  res.json({ status: 'ok', xray_running: isXrayRunning() });
});

app.get('/stats', requireAuth, (req, res) => {
  const stats = getXrayStats();
  const db = loadDB();
  if (syncProfileUsageFromStats(db, stats)) saveDB(db);
  
  const profileStats = db.profiles.map(p => {
    const uplink = stats[`user>>>${p.username}>>>traffic>>>uplink`] ?? stats[`user>>>${p.username}>>>uplink`] ?? p.upload_bytes ?? 0;
    const downlink = stats[`user>>>${p.username}>>>traffic>>>downlink`] ?? stats[`user>>>${p.username}>>>downlink`] ?? p.download_bytes ?? 0;
    
    return { username: p.username, uuid: p.uuid, uplink, downlink };
  });
  
  res.json({ xray: stats, profiles: profileStats });
});

app.post('/reload', requireAuth, (req, res) => {
  try {
    saveConfigAndReload();
    res.json({ status: 'ok' });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
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
  res.send(generateSubscription(profile));
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
  
  db.profiles.push(profile);
  saveDB(db);
  saveConfigAndReload();
  
  res.json(profile);
});

app.delete('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  const idx = db.profiles.findIndex(p => p.id === profile.id);
  if (idx === -1) return res.status(404).json({ detail: 'Profile not found' });
  
  db.profiles.splice(idx, 1);
  saveDB(db);
  saveConfigAndReload();
  
  res.json({ status: 'ok' });
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
    return res.json(profile.inbound_tags);
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
  }
  
  res.json(profile.inbound_tags);
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
  
  res.json(profile.inbound_tags);
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
  res.json(info);
});

app.post('/api/xray/start', requireAuth, (req, res) => {
  if (startXray()) {
    res.json({ status: 'ok' });
  } else {
    res.status(500).json({ detail: 'Failed to start xray' });
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
  
  res.json({ status: 'ok', enable: profile.enable });
});

app.patch('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });

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
  res.json(profile);
});

app.get('/api/settings', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.settings);
});

app.patch('/api/settings', requireAuth, (req, res) => {
  const db = loadDB();
  const subscription_title =
    req.body.subscription_title === undefined ? undefined : normalizeText(req.body.subscription_title);
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
  const show_traffic_limit =
    req.body.show_traffic_limit === undefined ? undefined : (req.body.show_traffic_limit ? 1 : 0);
  const show_expiration =
    req.body.show_expiration === undefined ? undefined : (req.body.show_expiration ? 1 : 0);

  if (subscription_title !== undefined) db.settings.subscription_title = subscription_title;
  if (announcement !== undefined) db.settings.announcement = announcement;
  if (inbound_remarks !== undefined) db.settings.inbound_remarks = inbound_remarks as Record<string, string>;
  if (inbound_link_remarks !== undefined) db.settings.inbound_link_remarks = inbound_link_remarks as Record<string, string>;
  if (profile_update_interval !== undefined && !Number.isNaN(profile_update_interval)) {
    db.settings.profile_update_interval = Math.max(1, Math.floor(profile_update_interval));
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
  const decoded = Buffer.from(generateSubscription(profile), 'base64').toString('utf8');
  const links = decoded.split('\n').map(v => v.trim()).filter(v => v && !v.startsWith('#'));
  const userinfo = {
    upload: Math.max(0, Math.floor(profile.upload_bytes || 0)),
    download: Math.max(0, Math.floor(profile.download_bytes || 0)),
    total: Math.max(0, Math.floor((profile.limit_gb || 0) * 1024 * 1024 * 1024)),
    expire: profile.expires_at ? Math.floor(new Date(profile.expires_at).getTime() / 1000) : 0
  };
  res.json({
    profile_title: db.settings?.subscription_title || '',
    userinfo,
    links
  });
});

app.listen(API_PORT, API_HOST, () => {
  console.log(`API server running on ${API_HOST}:${API_PORT}`);
});
