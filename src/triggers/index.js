// Единая точка входа для всего, что может попросить «сделай клип».
//
// Триггеры:
//   manual.js — кнопка «Клип» / горячая клавиша;
//   chat.js   — авто-клипы по реакции чата (+ громкость как усиление).
// Чтобы добавить новый (например, по словам стримера):
//   1. Создай рядом файл, например words.js, который экспортирует объект:
//        { name: 'words', start(ctx) {...}, stop() {...} }
//   2. Внутри start() следи за чем нужно и вызывай
//        ctx.requestClip({ seconds, format, source })               — последние N секунд, или
//        ctx.requestClipRange({ from, to, format, source, reason }) — отрезок по времени (мс).
//      В ctx есть recorder (буфер, сведения о стриме) и loudness (громкость).
//   3. Зарегистрируй его ниже: register(require('./words')).
// Очередь, статус, пометки и галерея уже работают для любых триггеров.

const clipper = require('../clipper');
const settings = require('../settings');
const status = require('../status');
const recorder = require('../recorder');
const loudness = require('../signals/loudness');
const clipsMeta = require('../clips-meta');

const triggers = [];
const queue = [];
let busy = false;

function register(trigger) {
  triggers.push(trigger);
}

function get(name) {
  return triggers.find((t) => t.name === name);
}

const ctx = {
  requestClip,
  requestClipRange,
  recorder,
  loudness,
  bufferDir: recorder.BUFFER_DIR,
};

// Вызывается при старте записи — все триггеры начинают «слушать» стрим.
function startAll() {
  for (const t of triggers) if (t.start) t.start(ctx);
}

// Вызывается при остановке записи.
function stopAll() {
  for (const t of triggers) if (t.stop) t.stop();
}

// Попросить клип. Снимок буфера делается сразу, а нарезка встаёт в очередь.
// Возвращает { queued, short, seconds }.
function requestClip({ seconds, format, source = 'manual' } = {}) {
  const s = settings.get();
  if (!s.clipsDir) throw new Error('Сначала выбери папку для клипов.');
  const secs = Number(seconds) || s.clipSeconds;
  const fmt = format || s.format;
  const snap = clipper.snapshot(secs); // бросит понятную ошибку, если буфер пуст

  return enqueue({ snap, format: fmt, source });
}

// Попросить клип-отрезок по времени (для авто-клипов). from/to — миллисекунды (Date.now()).
function requestClipRange({ from, to, format, source = 'auto', reason = '' } = {}) {
  const s = settings.get();
  if (!s.clipsDir) throw new Error('Сначала выбери папку для клипов.');
  const snap = clipper.snapshotRange(from, to);
  snap.auto = source !== 'manual';
  return enqueue({ snap, format: format || s.format, source, reason });
}

function enqueue(job) {
  const queued = busy; // если уже что-то режется — этот клип подождёт
  queue.push(job);
  if (queued) status.set({ queue: queue.length });
  processQueue();
  return { queued, short: job.snap.short, seconds: Math.round(job.snap.seconds) };
}

async function processQueue() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;

  status.set({
    clipState: 'cutting',
    clipProgress: 0,
    queue: queue.length,
    clipMessage: job.snap.short
      ? `В буфере было только ${Math.round(job.snap.seconds)} сек — клип будет короче.`
      : '',
  });

  try {
    const name = await clipper.render(job.snap, { format: job.format, clipsDir: settings.get().clipsDir },
      (p) => status.set({ clipProgress: p }));
    if (job.source !== 'manual') clipsMeta.set(name, { source: job.source, reason: job.reason || '' });
    status.set({ clipState: 'done', clipProgress: 100, lastClip: name });
    status.emit('clip', { name, source: job.source, reason: job.reason || '' });
  } catch (err) {
    status.set({ clipState: 'error', clipMessage: err.message });
  }

  busy = false;
  status.set({ queue: queue.length });
  if (queue.length) processQueue();
}

// --- регистрация триггеров ---
register(require('./manual'));
register(require('./chat'));

// Ручной триггер работает всегда — даже после остановки записи можно резать из буфера.
get('manual').start(ctx);

module.exports = { register, get, startAll, stopAll, requestClip, requestClipRange };
