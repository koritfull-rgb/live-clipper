// Запускает Electron с переданными аргументами.
// Нужен потому, что терминал VS Code выставляет ELECTRON_RUN_AS_NODE=1, и тогда Electron
// работает как обычный Node без окон. Здесь эта переменная убирается.

const { spawn } = require('child_process');
const electron = require('electron'); // путь к electron.exe

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));
