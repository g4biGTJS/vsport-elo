// api/ai-prediction.js – v6: Gemini 2.5 Flash + model fallback
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AI_KEY      = 'vsport:ai_prediction';
const AI_META_KEY = 'vsport:ai_meta';
const GEMINI_KEY  = process.env.GEMINI_API_KEY || 'AIzaSyDgpQrXm0Et2lWoXdIr_se6h8mEMgeZDDI';

const GROQ_KEY = process.env.GROQ_API_KEY || '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';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Groq hívás ────────────────────────────────────────────────────────────────
async function callGemini(prompt, temp = 0.4) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: temp,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(22000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => String(res.status));
    throw new Error(`Groq hiba: ${res.status} – ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Groq üres választ adott');
  console.log('[Groq] sikeres');
  return text;
}

// ── KV helpers ────────────────────────────────────────────────────────────────
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
      headers: kvHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.result ?? null;
    if (result === null || result === undefined) return null;
    if (typeof result === 'object' && result.value !== undefined)
      return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  } catch { return null; }
}

async function kvSet(key, value) {
  const res = await fetch(kvUrl('/pipeline'), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KV SET hiba: ${res.status}`);
  return true;
}

function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ── History context ───────────────────────────────────────────────────────────
async function getHistoryContext(seasonId) {
  try {
    const key = seasonId
      ? `vsport:league_history:season:${seasonId}`
      : 'vsport:league_history';

    let raw = await kvGet(key);
    if (!raw && key !== 'vsport:league_history') raw = await kvGet('vsport:league_history');
    if (!raw) return { context: '', entryCount: 0, teamStats: {} };

    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || !entries.length) return { context: '', entryCount: 0, teamStats: {} };

    const teamHistory = {};
    for (const entry of entries) {
      for (const t of (entry.standingsSnapshot || [])) {
        if (!teamHistory[t.team]) teamHistory[t.team] = [];
        teamHistory[t.team].push({ pos: t.pos, pts: t.pts, goalsFor: t.goalsFor || 0, goalsAgainst: t.goalsAgainst || 0 });
      }
    }

    const teamStats = {};
    for (const [team, history] of Object.entries(teamHistory)) {
      if (history.length < 2) {
        teamStats[team] = { posChange: 0, ptsGrowthPerRound: 0, trend: 'same', dataPoints: history.length };
        continue;
      }
      const first = history[0], last = history[history.length - 1];
      const posChange = first.pos - last.pos;
      const ptsGrowth = last.pts - first.pts;
      const rounds = history.length;
      let trend = 'same';
      if (history.length >= 4) {
        const mid = Math.floor(history.length / 2);
        const recentAvg  = history.slice(mid).reduce((s, h) => s + h.pos, 0) / (history.length - mid);
        const earlierAvg = history.slice(0, mid).reduce((s, h) => s + h.pos, 0) / mid;
        if (recentAvg < earlierAvg - 1) trend = 'up';
        else if (recentAvg > earlierAvg + 1) trend = 'down';
      } else {
        if (posChange > 1) trend = 'up';
        else if (posChange < -1) trend = 'down';
      }
      teamStats[team] = {
        posChange,
        ptsGrowthPerRound: rounds > 1 ? +(ptsGrowth / (rounds - 1)).toFixed(2) : 0,
        trend,
        dataPoints: rounds,
      };
    }

    const teamSummaryLines = Object.entries(teamStats)
      .map(([team, s]) => {
        const trendStr = s.trend === 'up' ? 'EMELKEDŐ' : s.trend === 'down' ? 'ESŐ' : 'STAGNÁLÓ';
        return `    ${team}: ${trendStr} | ${s.ptsGrowthPerRound > 0 ? '+' : ''}${s.ptsGrowthPerRound} pt/forduló | ${s.dataPoints} mérés`;
      }).join('\n');

    const recent = entries.slice(0, 4);
    const roundLines = recent.map((e, idx) => {
      const snap = e.standingsSnapshot || [];
      const str = snap.map(t => `    ${String(t.pos).padStart(2)}. ${t.team}: ${t.pts}pt`).join('\n');
      return `\n  [${idx === 0 ? 'LEGUTÓBBI' : `${idx + 1}. korábbi`}]\n${str}`;
    });

    const context = `
═══ HISTORY TRENDEK (${entries.length} forduló) ═══
${teamSummaryLines}
UTOLSÓ FORDULÓK:${roundLines.join('\n')}
═══ VÉGE ═══`;

    return { context, entryCount: entries.length, teamStats };
  } catch (e) {
    console.warn('[getHistoryContext]', e.message);
    return { context: '', entryCount: 0, teamStats: {} };
  }
}

