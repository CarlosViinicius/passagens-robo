// Robô do GitHub: abre o Google Voos num Chrome invisível, lê o menor preço de cada combinação de datas
// (com horários de ida e volta) e manda para o app. Várias datas ao mesmo tempo, sem imagens nem fontes.
import { chromium } from 'playwright';

const APP_URL = (process.env.APP_URL || 'https://passagens-chile.baudelaire-aviso.workers.dev').replace(/\/+$/, '');
const EXT_KEY = process.env.EXT_KEY;
const PARALELO = Number(process.env.PARALELO || 1); // quantas datas ao mesmo tempo
const LOTE = 10; // manda para o app a cada 10 datas conferidas
if (!EXT_KEY) throw new Error('Falta o segredo EXT_KEY no GitHub (Settings > Secrets and variables > Actions).');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flightsUrl = (dep, ret) =>
  `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from MGF to SCL on ${dep} through ${ret}`)}&curr=BRL&hl=pt-BR&gl=BR`;

async function post(path, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(APP_URL + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ext-key': EXT_KEY },
        body: JSON.stringify(body),
      });
      if (res.status === 401) throw new Error('O app não reconheceu a EXT_KEY.');
      if (res.ok) return;
    } catch (e) {
      if (/EXT_KEY/.test(e.message)) throw e;
    }
    await sleep(2000);
  }
}

// Mesma leitura da extensão (roda dentro da página do Google Voos)
async function readGoogle() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.hostname.includes('google.') && location.pathname.startsWith('/sorry')) return { blocked: true };

  const parse = (t) => {
    const price = Number((t.match(/a partir de ([\d.]+) Reais/) || [])[1]?.replace(/\./g, '')) || null;
    const direct = /Voo direto/i.test(t);
    const stops = direct ? 0 : Number((t.match(/com (\d+) parada/) || [])[1] ?? NaN);
    const airline = (t.match(/Voo (?:direto )?da (.+?)(?: com \d+ parada|\.)/) || [])[1] ?? null;
    const m = t.match(/às (\d{2}:\d{2}) do dia ([^.]+?) e chega no aeroporto .+? às (\d{2}:\d{2}) do dia ([^.]+?)\./);
    const d = t.match(/Duração total: (?:(\d+)h)?\s*(?:(\d+) min)?/);
    const dur = d ? Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0) : null;
    return {
      price,
      airline,
      leg: m
        ? { time: m[1], arr: m[3] + (m[2].trim() !== m[4].trim() ? ' (+1)' : ''), dur: dur || null, stops: Number.isFinite(stops) ? stops : null }
        : null,
    };
  };
  const options = () =>
    [...document.querySelectorAll('[aria-label^="Preço total"]')]
      .map((el) => ({ el, ...parse(el.getAttribute('aria-label')) }))
      .filter((o) => o.price && o.leg);

  // espera os resultados de ida (até 40 s: no servidor a página pode demorar)
  let outs = options();
  for (let i = 0; i < 40 && !outs.length; i++) {
    if (location.pathname.startsWith('/sorry')) return { blocked: true };
    await wait(500);
    outs = options();
  }
  if (!outs.length) return { price: null, timeout: true, page: (document.title + ' | ' + (document.body?.innerText ?? '')).replace(/\s+/g, ' ').slice(0, 220) };
  const best = outs.reduce((a, b) => (b.price < a.price ? b : a));
  const firstText = best.el.getAttribute('aria-label');

  // abre a ida mais barata para ver as voltas
  best.el.click();
  let backs = [];
  for (let i = 0; i < 60 && !backs.length; i++) {
    await wait(500);
    backs = options().filter((o) => o.el.getAttribute('aria-label') !== firstText && /Maringá/.test(o.el.getAttribute('aria-label').split('chega no aeroporto')[1] ?? ''));
  }
  const back = backs.length ? backs.reduce((a, b) => (b.price < a.price ? b : a)) : null;

  return {
    price: back ? Math.min(back.price, best.price) : best.price,
    airline: best.airline,
    out: best.leg,
    back: back?.leg ?? null,
  };
}

const st = { running: true, done: 0, total: 0, found: 0, error: null };
const progress = (alert) =>
  post('/api/progress', { running: st.running, origin: 'github', auto: true, done: st.done, total: st.total, google: st.found, sky: 0, skyOff: true, error: st.error, alert }).catch(() => {});

const summary = await (await fetch(APP_URL + '/api/summary')).json();
const pairs = summary.pairs.map((p) => ({ dep: p.dep, ret: p.ret }));
st.total = pairs.length;
console.log(`${pairs.length} combinações, ${PARALELO} ao mesmo tempo`);
await progress();

// Chrome "de verdade" (não o modo invisível simplificado), sem imagens
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--disable-blink-features=AutomationControlled', '--blink-settings=imagesEnabled=false'],
});
const ctx = await browser.newContext({
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

let pend = { fares: [], checked: [], q: 0 };
let enviando = Promise.resolve();
const flush = (force = false) => {
  if (!force && pend.q < LOTE) return enviando;
  const lote = pend;
  pend = { fares: [], checked: [], q: 0 };
  if (!lote.q) return enviando;
  enviando = enviando.then(() =>
    post('/api/ingest', { source: 'github', fares: lote.fares, checked: lote.checked, queried: lote.q, note: `Robô do GitHub: ${st.done} de ${st.total} datas` }),
  );
  return enviando;
};

let blocked = false;
const fila = [...pairs];
const tentativas = new Map();
async function trabalhador(n) {
  const page = await ctx.newPage();
  await sleep(n * 1500); // começa um pouco espaçado
  while (fila.length && !blocked) {
    const p = fila.shift();
    const url = flightsUrl(p.dep, p.ret);
    let result = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      result = await page.evaluate(readGoogle);
      if (result?.timeout) {
        // ficou preso em "Carregando resultados": recarrega uma vez
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        result = await page.evaluate(readGoogle);
      }
    } catch (e) {
      result = { timeout: true, page: e.message.split('\n')[0] };
    }
    await sleep(1500 + Math.random() * 1500); // ritmo de gente, não de robô
    const k = `${p.dep}|${p.ret}`;
    if (result?.timeout && (tentativas.get(k) ?? 0) < 2) {
      tentativas.set(k, (tentativas.get(k) ?? 0) + 1);
      console.log(`   … ${p.dep} → ${p.ret} não carregou, tenta de novo no fim (${result.page})`);
      fila.push(p);
      continue;
    }
    if (result?.blocked) {
      blocked = true;
      st.error = 'O Google pediu verificação de robô no servidor do GitHub. A próxima rodada tenta de novo.';
      break;
    }
    pend.q++;
    // só conta como "conferida" (e troca o preço antigo) quando achou preço de verdade
    if (result?.price) pend.checked.push(p);
    if (result?.price) {
      st.found++;
      pend.fares.push({ dep: p.dep, ret: p.ret, price: result.price, airline: result.airline, stops: result.out?.stops ?? null, link: url, info: { out: result.out, back: result.back } });
    }
    st.done++;
    console.log(`${String(st.done).padStart(2)} de ${st.total}  ${p.dep} → ${p.ret}  ${result?.price ? 'R$ ' + result.price : 'não carregou'}${result?.back ? '' : result?.price ? ' (sem volta)' : ''}`);
    progress();
    flush();
  }
  await page.close();
}

const t0 = Date.now();
try {
  await Promise.all(Array.from({ length: PARALELO }, (_, i) => trabalhador(i)));
} catch (e) {
  st.error = e.message;
}
await flush(true);
await browser.close();
st.running = false;
const problema = st.error || (st.total && st.found === 0) ? st.error || 'O robô do GitHub não encontrou nenhum preço nesta rodada.' : null;
st.error = problema;
await progress(problema ? { title: '⚠️ Robô do GitHub com problema', body: `${problema} Conferidas ${st.done} de ${st.total} datas.` } : null);
console.log(`Pronto em ${Math.round((Date.now() - t0) / 1000)} s: ${st.found} preços em ${st.done} de ${st.total} datas.${problema ? ' Problema: ' + problema : ''}`);
if (problema) process.exitCode = 1;
