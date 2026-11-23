// Чтение чата Twitch без входа в аккаунт.
// Twitch разрешает анонимное подключение к чату под именем «justinfanXXXX» — так чат видит любой зритель.

const URL_RE = /twitch\.tv\/(?:popout\/)?([a-z0-9_]{2,25})/i;

function channelFromUrl(url) {
  const m = URL_RE.exec(url || '');
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (['videos', 'directory', 'settings', 'search'].includes(name)) return null;
  return name;
}

// onMessage({ time, text }), onState('connecting' | 'connected' | 'unavailable', detail)
function connect(channel, { onMessage, onState }) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let retryTimer = null;

  function open() {
    onState('connecting');
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${channel}`);
    });
    ws.addEventListener('message', (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        if (line.includes(' 366 ')) { retry = 0; onState('connected'); continue; } // вошли в канал
        const marker = ` PRIVMSG #${channel} :`;
        const i = line.indexOf(marker);
        if (i !== -1) onMessage({ time: Date.now(), text: line.slice(i + marker.length) });
      }
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      // переподключаемся: 2, 4, 8 … максимум 30 секунд
      retry++;
      onState('connecting');
      retryTimer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry));
    });
    ws.addEventListener('error', () => {});
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      try { ws.close(); } catch {}
    },
  };
}

module.exports = { channelFromUrl, connect };
