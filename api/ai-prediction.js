// api/ai-prediction.js – v6: valódi trend-alapú előrejelzés, javított AI prompt
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AI_KEY      = 'vsport:ai_prediction';
const AI_META_KEY = 'vsport:ai_meta';

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

// ─── History feldolgozás ──────────────────────────────────────────────────────
async function getHistoryData(seasonId) {
  try {
    const key = seasonId ? `vsport:league_history:season:${seasonId}` : 'vsport:league_history';
    let raw = await kvGet(key);
    if (!raw && key !== 'vsport:league_history') raw = await kvGet('vsport:league_history');
    if (!raw) return null;

    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || !entries.length) return null;

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
        });
      }
    }

    for (const team of Object.keys(teamData)) {
      teamData[team].sort((a, b) => a.ts - b.ts);
    }

    const stats = {};
    for (const [team, history] of Object.entries(teamData)) {
      if (history.length < 1) continue;
      const n = history.length;
      const first = history[0];
      const last  = history[n - 1];

      const ptsGains = [];
      for (let i = 1; i < n; i++) ptsGains.push(history[i].pts - history[i - 1].pts);
      const avgPtsPerRound = ptsGains.length
        ? ptsGains.reduce((a, b) => a + b, 0) / ptsGains.length : 0;

      const last5gains = ptsGains.slice(-5);
      const last5Avg = last5gains.length
        ? last5gains.reduce((a, b) => a + b, 0) / last5gains.length : avgPtsPerRound;

      const last5snaps = history.slice(-5);
      const last5GF = last5snaps.reduce((s, h) => s + h.goalsFor, 0) / last5snaps.length;
      const last5GA = last5snaps.reduce((s, h) => s + h.goalsAgainst, 0) / last5snaps.length;

      const posChange = first.pos - last.pos;

      let recentTrend = 'stagnáló';
      if (n >= 6) {
        const third    = Math.floor(n / 3);
        const earlyAvg = history.slice(0, third).reduce((s, h) => s + h.pos, 0) / third;
        const lateAvg  = history.slice(-third).reduce((s, h) => s + h.pos, 0) / third;
        if (lateAvg < earlyAvg - 1.5)      recentTrend = 'erősen emelkedő';
        else if (lateAvg < earlyAvg - 0.5) recentTrend = 'emelkedő';
        else if (lateAvg > earlyAvg + 1.5) recentTrend = 'erősen eső';
        else if (lateAvg > earlyAvg + 0.5) recentTrend = 'eső';
      } else if (posChange > 1) recentTrend = 'emelkedő';
      else if (posChange < -1)  recentTrend = 'eső';

      const wins   = ptsGains.filter(g => g >= 3).length;
      const draws  = ptsGains.filter(g => g === 1).length;
      const losses = ptsGains.filter(g => g === 0).length;

      stats[team] = {
        snapCount: n, firstPos: first.pos, lastPos: last.pos,
        firstPts: first.pts, lastPts: last.pts,
        posChange, ptsGrowth: last.pts - first.pts,
        avgPtsPerRound: Math.round(avgPtsPerRound * 100) / 100,
        last5Avg:       Math.round(last5Avg       * 100) / 100,
        last5GF:        Math.round(last5GF * 10) / 10,
        last5GA:        Math.round(last5GA * 10) / 10,
        recentTrend, wins, draws, losses,
        winRate: ptsGains.length ? Math.round((wins / ptsGains.length) * 100) : 0,
      };
    }

    return { stats, entryCount: entries.length };
  } catch (e) {
    console.warn('[getHistoryData]', e.message);
    return null;
  }
}

// ─── Szezon extrapoláció ─────────────────────────────────────────────────────
function calcExtrapolation(standings) {
  const totalCurrentPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const totalTeams    = standings.length;
  const avgPtsPerTeam = totalCurrentPts / Math.max(totalTeams, 1);
  // ~1.9pt/forduló/csapat (vegyes győzelem/döntetlen/vereség arány)
  const estRoundsPlayed = Math.max(1, Math.round(avgPtsPerTeam / 1.9));
  const TOTAL_ROUNDS    = 34;
  const estRoundsLeft   = Math.max(0, TOTAL_ROUNDS - estRoundsPlayed);
  const extrapolFactor  = TOTAL_ROUNDS / Math.max(estRoundsPlayed, 1);
  return { estRoundsPlayed, estRoundsLeft, extrapolFactor, totalCurrentPts, avgPtsPerTeam };
}