// ── Előrejelzés generálás ─────────────────────────────────────────────────────
async function generatePrediction(standings, seasonId) {
  const { context: historyContext, entryCount, teamStats } = await getHistoryContext(seasonId);

  const totalPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const estimatedRoundsTotal  = 34;
  const estimatedRoundsPlayed = totalPts > 0
    ? Math.round(totalPts / Math.max(1, standings.length) / 2)
    : 1;
  const estimatedRoundsLeft = Math.max(2, estimatedRoundsTotal - estimatedRoundsPlayed);
  const multiplier = Math.min(3.0, estimatedRoundsTotal / Math.max(1, estimatedRoundsPlayed));

  // Saját extrapoláció alapként
  const baseStandings = standings
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map(t => {
      const stat = teamStats[t.team];
      const trendMod = stat ? (stat.trend === 'up' ? 1.08 : stat.trend === 'down' ? 0.93 : 1.0) : 1.0;
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

  baseStandings.sort((a, b) => b.projectedPts - a.projectedPts);
  baseStandings.forEach((t, i) => { t.projectedPos = i + 1; });

  const allTeamsData = baseStandings.map(t =>
    `${t.currentPos}. ${t.team}: JELENLEGI ${t.currentPts}pt (${t.currentGF}:${t.currentGA}) → BECSÜLT ${t.projectedPts}pt | trend: ${t.trend}`
  ).join('\n');

  const prompt = `Virtuális futball liga statisztikus vagy. EGY válaszban adj: 1) szezonvégi tabella JSON, 2) rövid elemzés.

VALÓS TABELLA ALAP:
${allTeamsData}

SZABÁLYOK:
- Max ±3 hely eltérés a becsült pozíciótól
- Pontszámok magasabbak legyenek (${estimatedRoundsLeft} forduló van még)
- trend: "up"/"down"/"same"

Válasz PONTOSAN ebben a formátumban (semmi más):
STANDINGS:
[{"pos":1,"team":"...","goalsFor":0,"goalsAgainst":0,"pts":0,"trend":"same"}]
ANALYSIS:
3 mondatos magyar elemzés itt.`;

  const text = await callGemini(prompt, 0.4);

  // Tabella kinyerése
  const standingsMatch = text.match(/STANDINGS:\s*(\[[\s\S]*?\])/);
  if (!standingsMatch) throw new Error('STANDINGS szekció nem található');

  let parsed;
  try { parsed = JSON.parse(standingsMatch[1]); }
  catch(e) { throw new Error('JSON parse hiba: ' + e.message); }

  // Elemzés kinyerése
  const analysisMatch = text.match(/ANALYSIS:\s*([\s\S]+)$/);
  const analysis = analysisMatch ? analysisMatch[1].trim() : '';

  let aiStandings = parsed.map((r, i) => ({
    pos:          parseInt(String(r.pos || (i + 1)), 10),
    team:         String(r.team || '–'),
    goalsFor:     parseInt(String(r.goalsFor  ?? r.gf ?? 0), 10) || 0,
    goalsAgainst: parseInt(String(r.goalsAgainst ?? r.ga ?? 0), 10) || 0,
    pts:          parseInt(String(r.pts ?? r.points ?? 0), 10) || 0,
    trend:        String(r.trend || 'same'),
  }));

  // Validáció – ha az AI kihagyott csapatokat, fallback  const realTeams = new Set(standings.map(t => t.team));
  const aiTeams   = new Set(aiStandings.map(t => t.team));
  const missing   = [...realTeams].filter(t => !aiTeams.has(t));

  if (missing.length > 0 || aiStandings.length !== standings.length) {
    console.warn('[ai-prediction] Gemini kihagyott csapatokat, fallback alkalmazva. Missing:', missing);
    aiStandings = baseStandings.map((t, i) => ({
      pos: i + 1, team: t.team,
      goalsFor: t.projectedGF, goalsAgainst: t.projectedGA,
      pts: t.projectedPts, trend: t.trend,
    }));
  } else {
    // Pozíció korrekció: max ±4 hely
    const basePosByTeam = {};
    baseStandings.forEach(t => { basePosByTeam[t.team] = t.projectedPos; });
    aiStandings.forEach(t => {
      const basePos = basePosByTeam[t.team];
      if (basePos && Math.abs(t.pos - basePos) > 4) t.pos = basePos;
      const realTeam = standings.find(s => s.team === t.team);
      if (realTeam && t.pts <= realTeam.pts) {
        t.pts = realTeam.pts + Math.round(estimatedRoundsLeft * 1.5);
      }
    });
    aiStandings.sort((a, b) => b.pts - a.pts);
    aiStandings.forEach((t, i) => { t.pos = i + 1; });
  }

  if (!aiStandings.length) throw new Error('Üres AI tabella');



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
                  return new Response(JSON.stringify({ prediction, meta, regenerated: false, reason: 'already_current' }), {
                    status: 200, headers: corsHeaders,
                  });
                }
              }
            }
          }
        }
      }

      console.log('[ai-prediction] Generating with Gemini... force=', force, 'seasonId=', seasonId);
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
    console.error('[ai-prediction] Error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500, headers: corsHeaders,
    });
  }
}
