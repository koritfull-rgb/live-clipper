// Авто-клипы по реакции чата.
//
// Каждую секунду:
//   • «обычный уровень» = среднее число сообщений в секунду за последние 2 минуты;
//   • «сейчас»          = сообщения за последние 5 секунд;
//   • взрыв             = «сейчас» в N раз больше обычного И сообщений не меньше порога
//                         (порог нужен для маленьких чатов, чтобы не срабатывало от 2–3 сообщений).
// Реакции (KEKW, 😂, «no way»…) и скачок громкости стримера немного снижают нужный множитель.
// Громкость сама по себе клип не делает.
//
// Клип: 20 сек ДО начала взрыва + 10 сек ПОСЛЕ. Если чат взорвался ещё раз, пока клип не вырезан, —
// клип удлиняется (до 60 сек). Следующий авто-клип — не раньше чем через 45 сек.

const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const status = require('../status');
const reactions = require('../chat/reactions');
const twitch = require('../chat/twitch');
const youtube = require('../chat/youtube');
const { DATA_DIR } = require('../paths');

const SENSITIVITY = {
  low:    { mult: 4.0, minMsgs: 12 },
  medium: { mult: 3.0, minMsgs: 8 },
  high:   { mult: 2.2, minMsgs: 5 },
};

const WINDOW_S = 5;            // «сейчас» — последние 5 секунд
const BASELINE_S = 120;        // «обычный уровень» — последние 2 минуты
const WARMUP_S = 60;           // первую минуту только слушаем, чтобы понять обычный уровень
const BASELINE_FLOOR = 0.3;    // сообщ/сек — ниже не опускаем, иначе в пустом чате любое сообщение = «взрыв»
const QUIET_TO_END_S = 3;      // взрыв закончился, если 3 секунды подряд нет превышения
const BEFORE_MS = 20000;
const AFTER_MS = 10000;
const MAX_CLIP_MS = 60000;
const COOLDOWN_MS = 45000;
const GRACE_MS = 15000;         // после «10 сек после» ждём ещё 15 сек — вдруг чат взорвётся снова, тогда удлиним клип
                                // (взрыв замечается с опозданием ~5 сек, поэтому меньше 15 — мало: проверено на живом стриме)
const LOUD_LOOKBACK_MS = 15000; // чат реагирует с опозданием — громкость ищем до 15 сек раньше взрыва
const LOG_FILE = path.join(DATA_DIR, 'auto-log.jsonl');

let ctx = null;
let reader = null;
let tickTimer = null;
let infoHooked = false;

let platform = null;
let chatState = 'off';
let chatDetail = '';
let lagMs = 1000;          // YouTube отдаёт сообщения пачками раз в пару секунд — смотрим чуть «в прошлое»
let bins = new Map();      // секунда → { n, r, labels: Map }
let firstSec = null;
let burst = null;          // текущий взрыв { start, peakRatio, labels, loudDb, quiet }
let pending = null;        // клип, который ждёт, пока в буфер допишутся «10 сек после»
let cooldownUntil = 0;
let lastClipTo = 0;

// ---------------- приём сообщений ----------------

function onMessage({ time, text }) {
  const sec = Math.floor(time / 1000);
  if (firstSec === null) firstSec = sec;
  let b = bins.get(sec);
  if (!b) { b = { n: 0, r: 0, labels: new Map() }; bins.set(sec, b); }
  b.n++;
  const label = reactions.detect(text);
  if (label) {
    b.r++;
    b.labels.set(label, (b.labels.get(label) || 0) + 1);
  }
}

function onState(state, detail = '') {
  chatState = state;
  chatDetail = detail;
  pushStatus();
}

function connectChat(info) {
  if (reader) return;
  const url = info.url || '';
  const site = info.site || '';
  if (site.includes('twitch') || twitch.channelFromUrl(url)) {
    const channel = twitch.channelFromUrl(url);
    if (!channel) return onState('unavailable', 'не удалось понять канал Twitch');
    platform = 'Twitch';
    lagMs = 1000;
    reader = twitch.connect(channel, { onMessage, onState });
  } else if (site.includes('youtube') || youtube.isYoutube(url)) {
    if (!info.id) return; // id стрима узнаем после запуска yt-dlp
    platform = 'YouTube';
    lagMs = 6000;
    reader = youtube.connect(info.id, { onMessage, onState });
  } else {
    onState('unavailable', 'чат этого сайта не поддерживается');
  }
}

// ---------------- подсчёт ----------------

