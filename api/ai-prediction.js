// api/ai-prediction.js – v9 · llm7.io · erős változás, valódi előrejelzés
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
  timeout:   35_000,
  maxTokens: 6000,
};

const KV_KEYS = {
  prediction: 'vsport:ai_prediction',
  meta:       'vsport:ai_meta',
};

const SEASON_ROUNDS = 34;
const MIN_POS_CHANGE = 3; // minimum ennyi helyet el kell mozdulnia a legtöbb csapatnak

// ─── Segédek ─────────────────────────────────────────────────────────────────

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const rnd = v => Math.round(v * 10) / 10;

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

// ─── LLM hívás ───────────────────────────────────────────────────────────────

async function llmCall(systemPrompt, userPrompt, temp = 0.85, retries = 2) {
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
      await sleep(900 * (i + 1));
    }
  }
}

// ─── Ujjlenyomat ─────────────────────────────────────────────────────────────

function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ─── Szezon állapot + forduló-normalizált metrikák ───────────────────────────

function buildSeasonMetrics(standings) {
  const totalPts     = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const avgPts       = totalPts / Math.max(standings.length, 1);
  const roundsPlayed = clamp(Math.round(avgPts / 2), 1, SEASON_ROUNDS - 1);
  const roundsLeft   = SEASON_ROUNDS - roundsPlayed;
  const pctDone      = roundsPlayed / SEASON_ROUNDS;

  const metrics = standings.map(t => {
    const pts = t.pts || 0;
    const gf  = t.goalsFor  || 0;
    const ga  = t.goalsAgainst || 0;
    const gd  = gf - ga;

    const ptsPerRound = roundsPlayed > 0 ? rnd(pts / roundsPlayed) : 0;
    const gfPerRound  = roundsPlayed > 0 ? rnd(gf  / roundsPlayed) : 0;
    const gaPerRound  = roundsPlayed > 0 ? rnd(ga  / roundsPlayed) : 0;

    // Lineáris vetítés – ez az alap amit az AI felülbírálhat
    const projPts = pctDone > 0 ? Math.round(pts / pctDone) : pts + roundsLeft * 2;
    const projGF  = pctDone > 0 ? Math.round(gf  / pctDone) : gf  + roundsLeft;
    const projGA  = pctDone > 0 ? Math.round(ga  / pctDone) : ga  + roundsLeft;

    return {
      team: t.team,
      currentPos: t.pos,
      currentPts: pts,
      gf, ga, gd,
      ptsPerRound, gfPerRound, gaPerRound,
      projPts, projGF, projGA,
    };
  });

  // Rangsorolás pt/forduló szerint → ez lesz a "várható" sorrend
  const sorted = metrics.slice().sort((a, b) => {
    if (b.ptsPerRound !== a.ptsPerRound) return b.ptsPerRound - a.ptsPerRound;
    return b.gd - a.gd; // GD dönt ha egyenlő
  });
  sorted.forEach((t, i) => { t.expectedPos = i + 1; });

  return { metrics, roundsPlayed, roundsLeft, pctDone };
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
        pos: t.pos, pts: t.pts || 0,
      });
    }
  }

  const teamStats = {};
  for (const [team, hist] of Object.entries(teamMap)) {
    if (hist.length < 2) continue;

    const gains = [];
    for (let i = 1; i < hist.length; i++) gains.push(hist[i].pts - hist[i - 1].pts);
    const avgGain = +(gains.reduce((a, b) => a + b, 0) / gains.length).toFixed(2);

    const posFirst = hist[0].pos;
    const posLast  = hist.at(-1).pos;
    const posDelta = posFirst - posLast; // pozitív = javult

    let momentum = 'stagnál';
    if (hist.length >= 4) {
      const mid    = Math.floor(hist.length / 2);
      const recAvg = hist.slice(mid).reduce((s, h) => s + h.pts, 0) / (hist.length - mid);
      const earAvg = hist.slice(0, mid).reduce((s, h) => s + h.pts, 0) / mid;
      const diff   = recAvg - earAvg;
      if (diff > 2)       momentum = 'erősen emelkedő';
      else if (diff > 0.5) momentum = 'emelkedő';
      else if (diff < -2)  momentum = 'erősen eső';
      else if (diff < -0.5) momentum = 'eső';
    }

    teamStats[team] = { avgGain, posDelta, momentum, samples: hist.length };
  }

  const lines = Object.entries(teamStats)
    .map(([team, s]) =>
      `  ${team.padEnd(24)} momentum:${s.momentum.padEnd(18)} ${s.avgGain > 0 ? '+' : ''}${s.avgGain}pt/fd  poz.δ:${s.posDelta > 0 ? '+' : ''}${s.posDelta}  (${s.samples} forduló)`
    ).join('\n');

  return { lines, teamStats, entryCount: entries.length };
}

