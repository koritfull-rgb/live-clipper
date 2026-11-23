// Громкость стримера. ffmpeg записи отдаёт сюда звук (моно, 8000 Гц, 16 бит),
// а мы каждые полсекунды считаем уровень в децибелах и помним последние 3 минуты.
// Скачок = громкость заметно выше обычной (медиана за 2 минуты). Сам по себе клип не делает —
// только усиливает оценку момента, если в это же время взорвался чат.

const SAMPLE_RATE = 8000;
const WINDOW_SAMPLES = SAMPLE_RATE / 2; // 0,5 сек
const KEEP_MS = 3 * 60 * 1000;
const BASELINE_MS = 2 * 60 * 1000;
const SPIKE_DB = 8;       // насколько громче обычного считается «скачком»
const MIN_LOUD_DB = -35;  // совсем тихие места скачком не считаем

let points = [];          // { time, db }
let sumSq = 0;
let count = 0;
let leftover = null;

function reset() {
  points = [];
  sumSq = 0;
  count = 0;
  leftover = null;
}

// Сырые байты звука от ffmpeg.
function feed(chunk) {
  let buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
  const usable = buf.length - (buf.length % 2);
  for (let i = 0; i < usable; i += 2) {
    const s = buf.readInt16LE(i) / 32768;
    sumSq += s * s;
    if (++count === WINDOW_SAMPLES) {
      const rms = Math.sqrt(sumSq / count);
      points.push({ time: Date.now(), db: rms > 0 ? 20 * Math.log10(rms) : -100 });
      sumSq = 0;
      count = 0;
    }
  }
  leftover = usable < buf.length ? buf.subarray(usable) : null;
  const cutoff = Date.now() - KEEP_MS;
  while (points.length && points[0].time < cutoff) points.shift();
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Насколько (в дБ) самый громкий момент в [from, to] выше обычного уровня. null — если данных мало.
function spikeDb(from, to) {
  const base = median(points.filter((p) => p.time < from && p.time >= from - BASELINE_MS).map((p) => p.db));
  if (base === null || points.length < 60) return null;
  const inside = points.filter((p) => p.time >= from && p.time <= to).map((p) => p.db);
  if (!inside.length) return null;
  const peak = Math.max(...inside);
  if (peak < MIN_LOUD_DB) return 0;
  return peak - base;
}

function isSpike(db) {
  return db !== null && db >= SPIKE_DB;
}

module.exports = { feed, reset, spikeDb, isSpike, SAMPLE_RATE };
