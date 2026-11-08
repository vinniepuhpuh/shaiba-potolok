import vm from 'node:vm';
import fs from 'node:fs';

/**
 * Загружает код игры из index.html (тот же, что у игроков) в изолированный контекст Node.
 * Сервер использует движок матча, составы, ИИ клубов и рост игроков без копирования кода.
 * G.ev('выражение') — доступ к любым функциям и переменным игры (в том числе let/const).
 */
export function loadGame(htmlPath) {
  const h = fs.readFileSync(htmlPath, 'utf8');
  const i = h.indexOf('<script>\n', h.indexOf('<div id="app"></div>')) + 9;
  const j = h.lastIndexOf('</script>');
  if (i < 9 || j < i) throw new Error('не нашёл код игры в ' + htmlPath);
  const code = h.slice(i, j);
  const store = new Map();
  const ctx = {
    console, Math, Date, JSON, Promise, Map, Set, Array, Object, Number, String, Boolean, RegExp, Error,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Blob, Response, URLSearchParams, btoa, atob,
    fetch: () => Promise.reject(new Error('fetch недоступен на сервере')),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code + '\n;globalThis.__ev=(src)=>eval(src);', ctx, { filename: 'game.js' });
  const ev = ctx.__ev;
  return {
    ev,
    get S() { return ev('S'); },
    set S(v) { ctx.__tmp = v; ev('S=globalThis.__tmp'); ctx.__tmp = null; },
    get HOOK() { return ev('HOOK'); },
    version: (code.match(/const CHANGES=\[\s*\{v:'([^']+)'/) || [])[1] || '?',
  };
}
