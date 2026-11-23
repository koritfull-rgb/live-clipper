// Онбординг-тур: стрелка-подсказка по очереди показывает каждую кнопку.
// Клик в любом месте — следующий шаг. «Пропустить» или Esc — закончить.
// При первом открытии запускается сам; кнопка «?» запускает снова.

(function () {
  const STORAGE_KEY = 'liveclipper.tourDone';

  const STEPS = [
    { target: 'url', title: 'Ссылка на стрим', text: 'Вставь сюда ссылку на живой стрим с Twitch или YouTube.' },
    { target: 'record', title: 'Начать запись', text: 'Запускает запись в фоне. Программа всегда держит в памяти последние 6 минут. Нажми ещё раз, чтобы остановить.' },
    { target: 'buffer', title: 'Буфер', text: 'Показывает, сколько стрима уже накоплено. Больше 6 минут не хранится — старое удаляется само.' },
    { target: 'length', title: 'Длина клипа', text: 'Сколько последних секунд сохранить: 30 сек, 1, 2 или 5 минут.' },
    { target: 'format', title: 'Формат', text: '9:16 — вертикальное видео для TikTok/Shorts/Reels с размытым фоном. «Оригинал» — как на стриме.' },
    { target: 'auto', title: 'Авто-клипы', text: 'Программа сама следит за чатом стрима: когда чат бурно реагирует (сообщений в ~3 раза больше обычного, KEKW, 😂, «no way»…), она сама делает клип — 20 сек до реакции и 10 после. Крик или смех стримера усиливают сигнал. Чувствительность: чем выше, тем чаще срабатывает.' },
    { target: 'clip', title: 'Клип', text: 'Сохраняет последние N секунд стрима в папку с клипами.' },
    { target: 'hotkey', title: 'Горячая клавиша', text: 'Пробел или C — то же самое, что кнопка «Клип». Работает, когда окно Live Clipper активно и курсор не стоит в поле ввода.' },
    // Шаг про папку: если папка ещё не выбрана — показываем карточку с плюсом, иначе — путь и «Сменить».
    { target: 'folder', title: 'Папка для клипов', text: 'Нажми, чтобы выбрать папку на компьютере, куда будут сохраняться клипы. Пока папка не выбрана, кнопка «Клип» не работает.' },
    { target: 'folder-line', title: 'Папка для клипов', text: 'Сюда сохраняются клипы. «Сменить» — выбрать другую папку, «Открыть» — открыть её в проводнике.' },
    { target: 'status', title: 'Статус', text: 'Здесь видно, что происходит: «Идёт запись», «Режу клип…», «Готово».' },
    { target: 'gallery', title: 'Галерея', text: 'Все готовые клипы из выбранной папки. Нажми на любой, чтобы посмотреть прямо здесь.' },
    { target: 'help', title: 'Подсказки', text: 'Нажми «?», чтобы снова пройти этот тур.' },
  ];

  let index = -1;
  let els = null;
  let steps = []; // шаги, чьи элементы сейчас видны на странице

  function build() {
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const bubble = document.createElement('div');
    bubble.className = 'tour-bubble';
    bubble.innerHTML = `
      <div class="tour-arrow"></div>
      <h4></h4>
      <p></p>
      <div class="tour-foot">
        <span class="tour-count"></span>
        <button class="tour-skip" type="button">Пропустить</button>
        <button class="btn btn-primary tour-next" type="button">Далее</button>
      </div>`;
    overlay.addEventListener('click', next);
    bubble.addEventListener('click', (e) => {
      if (e.target.closest('.tour-skip')) return finish();
      next();
    });
    document.body.append(overlay, spot, bubble);
    return { overlay, spot, bubble };
  }

  function start() {
    if (els) finish(false);
    document.activeElement && document.activeElement.blur();
    steps = STEPS.filter((s) => findTarget(s));
    if (steps.length === 0) return;
    els = build();
    index = -1;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('keydown', onKey, true);
    next();
  }

  function next() {
    index++;
    // пропускаем шаги, чей элемент успел исчезнуть
    while (index < steps.length && !findTarget(steps[index])) index++;
    if (index >= steps.length) return finish();
    const step = steps[index];
    const b = els.bubble;
    b.querySelector('h4').textContent = step.title;
    b.querySelector('p').textContent = step.text;
    b.querySelector('.tour-count').textContent = `${index + 1} из ${steps.length}`;
    b.querySelector('.tour-next').textContent = index === steps.length - 1 ? 'Готово' : 'Далее';
    findTarget(step).scrollIntoView({ block: 'center', behavior: 'smooth' });
    place();
    setTimeout(place, 350); // после плавной прокрутки
  }

  // Элемент шага, если он есть и виден (у скрытых элементов нет размеров на странице).
  function findTarget(step) {
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    return el && el.getClientRects().length > 0 ? el : null;
  }

  function place() {
    if (!els || index < 0 || index >= steps.length) return;
    const el = findTarget(steps[index]);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    Object.assign(els.spot.style, {
      top: `${r.top - pad}px`,
      left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });

    const b = els.bubble;
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const gap = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const below = r.bottom + pad + gap + bh <= vh || r.top - pad - gap - bh < 0;
    const top = below ? r.bottom + pad + gap : r.top - pad - gap - bh;
    const centerX = r.left + r.width / 2;
    const left = Math.max(12, Math.min(vw - bw - 12, centerX - bw / 2));

    b.dataset.side = below ? 'below' : 'above';
    b.style.top = `${Math.max(12, top)}px`;
    b.style.left = `${left}px`;
    const arrow = b.querySelector('.tour-arrow');
    arrow.style.left = `${Math.max(14, Math.min(bw - 28, centerX - left - 7))}px`;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'Enter' || e.key === 'ArrowRight' || e.code === 'Space') { e.preventDefault(); next(); }
    e.stopPropagation(); // пока идёт тур, горячие клавиши приложения не срабатывают
  }

  function finish(markDone = true) {
    if (!els) return;
    els.overlay.remove();
    els.spot.remove();
    els.bubble.remove();
    els = null;
    index = -1;
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKey, true);
    if (markDone) {
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
    }
  }

  function isDone() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  }

  window.Tour = {
    start,
    get active() { return Boolean(els); },
    startIfFirstTime() { if (!isDone()) start(); },
  };
})();
