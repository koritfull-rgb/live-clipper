// Чтение и сохранение настроек в settings.json.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, SETTINGS_FILE } = require('./paths');

const DEFAULTS = {
  clipsDir: null,         // папку выбирает пользователь; пока не выбрана — клипы делать нельзя
  clipSeconds: 60,        // 30 | 60 | 120 | 300
  format: 'vertical',     // vertical | original
  autoClips: true,        // авто-клипы по реакции чата
  sensitivity: 'medium',  // low | medium | high
};

const ALLOWED_SECONDS = [30, 60, 120, 300];
const ALLOWED_FORMATS = ['vertical', 'original'];
const ALLOWED_SENSITIVITY = ['low', 'medium', 'high'];

let current = load();

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    // файла ещё нет или он повреждён — берём значения по умолчанию
  }
  const s = { ...DEFAULTS, ...data };
  delete s.port; // осталось от версии 0.1
  if (s.clipsDir) {
    try {
      fs.mkdirSync(s.clipsDir, { recursive: true });
    } catch {
      s.clipsDir = null; // папка пропала (например, вынули флешку) — попросим выбрать заново
    }
  }
  return s;
}

function save(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function get() {
  return { ...current };
}

// Обновить настройки. Бросает ошибку с понятным текстом, если что-то не так.
function update(patch) {
  const next = { ...current };

  if (patch.clipsDir !== undefined) {
    const dir = String(patch.clipsDir || '').trim();
    if (!dir) throw new Error('Выбери папку для клипов.');
    if (!path.isAbsolute(dir)) throw new Error('Нужен полный путь к папке, например C:\\Users\\Имя\\Videos\\Clips');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new Error('В эту папку нельзя сохранять файлы: ' + dir);
    }
    next.clipsDir = path.resolve(dir);
  }

  if (patch.clipSeconds !== undefined) {
    const n = Number(patch.clipSeconds);
    if (!ALLOWED_SECONDS.includes(n)) throw new Error('Недопустимая длина клипа.');
    next.clipSeconds = n;
  }

  if (patch.format !== undefined) {
    if (!ALLOWED_FORMATS.includes(patch.format)) throw new Error('Недопустимый формат.');
    next.format = patch.format;
  }

  if (patch.autoClips !== undefined) {
    next.autoClips = Boolean(patch.autoClips);
  }

  if (patch.sensitivity !== undefined) {
    if (!ALLOWED_SENSITIVITY.includes(patch.sensitivity)) throw new Error('Недопустимая чувствительность.');
    next.sensitivity = patch.sensitivity;
  }

  current = next;
  save(current);
  return get();
}

module.exports = { get, update, ALLOWED_SECONDS, ALLOWED_FORMATS };
