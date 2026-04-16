#!/usr/bin/env bun

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
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

function normalizeInboundSettings(settings: any): any {
  const next = { ...(settings || {}) };
  if ('clients' in next) delete next.clients;
  return next;
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
      profiles: (raw.profiles || []).map((p: any) => ({
        ...p,
        flow: p.flow || 'xtls-rprx-vision',
        limit_gb: Number(p.limit_gb ?? p.total_gb ?? 0) || 0,
        upload_bytes: Number(p.upload_bytes ?? 0) || 0,
        download_bytes: Number(p.download_bytes ?? 0) || 0,
        expire_days: Number(p.expire_days ?? 0) || 0,
        expires_at: p.expires_at || '',
        server_address: p.server_address || '',
        remark: p.remark || p.username || '',
        inbound_remarks: p.inbound_remarks || {},
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

const XRAY_CONFIG_PATH = process.env.XRAY_CONFIG_PATH || '/usr/local/etc/xray/config.json';

function ask(question: string): string {
  const ans = prompt(question);
  return ans || '';
}

function clear() {
  console.clear();
}

const PANEL_WIDTH = 76;

function fitText(value: string, width: number): string {
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width <= 3) return chars.slice(0, width).join('');
  return chars.slice(0, width - 3).join('') + '...';
}

function centerLine(text: string): string {
  const columns = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((columns - Array.from(text).length) / 2));
  return ' '.repeat(pad) + text;
}

function renderPanel(title: string, lines: string[] = []) {
  const inner = PANEL_WIDTH - 4;
  const top = `+${'-'.repeat(PANEL_WIDTH - 2)}+`;
  const fullTitle = title === 'XRAY CLI' ? title : `XRAY CLI | ${title}`;

  console.log('');
  console.log(centerLine(top));
  console.log(centerLine(`| ${fitText(fullTitle, inner).padEnd(inner, ' ')} |`));
  console.log(centerLine(top));
  for (const line of lines) {
    console.log(centerLine(`| ${fitText(line, inner).padEnd(inner, ' ')} |`));
  }
  console.log(centerLine(top));
  console.log('');
}

function promptCentered(question: string): string {
  return prompt(centerLine(question)) || '';
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
  serverAddress?: string,
  remark?: string,
  serverDescription?: string,
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
    inbound_tags: [],
    inbound_remarks: {},
    server_address: serverAddress || '',
    remark: remark || username,
    server_description: serverDescription || '',
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

function setProfileInboundRemark(profileId: number, tag: string, remark: string) {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === profileId);
  if (!profile) return;
  if (!profile.inbound_remarks) profile.inbound_remarks = {};
  if (!tag) return;
  if (remark.trim()) profile.inbound_remarks[tag] = remark.trim();
  else delete profile.inbound_remarks[tag];
  profile.updated_at = new Date().toISOString();
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
    server_description: '',
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
  serverDescription?: string,
  limitGb?: number,
  expireDays?: number
) {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === id);
  if (!profile) return;
  
  if (serverAddress !== undefined) profile.server_address = serverAddress;
  if (remark !== undefined) profile.remark = remark;
  if (serverDescription !== undefined) profile.server_description = serverDescription;
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
        clients.push({ id: profile.uuid, email: profile.username, flow: profile.flow || 'xtls-rprx-vision' });
      } else if (ib.protocol === 'trojan') {
        const pass = (ib.settings as any)?.clients?.[0]?.password || profile.uuid;
        clients.push({ password: pass, email: profile.username });
      } else if (ib.protocol === 'shadowsocks') {
        const ssSettings = (ib.settings as any)?.clients?.[0] || {};
        clients.push({ method: ssSettings.method || 'aes-256-gcm', password: ssSettings.password || profile.uuid, email: profile.username });
      } else if (ib.protocol === 'hysteria2') {
        clients.push({ password: profile.uuid, email: profile.username });
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

function reloadXray() {
  try {
    const config = buildXrayConfig();
    mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
    writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
    execSync('systemctl restart xray');
    console.log('✓ xray reloaded');
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
    const inboundRemark = p.inbound_remarks?.[ib.tag];
    const title = `${titlePrefix}${inboundRemark || ib.tag}`;
    const remark = encodeURIComponent(title);
    const effectiveDesc = p.server_description || settings.server_description || '';
    const serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
    const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
    
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
      if (streamSettings.wsSettings?.path) vmess.path = streamSettings.wsSettings.path;
      if (streamSettings.wsSettings?.headers?.Host) vmess.host = streamSettings.wsSettings.headers.Host;
      if (streamSettings.grpcSettings?.serviceName) vmess.path = streamSettings.grpcSettings.serviceName;
      const encoded = Buffer.from(JSON.stringify(vmess)).toString('base64');
      links.push(`vmess://${encoded}`);
    } else if (ib.protocol === 'vless') {
      const params = new URLSearchParams();
      if (streamSettings.security) params.set('security', streamSettings.security);
      if (streamSettings.network) params.set('type', streamSettings.network);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      if (streamSettings.realitySettings?.publicKey) params.set('pbk', streamSettings.realitySettings.publicKey);
      if (streamSettings.realitySettings?.shortId) params.set('sid', streamSettings.realitySettings.shortId);
      if (streamSettings.realitySettings?.spiderX) params.set('spx', streamSettings.realitySettings.spiderX);
      if (streamSettings.wsSettings?.path) params.set('path', streamSettings.wsSettings.path);
      if (streamSettings.wsSettings?.headers?.Host) params.set('host', streamSettings.wsSettings.headers.Host);
      if (streamSettings.grpcSettings?.serviceName) params.set('serviceName', streamSettings.grpcSettings.serviceName);
      if (streamSettings.grpcSettings?.mode) params.set('mode', streamSettings.grpcSettings.mode);
      params.set('flow', profile.flow || 'xtls-rprx-vision');
      params.set('encryption', 'none');
      links.push(`vless://${p.uuid}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
    } else if (ib.protocol === 'trojan') {
      const params = new URLSearchParams();
      const pass = inboundSettings?.clients?.[0]?.password || p.uuid;
      if (streamSettings.security) params.set('security', streamSettings.security);
      if (streamSettings.network) params.set('type', streamSettings.network);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      if (streamSettings.wsSettings?.path) params.set('path', streamSettings.wsSettings.path);
      if (streamSettings.wsSettings?.headers?.Host) params.set('host', streamSettings.wsSettings.headers.Host);
      if (streamSettings.grpcSettings?.serviceName) params.set('serviceName', streamSettings.grpcSettings.serviceName);
      links.push(`trojan://${pass}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = inboundSettings?.clients?.[0] || {};
      const ss = `${ssSettings.method || 'aes-256-gcm'}:${ssSettings.password || p.uuid}@${serverAddress}:${ib.port}`;
      links.push(`ss://${Buffer.from(ss).toString('base64')}#${remark}${descParam}`);
    } else if (ib.protocol === 'hysteria2' || ib.protocol === 'hysteria') {
      const params = new URLSearchParams();
      const auth = p.uuid;
      if (streamSettings.sni) params.set('sni', streamSettings.sni);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.serverName) params.set('sni', streamSettings.tlsSettings.serverName);
      if (streamSettings.fingerprint) params.set('fp', streamSettings.fingerprint);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (Array.isArray(streamSettings.alpn)) params.set('alpn', streamSettings.alpn.join(','));
      else if (typeof streamSettings.alpn === 'string') params.set('alpn', streamSettings.alpn);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn.join(','));
      if (inboundSettings.obfs) params.set('obfs', inboundSettings.obfs);
      if (inboundSettings.obfsPassword) params.set('obfs-password', inboundSettings.obfsPassword);
      if (inboundSettings.upMbps) params.set('upmbps', String(inboundSettings.upMbps));
      if (inboundSettings.downMbps) params.set('downmbps', String(inboundSettings.downMbps));
      links.push(`hy2://${auth}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
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

  const lines = [
    `Status: ${xrayStatus === 'active' ? 'RUNNING' : 'STOPPED'}`,
    `Users: ${profiles.length}`,
    `Inbounds: ${xrayInbounds.length}`,
    '',
    'Users',
    '-'.repeat(28),
  ];

  for (const p of profiles) {
    const status = p.enable ? '[ON]' : '[OFF]';
    const tagCount = p.inbound_tags?.length || 0;
    const expTs = p.expires_at ? Math.floor(new Date(p.expires_at).getTime() / 1000) : 0;
    lines.push(`${status} ${fitText(p.username, 15).padEnd(15, ' ')} ${(p.sub_uuid || '').slice(0, 10)}  ${tagCount} inb  ${p.limit_gb}GB exp:${expTs ? new Date(expTs * 1000).toISOString().slice(0, 10) : 'none'}`);
  }
  if (profiles.length === 0) lines.push('No users yet');

  renderPanel('Dashboard', lines);
  promptCentered('Press Enter to continue...');
}

async function listProfiles() {
  const profiles = getProfiles();

  const lines = ['ID   USERNAME         TOKEN       EN  LIMIT  EXP(D)', '-'.repeat(58)];
  if (profiles.length === 0) {
    lines.push('No profiles found.');
  } else {
    for (const p of profiles) {
      lines.push(`${String(p.id).padEnd(4, ' ')} ${fitText(p.username, 15).padEnd(15, ' ')} ${(p.sub_uuid || '').slice(0, 10).padEnd(11, ' ')} ${p.enable ? 'Y ' : 'N '} ${String(p.limit_gb).padStart(5, ' ')}G ${String(p.expire_days || 0).padStart(6, ' ')}`);
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
    const currentTags = profile.inbound_tags || [];
    const lines = ['Available inbounds', '-'.repeat(20)];

    for (const ib of xrayInbounds) {
      const selected = currentTags.includes(ib.tag) ? '[x]' : '[ ]';
      const inboundRemark = profile.inbound_remarks?.[ib.tag] || '-';
      lines.push(`${selected} ${fitText(ib.tag, 12).padEnd(12, ' ')} (${ib.protocol}:${ib.port}) ${fitText(inboundRemark, 20)}`);
    }
    lines.push('');
    lines.push(`Current tags: ${currentTags.length > 0 ? currentTags.join(', ') : 'none'}`);
    lines.push('');
    lines.push('1. Add inbound by tag');
    lines.push('2. Remove inbound by tag');
    lines.push('3. Set inbound remark');
    lines.push('0. Back');
    renderPanel(`Inbounds | ${profile.username}`, lines);
    
    const choice = promptCentered('Select: ');
    
    if (choice === '1') {
      const tag = promptCentered('Inbound tag to add: ');
      if (!tag) continue;
      
      const exists = xrayInbounds.find(ib => ib.tag === tag);
      if (!exists) {
        console.log(centerLine('Tag not found in Xray config'));
        promptCentered('Press Enter to continue...');
        continue;
      }
      
      if (!currentTags.includes(tag)) {
        setProfileInboundTags(profileId, [...currentTags, tag]);
        console.log('✓ Inbound added');
        reloadXray();
      } else {
        console.log('Tag already added');
      }
    } else if (choice === '2') {
      const tag = promptCentered('Inbound tag to remove: ');
      if (!tag) continue;
      
      if (currentTags.includes(tag)) {
        setProfileInboundTags(profileId, currentTags.filter(t => t !== tag));
        console.log('✓ Inbound removed');
        reloadXray();
      } else {
        console.log('Tag not in profile');
      }
    } else if (choice === '3') {
      const tag = promptCentered('Inbound tag: ');
      if (!tag) continue;
      if (!xrayInbounds.find(ib => ib.tag === tag)) {
        console.log('Tag not found in Xray config');
      } else {
        const current = profile.inbound_remarks?.[tag] || '';
        const inboundRemark = promptCentered(`Remark for ${tag} (${current || 'empty'}): `);
        setProfileInboundRemark(profileId, tag, inboundRemark);
        console.log('✓ Inbound remark updated');
      }
    } else {
      break;
    }
  }
}

async function subscriptionUrl(profileId: number) {
  const profile = getProfile(profileId);
  if (!profile) return;
  
  const sub = generateSubscription(profile);
  
  clear();
  renderPanel(`Subscription | ${profile.username}`, [
    'Base64',
    '-'.repeat(10),
    sub,
    '',
    'Decoded',
    '-'.repeat(10),
    Buffer.from(sub, 'base64').toString()
  ]);
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
        '2. Delete Profile',
        '3. Toggle Enable',
        '4. Manage Inbounds',
        '5. View Subscription',
        '0. Back'
      ]);
      
      const sub = promptCentered('Select: ') || '';
      
      if (sub === '1') {
        const username = promptCentered('Username: ');
        if (username) {
          const serverAddr = promptCentered('Server address (empty = auto): ');
          const remark = promptCentered('Remark (display name): ');
          const serverDesc = promptCentered('Server description (empty = none): ');
          const limitGb = Number(promptCentered('Traffic limit GB (0 = no limit): ') || '0');
          const expireDays = Number(promptCentered('Expiration period in days (0 = none): ') || '0');
          const profile = createProfile(
            username,
            serverAddr || undefined,
            remark || undefined,
            serverDesc || undefined,
            limitGb || 0,
            expireDays || 0
          );
          console.log(`✓ Profile created: ${profile.username}`);
          
          const add = promptCentered('Add inbound? (y/n): ');
          if (add.toLowerCase() === 'y') {
            await manageInbounds(profile.id);
          }
        }
      } else if (sub === '2') {
        const id = promptCentered('Profile ID to delete: ');
        if (deleteProfile(parseInt(id))) {
          console.log('✓ Profile deleted');
          reloadXray();
        }
      } else if (sub === '3') {
        const id = promptCentered('Profile ID to toggle: ');
        const profile = getProfile(parseInt(id));
        if (profile) {
          profile.enable = profile.enable ? 0 : 1;
          updateProfile(parseInt(id), { enable: profile.enable });
          console.log(`✓ Profile ${profile.enable ? 'enabled' : 'disabled'}`);
          reloadXray();
        }
      } else if (sub === '4') {
        const id = promptCentered('Profile ID: ');
        await manageInbounds(parseInt(id));
      } else if (sub === '5') {
        const id = promptCentered('Profile ID: ');
        await subscriptionUrl(parseInt(id));
      }
    } else if (choice === '3') {
      await xrayManagement();
    } else if (choice === '4') {
      while (true) {
        clear();
        const settings = getSettings();
        renderPanel('Settings', [
          `API Port: 2053`,
          `Config: ${XRAY_CONFIG_PATH}`,
          `Database: ${DB_PATH}`,
          `Subscription Title: ${settings.subscription_title || '(default)'}`,
          `Server Description: ${settings.server_description || '(none)'}`,
          `Auto Update Interval (h): ${settings.profile_update_interval || 2}`,
          `Show Traffic Limit: ${settings.show_traffic_limit ? 'ON' : 'OFF'}`,
          `Show Expiration: ${settings.show_expiration ? 'ON' : 'OFF'}`,
          '',
          '1. Set Subscription Title',
          '2. Set Server Description (global)',
          '3. Set Auto Update Interval (hours)',
          '4. Toggle Show Traffic Limit',
          '5. Toggle Show Expiration',
          '6. Edit Profile',
          '0. Back'
        ]);

        const s = promptCentered('Select: ');
        if (s === '1') {
          const title = promptCentered('Subscription title: ');
          updateSettings({ subscription_title: title });
          console.log('✓ Title updated');
        } else if (s === '2') {
          const desc = promptCentered('Server description: ');
          updateSettings({ server_description: desc });
          console.log('✓ Description updated');
        } else if (s === '3') {
          const hours = Number(promptCentered(`Auto update interval hours (${settings.profile_update_interval || 2}): `) || '2');
          updateSettings({ profile_update_interval: Math.max(1, Math.floor(hours || 2)) });
          console.log('✓ Update interval saved');
        } else if (s === '4') {
          updateSettings({ show_traffic_limit: settings.show_traffic_limit ? 0 : 1 });
          console.log('✓ Traffic-limit display updated');
        } else if (s === '5') {
          updateSettings({ show_expiration: settings.show_expiration ? 0 : 1 });
          console.log('✓ Expiration display updated');
        } else if (s === '6') {
          const id = promptCentered('Profile ID: ');
          const profile = getProfile(parseInt(id));
          if (profile) {
            const newAddr = promptCentered(`Server address (${profile.server_address || 'auto'}): `);
            const newRemark = promptCentered(`Remark (${profile.remark || profile.username}): `);
            const newServerDesc = promptCentered(`Server description (${profile.server_description || 'none'}): `);
            const newLimitGb = promptCentered(`Traffic limit GB (${profile.limit_gb || 0}): `);
            const newExpireDays = promptCentered(`Expiration days (${profile.expire_days || 0}): `);
            if (newAddr !== '' || newRemark !== '' || newServerDesc !== '' || newLimitGb !== '' || newExpireDays !== '') {
              updateProfileSettings(
                parseInt(id),
                newAddr || profile.server_address,
                newRemark || profile.remark,
                newServerDesc || profile.server_description,
                newLimitGb === '' ? profile.limit_gb : Number(newLimitGb),
                newExpireDays === '' ? profile.expire_days : Number(newExpireDays)
              );
              console.log('✓ Profile updated');
            }
          } else {
            console.log('✗ Profile not found');
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
