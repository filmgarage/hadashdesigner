const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const WebSocket = require('ws');

const PORT = 8099; // ingress-poort; wordt niet extern geopend
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_DIR = '/data/backups';
const MAX_BODY = 200_000;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}\.dash$/;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const HA_WS_URL = 'ws://supervisor/core/websocket';
const TOKEN = process.env.SUPERVISOR_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function loadOptions() {
  try {
    return JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  } catch {
    return {};
  }
}

const options = loadOptions();
const DASH_DIR = path.resolve(options.dashboard_dir || '/share/dashboards');

// Map aanmaken als die ontbreekt, zodat de lijst ook na een herinstallatie werkt
try {
  fs.mkdirSync(DASH_DIR, { recursive: true });
} catch (e) {
  console.error('Kan dashboardmap niet aanmaken:', e.message);
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function listDashboards() {
  return fs
    .readdirSync(DASH_DIR)
    .filter((f) => NAME_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(DASH_DIR, f));
      return { name: f, size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Geeft null als de naam ongeldig is (voorkomt paden zoals ../)
function dashPath(name) {
  if (!NAME_RE.test(name)) return null;
  return path.join(DASH_DIR, name);
}

function diagnose() {
  const exists = fs.existsSync(DASH_DIR);
  return {
    dashboard_dir: DASH_DIR,
    dir_exists: exists,
    dir_writable: exists && isWritable(DASH_DIR),
    dir_files: exists ? fs.readdirSync(DASH_DIR) : [],
    ha: { online: ha.online, reason: ha.reason, entities: ha.states.size },
  };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      sendJson(res, 413, { error: 'bestand is te groot' });
      req.destroy();
    } else {
      chunks.push(chunk);
    }
  });
  req.on('end', () => {
    if (!res.writableEnded) cb(Buffer.concat(chunks).toString('utf8'));
  });
}

function saveDashboard(name, file, body, res) {
  let parsed;
  try {
    parsed = yaml.load(body);
  } catch (e) {
    return sendJson(res, 400, { error: 'ongeldige YAML: ' + e.message });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return sendJson(res, 400, { error: 'een dashboard moet een YAML-object zijn' });
  }
  if (!Array.isArray(parsed.layout)) {
    return sendJson(res, 400, { error: 'een dashboard heeft een layout-lijst nodig' });
  }

  try {
    // Oude versie bewaren in de data-map van de add-on, niet in de AppDaemon-map
    if (fs.existsSync(file)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.copyFileSync(file, path.join(BACKUP_DIR, `${name}.${Date.now()}.bak`));
    }
    // Eerst naar een tijdelijk bestand schrijven, dan hernoemen: AppDaemon kan nooit een half bestand lezen
    const tmp = path.join(DASH_DIR, `.${name}.partial`);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return sendJson(res, 200, { ok: true, name });
  } catch (e) {
    return sendJson(res, 500, { error: 'schrijven mislukt: ' + e.message });
  }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('niet gevonden');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Home Assistant (websocket, zoals de Tessera-add-on) ----------
//
// Eén verbinding met de Supervisor-proxy. Na authenticatie: state_changed abonneren en daarna get_states,
// zodat er geen wijziging tussen de twee in verloren gaat. Verbinding weg? Dan wachten en opnieuw verbinden.

const ha = {
  ws: null,
  online: false,
  reason: TOKEN ? 'nog niet verbonden' : 'geen SUPERVISOR_TOKEN (staat homeassistant_api aan?)',
  nextId: 1,
  pending: new Map(),   // id -> { resolve, reject }
  states: new Map(),    // entity_id -> state
  seq: 0,               // gaat omhoog bij elke wijziging
};

function haRequest(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!ha.ws || ha.ws.readyState !== WebSocket.OPEN || !ha.online) {
      return reject(new Error('geen verbinding met Home Assistant'));
    }
    const id = ha.nextId++;
    const timer = setTimeout(() => {
      ha.pending.delete(id);
      reject(new Error('Home Assistant reageert niet'));
    }, timeoutMs);
    ha.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ha.ws.send(JSON.stringify({ ...msg, id }));
  });
}

async function handleHa(msg, sock) {
  if (msg.type === 'auth_required') {
    return sock.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
  }
  if (msg.type === 'auth_invalid') {
    ha.reason = 'Home Assistant weigerde de token';
    return sock.close();
  }
  if (msg.type === 'auth_ok') {
    ha.online = true;
    ha.reason = 'verbonden';
    await haRequest({ type: 'subscribe_events', event_type: 'state_changed' });
    const list = await haRequest({ type: 'get_states' });
    ha.states.clear();
    for (const s of list) ha.states.set(s.entity_id, s);
    ha.seq++;
    console.log(`Home Assistant verbonden: ${ha.states.size} entiteiten`);
    return;
  }
  if (msg.type === 'result') {
    const p = ha.pending.get(msg.id);
    if (!p) return;
    ha.pending.delete(msg.id);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new Error((msg.error && msg.error.message) || 'fout van Home Assistant'));
    return;
  }
  if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
    const d = msg.event.data;
    if (d.new_state) ha.states.set(d.entity_id, d.new_state);
    else ha.states.delete(d.entity_id);
    ha.seq++;
  }
}

