'use strict';

const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const fetch = require('node-fetch');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BELLS_FILE = path.join(DATA_DIR, 'bells.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_ALARMS = [
  { id: 'fire_drill',            label: 'Fire Drill',                          soundId: '', isDrill: true  },
  { id: 'fire_real',             label: 'Fire (NOT A DRILL)',                   soundId: '', isDrill: false },
  { id: 'severe_weather_drill',  label: 'Severe Weather Warning Drill',         soundId: '', isDrill: true  },
  { id: 'severe_weather_real',   label: 'Severe Weather Warning (NOT A DRILL)', soundId: '', isDrill: false },
  { id: 'intruder_drill',        label: 'Intruder Lockdown Drill',              soundId: '', isDrill: true  },
  { id: 'intruder_real',         label: 'Intruder Lockdown (NOT A DRILL)',      soundId: '', isDrill: false },
  { id: 'tornado_drill',         label: 'Tornado Warning Drill',                soundId: '', isDrill: true  },
  { id: 'tornado_real',          label: 'Tornado Warning (NOT A DRILL)',        soundId: '', isDrill: false },
  { id: 'system_test',           label: 'System Test',                          soundId: '', isDrill: true  },
  { id: 'graduation',            label: 'Graduation Song',                      soundId: '', isDrill: true  },
  { id: 'all_clear',             label: 'All Clear',                            soundId: '', isDrill: true  },
];

