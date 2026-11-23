// Нарезка клипа из буфера.
// Шаг 1 (snapshot): сразу копируем нужные кусочки во временную папку — чтобы клип был
//                   именно из того момента, когда нажали кнопку, и кусочки не успели удалиться.
// Шаг 2 (render):   склеиваем, отрезаем ровно N секунд и, если надо, делаем 9:16 с размытым фоном.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const recorder = require('./recorder');
const tools = require('./tools');
const { TMP_DIR } = require('./paths');

let activeProc = null; // ffmpeg, который сейчас режет клип (чтобы закрыть его при выходе)

// Вертикальное видео 1080×1920: снизу размытая растянутая копия, сверху — оригинал по ширине.
const VERTICAL_FILTER = [
  '[0:v]split=2[bgsrc][fgsrc]',
  '[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,setsar=1[bg]',
  '[fgsrc]scale=1080:-2,setsar=1[fg]',
  '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]',
].join(';');

let jobCounter = 0;

// Шаг 1. Возвращает «снимок» буфера или бросает ошибку.
function snapshot(seconds) {
  const all = recorder.readPlaylist();
  if (all.length === 0) throw new Error('Буфер пуст. Сначала начни запись и подожди несколько секунд.');

  // Берём кусочки с конца, пока не наберём нужную длину.
  const picked = [];
  let total = 0;
  for (let i = all.length - 1; i >= 0 && total < seconds; i--) {
    picked.unshift(all[i]);
    total += all[i].duration;
  }

  const snap = copySegments(picked);
  const actual = Math.min(seconds, snap.copiedTotal);
  return {
    ...snap,
    seconds: actual,
    offset: Math.max(0, snap.copiedTotal - seconds),
    short: snap.copiedTotal < seconds - 1, // в буфере было меньше, чем просили
  };
}

// Шаг 1 для авто-клипов: отрезок по времени [from, to] (мс).
function snapshotRange(from, to) {
  const timeline = recorder.readTimeline();
  const picked = timeline.filter((s) => s.end > from && s.start < to);
  if (picked.length === 0) throw new Error('Этого момента уже нет в буфере.');
  const snap = copySegments(picked);
  const first = snap.firstStart;
  const offset = Math.max(0, (from - first) / 1000);
  const seconds = Math.max(1, Math.min(snap.copiedTotal - offset, (to - Math.max(from, first)) / 1000));
  return { ...snap, offset, seconds, short: false };
}

// Скопировать кусочки во временную папку и составить список для склейки.
function copySegments(picked) {
  const dir = path.join(TMP_DIR, `job_${Date.now()}_${++jobCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  let copiedTotal = 0;
  let firstStart = null;
  for (const seg of picked) {
    const dest = path.join(dir, path.basename(seg.file));
    try {
      fs.copyFileSync(seg.file, dest);
      files.push(dest);
      copiedTotal += seg.duration;
      if (firstStart === null) firstStart = seg.start;
    } catch {
      // самый старый кусочек могли удалить в эту же секунду — просто пропускаем
    }
  }
  if (files.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Не удалось прочитать буфер. Попробуй ещё раз.');
  }

  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

  return { dir, listFile, copiedTotal, firstStart, createdAt: new Date() };
}

function makeFileName(snap, format) {
  const d = snap.createdAt;
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const auto = snap.auto ? '_auto' : '';
  return `clip_${stamp}${auto}_${Math.round(snap.seconds)}s_${format === 'vertical' ? '9x16' : 'orig'}.mp4`;
}

// Шаг 2. onProgress(0..100). Возвращает имя готового файла.
function render(snap, { format, clipsDir }, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const name = makeFileName(snap, format);
    const out = path.join(clipsDir, name);
    const partial = out + '.part.mp4';

    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', snap.listFile,
      '-ss', snap.offset.toFixed(3),
      '-t', snap.seconds.toFixed(3),
    ];
    if (format === 'vertical') {
      args.push('-filter_complex', VERTICAL_FILTER, '-map', '[v]');
    } else {
      args.push('-map', '0:v:0', '-vf', 'format=yuv420p');
    }
    args.push(
      '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      partial,
    );

    const ff = spawn(tools.ffmpeg(), args, { windowsHide: true });
    activeProc = ff;
    let errText = '';
    ff.stderr.on('data', (d) => { errText += d.toString(); });
    ff.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / snap.seconds) * 100)));
    });
    ff.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? 'Не найден ffmpeg.' : err.message)));
    ff.on('close', (code) => {
      activeProc = null;
      fs.rmSync(snap.dir, { recursive: true, force: true });
      if (code !== 0) {
        fs.rmSync(partial, { force: true });
        const last = errText.trim().split(/\r?\n/).pop() || `код ${code}`;
        return reject(new Error('ffmpeg не смог сделать клип: ' + last));
      }
      fs.renameSync(partial, out);
      onProgress(100);
      resolve(name);
    });
  });
}

function cleanupTmp() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

// Прервать нарезку (при закрытии программы).
function abort() {
  if (activeProc) activeProc.kill();
}

module.exports = { snapshot, snapshotRange, render, cleanupTmp, abort };
