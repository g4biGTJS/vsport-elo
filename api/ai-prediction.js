// api/ai-prediction.js – v4: valós tabella alapú, nem rendezi át véletlenszerűen
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
  const res = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), {
    headers: kvHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    return null;
  }
  const data = await res.json();
  const result = data.result ?? null;
  if (result === null || result === undefined) return null;
  if (typeof result === 'object' && result !== null && result.value !== undefined)
    return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  if (typeof result === 'object') return JSON.stringify(result);
  return String(result);
}

async function kvSet(key, value) {
  const res = await fetch(kvUrl('/pipeline'), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => String(res.status));
    throw new Error(`KV SET hiba: ${res.status} – ${errText}`);
  }
  return true;
}

function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

async function callAI(prompt, temp = 0.5) {
  const res = await fetch(LLM7_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM7_KEY}` },
    body: JSON.stringify({
      model: 'default',
      messages: [{ role: 'user', content: prompt }],
      temperature: temp,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(35000),
  });
  if (!res.ok) throw new Error(`LLM7 hiba: ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

// ── History context ───────────────────────────────────────────────────────────
async function getHistoryContext(seasonId) {
  try {
    const key = seasonId
      ? `vsport:league_history:season:${seasonId}`
      : 'vsport:league_history';

    let raw = await kvGet(key);
    if (!raw && key !== 'vsport:league_history') {
      raw = await kvGet('vsport:league_history');
    }
    if (!raw) return { context: '', entryCount: 0, teamStats: {} };

    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || !entries.length) return { context: '', entryCount: 0, teamStats: {} };

    // Per-csapat trend számítás
    const teamHistory = {};
    for (const entry of entries) {
      const snap = entry.standingsSnapshot || [];
      for (const t of snap) {
        if (!teamHistory[t.team]) teamHistory[t.team] = [];
        teamHistory[t.team].push({ pos: t.pos, pts: t.pts, goalsFor: t.goalsFor || 0, goalsAgainst: t.goalsAgainst || 0 });
      }
    }

    const teamStats = {};
    for (const [team, history] of Object.entries(teamHistory)) {
      if (history.length < 2) {
        const only = history[0] || {};
        teamStats[team] = { posChange: 0, ptsGrowthPerRound: 0, trend: 'same', dataPoints: history.length };
        continue;
      }
      const first = history[0];
      const last  = history[history.length - 1];
      const posChange  = first.pos - last.pos;
      const ptsGrowth  = last.pts - first.pts;
      const rounds     = history.length;

      let recentTrend = 'same';
      if (history.length >= 4) {
        const mid = Math.floor(history.length / 2);
        const recentAvgPos  = history.slice(mid).reduce((s, h) => s + h.pos, 0) / (history.length - mid);
        const earlierAvgPos = history.slice(0, mid).reduce((s, h) => s + h.pos, 0) / mid;
        if (recentAvgPos < earlierAvgPos - 1)      recentTrend = 'up';
        else if (recentAvgPos > earlierAvgPos + 1) recentTrend = 'down';
      } else {
        if (posChange > 1)       recentTrend = 'up';
        else if (posChange < -1) recentTrend = 'down';
      }

      teamStats[team] = {
        posChange,
        ptsGrowthPerRound: rounds > 1 ? +(ptsGrowth / (rounds - 1)).toFixed(2) : 0,
        trend: recentTrend,
        dataPoints: rounds,
      };
    }

    const recent = entries.slice(0, 4);
    const roundLines = recent.map((e, idx) => {
      const snap = e.standingsSnapshot || [];
      const standingsStr = snap.length
        ? snap.map(t => `    ${String(t.pos).padStart(2)}. ${t.team}: ${t.pts}pt`).join('\n')
        : '';
      return `\n  [${idx === 0 ? 'LEGUTÓBBI' : `${idx + 1}. korábbi`}]\n${standingsStr}`;
    });

    const teamSummaryLines = Object.entries(teamStats)
      .map(([team, s]) => {
        const trendStr = s.trend === 'up' ? 'EMELKEDŐ' : s.trend === 'down' ? 'ESŐ' : 'STAGNÁLÓ';
        return `    ${team}: ${trendStr} | ${s.ptsGrowthPerRound > 0 ? '+' : ''}${s.ptsGrowthPerRound} pt/forduló trend | ${s.dataPoints} mérés`;
      }).join('\n');

    const context = `
═══ HISTORY TRENDEK (${entries.length} forduló) ═══
${teamSummaryLines}

UTOLSÓ FORDULÓK:
${roundLines.join('\n')}
═══ VÉGE ═══
`;
    return { context, entryCount: entries.length, teamStats };
  } catch (e) {
    console.warn('[getHistoryContext]', e.message);
    return { context: '', entryCount: 0, teamStats: {} };
  }
}

