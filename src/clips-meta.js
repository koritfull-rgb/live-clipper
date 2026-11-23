// Пометки к клипам: какой клип сделан автоматически и почему («чат ×4, KEKW»).
// Хранятся в %APPDATA%\Live Clipper\clips-meta.json, ключ — имя файла клипа.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'clips-meta.json');
const MAX_ENTRIES = 2000;

let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

function set(name, meta) {
  data[name] = { ...meta, savedAt: Date.now() };
  const keys = Object.keys(data);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => data[a].savedAt - data[b].savedAt);
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete data[k];
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 1), 'utf8');
  } catch (err) {
    console.warn('Не удалось сохранить пометки клипов:', err.message);
  }
}

function get(name) {
  return data[name] || null;
}

module.exports = { set, get };