function sumRange(fromSec, toSec) {
  const out = { n: 0, r: 0, labels: new Map() };
  for (let s = fromSec; s <= toSec; s++) {
    const b = bins.get(s);
    if (!b) continue;
    out.n += b.n;
    out.r += b.r;
    for (const [k, v] of b.labels) out.labels.set(k, (out.labels.get(k) || 0) + v);
  }
  return out;
}

function tick() {
  const now = Date.now();
  const endSec = Math.floor((now - lagMs) / 1000);

  // старые секунды больше не нужны
  for (const s of bins.keys()) if (s < endSec - BASELINE_S - WINDOW_S - 5) bins.delete(s);

  const s = settings.get();
  if (!s.autoClips) {
    burst = null;
    pending = null;
    return pushStatus();
  }

  if (pending) maybeCut(now);

  if (chatState !== 'connected' || firstSec === null) return pushStatus();
  const elapsed = endSec - firstSec;
  if (elapsed < WARMUP_S) return pushStatus(Math.max(0, WARMUP_S - elapsed));

  const cfg = SENSITIVITY[s.sensitivity] || SENSITIVITY.medium;
  const winFrom = endSec - WINDOW_S + 1;
  const cur = sumRange(winFrom, endSec);
  const baseSecs = Math.min(BASELINE_S, winFrom - firstSec);
  const base = sumRange(winFrom - baseSecs, winFrom - 1);
  const baseline = Math.max(BASELINE_FLOOR, base.n / Math.max(1, baseSecs));
  const ratio = cur.n / WINDOW_S / baseline;
  const reactShare = cur.n ? cur.r / cur.n : 0;

  const burstStartGuess = findBurstStart(winFrom, endSec, baseline);
  const loudDb = ctx.loudness.spikeDb(burstStartGuess - LOUD_LOOKBACK_MS, burstStartGuess + 2000);
  const loud = ctx.loudness.isSpike(loudDb);

  // реакции снижают нужный множитель до 20%, громкость — ещё на 10%
  const need = cfg.mult * (1 - 0.2 * Math.min(1, reactShare / 0.5)) * (loud ? 0.9 : 1);
  const firing = cur.n >= cfg.minMsgs && ratio >= need;

  if (firing) {
    if (!burst) {
      burst = { start: burstStartGuess, peakRatio: ratio, labels: cur.labels, loudDb, reactShare, msgs: cur.n, baseline, need };
      onBurst(burst, now);
    } else {
      burst.quiet = 0;
      if (ratio > burst.peakRatio) Object.assign(burst, { peakRatio: ratio, labels: cur.labels, msgs: cur.n, reactShare });
      if (loud) burst.loudDb = Math.max(burst.loudDb || 0, loudDb);
      if (pending && pending.bursts.includes(burst)) {
        // чат всё ещё бушует — клип захватывает и продолжение (но не длиннее 60 сек)
        pending.to = Math.min(pending.from + MAX_CLIP_MS, Math.max(pending.to, endSec * 1000 + 5000));
        refreshPending();
      }
    }
  } else if (burst && ++burst.quiet >= QUIET_TO_END_S) {
    burst = null;
  }

  pushStatus(0, { baseline, ratio });
}

// Начало взрыва: первая секунда окна, где сообщений заметно больше обычного.
function findBurstStart(fromSec, toSec, baseline) {
  for (let sec = fromSec; sec <= toSec; sec++) {
    const b = bins.get(sec);
    if (b && b.n >= baseline * 1.5) return sec * 1000;
  }
  return fromSec * 1000;
}

// ---------------- взрывы → клипы ----------------

function onBurst(b, now) {
  b.quiet = 0;
  if (pending && b.start < pending.from + MAX_CLIP_MS - 5000) {
    // ещё один взрыв, пока клип не вырезан — удлиняем клип (не больше 60 сек)
    pending.bursts.push(b);
    pending.to = Math.min(pending.from + MAX_CLIP_MS, Math.max(pending.to, b.start + AFTER_MS));
    refreshPending();
    log({ event: 'merged', ...describe(b) });
    return;
  }
  if (pending || now < cooldownUntil) {
    log({ event: 'skipped', why: 'пауза 45 сек между авто-клипами', ...describe(b) });
    return;
  }
  pending = {
    from: Math.max(b.start - BEFORE_MS, lastClipTo),
    to: b.start + AFTER_MS,
    bursts: [b],
    createdAt: now,
  };
  refreshPending();
  log({ event: 'burst', ...describe(b) });
}

