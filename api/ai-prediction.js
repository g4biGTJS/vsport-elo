// api/ai-prediction.js – v4: csapatnevek mindig a valódi standings-ből jönnek
// Az AI csak a sorrendet és statisztikákat becsüli – soha nem talál ki csapatneveket
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

async function callAI(prompt, temp = 0.85) {
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

    const teamHistory = {};
    for (const entry of entries) {
      const snap  = entry.standingsSnapshot || [];
      const round = entry.round || null;
      for (const t of snap) {
        if (!teamHistory[t.team]) teamHistory[t.team] = [];
        teamHistory[t.team].push({
          round,
          pos: t.pos,
          pts: t.pts,
          goalsFor: t.goalsFor || 0,
          goalsAgainst: t.goalsAgainst || 0,
        });
      }
    }

    for (const team of Object.keys(teamHistory)) {
      teamHistory[team].sort((a, b) => (a.round || 0) - (b.round || 0));
    }

    const teamStats = {};
    for (const [team, history] of Object.entries(teamHistory)) {
      if (history.length < 2) {
        const only = history[0] || {};
        teamStats[team] = {
          firstPos: only.pos, lastPos: only.pos,
          firstPts: only.pts, lastPts: only.pts,
          posChange: 0, ptsGrowthPerRound: 0,
          avgGoalsFor: only.goalsFor || 0,
          avgGoalsAgainst: only.goalsAgainst || 0,
          trend: 'same', dataPoints: history.length,
        };
        continue;
      }

      const first = history[0];
      const last  = history[history.length - 1];
      const posChange  = first.pos - last.pos;
      const ptsGrowth  = last.pts - first.pts;
      const rounds     = history.length;
      const avgGoalsFor     = Math.round(history.reduce((s, h) => s + h.goalsFor, 0)     / rounds);
      const avgGoalsAgainst = Math.round(history.reduce((s, h) => s + h.goalsAgainst, 0) / rounds);

      let recentTrend = 'same';
      if (history.length >= 4) {
        const mid = Math.floor(history.length / 2);
        const recentAvgPos  = history.slice(mid).reduce((s, h)  => s + h.pos, 0) / (history.length - mid);
        const earlierAvgPos = history.slice(0, mid).reduce((s, h) => s + h.pos, 0) / mid;
        if (recentAvgPos < earlierAvgPos - 1)      recentTrend = 'up';
        else if (recentAvgPos > earlierAvgPos + 1) recentTrend = 'down';
      } else {
        if (posChange > 1)       recentTrend = 'up';
        else if (posChange < -1) recentTrend = 'down';
      }

      teamStats[team] = {
        firstPos: first.pos, lastPos: last.pos,
        firstPts: first.pts, lastPts: last.pts,
        posChange,
        ptsGrowthPerRound: rounds > 1 ? +(ptsGrowth / (rounds - 1)).toFixed(2) : 0,
        avgGoalsFor, avgGoalsAgainst,
        trend: recentTrend, dataPoints: rounds,
      };
    }

    const recent = entries.slice(0, 30);
    const roundLines = recent.map((e, idx) => {
      const d = new Date(e.timestamp);
      const dateStr = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
      const label   = idx === 0 ? 'LEGUTÓBBI' : `${idx + 1}. korábbi`;
      const snap    = e.standingsSnapshot || [];
      const standingsStr = snap.length
        ? snap.map(t => {
            const gd = (t.goalsFor || 0) - (t.goalsAgainst || 0);
            return `    ${String(t.pos).padStart(2)}. ${t.team}: ${t.pts}pt  ${t.goalsFor||0}:${t.goalsAgainst||0}(${gd >= 0 ? '+' : ''}${gd})`;
          }).join('\n')
        : (e.top3 || []).map(t => `    ${t.pos}. ${t.team}: ${t.pts}pt`).join('\n');
      const moversStr = (e.movers || [])
        .filter(m => m.dir !== 'same')
        .slice(0, 6)
        .map(m => `${m.team}(${m.fromPos}→${m.toPos}${m.ptsDiff ? `,+${m.ptsDiff}pt` : ''})`)
        .join(', ');
      return `\n  [${dateStr} – ${label}]\n${standingsStr}${moversStr ? `\n  Mozgások: ${moversStr}` : ''}`;
    });

    const teamSummaryLines = Object.entries(teamStats)
      .sort((a, b) => (a[1].lastPos || 99) - (b[1].lastPos || 99))
      .map(([team, s]) => {
        const posStr   = s.posChange > 0 ? `↑${s.posChange}` : s.posChange < 0 ? `↓${Math.abs(s.posChange)}` : `=`;
        const trendStr = s.trend === 'up' ? 'EMELKEDŐ' : s.trend === 'down' ? 'ESŐ' : 'STAGNÁLÓ';
        return `    ${String(s.lastPos || '?').padStart(2)}. ${team}: ${s.lastPts}pt | pozíció ${posStr} (${s.firstPos}→${s.lastPos}) | ${trendStr} | gólátlag ${s.avgGoalsFor}:${s.avgGoalsAgainst} | ${s.dataPoints} mérés`;
      }).join('\n');

    const context = `
═══ SZEZON HISTORY (${entries.length} forduló rögzítve) ═══

PER-CSAPAT TREND ÖSSZEFOGLALÓ (FONTOS – ez alapján becsülj!):
${teamSummaryLines}

UTOLSÓ ${recent.length} FORDULÓ RÉSZLETESEN:
${roundLines.join('\n')}

═══ VÉGE ═══
`;

    return { context, entryCount: entries.length, teamStats };
  } catch (e) {
    console.warn('[getHistoryContext]', e.message);
    return { context: '', entryCount: 0, teamStats: {} };
  }
}