// ─── Prompt felépítés ─────────────────────────────────────────────────────────
// KULCS: az AI NEM látja a jelenlegi pozíciókat és pontokat!
// Csak forduló-normalizált teljesítményt és trendet lát.

function buildPrompts({ metrics, roundsPlayed, roundsLeft, pctDone }, histLines, histStats) {
  const n = metrics.length;

  const system = `Te egy merész, független futball-statisztikus vagy aki valódi szezonvégi előrejelzést készít.
NEM másolod vissza a jelenlegi tabellát. Komoly elemzés alapján megváltoztatod a sorrendet.
Kizárólag a megadott formátumban válaszolsz. Semmi markdown, semmi magyarázat.`;

  // Az AI NEM látja: pos, pts – csak teljesítmény-rátákat és trendeket
  // Ez megakadályozza hogy "visszahúzódjon" a jelenlegi álláshoz
  const metricsBlock = metrics
    .map(t => {
      const hist = histStats[t.team];
      const momentum = hist?.momentum || 'ismeretlen';
      return [
        `  ${t.team.padEnd(24)}`,
        `pt/fd:${String(t.ptsPerRound).padStart(4)}`,
        `GF/fd:${String(t.gfPerRound).padStart(4)}`,
        `GA/fd:${String(t.gaPerRound).padStart(4)}`,
        `GD:${t.gd >= 0 ? '+' : ''}${t.gd}`,
        `lin.vetítés:${t.projPts}pt`,
        `momentum:${momentum}`,
      ].join('  ');
    }).join('\n');

  const histSection = histLines
    ? `\n# RÉSZLETES HISTORY TRENDEK\n${histLines}\n`
    : '';

  // Várható ponthatárok egy 34 fordulós ligában
  const champMin  = Math.round(SEASON_ROUNDS * 2.2);  // ~75pt
  const champMax  = SEASON_ROUNDS * 3;                // 102pt
  const relegMin  = Math.round(SEASON_ROUNDS * 0.8);  // ~27pt
  const relegMax  = Math.round(SEASON_ROUNDS * 1.3);  // ~44pt

  const user = `
# SZEZON ÁLLAPOTA
Lejátszott fordulók: ${roundsPlayed} / ${SEASON_ROUNDS}  (${Math.round(pctDone * 100)}% teljesítve)
Hátralévő fordulók: ${roundsLeft}
Csapatok száma: ${n}

# CSAPATOK TELJESÍTMÉNYE (forduló-normalizálva)
(A "lin.vetítés" az egyenes arányú extrapoláció – te ettől ELTÉRHETSZ a momentum alapján)
${metricsBlock}
${histSection}
# FELADAT
Jósold meg a szezon VÉGI végső tabellát. Gondolkodj így:

1. Ki tartja fenn a magas pt/forduló rátát a szezon végéig?
2. Kinek van emelkedő momentuma → valószínűleg túlteljesít a lin.vetítésen
3. Kinek van eső momentuma → valószínűleg alulteljesít
4. Legyenek KOMOLY pozíció-változások – ez egy előrejelzés, nem a jelenlegi állás másolata!
5. Bajnok tipikusan ${champMin}-${champMax}pt, kiesők ${relegMin}-${relegMax}pt körül

KÖTELEZŐ: A végső sorrend SZIGNIFIKÁNSAN különbözzön az aktuális teljesítmény-sorrendtől.
Legalább a csapatok 60%-ánál legyen 3+ helyes változás a lin.vetítéshez képest.

VÁLASZ – pontosan ebben a formátumban, SEMMI MÁS:
STANDINGS:
[{"pos":1,"team":"CsapatNév","goalsFor":55,"goalsAgainst":22,"pts":82,"trend":"up"}]
ANALYSIS:
3-4 mondat magyarul: ki nyeri a bajnokságot és miért, ki esik ki, ki a nagy meglepetés, milyen drámai fordulatok várhatók.
`.trim();

  return { system, user };
}

