// Реакции чата: смех, шок, «клипай!». Сообщение с реакцией весит больше обычного.
// Чтобы добавить реакцию — допиши строку в WORDS или правило в PATTERNS.

// Отдельные слова/эмоуты (сравниваются целиком, без учёта регистра).
const WORDS = {
  // смех
  KEKW: 'KEKW', KEKL: 'KEKW', KEK: 'KEKW', KEKWAIT: 'KEKW',
  LUL: 'LUL', LULW: 'LUL', OMEGALUL: 'OMEGALUL', LMAO: 'LMAO', LMFAO: 'LMAO', LOL: 'LOL',
  ICANT: 'ICANT', PEPELAUGH: 'pepeLaugh', XDD: 'xdd', XD: 'xD', ROFL: 'LOL', HAHA: 'хаха',
  // восторг / шок
  POG: 'Pog', POGGERS: 'Pog', POGCHAMP: 'Pog', POGU: 'Pog', POGO: 'Pog', SHEESH: 'Sheesh',
  OMG: 'OMG', OMEGAPOG: 'Pog', MONKAS: 'monkaS', MONKAW: 'monkaS', WTF: 'WTF', NOWAY: 'no way',
  W: 'W', WW: 'W', WWW: 'W', WWWW: 'W', L: 'L',
  // просьба клипнуть
  CLIP: 'clip', CLIPIT: 'clip', CLIPPED: 'clip', CLIPPING: 'clip',
};

// Фразы и шаблоны внутри сообщения.
const PATTERNS = [
  [/\bno\s*way\b/i, 'no way'],
  [/\bclip\s*(it|that|this)\b/i, 'clip'],
  [/\?{3,}/, '???'],
  [/!{3,}/, '!!!'],
  [/\b(ha){3,}|\b(ah){3,}|(ха){3,}|(ах){3,}/i, 'хаха'], // для кириллицы \b в JS не работает
  [/😂|🤣/u, '😂'],
  [/💀|☠️/u, '💀'],
  [/😭/u, '😭'],
  [/😱|😳|🤯/u, '😱'],
  [/🔥/u, '🔥'],
];

// Возвращает название реакции (например «KEKW») или null.
function detect(text) {
  if (!text) return null;
  for (const [re, label] of PATTERNS) if (re.test(text)) return label;
  const words = text.split(/\s+/).slice(0, 12);
  for (const w of words) {
    const key = w.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
    if (!key) continue;
    // одиночные «W»/«L» считаем только если сообщение короткое — иначе это просто буква в тексте
    if ((key === 'W' || key === 'L' || /^W+$/.test(key)) && words.length > 3) continue;
    if (/^W{2,}$/.test(key)) return 'W';
    if (WORDS[key]) return WORDS[key];
  }
  return null;
}

module.exports = { detect };
