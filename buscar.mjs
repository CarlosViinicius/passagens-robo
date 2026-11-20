// Robô do GitHub: abre o Google Voos num Chrome nos servidores do GitHub, lê o voo mais barato de cada
// combinação de datas (ida e volta, com horários) e manda para o app.
// Pode demorar, mas não desiste: cada data tenta várias vezes, e a tela das voltas é recarregada
// sozinha (sem recomeçar a data) até aparecerem os voos de volta.
import { chromium } from 'playwright';

const APP_URL = (process.env.APP_URL || 'https://passagens-chile.baudelaire-aviso.workers.dev').replace(/\/+$/, '');
const EXT_KEY = process.env.EXT_KEY;
const LOTE = 3; // manda para o app a cada 3 datas
const MAX_TENTATIVAS = 6; // por data (cada tentativa já recarrega as voltas até 4 vezes)
const LIMITE_MS = Number(process.env.LIMITE_MIN || 40) * 60000; // tempo máximo desta parte
// Divisão entre vários servidores do GitHub (cada um com outro endereço de internet)
const SHARD = Number(process.env.SHARD || 0);
const SHARDS = Number(process.env.SHARDS || 1);
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

// ---------------------------------------------------------------- leitura (roda dentro da página)
// Lê a lista de voos da tela atual. modo 'ida': espera as idas; modo 'volta': espera as voltas (chegam em Maringá).
async function lerLista([modo, esperaMs]) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const parse = (t) => {
    const price = Number((t.match(/a partir de ([\d.]+) Reais/) || [])[1]?.replace(/\./g, '')) || null;
    const direct = /Voo direto/i.test(t);
    const stops = direct ? 0 : Number((t.match(/com (\d+) parada/) || [])[1] ?? NaN);
    const airline = (t.match(/Voo (?:direto )?da (.+?)(?: com \d+ parada|\.)/) || [])[1] ?? null;
    const m = t.match(/às (\d{2}:\d{2}) do dia ([^.]+?) e chega no aeroporto (.+?) às (\d{2}:\d{2}) do dia ([^.]+?)\./);
    const d = t.match(/Duração total: (?:(\d+)h)?\s*(?:(\d+) min)?/);
    const dur = d ? Number(d[1] ?? 0) * 60 + Number(d[2] ?? 0) : null;
    return {
      price,
      airline,
      chega: m?.[3] ?? '',
      leg: m ? { time: m[1], arr: m[4] + (m[2].trim() !== m[5].trim() ? ' (+1)' : ''), dur: dur || null, stops: Number.isFinite(stops) ? stops : null } : null,
    };
  };
  const ler = () =>
    [...document.querySelectorAll('[aria-label^="Preço total"]')]
      .map((el, i) => ({ i, ...parse(el.getAttribute('aria-label')) }))
      .filter((o) => o.price && o.leg && (modo === 'volta' ? /Maringá/i.test(o.chega) : !/Maringá/i.test(o.chega)));

  const fim = Date.now() + esperaMs;
  let lista = ler();
  while (!lista.length && Date.now() < fim) {
    if (location.pathname.startsWith('/sorry')) return { blocked: true };
    await wait(500);
    lista = ler();
  }
  if (!lista.length) return { vazio: true, tela: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 120) };
  // espera mais um pouco para a lista terminar de carregar (o mais barato pode chegar depois)
  await wait(1500);
  lista = ler();
  // o mais barato; no empate, o mais rápido e com menos escalas
  lista.sort((a, b) => a.price - b.price || (a.leg.dur ?? 1e6) - (b.leg.dur ?? 1e6) || (a.leg.stops ?? 9) - (b.leg.stops ?? 9));
  return { melhor: lista[0], total: lista.length };
}

function clicar(i) {
  const el = [...document.querySelectorAll('[aria-label^="Preço total"]')][i];
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
}