// ─── Matematikai előrejelzés ─────────────────────────────────────────────────
function computeMathProjection(standings, histData, estRoundsLeft, extrapolFactor) {
  return standings.map(t => {
    const hist    = histData?.stats?.[t.team];
    const basePts = t.pts || 0;
    const baseGF  = t.goalsFor || 0;
    const baseGA  = t.goalsAgainst || 0;

    let projPts, projGF, projGA;

    if (hist && hist.last5Avg > 0 && estRoundsLeft > 0) {
      const trendMod = hist.recentTrend.includes('erősen emelkedő') ? 1.20
        : hist.recentTrend.includes('emelkedő')   ? 1.10
        : hist.recentTrend.includes('erősen eső') ? 0.80
        : hist.recentTrend.includes('eső')         ? 0.90 : 1.0;

      projPts = Math.round(basePts + hist.last5Avg * estRoundsLeft * trendMod);
      projGF  = Math.round(baseGF + hist.last5GF * estRoundsLeft * trendMod);
      projGA  = Math.round(baseGA + hist.last5GA * estRoundsLeft);
    } else {
      projPts = Math.round(basePts * extrapolFactor);
      projGF  = Math.round(baseGF * extrapolFactor * 0.95);
      projGA  = Math.round(baseGA * extrapolFactor * 0.95);
    }

    projPts = Math.max(projPts, basePts + 1);
    projGF  = Math.max(projGF,  baseGF);
    projGA  = Math.max(projGA,  baseGA);

    return {
      team: t.team, currentPos: t.pos, currentPts: basePts,
      projPts, projGF, projGA,
      trend: hist?.recentTrend || 'stagnáló',
    };
  }).sort((a, b) => b.projPts - a.projPts);
}

// ─── AI hívás ────────────────────────────────────────────────────────────────
async function callAI(systemPrompt, userPrompt, temp = 0.3) {
  // 1. Anthropic (ha van key)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 3000,
          messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
          temperature: temp,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.ok) {
        const d = await res.json();
        const text = d.content?.[0]?.text;
        if (text?.trim()) return text;
      }
    } catch (e) { console.warn('[ai-prediction] Anthropic hiba:', e.message); }
  }

  // 2. LLM7 fallback
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature: temp,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (res.ok) {
      const d = await res.json();
      const text = d.choices?.[0]?.message?.content;
      if (text?.trim()) return text;
    }
  } catch (e) { console.warn('[ai-prediction] LLM7 hiba:', e.message); }

  return null;
}

// ─── History feldolgozás kliens adatokból ─────────────────────────────────────
async function buildHistDataFromEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  // Ugyanolyan feldolgozás mint getHistoryData, de KV hívás nélkül
  const teamData = {};
  for (const entry of entries) {
    const snap = entry.standingsSnapshot || [];
    for (const t of snap) {
      if (!teamData[t.team]) teamData[t.team] = [];
      teamData[t.team].push({
        ts:           new Date(entry.timestamp || 0).getTime(),
        pos:          t.pos,
        pts:          t.pts || 0,
        goalsFor:     t.goalsFor || 0,
        goalsAgainst: t.goalsAgainst || 0,
      });
    }
  }
  for (const team of Object.keys(teamData)) {
    teamData[team].sort((a, b) => a.ts - b.ts);
  }
  const stats = {};
  for (const [team, history] of Object.entries(teamData)) {
    if (history.length < 1) continue;
    const n = history.length;
    const first = history[0];
    const last  = history[n - 1];
    const ptsGains = [];
    for (let i = 1; i < n; i++) ptsGains.push(history[i].pts - history[i - 1].pts);
    const avgPtsPerRound = ptsGains.length ? ptsGains.reduce((a, b) => a + b, 0) / ptsGains.length : 0;
    const last5gains = ptsGains.slice(-5);
    const last5Avg = last5gains.length ? last5gains.reduce((a, b) => a + b, 0) / last5gains.length : avgPtsPerRound;
    const last5snaps = history.slice(-5);
    const last5GF = last5snaps.reduce((s, h) => s + h.goalsFor, 0) / last5snaps.length;
    const last5GA = last5snaps.reduce((s, h) => s + h.goalsAgainst, 0) / last5snaps.length;
    const posChange = first.pos - last.pos;
    let recentTrend = 'stagnáló';
    if (n >= 6) {
      const third    = Math.floor(n / 3);
      const earlyAvg = history.slice(0, third).reduce((s, h) => s + h.pos, 0) / third;
      const lateAvg  = history.slice(-third).reduce((s, h) => s + h.pos, 0) / third;
      if (lateAvg < earlyAvg - 1.5)      recentTrend = 'erősen emelkedő';
      else if (lateAvg < earlyAvg - 0.5) recentTrend = 'emelkedő';
      else if (lateAvg > earlyAvg + 1.5) recentTrend = 'erősen eső';
      else if (lateAvg > earlyAvg + 0.5) recentTrend = 'eső';
    } else if (posChange > 1) recentTrend = 'emelkedő';
    else if (posChange < -1)  recentTrend = 'eső';
    const wins   = ptsGains.filter(g => g >= 3).length;
    const draws  = ptsGains.filter(g => g === 1).length;
    const losses = ptsGains.filter(g => g === 0).length;
    stats[team] = {
      snapCount: n, firstPos: first.pos, lastPos: last.pos,
      firstPts: first.pts, lastPts: last.pts,
      posChange, ptsGrowth: last.pts - first.pts,
      avgPtsPerRound: Math.round(avgPtsPerRound * 100) / 100,
      last5Avg:       Math.round(last5Avg       * 100) / 100,
      last5GF:        Math.round(last5GF * 10) / 10,
      last5GA:        Math.round(last5GA * 10) / 10,
      recentTrend, wins, draws, losses,
      winRate: ptsGains.length ? Math.round((wins / ptsGains.length) * 100) : 0,
    };
  }
  return Object.keys(stats).length > 0 ? { stats, entryCount: entries.length } : null;
}

