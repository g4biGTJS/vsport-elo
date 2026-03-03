// api/match-tips.js – v9 ULTRA PRECÍZ MODELL
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HOME_ADVANTAGE = 55; // finomhangolt hazai előny

// ─────────────────────────────────────────────────────────────
// ELO SYSTEM
// ─────────────────────────────────────────────────────────────
function teamElo(pos, pts, n, maxPts, formBonus = 0) {
  if (!n || n <= 1) return 1500;

  const posStrength = (n - pos) / (n - 1);
  const ptsStrength = maxPts > 0 ? pts / maxPts : 0;

  const elo =
    1300 +
    posStrength * 500 +
    ptsStrength * 250 +
    formBonus;

  return Math.round(elo);
}

function eloProb(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// ─────────────────────────────────────────────────────────────
// POISSON
// ─────────────────────────────────────────────────────────────
function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let log = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) log -= Math.log(i);
  return Math.exp(log);
}

function overGoals(lambda, line) {
  let sum = 0;
  for (let k = 0; k <= line; k++) {
    sum += poisson(lambda, k);
  }
  return Math.round((1 - sum) * 100);
}

// ─────────────────────────────────────────────────────────────
// MAIN CALCULATION
// ─────────────────────────────────────────────────────────────
function calcMatch(home, away, standings, forms) {
  const n = standings.length;
  const maxPts = Math.max(...standings.map(t => t.pts || 0), 1);

  const sH = standings.find(t => t.team === home);
  const sA = standings.find(t => t.team === away);

  const fH = forms?.[home];
  const fA = forms?.[away];

  const posH = sH?.pos ?? Math.ceil(n / 2);
  const posA = sA?.pos ?? Math.ceil(n / 2);
  const ptsH = sH?.pts ?? Math.round(maxPts * 0.45);
  const ptsA = sA?.pts ?? Math.round(maxPts * 0.45);

  const formBonusH = fH ? (fH.last5Avg - 1.5) * 35 : 0;
  const formBonusA = fA ? (fA.last5Avg - 1.5) * 35 : 0;

  const eloH_base = teamElo(posH, ptsH, n, maxPts, formBonusH);
  const eloA_base = teamElo(posA, ptsA, n, maxPts, formBonusA);

  const eloH = eloH_base + HOME_ADVANTAGE;
  const eloA = eloA_base;

  const diff = eloH_base - eloA_base;

  const rawHome = eloProb(eloH, eloA);
  const rawAway = eloProb(eloA, eloH);

  // Dinamikus döntetlen modell
  let drawRate = 0.28 - Math.abs(diff) / 900;
  drawRate = Math.max(0.08, Math.min(0.30, drawRate));

  const pool = 1 - drawRate;

  let h = rawHome * pool;
  let a = rawAway * pool;
  let d = drawRate;

  // Normalizálás
  const sum = h + a + d;
  h /= sum;
  a /= sum;
  d /= sum;

  let homePct = Math.round(h * 100);
  let awayPct = Math.round(a * 100);
  let drawPct = 100 - homePct - awayPct;

  // ─────────────────────────────────────────────────────────────
  // xG MODELL – támadó vs védekező erő
  // ─────────────────────────────────────────────────────────────

  const leagueAvg = 1.45;

  const attackH = fH?.avgGF5 ?? leagueAvg;
  const defenseH = fH?.avgGA5 ?? leagueAvg;
  const attackA = fA?.avgGF5 ?? leagueAvg;
  const defenseA = fA?.avgGA5 ?? leagueAvg;

  const xGH = attackH * (defenseA / leagueAvg) * 1.05;
  const xGA = attackA * (defenseH / leagueAvg);

  const totalXG = xGH + xGA;

  const over15 = overGoals(totalXG, 1);
  const over25 = overGoals(totalXG, 2);

  return {
    homePct,
    drawPct,
    awayPct,
    over15Pct: over15,
    over25Pct: over25,

    // debug
    _eloDiff: Math.round(diff),
    _xG: Math.round(totalXG * 100) / 100,
    _posH: posH,
    _posA: posA,
    _ptsH: ptsH,
    _ptsA: ptsA,
  };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders });

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    const body = await req.json();
    const { matches, standings, forms } = body;

    if (!matches?.length) {
      return new Response(
        JSON.stringify({ error: 'Hiányzó matches' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const results = matches.map(m =>
      calcMatch(m.home, m.away, standings || [], forms || {})
    );

    return new Response(
      JSON.stringify({
        results,
        count: results.length
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