function connectHA() {
  if (!TOKEN) {
    console.error(ha.reason);
    return;
  }
  const sock = new WebSocket(HA_WS_URL);
  ha.ws = sock;
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleHa(msg, sock).catch((e) => {
      ha.reason = 'fout: ' + e.message;
      console.error('HA-fout:', e.message);
    });
  });
  sock.on('error', (err) => {
    ha.reason = 'verbindingsfout: ' + err.message;
    console.error('HA-verbinding:', err.message);
  });
  sock.on('close', () => {
    ha.online = false;
    ha.reason = 'verbinding verbroken, opnieuw proberen';
    for (const p of ha.pending.values()) p.reject(new Error('verbinding verbroken'));
    ha.pending.clear();
    setTimeout(connectHA, 5000);
  });
}

// Welke acties Home Assistant voor één entiteit aanbiedt (zoals de Tessera-add-on dat vraagt)
async function actionsFor(entityId) {
  try {
    const answer = await haRequest({
      type: 'get_services_for_target',
      target: { entity_id: [entityId] },
      expand_group: false,
    });
    return Array.isArray(answer) ? answer : [];
  } catch {
    return [];
  }
}

// ---------- HTTP ----------

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/diag' && req.method === 'GET') {
    return sendJson(res, 200, diagnose());
  }

  if (p === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, {
      appdaemon_port: Number(options.appdaemon_port) || 5050,
      dashboard_dir: DASH_DIR,
    });
  }

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { online: ha.online, reason: ha.reason, entities: ha.states.size, seq: ha.seq });
  }

  if (p === '/api/catalog' && req.method === 'GET') {
    try {
      return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8')));
    } catch {
      return sendJson(res, 500, { error: 'catalogus niet leesbaar' });
    }
  }

  if (p === '/api/entities' && req.method === 'GET') {
    if (!ha.online) return sendJson(res, 503, { error: 'geen verbinding met Home Assistant: ' + ha.reason });
    const list = [...ha.states.values()]
      .map((s) => ({ entity_id: s.entity_id, name: (s.attributes && s.attributes.friendly_name) || s.entity_id }))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    return sendJson(res, 200, list);
  }

  // Actuele waarden voor de tegels in het ontwerp (de editor vraagt dit elke paar seconden)
  if (p === '/api/live' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter((id) => ENTITY_RE.test(id)).slice(0, 300);
    const states = {};
    for (const id of ids) {
      const s = ha.states.get(id);
      if (!s) continue;
      const a = s.attributes || {};
      states[id] = { state: s.state, unit: a.unit_of_measurement || '', name: a.friendly_name || id };
    }
    return sendJson(res, 200, { online: ha.online, reason: ha.reason, seq: ha.seq, states });
  }

  // Welke acties een entiteit heeft (van Home Assistant zelf, niet uit een vaste lijst)
  if (p === '/api/actions' && req.method === 'GET') {
    const id = url.searchParams.get('entity') || '';
    if (!ENTITY_RE.test(id)) return sendJson(res, 400, { error: 'ongeldige entiteit' });
    if (!ha.online) return sendJson(res, 503, { error: 'geen verbinding met Home Assistant' });
    actionsFor(id).then((list) => sendJson(res, 200, { entity: id, actions: list }));
    return;
  }

  if (p === '/api/dashboards' && req.method === 'GET') {
    try {
      return sendJson(res, 200, listDashboards());
    } catch (e) {
      return sendJson(res, 500, { error: 'map niet leesbaar: ' + e.message });
    }
  }

  const m = p.match(/^\/api\/dashboards\/([^/]+)$/);
  if (m) {
    const name = decodeURIComponent(m[1]);
    const file = dashPath(name);
    if (!file) return sendJson(res, 400, { error: 'ongeldige bestandsnaam (gebruik letters, cijfers, - of _ en eindig op .dash)' });

    if (req.method === 'GET') {
      try {
        return sendJson(res, 200, { name, content: fs.readFileSync(file, 'utf8') });
      } catch {
        return sendJson(res, 404, { error: 'bestand niet gevonden' });
      }
    }

    if (req.method === 'PUT') {
      return readBody(req, res, (body) => saveDashboard(name, file, body, res));
    }

    return sendJson(res, 405, { error: 'methode niet toegestaan' });
  }

  return serveStatic(p, res);
}

http.createServer(handle).listen(PORT, () => {
  console.log(`Editor luistert op poort ${PORT}`);
  console.log(`Dashboardmap: ${DASH_DIR}`);
});

connectHA();
