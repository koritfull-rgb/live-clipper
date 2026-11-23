// Чтение чата YouTube без входа в аккаунт.
// Используем тот же внутренний механизм, что и страница «Чат» на YouTube (не официальный API,
// поэтому если YouTube что-то поменяет — чат может перестать читаться; запись при этом продолжит работать).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1; SOCS=CAI', // без этого в Европе YouTube показывает страницу согласия
};

function isYoutube(url) {
  return /(^|\.)youtube\.com|youtu\.be/i.test(url || '');
}

// Текст сообщения из «runs» (обычный текст + эмодзи).
function runsToText(runs) {
  return (runs || []).map((r) => {
    if (r.text) return r.text;
    if (r.emoji) return r.emoji.isCustomEmoji ? (r.emoji.shortcuts || [''])[0] : (r.emoji.emojiId || '');
    return '';
  }).join('');
}

function pickContinuation(list) {
  const c = (list || [])[0] || {};
  const d = c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData || {};
  return { continuation: d.continuation, timeoutMs: d.timeoutMs };
}

// onMessage({ time, text }), onState('connecting' | 'connected' | 'unavailable', detail)
function connect(videoId, { onMessage, onState }) {
  let closed = false;
  let timer = null;
  let apiKey = null;
  let clientVersion = null;
  let continuation = null;
  let failures = 0;

  async function init() {
    onState('connecting');
    const res = await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`, { headers: HEADERS });
    const html = await res.text();
    apiKey = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
    clientVersion = (/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1]
      || (/"clientVersion":"([^"]+)"/.exec(html) || [])[1];
    continuation = (/"continuation":"([^"]+)"/.exec(html) || [])[1];
    if (!apiKey || !continuation) throw new Error('чат этого стрима недоступен');
    onState('connected');
  }

  async function poll() {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}&prettyPrint=false`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } }, continuation }),
    });
    if (!res.ok) throw new Error('YouTube ответил ' + res.status);
    const data = await res.json();
    const live = data.continuationContents && data.continuationContents.liveChatContinuation;
    if (!live) throw new Error('чат закончился');
    for (const a of live.actions || []) {
      const item = a.addChatItemAction && a.addChatItemAction.item;
      const r = item && (item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer);
      if (!r) continue;
      const time = r.timestampUsec ? Math.round(Number(r.timestampUsec) / 1000) : Date.now();
      onMessage({ time, text: runsToText(r.message && r.message.runs) });
    }
    const next = pickContinuation(live.continuations);
    if (!next.continuation) throw new Error('чат закончился');
    continuation = next.continuation;
    return Math.min(Math.max(Number(next.timeoutMs) || 2000, 1000), 5000);
  }

  async function loop() {
    if (closed) return;
    let delay = 2000;
    try {
      if (!continuation) await init();
      delay = await poll();
      failures = 0;
    } catch (err) {
      failures++;
      continuation = null; // начнём заново
      if (failures >= 3) onState('unavailable', err.message);
      delay = Math.min(30000, 2000 * failures);
    }
    if (!closed) timer = setTimeout(loop, delay);
  }

  loop();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { isYoutube, connect };
