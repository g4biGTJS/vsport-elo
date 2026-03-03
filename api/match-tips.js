// api/match-tips.js – v8: valós standings elsőbbség, KV history, math számítja a %-okat
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HOME_ELO_BONUS = 60; // ~7% hazai előny

// ─── KV helpers ──────────────────────────────────────────────────────────────
function kvUrl(path) {
  const base = process.env.KV_REST_API_URL;
  if (!base) return null;
  return `${base}${path}`;
}
function kvHeaders() {
  const token = process.env.KV_REST_API_TOKEN;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function kvGet(key) {
  try {
    const url = kvUrl(`/get/${encodeURIComponent(key)}`);
    const hdrs = kvHeaders();
    if (!url || !hdrs) return null;
    const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.result ?? null;
    if (result === null) return null;
    if (typeof result === 'object' && result.value !== undefined)
      return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  } catch { return null; }
}

// ─── History betöltése KV-ból ────────────────────────────────────────────────
async function loadHistoryFromKV(seasonId) {
  try {
    // Először szezon-specifikus kulcs
    if (seasonId) {
      const raw = await kvGet(`vsport:league_history:season:${seasonId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    }
    // Fallback: legacy kulcs
    const raw = await kvGet('vsport:league_history');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn('[match-tips] KV history betöltési hiba:', e.message);
  }
  return [];
}

// ─── Elo számítás ─────────────────────────────────────────────────────────────
function teamElo(pos, pts, n, maxPts, formBonus = 0) {
  if (n <= 1) return 1400 + formBonus;
  const posScore = ((n - pos) / (n - 1)) * 600; // 1. hely=600, utolsó=0
  const ptsScore = maxPts > 0 ? (pts / maxPts) * 300 : 0;
  return Math.round(1000 + posScore + ptsScore + formBonus);
}

function eloWinProb(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

// ─── Poisson ─────────────────────────────────────────────────────────────────
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function overXGoalsPct(lambda, x) {
  let cum = 0;
  for (let k = 0; k <= Math.floor(x); k++) cum += poissonPMF(lambda, k);
  return Math.round(Math.min(Math.max((1 - cum) * 100, 10), 95));
}

// ─── Forma feldolgozás a history-ból ─────────────────────────────────────────
function buildForms(historyEntries) {
  if (!historyEntries?.length) return {};

  // Legújabbtól a legrégebbiig, max 30 snapshot
  const snaps = [...historyEntries]
    .filter(e => e.standingsSnapshot?.length)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 30)
    .reverse(); // most legrégebbitől legújabbig

  if (snaps.length < 2) return {};

  const forms = {};
  const teams = new Set(snaps.flatMap(s => s.standingsSnapshot.map(t => t.team)));

  for (const name of teams) {
    const timeline = snaps.map(s => {
      const t = s.standingsSnapshot.find(x => x.team === name);
      return t ? {
        pts: t.pts || 0,
        pos: t.pos,
        gf:  t.goalsFor || 0,
        ga:  t.goalsAgainst || 0
      } : null;
    }).filter(Boolean);

    if (timeline.length < 2) continue;

    // Pont növekmények fordulónként
    const gains = [];
    for (let i = 1; i < timeline.length; i++) {
      gains.push(timeline[i].pts - timeline[i - 1].pts);
    }

    const avgGain  = gains.reduce((a, b) => a + b, 0) / gains.length;
    const last5g   = gains.slice(-5);
    const last5Avg = last5g.length ? last5g.reduce((a, b) => a + b, 0) / last5g.length : avgGain;

    // Utolsó 5 snapshot gólátlag
    const last5snaps = timeline.slice(-5);
    const avgGF5 = last5snaps.reduce((s, t) => s + t.gf, 0) / last5snaps.length;
    const avgGA5 = last5snaps.reduce((s, t) => s + t.ga, 0) / last5snaps.length;

    // Pozíció trend
    const half = Math.max(1, Math.floor(timeline.length / 2));
    const earlyPos = timeline.slice(0, half).reduce((s, t) => s + t.pos, 0) / half;
    const latePos  = timeline.slice(-half).reduce((s, t) => s + t.pos, 0) / half;
    const trend = latePos < earlyPos - 1 ? 'up' : latePos > earlyPos + 1 ? 'down' : 'same';

    // W/D/L
    const wins   = gains.filter(g => g >= 3).length;
    const draws  = gains.filter(g => g === 1).length;
    const losses = gains.filter(g => g === 0).length;
    const total  = wins + draws + losses;

    // Elo bónusz forma alapján: 1.5 pt/forduló az átlag
    const eloBonus = Math.round((last5Avg - 1.5) * 20);

    forms[name] = {
      last5Avg:  Math.round(last5Avg * 100) / 100,
      avgGF5:    Math.round(avgGF5   * 10)  / 10,
      avgGA5:    Math.round(avgGA5   * 10)  / 10,
      trend,
      winRate:   total ? Math.round(wins   / total * 100) : 0,
      drawRate:  total ? Math.round(draws  / total * 100) : 0,
      lossRate:  total ? Math.round(losses / total * 100) : 0,
      eloBonus:  Math.max(-80, Math.min(80, eloBonus)), // -80..+80 korlátoz
      snapCount: timeline.length,
    };
  }
  return forms;
}

// ─── Standings kiválasztása (valós > AI) ─────────────────────────────────────
function pickBestStandings(realStandings, aiStandings) {
  // Ha a valós tabella rendelkezésre áll és elég csapatot tartalmaz, azt használjuk
  if (realStandings && realStandings.length >= 8) {
    return { standings: realStandings, source: 'real' };
  }
  // Ha AI tabella van
  if (aiStandings && aiStandings.length >= 8) {
    return { standings: aiStandings, source: 'ai' };
  }
  // Ha egyik sem elég jó, kombináljuk
  const combined = [...(realStandings || []), ...(aiStandings || [])];
  const seen = new Set();
  const unique = combined.filter(t => {
    if (seen.has(t.team)) return false;
    seen.add(t.team);
    return true;
  });
  return { standings: unique, source: 'combined' };
}

// ─── FŐ SZÁMÍTÁS – kizárólag ez adja a %-okat ────────────────────────────────
function calcMatch(home, away, standings, forms) {
  const n      = standings.length || 12;
  const maxPts = Math.max(...standings.map(t => t.pts || 0), 1);

  const sH = standings.find(t => t.team === home);
  const sA = standings.find(t => t.team === away);
  const fH = forms[home];
  const fA = forms[away];

  // Ha a csapat nem szerepel a tabellán, középmezőny-szerű értéket kap
  const posH = sH?.pos  ?? Math.ceil(n * 0.5);
  const posA = sA?.pos  ?? Math.ceil(n * 0.5);
  const ptsH = sH?.pts  ?? Math.round(maxPts * 0.45);
  const ptsA = sA?.pts  ?? Math.round(maxPts * 0.45);

  const eloH_base = teamElo(posH, ptsH, n, maxPts, fH?.eloBonus ?? 0);
  const eloA_base = teamElo(posA, ptsA, n, maxPts, fA?.eloBonus ?? 0);

  // Hazai pálya bónusz csak a hazai csapatnak
  const eloH = eloH_base + HOME_ELO_BONUS;
  const eloA = eloA_base;

  // Erőkülönbség hazai pálya nélkül (pozíció alapú összehasonlításhoz)
  const eloDiff = eloH_base - eloA_base;

  // Győzelem valószínűségek
  const rawH = eloWinProb(eloH, eloA);
  const rawA = eloWinProb(eloA, eloH);

  // Döntetlen ráta: minél nagyobb az Elo-különbség, annál kisebb
  // |diff|=0 → 27%, |diff|=200 → 18%, |diff|=400 → 9%
  const dr   = Math.max(0.07, Math.min(0.28, 0.28 - (Math.abs(eloDiff) / 400) * 0.19));
  const pool = 1 - dr;

  // Nyers %-ok
  let h = Math.round(rawH * pool * 100);
  let a = Math.round(rawA * pool * 100);
  let d = Math.round(dr   * 100);

  // Min 7% mindenhol
  h = Math.max(h, 7);
  a = Math.max(a, 7);
  d = Math.max(d, 7);

  // Normalizálás → összeg = 100
  const sum = h + d + a;
  h = Math.round(h / sum * 100);
  d = Math.round(d / sum * 100);
  a = 100 - h - d;
  if (a < 7) { a = 7; h = 100 - d - a; }

  // xG becslés
  // Ha van history forma: azt használjuk
  // Ha nem: goalsFor / (n * 2) alapú becslés, de legalább 1.2 / mérkőzés
  const totalGoalsAvg = n > 0 ? maxPts * 0.5 / n : 2.0; // durva átlag
  const xGH = fH?.avgGF5 ?? (sH?.goalsFor  ? sH.goalsFor  / Math.max(n * 1.8, 1) : Math.max(totalGoalsAvg * 0.55, 1.2));
  const xGA = fA?.avgGF5 ?? (sA?.goalsFor  ? sA.goalsFor  / Math.max(n * 1.8, 1) : Math.max(totalGoalsAvg * 0.55, 1.2));
  const xG  = Math.max(xGH + xGA, 1.5);

  const over15 = overXGoalsPct(xG, 1);
  const over25 = overXGoalsPct(xG, 2);

  return {
    homePct:   h,
    drawPct:   d,
    awayPct:   a,
    over15Pct: over15,
    over25Pct: over25,
    // Debug meta az AI szöveghez
    _eloH:    eloH_base,
    _eloA:    eloA_base,
    _eloDiff: Math.round(eloDiff),
    _xG:      Math.round(xG * 100) / 100,
    _posH:    posH,
    _posA:    posA,
    _ptsH:    ptsH,
    _ptsA:    ptsA,
    _fH:      fH,
    _fA:      fA,
    _n:       n,
  };
}

// ─── AI: CSAK szöveges elemzést kér, számokat NEM ────────────────────────────
async function getAIAnalysis(matches, calcResults, forms) {
  const matchLines = matches.map((m, i) => {
    const c   = calcResults[i];
    const fav = c.homePct >= c.awayPct ? m.home : m.away;
    const diff = Math.abs(c._eloDiff);
    const label = diff > 300 ? 'nagy erőfölény'
      : diff > 150 ? 'közepes különbség' : 'kiegyenlített';

    const lines = [
      `MECCS ${i+1}: ${m.home} (HAZAI, ${c._posH}.hely, ${c._ptsH}pt, Elo=${c._eloH}) vs ${m.away} (VENDÉG, ${c._posA}.hely, ${c._ptsA}pt, Elo=${c._eloA})`,
      `  → Favorit: ${fav} | Különbség: ${label} (Elo ${diff}) | Számított esélyek: ${c.homePct}% / ${c.drawPct}% / ${c.awayPct}%`,
      `  → Gól: xG≈${c._xG}, Over1.5=${c.over15Pct}%, Over2.5=${c.over25Pct}%`,
    ];

    if (c._fH) lines.push(`  → ${m.home} forma (${c._fH.snapCount} forduló): ${c._fH.trend==='up'?'↑emelkedő':c._fH.trend==='down'?'↓eső':'→stabil'}, W/D/L=${c._fH.winRate}%/${c._fH.drawRate}%/${c._fH.lossRate}%, utolsó5=${c._fH.last5Avg}pt/kör, gól${c._fH.avgGF5}:${c._fH.avgGA5}`);
    if (c._fA) lines.push(`  → ${m.away} forma (${c._fA.snapCount} forduló): ${c._fA.trend==='up'?'↑emelkedő':c._fA.trend==='down'?'↓eső':'→stabil'}, W/D/L=${c._fA.winRate}%/${c._fA.drawRate}%/${c._fA.lossRate}%, utolsó5=${c._fA.last5Avg}pt/kör, gól${c._fA.avgGF5}:${c._fA.avgGA5}`);

    return lines.join('\n');
  }).join('\n\n');

  const prompt = `Te egy virtuális futball kommentátor vagy. Az esélyek MATEMATIKAILAG vannak kiszámítva – te csak SZÖVEGES elemzést írj magyarul minden meccshez.

${matchLines}

Adj vissza KIZÁRÓLAG valid JSON tömböt, pontosan ${matches.length} elemmel:
[
  {
    "over15Comment": "1 mondat az xG alapján – miért várható sok/kevés gól",
    "over25Comment": "1 mondat – 2.5 gól feletti valószínűségről",
    "analysis": "2-3 mondat – ki az esélyes, miért, tabella pozíció + forma alapján"
  }
]

NE írj százalékokat a szövegbe. Csak magyarázatot.`;

  // 1. LLM7 próba
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.35,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(22000),
    });
    if (res.ok) {
      const data  = await res.json();
      const txt   = data.choices?.[0]?.message?.content || '';
      const clean = txt.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const m     = clean.match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr) && arr.length === matches.length) return arr;
      }
    }
  } catch (e) {
    console.warn('[match-tips] LLM7 hiba:', e.message);
  }

  // 2. Anthropic fallback
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(22000),
      });
      if (res.ok) {
        const data  = await res.json();
        const txt   = data.content?.[0]?.text || '';
        const clean = txt.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const m     = clean.match(/\[[\s\S]*\]/);
        if (m) {
          const arr = JSON.parse(m[0]);
          if (Array.isArray(arr) && arr.length === matches.length) return arr;
        }
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic hiba:', e.message);
    }
  }

  return null;
}

// ─── Fallback szöveg ──────────────────────────────────────────────────────────
function fallbackText(m, c) {
  const fav   = c.homePct >= c.awayPct ? m.home : m.away;
  const diff  = Math.abs(c._eloDiff);
  const label = diff > 300 ? 'nagy erőfölénnyel' : diff > 150 ? 'közepes előnnyel' : 'kis előnnyel';
  const formH = c._fH ? ` ${m.home} formája ${c._fH.trend === 'up' ? 'emelkedő' : c._fH.trend === 'down' ? 'eső' : 'stabil'} (utolsó 5 kör: ${c._fH.last5Avg}pt/meccs).` : '';
  const formA = c._fA ? ` ${m.away} formája ${c._fA.trend === 'up' ? 'emelkedő' : c._fA.trend === 'down' ? 'eső' : 'stabil'}.` : '';
  return {
    over15Comment: c.over15Pct >= 62
      ? `xG≈${c._xG} – mindkét csapat gólgazdag formában van, valószínű az 1.5 gól felett.`
      : `xG≈${c._xG} – alacsony gólszám várható, szoros taktikai mérkőzés.`,
    over25Comment: c.over25Pct >= 55
      ? '3 vagy több gól valószínű, mindkét csapat aktívan támad.'
      : 'Kevesebb mint 3 gól várható, inkább zárt mérkőzés.',
    analysis: `${fav} az esélyes ${label} – ${c._posH}. vs ${c._posA}. hely a tabellán (${c._ptsH} vs ${c._ptsA} pont, Elo-különbség: ${diff}).${formH}${formA}`,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { matches, standings: realStandings, aiPrediction, history: clientHistory, seasonId } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches' }), { status: 400, headers: corsHeaders });
    }

    // ── 1. Standings összeállítása: valós > AI ──────────────────────────────
    const aiStandings = aiPrediction?.standings || [];
    const { standings, source: standingsSource } = pickBestStandings(realStandings, aiStandings);

    // ── 2. History: kliens + KV (összefésülve, duplikáció nélkül) ──────────
    // Mindig betöltjük a KV-ból is hogy minden forduló benne legyen
    const kvHistory = await loadHistoryFromKV(seasonId || aiPrediction?.seasonId);
    
    // Kliens history + KV history összefésülése fingerprint alapján
    const allHistory = [...(clientHistory || [])];
    const clientFPs  = new Set(allHistory.map(e => e.fingerprint).filter(Boolean));
    
    for (const entry of kvHistory) {
      if (!clientFPs.has(entry.fingerprint)) {
        allHistory.push(entry);
      }
    }

    // Rendezés: legújabb először
    allHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log(`[match-tips] standings=${standings.length}(${standingsSource}), history=${allHistory.length}(client:${clientHistory?.length||0}+kv:${kvHistory.length})`);

    // ── 3. Forma feldolgozás az összes history alapján ──────────────────────
    const forms = buildForms(allHistory);

    // ── 4. Matematikai számítás – ez adja a végleges %-okat ────────────────
    const calcResults = matches.map(m => calcMatch(m.home, m.away, standings, forms));

    // Debug log: ellenőrzés
    calcResults.forEach((c, i) => {
      console.log(`[match-tips] ${matches[i].home}(${c._posH}./${c._ptsH}pt Elo${c._eloH}) vs ${matches[i].away}(${c._posA}./${c._ptsA}pt Elo${c._eloA}) → ${c.homePct}/${c.drawPct}/${c.awayPct}`);
    });

    // ── 5. AI szöveges elemzés ──────────────────────────────────────────────
    const aiTexts = await getAIAnalysis(matches, calcResults, forms);

    // ── 6. Összerakás ───────────────────────────────────────────────────────
    const results = matches.map((m, i) => {
      const c   = calcResults[i];
      const txt = aiTexts?.[i] || fallbackText(m, c);
      return {
        home:     m.home,
        away:     m.away,
        homePct:  c.homePct,
        drawPct:  c.drawPct,
        awayPct:  c.awayPct,
        over15Pct: c.over15Pct,
        over25Pct: c.over25Pct,
        over15Comment: txt.over15Comment || fallbackText(m, c).over15Comment,
        over25Comment: txt.over25Comment || fallbackText(m, c).over25Comment,
        analysis:      txt.analysis      || fallbackText(m, c).analysis,
      };
    });

    return new Response(JSON.stringify({
      results,
      source:          aiTexts ? 'ai-text' : 'fallback-text',
      standingsSource,
      historyUsed:     allHistory.length,
      formsAvailable:  Object.keys(forms).length,
      count:           results.length,
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error('[match-tips] FATAL:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
