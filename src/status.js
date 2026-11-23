// Общее состояние программы + рассылка его на страницу в реальном времени (Server-Sent Events).
// Любой модуль вызывает status.set({...}), и все открытые вкладки сразу видят изменения.

const clients = new Set();

const state = {
  recState: 'idle',      // idle | starting | recording | error
  recMessage: '',
  url: '',
  bufferSeconds: 0,      // сколько секунд сейчас лежит в буфере
  bufferMax: 360,
  clipState: 'idle',     // idle | cutting | done | error
  clipMessage: '',
  clipProgress: 0,       // 0..100
  queue: 0,              // сколько клипов ждут своей очереди
  lastClip: null,        // имя последнего готового файла
};

function get() {
  return { ...state };
}

function set(patch) {
  Object.assign(state, patch);
  broadcast('status', state);
}

// Отдельные события (например, «появился новый клип») — чтобы страница обновила галерею.
function emit(event, data) {
  broadcast(event, data);
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// Подключение страницы к потоку событий.
function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: status\ndata: ${JSON.stringify(state)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

module.exports = { get, set, emit, attach };