function refreshPending() {
  const bs = pending.bursts;
  const peak = Math.max(...bs.map((b) => b.peakRatio));
  const labels = new Map();
  for (const b of bs) for (const [k, v] of b.labels) labels.set(k, (labels.get(k) || 0) + v);
  const loud = bs.some((b) => ctx.loudness.isSpike(b.loudDb));
  pending.reason = makeReason(peak, labels, loud, bs.length);
}

function makeReason(ratio, labels, loud, count) {
  const x = ratio >= 3 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
  const word = count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'взрыва' : 'взрывов';
  const parts = [`чат ×${String(x).replace('.', ',')}${count > 1 ? ` (${count} ${word})` : ''}`];
  const top = [...labels.entries()].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  parts.push(...top);
  if (loud) parts.push('громко');
  return parts.join(', ');
}

// Режем, когда прошло «10 сек после» + небольшое ожидание и эти секунды дописались в буфер.
function maybeCut(now, force = false) {
  const timeline = ctx.recorder.readTimeline();
  const lastEnd = timeline.length ? timeline[timeline.length - 1].end : 0;
  const ready = lastEnd >= pending.to || now > pending.to + GRACE_MS + 20000;
  const maxed = pending.to - pending.from >= MAX_CLIP_MS; // длиннее уже не станет — можно не ждать
  if (!force && (now < pending.to + (maxed ? 0 : GRACE_MS) || !ready)) return;

  const p = pending;
  pending = null;
  cooldownUntil = p.bursts[0].start + COOLDOWN_MS;
  lastClipTo = p.to;
  try {
    const r = ctx.requestClipRange({ from: p.from, to: Math.min(p.to, lastEnd || p.to), format: settings.get().format, source: 'auto', reason: p.reason });
    log({ event: 'clip', reason: p.reason, seconds: r.seconds, bursts: p.bursts.length });
  } catch (err) {
    log({ event: 'clip-failed', reason: p.reason, error: err.message });
    status.set({ clipMessage: 'Авто-клип не получился: ' + err.message });
  }
}

// ---------------- статус и журнал ----------------

function describe(b) {
  return {
    at: new Date(b.start).toISOString(),
    ratio: Math.round(b.peakRatio * 10) / 10,
    msgs5s: b.msgs,
    baselinePerSec: Math.round(b.baseline * 100) / 100,
    need: Math.round(b.need * 100) / 100,
    reactShare: Math.round(b.reactShare * 100) / 100,
    reactions: Object.fromEntries(b.labels),
    loudDb: b.loudDb === null || b.loudDb === undefined ? null : Math.round(b.loudDb * 10) / 10,
  };
}

function log(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
  status.emit('auto', entry);
}

function roundOrNull(v) {
  return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}

let lastStatusAt = 0;
function pushStatus(warmupLeft = 0, extra = {}) {
  const now = Date.now();
  if (now - lastStatusAt < 2000 && !extra.force) return;
  lastStatusAt = now;
  const perMin = sumRange(Math.floor((now - lagMs) / 1000) - 59, Math.floor((now - lagMs) / 1000)).n;
  status.set({
    chat: {
      state: chatState,
      detail: chatDetail,
      platform,
      perMin,
      warmupLeft,
      ratio: extra.ratio ? Math.round(extra.ratio * 10) / 10 : null,
      loudDb: ctx ? roundOrNull(ctx.loudness.spikeDb(now - 3000, now)) : null, // громче обычного на N дБ
      waitingClip: Boolean(pending),
    },
  });
}

// ---------------- триггер ----------------

module.exports = {
  name: 'chat',

  start(context) {
    this.stop();
    ctx = context;
    bins = new Map();
    firstSec = null;
    burst = null;
    pending = null;
    cooldownUntil = 0;
    lastClipTo = 0;
    platform = null;
    chatState = 'connecting';
    chatDetail = '';
    if (!infoHooked) {
      infoHooked = true;
      ctx.recorder.onStreamInfo((info) => { if (ctx && tickTimer) connectChat(info); });
    }
    const url = (ctx.recorder.getStreamInfo() || {}).url || status.get().url;
    connectChat({ url }); // Twitch подключаем сразу по ссылке, YouTube — когда yt-dlp узнает id стрима
    tickTimer = setInterval(tick, 1000);
    pushStatus(0, { force: true });
  },

  stop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (reader) reader.close();
    reader = null;
    if (pending && ctx) maybeCut(Date.now(), true); // запись остановили — режем то, что успели
    chatState = 'off';
    pushStatus(0, { force: true });
  },
};
