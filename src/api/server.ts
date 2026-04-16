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
  inbound_remarks: Record<string, string>;
  server_address: string;
  remark: string;
  server_description: string;
  created_at: string;
  updated_at: string;
}

interface Settings {
  subscription_title: string;
  server_description: string;
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
  wsSettings?: any;
  grpcSettings?: any;
  httpSettings?: any;
  realitySettings?: any;
  sni?: string;
  fingerprint?: string;
  alpn?: string | string[];
}

function getInboundStreamSettings(ib: XrayInbound): XrayStreamSettings {
  const streamSettings = (ib.stream_settings || ib.streamSettings || {}) as XrayStreamSettings;
  if (!streamSettings.tlsSettings && ib.tlsSettings) streamSettings.tlsSettings = ib.tlsSettings;
  if (!streamSettings.tcpSettings && ib.tcpSettings) streamSettings.tcpSettings = ib.tcpSettings;
  return streamSettings;
}

function loadDB(): Database {
  if (existsSync(DB_PATH)) {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    return {
      profiles: (raw.profiles || []).map((p: any) => ({
        ...p,
        flow: p.flow || 'xtls-rprx-vision',
        limit_gb: Number(p.limit_gb ?? p.total_gb ?? 0) || 0,
        upload_bytes: Number(p.upload_bytes ?? 0) || 0,
        download_bytes: Number(p.download_bytes ?? 0) || 0,
        expire_days: Number(p.expire_days ?? 0) || 0,
        expires_at: p.expires_at || '',
        inbound_remarks: p.inbound_remarks || {},
        server_address: p.server_address || '',
        remark: p.remark || p.username || '',
        server_description: p.server_description || ''
      })),
      settings: {
        subscription_title: raw.settings?.subscription_title || '',
        server_description: raw.settings?.server_description || '',
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
      server_description: '',
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
    return (config.inbounds || []).filter((ib: any) => ib.tag !== 'api');
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
  
  const config = {
    log: { access: '/var/log/xray/access.log', error: '/var/log/xray/error.log', loglevel: 'warning' },
    api: { tag: 'api', services: ['LoggerService', 'StatsService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [] as any[],
    outbounds: [
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
    
    if (ib.stream_settings || ib.streamSettings) {
      inbound.stream_settings = ib.stream_settings || ib.streamSettings;
    }
    
    const clients: any[] = [];
    
    for (const profile of db.profiles.filter(p => p.enable && p.inbound_tags?.includes(ib.tag))) {
      if (ib.protocol === 'vmess' || ib.protocol === 'vless') {
        clients.push({ id: profile.uuid, email: profile.username, flow: 'xtls-rprx-vision' });
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
  const stats = getXrayStats();
  if (syncProfileUsageFromStats(db, stats)) saveDB(db);
  const settingsRoot = db.settings;
  const p = db.profiles.find(v => v.id === profile.id) || profile;
  const globalTitle = settingsRoot.subscription_title || '';
  const globalServerDescription = settingsRoot.server_description || '';
  const xrayInbounds = getXrayInbounds();
  const fallbackAddress = getServerAddress();
  const serverAddress = p.server_address || fallbackAddress;
  const links: string[] = [];
  const meta: string[] = [];
  meta.push('#subscription-auto-update-enable: 1');
  meta.push(`#profile-update-interval: ${Math.max(1, settingsRoot.profile_update_interval || 2)}`);
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
    const inboundRemark = p.inbound_remarks?.[ib.tag];
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
      
      if (streamSettings.wsSettings) {
        if (streamSettings.wsSettings.path) vmess.path = streamSettings.wsSettings.path;
        if (streamSettings.wsSettings.headers?.Host) vmess.host = streamSettings.wsSettings.headers.Host;
      }
      
      if (streamSettings.grpcSettings?.serviceName) {
        vmess.path = streamSettings.grpcSettings.serviceName;
      }
      
      const encoded = Buffer.from(JSON.stringify(vmess)).toString('base64').replace(/=+$/, '');
      links.push(`vmess://${encoded}`);
      
    } else if (ib.protocol === 'vless') {
      if (streamSettings.security) params.set('security', streamSettings.security);
      if (streamSettings.network) params.set('type', streamSettings.network);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      if (streamSettings.realitySettings?.publicKey) params.set('pbk', streamSettings.realitySettings.publicKey);
      if (streamSettings.realitySettings?.shortId) params.set('sid', streamSettings.realitySettings.shortId);
      if (streamSettings.realitySettings?.spiderX) params.set('spx', streamSettings.realitySettings.spiderX);
      
      if (streamSettings.wsSettings) {
        if (streamSettings.wsSettings.path) params.set('path', streamSettings.wsSettings.path);
        if (streamSettings.wsSettings.headers?.Host) params.set('host', streamSettings.wsSettings.headers.Host);
      }
      
      if (streamSettings.httpSettings?.path) params.set('path', streamSettings.httpSettings.path);
      if (streamSettings.httpSettings?.host) params.set('host', streamSettings.httpSettings.host);
      
      if (streamSettings.grpcSettings?.serviceName) params.set('serviceName', streamSettings.grpcSettings.serviceName);
      if (streamSettings.grpcSettings?.mode) params.set('mode', streamSettings.grpcSettings.mode);
      
      params.set('flow', 'xtls-rprx-vision');
      params.set('encryption', 'none');
      
      const effectiveDesc = p.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`vless://${p.uuid}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'trojan') {
      const password = settings.clients?.[0]?.password || p.uuid;
      
      if (streamSettings.security) params.set('security', streamSettings.security);
      if (streamSettings.network) params.set('type', streamSettings.network);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      
      if (streamSettings.wsSettings) {
        if (streamSettings.wsSettings.path) params.set('path', streamSettings.wsSettings.path);
        if (streamSettings.wsSettings.headers?.Host) params.set('host', streamSettings.wsSettings.headers.Host);
      }
      
      if (streamSettings.grpcSettings?.serviceName) {
        params.set('serviceName', streamSettings.grpcSettings.serviceName);
      }
      
      const effectiveDesc = p.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`trojan://${password}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = settings.clients?.[0] || {};
      const method = ssSettings.method || 'aes-256-gcm';
      const password = ssSettings.password || p.uuid;
      
      const ssPart = `${method}:${password}`;
      const ssEncoded = Buffer.from(ssPart).toString('base64').replace(/=+$/, '');
      
      const effectiveDesc = p.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`ss://${ssEncoded}@${serverAddress}:${ib.port}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'hysteria2' || ib.protocol === 'hysteria') {
      const auth = p.uuid;
      
      if (streamSettings.sni) params.set('sni', streamSettings.sni);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      if (streamSettings.fingerprint) params.set('fp', streamSettings.fingerprint);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (Array.isArray(streamSettings.alpn)) params.set('alpn', streamSettings.alpn.join(','));
      else if (typeof streamSettings.alpn === 'string') params.set('alpn', streamSettings.alpn);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      if (settings.obfs) params.set('obfs', settings.obfs);
      if (settings.obfsPassword) params.set('obfs-password', settings.obfsPassword);
      if (settings.upMbps) params.set('upmbps', String(settings.upMbps));
      if (settings.downMbps) params.set('downmbps', String(settings.downMbps));
      
      const effectiveDesc = p.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`hy2://${auth}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'wireguard') {
      const wgSettings = settings || {};
      const privateKey = wgSettings.privateKey || '';
      const peer = wgSettings.peers?.[0] || {};
      const publicKey = peer.publicKey || '';
      const allowedIPs = peer.allowedIPs?.join(',') || '0.0.0.0/0';
      const endpoint = peer.endpoint || `${serverAddress}:${ib.port}`;
      
      const effectiveDesc = p.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`wireguard://${privateKey}@${serverAddress}:${ib.port}?publicKey=${publicKey}&allowedIPs=${encodeURIComponent(allowedIPs)}&endpoint=${encodeURIComponent(endpoint)}#${remark}${descParam}`);
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
  const server_description = normalizeText(req.body.server_description);
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
    inbound_tags: [],
    inbound_remarks: {},
    server_address: server_address || '',
    remark: remark || username,
    server_description: server_description || '',
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
  
  const tag = normalizeText(req.body.tag);
  if (!tag) return res.status(400).json({ detail: 'tag required' });
  
  const xrayInbounds = getXrayInbounds();
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
  const server_description = req.body.server_description === undefined ? undefined : normalizeText(req.body.server_description);
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
  if (server_description !== undefined) profile.server_description = server_description;
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
  const server_description =
    req.body.server_description === undefined ? undefined : normalizeText(req.body.server_description);
  const profile_update_interval =
    req.body.profile_update_interval === undefined ? undefined : Number(req.body.profile_update_interval);
  const show_traffic_limit =
    req.body.show_traffic_limit === undefined ? undefined : (req.body.show_traffic_limit ? 1 : 0);
  const show_expiration =
    req.body.show_expiration === undefined ? undefined : (req.body.show_expiration ? 1 : 0);

  if (subscription_title !== undefined) db.settings.subscription_title = subscription_title;
  if (server_description !== undefined) db.settings.server_description = server_description;
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