// ── AI generálás ──────────────────────────────────────────────────────────────
async function generatePrediction(standings, seasonId) {
  const { context: historyContext, entryCount, teamStats } = await getHistoryContext(seasonId);

  // ════════════════════════════════════════════════════════════════
  // FONTOS: A csapatnevek sorszámmal indexelve – az AI CSAK sorszámra hivatkozik!
  // Ez megakadályozza, hogy az AI kitalált neveket (Arsenal stb.) írjon be.
  // ════════════════════════════════════════════════════════════════
  const teamIndexed = standings.map((t, i) => ({
    index: i + 1,
    team: t.team,
    pts: t.pts,
    goalsFor: t.goalsFor || 0,
    goalsAgainst: t.goalsAgainst || 0,
    pos: t.pos,
  }));

  const allTeamsData = teamIndexed.map(t =>
    `#${t.index} (jelenleg ${t.pos}. hely) ${t.team}: ${t.pts}pt, ${t.goalsFor}:${t.goalsAgainst}`
  ).join('\n');

  const totalPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const hasHistory = entryCount > 0;

  const estimatedRoundsTotal  = 34;
  const estimatedRoundsPlayed = totalPts > 0
    ? Math.round(totalPts / Math.max(1, standings.length) / 2)
    : 1;
  const estimatedRoundsLeft = Math.max(0, estimatedRoundsTotal - estimatedRoundsPlayed);

  const seasonNote = totalPts < 50
    ? `SZEZON ELEJE – kb. ${estimatedRoundsPlayed} forduló játszva, ~${estimatedRoundsLeft} van hátra.`
    : estimatedRoundsLeft <= 5
    ? `SZEZON VÉGE KÖZELEDIK – ~${estimatedRoundsLeft} forduló van hátra.`
    : `SZEZON KÖZEPE – ~${estimatedRoundsLeft} forduló van hátra.`;

  // Az AI CSAK indexeket kap vissza – NEM csapatneveket!
  const prompt = `Te egy virtuális futball liga statisztikusa vagy. Becsüld meg a szezonvégi végső tabellát.

JELENLEGI TABELLA (${standings.length} csapat, indexszámmal jelölve):
${allTeamsData}

${historyContext || 'Nincs előzmény adat.'}

HELYZET: ${seasonNote}
Extrapolálj a TELJES szezonra (szorzó: ~${Math.max(1.1, (estimatedRoundsTotal / Math.max(1, estimatedRoundsPlayed))).toFixed(1)}).

KRITIKUS SZABÁLY: A válaszban CSAK az indexszámot (#1, #2, stb.) használd a csapatok azonosítására.
NE írj csapatneveket – csak az index számot! A csapatneveket a rendszer automatikusan hozzárendeli.

Válaszolj KIZÁRÓLAG valid JSON tömbbel:
[{"index":1,"goalsFor":72,"goalsAgainst":28,"pts":87,"trend":"up"},{"index":3,"goalsFor":65,"goalsAgainst":35,"pts":82,"trend":"same"},...]

Szabályok:
1. Minden csapat szerepeljen (pontosan ${standings.length} elem)
2. Az "index" mező az eredeti sorszám (#1–#${standings.length})
3. A sorrend a becsült végső helyezés szerint legyen (legtöbb pont = első)
4. trend: "up"=javul, "down"=romlik, "same"=marad
5. A pontok legyenek magasabbak az aktuálisnál (szezonvégi extrapoláció)`;

  const text  = await callAI(prompt);
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('[');
  if (start === -1) throw new Error('JSON nem található az AI válaszban');

  let depth = 0, end = start;
  for (; end < clean.length; end++) {
    if (clean[end] === '[') depth++;
    else if (clean[end] === ']') { depth--; if (depth === 0) break; }
  }

  const parsed = JSON.parse(clean.slice(start, end + 1));

  // ════════════════════════════════════════════════════════════════
  // CSAPATNÉV VISSZARENDELÉS: Az AI indexei alapján a VALÓDI neveket rendeljük vissza.
  // Ha az AI ismeretlen indexet ad (pl. "Arsenal"), azt kihagyjuk és fallback-et alkalmazunk.
  // ════════════════════════════════════════════════════════════════
  const teamMap = {};
  teamIndexed.forEach(t => { teamMap[t.index] = t; });

  // Először megpróbáljuk index alapján párosítani
  let aiStandings = [];
  const usedIndexes = new Set();

  for (const r of parsed) {
    const idx = parseInt(String(r.index || 0), 10);
    if (idx >= 1 && idx <= standings.length && teamMap[idx] && !usedIndexes.has(idx)) {
      usedIndexes.add(idx);
      aiStandings.push({
        pos:          aiStandings.length + 1, // pozíciót majd újra rendezzük
        team:         teamMap[idx].team,       // ← MINDIG a valódi csapatnév!
        goalsFor:     parseInt(String(r.goalsFor  ?? r.gf ?? 0), 10) || 0,
        goalsAgainst: parseInt(String(r.goalsAgainst ?? r.ga ?? 0), 10) || 0,
        pts:          parseInt(String(r.pts ?? r.points ?? 0), 10) || 0,
        trend:        String(r.trend || 'same'),
        logo:         teamMap[idx].logo || null,
      });
    }
  }

  // Ha az AI nem adott vissza minden csapatot (pl. kihagyott néhányat),
  // a hiányzókat az eredeti standings alapján adjuk hozzá
  if (aiStandings.length < standings.length) {
    console.warn(`[ai-prediction] AI csak ${aiStandings.length}/${standings.length} csapatot adott vissza – hiányzók pótlása`);
    for (const t of teamIndexed) {
      if (!usedIndexes.has(t.index)) {
        const multiplier = Math.max(1.1, estimatedRoundsTotal / Math.max(1, estimatedRoundsPlayed));
        aiStandings.push({
          pos:          aiStandings.length + 1,
          team:         t.team,
          goalsFor:     Math.round((t.goalsFor || 0) * multiplier),
          goalsAgainst: Math.round((t.goalsAgainst || 0) * multiplier),
          pts:          Math.round((t.pts || 0) * multiplier),
          trend:        'same',
          logo:         t.logo || null,
        });
      }
    }
  }

  if (!aiStandings.length) throw new Error('Üres AI tabella');

  // Rendezés pontszám szerint és pozíció frissítés
  aiStandings.sort((a, b) => b.pts - a.pts || b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst));
  aiStandings.forEach((t, i) => { t.pos = i + 1; });

  // Ellenőrzés: ha az AI nem extrapolált rendesen
  const totalAIPts   = aiStandings.reduce((s, t) => s + t.pts, 0);
  const totalRealPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const ptsRatio     = totalRealPts > 0 ? totalAIPts / totalRealPts : 1;

  if (ptsRatio < 1.08 && estimatedRoundsLeft > 3) {
    console.warn('[ai-prediction] AI nem extrapolált rendesen – kézi extrapoláció');
    const multiplier = Math.max(1.2, estimatedRoundsTotal / Math.max(1, estimatedRoundsPlayed));
    // Az aiStandings-ban már a valódi nevek vannak, csak a számokat korrigáljuk
    aiStandings.forEach(t => {
      // Megkeressük az eredeti standings-ban ezt a csapatot (névegyezéssel – már biztosan helyes)
      const orig = standings.find(s => s.team === t.team);
      if (orig) {
        const trendMod = t.trend === 'up' ? 1.12 : t.trend === 'down' ? 0.90 : 1.0;
        t.pts          = Math.round((orig.pts || 0) * multiplier * trendMod);
        t.goalsFor     = Math.round((orig.goalsFor || 0)     * multiplier * (t.trend === 'up'   ? 1.08 : 1.0));
        t.goalsAgainst = Math.round((orig.goalsAgainst || 0) * multiplier * (t.trend === 'down' ? 1.08 : 1.0));
      }
    });
    aiStandings.sort((a, b) => b.pts - a.pts);
    aiStandings.forEach((t, i) => { t.pos = i + 1; });
  }

  // Elemzés szöveg – csapatnevekkel (már biztosan helyesek)
  const top3      = aiStandings.slice(0, 3).map(t  => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const bot3      = aiStandings.slice(-3).map(t     => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const upTeams   = aiStandings.filter(t => t.trend === 'up').map(t   => t.team).join(', ') || 'nincs';
  const downTeams = aiStandings.filter(t => t.trend === 'down').map(t => t.team).join(', ') || 'nincs';

  const analysisPrompt = `Rövid elemzés MAGYARUL (4-5 konkrét mondat, hivatkozz csapatokra és trendekre):
Szezonvégi előrejelzés:
- Top 3: ${top3}
- Kieső zóna: ${bot3}
- Emelkedő csapatok: ${upTeams}
- Csökkenő csapatok: ${downTeams}
- Adatbázis: ${hasHistory ? `${entryCount} forduló history` : 'nincs history, gól-arányok alapján'}
Miért lehetnek ilyen helyzetben a szezon végén?`;

  const analysis = await callAI(analysisPrompt, 0.7);

  return {
    standings: aiStandings,
    analysis,
    generatedAt: new Date().toISOString(),
    basedOnFingerprint: fingerprint(standings),
    seasonId: seasonId || null,
    basedOnRounds: estimatedRoundsPlayed,
    hasHistoryData: hasHistory,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    if (req.method === 'GET') {
      const rawPred = await kvGet(AI_KEY);
      const rawMeta = await kvGet(AI_META_KEY);

      let prediction = null;
      let meta = null;

      if (rawPred) {
        try { prediction = JSON.parse(rawPred); } catch (e) {
          console.error('[ai GET] prediction parse hiba:', e.message);
        }
      }
      if (rawMeta) {
        try { meta = JSON.parse(rawMeta); } catch (e) {
          console.error('[ai GET] meta parse hiba:', e.message);
        }
      }

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
          try { meta = JSON.parse(rawMeta); } catch (e) {}
          if (meta) {
            const seasonChanged = seasonId && meta.seasonId && String(seasonId) !== String(meta.seasonId);
            if (!seasonChanged && meta.basedOnFingerprint === currentFP) {
              const rawPred = await kvGet(AI_KEY);
              if (rawPred) {
                let prediction = null;
                try { prediction = JSON.parse(rawPred); } catch (e) {}
                if (prediction) {
                  // ── EXTRA ELLENŐRZÉS: Ha a tárolt előrejelzés csapatai nem egyeznek a valódiakkal, újragenerálunk ──
                  const realTeams = new Set(standings.map(t => t.team));
                  const aiTeams  = (prediction.standings || []).map(t => t.team);
                  const hasWrongTeams = aiTeams.some(name => !realTeams.has(name));

                  if (hasWrongTeams) {
                    console.warn('[ai-prediction] Tárolt előrejelzés helytelen csapatneveket tartalmaz – újragenerálás!');
                    // Ne adjuk vissza, menjünk tovább a generáláshoz
                  } else {
                    return new Response(JSON.stringify({
                      prediction, meta, regenerated: false, reason: 'already_current',
                    }), { status: 200, headers: corsHeaders });
                  }
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
