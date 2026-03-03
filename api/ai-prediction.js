// api/ai-prediction.js – v5: okos, precíz szezonvégi előrejelzés
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AI_KEY      = 'vsport:ai_prediction';
const AI_META_KEY = 'vsport:ai_meta';
const LLM7_URL    = 'https://api.llm7.io/v1/chat/completions';
const LLM7_KEY    = '/WF1cs8NieiVJAvBfBR+n5Fb/vxRW1oSmv3EqtTSTRxWQBGMexqcI4Xivs+BqTXfNYMZI8OUFZpv5YAA0FOjcumYWgcG8AkhePVVO8zCVKQo3GMYfArXw2yPPKY7w3tRvofNvQ==';

// ─── KV helpers ──────────────────────────────────────────────────────────────
function kvUrl(path) {
  const base = process.env.KV_REST_API_URL;
  if (!base) throw new Error('KV_REST_API_URL nincs beállítva');
  return `${base}${path}`;
}
function kvHeaders() {
  const token = process.env.KV_REST_API_TOKEN;
  if (!token) throw new Error('KV_REST_API_TOKEN nincs beállítva');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function kvGet(key) {
  try {
    const res = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), {
      headers: kvHeaders(), signal: AbortSignal.timeout(8000),
    });
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
async function kvSet(key, value) {
  const res = await fetch(kvUrl('/pipeline'), {
    method: 'POST', headers: kvHeaders(),
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KV SET hiba: ${res.status}`);
  return true;
}

function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ─── Elo modell – ugyanaz mint match-tips.js-ben ────────────────────────────
function teamElo(pos, pts, totalTeams, maxPts) {
  const posScore = ((totalTeams - pos) / Math.max(totalTeams - 1, 1)) * 600;
  const ptsScore = maxPts > 0 ? (pts / maxPts) * 300 : 0;
  return Math.round(1000 + posScore + ptsScore);
}

// ─── History feldolgozás – per-csapat részletes statisztikák ────────────────
async function getHistoryData(seasonId) {
  try {
    const key = seasonId ? `vsport:league_history:season:${seasonId}` : 'vsport:league_history';
    let raw = await kvGet(key);
    if (!raw && key !== 'vsport:league_history') raw = await kvGet('vsport:league_history');
    if (!raw) return null;

    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || !entries.length) return null;

    // ── Per-csapat teljes statisztika ──────────────────────────────────────
    const teamData = {};

    for (const entry of entries) {
      const snap = entry.standingsSnapshot || [];
      for (const t of snap) {
        if (!teamData[t.team]) teamData[t.team] = [];
        teamData[t.team].push({
          ts:           new Date(entry.timestamp).getTime(),
          pos:          t.pos,
          pts:          t.pts || 0,
          goalsFor:     t.goalsFor || 0,
          goalsAgainst: t.goalsAgainst || 0,
          gd:           (t.goalsFor || 0) - (t.goalsAgainst || 0),
        });
      }
    }

    // Rendezés időrendben (legrégebbi először)
    for (const team of Object.keys(teamData)) {
      teamData[team].sort((a, b) => a.ts - b.ts);
    }

    // ── Statisztikák kiszámítása ───────────────────────────────────────────
    const stats = {};
    for (const [team, history] of Object.entries(teamData)) {
      if (history.length < 1) continue;

      const n     = history.length;
      const first = history[0];
      const last  = history[n - 1];

      // Pont per forduló
      const ptsGains = [];
      for (let i = 1; i < n; i++) ptsGains.push(history[i].pts - history[i - 1].pts);
      const avgPtsPerRound = ptsGains.length
        ? ptsGains.reduce((a, b) => a + b, 0) / ptsGains.length : 0;

      // Utolsó 5 forduló forma
      const last5 = ptsGains.slice(-5);
      const last5Avg = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : avgPtsPerRound;

      // Gólátlagok
      const avgGF = history.reduce((s, h) => s + h.goalsFor, 0)     / n;
      const avgGA = history.reduce((s, h) => s + h.goalsAgainst, 0) / n;

      // Utolsó 5 forduló góljai
      const last5snaps = history.slice(-5);
      const last5GF = last5snaps.reduce((s, h) => s + h.goalsFor, 0) / last5snaps.length;
      const last5GA = last5snaps.reduce((s, h) => s + h.goalsAgainst, 0) / last5snaps.length;

      // Pozíció trend (javult/romlott)
      const posChange   = first.pos - last.pos; // pozitív = javult
      const ptsGrowth   = last.pts - first.pts;

      // Trend iránya: utolsó 1/3 vs első 1/3
      let recentTrend = 'stagnáló';
      if (n >= 6) {
        const third   = Math.floor(n / 3);
        const earlyAvg = history.slice(0, third).reduce((s, h) => s + h.pos, 0) / third;
        const lateAvg  = history.slice(-third).reduce((s, h) => s + h.pos, 0)  / third;
        if (lateAvg < earlyAvg - 1.5)      recentTrend = 'erősen emelkedő';
        else if (lateAvg < earlyAvg - 0.5) recentTrend = 'emelkedő';
        else if (lateAvg > earlyAvg + 1.5) recentTrend = 'erősen eső';
        else if (lateAvg > earlyAvg + 0.5) recentTrend = 'eső';
      } else if (posChange > 1) recentTrend = 'emelkedő';
      else if (posChange < -1)  recentTrend = 'eső';

      // Win/Draw/Loss arány (ha van elég adat)
      const wins   = ptsGains.filter(g => g >= 3).length;
      const draws  = ptsGains.filter(g => g === 1).length;
      const losses = ptsGains.filter(g => g === 0).length;

      stats[team] = {
        snapCount:      n,
        firstPos:       first.pos,  lastPos: last.pos,
        firstPts:       first.pts,  lastPts: last.pts,
        posChange,      ptsGrowth,
        avgPtsPerRound: Math.round(avgPtsPerRound * 100) / 100,
        last5Avg:       Math.round(last5Avg       * 100) / 100,
        avgGF:          Math.round(avgGF * 10)  / 10,
        avgGA:          Math.round(avgGA * 10)  / 10,
        last5GF:        Math.round(last5GF * 10) / 10,
        last5GA:        Math.round(last5GA * 10) / 10,
        recentTrend,
        wins, draws, losses,
        winRate: ptsGains.length ? Math.round((wins / ptsGains.length) * 100) : 0,
      };
    }

    return { stats, entryCount: entries.length };
  } catch (e) {
    console.warn('[getHistoryData]', e.message);
    return null;
  }
}

// ─── Szezon extrapoláció számítása ──────────────────────────────────────────
function calcExtrapolation(standings, histData) {
  const totalTeams    = standings.length;
  const maxPts        = Math.max(...standings.map(t => t.pts || 0), 1);
  const totalCurrentPts = standings.reduce((s, t) => s + (t.pts || 0), 0);

  // Becsüljük a lejátszott fordulók számát
  // Egy fordulóban minden csapat játszik egyszer: totalPts = rounds * teams * 2 (kb, győzelmi pontok)
  // Pontosabb: átlagos pont/csapat / 2 = hozzávetőleges lejátszott fordulók
  const avgPtsPerTeam    = totalCurrentPts / Math.max(totalTeams, 1);
  const estRoundsPlayed  = Math.max(1, Math.round(avgPtsPerTeam / 2));
  const TOTAL_ROUNDS     = 34;
  const estRoundsLeft    = Math.max(0, TOTAL_ROUNDS - estRoundsPlayed);
  const extrapolFactor   = TOTAL_ROUNDS / Math.max(estRoundsPlayed, 1);

  return { estRoundsPlayed, estRoundsLeft, extrapolFactor, totalCurrentPts, avgPtsPerTeam };
}

// ─── AI hívás ────────────────────────────────────────────────────────────────
async function callAI(systemPrompt, userPrompt, temp = 0.2) {
  const res = await fetch(LLM7_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM7_KEY}` },
    body: JSON.stringify({
      model: 'default',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      temperature: temp,
      max_tokens: 2500,
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`LLM7 hiba: ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

// ─── Főgenerátor ─────────────────────────────────────────────────────────────
async function generatePrediction(standings, seasonId) {
  const totalTeams = standings.length;
  const maxPts     = Math.max(...standings.map(t => t.pts || 0), 1);
  const histData   = await getHistoryData(seasonId);
  const { estRoundsPlayed, estRoundsLeft, extrapolFactor } = calcExtrapolation(standings, histData);

  // ── 1. Tabella kontextus az AI-nak ────────────────────────────────────────
  const currentTable = standings.map(t => {
    const elo    = teamElo(t.pos, t.pts || 0, totalTeams, maxPts);
    const gd     = (t.goalsFor || 0) - (t.goalsAgainst || 0);
    const hist   = histData?.stats?.[t.team];
    const histLine = hist
      ? ` | forma: ${hist.recentTrend} | utolsó 5 forduló: ${hist.last5Avg}pt/forduló | W/D/L: ${hist.wins}/${hist.draws}/${hist.losses} | gólátlag: ${hist.avgGF}:${hist.avgGA} (utolsó 5: ${hist.last5GF}:${hist.last5GA})`
      : '';
    return `${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${String(t.pts || 0).padStart(3)}pt  GF:${String(t.goalsFor || 0).padStart(3)}  GA:${String(t.goalsAgainst || 0).padStart(3)}  GD:${String(gd).padStart(4)}  Elo:${elo}${histLine}`;
  }).join('\n');

  // ── 2. History összefoglaló ────────────────────────────────────────────────
  let histSummary = 'Nincs history adat – az aktuális tabella alapján becsülj.';
  if (histData && histData.entryCount > 0) {
    const lines = Object.entries(histData.stats)
      .sort((a, b) => (a[1].lastPos || 99) - (b[1].lastPos || 99))
      .map(([team, s]) => {
        const posStr = s.posChange > 0 ? `↑${s.posChange}` : s.posChange < 0 ? `↓${Math.abs(s.posChange)}` : '→';
        return `  ${team}: trend=${s.recentTrend}, pozíció ${s.firstPos}→${s.lastPos}(${posStr}), winRate=${s.winRate}%, utolsó5=${s.last5Avg}pt/forduló, gól${s.last5GF}:${s.last5GA}`;
      }).join('\n');
    histSummary = `${histData.entryCount} forduló rögzítve.\nPer-csapat összefoglaló:\n${lines}`;
  }

  // ── 3. Matematikai referenciaértékek ─────────────────────────────────────
  // Extrapolált pont becslés trend alapján
  const mathRef = standings.map(t => {
    const hist     = histData?.stats?.[t.team];
    const basePts  = t.pts || 0;
    // Alap extrapoláció
    let projPts = Math.round(basePts * extrapolFactor);
    // Trend módosítás
    if (hist) {
      const trendMod = hist.recentTrend.includes('erősen emelkedő') ? 1.15
        : hist.recentTrend.includes('emelkedő') ? 1.07
        : hist.recentTrend.includes('erősen eső') ? 0.87
        : hist.recentTrend.includes('eső')         ? 0.93 : 1.0;
      // Ha van last5Avg, finomabb becslés
      const last5Pts = hist.last5Avg * estRoundsLeft;
      projPts = Math.round(basePts + last5Pts * trendMod);
    }
    return { team: t.team, currentPts: basePts, projPts, currentPos: t.pos };
  }).sort((a, b) => b.projPts - a.projPts);

  const mathRefStr = mathRef.map((t, i) =>
    `${i + 1}. ${t.team}: jelenlegi ${t.currentPts}pt → becsült szezonvégi ${t.projPts}pt (mostani hely: ${t.currentPos}.)`
  ).join('\n');

  // ── 4. Prompt ─────────────────────────────────────────────────────────────
  const systemPrompt = `Te egy virtuális futball liga profi statisztikusa vagy. Feladatod precíz, trend-alapú szezonvégi tabella előrejelzés készítése.

ALAPELVEK:
- A jelenlegi tabella és a history trend adatok EGYÜTT határozzák meg az előrejelzést
- Az emelkedő csapatok végezzenek előrébb, az eső csapatok hátrább
- A matematikai referenciától max ±3 hellyel térhetsz el, ha azt a trend indokolja
- A pontok legyenek realisztikusan extrapolálva (ne maradjanak azonosak az aktuálisal)
- Mindig valid JSON tömböt adj vissza, semmi mást`;

  const userPrompt = `AKTUÁLIS TABELLA (${totalTeams} csapat, kb. ${estRoundsPlayed} forduló játszva, ~${estRoundsLeft} van hátra):
${currentTable}

HISTORY ADATOK:
${histSummary}

MATEMATIKAI REFERENCIA (extrapoláció + trend alapján):
${mathRefStr}

FELADAT: Adj pontos szezonvégi előrejelzést. A végső sorrend TÜKRÖZZE a trendeket.

KÖTELEZŐ SZABÁLYOK:
1. Pontosan ${totalTeams} csapat szerepeljen
2. A pontszámok legyenek magasabbak az aktuálisnál (extrapolált szezonvégi értékek)
3. Az "erősen emelkedő" / "emelkedő" csapatok kerüljenek előrébb mint most
4. Az "erősen eső" / "eső" csapatok kerüljenek hátrább mint most
5. A gólstatisztikák is legyenek extrapolálva arányosan
6. trend mező: "up" ha a csapat javít helyezésén a szezon végéig, "down" ha romlik, "same" ha marad

Válaszolj KIZÁRÓLAG valid JSON tömbbel – semmi más szöveg, magyarázat, prefix:
[{"pos":1,"team":"Csapatnév","goalsFor":85,"goalsAgainst":32,"pts":91,"trend":"up"},...]`;

  const text  = await callAI(systemPrompt, userPrompt, 0.15);
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('[');
  if (start === -1) throw new Error('JSON nem található az AI válaszban');

  let depth = 0, end = start;
  for (; end < clean.length; end++) {
    if (clean[end] === '[') depth++;
    else if (clean[end] === ']') { depth--; if (depth === 0) break; }
  }

  let aiStandings = JSON.parse(clean.slice(start, end + 1)).map((r, i) => ({
    pos:          parseInt(String(r.pos || (i + 1))),
    team:         String(r.team || '–'),
    goalsFor:     parseInt(String(r.goalsFor  ?? 0)) || 0,
    goalsAgainst: parseInt(String(r.goalsAgainst ?? 0)) || 0,
    pts:          parseInt(String(r.pts ?? 0)) || 0,
    trend:        String(r.trend || 'same'),
  }));

  if (!aiStandings.length) throw new Error('Üres AI tabella');

  // ── Ellenőrzés: extrapolált-e rendesen? ───────────────────────────────────
  const totalAIPts   = aiStandings.reduce((s, t) => s + t.pts, 0);
  const totalRealPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  if (totalRealPts > 0 && totalAIPts / totalRealPts < 1.05 && estRoundsLeft > 5) {
    // Az AI nem extrapolált – alkalmazzuk a matematikai referenciát
    console.warn('[ai-prediction] AI nem extrapolált rendesen – referencia alkalmazva');
    aiStandings = mathRef.map((ref, i) => {
      const orig = aiStandings.find(t => t.team === ref.team) || aiStandings[i] || {};
      const hist  = histData?.stats?.[ref.team];
      const scaleFactor = totalRealPts > 0 ? ref.projPts / Math.max(standings.find(t => t.team === ref.team)?.pts || 1, 1) : extrapolFactor;
      const origTeam    = standings.find(t => t.team === ref.team);
      return {
        pos:          i + 1,
        team:         ref.team,
        goalsFor:     Math.round((origTeam?.goalsFor     || 50) * (extrapolFactor * 0.95)),
        goalsAgainst: Math.round((origTeam?.goalsAgainst || 40) * (extrapolFactor * 0.95)),
        pts:          ref.projPts,
        trend:        orig.trend || (hist ? (hist.recentTrend.includes('emelkedő') ? 'up' : hist.recentTrend.includes('eső') ? 'down' : 'same') : 'same'),
      };
    });
  }

  // ── Rendezés és pozíció újraszámítás ────────────────────────────────────
  aiStandings.sort((a, b) => b.pts - a.pts);
  aiStandings.forEach((t, i) => { t.pos = i + 1; });

  // ── Elemzés generálása ──────────────────────────────────────────────────
  const top3    = aiStandings.slice(0, 3).map(t   => `${t.pos}. ${t.team} (${t.pts}pt, trend: ${t.trend})`).join(', ');
  const bottom3 = aiStandings.slice(-3).map(t     => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const risers  = aiStandings.filter(t => t.trend === 'up').map(t   => `${t.team}(${standings.find(s=>s.team===t.team)?.pos||'?'}→${t.pos})`).join(', ') || 'nincs';
  const fallers = aiStandings.filter(t => t.trend === 'down').map(t => `${t.team}(${standings.find(s=>s.team===t.team)?.pos||'?'}→${t.pos})`).join(', ') || 'nincs';

  const analysisPrompt = `Írj rövid, tömör elemzést MAGYARUL (4-5 mondat). Hivatkozz konkrét csapatokra, trendekre, számokra.

Szezonvégi előrejelzés:
- Top 3: ${top3}
- Kiesők: ${bottom3}
- Emelkedők (jelenlegi hely → várható): ${risers}
- Esők: ${fallers}
- History: ${histData ? `${histData.entryCount} forduló adat` : 'nincs history'}
- Hátralevő fordulók: ~${estRoundsLeft}

Miért éppen így alakul a szezon vége? Mi a kulcstényező az éllovas és a kiesők esetén?`;

  const analysis = await callAI(
    'Te egy futball kommentátor vagy. Tömör, informatív elemzéseket írsz magyarul.',
    analysisPrompt,
    0.4
  );

  return {
    standings:            aiStandings,
    analysis:             analysis.trim(),
    generatedAt:          new Date().toISOString(),
    basedOnFingerprint:   fingerprint(standings),
    seasonId:             seasonId || null,
    estRoundsPlayed,
    estRoundsLeft,
    hasHistoryData:       !!(histData && histData.entryCount > 0),
    historyEntryCount:    histData?.entryCount || 0,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method === 'GET') {
      const rawPred = await kvGet(AI_KEY);
      const rawMeta = await kvGet(AI_META_KEY);
      let prediction = null, meta = null;
      if (rawPred) { try { prediction = JSON.parse(rawPred); } catch {} }
      if (rawMeta) { try { meta = JSON.parse(rawMeta); }       catch {} }
      return new Response(JSON.stringify({ prediction, meta, hasData: !!prediction }), {
        status: 200, headers: corsHeaders,
      });
    }

    if (req.method === 'POST') {
      const { standings, seasonId, force } = await req.json();
      if (!standings?.length) {
        return new Response(JSON.stringify({ error: 'Hiányzó standings' }), { status: 400, headers: corsHeaders });
      }

      const currentFP = fingerprint(standings);

      if (!force) {
        const rawMeta = await kvGet(AI_META_KEY);
        if (rawMeta) {
          let meta = null;
          try { meta = JSON.parse(rawMeta); } catch {}
          if (meta) {
            const seasonChanged = seasonId && meta.seasonId && String(seasonId) !== String(meta.seasonId);
            if (!seasonChanged && meta.basedOnFingerprint === currentFP) {
              const rawPred = await kvGet(AI_KEY);
              if (rawPred) {
                let prediction = null;
                try { prediction = JSON.parse(rawPred); } catch {}
                if (prediction) return new Response(JSON.stringify({ prediction, meta, regenerated: false, reason: 'already_current' }), { status: 200, headers: corsHeaders });
              }
            }
          }
        }
      }

      console.log('[ai-prediction] Generating... force=', force, 'seasonId=', seasonId);
      const prediction = await generatePrediction(standings, seasonId);

      await kvSet(AI_KEY,      JSON.stringify(prediction));
      await kvSet(AI_META_KEY, JSON.stringify({
        generatedAt:         prediction.generatedAt,
        basedOnFingerprint:  prediction.basedOnFingerprint,
        seasonId:            prediction.seasonId,
      }));

      return new Response(JSON.stringify({ prediction, regenerated: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });

  } catch (err) {
    console.error('[ai-prediction]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
