// Live Clipper — главный файл программы для Windows.
// Открывает окно, запускает внутри сервер и даёт странице выбирать папку через окно Windows.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');

// Пути для сервера нужно задать ДО того, как он загрузится.
process.env.LIVECLIPPER_DATA = app.getPath('userData'); // %APPDATA%\Live Clipper
process.env.LIVECLIPPER_BIN = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', 'bin');

const { startServer, shutdown } = require('../server');

let win = null;
let quitting = false;

// Вторую копию программы не открываем — показываем уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(boot);
}

async function boot() {
  Menu.setApplicationMenu(null);

  let port;
  try {
    port = await startServer();
  } catch (err) {
    dialog.showErrorBox('Live Clipper', 'Не удалось запустить программу:\n' + err.message);
    return app.quit();
  }

  win = new BrowserWindow({
    title: 'Live Clipper',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    width: 1000,
    height: 840,
    minWidth: 520,
    minHeight: 500,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', (e) => e.preventDefault()); // всегда «Live Clipper»
  win.on('closed', () => { win = null; });

  // Ссылки на внешние сайты открываем в обычном браузере, а не внутри программы.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) e.preventDefault();
  });

  win.loadURL(`http://127.0.0.1:${port}/`);
}

// Окно выбора папки для клипов. Возвращает путь или null, если окно закрыли без выбора.
ipcMain.handle('pick-folder', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    title: 'Папка для клипов',
    buttonLabel: 'Выбрать папку',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Перед выходом аккуратно останавливаем запись, чтобы не остались висеть ffmpeg и yt-dlp.
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
