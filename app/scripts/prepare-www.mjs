// Готовит папку www для Android: берёт игру из корня репозитория (та же сборка, что в Telegram)
// и убирает то, что нужно только Telegram. Адрес сервера: переменная APP_API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'index.html');
const out = path.join(here, '..', 'www');
const api = process.env.APP_API || 'https://gmhockey.ru';
let h = fs.readFileSync(src, 'utf8');
h = h.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', '');
h = h.replace(/<script>window\.GM_API=[^<]*<\/script>/, `<script>window.GM_API=${JSON.stringify(api)};</script>`);
if (!h.includes(`window.GM_API=${JSON.stringify(api)}`)) throw new Error('не нашёл строку window.GM_API в index.html');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), h);
console.log(`www/index.html готов, сервер: ${api}`);