const DEFAULT_CONFIG = {
  schoolName:  'Delphi Academy',
  controllerIP: '',
  apiKey:       '',
  password:     'Admin1!!',
  bellSoundId:  '',
  alarms:       DEFAULT_ALARMS,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const savedAlarms = saved.alarms || [];
    saved.alarms = DEFAULT_ALARMS.map(def => {
      const found = savedAlarms.find(a => a.id === def.id);
      return found ? { ...def, soundId: found.soundId } : { ...def };
    });
    return { ...DEFAULT_CONFIG, ...saved };
  } catch (e) {
    console.error('Config load error:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadBells() {
  try {
    if (!fs.existsSync(BELLS_FILE)) {
      fs.writeFileSync(BELLS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    return JSON.parse(fs.readFileSync(BELLS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveBells(bells) {
  fs.writeFileSync(BELLS_FILE, JSON.stringify(bells, null, 2));
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'unifi-alarm-panel-' + crypto.randomBytes(16).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── UniFi integration ─────────────────────────────────────────────────────────

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function triggerUnifi(soundId) {
  const c = loadConfig();
  if (!c.controllerIP) throw new Error('Controller IP not configured — visit Settings.');
  if (!c.apiKey)       throw new Error('API Key not configured — visit Settings.');
  if (!soundId)        throw new Error('Chime ID not configured for this alarm — visit Settings.');

  // UniFi Protect Integration API: POST /proxy/protect/integration/v1/chimes/{id}/play-speaker
  const url = `https://${c.controllerIP}/proxy/protect/integration/v1/chimes/${encodeURIComponent(soundId)}/play-speaker`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'X-API-KEY': c.apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({}),
    agent:   httpsAgent,
    timeout: 10000,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return res.json().catch(() => ({}));
}

// ── Bell scheduler ────────────────────────────────────────────────────────────

const activeCrons = new Map();

function scheduleBell(bell) {
  if (activeCrons.has(bell.id)) {
    activeCrons.get(bell.id).stop();
    activeCrons.delete(bell.id);
  }
  if (!bell.enabled || !bell.time) return;

  const [h, m] = bell.time.split(':').map(Number);
  const days   = bell.days && bell.days.length ? bell.days.join(',') : '*';
  const expr   = `${m} ${h} * * ${days}`;

  if (!cron.validate(expr)) {
    console.error(`Invalid cron for bell "${bell.name}": ${expr}`);
    return;
  }

  activeCrons.set(bell.id, cron.schedule(expr, async () => {
    console.log(`[${new Date().toISOString()}] Bell: ${bell.name}`);
    const c      = loadConfig();
    const soundId = bell.soundId || c.bellSoundId;
    try {
      await triggerUnifi(soundId);
    } catch (err) {
      console.error(`Bell "${bell.name}" failed:`, err.message);
    }
  }));
}

function initSchedules() {
  const bells = loadBells();
  bells.forEach(scheduleBell);
  console.log(`Scheduled ${bells.filter(b => b.enabled).length} active bell(s)`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config/public', (req, res) => {
  const c = loadConfig();
  res.json({
    schoolName: c.schoolName,
    ready:  !!(c.controllerIP && c.apiKey),
    alarms: c.alarms.map(a => ({ id: a.id, label: a.label, isDrill: a.isDrill, configured: !!a.soundId })),
  });
});

app.get('/api/check-unifi', async (req, res) => {
  const c = loadConfig();
  if (!c.controllerIP || !c.apiKey) {
    return res.json({ ok: false, message: 'Controller IP or API Key not configured — visit Settings.' });
  }
  try {
    const r = await fetch(
      `https://${c.controllerIP}/proxy/protect/integration/v1/meta/info`,
      { headers: { 'X-API-KEY': c.apiKey, 'Accept': 'application/json' }, agent: httpsAgent, timeout: 6000 }
    );
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      res.json({ ok: true, message: `Connected — ${data.name || c.controllerIP}` });
    } else {
      res.json({ ok: false, message: `HTTP ${r.status} from controller` });
    }
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

app.post('/api/alarm/:alarmId', async (req, res) => {
  const c     = loadConfig();
  const alarm = c.alarms.find(a => a.id === req.params.alarmId);
  if (!alarm) return res.status(404).json({ error: 'Unknown alarm' });
  try {
    await triggerUnifi(alarm.soundId);
    res.json({ ok: true, message: `${alarm.label} triggered successfully` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Bells CRUD
app.get('/api/bells', (req, res) => res.json(loadBells()));

app.post('/api/bells', (req, res) => {
  const { name, time, days, enabled } = req.body;
  if (!name?.trim() || !time) return res.status(400).json({ error: 'Name and time are required' });
  const bells = loadBells();
  const bell  = {
    id:      crypto.randomUUID(),
    name:    name.trim(),
    time,
    days:    (Array.isArray(days) ? days : []).map(Number),
    enabled: enabled !== false && enabled !== 'false',
  };
  bells.push(bell);
  saveBells(bells);
  scheduleBell(bell);
  res.json(bell);
});

app.put('/api/bells/:id', (req, res) => {
  const bells = loadBells();
  const idx   = bells.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bell not found' });
  const { name, time, days, enabled } = req.body;
  const bell = {
    ...bells[idx],
    ...(name    !== undefined && { name: name.trim() }),
    ...(time    !== undefined && { time }),
    ...(days    !== undefined && { days: (Array.isArray(days) ? days : []).map(Number) }),
    ...(enabled !== undefined && { enabled: enabled !== false && enabled !== 'false' }),
  };
  bells[idx] = bell;
  saveBells(bells);
  scheduleBell(bell);
  res.json(bell);
});

app.delete('/api/bells/:id', (req, res) => {
  const bells = loadBells();
  const idx   = bells.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bell not found' });
  if (activeCrons.has(req.params.id)) {
    activeCrons.get(req.params.id).stop();
    activeCrons.delete(req.params.id);
  }
  bells.splice(idx, 1);
  saveBells(bells);
  res.json({ ok: true });
});

app.post('/api/bells/:id/toggle', (req, res) => {
  const bells = loadBells();
  const idx   = bells.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bell not found' });
  bells[idx].enabled = !bells[idx].enabled;
  saveBells(bells);
  scheduleBell(bells[idx]);
  res.json(bells[idx]);
});

// Auth
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === loadConfig().password) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Incorrect password' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Settings (protected)
app.get('/api/settings', requireAuth, (req, res) => {
  const c = loadConfig();
  res.json({
    schoolName:   c.schoolName,
    controllerIP: c.controllerIP,
    apiKey:       c.apiKey,
    bellSoundId:  c.bellSoundId || '',
    alarms:       c.alarms,
  });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const c = loadConfig();
  const { schoolName, controllerIP, apiKey, password, bellSoundId, alarms } = req.body;
  if (schoolName   !== undefined) c.schoolName   = schoolName;
  if (controllerIP !== undefined) c.controllerIP = controllerIP;
  if (apiKey       !== undefined) c.apiKey       = apiKey;
  if (password)                   c.password     = password;
  if (bellSoundId  !== undefined) c.bellSoundId  = bellSoundId;
  if (Array.isArray(alarms)) {
    alarms.forEach(u => {
      const a = c.alarms.find(x => x.id === u.id);
      if (a && u.soundId !== undefined) a.soundId = u.soundId;
    });
  }
  saveConfig(c);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UniFi Alarm Panel running at http://0.0.0.0:${PORT}`);
  initSchedules();
});