// ─── LLM válasz parse ─────────────────────────────────────────────────────────

function parseResponse(text) {
  // Elsődleges: STANDINGS: [...] ANALYSIS: ... struktúra
  const sMatch = text.match(/STANDINGS:\s*(\[[\s\S]*?\])\s*(?=ANALYSIS:|$)/);
  if (sMatch) {
    const parsed   = JSON.parse(sMatch[1]);
    const aMatch   = text.match(/ANALYSIS:\s*([\s\S]+)$/);
    return { parsed, analysis: aMatch?.[1]?.trim() || '' };
  }

  // Fallback: bármilyen JSON tömb
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const parsed = JSON.parse(arrMatch[0]);
    const aMatch = text.match(/ANALYSIS:\s*([\s\S]+)$/);
    return { parsed, analysis: aMatch?.[1]?.trim() || '' };
  }

  throw new Error('Nem található JSON tömb a válaszban');
}

// ─── Post-processing: kikényszerített pozíció változások ─────────────────────

function enforceChanges(aiStandings, metrics, standings, roundsLeft) {
  const currentPosByTeam = Object.fromEntries(standings.map(t => [t.team, t.pos]));
  const currentPtsByTeam = Object.fromEntries(standings.map(t => [t.team, t.pts || 0]));
  const projByTeam       = Object.fromEntries(metrics.map(t => [t.team, t]));
  const n                = standings.length;

  // 1. Pontok javítása: végső pont > jelenlegi pont
  let result = aiStandings.map(r => {
    const currentPts = currentPtsByTeam[r.team] ?? 0;
    const proj       = projByTeam[r.team];

    let pts = parseInt(r.pts) || 0;
    if (pts <= currentPts) {
      pts = currentPts + Math.max(Math.round(roundsLeft * 1.4), 6);
    }
    pts = clamp(pts, currentPts + 1, 102);

    return {
      pos:          parseInt(r.pos) || 1,
      team:         String(r.team),
      goalsFor:     Math.max(parseInt(r.goalsFor)     || proj?.projGF || 0, proj?.gf || 0),
      goalsAgainst: Math.max(parseInt(r.goalsAgainst) || proj?.projGA || 0, proj?.ga || 0),
      pts,
      trend:        String(r.trend || 'same'),
    };
  });

  // 2. Rendezés pontszám szerint
  result.sort((a, b) => b.pts - a.pts);
  result.forEach((t, i) => { t.pos = i + 1; });

  // 3. Kikényszerített változások – ha az AI túl konzervatív volt
  const unchanged = result.filter(t => {
    const orig = currentPosByTeam[t.team];
    return orig && Math.abs(t.pos - orig) < MIN_POS_CHANGE;
  });

  // Ha a csapatok több mint 50%-a nem mozdult el legalább 3 helyet → beavatkozunk
  if (unchanged.length > result.length * 0.5) {
    console.warn(`[ai-prediction] Túl kevés változás (${unchanged.length}/${result.length}), pozíció korrekció...`);

    // Sorba rendezzük pt/forduló alapján a várható sorrendet
    const byPtsPerRound = metrics.slice().sort((a, b) => {
      if (b.ptsPerRound !== a.ptsPerRound) return b.ptsPerRound - a.ptsPerRound;
      return b.gd - a.gd;
    });

    // Minden csapatnál: ha a pt/forduló alapú várható pozíció legalább 3-mal
    // különbözik a jelenlegi pozíciótól, módosítsuk a pontszámot hogy tükrözze
    byPtsPerRound.forEach((m, expectedIdx) => {
      const expectedPos = expectedIdx + 1;
      const currentPos  = currentPosByTeam[m.team] || expectedPos;
      const posChange   = currentPos - expectedPos; // pozitív = javul

      if (Math.abs(posChange) >= MIN_POS_CHANGE) {
        const entry = result.find(r => r.team === m.team);
        if (!entry) return;

        // Pontbónusz/büntetés a várható elmozdulás alapján
        const bonus = Math.round(posChange * (roundsLeft * 0.15));
        entry.pts   = clamp(entry.pts + bonus, (currentPtsByTeam[m.team] || 0) + 1, 102);
      }
    });

    // Újrarendezés
    result.sort((a, b) => b.pts - a.pts);
    result.forEach((t, i) => { t.pos = i + 1; });
  }

  // 4. Trend frissítése a tényleges változás alapján
  result.forEach(t => {
    const orig = currentPosByTeam[t.team];
    if (!orig) return;
    const delta = orig - t.pos; // pozitív = javult
    if (delta >= MIN_POS_CHANGE)       t.trend = 'up';
    else if (delta <= -MIN_POS_CHANGE) t.trend = 'down';
    else                               t.trend = 'same';
  });

  return result;
}