// ─── Főgenerátor ─────────────────────────────────────────────────────────────
// clientHistory: a frontendről küldött history bejegyzések (opcionális, gyorsabb)
async function generatePrediction(standings, seasonId, clientHistory = null) {
  const totalTeams = standings.length;

  // Ha a kliens küldött historyt, használjuk azt (nem kell KV hívás)
  let histData;
  if (clientHistory && Array.isArray(clientHistory) && clientHistory.length > 0) {
    // Feldolgozzuk a kliens history-t ugyanolyan formában mint a getHistoryData
    histData = await buildHistDataFromEntries(clientHistory);
  } else {
    histData = await getHistoryData(seasonId);
  }
  const { estRoundsPlayed, estRoundsLeft, extrapolFactor } = calcExtrapolation(standings);

  const mathProj = computeMathProjection(standings, histData, estRoundsLeft, extrapolFactor);

  // Tabella az AI-nak
  const currentTable = standings.map(t => {
    const hist = histData?.stats?.[t.team];
    const proj = mathProj.find(p => p.team === t.team);
    const gd   = (t.goalsFor || 0) - (t.goalsAgainst || 0);
    return `${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${String(t.pts || 0).padStart(3)}pt  GD:${String(gd).padStart(4)}  TREND:${hist?.recentTrend || 'nincs'}  MATH_PROGNOZIS:${proj?.projPts || '?'}pt`;
  }).join('\n');

  const mathRefStr = mathProj.map((t, i) => {
    const posChange = t.currentPos - (i + 1);
    const dir = posChange > 0 ? `↑${posChange} hely` : posChange < 0 ? `↓${Math.abs(posChange)} hely` : 'változatlan';
    return `${i + 1}. ${t.team}: ${t.currentPts}→${t.projPts}pt [${dir}] TREND:${t.trend}`;
  }).join('\n');

  let histSummary = 'NINCS history.';
  if (histData?.entryCount > 0) {
    histSummary = `${histData.entryCount} forduló rögzítve. Per-csapat:\n` +
      Object.entries(histData.stats)
        .sort((a, b) => (a[1].lastPos || 99) - (b[1].lastPos || 99))
        .map(([team, s]) => `  ${team}: ${s.recentTrend}, winRate=${s.winRate}%, last5=${s.last5Avg}pt/ford`)
        .join('\n');
  }

  const systemPrompt = `Te egy virtuális futball liga szezonvégi tabella prediktor vagy. Kizárólag JSON tömböt adsz vissza, semmi mást.`;

  const userPrompt = `JELENLEGI TABELLA (${totalTeams} csapat, ~${estRoundsPlayed} forduló játszva, ~${estRoundsLeft} van hátra):
${currentTable}

HISTORY:
${histSummary}

MATEMATIKAI PROGNÓZIS (alap – ettől max ±4 hellyel térhetsz el):
${mathRefStr}

FELADAT: Szezonvégi tabella előrejelzés.

KÖTELEZŐ SZABÁLYOK:
1. MINDEN csapat pontja legyen MAGASABB a jelenleginél (${estRoundsLeft} forduló van még hátra!)
2. Az "erősen emelkedő" trendű csapatok kerüljenek ELŐRÉBB mint most vannak
3. Az "erősen eső" trendű csapatok kerüljenek HÁTRÁBB
4. Kövesd a MATH_PROGNOZIS sorrendet (±4 hely eltérés max)
5. A sorrend LÁTHATÓAN KÜLÖNBÖZZÖN az aktuálistól!

CSAK ezt a JSON tömböt add vissza (${totalTeams} elem):
[{"pos":1,"team":"NévPontosan","goalsFor":90,"goalsAgainst":30,"pts":95,"trend":"up"},...]

trend értékek: "up"=javult helyezés, "down"=romlott, "same"=változatlan a jelenlegi pozícióhoz képest`;

  // AI hívás
  let aiStandings = null;
  const aiText = await callAI(systemPrompt, userPrompt, 0.25);

  if (aiText) {
    try {
      const clean = aiText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const start = clean.indexOf('[');
      if (start !== -1) {
        let depth = 0, end = start;
        for (; end < clean.length; end++) {
          if (clean[end] === '[') depth++;
          else if (clean[end] === ']') { depth--; if (depth === 0) break; }
        }
        const parsed = JSON.parse(clean.slice(start, end + 1));
        if (Array.isArray(parsed) && parsed.length >= 2) {
          aiStandings = parsed.map((r, i) => ({
            pos:          parseInt(String(r.pos || (i + 1))),
            team:         String(r.team || '–'),
            goalsFor:     parseInt(String(r.goalsFor  ?? 0)) || 0,
            goalsAgainst: parseInt(String(r.goalsAgainst ?? 0)) || 0,
            pts:          parseInt(String(r.pts ?? 0)) || 0,
            trend:        String(r.trend || 'same'),
          }));
        }
      }
    } catch (e) {
      console.warn('[ai-prediction] JSON parse hiba:', e.message);
    }
  }

  // Validáció: az AI extrapolált-e rendesen?
  const totalAIPts  = aiStandings ? aiStandings.reduce((s, t) => s + t.pts, 0) : 0;
  const totalRealPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const aiIsGood = aiStandings &&
    aiStandings.length === totalTeams &&
    totalRealPts > 0 &&
    totalAIPts / totalRealPts >= 1.04;

  if (!aiIsGood) {
    console.warn('[ai-prediction] AI gyenge/hibás → math fallback');
    aiStandings = mathProj.map((ref, i) => {
      const hist  = histData?.stats?.[ref.team];
      const trendDir = (i + 1) < ref.currentPos ? 'up' : (i + 1) > ref.currentPos ? 'down' : 'same';
      return {
        pos:          i + 1,
        team:         ref.team,
        goalsFor:     ref.projGF,
        goalsAgainst: ref.projGA,
        pts:          ref.projPts,
        trend:        trendDir,
      };
    });
  }

  // Rendezés + trend újraszámítás
  aiStandings.sort((a, b) => b.pts - a.pts || ((b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst)));
  aiStandings.forEach((t, i) => {
    t.pos = i + 1;
    const orig = standings.find(s => s.team === t.team);
    if (orig) {
      t.trend = t.pos < orig.pos ? 'up' : t.pos > orig.pos ? 'down' : 'same';
    }
  });

  // Elemzés
  const top3    = aiStandings.slice(0, 3).map(t => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const bottom3 = aiStandings.slice(-3).map(t => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const risers  = aiStandings.filter(t => t.trend === 'up').slice(0, 4)
    .map(t => { const o = standings.find(s => s.team === t.team); return `${t.team}(${o?.pos}→${t.pos})`; }).join(', ') || 'nincs';
  const fallers = aiStandings.filter(t => t.trend === 'down').slice(0, 4)
    .map(t => { const o = standings.find(s => s.team === t.team); return `${t.team}(${o?.pos}→${t.pos})`; }).join(', ') || 'nincs';

  const analysisText = await callAI(
    'Futball kommentátor vagy. Rövid, tömör elemzést írsz magyarul, 4-5 mondatban. Ne használj markdown-t, listát, csak folyó szöveget.',
    `Szezonvégi előrejelzés:\n- Top 3: ${top3}\n- Kiesők: ${bottom3}\n- Felfelé tartók: ${risers}\n- Lefelé tartók: ${fallers}\n- ~${estRoundsLeft} forduló van hátra\n\nMiért alakul így a szezon?`,
    0.5
  );

  return {
    standings:            aiStandings,
    analysis:             analysisText?.trim() || `A szezonvégi előrejelzés szerint ${top3} végez az élen. A kiesőzónában ${bottom3} csapatai szerepelnek.`,
    generatedAt:          new Date().toISOString(),
    basedOnFingerprint:   fingerprint(standings),
    seasonId:             seasonId || null,
    estRoundsPlayed,
    estRoundsLeft,
    hasHistoryData:       !!(histData && histData.entryCount > 0),
    historyEntryCount:    histData?.entryCount || 0,
    usedMathFallback:     !aiIsGood,
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
      const { standings, seasonId, force, history } = await req.json();
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

      console.log('[ai-prediction] Generating... force=', force, 'seasonId=', seasonId);
      const prediction = await generatePrediction(standings, seasonId, history || null);

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
