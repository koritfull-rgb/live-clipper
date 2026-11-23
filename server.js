// Live Clipper — внутренний сервер. Отдаёт страницу и принимает команды от неё.
// В программе его запускает electron/main.js.
// Для отладки можно запустить и без Electron: node server.js --open  (откроется в браузере)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const { PUBLIC_DIR } = require('./src/paths');
const settings = require('./src/settings');
const status = require('./src/status');
const recorder = require('./src/recorder');
const clipper = require('./src/clipper');
const tools = require('./src/tools');
const triggers = require('./src/triggers');
const clipsMeta = require('./src/clips-meta');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47811; // постоянный порт, чтобы страница помнила тур и последнюю ссылку

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
};

// ---------- помощники ----------

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Нельзя' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Не найдено' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Отдать видео с поддержкой перемотки (HTTP Range).
function serveMedia(req, res, name) {
  const dir = settings.get().clipsDir;
  if (!dir) return sendJson(res, 404, { error: 'Папка для клипов не выбрана' });
  const file = path.join(dir, path.basename(name));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Клип не найден' });
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] ? Number(range[1]) : 0;
      let end = range[2] ? Number(range[2]) : st.size - 1;
      if (!range[1] && range[2]) { start = st.size - Number(range[2]); end = st.size - 1; }
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function listClips() {
  const dir = settings.get().clipsDir;
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const clips = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.mp4') || n.endsWith('.part.mp4')) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      const meta = clipsMeta.get(n);
      clips.push({
        name: n,
        size: st.size,
        mtime: st.mtimeMs,
        auto: Boolean(meta && meta.source !== 'manual') || n.includes('_auto_'),
        reason: meta ? meta.reason : '',
      });
    } catch {}
  }
  return clips.sort((a, b) => b.mtime - a.mtime);
}

// ---------- маршруты ----------

const routes = {
  'GET /api/events': (req, res) => status.attach(req, res),

  'GET /api/settings': (req, res) => sendJson(res, 200, settings.get()),

  'POST /api/settings': async (req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, settings.update(body));
  },

  'POST /api/record/start': async (req, res) => {
    const { url } = await readBody(req);
    recorder.start(url);
    triggers.startAll();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/record/stop': (req, res) => {
    recorder.stop();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/clip': async (req, res) => {
    const { seconds, format } = await readBody(req);
    sendJson(res, 200, triggers.get('manual').fire({ seconds, format }));
  },

  'GET /api/clips': (req, res) => sendJson(res, 200, listClips()),

  'POST /api/open-folder': (req, res) => {
    const dir = settings.get().clipsDir;
    if (!dir) throw new Error('Папка для клипов не выбрана.');
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    sendJson(res, 200, { ok: true });
  },
};

// Запросы принимаем только от самой программы, а не от посторонних сайтов в браузере.
function isForeignOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return false;
  return origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`;
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    try {
      if (isForeignOrigin(req, server.address().port)) return sendJson(res, 403, { error: 'Нельзя' });
      const route = routes[`${req.method} ${pathname}`];
      if (route) return await route(req, res);
      if (req.method === 'GET' && pathname.startsWith('/media/')) {
        return serveMedia(req, res, decodeURIComponent(pathname.slice('/media/'.length)));
      }
      if (req.method === 'GET') return serveStatic(req, res);
      sendJson(res, 404, { error: 'Не найдено' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    }
  });
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onOk); reject(err); };
    const onOk = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, HOST);
  });
}

// Запустить сервер. Если основной порт занят — берём любой свободный.
async function startServer({ port = DEFAULT_PORT } = {}) {
  clipper.cleanupTmp();
  tools.prepare();
  recorder.onStop(() => triggers.stopAll());

  const server = createServer();
  try {
    return await listen(server, port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    return listen(server, 0);
  }
}

// Остановить запись и нарезку. Возвращает Promise, который выполнится, когда всё закрыто.
function shutdown() {
  clipper.abort();
  if (!recorder.isRunning()) return Promise.resolve();
  return new Promise((resolve) => {
    recorder.onStop(resolve);
    recorder.stop();
    setTimeout(resolve, 4000);
  });
}

module.exports = { startServer, shutdown };

// ---------- запуск без Electron (для отладки) ----------
if (require.main === module) {
  startServer().then((port) => {
    const url = `http://localhost:${port}`;
    console.log(`Live Clipper запущен: ${url}`);
    console.log('Чтобы закрыть, нажми Ctrl+C.');
    if (process.argv.includes('--open')) exec(`start "" "${url}"`);
  });
  const stop = () => shutdown().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
