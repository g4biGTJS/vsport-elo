// api/ai-prediction.js – v8 · llm7.io · valódi előrejelzés, nem tükör
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

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

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
      headers, signal: AbortSignal.timeout(8000),
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
    method: 'POST', headers,
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KV SET hiba: ${res.status}`);
}

// ─── LLM hívás retry-jal ─────────────────────────────────────────────────────

async function llmCall(systemPrompt, userPrompt, temp = 0.7, retries = 2) {
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
      await sleep(900 * (i + 1));
    }
  }
}

// ─── Ujjlenyomat ─────────────────────────────────────────────────────────────

function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ─── Szezon állapot kiszámítása ───────────────────────────────────────────────

function computeSeasonState(standings) {
  const n           = standings.length;
  const totalPts    = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const avgPts      = totalPts / Math.max(n, 1);
  // Átlagosan ~2 pt/meccs → fordulók száma
  const roundsPlayed = clamp(Math.round(avgPts / 2), 1, SEASON_ROUNDS - 1);
  const roundsLeft   = SEASON_ROUNDS - roundsPlayed;
  const pctDone      = roundsPlayed / SEASON_ROUNDS; // 0..1

  // Várható teljes szezon pontok (egyenes arányú extrapoláció per csapat)
  const withProjection = standings.map(t => {
    const pts     = t.pts || 0;
    const gf      = t.goalsFor || 0;
    const ga      = t.goalsAgainst || 0;
    const gd      = gf - ga;
    // Lineáris vetítés a szezon végére
    const projPts = pctDone > 0 ? Math.round(pts / pctDone) : pts + roundsLeft * 2;
    const projGF  = pctDone > 0 ? Math.round(gf / pctDone)  : gf  + roundsLeft;
    const projGA  = pctDone > 0 ? Math.round(ga / pctDone)  : ga  + roundsLeft;
    // Pont/forduló arány (jobb összehasonlítási alap mint a nyers pont)
    const ptsPerRound = roundsPlayed > 0 ? +(pts / roundsPlayed).toFixed(2) : 0;
    const gfPerRound  = roundsPlayed > 0 ? +(gf  / roundsPlayed).toFixed(2) : 0;
    const gaPerRound  = roundsPlayed > 0 ? +(ga  / roundsPlayed).toFixed(2) : 0;

    return {
      ...t,
      pts, gf, ga, gd,
      projPts, projGF, projGA,
      ptsPerRound, gfPerRound, gaPerRound,
    };
  });

  return { withProjection, roundsPlayed, roundsLeft, pctDone };
}

// ─── History trendek ──────────────────────────────────────────────────────────

async function loadHistoryTrends(seasonId) {
  const keys = seasonId
    ? [`vsport:league_history:season:${seasonId}`, 'vsport:league_history']
    : ['vsport:league_history'];

  let entries = null;
  for (const key of keys) {
    const raw = await kvGet(key);
    if (raw) { try { entries = JSON.parse(raw); break; } catch { /* next */ } }
  }

  if (!Array.isArray(entries) || entries.length < 2) {
    return { lines: '', teamStats: {}, entryCount: entries?.length || 0 };
  }

  const teamMap = {};
  for (const entry of entries) {
    for (const t of (entry.standingsSnapshot || [])) {
      (teamMap[t.team] = teamMap[t.team] || []).push({
        pos: t.pos, pts: t.pts || 0, gf: t.goalsFor || 0, ga: t.goalsAgainst || 0,
      });
    }
  }

  const teamStats = {};
  for (const [team, hist] of Object.entries(teamMap)) {
    if (hist.length < 2) { teamStats[team] = { trend: 'same', ptsPerRound: 0 }; continue; }

    const first = hist[0], last = hist.at(-1);
    const posChange  = first.pos - last.pos;
    const ptsGrowth  = last.pts - first.pts;
    const ptsPerRound = +(ptsGrowth / (hist.length - 1)).toFixed(2);

    let trend = 'same';
    if (hist.length >= 4) {
      const mid     = Math.floor(hist.length / 2);
      const recAvg  = hist.slice(mid).reduce((s, h) => s + h.pos, 0) / (hist.length - mid);
      const earAvg  = hist.slice(0, mid).reduce((s, h) => s + h.pos, 0) / mid;
      if (recAvg < earAvg - 0.8)      trend = 'up';
      else if (recAvg > earAvg + 0.8) trend = 'down';
    } else {
      if (posChange >  1) trend = 'up';
      if (posChange < -1) trend = 'down';
    }

    teamStats[team] = { trend, ptsPerRound, posChange };
  }

  const tL = t => t === 'up' ? '▲' : t === 'down' ? '▼' : '►';
  const lines = Object.entries(teamStats)
    .map(([team, s]) =>
      `  ${team.padEnd(22)} ${tL(s.trend)} ${s.ptsPerRound > 0 ? '+' : ''}${s.ptsPerRound}pt/forduló  poz.változás:${s.posChange > 0 ? '+' : ''}${s.posChange}`
    ).join('\n');

  return { lines, teamStats, entryCount: entries.length };
}

// ─── Prompt felépítés ─────────────────────────────────────────────────────────
// KULCS VÁLTOZTATÁS: az AI pt/forduló rátát és szezonvégi VETÍTÉST lát,
// NEM a jelenlegi nyers pontot → nem tud "visszahúzódni" a jelenlegire

function buildPrompts({ withProjection, roundsPlayed, roundsLeft, pctDone }, histLines) {
  const system = `Te egy futball-statisztikus vagy, aki szezonvégi tabellát jósol.