// ---------------------------------------------------------------- uma data
async function buscarData(page, p) {
  const url = flightsUrl(p.dep, p.ret);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ida = await page.evaluate(lerLista, ['ida', 30000]);
  if (ida.vazio) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    ida = await page.evaluate(lerLista, ['ida', 30000]);
  }
  if (ida.blocked) return { blocked: true };
  if (!ida.melhor) return { erro: `as idas não carregaram (${ida.tela})` };

  // abre a ida mais barata: a página vai para a tela das voltas (o endereço muda)
  const antes = page.url();
  await page.evaluate(clicar, ida.melhor.i);
  await page.waitForURL((u) => u.toString() !== antes, { timeout: 20000 }).catch(() => {});

  // espera as voltas; se não vierem, recarrega só a tela das voltas (até 4 vezes)
  let volta = null;
  for (let r = 0; r < 4 && !volta?.melhor; r++) {
    if (r > 0) {
      await sleep(2000 + r * 2000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    volta = await page.evaluate(lerLista, ['volta', 25000]).catch(() => null);
    if (volta?.blocked) return { blocked: true };
  }
  if (!volta?.melhor) return { erro: 'achou a ida, mas as voltas não carregaram' };

  return {
    // o preço da tela das voltas é o total de ida e volta para essa combinação
    price: volta.melhor.price,
    airline: ida.melhor.airline,
    out: ida.melhor.leg,
    back: volta.melhor.leg,
    link: url,
  };
}

// ---------------------------------------------------------------- rodada
const st = { running: true, done: 0, total: 0, found: 0, error: null };
const progress = (alert) =>
  post('/api/progress', { running: st.running, origin: 'github', shard: SHARD, shards: SHARDS, auto: true, done: st.done, total: st.total, google: st.found, sky: 0, skyOff: true, error: st.error, alert }).catch(() => {});

const summary = await (await fetch(APP_URL + '/api/summary')).json();
const pairs = summary.pairs.map((p) => ({ dep: p.dep, ret: p.ret })).filter((_, i) => i % SHARDS === SHARD);
st.total = pairs.length;
console.log(`Parte ${SHARD + 1} de ${SHARDS}: ${pairs.length} combinações`);
await progress();

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--disable-blink-features=AutomationControlled', '--blink-settings=imagesEnabled=false'],
});
const novaAba = async () => {
  const ctx = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return { ctx, page: await ctx.newPage() };
};

let pend = { fares: [], checked: [], q: 0 };
const flush = async (force = false) => {
  if (!force && pend.q < LOTE) return;
  const lote = pend;
  pend = { fares: [], checked: [], q: 0 };
  if (lote.q) await post('/api/ingest', { source: 'github', fares: lote.fares, checked: lote.checked, queried: lote.q, note: `Robô do GitHub: ${st.done} de ${st.total} datas` });
};

const t0 = Date.now();
const fila = pairs.map((p) => ({ ...p, tent: 0 }));
const faltaram = [];
let aba = await novaAba();
let falhasSeguidas = 0;

while (fila.length) {
  if (Date.now() - t0 > LIMITE_MS) {
    faltaram.push(...fila.splice(0));
    break;
  }
  const p = fila.shift();
  p.tent++;
  let r;
  try {
    r = await buscarData(aba.page, p);
  } catch (e) {
    r = { erro: e.message.split('\n')[0].slice(0, 100) };
  }

  if (r.blocked) {
    // o Google pediu verificação: espera, troca de sessão e tenta de novo depois
    console.log(`   Google pediu verificação de robô. Esperando 1 minuto e trocando de sessão…`);
    await aba.ctx.close().catch(() => {});
    await sleep(60000);
    aba = await novaAba();
    r = { erro: 'verificação de robô' };
  }

  if (r.price) {
    falhasSeguidas = 0;
    st.found++;
    st.done++;
    pend.q++;
    pend.checked.push({ dep: p.dep, ret: p.ret });
    pend.fares.push({ dep: p.dep, ret: p.ret, price: r.price, airline: r.airline, stops: r.out?.stops ?? null, link: r.link, info: { out: r.out, back: r.back } });
    console.log(`${String(st.done).padStart(2)} de ${st.total}  ${p.dep} → ${p.ret}  R$ ${r.price}  ida ${r.out.time}→${r.out.arr}, volta ${r.back.time}→${r.back.arr}${p.tent > 1 ? `  (tentativa ${p.tent})` : ''}`);
  } else {
    falhasSeguidas++;
    if (p.tent < MAX_TENTATIVAS) {
      console.log(`   … ${p.dep} → ${p.ret}: ${r.erro}. Tenta de novo depois (tentativa ${p.tent} de ${MAX_TENTATIVAS})`);
      fila.push(p);
    } else {
      st.done++;
      faltaram.push(p);
      console.log(`   ✗ ${p.dep} → ${p.ret}: não consegui depois de ${MAX_TENTATIVAS} tentativas (${r.erro})`);
    }
    // várias falhas seguidas: sessão nova e uma pausa maior (o Google costuma liberar depois)
    if (falhasSeguidas >= 2) {
      await aba.ctx.close().catch(() => {});
      await sleep(15000 + Math.random() * 15000);
      aba = await novaAba();
      falhasSeguidas = 0;
    }
  }
  await progress();
  await flush();
  await sleep(1500 + Math.random() * 2000); // ritmo de gente, não de robô
}

await flush(true);
await browser.close();
st.running = false;
if (faltaram.length) st.error = `${faltaram.length} data(s) não carregaram: ${faltaram.map((p) => `${p.dep.slice(5)}→${p.ret.slice(5)}`).join(', ')}. A próxima rodada tenta de novo.`;
await progress(st.found === 0 && st.total ? { title: '⚠️ Robô do GitHub não achou preços', body: 'Nenhuma data carregou nesta parte da rodada. A próxima tenta de novo.' } : null);
console.log(`Pronto em ${Math.round((Date.now() - t0) / 1000)} s: ${st.found} de ${st.total} datas com preço e volta.${faltaram.length ? ' Faltaram: ' + faltaram.map((p) => p.dep + '→' + p.ret).join(', ') : ''}`);
