// api/match-tips.js – v5: Dixon-Coles Poisson modell, valódi statisztikai elemzés
// Nincs hazai/vendég előny – csak objektív csapaterő számít
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ════════════════════════════════════════════════════════════════════════════
// § 1. MATEMATIKAI ESZKÖZTÁR
// ════════════════════════════════════════════════════════════════════════════

/** Poisson P(X = k) – log-térben számol a numerikus stabilitásért */
function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k < 0) return 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Dixon-Coles Poisson modell:
 * Visszaad { home, draw, away } valószínűségeket 0–1 között.
 * lambdaH, lambdaA: a két csapat várható gólszáma.
 * rho: alacsony gólszámú eredmények korrekciója (általában -0.13).
 */
function dixonColes(lambdaH, lambdaA, rho = -0.13) {
  const MAX = 10;
  let pH = 0, pD = 0, pA = 0;

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      let p = poisson(lambdaH, h) * poisson(lambdaA, a);

      // Dixon-Coles tau korrekció alacsony gólszámokra
      if (h === 0 && a === 0) p *= Math.max(1 - lambdaH * lambdaA * rho, 0);
      else if (h === 1 && a === 0) p *= Math.max(1 + lambdaA * rho, 0);
      else if (h === 0 && a === 1) p *= Math.max(1 + lambdaH * rho, 0);
      else if (h === 1 && a === 1) p *= Math.max(1 - rho, 0);

      if (h > a) pH += p;
      else if (h === a) pD += p;
      else pA += p;
    }
  }

  const total = Math.max(pH + pD + pA, 1e-10);
  return { home: pH / total, draw: pD / total, away: pA / total };
}

/** P(összgól > threshold) Poisson-konvolúcióval */
function probOverGoals(lambdaH, lambdaA, threshold) {
  const MAX = 14;
  let pUnder = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      if (h + a <= threshold) pUnder += poisson(lambdaH, h) * poisson(lambdaA, a);
    }
  }
  return Math.min(Math.max(1 - pUnder, 0), 1);
}

/** Logisztikus erőkülönbség → lambda konverzió. BASE_LAMBDA a ligaátlag xG. */
function strengthToLambda(ownStr, oppStr, baseLambda = 1.30) {
  const k = 0.030; // 33 erőpontnyi különbség ~2.7x arány
  return baseLambda * Math.exp(k * (ownStr - oppStr));
}

/** Egész százalék, clampelve */
function toPct(p, min = 5, max = 95) {
  return Math.min(Math.max(Math.round(p * 100), min), max);
}

/** 3 értéket pontosan 100-ra normalizál, min korlátokkal */
function normTo100(a, b, c, minA = 5, minB = 8, minC = 5) {
  a = Math.max(a, minA);
  b = Math.max(b, minB);
  c = Math.max(c, minC);
  const s = a + b + c;
  let ra = Math.round(a / s * 100);
  let rb = Math.round(b / s * 100);
  let rc = 100 - ra - rb;
  if (rc < minC) { rc = minC; rb = Math.max(100 - ra - rc, minB); ra = 100 - rb - rc; }
  if (rb < minB) { rb = minB; ra = Math.max(100 - rb - rc, minA); rc = 100 - ra - rb; }
  return [Math.max(ra, minA), Math.max(rb, minB), Math.max(rc, minC)];
}

// ════════════════════════════════════════════════════════════════════════════
// § 2. CSAPATERŐ MODELL (0-100 skála, NINCS hazai előny)
// ════════════════════════════════════════════════════════════════════════════

