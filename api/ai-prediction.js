// api/ai-prediction.js – v7 · teljes újraírás · llm7.io
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
  maxTokens: 6000,
};

const KV_KEYS = {
  prediction: 'vsport:ai_prediction',
  meta:       'vsport:ai_meta',
};

const SEASON_ROUNDS = 34;

// ─── Segédek ─────────────────────────────────────────────────────────────────

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── KV store ────────────────────────────────────────────────────────────────

function kvBase() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env változók hiányoznak');
  return { url, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

async function kvGet(key) {
  try {
    const { url, headers } = kvBase();
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const v = d.result ?? null;
    if (v == null) return null;
    if (typeof v === 'object') return JSON.stringify(v.value ?? v);
    return String(v);
  } catch { return null; }
}

async function kvSet(key, value) {
  const { url, headers } = kvBase();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers,
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KV SET hiba: ${res.status}`);
}

// ─── LLM hívás retry-jal ─────────────────────────────────────────────────────

async function llmCall(systemPrompt, userPrompt, temp = 0.35, retries = 2) {
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
      await sleep(800 * (i + 1));
    }
  }
}

// ─── Ujjlenyomat (cache invalidáció) ─────────────────────────────────────────

function fingerprint(standings) {
  return standings
    .map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`)
    .join('|');
}

// ─── History trendek ──────────────────────────────────────────────────────────

async function loadHistoryTrends(seasonId) {
  const keys = seasonId
    ? [`vsport:league_history:season:${seasonId}`, 'vsport:league_history']
    : ['vsport:league_history'];

  let entries = null;
  for (const key of keys) {
    const raw = await kvGet(key);
    if (raw) {
      try { entries = JSON.parse(raw); break; } catch { /* continue */ }
    }
  }

  if (!Array.isArray(entries) || !entries.length) {
    return { summary: '', teamStats: {}, entryCount: 0 };
  }

  // Csapatonkénti statisztikák
  const teamMap = {};
  for (const entry of entries) {
    for (const t of (entry.standingsSnapshot || [])) {
      if (!teamMap[t.team]) teamMap[t.team] = [];
      teamMap[t.team].push({
        pos:  t.pos,
        pts:  t.pts || 0,
        gf:   t.goalsFor  || 0,
        ga:   t.goalsAgainst || 0,
      });
    }
  }

  const teamStats = {};
  for (const [team, hist] of Object.entries(teamMap)) {
    if (hist.length < 2) {
      teamStats[team] = { trend: 'same', ptsPerRound: 0, posChange: 0, dataPoints: hist.length };
      continue;
    }

    const first = hist[0], last = hist.at(-1);
    const ptsGrowth = last.pts - first.pts;
    const posChange = first.pos - last.pos; // pozitív = javult

    let trend = 'same';
    if (hist.length >= 4) {
      const mid = Math.floor(hist.length / 2);
      const recAvg  = hist.slice(mid).reduce((s, h) => s + h.pos, 0) / (hist.length - mid);
      const earAvg  = hist.slice(0, mid).reduce((s, h) => s + h.pos, 0) / mid;
      if (recAvg < earAvg - 1)      trend = 'up';
      else if (recAvg > earAvg + 1) trend = 'down';
    } else {
      if (posChange > 1)       trend = 'up';
      else if (posChange < -1) trend = 'down';
    }

    const ptsPerRound = hist.length > 1
      ? +(ptsGrowth / (hist.length - 1)).toFixed(2) : 0;

    teamStats[team] = { trend, ptsPerRound, posChange, dataPoints: hist.length };
  }

  const trendLabel = t => t === 'up' ? '▲ EMELKEDŐ' : t === 'down' ? '▼ ESŐ' : '► STAGNÁLÓ';
  const pad = (s, n) => String(s).padEnd(n);

  const lines = Object.entries(teamStats).map(([team, s]) =>
    `  ${pad(team,22)} ${trendLabel(s.trend)}  ${s.ptsPerRound>0?'+':''}${s.ptsPerRound}pt/fd  poz.δ:${s.posChange>0?'+':''}${s.posChange}  (${s.dataPoints} minta)`
  );

  const recentRounds = entries.slice(0, 3).map((e, idx) => {
    const snap = (e.standingsSnapshot || [])
      .map(t => `    ${String(t.pos).padStart(2)}. ${pad(t.team,20)} ${t.pts}pt`)
      .join('\n');
    return `  [${idx === 0 ? 'LEGFRISSEBB' : `${idx+1}. korábbi`}]\n${snap}`;
  });

  const summary = [
    `═══ HISTORY TRENDEK (${entries.length} forduló alapján) ═══`,
    lines.join('\n'),
    '',
    'LEGUTÓBBI FORDULÓK:',
    recentRounds.join('\n\n'),
    '═══════════════════════════════════════════════════',
  ].join('\n');

  return { summary, teamStats, entryCount: entries.length };
}

