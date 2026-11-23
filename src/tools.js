// Встроенные инструменты: ffmpeg и yt-dlp.
//
// ffmpeg берётся из папки bin/ программы.
// yt-dlp при первом запуске копируется в %APPDATA%\Live Clipper\tools и при каждом старте
// программы тихо обновляет сам себя — YouTube и Twitch часто меняются, а старый yt-dlp перестаёт работать.
// Если встроенных файлов нет (запуск из проекта без bin/), используются ffmpeg и yt-dlp из PATH.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { BIN_DIR, TOOLS_DIR } = require('./paths');

const bundledFfmpeg = path.join(BIN_DIR, 'ffmpeg.exe');
const bundledYtdlp = path.join(BIN_DIR, 'yt-dlp.exe');
const userYtdlp = path.join(TOOLS_DIR, 'yt-dlp.exe');

const UPDATE_TIMEOUT_MS = 60 * 1000;

let ready = Promise.resolve();

function ffmpeg() {
  return fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg';
}

function ytdlp() {
  if (fs.existsSync(userYtdlp)) return userYtdlp;
  if (fs.existsSync(bundledYtdlp)) return bundledYtdlp;
  return 'yt-dlp';
}

// Вызывается один раз при старте программы.
function prepare() {
  if (!fs.existsSync(bundledYtdlp)) return; // нечего обновлять — работаем с yt-dlp из PATH
  try {
    if (!fs.existsSync(userYtdlp)) {
      fs.mkdirSync(TOOLS_DIR, { recursive: true });
      fs.copyFileSync(bundledYtdlp, userYtdlp);
    }
  } catch (err) {
    console.warn('Не удалось скопировать yt-dlp:', err.message);
    return;
  }
  ready = updateYtdlp();
}

function updateYtdlp() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(userYtdlp, ['-U'], { windowsHide: true });
    const timer = setTimeout(() => p.kill(), UPDATE_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(); });
    p.on('close', () => {
      clearTimeout(timer);
      const last = out.trim().split(/\r?\n/).pop();
      if (last) console.log('yt-dlp:', last);
      resolve();
    });
  });
}

// Дождаться, пока закончится обновление yt-dlp (обычно пара секунд).
function whenReady() {
  return ready;
}

module.exports = { ffmpeg, ytdlp, prepare, whenReady };
