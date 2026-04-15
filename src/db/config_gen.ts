import * as db from './database';

export interface XrayConfig {
  log: object;
  api: object;
  stats: object;
  policy: object;
  inbounds: XrayInbound[];
  outbounds: XrayOutbound[];
}

export interface XrayInbound {
  tag: string;
  port: number;
  listen: string;
  protocol: string;
  settings: object;
  streamSettings?: object;
  allocate?: object;
}

export interface XrayOutbound {
  tag: string;
  protocol: string;
  settings: object;
}

export function buildXrayConfig(): XrayConfig {
  const profiles = db.getAllProfiles().filter(p => p.enable);
  const inbounds = db.getAllInbounds();
  
  const config: XrayConfig = {
    log: {
      access: '/var/log/xray/access.log',
      error: '/var/log/xray/error.log',
      loglevel: 'warning'
    },
    api: {
      tag: 'api',
      services: ['HandlerService', 'LoggerService', 'StatsService']
    },
    stats: {},
    policy: {
      levels: {
        '0': { statsUserUplink: true, statsUserDownlink: true }
      },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true
      }
    },
    inbounds: [],
    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'blocked', protocol: 'blackhole', settings: {} }
    ]
  };
  
  const usedPorts = new Set<number>();
  
  for (const profile of profiles) {
    const profileInbounds = inbounds.filter(i => i.profile_id === profile.id && i.enable);
    
    for (const ib of profileInbounds) {
      let port = ib.port;
      while (usedPorts.has(port)) port++;
      usedPorts.add(port);
      
      const settings = JSON.parse(ib.settings || '{}');
      const streamSettings = JSON.parse(ib.stream_settings || '{}');
      
      const inbound: XrayInbound = {
        tag: `${profile.username}-${ib.tag}`,
        port,
        listen: ib.listen,
        protocol: ib.protocol,
        settings: {},
        streamSettings: streamSettings,
        allocate: { strategy: 'always' }
      };
      
      if (ib.protocol === 'vmess' || ib.protocol === 'vless') {
        inbound.settings = {
          clients: [{ id: profile.uuid, flow: profile.flow || '' }]
        };
      } else if (ib.protocol === 'trojan') {
        inbound.settings = {
          clients: [{ password: settings.password || '' }]
        };
      } else if (ib.protocol === 'shadowsocks') {
        inbound.settings = {
          clients: [{ method: settings.method || 'aes-256-gcm', password: settings.password || '' }]
        };
      } else if (ib.protocol === 'hysteria2') {
        inbound.settings = {
          users: [{ password: settings.password || '' }],
          tls: settings.tls ? {
            enabled: true,
            server_name: settings.sni || '',
            alpn: ['h2', 'http/1.1']
          } : undefined
        };
      }
      
      config.inbounds.push(inbound);
    }
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

export function generateSubscription(profile: db.Profile, inbounds: db.Inbound[]): string {
  const links: string[] = [];
  
  for (const ib of inbounds) {
    const settings = JSON.parse(ib.settings || '{}');
    const port = ib.port;
    
    if (ib.protocol === 'vmess') {
      const vmess = {
        v: '2',
        ps: `${profile.username}-${ib.tag}`,
        add: '0.0.0.0',
        port: String(port),
        id: profile.uuid,
        aid: settings.alterId || 0,
        net: settings.network || 'tcp',
        type: settings.header?.type || 'none',
        host: settings.header?.requests?.[0]?.headers?.Host?.[0] || '',
        tls: settings.security || ''
      };
      const encoded = Buffer.from(JSON.stringify(vmess)).toString('base64');
      links.push(`vmess://${encoded}`);
    } else if (ib.protocol === 'vless') {
      const params = new URLSearchParams();
      if (profile.flow) params.set('flow', profile.flow);
      if (settings.security) params.set('security', settings.security);
      if (settings.sni) params.set('sni', settings.sni);
      links.push(`vless://${profile.uuid}@0.0.0.0:${port}?${params}`);
    } else if (ib.protocol === 'trojan') {
      const params = new URLSearchParams();
      if (settings.sni) params.set('sni', settings.sni);
      links.push(`trojan://${settings.password}@0.0.0.0:${port}?${params}`);
    } else if (ib.protocol === 'shadowsocks') {
      const ss = `${settings.method || 'aes-256-gcm'}:${settings.password}@0.0.0.0:${port}`;
      const encoded = Buffer.from(ss).toString('base64');
      links.push(`ss://${encoded}`);
    } else if (ib.protocol === 'hysteria2') {
      const params = new URLSearchParams();
      if (settings.sni) params.set('sni', settings.sni);
      if (settings.upMbps) params.set('upmbps', String(settings.upMbps));
      if (settings.downMbps) params.set('downmbps', String(settings.downMbps));
      links.push(`hysteria2://${settings.password}@0.0.0.0:${port}?${params}`);
    }
  }
  
  return Buffer.from(links.join('\n')).toString('base64');
}
