// api/match-tips.js – v7 · teljes újraírás · llm7.io
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

// ─── Segédek ─────────────────────────────────────────────────────────────────

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── LLM hívás retry-jal ─────────────────────────────────────────────────────

async function llmCall(systemPrompt, userPrompt, temp = 0.28, retries = 2) {
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
            { role: 'user',   content: userPrompt   },
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

// ─── Forma statisztikák ───────────────────────────────────────────────────────

function computeFormStats(history) {
  if (!history?.length) return {};

  const snapshots = history
    .filter(e => e.standingsSnapshot?.length)
    .slice(0, 10)
    .map(e => e.standingsSnapshot)
    .reverse(); // legrégebbi → legújabb

  if (snapshots.length < 2) return {};

  const teams = [...new Set(snapshots.flatMap(s => s.map(t => t.team)))];
  const out = {};

  for (const team of teams) {
    const series = snapshots.map(s => s.find(t => t.team === team)).filter(Boolean);
    if (series.length < 2) continue;

    const recent = series.slice(-5);
    const gains  = [];
    for (let i = 1; i < recent.length; i++) gains.push(recent[i].pts - recent[i - 1].pts);
    const avg = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;

    const posFirst = series[0].pos;
    const posLast  = series.at(-1).pos;
    const posDelta = posFirst - posLast; // pozitív = javult

    const gdLast  = (series.at(-1).goalsFor  || 0) - (series.at(-1).goalsAgainst  || 0);
    const gdFirst = (series[0].goalsFor || 0) - (series[0].goalsAgainst || 0);

    out[team] = {
      avgPtsPerRound: +(avg.toFixed(2)),
      positionTrend:  posDelta,
      gdTrend:        gdLast - gdFirst,
      formLabel:      avg >= 2.1 ? 'kiváló' : avg >= 1.5 ? 'jó' : avg >= 0.9 ? 'közepes' : 'gyenge',
      posLabel:       posDelta > 0 ? `↑${posDelta}` : posDelta < 0 ? `↓${Math.abs(posDelta)}` : '→',
    };
  }

  return out;
}

// ─── Lokális fallback ─────────────────────────────────────────────────────────

function localFallback(matches, live, aiSt, form) {
  const n = live.length || 20;

  const score = team => {
    const l = live.find(t => t.team === team);
    const a = aiSt.find(t => t.team === team);
    const f = form[team];
    return (
      (l ? l.pts * 1.4 + ((l.goalsFor||0)-(l.goalsAgainst||0)) * 0.7 + (n+1-l.pos)*2.2 : 25) +
      (a ? (n+1-a.pos)*1.4 : 0) +
      (f ? f.avgPtsPerRound*5 + f.positionTrend*0.6 + f.gdTrend*0.3 : 0)
    );
  };

  return matches.map(m => {
    const hs = score(m.home), as_ = score(m.away);
    const total = Math.max(hs + as_, 1);

    let h = Math.min(Math.max(Math.round((hs / total) * 72), 13), 72);
    let a = Math.min(Math.max(Math.round((as_ / total) * 72), 13), 72);
    let d = Math.max(100 - h - a, 5);
    h = 100 - d - a;

    const lh   = live.find(t => t.team === m.home);
    const la   = live.find(t => t.team === m.away);
    const avgGF = ((lh?.goalsFor || 3.5) + (la?.goalsFor || 3.5)) / 2;
    const o15  = Math.min(Math.max(Math.round(58 + avgGF * 1.1), 42), 92);
    const o25  = Math.min(Math.max(Math.round(36 + avgGF * 0.85), 22), 82);

    const fav = h >= a ? m.home : m.away;
    const fh  = form[m.home], fa = form[m.away];

    return {
      home: m.home, away: m.away,
      homePct: h, drawPct: d, awayPct: a,
      over15Pct: o15, over25Pct: o25,
      over15Comment: o15 >= 62
        ? 'Gólgazdag meccs várható, mindkét csapat aktívan támad.'
        : 'Taktikai, szoros meccs – kevés gólra számítunk.',
      over25Comment: o25 >= 55
        ? 'Nagy valószínűséggel 3 vagy több gól lesz a meccsen.'
        : 'Defenzív, zárt összecsapás valószínű.',
      analysis: [
        `${fav} az esélyes a tabella és statisztikák alapján.`,
        fh ? `${m.home} formája: ${fh.formLabel} (${fh.avgPtsPerRound} pt/forduló, ${fh.posLabel}).` : '',
        fa ? `${m.away} formája: ${fa.formLabel} (${fa.avgPtsPerRound} pt/forduló, ${fa.posLabel}).` : '',
      ].filter(Boolean).join(' '),
      source: 'local',
    };
  });
}

// ─── Prompt építés ────────────────────────────────────────────────────────────

function buildPrompts(matches, live, aiSt, form) {
  const system = [
    'Te egy precíz virtuális futball-elemző vagy.',
    'Kizárólag valid JSON-t adsz vissza – semmi más szöveg, semmi markdown, semmi magyarázat.',
    'Minden meccsnél: homePct + drawPct + awayPct = pontosan 100 (egész számok).',
    'Minimum százalék bármely kimenetelre: 12.',
  ].join(' ');

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  const liveBlock = live.length
    ? live.map(t => {
        const gd = (t.goalsFor||0) - (t.goalsAgainst||0);
        return `  ${rpad(t.pos,2)}. ${pad(t.team,22)} ${rpad(t.pts,3)}pt  GF:${rpad(t.goalsFor??'?',3)} GA:${rpad(t.goalsAgainst??'?',3)} GD:${gd>=0?'+':''}${gd}  trend:${t.trend||'same'}`;
      }).join('\n')
    : '  (nem elérhető)';

  const aiBlock = aiSt.length
    ? aiSt.map(t =>
        `  ${rpad(t.pos,2)}. ${pad(t.team,22)} → ${rpad(t.pts,3)}pt végső  trend:${t.trend||'same'}`
      ).join('\n')
    : '  (nem elérhető)';

  const formBlock = Object.keys(form).length
    ? Object.entries(form).map(([team, f]) =>
        `  ${pad(team,22)} forma:${pad(f.formLabel,8)} ${f.avgPtsPerRound}pt/rd  poz:${f.posLabel}  GD-δ:${f.gdTrend>=0?'+':''}${f.gdTrend}`
      ).join('\n')
    : '  (nem elérhető)';

  const matchBlock = matches
    .map((m, i) => `  ${i+1}. ${m.home}  vs  ${m.away}`)
    .join('\n');

  const user = `
# AKTUÁLIS TABELLA
${liveBlock}

# AI SZEZONVÉGI ELŐREJELZÉS
${aiBlock}

# CSAPAT-FORMA TRENDEK (legutóbbi fordulók alapján)
${formBlock}

# MECCSEK
${matchBlock}

# FELADAT
Elemezd mindegyik meccset. Figyelj arra, hogy:
- NINCS hazai pálya előny – csak tabella, statisztika, forma számít
- Az esélyes csapatot mindig nevesítsd az analysis-ban és indokold
- Az over-kommentek legyenek specifikusak (ne generikusak)
- Minden százalék egész szám, minimum 12

Válasz: JSON tömb, pontosan ${matches.length} objektum, ebben a sémában:
[{"home":"...","away":"...","homePct":0,"drawPct":0,"awayPct":0,"over15Pct":0,"over25Pct":0,"over15Comment":"...","over25Comment":"...","analysis":"..."}]
`.trim();

  return { system, user };
}

// ─── Validálás & normalizálás ─────────────────────────────────────────────────

function validateResults(raw, matches) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Üres vagy nem tömb válasz');

  return raw.slice(0, matches.length).map((r, i) => {
    const m = matches[i] || {};

    let h = Math.min(Math.max(parseInt(r.homePct) || 33, 12), 76);
    let a = Math.min(Math.max(parseInt(r.awayPct) || 33, 12), 76);
    let d = Math.min(Math.max(parseInt(r.drawPct) || 25,  5), 50);

    // Normalizálás 100-ra
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
      analysis:      String(r.analysis     || '').trim() || `${r.home || m.home} vs ${r.away || m.away} – elemzés nem elérhető.`,
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

  const { matches, standings = [], aiPrediction, history = [] } = body;

  if (!Array.isArray(matches) || !matches.length) {
    return jsonRes({ error: '"matches" mező kötelező és nem lehet üres.' }, 400);
  }

  const aiStandings = aiPrediction?.standings || [];
  const formStats   = computeFormStats(history);

  try {
    const { system, user } = buildPrompts(matches, standings, aiStandings, formStats);
    const text    = await llmCall(system, user, 0.28);
    const raw     = extractArray(text);
    const results = validateResults(raw, matches);

    if (results.length !== matches.length) {
      throw new Error(`Várt ${matches.length} meccs, kapott ${results.length}`);
    }

    return jsonRes({ results, source: 'ai', count: results.length });

  } catch (err) {
    console.warn('[match-tips] fallback:', err.message);
    const results = localFallback(matches, standings, aiStandings, formStats);
    return jsonRes({ results, source: 'local', count: results.length, fallbackReason: err.message });
  }
}