function computeStrength(teamName, standings, aiStandings, formData) {
  const n    = Math.max(standings.length, 1);
  const live = standings.find(t => t.team === teamName);
  const ai   = (aiStandings || []).find(t => t.team === teamName);
  const form = formData?.[teamName] ?? null;

  const parts = [];

  // ── A) Élő tabella (45% súly) ──────────────────────────────────────────
  if (live) {
    const gp   = Math.max((live.wins || 0) + (live.draws || 0) + (live.losses || 0), 1);
    const ppg  = live.pts / gp;
    const gdpg = ((live.goalsFor || 0) - (live.goalsAgainst || 0)) / gp;
    const ppgN = ppg / 3 * 100;
    const gdN  = Math.min(Math.max((gdpg + 3) / 6 * 100, 0), 100);
    const posN = (n - live.pos) / Math.max(n - 1, 1) * 100;
    const winR = (live.wins || 0) / gp * 100;
    const xgRatio = (live.goalsAgainst || 0) > 0
      ? Math.min((live.goalsFor || 0) / (live.goalsAgainst || 1) / 2.5 * 100, 100)
      : 60;
    parts.push({
      score: ppgN * 0.35 + gdN * 0.25 + posN * 0.20 + winR * 0.10 + xgRatio * 0.10,
      weight: 0.45,
    });
  }

  // ── B) AI szezonvégi előrejelzés (30% súly) ────────────────────────────
  if (ai && aiStandings && aiStandings.length > 0) {
    const aiN   = aiStandings.length;
    const aiPos = (aiN - ai.pos) / Math.max(aiN - 1, 1) * 100;
    const maxPt = Math.max(...aiStandings.map(t => t.pts || 0), 90);
    const aiPts = Math.min((ai.pts || 0) / maxPt * 100, 100);
    parts.push({ score: aiPos * 0.60 + aiPts * 0.40, weight: 0.30 });
  }

  // ── C) Forma history (25% súly) ────────────────────────────────────────
  if (form) {
    const formN  = Math.min(Math.max(form.avgPtsPerRound / 3 * 100, 0), 100);
    const trendN = Math.min(Math.max((form.positionTrend + 10) / 20 * 100, 0), 100);
    const conN   = form.consistency ?? 50;
    parts.push({ score: formN * 0.50 + trendN * 0.30 + conN * 0.20, weight: 0.25 });
  }

  if (parts.length === 0) return 50;
  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  return parts.reduce((s, p) => s + p.score * (p.weight / totalW), 0);
}

/** Csapat xG/m a standings alapján, ligaátlaghoz regresszálva */
function teamXG(teamName, standings, ligaAvg = 1.30) {
  const t = standings.find(x => x.team === teamName);
  if (!t || !t.goalsFor) return ligaAvg;
  const gp = Math.max((t.wins || 0) + (t.draws || 0) + (t.losses || 0), 1);
  const raw = t.goalsFor / gp;
  const w   = Math.min(gp / 20, 1);
  return raw * w + ligaAvg * (1 - w);
}

// ════════════════════════════════════════════════════════════════════════════
// § 3. FORMA SZÁMÍTÁS HISTORY ALAPJÁN
// ════════════════════════════════════════════════════════════════════════════

function buildFormContext(historyEntries) {
  if (!historyEntries?.length) return null;

  const snapshots = historyEntries
    .filter(e => e.standingsSnapshot?.length >= 2)
    .slice(0, 10)
    .reverse();

  if (snapshots.length < 2) return null;

  const allTeams = new Set(snapshots.flatMap(s => s.standingsSnapshot.map(t => t.team)));
  const result = {};

  allTeams.forEach(teamName => {
    const pts = snapshots
      .map(snap => snap.standingsSnapshot.find(t => t.team === teamName)?.pts ?? null)
      .filter(v => v !== null);

    if (pts.length < 2) return;

    const gains = [];
    for (let i = 1; i < pts.length; i++) gains.push(pts[i] - pts[i - 1]);

    // Exponenciálisan súlyozott mozgóátlag
    const alpha = 0.35;
    let ewma = gains[0];
    for (let i = 1; i < gains.length; i++) ewma = alpha * gains[i] + (1 - alpha) * ewma;

    const firstPos = snapshots[0].standingsSnapshot.find(t => t.team === teamName)?.pos ?? null;
    const lastPos  = snapshots[snapshots.length - 1].standingsSnapshot.find(t => t.team === teamName)?.pos ?? null;
    const posTrend = (firstPos !== null && lastPos !== null) ? firstPos - lastPos : 0;

    const mean     = gains.reduce((a, b) => a + b, 0) / gains.length;
    const variance = gains.reduce((a, b) => a + (b - mean) ** 2, 0) / gains.length;
    const consistency = Math.round(Math.max(0, 1 - Math.sqrt(variance) / 3) * 100);

    const last3 = gains.slice(-3).map(g => g >= 3 ? 'W' : g === 1 ? 'D' : 'L').join('');

    result[teamName] = {
      avgPtsPerRound: Math.round(ewma * 100) / 100,
      positionTrend: posTrend,
      consistency,
      last3,
      trend: ewma >= 2.5 ? 'kiváló' : ewma >= 1.8 ? 'erős' : ewma >= 1.2 ? 'közepes' : ewma >= 0.5 ? 'gyenge' : 'rossz',
      posLabel: posTrend > 0 ? `+${posTrend} hely` : posTrend < 0 ? `${posTrend} hely` : 'stabil',
    };
  });

  return Object.keys(result).length > 0 ? result : null;
}

