import Database from 'better-sqlite3';
import { mkdir } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

const DB_PATH = `${homedir()}/.config/xray-cli/xray-cli.db`;

mkdir(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    enable INTEGER DEFAULT 1,
    flow TEXT DEFAULT '',
    limit_ip INTEGER DEFAULT 0,
    total_gb INTEGER DEFAULT 0,
    expiry_time INTEGER,
    sub_uuid TEXT UNIQUE,
    sub_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inbounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    protocol TEXT NOT NULL,
    port INTEGER NOT NULL,
    listen TEXT DEFAULT '0.0.0.0',
    enable INTEGER DEFAULT 1,
    settings TEXT DEFAULT '{}',
    stream_settings TEXT DEFAULT '{}',
    tag_settings TEXT DEFAULT '{}',
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    uplink INTEGER DEFAULT 0,
    downlink INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
  );
`);

function generateShortToken(length = 10): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function generateUniqueToken(maxAttempts = 10): string {
  for (let i = 0; i < maxAttempts; i++) {
    const token = generateShortToken();
    const existing = db.prepare('SELECT id FROM profiles WHERE sub_uuid = ?').get(token);
    if (!existing) return token;
  }
  throw new Error('Failed to generate unique token');
}

interface Profile {
  id: number;
  uuid: string;
  username: string;
  enable: number;
  flow: string;
  limit_ip: number;
  total_gb: number;
  expiry_time: number | null;
  sub_uuid: string | null;
  sub_url: string | null;
  created_at: string;
  updated_at: string;
}

interface Inbound {
  id: number;
  profile_id: number;
  tag: string;
  protocol: string;
  port: number;
  listen: string;
  enable: number;
  settings: string;
  stream_settings: string;
  tag_settings: string;
}

export function getAllProfiles(): Profile[] {
  return db.prepare('SELECT * FROM profiles ORDER BY id DESC').all() as Profile[];
}

export function getProfile(id: number): Profile | undefined {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined;
}

export function getProfileByToken(token: string): Profile | undefined {
  return db.prepare('SELECT * FROM profiles WHERE sub_uuid = ? AND enable = 1').get(token) as Profile | undefined;
}

export function createProfile(data: {
  username: string;
  uuid?: string;
  flow?: string;
  limit_ip?: number;
  total_gb?: number;
}): Profile {
  const uuid = data.uuid || crypto.randomUUID();
  const sub_uuid = generateUniqueToken();
  
  const result = db.prepare(`
    INSERT INTO profiles (uuid, username, sub_uuid, flow, limit_ip, total_gb)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid, data.username, sub_uuid, data.flow || '', data.limit_ip || 0, data.total_gb || 0);
  
  return getProfile(result.lastInsertRowid as number)!;
}

export function updateProfile(id: number, data: Partial<{
  username: string;
  uuid: string;
  enable: number;
  flow: string;
  limit_ip: number;
  total_gb: number;
}>): Profile | undefined {
  const current = getProfile(id);
  if (!current) return undefined;
  
  const fields: string[] = [];
  const values: any[] = [];
  
  if (data.username !== undefined) { fields.push('username = ?'); values.push(data.username); }
  if (data.uuid !== undefined) { fields.push('uuid = ?'); values.push(data.uuid); }
  if (data.enable !== undefined) { fields.push('enable = ?'); values.push(data.enable); }
  if (data.flow !== undefined) { fields.push('flow = ?'); values.push(data.flow); }
  if (data.limit_ip !== undefined) { fields.push('limit_ip = ?'); values.push(data.limit_ip); }
  if (data.total_gb !== undefined) { fields.push('total_gb = ?'); values.push(data.total_gb); }
  
  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE profiles SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  }
  
  return getProfile(id);
}

export function deleteProfile(id: number): boolean {
  const result = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getInboundsByProfile(profileId: number): Inbound[] {
  return db.prepare('SELECT * FROM inbounds WHERE profile_id = ?').all(profileId) as Inbound[];
}

export function getInbound(id: number): Inbound | undefined {
  return db.prepare('SELECT * FROM inbounds WHERE id = ?').get(id) as Inbound | undefined;
}

export function createInbound(data: {
  profile_id: number;
  tag: string;
  protocol: string;
  port: number;
  listen?: string;
  settings?: string;
  stream_settings?: string;
}): Inbound {
  const result = db.prepare(`
    INSERT INTO inbounds (profile_id, tag, protocol, port, listen, settings, stream_settings)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.profile_id,
    data.tag,
    data.protocol,
    data.port,
    data.listen || '0.0.0.0',
    data.settings || '{}',
    data.stream_settings || '{}'
  );
  
  return getInbound(result.lastInsertRowid as number)!;
}

export function updateInbound(id: number, data: Partial<{
  tag: string;
  protocol: string;
  port: number;
  listen: string;
  enable: number;
  settings: string;
  stream_settings: string;
}>): Inbound | undefined {
  const current = getInbound(id);
  if (!current) return undefined;
  
  const fields: string[] = [];
  const values: any[] = [];
  
  if (data.tag !== undefined) { fields.push('tag = ?'); values.push(data.tag); }
  if (data.protocol !== undefined) { fields.push('protocol = ?'); values.push(data.protocol); }
  if (data.port !== undefined) { fields.push('port = ?'); values.push(data.port); }
  if (data.listen !== undefined) { fields.push('listen = ?'); values.push(data.listen); }
  if (data.enable !== undefined) { fields.push('enable = ?'); values.push(data.enable); }
  if (data.settings !== undefined) { fields.push('settings = ?'); values.push(data.settings); }
  if (data.stream_settings !== undefined) { fields.push('stream_settings = ?'); values.push(data.stream_settings); }
  
  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE inbounds SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  
  return getInbound(id);
}

export function deleteInbound(id: number): boolean {
  const result = db.prepare('DELETE FROM inbounds WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getAllInbounds(): Inbound[] {
  return db.prepare('SELECT * FROM inbounds').all() as Inbound[];
}

export default db;
