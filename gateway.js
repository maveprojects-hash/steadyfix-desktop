// Network scanner built into the STEADYFIX computer app.
// Finds devices on the local network and reports them to STEADYFIX every two minutes.
const os = require('os');
const { execFile } = require('child_process');
const dns = require('dns').promises;

const SUPABASE_URL = 'https://wqggnimaglsikdusbvuh.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_NhiAgVZ451DMdfwzWTSGvQ_zQlbwW8l';
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function ping(host) {
  const args = WIN ? ['-n', '1', '-w', '1500', host] : MAC ? ['-c', '1', '-t', '2', host] : ['-c', '1', '-W', '2', host];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 6000, windowsHide: true }, (err, stdout) => {
      // Windows can exit 0 on "destination unreachable", so it must also show a TTL
      resolve(!err && (!WIN || /TTL=/i.test(String(stdout))));
    });
  });
}

function subnetBase() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.')) {
        return i.address.split('.').slice(0, 3).join('.');
      }
    }
  }
  return null;
}

function parseArp(text) {
  const out = {};
  const re = /(\d+\.\d+\.\d+\.\d+)[^\n]*?((?:[0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2})/g;
  let m;
  while ((m = re.exec(text))) {
    const mac = m[2].split(/[:-]/).map((p) => p.padStart(2, '0')).join(':').toLowerCase();
    if (mac !== 'ff:ff:ff:ff:ff:ff' && mac !== '00:00:00:00:00:00') out[m[1]] = mac;
  }
  return out;
}

function arpTable() {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? {} : parseArp(String(stdout))));
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function hostname(ip) {
  try {
    const names = await Promise.race([dns.reverse(ip), new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 1500))]);
    return (names[0] || '').split('.')[0];
  } catch {
    return '';
  }
}

async function scan() {
  const base = subnetBase();
  if (!base) return [];
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const ok = await mapLimit(hosts, 48, ping);
  const alive = hosts.filter((_, i) => ok[i]);
  const macs = await arpTable();
  const devices = [];
  for (const ip of alive) {
    const name = await hostname(ip);
    devices.push({ ip, mac: macs[ip] || '', name: name || ip, up: true });
  }
  return devices;
}

async function sync(agentKey, devices) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/agent_sync', {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_agent_key: agentKey, p_devices: devices }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'The app refused the report (' + r.status + ')');
  return j;
}

class Gateway {
  constructor(getKey, onStatus) {
    this.getKey = getKey;
    this.onStatus = onStatus;
    this.busy = false;
    this.timer = null;
  }
  start() {
    this.stop();
    this.timer = setInterval(() => this.once(), 120000);
    this.once();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  async once() {
    const key = this.getKey();
    if (this.busy || !key) return;
    this.busy = true;
    try {
      this.onStatus('Scanning the network...');
      const devices = await scan();
      const r = await sync(key, devices);
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.onStatus(`Network scan: ${devices.length} devices found, last at ${t}` + (r.skipped ? ` (${r.skipped} skipped, plan limit)` : ''));
    } catch (e) {
      this.onStatus('Network scan problem: ' + e.message);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Gateway, scan, sync, parseArp, subnetBase, ping };
