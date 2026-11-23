// Логика страницы: кнопки, статус, галерея, настройки, горячие клавиши.

(function () {
  const $ = (id) => document.getElementById(id);

  const ui = {
    status: $('status'), statusText: $('statusText'),
    url: $('urlInput'), record: $('recordBtn'),
    bufferFill: $('bufferFill'), bufferText: $('bufferText'), recMessage: $('recMessage'),
    lengthGroup: $('lengthGroup'), formatGroup: $('formatGroup'),
    clip: $('clipBtn'), clipWrap: $('clipWrap'), clipProgress: $('clipProgress'), clipProgressFill: $('clipProgressFill'), clipMessage: $('clipMessage'),
    gallery: $('gallery'), galleryEmpty: $('galleryEmpty'), clipCount: $('clipCount'),
    addFolder: $('addFolderCard'), folderLine: $('folderLine'), folderPath: $('folderPath'),
    changeFolder: $('changeFolderBtn'), openFolder: $('openFolderBtn'),
    playerDialog: $('playerDialog'), player: $('player'), playerName: $('playerName'), playerClose: $('playerClose'),
    help: $('helpBtn'), toast: $('toast'),
    autoToggle: $('autoToggle'), sensGroup: $('sensGroup'), chatLine: $('chatLine'),
  };

  let settings = { clipSeconds: 60, format: 'vertical', clipsDir: null, autoClips: true, sensitivity: 'medium' };
  let st = {};
  let doneUntil = 0;
  let doneTimer = null;
  let newClipName = null;

  // ---------- связь с сервером ----------

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('status', (e) => {
      const prev = st;
      const first = !('clipState' in prev); // первое сообщение после загрузки страницы — без уведомлений
      st = JSON.parse(e.data);
      if (!first && st.clipState === 'done' && prev.clipState !== 'done') showDone();
      if (!first && st.clipState === 'error' && prev.clipState !== 'error') toast(st.clipMessage);
      render();
    });
    es.addEventListener('clip', (e) => {
      const data = JSON.parse(e.data);
      newClipName = data.name;
      if (data.source === 'auto') toast('Авто-клип: ' + (data.reason || 'реакция чата'));
      loadClips();
    });
    es.onerror = () => {
      ui.status.dataset.state = 'error';
      ui.statusText.textContent = 'Нет связи с программой';
    };
  }

  // ---------- отрисовка состояния ----------

  function fmtTime(sec) {
    sec = Math.round(sec || 0);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function showDone() {
    doneUntil = Date.now() + 3000;
    clearTimeout(doneTimer);
    doneTimer = setTimeout(render, 3050);
  }

  function render() {
    const recActive = st.recState === 'starting' || st.recState === 'recording';
    const cutting = st.clipState === 'cutting';
    const done = !cutting && Date.now() < doneUntil;

    // статус
    let state = st.recState || 'idle';
    let text = { idle: 'Не записывается', starting: 'Подключаюсь к стриму…', recording: 'Идёт запись', error: 'Ошибка' }[state];
    if (cutting) {
      state = 'cutting';
      text = `Режу клип… ${st.clipProgress || 0}%` + (st.queue ? ` · в очереди ${st.queue}` : '');
    } else if (done) {
      state = 'done';
      text = 'Готово';
    }
    ui.status.dataset.state = state;
    ui.statusText.textContent = text;

    // кнопка записи
    ui.record.textContent = recActive ? 'Остановить' : 'Начать запись';
    ui.record.classList.toggle('btn-primary', !recActive);
    ui.record.classList.toggle('btn-stop', recActive);
    ui.url.disabled = recActive;

    // буфер
    const max = st.bufferMax || 360;
    ui.bufferFill.style.width = `${Math.min(100, ((st.bufferSeconds || 0) / max) * 100)}%`;
    ui.bufferText.textContent = `Буфер: ${fmtTime(st.bufferSeconds)} / ${fmtTime(max)}`;
    showMessage(ui.recMessage, st.recMessage, st.recState === 'error' ? 'error' : '');

    // клип
    const reason = clipBlockReason();
    ui.clip.disabled = Boolean(reason);
    ui.clipWrap.title = reason || `Сохранить последние ${fmtTime(settings.clipSeconds)} (Пробел / C)`;
    ui.clipProgress.hidden = !cutting;
    ui.clipProgressFill.style.width = `${st.clipProgress || 0}%`;
    showMessage(ui.clipMessage, st.clipMessage, st.clipState === 'error' ? 'error' : 'warn');
    renderChat();
  }

  // Строка под переключателем авто-клипов: что сейчас с чатом.
  function renderChat() {
    ui.autoToggle.checked = Boolean(settings.autoClips);
    ui.sensGroup.parentElement.classList.toggle('off', !settings.autoClips);
    const c = st.chat || { state: 'off' };
    const recActive = st.recState === 'starting' || st.recState === 'recording';
    let text = '';
    let kind = '';
    if (!settings.autoClips) {
      text = 'Авто-клипы выключены — работает только кнопка «Клип».';
    } else if (!recActive || c.state === 'off') {
      text = 'Начни запись — программа подключится к чату стрима и будет ловить моменты.';
    } else if (c.state === 'connecting') {
      text = 'Подключаюсь к чату…';
    } else if (c.state === 'unavailable') {
      text = `Чат недоступен (${c.detail || 'неизвестная причина'}) — авто-клипы не работают, кнопка «Клип» работает.`;
      kind = 'bad';
    } else {
      text = `Чат ${c.platform || ''}: ${c.perMin} сообщ/мин`;
      if (c.warmupLeft > 0) text += ` · изучаю обычный уровень чата, ещё ${c.warmupLeft} сек`;
      else if (c.waitingClip) text += ' · чат взорвался, готовлю авто-клип…';
      else text += ' · слежу за реакциями';
      if (!settings.clipsDir) { text += ' · сначала выбери папку для клипов'; kind = 'bad'; } else kind = 'live';
    }
    ui.chatLine.textContent = text;
    ui.chatLine.className = 'chat-line' + (kind ? ' ' + kind : '');
  }

  // Почему сейчас нельзя сделать клип (или пустая строка, если можно).
  function clipBlockReason() {
    if (!settings.clipsDir) return 'Сначала выбери папку для клипов';
    if (!(st.bufferSeconds > 0)) return 'Сначала начни запись';
    return '';
  }

  function showMessage(el, text, kind) {
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'message' + (kind ? ' ' + kind : '');
  }

  function setActive(group, value) {
    for (const b of group.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.value === String(value));
    }
  }

  let toastTimer = null;
  function toast(text) {
    if (!text) return;
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3500);
  }

  // ---------- действия ----------

  async function toggleRecord() {
    const recActive = st.recState === 'starting' || st.recState === 'recording';
    try {
      if (recActive) {
        await api('POST', '/api/record/stop');
      } else {
        const url = ui.url.value.trim();
        if (!url) { ui.url.focus(); return toast('Сначала вставь ссылку на стрим.'); }
        try { localStorage.setItem('liveclipper.lastUrl', url); } catch {}
        await api('POST', '/api/record/start', { url });
      }
    } catch (err) {
      toast(err.message);
    }
  }

  async function makeClip() {
    const reason = clipBlockReason();
    if (reason) return toast(reason + '.');
    ui.clip.classList.remove('flash');
    void ui.clip.offsetWidth;
    ui.clip.classList.add('flash');
    try {
      const r = await api('POST', '/api/clip', { seconds: settings.clipSeconds, format: settings.format });
      if (r.short) toast(`В буфере только ${r.seconds} сек — клип будет короче.`);
      else if (r.queued) toast('Клип добавлен в очередь.');
    } catch (err) {
      toast(err.message);
    }
  }

  async function saveSetting(patch) {
    try {
      settings = await api('POST', '/api/settings', patch);
    } catch (err) {
      toast(err.message);
    }
    setActive(ui.lengthGroup, settings.clipSeconds);
    setActive(ui.formatGroup, settings.format);
    setActive(ui.sensGroup, settings.sensitivity);
    render();
  }

  // ---------- галерея ----------

  async function loadClips() {
    const hasFolder = Boolean(settings.clipsDir);
    ui.addFolder.hidden = hasFolder;
    ui.folderLine.hidden = !hasFolder;
    // \u200E — чтобы путь правильно обрезался слева и «C:\» не прыгал в конец
    ui.folderPath.textContent = hasFolder ? '\u200E' + settings.clipsDir + '\u200E' : '';
    ui.folderPath.title = settings.clipsDir || '';

    let clips = [];
    if (hasFolder) {
      try { clips = await api('GET', '/api/clips'); } catch {}
    }
    ui.gallery.innerHTML = '';
    ui.galleryEmpty.hidden = !hasFolder || clips.length > 0;
    ui.clipCount.textContent = clips.length ? String(clips.length) : '';
    for (const c of clips) ui.gallery.append(clipCard(c));
    newClipName = null;
  }

  function clipCard(c) {
    const vertical = c.name.includes('_9x16');
    const secs = (/_(\d+)s_/.exec(c.name) || [])[1];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'clip-card' + (vertical ? ' vertical' : '') + (c.name === newClipName ? ' new' : '');
    card.title = c.name;

    const thumb = document.createElement('div');
    thumb.className = 'clip-thumb';
    const video = document.createElement('video');
    video.src = `/media/${encodeURIComponent(c.name)}#t=0.5`;
    video.preload = 'metadata';
    video.muted = true;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = (vertical ? '9:16' : 'Оригинал') + (secs ? ` · ${fmtTime(secs)}` : '');
    thumb.append(video, badge);
    if (c.auto) {
      const autoBadge = document.createElement('span');
      autoBadge.className = 'badge badge-auto';
      autoBadge.textContent = 'Авто';
      thumb.append(autoBadge);
    }

    const meta = document.createElement('div');
    meta.className = 'clip-meta';
    const d = new Date(c.mtime);
    const title = document.createElement('b');
    title.textContent = d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    meta.append(title, `${(c.size / 1024 / 1024).toFixed(1)} МБ`);
    if (c.auto && c.reason) {
      const reason = document.createElement('span');
      reason.className = 'clip-reason';
      reason.textContent = c.reason;
      reason.title = 'Почему сделан авто-клип: ' + c.reason;
      meta.append(reason);
    }

    card.append(thumb, meta);
    card.addEventListener('click', () => openPlayer(c.name));
    return card;
  }

  function openPlayer(name) {
    ui.player.src = `/media/${encodeURIComponent(name)}`;
    ui.playerName.textContent = name;
    ui.playerDialog.showModal();
    ui.player.play().catch(() => {});
  }

  function closePlayer() {
    ui.player.pause();
    ui.player.removeAttribute('src');
    ui.player.load();
  }

  // ---------- папка для клипов ----------

  async function pickFolder() {
    let dir = null;
    if (window.liveClipper) {
      dir = await window.liveClipper.pickFolder(); // окно Windows; null — если закрыли без выбора
    } else {
      dir = window.prompt('Полный путь к папке для клипов:', settings.clipsDir || ''); // запуск в браузере (отладка)
    }
    if (!dir) return;
    try {
      settings = await api('POST', '/api/settings', { clipsDir: dir });
    } catch (err) {
      return toast(err.message);
    }
    await loadClips();
    render();
  }

  // ---------- горячие клавиши: Пробел или C ----------

  function isTyping(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'button'].includes(el.type); // переключатель — не поле ввода
    return el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  document.addEventListener('keydown', (e) => {
    if (window.Tour && window.Tour.active) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.code !== 'Space' && e.code !== 'KeyC') return; // KeyC — физическая клавиша C, на русской раскладке это «С»
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    e.preventDefault(); // чтобы пробел не прокручивал страницу и не «нажимал» кнопку в фокусе
    if (e.repeat) return;
    makeClip();
  });
  // пробел на кнопке в фокусе срабатывает при отпускании — гасим, чтобы не было двойного действия
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !isTyping(e.target) && !document.querySelector('dialog[open]')) e.preventDefault();
  });

  // ---------- подключение кнопок ----------

  ui.record.addEventListener('click', toggleRecord);
  ui.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggleRecord(); });
  ui.clip.addEventListener('click', makeClip);
  ui.lengthGroup.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) saveSetting({ clipSeconds: Number(b.dataset.value) });
  });
  ui.formatGroup.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) saveSetting({ format: b.dataset.value });
  });
  ui.autoToggle.addEventListener('change', () => saveSetting({ autoClips: ui.autoToggle.checked }));
  ui.sensGroup.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) saveSetting({ sensitivity: b.dataset.value });
  });
  ui.addFolder.addEventListener('click', pickFolder);
  ui.changeFolder.addEventListener('click', pickFolder);
  ui.openFolder.addEventListener('click', () => api('POST', '/api/open-folder').catch((err) => toast(err.message)));
  ui.playerClose.addEventListener('click', () => ui.playerDialog.close());
  ui.playerDialog.addEventListener('close', closePlayer);
  ui.help.addEventListener('click', () => window.Tour.start());

  // ---------- старт ----------

  (async function init() {
    try { ui.url.value = localStorage.getItem('liveclipper.lastUrl') || ''; } catch {}
    try { settings = await api('GET', '/api/settings'); } catch {}
    setActive(ui.lengthGroup, settings.clipSeconds);
    setActive(ui.formatGroup, settings.format);
    setActive(ui.sensGroup, settings.sensitivity);
    connectEvents();
    await loadClips();
    render();
    window.Tour.startIfFirstTime();
  })();
})();