// ─── Matematikai alap-előrejelzés ─────────────────────────────────────────────

function computeBaseProjection(standings, teamStats) {
  const totalPts    = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const avgPts      = totalPts / Math.max(standings.length, 1);
  const roundsPlayed = Math.max(1, Math.round(avgPts / 2));
  const roundsLeft  = Math.max(2, SEASON_ROUNDS - roundsPlayed);
  const multiplier  = Math.min(3.5, SEASON_ROUNDS / Math.max(1, roundsPlayed));

  const projected = standings.map(t => {
    const stat    = teamStats[t.team];
    const trendM  = stat
      ? (stat.trend === 'up' ? 1.09 : stat.trend === 'down' ? 0.92 : 1.0)
      : 1.0;
    const gfM     = stat?.trend === 'up'   ? 1.07 : 1.0;
    const gaM     = stat?.trend === 'down' ? 1.07 : 1.0;

    return {
      team:         t.team,
      currentPos:   t.pos,
      currentPts:   t.pts || 0,
      currentGF:    t.goalsFor  || 0,
      currentGA:    t.goalsAgainst || 0,
      projectedPts: Math.round((t.pts || 0) * multiplier * trendM),
      projectedGF:  Math.round((t.goalsFor  || 0) * multiplier * gfM),
      projectedGA:  Math.round((t.goalsAgainst || 0) * multiplier * gaM),
      trend:        stat?.trend || 'same',
    };
  });

  projected.sort((a, b) => b.projectedPts - a.projectedPts);
  projected.forEach((t, i) => { t.projectedPos = i + 1; });

  return { projected, roundsPlayed, roundsLeft };
}

// ─── Prompt felépítés ─────────────────────────────────────────────────────────

function buildPrompts(projected, historySummary, roundsLeft) {
  const system = [
    'Te egy profi futball szezonvégi előrejelző vagy.',
    'Kizárólag a megadott formátumban válaszolsz – STANDINGS: JSON, ANALYSIS: szöveg.',
    'Semmi más markdown, semmi más szöveg.',
  ].join(' ');

  const pad  = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  const tableData = projected.map(t =>
    `  ${rpad(t.currentPos,2)}. ${pad(t.team,22)} jelenlegi:${rpad(t.currentPts,3)}pt (${t.currentGF}:${t.currentGA}) → becsült:${rpad(t.projectedPts,3)}pt  trend:${t.trend}`
  ).join('\n');

  const histSection = historySummary
    ? `\n# HISTORY TRENDEK\n${historySummary}\n`
    : '';

  const user = `
# JELENLEGI TABELLA + MATEMATIKAI ELŐREJELZÉS
${tableData}
${histSection}
# FELADAT
Generálj szezonvégi tabellát. Még hátra van ~${roundsLeft} forduló.

SZABÁLYOK:
1. Max ±4 hely eltérés a matematikai előrejelzéstől
2. A pontszámok legyenek magasabbak a jelenlegi értékeknél
3. Vedd figyelembe a history trendeket (ha van)
4. trend mező: "up" / "down" / "same"
5. A JSON-ban minden csapat szerepeljen

VÁLASZ FORMÁTUM (semmi más):
STANDINGS:
[{"pos":1,"team":"CsapatNév","goalsFor":50,"goalsAgainst":20,"pts":85,"trend":"same"}]
ANALYSIS:
3 mondatos magyar elemzés: ki bajnok, kik esnek ki, meglepetések.
`.trim();

  return { system, user };
}

// ─── LLM válasz feldolgozása ──────────────────────────────────────────────────

function parseResponse(text) {
  const standingsM = text.match(/STANDINGS:\s*(\[[\s\S]*?\])(?:\s*ANALYSIS:|$)/);
  if (!standingsM) throw new Error('STANDINGS szekció nem található');

  let parsed;
  try { parsed = JSON.parse(standingsM[1]); }
  catch (e) { throw new Error('STANDINGS JSON parse hiba: ' + e.message); }

  const analysisM = text.match(/ANALYSIS:\s*([\s\S]+)$/);
  const analysis  = analysisM ? analysisM[1].trim() : '';

  return { parsed, analysis };
}

// ─── Validálás & fallback ─────────────────────────────────────────────────────