Kizárólag valid JSON-t adsz vissza a megadott formátumban – semmi más szöveg, semmi markdown.
A végső tabellában a pozíciók 1-től N-ig folyamatosak, ismétlés nélkül.`;

  // Táblázat: csapat, pt/forduló arány, GF/GA ráta, lineáris vetítés
  const rows = withProjection
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map(t => [
      `  ${String(t.pos).padStart(2)}. ${t.team.padEnd(22)}`,
      `pt/fd:${t.ptsPerRound.toFixed(2).padStart(5)}`,
      `GF/fd:${t.gfPerRound.toFixed(2).padStart(5)}`,
      `GA/fd:${t.gaPerRound.toFixed(2).padStart(5)}`,
      `GD:${t.gd >= 0 ? '+' : ''}${t.gd}`,
      `→ lin.vetítés: ${t.projPts}pt (${t.projGF}:${t.projGA})`,
      `trend:${t.trend || 'same'}`,
    ].join('  ')
    ).join('\n');

  const histSection = histLines
    ? `\n# HISTORY TRENDEK (korábbi fordulók)\n${histLines}\n`
    : '';

  const totalTeams = withProjection.length;

  const user = `
# SZEZON ÁLLAPOTA
Lejátszott fordulók: ${roundsPlayed} / ${SEASON_ROUNDS}  (${Math.round(pctDone * 100)}% kész)
Hátralévő fordulók: ${roundsLeft}
Csapatok száma: ${totalTeams}

# CSAPATOK TELJESÍTMÉNYE (forduló-normalizált adatok)
${rows}
${histSection}
# FELADAT
Jósold meg a szezon végi végső tabellát a ${roundsLeft} hátralévő forduló alapján.

Gondolkodj így:
- Melyik csapat tart fenn erős pt/forduló rátát → valószínűleg folytatja
- Melyik csapat gyengülő / erősödő trendben van → korrigálj a lin.vetítésen
- A lin.vetítés kiindulási alap, DE az AI felülbírálhatja ha a trend indokolja
- Legyenek VALÓDI különbségek a csapatok között – ne mindenki hasonló ponttal végezzen
- A bajnok tipikusan 70-90pt, a kiesők 25-45pt körül végeznek (34 fordulós liga)

MEGSZORÍTÁS: A végső pontszámok MINDENKÉPPEN magasabbak legyenek a jelenlegi pontoknál.

VÁLASZ – PONTOSAN ebben a formátumban, semmi más:
STANDINGS:
[{"pos":1,"team":"NévPontosan","goalsFor":55,"goalsAgainst":22,"pts":82,"trend":"up"}]
ANALYSIS:
2-3 mondat magyarul: ki nyeri a bajnokságot és miért, kik eshetnek ki, van-e meglepetés.
`.trim();

  return { system, user };
}

// ─── LLM válasz parse ─────────────────────────────────────────────────────────

function parseResponse(text) {
  // STANDINGS szekció kinyerése – greedy match a záró ] -ig
  const sMatch = text.match(/STANDINGS:\s*(\[[\s\S]*?\])[\s\S]*?(?=ANALYSIS:|$)/);
  if (!sMatch) {
    // Fallback: keressünk bármilyen JSON tömböt
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error('Nem található JSON tömb a válaszban');
    const parsed = JSON.parse(arrMatch[0]);
    const aMatch = text.match(/ANALYSIS:\s*([\s\S]+)$/);
    return { parsed, analysis: aMatch?.[1]?.trim() || '' };
  }

  const parsed = JSON.parse(sMatch[1]);
  const aMatch = text.match(/ANALYSIS:\s*([\s\S]+)$/);
  return { parsed, analysis: aMatch?.[1]?.trim() || '' };
}

// ─── Validálás & post-processing ─────────────────────────────────────────────

