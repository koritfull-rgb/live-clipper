// Где что лежит.
//
// В установленной программе (Electron) пути передаёт electron/main.js через переменные окружения:
//   LIVECLIPPER_DATA — папка для настроек, буфера и временных файлов (%APPDATA%\Live Clipper)
//   LIVECLIPPER_BIN  — папка со встроенными ffmpeg.exe и yt-dlp.exe
// При запуске из папки проекта (node server.js) всё лежит рядом с проектом.

const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.LIVECLIPPER_DATA || ROOT;
const BIN_DIR = process.env.LIVECLIPPER_BIN || path.join(ROOT, 'bin');

module.exports = {
  ROOT,
  DATA_DIR,
  BIN_DIR,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  BUFFER_DIR: path.join(DATA_DIR, 'buffer'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  TOOLS_DIR: path.join(DATA_DIR, 'tools'), // сюда копируется yt-dlp, чтобы он мог сам обновляться
};
