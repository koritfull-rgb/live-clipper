// Запись стрима в «кольцевой» буфер.
// 1) yt-dlp получает прямые ссылки на поток (у YouTube видео и звук идут отдельно, у Twitch — вместе).
// 2) ffmpeg читает эти ссылки и режет стрим на кусочки по 2 секунды (HLS) без перекодирования.
// 3) Каждую секунду удаляем кусочки старше 6 минут, поэтому в buffer/ всегда лежат ~последние 6 минут.
//    (Считаем по времени, а не по количеству: у YouTube кусочки бывают по 5 секунд, у Twitch — по 2.)
// 4) Запоминаем, в какое время пришёл каждый кусочек — чтобы авто-клипы могли вырезать
//    отрезок «с такого-то по такое-то время», а не только «последние N секунд».
// 5) Тот же ffmpeg отдаёт звук в signals/loudness.js для замера громкости.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const status = require('./status');
const tools = require('./tools');
const loudness = require('./signals/loudness');
const { BUFFER_DIR } = require('./paths');

const PLAYLIST = path.join(BUFFER_DIR, 'live.m3u8');
const SEGMENT_SECONDS = 2;
const BUFFER_SECONDS = 360; // 6 минут
const KEEP_EXTRA_SECONDS = 30; // небольшой запас на диске, чтобы кусочки не удалились прямо во время копирования

// Сначала поток «видео+звук вместе» (Twitch), иначе отдельные видео и звук (YouTube). Не выше 1080p.
const FORMAT = 'b[height<=1080]/bv*[height<=1080]+ba/b';

let pending = false; // ждём окончания обновления yt-dlp
let ytdlp = null;
let ffmpeg = null;
let pollTimer = null;
let stopping = false;
let lastErrors = [];
let prunedCount = 0; // сколько первых кусочков из плейлиста уже удалено
let segEndTimes = new Map(); // имя кусочка → время (мс), когда он был дописан
let streamInfo = null;       // { url, site, id } — для чтения чата
const stopListeners = [];
const infoListeners = [];

// Подписка на «узнали, что за стрим» (сайт и id) — нужно чату.
function onStreamInfo(fn) {
  infoListeners.push(fn);
}

function getStreamInfo() {
  return streamInfo;
}

function isRunning() {
  return Boolean(pending || ytdlp || ffmpeg);
}

// Подписка на «запись остановилась» (по кнопке или потому что стрим закончился).
function onStop(fn) {
  stopListeners.push(fn);
}

function clearBuffer() {
  fs.rmSync(BUFFER_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUFFER_DIR, { recursive: true });
}

function rememberError(chunk) {
  const lines = chunk.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lastErrors.push(...lines);
  lastErrors = lastErrors.slice(-5);
}

function notFound(tool) {
  return `Не найден ${tool}. Попробуй переустановить Live Clipper.`;
}

