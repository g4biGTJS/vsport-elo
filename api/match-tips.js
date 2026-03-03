// api/match-tips.js – v6: MATH számítja a %-okat, AI csak szöveget ír
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HOME_ELO_BONUS = 50; // ~6% előny azonos erőknél

// ─── Elo ─────────────────────────────────────────────────────────────────────
function teamElo(pos, pts, n, maxPts, formBonus = 0) {
  const posScore = ((n - pos) / Math.max(n - 1, 1)) * 600;
  const ptsScore = maxPts > 0 ? (pts / maxPts) * 300 : 0;
  return Math.round(1000 + posScore + ptsScore + formBonus);
}

function eloWinProb(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

// ─── Poisson ─────────────────────────────────────────────────────────────────
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function overXGoalsPct(lambda, x) {
  let cum = 0;
  for (let k = 0; k <= Math.floor(x); k++) cum += poissonPMF(lambda, k);
  return Math.round(Math.min(Math.max((1 - cum) * 100, 10), 95));
}

// ─── Forma feldolgozás ────────────────────────────────────────────────────────
function buildForms(historyEntries) {
  if (!historyEntries?.length) return {};

  const snaps = historyEntries
    .filter(e => e.standingsSnapshot?.length)
    .slice(0, 20)
    .reverse();

  if (snaps.length < 2) return {};

  const forms = {};
  const teams = new Set(snaps.flatMap(s => s.standingsSnapshot.map(t => t.team)));

  for (const name of teams) {
    const tl = snaps.map(s => {
      const t = s.standingsSnapshot.find(x => x.team === name);
      return t ? { pts: t.pts || 0, pos: t.pos, gf: t.goalsFor || 0, ga: t.goalsAgainst || 0 } : null;
    }).filter(Boolean);

    if (tl.length < 2) continue;

    const gains = [];
    for (let i = 1; i < tl.length; i++) gains.push(tl[i].pts - tl[i - 1].pts);

    const avgGain  = gains.reduce((a, b) => a + b, 0) / gains.length;
    const last5    = gains.slice(-5);
    const last5Avg = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : avgGain;

    const last5snaps = tl.slice(-5);
    const avgGF5 = last5snaps.reduce((s, t) => s + t.gf, 0) / last5snaps.length;
    const avgGA5 = last5snaps.reduce((s, t) => s + t.ga, 0) / last5snaps.length;

    const half = Math.floor(tl.length / 2);
    const earlyPos = tl.slice(0, half).reduce((s, t) => s + t.pos, 0) / half;
    const latePos  = tl.slice(-half).reduce((s, t) => s + t.pos, 0) / half;
    const trend = latePos < earlyPos - 1 ? 'up' : latePos > earlyPos + 1 ? 'down' : 'same';

    const wins   = gains.filter(g => g >= 3).length;
    const draws  = gains.filter(g => g === 1).length;
    const losses = gains.filter(g => g === 0).length;
    const total  = wins + draws + losses;

    forms[name] = {
      last5Avg:  Math.round(last5Avg * 100) / 100,
      avgGF5:    Math.round(avgGF5   * 10)  / 10,
      avgGA5:    Math.round(avgGA5   * 10)  / 10,
      trend,
      winRate:  total ? Math.round(wins   / total * 100) : 0,
      drawRate: total ? Math.round(draws  / total * 100) : 0,
      lossRate: total ? Math.round(losses / total * 100) : 0,
      // Elo módosító: 1.5 pt/forduló az átlag, ennél jobb/rosszabb = +/- Elo
      eloBonus: Math.round((last5Avg - 1.5) * 18),
    };
  }
  return forms;
}

// ─── A FŐ SZÁMÍTÁS – ez adja a végleges %-okat, NEM az AI ───────────────────
function calcMatch(home, away, aiStandings, forms) {
  const n      = aiStandings.length || 20;
  const maxPts = Math.max(...aiStandings.map(t => t.pts || 0), 1);

  const aiH = aiStandings.find(t => t.team === home);
  const aiA = aiStandings.find(t => t.team === away);
  const fH  = forms[home];
  const fA  = forms[away];

  const posH = aiH?.pos ?? Math.round(n / 2);
  const posA = aiA?.pos ?? Math.round(n / 2);
  const ptsH = aiH?.pts ?? 0;
  const ptsA = aiA?.pts ?? 0;

  const eloH_base = teamElo(posH, ptsH, n, maxPts, fH?.eloBonus ?? 0);
  const eloA_base = teamElo(posA, ptsA, n, maxPts, fA?.eloBonus ?? 0);
  const eloH = eloH_base + HOME_ELO_BONUS;
  const eloA = eloA_base;

  const eloDiff = eloH_base - eloA_base; // hazai pálya nélkül

  // Győzelem valószínűségek
  const rawH = eloWinProb(eloH, eloA);
  const rawA = eloWinProb(eloA, eloH);

  // Döntetlen ráta: Elo-különbség alapján
  // |diff|=0 → 28%, |diff|=300 → 11%
  const dr   = Math.max(0.08, Math.min(0.30, 0.28 - (Math.abs(eloDiff) / 300) * 0.17));
  const pool = 1 - dr;

  // Nyers %-ok
  let h = rawH * pool * 100;
  let a = rawA * pool * 100;
  let d = dr * 100;

  // Kerekítés, min 8%
  h = Math.max(Math.round(h), 8);
  a = Math.max(Math.round(a), 8);
  d = Math.max(Math.round(d), 8);

  // Normalizálás → összeg = 100
  const sum = h + d + a;
  h = Math.round(h / sum * 100);
  d = Math.round(d / sum * 100);
  a = 100 - h - d;
  if (a < 8) { a = 8; h = 100 - d - a; }

  // xG
  const xGH = fH?.avgGF5 ?? (aiH ? (aiH.goalsFor  || 50) / Math.max(n * 1.5, 1) : 1.8);
  const xGA = fA?.avgGF5 ?? (aiA ? (aiA.goalsFor  || 50) / Math.max(n * 1.5, 1) : 1.8);
  const xG  = xGH + xGA;

  const over15 = overXGoalsPct(xG, 1);
  const over25 = overXGoalsPct(xG, 2);

  return {
    homePct:  h,
    drawPct:  d,
    awayPct:  a,
    over15Pct: over15,
    over25Pct: over25,
    // meta az AI szöveghez
    _eloH:    eloH_base,
    _eloA:    eloA_base,
    _eloDiff: Math.round(eloDiff),
    _xG:      Math.round(xG * 100) / 100,
    _posH:    posH,
    _posA:    posA,
    _fH:      fH,
    _fA:      fA,
  };
}

// ─── AI: csak szöveges elemzést kér, számokat NEM ────────────────────────────
async function getAIAnalysis(matches, calcResults, aiStandings) {
  const matchLines = matches.map((m, i) => {
    const c = calcResults[i];
    const fav = c.homePct >= c.awayPct ? m.home : m.away;
    const label = Math.abs(c._eloDiff) > 250 ? 'nagy erőfölény'
      : Math.abs(c._eloDiff) > 100 ? 'közepes különbség' : 'kiegyenlített';
    return [
      `MECCS ${i+1}: ${m.home} (HAZAI, ${c._posH}. hely, Elo=${c._eloH}) vs ${m.away} (VENDÉG, ${c._posA}. hely, Elo=${c._eloA})`,
      `  Favorit: ${fav} | Erőkülönbség: ${label} (${Math.abs(c._eloDiff)} Elo pont)`,
      `  Esélyek: Hazai ${c.homePct}% | Döntetlen ${c.drawPct}% | Vendég ${c.awayPct}%`,
      `  Gól: Over 1.5 = ${c.over15Pct}%, Over 2.5 = ${c.over25Pct}%, xG ≈ ${c._xG}`,
      c._fH ? `  ${m.home} forma: ${c._fH.trend === 'up' ? '↑emelkedő' : c._fH.trend === 'down' ? '↓eső' : '→stabil'}, win%=${c._fH.winRate}%, utolsó5=${c._fH.last5Avg}pt/forduló` : '',
      c._fA ? `  ${m.away} forma: ${c._fA.trend === 'up' ? '↑emelkedő' : c._fA.trend === 'down' ? '↓eső' : '→stabil'}, win%=${c._fA.winRate}%, utolsó5=${c._fA.last5Avg}pt/forduló` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = `Te egy virtuális futball kommentátor vagy. Az alábbi meccsekhez már ki vannak számítva az esélyek matematikailag – te csak rövid, informatív SZÖVEGES elemzést írj minden meccshez magyarul.

${matchLines}

Adj vissza KIZÁRÓLAG valid JSON tömböt:
[
  {
    "over15Comment": "1 mondat – miért valószínű/nem valószínű 1.5 gól felett, hivatkozz az xG értékre",
    "over25Comment": "1 mondat – 2.5 gól felett",
    "analysis": "2-3 mondat – ki az esélyes és miért, tabella pozícióra és ha van formára hivatkozva"
  }
]

FONTOS: Ne adj meg százalékokat a szövegben, azok már ki vannak töltve. Csak a szöveges magyarázatot add.`;

  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) {
      const data = await res.json();
      const txt  = data.choices?.[0]?.message?.content || '';
      const clean = txt.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const jsonMatch = clean.match(/\[[\s\S]*\]/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.warn('[match-tips] AI text hiba:', e.message);
  }

  // Anthropic fallback
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) {
        const data = await res.json();
        const txt  = data.content?.[0]?.text || '';
        const clean = txt.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const jsonMatch = clean.match(/\[[\s\S]*\]/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic text hiba:', e.message);
    }
  }

  return null;
}

// ─── Fallback szöveg ha az AI nem válaszol ────────────────────────────────────
function fallbackText(m, c) {
  const fav   = c.homePct >= c.awayPct ? m.home : m.away;
  const label = Math.abs(c._eloDiff) > 250 ? 'nagy erőfölénnyel'
    : Math.abs(c._eloDiff) > 100 ? 'közepes előnnyel' : 'kis előnnyel';
  return {
    over15Comment: c.over15Pct >= 65
      ? `xG ≈ ${c._xG}, gólgazdag meccs várható mindkét csapattól.`
      : `xG ≈ ${c._xG}, szoros, alacsony gólszámú mérkőzés várható.`,
    over25Comment: c.over25Pct >= 55
      ? '3+ gól valószínű, mindkét csapat támadó játékot játszik.'
      : '3 gólnál több nem várható, inkább taktikai mérkőzés.',
    analysis: `${fav} az esélyes ${label} (${c._posH}. vs ${c._posA}. hely a tabellán, Elo-különbség: ${Math.abs(c._eloDiff)} pont).${c._fH ? ` ${m.home} formája ${c._fH.trend === 'up' ? 'emelkedő' : c._fH.trend === 'down' ? 'eső' : 'stabil'}.` : ''}${c._fA ? ` ${m.away} formája ${c._fA.trend === 'up' ? 'emelkedő' : c._fA.trend === 'down' ? 'eső' : 'stabil'}.` : ''}`,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { matches, aiPrediction, history } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches' }), { status: 400, headers: corsHeaders });
    }

    const aiStandings = aiPrediction?.standings || [];
    const forms = buildForms(history || []);

    // ── 1. MATEMATIKA számítja az összes %-ot ────────────────────────────────
    const calcResults = matches.map(m => calcMatch(m.home, m.away, aiStandings, forms));

    // ── 2. AI csak szöveges elemzést ad ─────────────────────────────────────
    const aiTexts = await getAIAnalysis(matches, calcResults, aiStandings);

    // ── 3. Eredmények összeállítása ──────────────────────────────────────────
    const results = matches.map((m, i) => {
      const c   = calcResults[i];
      const txt = aiTexts?.[i] || fallbackText(m, c);
      return {
        home:    m.home,
        away:    m.away,
        // Százalékok: KIZÁRÓLAG a matematikai számításból
        homePct:  c.homePct,
        drawPct:  c.drawPct,
        awayPct:  c.awayPct,
        over15Pct: c.over15Pct,
        over25Pct: c.over25Pct,
        // Szöveg: AI-tól (vagy fallback)
        over15Comment: txt.over15Comment || fallbackText(m, c).over15Comment,
        over25Comment: txt.over25Comment || fallbackText(m, c).over25Comment,
        analysis:      txt.analysis      || fallbackText(m, c).analysis,
      };
    });

    return new Response(JSON.stringify({ results, source: aiTexts ? 'ai' : 'local', count: results.length }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    console.error('[match-tips]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
