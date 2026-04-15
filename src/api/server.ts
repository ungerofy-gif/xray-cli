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
  limit_ip: number;
  total_gb: number;
  sub_uuid: string;
  inbound_tags: string[];
  server_address: string;
  server_description: string;
  created_at: string;
  updated_at: string;
}

interface Settings {
  subscription_title: string;
  server_description: string;
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
  stream_settings?: any;
}

function loadDB(): Database {
  if (existsSync(DB_PATH)) {
    const raw = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    return {
      profiles: (raw.profiles || []).map((p: any) => ({
        ...p,
        server_address: p.server_address || '',
        server_description: p.server_description || ''
      })),
      settings: {
        subscription_title: raw.settings?.subscription_title || '',
        server_description: raw.settings?.server_description || ''
      },
      nextProfileId: raw.nextProfileId || 1
    };
  }
  return {
    profiles: [],
    settings: { subscription_title: '', server_description: '' },
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
  if (!API_KEY) return next();
  
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

function saveConfigAndRestart(): void {
  const config = buildXrayConfig();
  mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  restartXray();
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
      settings: ib.settings || {},
      allocate: { strategy: 'always' }
    };
    
    if (ib.stream_settings) {
      inbound.stream_settings = ib.stream_settings;
    }
    
    const clients: any[] = [];
    
    for (const profile of db.profiles.filter(p => p.enable && p.inbound_tags?.includes(ib.tag))) {
      if (ib.protocol === 'vmess' || ib.protocol === 'vless') {
        clients.push({ id: profile.uuid, flow: 'xtls-rprx-vision' });
      } else if (ib.protocol === 'trojan') {
        const pass = (ib.settings as any)?.clients?.[0]?.password || profile.uuid;
        clients.push({ password: pass });
      } else if (ib.protocol === 'shadowsocks') {
        const ssSettings = (ib.settings as any)?.clients?.[0] || {};
        clients.push({ method: ssSettings.method || 'aes-256-gcm', password: ssSettings.password || profile.uuid });
      }
    }
    
    if (clients.length > 0) {
      if (inbound.settings?.clients) {
        inbound.settings.clients = [...(inbound.settings.clients || []), ...clients];
      } else {
        inbound.settings = { ...inbound.settings, clients };
      }
    }
    
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
  const globalTitle = db.settings?.subscription_title || '';
  const globalServerDescription = db.settings?.server_description || '';
  const xrayInbounds = getXrayInbounds();
  const fallbackAddress = getServerAddress();
  const serverAddress = profile.server_address || fallbackAddress;
  const links: string[] = [];
  
  for (const ib of xrayInbounds) {
    if (!profile.inbound_tags?.includes(ib.tag)) continue;
    
    const streamSettings = ib.stream_settings as any || {};
    const settings = ib.settings as any || {};
    
    const params = new URLSearchParams();
    const titlePrefix = globalTitle ? `${globalTitle} - ` : '';
    const title = `${titlePrefix}${profile.username}-${ib.tag}`;
    let serverDescription = '';
    
    if (ib.protocol === 'vmess') {
      const vmess: any = {
        v: '2',
        ps: title,
        add: serverAddress,
        port: ib.port,
        id: profile.uuid,
        aid: 0,
        net: streamSettings.network || 'tcp',
        tls: streamSettings.security || ''
      };
      
      if (streamSettings.tlsSettings) {
        if (streamSettings.tlsSettings.sni) vmess.sni = streamSettings.tlsSettings.sni;
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
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn);
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
      
      const effectiveDesc = profile.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`vless://${profile.uuid}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'trojan') {
      const password = settings.clients?.[0]?.password || profile.uuid;
      
      if (streamSettings.security) params.set('security', streamSettings.security);
      if (streamSettings.network) params.set('type', streamSettings.network);
      if (streamSettings.tlsSettings?.sni) params.set('sni', streamSettings.tlsSettings.sni);
      if (streamSettings.tlsSettings?.fingerprint) params.set('fp', streamSettings.tlsSettings.fingerprint);
      if (streamSettings.tlsSettings?.alpn) params.set('alpn', streamSettings.tlsSettings.alpn);
      
      if (streamSettings.wsSettings) {
        if (streamSettings.wsSettings.path) params.set('path', streamSettings.wsSettings.path);
        if (streamSettings.wsSettings.headers?.Host) params.set('host', streamSettings.wsSettings.headers.Host);
      }
      
      if (streamSettings.grpcSettings?.serviceName) {
        params.set('serviceName', streamSettings.grpcSettings.serviceName);
      }
      
      const effectiveDesc = profile.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`trojan://${password}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = settings.clients?.[0] || {};
      const method = ssSettings.method || 'aes-256-gcm';
      const password = ssSettings.password || profile.uuid;
      
      const ssPart = `${method}:${password}`;
      const ssEncoded = Buffer.from(ssPart).toString('base64').replace(/=+$/, '');
      
      const effectiveDesc = profile.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`ss://${ssEncoded}@${serverAddress}:${ib.port}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'hysteria2') {
      const auth = profile.uuid;
      
      if (streamSettings.sni) params.set('sni', streamSettings.sni);
      if (streamSettings.fingerprint) params.set('fp', streamSettings.fingerprint);
      if (streamSettings.alpn) params.set('alpn', streamSettings.alpn);
      if (settings.obfs) params.set('obfs', settings.obfs);
      if (settings.obfsPassword) params.set('obfs-password', settings.obfsPassword);
      if (settings.upMbps) params.set('up', String(settings.upMbps));
      if (settings.downMbps) params.set('down', String(settings.downMbps));
      
      const effectiveDesc = profile.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`hysteria2://${auth}@${serverAddress}:${ib.port}?${params.toString()}#${remark}${descParam}`);
      
    } else if (ib.protocol === 'wireguard') {
      const wgSettings = settings || {};
      const privateKey = wgSettings.privateKey || '';
      const peer = wgSettings.peers?.[0] || {};
      const publicKey = peer.publicKey || '';
      const allowedIPs = peer.allowedIPs?.join(',') || '0.0.0.0/0';
      const endpoint = peer.endpoint || `${serverAddress}:${ib.port}`;
      
      const effectiveDesc = profile.server_description || globalServerDescription;
      serverDescription = effectiveDesc ? Buffer.from(effectiveDesc).toString('base64') : '';
      const remark = encodeURIComponent(title);
      const descParam = serverDescription ? `?serverDescription=${serverDescription}` : '';
      links.push(`wireguard://${privateKey}@${serverAddress}:${ib.port}?publicKey=${publicKey}&allowedIPs=${encodeURIComponent(allowedIPs)}&endpoint=${encodeURIComponent(endpoint)}#${remark}${descParam}`);
    }
  }
  
  return Buffer.from(links.join('\n')).toString('base64');
}

app.get('/health', requireAuth, (req, res) => {
  res.json({ status: 'ok', xray_running: isXrayRunning() });
});

app.get('/stats', requireAuth, (req, res) => {
  const stats = getXrayStats();
  const db = loadDB();
  
  const profileStats = db.profiles.map(p => {
    const uplink = stats[`user>>>${p.username}>>>uplink`] || 0;
    const downlink = stats[`user>>>${p.username}>>>downlink`] || 0;
    
    return { username: p.username, uuid: p.uuid, uplink, downlink };
  });
  
  res.json({ xray: stats, profiles: profileStats });
});

app.post('/reload', requireAuth, (req, res) => {
  try {
    saveConfigAndRestart();
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
  
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
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
  const server_description = normalizeText(req.body.server_description);
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
    flow: '',
    limit_ip: 0,
    total_gb: 0,
    sub_uuid: generateUniqueToken(db),
    inbound_tags: [],
    server_address: server_address || '',
    server_description: server_description || '',
    created_at: now,
    updated_at: now
  };
  
  db.profiles.push(profile);
  saveDB(db);
  saveConfigAndRestart();
  
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
  saveConfigAndRestart();
  
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
    saveConfigAndRestart();
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
  saveConfigAndRestart();
  
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
  saveConfigAndRestart();
  
  res.json({ status: 'ok', enable: profile.enable });
});

app.patch('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });

  const username = req.body.username === undefined ? undefined : normalizeText(req.body.username);
  const server_address = req.body.server_address === undefined ? undefined : normalizeText(req.body.server_address);
  const server_description = req.body.server_description === undefined ? undefined : normalizeText(req.body.server_description);
  const flow = req.body.flow === undefined ? undefined : normalizeText(req.body.flow);

  if (username !== undefined) {
    if (!username) return res.status(400).json({ detail: 'Username cannot be empty' });
    if (db.profiles.some(p => p.id !== profile.id && p.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ detail: 'Username already exists' });
    }
    profile.username = username;
  }
  if (server_address !== undefined) profile.server_address = server_address;
  if (server_description !== undefined) profile.server_description = server_description;
  if (flow !== undefined) profile.flow = flow;
  if (req.body.enable !== undefined) profile.enable = req.body.enable ? 1 : 0;

  profile.updated_at = new Date().toISOString();
  saveDB(db);
  saveConfigAndRestart();
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

  if (subscription_title !== undefined) db.settings.subscription_title = subscription_title;
  if (server_description !== undefined) db.settings.server_description = server_description;
  saveDB(db);
  res.json(db.settings);
});

app.get('/api/profiles/:id/subscription', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = getProfileById(db, req.params.id);
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(generateSubscription(profile));
});

app.listen(API_PORT, API_HOST, () => {
  console.log(`API server running on ${API_HOST}:${API_PORT}`);
});
