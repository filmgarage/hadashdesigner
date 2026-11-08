const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PORT = 8099; // ingress-poort; wordt niet extern geopend
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_DIR = '/data/backups';
const MAX_BODY = 200_000;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}\.dash$/;

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
    addon_configs_visible: fs.existsSync('/addon_configs')
      ? fs.readdirSync('/addon_configs')
      : 'niet zichtbaar',
    share_visible: fs.existsSync('/share'),
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
    // Eerst naar een tijdelijk bestand schrijven, dan hernoemen: zo kan AppDaemon nooit een half bestand lezen
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

let entityCache = { at: 0, data: [] };

async function getEntities() {
  if (Date.now() - entityCache.at < 60000 && entityCache.data.length) return entityCache.data;
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error('geen SUPERVISOR_TOKEN (staat homeassistant_api aan?)');
  const r = await fetch('http://supervisor/core/api/states', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Home Assistant gaf ${r.status}`);
  const states = await r.json();
  const data = states
    .map((st) => ({
      entity_id: st.entity_id,
      name: (st.attributes && st.attributes.friendly_name) || st.entity_id,
    }))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  entityCache = { at: Date.now(), data };
  return data;
}

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

  if (p === '/api/entities' && req.method === 'GET') {
    getEntities()
      .then((d) => sendJson(res, 200, d))
      .catch((e) => sendJson(res, 502, { error: e.message }));
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
