// api/match-tips.js – v8 · csak AI tabella + max 25 history · llm7.io
// ─────────────────────────────────────────────────────────────────────────────
export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const LLM = {
  url:       'https://api.llm7.io/v1/chat/completions',
  model:     'llama-3.3-70b-instruct-fp8-fast',
  timeout:   32_000,
  maxTokens: 4096,
};

const MAX_HISTORY = 25;

// ─── Segédek ─────────────────────────────────────────────────────────────────

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── LLM hívás retry-jal ─────────────────────────────────────────────────────

async function llmCall(systemPrompt, userPrompt, temp = 0.5, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(LLM.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer unused' },
        body: JSON.stringify({
          model: LLM.model,
          temperature: temp,
          max_tokens: LLM.maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(LLM.timeout),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => String(res.status));
        throw new Error(`HTTP ${res.status}: ${err.slice(0, 120)}`);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('Üres LLM válasz');
      return text;

    } catch (err) {
      if (i === retries) throw err;
      await sleep(700 * (i + 1));
    }
  }
}

// ─── JSON kibontása ───────────────────────────────────────────────────────────

function extractArray(text) {
  const clean = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  const m = clean.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Nem található JSON tömb');
  return JSON.parse(m[0]);
}

// ─── History feldolgozás (max 25 snapshot) ───────────────────────────────────
// Visszaadja: csapatonként a pozíció-sorozatot és pont/forduló trendet

function processHistory(history) {
  const snapshots = (history || [])
    .filter(e => e.standingsSnapshot?.length)
    .slice(0, MAX_HISTORY)          // max 25
    .map(e => e.standingsSnapshot)
    .reverse();                     // legrégebbi → legújabb

  if (snapshots.length < 2) return {};

  const teams = [...new Set(snapshots.flatMap(s => s.map(t => t.team)))];
  const out = {};

  for (const team of teams) {
    const series = snapshots
      .map(s => s.find(t => t.team === team))
      .filter(Boolean);

    if (series.length < 2) continue;

    // Pont/forduló átlag (utolsó max 10 adat)
    const recent = series.slice(-10);
    const gains = [];
    for (let i = 1; i < recent.length; i++) {
      gains.push(recent[i].pts - recent[i - 1].pts);
    }
    const avgPts = gains.length
      ? +(gains.reduce((a, b) => a + b, 0) / gains.length).toFixed(2)
      : 0;

    // Pozíció trend: első vs utolsó
    const posFirst = series[0].pos;
    const posLast  = series.at(-1).pos;
    const posDelta = posFirst - posLast; // pozitív = javult (kisebb szám = jobb)

    // Trend label
    const trend = avgPts >= 2.0 ? 'erős' : avgPts >= 1.3 ? 'közepes' : 'gyenge';
    const posLabel = posDelta > 0 ? `↑${posDelta}` : posDelta < 0 ? `↓${Math.abs(posDelta)}` : '→';

    out[team] = { avgPts, posDelta, trend, posLabel, samples: series.length };
  }

  return out;
}

// ─── Prompt felépítés ─────────────────────────────────────────────────────────

function buildPrompts(matches, aiStandings, histStats) {
  const system = [
    'Te egy precíz virtuális futball-elemző vagy.',
    'Kizárólag valid JSON-t adsz vissza – semmi más szöveg, semmi markdown.',
    'Minden meccsnél: homePct + drawPct + awayPct = pontosan 100 (egész számok).',
    'Minimum 12% bármely kimenetelre.',
  ].join(' ');

  // AI tabella blokk
  const aiBlock = aiStandings.length
    ? aiStandings
        .slice()
        .sort((a, b) => a.pos - b.pos)
        .map(t =>
          `  ${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${String(t.pts).padStart(3)}pt  trend:${t.trend || 'same'}`
        ).join('\n')
    : '  (nem elérhető)';

  // History trendek blokk
  const hasHistory = Object.keys(histStats).length > 0;
  const histBlock = hasHistory
    ? Object.entries(histStats)
        .map(([team, h]) =>
          `  ${team.padEnd(22)} ${h.trend.padEnd(8)} ${h.avgPts}pt/fd  poz:${h.posLabel}  (${h.samples} minta)`
        ).join('\n')
    : '  (nem elérhető)';

  // Meccsek
  const matchBlock = matches
    .map((m, i) => `  ${i + 1}. ${m.home}  vs  ${m.away}`)
    .join('\n');

  const user = `
# AI SZEZONVÉGI ELŐREJELZÉS
${aiBlock}

# CSAPAT FORMA TRENDEK (max ${MAX_HISTORY} forduló alapján)
${histBlock}

# ELEMZENDŐ MECCSEK
${matchBlock}

# FELADAT
Minden meccshez készíts elemzést kizárólag a fenti két adatforrás alapján.

Szabályok:
- NINCS hazai pálya előny
- Az esélyes csapatot mindig nevesítsd és indokold az analysis-ban
- Minimum 12% minden kimenetelre
- homePct + drawPct + awayPct = pontosan 100

Válasz: JSON tömb, pontosan ${matches.length} objektum:
[{"home":"...","away":"...","homePct":0,"drawPct":0,"awayPct":0,"over15Pct":0,"over25Pct":0,"over15Comment":"1 mondat magyarul","over25Comment":"1 mondat magyarul","analysis":"2-3 mondat magyarul"}]
`.trim();

  return { system, user };
}

