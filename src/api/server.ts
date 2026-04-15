import express from 'express';
import { exec } from 'child_process';
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
  created_at: string;
  updated_at: string;
}

interface XrayInbound {
  tag: string;
  port: number;
  listen: string;
  protocol: string;
  settings: any;
  stream_settings?: any;
}

interface Database {
  profiles: Profile[];
  nextProfileId: number;
}

function loadDB(): Database {
  if (existsSync(DB_PATH)) {
    return JSON.parse(readFileSync(DB_PATH, 'utf8'));
  }
  return { profiles: [], nextProfileId: 1 };
}

function saveDB(db: Database) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

const app = express();
app.use(express.json());

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
    configPath: '/etc/xray/config.json',
    binPath: '/usr/local/bin/xray'
  };

  if (existsSync(info.binPath)) {
    try {
      info.installed = true;
      info.method = 'official';
      info.version = execSync('xray version', { encoding: 'utf8' }).trim().split('\n')[0];
    } catch {
      info.installed = true;
      info.method = 'manual';
    }
  } else if (existsSync('/usr/bin/xray')) {
    info.binPath = '/usr/bin/xray';
    info.installed = true;
    info.method = 'official';
    try {
      info.version = execSync('xray version', { encoding: 'utf8' }).trim().split('\n')[0];
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
      if (match) stats[match[1]] = parseInt(match[2], 10);
    }
  } catch {}
  return stats;
}

function buildXrayConfig() {
  const db = loadDB();
  const xrayInbounds = getXrayInbounds();
  
  const config = {
    log: { access: '/var/log/xray/access.log', error: '/var/log/xray/error.log', loglevel: 'warning' },
    api: { tag: 'api', services: ['HandlerService', 'LoggerService', 'StatsService'] },
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
        clients.push({ id: profile.uuid, flow: profile.flow || '' });
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

function generateSubscription(profile: Profile): string {
  const xrayInbounds = getXrayInbounds();
  const links: string[] = [];
  
  for (const ib of xrayInbounds) {
    if (!profile.inbound_tags?.includes(ib.tag)) continue;
    
    if (ib.protocol === 'vmess') {
      const vmess = {
        v: '2',
        ps: `${profile.username}-${ib.tag}`,
        add: '0.0.0.0',
        port: String(ib.port),
        id: profile.uuid,
        aid: 0,
        net: 'tcp'
      };
      const encoded = Buffer.from(JSON.stringify(vmess)).toString('base64');
      links.push(`vmess://${encoded}`);
    } else if (ib.protocol === 'vless') {
      links.push(`vless://${profile.uuid}@0.0.0.0:${ib.port}?flow=${profile.flow || ''}`);
    } else if (ib.protocol === 'trojan') {
      const pass = (ib.settings as any)?.clients?.[0]?.password || profile.uuid;
      links.push(`trojan://${pass}@0.0.0.0:${ib.port}`);
    } else if (ib.protocol === 'shadowsocks') {
      const ssSettings = (ib.settings as any)?.clients?.[0] || {};
      const ss = `${ssSettings.method || 'aes-256-gcm'}:${ssSettings.password || profile.uuid}@0.0.0.0:${ib.port}`;
      links.push(`ss://${Buffer.from(ss).toString('base64')}`);
    }
  }
  
  return Buffer.from(links.join('\n')).toString('base64');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', xray_running: isXrayRunning() });
});

app.get('/stats', (req, res) => {
  const stats = getXrayStats();
  const db = loadDB();
  
  const profileStats = db.profiles.map(p => {
    const uplink = stats[`user>>>${p.username}>>>uplink`] || 0;
    const downlink = stats[`user>>>${p.username}>>>downlink`] || 0;
    
    return { username: p.uuid, uuid: p.uuid, uplink, downlink };
  });
  
  res.json({ xray: stats, profiles: profileStats });
});

app.post('/reload', requireAuth, (req, res) => {
  try {
    const config = buildXrayConfig();
    mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
    writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
    restartXray();
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

// Profile CRUD - admin only
app.get('/api/profiles', requireAuth, (req, res) => {
  const db = loadDB();
  res.json(db.profiles);
});

app.get('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === Number(req.params.id));
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  res.json(profile);
});

app.post('/api/profiles', requireAuth, (req, res) => {
  const db = loadDB();
  const { username } = req.body;
  if (!username) return res.status(400).json({ detail: 'Username required' });
  
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
    created_at: now,
    updated_at: now
  };
  
  db.profiles.push(profile);
  saveDB(db);
  
  const config = buildXrayConfig();
  mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  restartXray();
  
  res.json(profile);
});

app.delete('/api/profiles/:id', requireAuth, (req, res) => {
  const db = loadDB();
  const idx = db.profiles.findIndex(p => p.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ detail: 'Profile not found' });
  
  db.profiles.splice(idx, 1);
  saveDB(db);
  
  const config = buildXrayConfig();
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  restartXray();
  
  res.json({ status: 'ok' });
});

// Inbound tags management
app.get('/api/inbounds', requireAuth, (req, res) => {
  res.json(getXrayInbounds());
});

app.get('/api/profiles/:id/inbounds', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === Number(req.params.id));
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  res.json(profile.inbound_tags || []);
});

app.post('/api/profiles/:id/inbounds', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === Number(req.params.id));
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  
  const { tag } = req.body;
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
    
    const config = buildXrayConfig();
    writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
    restartXray();
  }
  
  res.json(profile.inbound_tags);
});

app.delete('/api/profiles/:id/inbounds/:tag', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === Number(req.params.id));
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  
  if (!profile.inbound_tags) profile.inbound_tags = [];
  profile.inbound_tags = profile.inbound_tags.filter(t => t !== req.params.tag);
  profile.updated_at = new Date().toISOString();
  saveDB(db);
  
  const config = buildXrayConfig();
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  restartXray();
  
  res.json(profile.inbound_tags);
});

// Xray management endpoints
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

// Profile enable/disable
app.patch('/api/profiles/:id/toggle', requireAuth, (req, res) => {
  const db = loadDB();
  const profile = db.profiles.find(p => p.id === Number(req.params.id));
  if (!profile) return res.status(404).json({ detail: 'Profile not found' });
  
  profile.enable = profile.enable ? 0 : 1;
  profile.updated_at = new Date().toISOString();
  saveDB(db);
  
  const config = buildXrayConfig();
  mkdirSync(dirname(XRAY_CONFIG_PATH), { recursive: true });
  writeFileSync(XRAY_CONFIG_PATH, JSON.stringify(config, null, 2));
  restartXray();
  
  res.json({ status: 'ok', enable: profile.enable });
});

app.listen(API_PORT, API_HOST, () => {
  console.log(`API server running on ${API_HOST}:${API_PORT}`);
});