function start(url) {
  if (isRunning()) throw new Error('Запись уже идёт. Сначала останови её.');
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Вставь ссылку на стрим (начинается с https://).');

  clearBuffer();
  stopping = false;
  lastErrors = [];
  prunedCount = 0;
  segEndTimes = new Map();
  streamInfo = null;
  loudness.reset();
  status.set({ recState: 'starting', recMessage: '', url, bufferSeconds: 0, bufferMax: BUFFER_SECONDS });

  pending = true;
  tools.whenReady().then(() => {
    pending = false;
    if (stopping) return onStopped();
    resolveStream(url);
  });
}

// Шаг 1: узнать прямые ссылки на поток.
function resolveStream(url) {
  let out = '';
  ytdlp = spawn(tools.ytdlp(), [
    '--no-warnings', '--no-playlist', '-f', FORMAT,
    '--print', 'INFO %(extractor_key)s %(id)s', // какой сайт и id стрима (нужно для чата)
    '--print', 'urls',                           // прямые ссылки на поток
    url,
  ], { windowsHide: true });
  ytdlp.stdout.on('data', (d) => { out += d.toString(); });
  ytdlp.stderr.on('data', rememberError);
  ytdlp.on('error', (err) => {
    lastErrors.push(err.code === 'ENOENT' ? notFound('yt-dlp') : 'yt-dlp: ' + err.message);
  });
  ytdlp.on('close', (code) => {
    ytdlp = null;
    const lines = out.split(/\r?\n/).map((s) => s.trim());
    const urls = lines.filter((s) => /^https?:\/\//.test(s));
    if (stopping || code !== 0 || urls.length === 0) return onStopped();
    const info = (lines.find((s) => s.startsWith('INFO ')) || '').split(' ');
    streamInfo = { url, site: (info[1] || '').toLowerCase(), id: info[2] || '' };
    for (const fn of infoListeners) fn(streamInfo);
    startFfmpeg(urls);
  });
}

// Шаг 2: ffmpeg пишет поток кусочками в buffer/.
function startFfmpeg(urls) {
  const inputs = urls.slice(0, 2).flatMap((u) => ['-i', u]);
  const audio = urls.length > 1 ? '1:a:0' : '0:a:0';
  const maps = ['-map', '0:v:0', '-map', audio];

  ffmpeg = spawn(tools.ffmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    ...inputs,
    ...maps,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '0',          // плейлист хранит всё; старые файлы удаляем сами (см. pollBuffer)
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(BUFFER_DIR, 'seg_%06d.ts'),
    PLAYLIST,
    // второй выход: звук для замера громкости (моно 8 кГц) — в stdout
    '-map', audio, '-ac', '1', '-ar', String(loudness.SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ], { windowsHide: true });

  ffmpeg.stdin.on('error', () => {});
  ffmpeg.stdout.on('data', loudness.feed);
  ffmpeg.stderr.on('data', rememberError);
  ffmpeg.on('error', (err) => {
    lastErrors.push(err.code === 'ENOENT' ? notFound('ffmpeg') : 'ffmpeg: ' + err.message);
  });
  ffmpeg.on('close', () => {
    ffmpeg = null;
    onStopped();
  });

  pollTimer = setInterval(pollBuffer, 500); // чаще — чтобы точнее знать время каждого кусочка
}

function stop() {
  if (!isRunning() || stopping) return;
  stopping = true;
  if (ytdlp) ytdlp.kill();
  if (ffmpeg) {
    const ff = ffmpeg;
    try { ff.stdin.write('q'); } catch {} // мягкая остановка: ffmpeg допишет последний кусочек
    setTimeout(() => { if (ffmpeg === ff) ff.kill(); }, 3000);
  }
}

function onStopped() {
  clearInterval(pollTimer);
  pollTimer = null;
  pollBuffer();
  for (const fn of stopListeners) fn();

  const hadVideo = status.get().bufferSeconds > 0;
  if (stopping) {
    status.set({ recState: 'idle', recMessage: hadVideo ? 'Запись остановлена. Из буфера ещё можно сделать клип.' : '' });
  } else if (hadVideo) {
    status.set({ recState: 'idle', recMessage: 'Стрим закончился или прервался. Из буфера ещё можно сделать клип.' });
  } else {
    const why = lastErrors.length ? lastErrors[lastErrors.length - 1] : 'Не удалось получить видео.';
    status.set({ recState: 'error', recMessage: 'Не получилось начать запись. ' + why });
  }
}

// Кусочки, которые входят в последние 6 минут (самые новые — в конце).
function readPlaylist() {
  const all = readAllSegments();
  let total = 0;
  let i = all.length;
  while (i > 0 && total + all[i - 1].duration <= BUFFER_SECONDS + 0.5) total += all[--i].duration;
  return all.slice(i);
}

// Все кусочки из плейлиста ffmpeg (включая уже удалённые старые).
function readAllSegments() {
  let text;
  try {
    text = fs.readFileSync(PLAYLIST, 'utf8');
  } catch {
    return [];
  }
  const segments = [];
  let duration = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8));
    } else if (line && !line.startsWith('#') && duration !== null) {
      segments.push({ file: path.join(BUFFER_DIR, path.basename(line)), duration });
      duration = null;
    }
  }
  return segments;
}

// Те же кусочки, но с временем начала и конца (мс). Самые новые — в конце.
function readTimeline() {
  const out = [];
  for (const seg of readPlaylist()) {
    const end = segEndTimes.get(path.basename(seg.file));
    if (end) out.push({ ...seg, start: end - seg.duration * 1000, end });
  }
  return out;
}

function pollBuffer() {
  pruneOld();
  const now = Date.now();
  for (const seg of readAllSegments()) {
    const name = path.basename(seg.file);
    if (!segEndTimes.has(name)) segEndTimes.set(name, now);
  }
  const segs = readPlaylist();
  const total = Math.min(BUFFER_SECONDS, segs.reduce((s, x) => s + x.duration, 0));
  const patch = {};
  if (Math.round(total) !== status.get().bufferSeconds) patch.bufferSeconds = Math.round(total);
  if (status.get().recState === 'starting' && segs.length > 0) patch.recState = 'recording';
  if (Object.keys(patch).length) status.set(patch);
}

// Удалить с диска кусочки старше 6 минут (+ небольшой запас).
function pruneOld() {
  const all = readAllSegments();
  let kept = 0;
  let firstToKeep = all.length;
  while (firstToKeep > 0 && kept < BUFFER_SECONDS + KEEP_EXTRA_SECONDS) kept += all[--firstToKeep].duration;
  for (; prunedCount < firstToKeep; prunedCount++) {
    fs.rmSync(all[prunedCount].file, { force: true });
    segEndTimes.delete(path.basename(all[prunedCount].file));
  }
}

module.exports = {
  start, stop, onStop, onStreamInfo, getStreamInfo, isRunning,
  readPlaylist, readTimeline, BUFFER_DIR, BUFFER_SECONDS,
};