// ─── Lokális fallback ─────────────────────────────────────────────────────────

function localFallback(matches, aiStandings, histStats) {
  const n = aiStandings.length || 20;

  const score = team => {
    const ai   = aiStandings.find(t => t.team === team);
    const hist = histStats[team];
    return (
      (ai   ? (n + 1 - ai.pos) * 3.5 : 20) +
      (hist ? hist.avgPts * 6 + hist.posDelta * 0.8 : 0)
    );
  };

  return matches.map(m => {
    const hs    = score(m.home);
    const as_   = score(m.away);
    const total = Math.max(hs + as_, 1);

    let h = Math.min(Math.max(Math.round((hs / total) * 72), 13), 72);
    let a = Math.min(Math.max(Math.round((as_ / total) * 72), 13), 72);
    let d = Math.max(100 - h - a, 5);
    h = 100 - d - a;

    const fav  = h >= a ? m.home : m.away;
    const hh   = histStats[m.home];
    const ha   = histStats[m.away];
    const aiH  = aiStandings.find(t => t.team === m.home);
    const aiA  = aiStandings.find(t => t.team === m.away);
    const avgPos = ((aiH?.pos || n / 2) + (aiA?.pos || n / 2)) / 2;
    const o15  = Math.min(Math.max(Math.round(72 - avgPos * 1.2), 42), 90);
    const o25  = Math.min(Math.max(Math.round(52 - avgPos * 0.9), 22), 80);

    return {
      home: m.home, away: m.away,
      homePct: h, drawPct: d, awayPct: a,
      over15Pct: o15, over25Pct: o25,
      over15Comment: o15 >= 62
        ? 'Gólgazdag meccs várható.'
        : 'Szoros, kevés gólos meccs valószínű.',
      over25Comment: o25 >= 52
        ? '3+ gól valószínűsíthető.'
        : 'Defenzív, zárt meccs várható.',
      analysis: [
        `${fav} az esélyes az AI előrejelzés alapján.`,
        hh ? `${m.home} forma: ${hh.trend} (${hh.avgPts}pt/fd, ${hh.posLabel}).` : '',
        ha ? `${m.away} forma: ${ha.trend} (${ha.avgPts}pt/fd, ${ha.posLabel}).` : '',
      ].filter(Boolean).join(' '),
      source: 'local',
    };
  });
}

// ─── Validálás ────────────────────────────────────────────────────────────────

function validateResults(raw, matches) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Üres vagy nem tömb válasz');

  return raw.slice(0, matches.length).map((r, i) => {
    const m = matches[i] || {};

    let h = Math.min(Math.max(parseInt(r.homePct) || 33, 12), 76);
    let a = Math.min(Math.max(parseInt(r.awayPct) || 33, 12), 76);
    let d = Math.min(Math.max(parseInt(r.drawPct) || 25,  5), 50);

    const sum = h + d + a;
    if (sum !== 100) {
      h = Math.round(h * 100 / sum);
      a = Math.round(a * 100 / sum);
      d = 100 - h - a;
    }
    if (d < 5) { d = 5; h = Math.max(h - 3, 12); }

    return {
      home:          r.home || m.home || '?',
      away:          r.away || m.away || '?',
      homePct:       h,
      drawPct:       d,
      awayPct:       a,
      over15Pct:     Math.min(Math.max(parseInt(r.over15Pct) || 65, 30), 95),
      over25Pct:     Math.min(Math.max(parseInt(r.over25Pct) || 48, 20), 85),
      over15Comment: String(r.over15Comment || '').trim() || 'Közepes gólvárakozás.',
      over25Comment: String(r.over25Comment || '').trim() || 'Közepes gólvárakozás.',
      analysis:      String(r.analysis     || '').trim() || `${m.home} vs ${m.away} – elemzés nem elérhető.`,
      source:        'ai',
    };
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return jsonRes({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return jsonRes({ error: 'Érvénytelen JSON body' }, 400); }

  const { matches, aiPrediction, history = [] } = body;

  if (!Array.isArray(matches) || !matches.length) {
    return jsonRes({ error: '"matches" mező kötelező és nem lehet üres.' }, 400);
  }

  const aiStandings = aiPrediction?.standings || [];
  const histStats   = processHistory(history);

  try {
    const { system, user } = buildPrompts(matches, aiStandings, histStats);
    const text    = await llmCall(system, user, 0.5);
    const raw     = extractArray(text);
    const results = validateResults(raw, matches);

    if (results.length !== matches.length) {
      throw new Error(`Várt ${matches.length} meccs, kapott ${results.length}`);
    }

    return jsonRes({ results, source: 'ai', count: results.length });

  } catch (err) {
    console.warn('[match-tips] fallback:', err.message);
    const results = localFallback(matches, aiStandings, histStats);
    return jsonRes({ results, source: 'local', count: results.length, fallbackReason: err.message });
  }
}