// ─── Validálás (csapat-ellenőrzés) ───────────────────────────────────────────

function validateTeams(parsed, metrics, standings, roundsLeft) {
  const realTeams = new Set(standings.map(t => t.team));
  const aiTeams   = new Set(parsed.map(t => t.team));
  const missing   = [...realTeams].filter(t => !aiTeams.has(t));

  if (missing.length > standings.length * 0.2 || parsed.length < standings.length * 0.7) {
    console.warn('[ai-prediction] Túl sok hiányzó csapat, matematikai fallback. Missing:', missing);

    // Matematikai fallback: pt/forduló alapú sorrend
    const sorted = metrics.slice().sort((a, b) => {
      if (b.ptsPerRound !== a.ptsPerRound) return b.ptsPerRound - a.ptsPerRound;
      return b.gd - a.gd;
    });

    return sorted.map((t, i) => ({
      pos: i + 1, team: t.team,
      goalsFor: t.projGF, goalsAgainst: t.projGA,
      pts: t.projPts, trend: 'same',
    }));
  }

  return parsed;
}

// ─── Főlogika ─────────────────────────────────────────────────────────────────

async function generatePrediction(standings, seasonId) {
  const seasonData = buildSeasonMetrics(standings);
  const { lines: histLines, teamStats: histStats, entryCount } =
    await loadHistoryTrends(seasonId);

  // History trendeket beolvasztjuk a metrics-be
  seasonData.metrics = seasonData.metrics.map(t => ({
    ...t,
    trend: histStats[t.team]?.momentum || 'stagnál',
  }));

  const { system, user } = buildPrompts(seasonData, histLines, histStats);

  console.log('[ai-prediction] LLM hívás, temp=0.85...');
  const text = await llmCall(system, user, 0.85);

  let { parsed, analysis } = parseResponse(text);

  // Csapat validáció
  parsed = validateTeams(parsed, seasonData.metrics, standings, seasonData.roundsLeft);

  // Post-processing: pontok javítása + változások kikényszerítése
  const finalStandings = enforceChanges(
    parsed, seasonData.metrics, standings, seasonData.roundsLeft
  );

  if (!finalStandings.length) throw new Error('Üres végeredmény');

  // Statisztika loggolás
  const changes = finalStandings.map(t => {
    const orig = standings.find(s => s.team === t.team);
    return orig ? Math.abs(t.pos - orig.pos) : 0;
  });
  const avgChange = rnd(changes.reduce((a, b) => a + b, 0) / changes.length);
  console.log(`[ai-prediction] Átlagos pozíció változás: ${avgChange} hely`);

  return {
    standings:          finalStandings,
    analysis,
    generatedAt:        new Date().toISOString(),
    basedOnFingerprint: fingerprint(standings),
    seasonId:           seasonId || null,
    basedOnRounds:      seasonData.roundsPlayed,
    roundsLeft:         seasonData.roundsLeft,
    hasHistoryData:     entryCount > 0,
    avgPositionChange:  avgChange,
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

      // Cache hit
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