function buildFinalStandings(parsed, analysis, withProjection, standings, roundsLeft) {
  const realTeams = new Set(standings.map(t => t.team));
  const aiTeams   = new Set(parsed.map(t => t.team));
  const missing   = [...realTeams].filter(t => !aiTeams.has(t));

  // Ha az AI kihagyott csapatokat → teljes matematikai fallback
  if (missing.length > 0 || parsed.length < standings.length * 0.8) {
    console.warn('[ai-prediction] AI kihagyott csapatokat, matematikai fallback. Missing:', missing);
    const sorted = withProjection.slice().sort((a, b) => b.projPts - a.projPts);
    return {
      standings: sorted.map((t, i) => ({
        pos: i + 1, team: t.team,
        goalsFor: t.projGF, goalsAgainst: t.projGA,
        pts: t.projPts, trend: t.trend || 'same',
      })),
      analysis,
    };
  }

  // Az AI adta a csapatokat → csak minimális biztonsági korrekció
  const currentPtsByTeam = Object.fromEntries(standings.map(t => [t.team, t.pts || 0]));
  const projByTeam       = Object.fromEntries(withProjection.map(t => [t.team, t]));

  let result = parsed.map((r, i) => {
    const currentPts = currentPtsByTeam[r.team] ?? 0;
    const proj       = projByTeam[r.team];

    let pts = parseInt(r.pts) || 0;

    // Kötelező: a végső pont > jelenlegi pont
    if (pts <= currentPts) {
      pts = currentPts + Math.max(Math.round(roundsLeft * 1.2), 5);
    }

    // Opcionális: ne legyen irreálisan magas sem (max 102pt 34 fordulóban)
    pts = clamp(pts, currentPts + 1, 102);

    return {
      pos:          parseInt(r.pos) || (i + 1),
      team:         String(r.team),
      goalsFor:     Math.max(parseInt(r.goalsFor)     || proj?.projGF  || 0, proj?.gf  || 0),
      goalsAgainst: Math.max(parseInt(r.goalsAgainst) || proj?.projGA  || 0, proj?.ga  || 0),
      pts,
      trend:        String(r.trend || 'same'),
    };
  });

  // Rendezés pontszám szerint, pozíció újraszámítás
  result.sort((a, b) => b.pts - a.pts);
  result.forEach((t, i) => { t.pos = i + 1; });

  return { standings: result, analysis };
}

// ─── Főbb generáló logika ─────────────────────────────────────────────────────

async function generatePrediction(standings, seasonId) {
  const seasonState = computeSeasonState(standings);
  const { lines: histLines, teamStats, entryCount } = await loadHistoryTrends(seasonId);

  // Beleolvasztjuk a history trendet a csapat adataiba
  const enriched = {
    ...seasonState,
    withProjection: seasonState.withProjection.map(t => ({
      ...t,
      trend: teamStats[t.team]?.trend || t.trend || 'same',
    })),
  };

  const { system, user } = buildPrompts(enriched, histLines);
  const text = await llmCall(system, user, 0.72); // magasabb temp = merészebb előrejelzés

  const { parsed, analysis } = parseResponse(text);
  const { standings: aiStandings, analysis: finalAnalysis } = buildFinalStandings(
    parsed, analysis,
    enriched.withProjection,
    standings,
    enriched.roundsLeft,
  );

  if (!aiStandings.length) throw new Error('Üres végeredmény');

  return {
    standings:          aiStandings,
    analysis:           finalAnalysis,
    generatedAt:        new Date().toISOString(),
    basedOnFingerprint: fingerprint(standings),
    seasonId:           seasonId || null,
    basedOnRounds:      enriched.roundsPlayed,
    roundsLeft:         enriched.roundsLeft,
    hasHistoryData:     entryCount > 0,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    // GET – cache lekérés
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

    // POST – generálás
    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); }
      catch { return jsonRes({ error: 'Érvénytelen JSON body' }, 400); }

      const { standings, seasonId, force = false } = body;

      if (!Array.isArray(standings) || !standings.length) {
        return jsonRes({ error: '"standings" mező kötelező és nem lehet üres.' }, 400);
      }

      const currentFP = fingerprint(standings);

      // Cache hit ellenőrzés
      if (!force) {
        const rawMeta = await kvGet(KV_KEYS.meta);
        if (rawMeta) {
          let meta = null;
          try { meta = JSON.parse(rawMeta); } catch { /* ignore */ }
          if (meta) {
            const seasonOk = !seasonId || !meta.seasonId || String(seasonId) === String(meta.seasonId);
            if (seasonOk && meta.basedOnFingerprint === currentFP) {
              const rawPred = await kvGet(KV_KEYS.prediction);
              let prediction = null;
              try { prediction = rawPred ? JSON.parse(rawPred) : null; } catch { /* ignore */ }
              if (prediction) {
                return jsonRes({ prediction, meta, regenerated: false, reason: 'already_current' });
              }
            }
          }
        }
      }

      console.log('[ai-prediction] Generálás... force=', force, 'seasonId=', seasonId);
      const prediction = await generatePrediction(standings, seasonId);

      const meta = {
        generatedAt:        prediction.generatedAt,
        basedOnFingerprint: prediction.basedOnFingerprint,
        seasonId:           prediction.seasonId,
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
