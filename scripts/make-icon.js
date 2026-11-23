// Рисует build/icon.png (512×512) из build/icon.svg.
// Запуск: npm run icon   (нужен только если поменяли icon.svg)

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, '..', 'build', 'icon.svg');
const PNG = path.join(__dirname, '..', 'build', 'icon.png');
const SIZE = 512;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const svg = fs.readFileSync(SVG, 'utf8');
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(PNG, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log('Готово:', PNG);
  app.quit();
});