// ── AI generálás – valós tabella alapú ────────────────────────────────────────
async function generatePrediction(standings, seasonId) {
  const { context: historyContext, entryCount, teamStats } = await getHistoryContext(seasonId);

  const totalPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const estimatedRoundsTotal  = 34;
  const estimatedRoundsPlayed = totalPts > 0
    ? Math.round(totalPts / Math.max(1, standings.length) / 2)
    : 1;
  const estimatedRoundsLeft = Math.max(2, estimatedRoundsTotal - estimatedRoundsPlayed);
  const multiplier = Math.min(3.0, estimatedRoundsTotal / Math.max(1, estimatedRoundsPlayed));

  // ── VALÓS TABELLA MINT ALAP – az AI csak kis módosításokat tehet ──────────
  const baseStandings = standings
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map(t => {
      const stat = teamStats[t.team];
      const trendMod = stat
        ? (stat.trend === 'up' ? 1.08 : stat.trend === 'down' ? 0.93 : 1.0)
        : 1.0;
      return {
        team:         t.team,
        currentPos:   t.pos,
        currentPts:   t.pts || 0,
        currentGF:    t.goalsFor || 0,
        currentGA:    t.goalsAgainst || 0,
        projectedPts: Math.round((t.pts || 0) * multiplier * trendMod),
        projectedGF:  Math.round((t.goalsFor || 0) * multiplier * (stat?.trend === 'up' ? 1.06 : 1.0)),
        projectedGA:  Math.round((t.goalsAgainst || 0) * multiplier * (stat?.trend === 'down' ? 1.06 : 1.0)),
        trend:        stat?.trend || 'same',
      };
    });

  // Rendezés a becsült pontok szerint
  baseStandings.sort((a, b) => b.projectedPts - a.projectedPts);
  baseStandings.forEach((t, i) => { t.projectedPos = i + 1; });

  const allTeamsData = baseStandings.map(t =>
    `${t.currentPos}. ${t.team}: JELENLEGI ${t.currentPts}pt (${t.currentGF}:${t.currentGA}) → BECSÜLT ${t.projectedPts}pt | trend: ${t.trend}`
  ).join('\n');

  const prompt = `Te egy virtuális futball liga statisztikusa vagy. A VALÓS TABELLA alapján készíts szezonvégi előrejelzést.

JELENLEGI VALÓS TABELLA (ezt KÖTELEZŐ alapul venni!):
${allTeamsData}

${historyContext || ''}

SZIGORÚ SZABÁLYOK:
1. A "BECSÜLT" pontszámokat használd alapként – ezek már trend-korrigáltak
2. A sorrend NEM változhat drasztikusan – max ±3 helyet mozdulhat egy csapat a becsült pozíciójától
3. Ha egy csapat jelenleg 1. (pl. Fulham 87pt), a szezon végén is top 3-ban kell lennie
4. Ha egy csapat jelenleg utolsó, a szezon végén is kieső zónában kell maradnia
5. A pontszámok MAGASABBAK legyenek a jelenlegi értéknél (még ${estimatedRoundsLeft} forduló van hátra)
6. trend mező: "up" ha javul, "down" ha romlik, "same" ha stabil – a fenti adatok alapján

Válaszolj KIZÁRÓLAG valid JSON tömbbel:
[{"pos":1,"team":"Csapatnév","goalsFor":72,"goalsAgainst":28,"pts":87,"trend":"same"},...]

KÖTELEZŐ: pontosan ${standings.length} csapat, a sorrend a valós tabellához KÖZELI legyen!`;

  const text  = await callAI(prompt, 0.4);
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('[');
  if (start === -1) throw new Error('JSON nem található az AI válaszban');

  let depth = 0, end = start;
  for (; end < clean.length; end++) {
    if (clean[end] === '[') depth++;
    else if (clean[end] === ']') { depth--; if (depth === 0) break; }
  }

  let parsed;
  try {
    parsed = JSON.parse(clean.slice(start, end + 1));
  } catch(e) {
    throw new Error('JSON parse hiba: ' + e.message);
  }

  // ── VALIDÁCIÓ: az AI ne rendezze át teljesen a táblázatot ──────────────────
  let aiStandings = parsed.map((r, i) => ({
    pos:          parseInt(String(r.pos || (i + 1)), 10),
    team:         String(r.team || r.name || '–'),
    goalsFor:     parseInt(String(r.goalsFor  ?? r.gf ?? 0), 10) || 0,
    goalsAgainst: parseInt(String(r.goalsAgainst ?? r.ga ?? 0), 10) || 0,
    pts:          parseInt(String(r.pts ?? r.points ?? 0), 10) || 0,
    trend:        String(r.trend || 'same'),
  }));

  // Ellenőrzés: minden valós csapat szerepel-e
  const realTeams = new Set(standings.map(t => t.team));
  const aiTeams   = new Set(aiStandings.map(t => t.team));
  const missingTeams = [...realTeams].filter(t => !aiTeams.has(t));

  if (missingTeams.length > 0 || aiStandings.length !== standings.length) {
    // Ha az AI kihagyott csapatokat vagy hibás a lista – fallback a saját becslésre
    console.warn('[ai-prediction] AI kihagyott csapatokat, fallback becslés alkalmazva');
    aiStandings = baseStandings.map((t, i) => ({
      pos:          i + 1,
      team:         t.team,
      goalsFor:     t.projectedGF,
      goalsAgainst: t.projectedGA,
      pts:          t.projectedPts,
      trend:        t.trend,
    }));
  } else {
    // Pozíció eltérés korrekció: max ±4 hely az extrapolált pozícióhoz képest
    const basePosByTeam = {};
    baseStandings.forEach(t => { basePosByTeam[t.team] = t.projectedPos; });

    aiStandings.forEach(t => {
      const basePos = basePosByTeam[t.team];
      if (basePos && Math.abs(t.pos - basePos) > 4) {
        console.warn(`[ai-prediction] ${t.team}: AI pos=${t.pos}, base pos=${basePos} – korrigálva`);
        t.pos = basePos;
      }
      // Minimum pontszám: legalább a jelenlegi + 1
      const realTeam = standings.find(s => s.team === t.team);
      if (realTeam && t.pts <= realTeam.pts) {
        t.pts = realTeam.pts + Math.round(estimatedRoundsLeft * 1.5);
      }
    });

    // Rendezés pontszám szerint, pozíciók újraszámítása
    aiStandings.sort((a, b) => b.pts - a.pts);
    aiStandings.forEach((t, i) => { t.pos = i + 1; });
  }

  if (!aiStandings.length) throw new Error('Üres AI tabella');

  // ── Elemzés ────────────────────────────────────────────────────────────────
  const top3      = aiStandings.slice(0, 3).map(t  => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const bot3      = aiStandings.slice(-3).map(t     => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const upTeams   = aiStandings.filter(t => t.trend === 'up').map(t   => t.team).join(', ') || 'nincs';
  const downTeams = aiStandings.filter(t => t.trend === 'down').map(t => t.team).join(', ') || 'nincs';

  const analysisPrompt = `Rövid elemzés MAGYARUL (3-4 mondat, hivatkozz konkrét csapatokra):
Szezonvégi előrejelzés a VALÓS TABELLA alapján (${estimatedRoundsLeft} forduló van még hátra):
- Várható top 3: ${top3}
- Várható kieső zóna: ${bot3}  
- Emelkedő tendencia: ${upTeams}
- Csökkenő tendencia: ${downTeams}
- History adatbázis: ${entryCount > 0 ? `${entryCount} forduló` : 'nincs – csak aktuális állás alapján'}
Miért ilyen a várható végeredmény? A jelenlegi tabella állásból kiindulva mi várható?`;

  const analysis = await callAI(analysisPrompt, 0.6);

  return {
    standings: aiStandings,
    analysis,
    generatedAt: new Date().toISOString(),
    basedOnFingerprint: fingerprint(standings),
    seasonId: seasonId || null,
    basedOnRounds: estimatedRoundsPlayed,
    hasHistoryData: entryCount > 0,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method === 'GET') {
      const rawPred = await kvGet(AI_KEY);
      const rawMeta = await kvGet(AI_META_KEY);
      let prediction = null, meta = null;
      if (rawPred) { try { prediction = JSON.parse(rawPred); } catch(e) {} }
      if (rawMeta) { try { meta = JSON.parse(rawMeta); } catch(e) {} }
      return new Response(JSON.stringify({ prediction, meta, hasData: !!prediction }), {
        status: 200, headers: corsHeaders,
      });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { standings, seasonId, force } = body;

      if (!standings || !standings.length) {
        return new Response(JSON.stringify({ error: 'Hiányzó standings' }), {
          status: 400, headers: corsHeaders,
        });
      }

      const currentFP = fingerprint(standings);

      if (!force) {
        const rawMeta = await kvGet(AI_META_KEY);
        if (rawMeta) {
          let meta = null;
          try { meta = JSON.parse(rawMeta); } catch(e) {}
          if (meta) {
            const seasonChanged = seasonId && meta.seasonId && String(seasonId) !== String(meta.seasonId);
            if (!seasonChanged && meta.basedOnFingerprint === currentFP) {
              const rawPred = await kvGet(AI_KEY);
              if (rawPred) {
                let prediction = null;
                try { prediction = JSON.parse(rawPred); } catch(e) {}
                if (prediction) {
                  return new Response(JSON.stringify({
                    prediction, meta, regenerated: false, reason: 'already_current',
                  }), { status: 200, headers: corsHeaders });
                }
              }
            }
          }
        }
      }

      console.log('[ai-prediction] Generating... force=', force, 'seasonId=', seasonId);
      const prediction = await generatePrediction(standings, seasonId);

      await kvSet(AI_KEY, JSON.stringify(prediction));
      await kvSet(AI_META_KEY, JSON.stringify({
        generatedAt: prediction.generatedAt,
        basedOnFingerprint: prediction.basedOnFingerprint,
        seasonId: prediction.seasonId,
      }));

      return new Response(JSON.stringify({ prediction, regenerated: true }), {
        status: 200, headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: corsHeaders,
    });

  } catch (err) {
    console.error('[ai-prediction]', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
}