// ════════════════════════════════════════════════════════════════════════════
// § 4. LOKÁLIS FALLBACK (ha az LLM nem válaszol)
// ════════════════════════════════════════════════════════════════════════════

function computeLocalTips(matches, standings, aiStandings, formData) {
  let ligaXG = 1.30;
  if (standings.length > 0) {
    const tGP = standings.reduce((s, t) => s + Math.max((t.wins||0)+(t.draws||0)+(t.losses||0), 0), 0);
    const tGF = standings.reduce((s, t) => s + (t.goalsFor || 0), 0);
    if (tGP > 0) ligaXG = tGF / tGP;
  }

  return matches.map(m => {
    const sA = computeStrength(m.home, standings, aiStandings, formData);
    const sB = computeStrength(m.away, standings, aiStandings, formData);

    const lambdaA = Math.max(strengthToLambda(sA, sB, ligaXG), 0.20);
    const lambdaB = Math.max(strengthToLambda(sB, sA, ligaXG), 0.20);

    const xgA  = teamXG(m.home, standings, ligaXG);
    const xgB  = teamXG(m.away, standings, ligaXG);
    const blA  = lambdaA * 0.60 + xgA * 0.40;
    const blB  = lambdaB * 0.60 + xgB * 0.40;

    const dc = dixonColes(blA, blB);
    const [hp, dp, ap] = normTo100(dc.home * 100, dc.draw * 100, dc.away * 100);

    const o15 = toPct(probOverGoals(blA, blB, 1), 25, 97);
    const o25 = toPct(probOverGoals(blA, blB, 2), 12, 94);

    const lA = standings.find(t => t.team === m.home);
    const lB = standings.find(t => t.team === m.away);
    const fA = formData?.[m.home];
    const fB = formData?.[m.away];
    const aiA = (aiStandings || []).find(t => t.team === m.home);
    const aiB = (aiStandings || []).find(t => t.team === m.away);

    const favorit   = hp >= ap ? m.home : m.away;
    const diff      = Math.abs(hp - ap);
    const certainty = diff >= 20 ? 'egyértelműen' : diff >= 10 ? 'valamelyest' : 'enyhén';

    const formTxt = fA && fB
      ? ` Forma: ${m.home} (${fA.trend}, ${fA.last3 || '?'}) vs ${m.away} (${fB.trend}, ${fB.last3 || '?'}).`
      : '';
    const aiTxt = aiA && aiB
      ? ` AI szezonvégi: ${m.home} ${aiA.pos}. vs ${m.away} ${aiB.pos}. hely.`
      : '';

    return {
      home: m.home, away: m.away,
      homePct: hp, drawPct: dp, awayPct: ap,
      over15Pct: o15, over25Pct: o25,
      over15Comment: o15 >= 65
        ? `Aktív támadójáték várható (becsült xG: ${blA.toFixed(1)} + ${blB.toFixed(1)})`
        : `Taktikai, alacsony gólszámú mérkőzés (becsült xG: ${blA.toFixed(1)} + ${blB.toFixed(1)})`,
      over25Comment: o25 >= 55
        ? 'A gólátlagok alapján gólgazdag összecsapás valószínűsíthető'
        : 'Az xG-adatok zárt, defenzív meccset vetítenek előre',
      analysis: `${favorit} ${certainty} az esélyes (erőindex: ${Math.round(sA)} vs ${Math.round(sB)}, tabella: ${lA?.pos || '?'}. vs ${lB?.pos || '?'}. hely, ${(lA?.pts || 0)}pt vs ${(lB?.pts || 0)}pt). Várható gólszám: ${blA.toFixed(2)} – ${blB.toFixed(2)}.${formTxt}${aiTxt}`,
      source: 'local',
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// § 5. AI PROMPT ÉPÍTŐ
// ════════════════════════════════════════════════════════════════════════════

function buildPrompt(matches, standings, aiStandings, formData) {
  const n = standings.length || 20;

  let ligaXG = 1.30;
  if (standings.length > 0) {
    const tGP = standings.reduce((s, t) => s + Math.max((t.wins||0)+(t.draws||0)+(t.losses||0), 0), 0);
    const tGF = standings.reduce((s, t) => s + (t.goalsFor || 0), 0);
    if (tGP > 0) ligaXG = tGF / tGP;
  }

  const tableCtx = standings.length
    ? standings.map(t => {
        const gp  = Math.max((t.wins||0)+(t.draws||0)+(t.losses||0), 1);
        const gd  = (t.goalsFor||0) - (t.goalsAgainst||0);
        const ppg = (t.pts / gp).toFixed(2);
        const xg  = ((t.goalsFor||0) / gp).toFixed(2);
        const xgA = ((t.goalsAgainst||0) / gp).toFixed(2);
        return `${String(t.pos).padStart(2)}. ${t.team.padEnd(20)} ${String(t.pts).padStart(3)}pt | ${t.wins||0}W/${t.draws||0}D/${t.losses||0}L | GF:${t.goalsFor||0} GA:${t.goalsAgainst||0} GD:${gd>=0?'+':''}${gd} | ppg:${ppg} | xG/m:${xg} xGA/m:${xgA}`;
      }).join('\n')
    : 'Nem elérhető';

  const aiCtx = (aiStandings||[]).length
    ? aiStandings.map(t => `${t.pos}. ${t.team} → ${t.pts}pt (trend: ${t.trend||'?'})`).join('\n')
    : 'Nem elérhető';

  const formCtx = formData && Object.keys(formData).length
    ? Object.entries(formData)
        .sort((a, b) => b[1].avgPtsPerRound - a[1].avgPtsPerRound)
        .map(([team, f]) =>
          `${team.padEnd(20)} ${f.trend.padEnd(8)} | ${f.avgPtsPerRound}pt/ford | ${f.posLabel} | konz:${f.consistency}% | utolsó3:${f.last3||'?'}`
        ).join('\n')
    : 'Nem elérhető';

  const matchCtx = matches.map((m, i) => {
    const sA  = computeStrength(m.home, standings, aiStandings, formData);
    const sB  = computeStrength(m.away, standings, aiStandings, formData);
    const xgA = teamXG(m.home, standings, ligaXG);
    const xgB = teamXG(m.away, standings, ligaXG);
    const lA  = standings.find(t => t.team === m.home);
    const lB  = standings.find(t => t.team === m.away);
    const ptsDiff = (lA?.pts||0) - (lB?.pts||0);
    return [
      `${i+1}. ${m.home} vs ${m.away}`,
      `   Erőindex: ${Math.round(sA)} vs ${Math.round(sB)} | különbség: ${Math.round(sA-sB)>=0?'+':''}${Math.round(sA-sB)}`,
      `   Tabella: ${lA?.pos||'?'}. (${lA?.pts||0}pt) vs ${lB?.pos||'?'}. (${lB?.pts||0}pt) | ptsDiff: ${ptsDiff>=0?'+':''}${ptsDiff}`,
      `   xG/m: ${xgA.toFixed(2)} vs ${xgB.toFixed(2)} | liga átlag: ${ligaXG.toFixed(2)}`,
    ].join('\n');
  }).join('\n\n');

  return `Te egy profi futball statisztikus vagy. Pontos, adatvezérelt elemzést kell adnod az alábbi meccsekről.

━━━ JELENLEGI TABELLA ━━━
${tableCtx}

━━━ AI SZEZONVÉGI ELŐREJELZÉS ━━━
${aiCtx}

━━━ CSAPATFORMA (history alapján) ━━━
${formCtx}

━━━ MECCSEK ELŐSZÁMÍTOTT ADATOKKAL ━━━
${matchCtx}

━━━ FELADAT ━━━
Minden meccshez generálj pontosan ilyen JSON struktúrát:
{
  "home": "csapatnév (első csapat)",
  "away": "csapatnév (második csapat)",
  "homePct": [egész, 5–90],
  "drawPct": [egész, 8–35],
  "awayPct": [egész, 5–90],
  "over15Pct": [egész, 25–97],
  "over25Pct": [egész, 12–94],
  "over15Comment": "1 mondat magyarul, xG + forma alapján",
  "over25Comment": "1 mondat magyarul",
  "analysis": "2-3 mondat magyarul, KI az esélyes + MIÉRT konkrét számokkal + mi a kockázat"
}

━━━ KÖTELEZŐ SZABÁLYOK ━━━
1. homePct + drawPct + awayPct = PONTOSAN 100
2. A helyszín (hazai/vendég felirat) NEM számít – kizárólag erőindex, tabella, forma, xG
3. Nagy erőkülönbségnél (>15 erőpont különbség): pl. 62-22-16 jellegű, ne 40-30-30
4. Kis erőkülönbségnél (<5 pont): 36-28-36 jellegű közel arányok
5. Döntetlen max 30%, minimum 10%
6. Az over valók legyenek konzisztensek az xG adatokkal
7. Az analysis-ban kötelező: az esélyes neve, konkrét statisztikai ok (pont, GD, erőindex), kockázat

CSAK valid JSON tömböt adj vissza, semmi más szöveget:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"..."}]`;
}

// ════════════════════════════════════════════════════════════════════════════
// § 6. LLM HÍVÁS
// ════════════════════════════════════════════════════════════════════════════

async function callLLM(prompt) {
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.20,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(28000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (text?.trim()) return text;
    }
  } catch (e) {
    console.warn('[match-tips] llm7.io hiba:', e.message);
  }

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
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(28000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text;
        if (text?.trim()) return text;
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic hiba:', e.message);
    }
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// § 7. JSON PARSE + VALIDÁCIÓ + JAVÍTÁS
// ════════════════════════════════════════════════════════════════════════════

function parseAndValidate(llmText, matches) {
  const clean = llmText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Leghosszabb [] blokk megkeresése
  let best = null;
  let depth = 0, start = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '[') { if (depth === 0) start = i; depth++; }
    else if (clean[i] === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        const cand = clean.slice(start, i + 1);
        if (!best || cand.length > best.length) best = cand;
        start = -1;
      }
    }
  }
  if (!best) return null;

  let parsed;
  try { parsed = JSON.parse(best); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  return parsed.map((r, i) => {
    const m    = matches[i] || {};
    const home = String(r.home || m.home || '?');
    const away = String(r.away || m.away || '?');

    let hp = Math.round(Number(r.homePct) || 0);
    let dp = Math.round(Number(r.drawPct) || 0);
    let ap = Math.round(Number(r.awayPct) || 0);

    const sum = hp + dp + ap;
    if (sum !== 100 && sum > 0) { hp = Math.round(hp/sum*100); dp = Math.round(dp/sum*100); ap = 100-hp-dp; }
    else if (sum === 0) { hp = 38; dp = 25; ap = 37; }

    [hp, dp, ap] = normTo100(hp, dp, ap);

    return {
      home, away,
      homePct: hp, drawPct: dp, awayPct: ap,
      over15Pct: Math.min(Math.max(Math.round(Number(r.over15Pct) || 62), 25), 97),
      over25Pct: Math.min(Math.max(Math.round(Number(r.over25Pct) || 42), 12), 94),
      over15Comment: String(r.over15Comment || 'Közepes gólvárhatóság.'),
      over25Comment: String(r.over25Comment || 'Szoros mérkőzés várható.'),
      analysis:      String(r.analysis      || 'Kiegyenlített meccs.'),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// § 8. EDGE HANDLER
// ════════════════════════════════════════════════════════════════════════════

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { matches, standings, aiPrediction, history } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches adat' }), { status: 400, headers: corsHeaders });
    }

    const safeStandings = Array.isArray(standings)              ? standings              : [];
    const aiStandings   = Array.isArray(aiPrediction?.standings)? aiPrediction.standings : [];
    const formData      = buildFormContext(Array.isArray(history) ? history : []);

    const prompt  = buildPrompt(matches, safeStandings, aiStandings, formData);
    const llmText = await callLLM(prompt);

    let results = null;
    let source  = 'local';

    if (llmText) {
      const parsed = parseAndValidate(llmText, matches);
      if (parsed && parsed.length > 0) {
        results = parsed;
        source  = 'ai';
      } else {
        console.warn('[match-tips] AI JSON parse sikertelen – lokális fallback');
      }
    }

    if (!results) {
      results = computeLocalTips(matches, safeStandings, aiStandings, formData);
    }

    // Meccsnevek biztosítása
    results = results.map((r, i) => ({
      ...r,
      home: r.home || matches[i]?.home || '?',
      away: r.away || matches[i]?.away || '?',
    }));

    return new Response(
      JSON.stringify({ results, source, count: results.length }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    console.error('[match-tips] Kritikus hiba:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