function buildFinalStandings({ parsed, analysis }, projected, standings, roundsLeft) {
  const realTeams = new Set(standings.map(t => t.team));
  const aiTeams   = new Set(parsed.map(t => t.team));
  const missing   = [...realTeams].filter(t => !aiTeams.has(t));

  let aiStandings;

  if (missing.length > 0 || parsed.length !== standings.length) {
    console.warn('[ai-prediction] Hiányzó csapatok az AI válaszból, matematikai fallback:', missing);
    aiStandings = projected.map((t, i) => ({
      pos:          i + 1,
      team:         t.team,
      goalsFor:     t.projectedGF,
      goalsAgainst: t.projectedGA,
      pts:          t.projectedPts,
      trend:        t.trend,
    }));
  } else {
    const basePosByTeam = Object.fromEntries(projected.map(t => [t.team, t.projectedPos]));

    aiStandings = parsed.map((r, i) => {
      const base    = projected.find(t => t.team === r.team);
      const current = standings.find(t => t.team === r.team);

      let pos = parseInt(r.pos) || (i + 1);
      const basePos = basePosByTeam[r.team];
      if (basePos && Math.abs(pos - basePos) > 4) pos = basePos;

      let pts = parseInt(r.pts) || 0;
      if (current && pts <= current.pts) {
        pts = current.pts + Math.round(roundsLeft * 1.6);
      }

      return {
        pos,
        team:         String(r.team || '–'),
        goalsFor:     parseInt(r.goalsFor)     || base?.projectedGF  || 0,
        goalsAgainst: parseInt(r.goalsAgainst) || base?.projectedGA  || 0,
        pts,
        trend:        String(r.trend || 'same'),
      };
    });

    // Rendezés pontszám szerint, pozíció újraszámítás
    aiStandings.sort((a, b) => b.pts - a.pts);
    aiStandings.forEach((t, i) => { t.pos = i + 1; });
  }

  return { standings: aiStandings, analysis };
}

// ─── Előrejelzés generálása ───────────────────────────────────────────────────

async function generatePrediction(standings, seasonId) {
  const { summary: historySummary, teamStats, entryCount } =
    await loadHistoryTrends(seasonId);

  const { projected, roundsPlayed, roundsLeft } =
    computeBaseProjection(standings, teamStats);

  const { system, user } = buildPrompts(projected, historySummary, roundsLeft);

  const text = await llmCall(system, user, 0.38);
  const { parsed, analysis } = parseResponse(text);
  const { standings: aiStandings, analysis: finalAnalysis } =
    buildFinalStandings({ parsed, analysis }, projected, standings, roundsLeft);

  if (!aiStandings.length) throw new Error('Üres végeredmény');

  return {
    standings:            aiStandings,
    analysis:             finalAnalysis,
    generatedAt:          new Date().toISOString(),
    basedOnFingerprint:   fingerprint(standings),
    seasonId:             seasonId || null,
    basedOnRounds:        roundsPlayed,
    roundsLeft,
    hasHistoryData:       entryCount > 0,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    // ── GET: cache lekérés ──
    if (req.method === 'GET') {
      const [rawPred, rawMeta] = await Promise.all([
        kvGet(KV_KEYS.prediction),
        kvGet(KV_KEYS.meta),
      ]);

      let prediction = null, meta = null;
      try { prediction = rawPred ? JSON.parse(rawPred) : null; } catch { /* ignore */ }
      try { meta       = rawMeta ? JSON.parse(rawMeta) : null; } catch { /* ignore */ }

      return jsonRes({ prediction, meta, hasData: !!prediction });
    }

    // ── POST: generálás ──
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); }
      catch { return jsonRes({ error: 'Érvénytelen JSON body' }, 400); }

      const { standings, seasonId, force = false } = body;

      if (!Array.isArray(standings) || !standings.length) {
        return jsonRes({ error: '"standings" mező kötelező és nem lehet üres.' }, 400);
      }

      const currentFP = fingerprint(standings);

      // Cache ellenőrzés (ha nem force)
      if (!force) {
        const rawMeta = await kvGet(KV_KEYS.meta);
        if (rawMeta) {
          let meta = null;
          try { meta = JSON.parse(rawMeta); } catch { /* ignore */ }

          if (meta) {
            const seasonMatch = !seasonId || !meta.seasonId || String(seasonId) === String(meta.seasonId);
            if (seasonMatch && meta.basedOnFingerprint === currentFP) {
              const rawPred = await kvGet(KV_KEYS.prediction);
              if (rawPred) {
                let prediction = null;
                try { prediction = JSON.parse(rawPred); } catch { /* ignore */ }
                if (prediction) {
                  return jsonRes({ prediction, meta, regenerated: false, reason: 'already_current' });
                }
              }
            }
          }
        }
      }

      console.log('[ai-prediction] Generálás... force=', force, 'seasonId=', seasonId);
      const prediction = await generatePrediction(standings, seasonId);

      const meta = {
        generatedAt:          prediction.generatedAt,
        basedOnFingerprint:   prediction.basedOnFingerprint,
        seasonId:             prediction.seasonId,
      };

      await Promise.all([
        kvSet(KV_KEYS.prediction, JSON.stringify(prediction)),
        kvSet(KV_KEYS.meta,       JSON.stringify(meta)),
      ]);

      return jsonRes({ prediction, meta, regenerated: true });
    }

    return jsonRes({ error: 'Method not allowed' }, 405);

  } catch (err) {
    console.error('[ai-prediction] Hiba:', err.message);
    return jsonRes({ error: err.message }, 500);
  }
}
