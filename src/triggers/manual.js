// Ручной триггер: кнопка «Клип» на странице или горячая клавиша (Пробел / C).
// Сам ничего не слушает — сервер вызывает fire(), когда пришёл запрос со страницы.

let ctx = null;

module.exports = {
  name: 'manual',

  start(context) {
    ctx = context;
  },

  stop() {
    // ничего не нужно: буфер после остановки ещё доступен
  },

  fire({ seconds, format } = {}) {
    if (!ctx) throw new Error('Триггер не инициализирован.');
    return ctx.requestClip({ seconds, format, source: 'manual' });
  },
};
