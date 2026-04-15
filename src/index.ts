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

function header(title: string) {
  console.log('\n' + '='.repeat(50));
  console.log('  ' + title);
  console.log('='.repeat(50) + '\n');
}

function getProfiles() {
  const db = loadDB();
  return db.profiles.sort((a, b) => b.id - a.id);
}

function getProfile(id: number) {
  const db = loadDB();
  return db.profiles.find(p => p.id === id);
}

function createProfile(username: string) {
  const db = loadDB();
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
  } else {
    try {
      execSync('which docker', { stdio: 'ignore' });
      const dockerCheck = execSync('docker ps --format "{{.Names}}" 2>/dev/null | grep -q xray', { encoding: 'utf8' });
      if (dockerCheck === '' || dockerCheck !== '') {
        info.installed = true;
        info.method = 'docker';
        info.configPath = '/var/lib/docker/volumes/xray-config/_data/config.json';
        info.binPath = 'docker';
      }
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

async function dashboard() {
  clear();
  header('Dashboard');
  
  let xrayStatus = 'Unknown';
  try {
    xrayStatus = execSync('systemctl is-active xray', { encoding: 'utf8' }).trim();
  } catch {}
  
  const db = loadDB();
  const profiles = db.profiles;
  const xrayInbounds = getXrayInbounds();
  
  console.log(`  xray Status: ${xrayStatus === 'active' ? '✓ Running' : '✗ Stopped'}`);
  console.log(`  Total Users: ${profiles.length}`);
  console.log(`  Available Inbounds: ${xrayInbounds.length}\n`);
  
  console.log('  Users:');
  console.log('  ' + '-'.repeat(40));
  
  for (const p of profiles) {
    const status = p.enable ? '✓' : '✗';
    const tagCount = p.inbound_tags?.length || 0;
    console.log(`  ${status} ${p.username.padEnd(15)} ${(p.sub_uuid || '').slice(0, 10)}  ${tagCount} inbound(s)`);
  }
  
  console.log('\n');
  prompt('Press Enter to continue...');
}

async function listProfiles() {
  const profiles = getProfiles();
  
  header('Profiles');
  
  if (profiles.length === 0) {
    console.log('  No profiles found.\n');
  } else {
    console.log('  ID    Username       Token       Enabled');
    console.log('  ' + '-'.repeat(45));
    
    for (const p of profiles) {
      console.log(`  ${String(p.id).padEnd(5)} ${p.username.padEnd(15)} ${(p.sub_uuid || '').slice(0, 10).padEnd(11)} ${p.enable ? 'Yes' : 'No'}`);
    }
  }
  console.log('');
}

async function manageInbounds(profileId: number) {
  const profile = getProfile(profileId);
  if (!profile) return;
  
  while (true) {
    clear();
    header(`Inbounds: ${profile.username}`);
    
    const xrayInbounds = getXrayInbounds();
    const currentTags = profile.inbound_tags || [];
    
    console.log('  Available inbounds (select by tag):');
    for (const ib of xrayInbounds) {
      const selected = currentTags.includes(ib.tag) ? '✓' : ' ';
      console.log(`  [${selected}] ${ib.tag} (${ib.protocol}:${ib.port})`);
    }
    console.log('');
    console.log('  Current tags:', currentTags.length > 0 ? currentTags.join(', ') : 'none');
    console.log('');
    console.log('  1. Add inbound by tag');
    console.log('  2. Remove inbound by tag');
    console.log('  0. Back\n');
    
    const choice = prompt('Select: ');
    
    if (choice === '1') {
      const tag = prompt('Inbound tag to add: ');
      if (!tag) continue;
      
      const exists = xrayInbounds.find(ib => ib.tag === tag);
      if (!exists) {
        console.log('✗ Tag not found in Xray config');
        prompt('Press Enter...');
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
      const tag = prompt('Inbound tag to remove: ');
      if (!tag) continue;
      
      if (currentTags.includes(tag)) {
        setProfileInboundTags(profileId, currentTags.filter(t => t !== tag));
        console.log('✓ Inbound removed');
        reloadXray();
      } else {
        console.log('Tag not in profile');
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
  header(`Subscription: ${profile.username}`);
  console.log('\nBase64:\n');
  console.log(sub);
  console.log('\n\nDecoded:\n');
  console.log(Buffer.from(sub, 'base64').toString());
  console.log('\n');
  prompt('Press Enter...');
}

async function xrayManagement() {
  while (true) {
    clear();
    const info = detectXray();
    header('Xray Management');
    
    console.log(`  Status: ${info.installed ? '✓ Installed' : '✗ Not installed'}`);
    console.log(`  Method: ${info.method}`);
    if (info.version) console.log(`  Version: ${info.version}`);
    console.log(`  Config: ${info.configPath}`);
    console.log('');
    console.log('  1. Install Xray');
    console.log('  2. Update Xray');
    console.log('  3. Start/Restart');
    console.log('  4. Stop');
    console.log('  5. Validate Config');
    console.log('  0. Back\n');
    
    const choice = prompt('Select: ') || '';
    
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
      header('Config Validation');
      const result = validateXrayConfig();
      if (result.valid) {
        console.log('  ✓ Config is valid\n');
      } else {
        console.log('  ✗ Config has errors:\n');
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
        console.log('');
      }
      prompt('Press Enter...');
    } else {
      break;
    }
    prompt('Press Enter...');
  }
}

async function main() {
  while (true) {
    clear();
    header('xray-cli');
    const info = detectXray();
    console.log(`  Xray: ${info.installed ? info.version || 'Installed' : 'Not installed'}`);
    console.log('');
    console.log('  1. Dashboard');
    console.log('  2. Profiles');
    console.log('  3. Xray Management');
    console.log('  4. Settings');
    console.log('  0. Exit\n');
    
    const choice = prompt('Select: ') || '';
    
    if (choice === '1') {
      await dashboard();
    } else if (choice === '2') {
      await listProfiles();
      
      console.log('  1. Add Profile');
      console.log('  2. Delete Profile');
      console.log('  3. Toggle Enable');
      console.log('  4. Manage Inbounds');
      console.log('  5. View Subscription');
      console.log('  0. Back\n');
      
      const sub = prompt('Select: ') || '';
      
      if (sub === '1') {
        const username = prompt('Username: ');
        if (username) {
          const profile = createProfile(username);
          console.log(`✓ Profile created: ${profile.username}`);
          
          const add = prompt('Add inbound? (y/n): ');
          if (add.toLowerCase() === 'y') {
            await manageInbounds(profile.id);
          }
        }
      } else if (sub === '2') {
        const id = prompt('Profile ID to delete: ');
        if (deleteProfile(parseInt(id))) {
          console.log('✓ Profile deleted');
          reloadXray();
        }
      } else if (sub === '3') {
        const id = prompt('Profile ID to toggle: ');
        const profile = getProfile(parseInt(id));
        if (profile) {
          profile.enable = profile.enable ? 0 : 1;
          updateProfile(parseInt(id), { enable: profile.enable });
          console.log(`✓ Profile ${profile.enable ? 'enabled' : 'disabled'}`);
          reloadXray();
        }
      } else if (sub === '4') {
        const id = prompt('Profile ID: ');
        await manageInbounds(parseInt(id));
      } else if (sub === '5') {
        const id = prompt('Profile ID: ');
        await subscriptionUrl(parseInt(id));
      }
    } else if (choice === '3') {
      await xrayManagement();
    } else if (choice === '4') {
      clear();
      header('Settings');
      console.log(`  API Port: 2053`);
      console.log(`  Config: ${XRAY_CONFIG_PATH}`);
      console.log(`  Database: ${DB_PATH}`);
      console.log('\n');
      prompt('Press Enter...');
    } else if (choice === '0') {
      break;
    }
  }
}

main();