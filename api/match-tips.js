// api/match-tips.js – v5: Elo + Poisson + okos AI prompt
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Elo modell ───────────────────────────────────────────────────────────────
// Skála: 1000–1900. Hazai pálya bónusz = +50 Elo (~5-7% előny azonos erőknél)
const HOME_ELO_BONUS = 50;

function teamElo(pos, pts, totalTeams, maxPts, formBonus = 0) {
  const posScore = ((totalTeams - pos) / Math.max(totalTeams - 1, 1)) * 600;
  const ptsScore = maxPts > 0 ? (pts / maxPts) * 300 : 0;
  return Math.round(1000 + posScore + ptsScore + formBonus);
}

function eloToWinProb(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

// Dixon-Coles közelítés: döntetlen ráta az Elo-különbség alapján
function drawRate(eloDiff) {
  // eloDiff=0 → ~28%, eloDiff=300 → ~11%
  return Math.max(0.08, Math.min(0.30, 0.28 - (Math.abs(eloDiff) / 300) * 0.17));
}

// ─── Poisson gól valószínűség ─────────────────────────────────────────────────
function poissonPMF(lambda, k) {
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function overXGoals(lambda, x) {
  // P(goals > x) = 1 - sum(P(k) for k=0..floor(x))
  let cumulative = 0;
  for (let k = 0; k <= Math.floor(x); k++) cumulative += poissonPMF(lambda, k);
  return Math.max(0, Math.min(1, 1 - cumulative));
}

// ─── Forma adatok feldolgozása history-ból ────────────────────────────────────
function buildTeamForms(historyEntries) {
  if (!historyEntries?.length) return {};

  const snapshots = historyEntries
    .filter(e => e.standingsSnapshot?.length)
    .slice(0, 20)
    .reverse(); // legrégebbi elöl

  if (snapshots.length < 2) return {};

  const forms = {};
  const allTeams = new Set(snapshots.flatMap(s => s.standingsSnapshot.map(t => t.team)));

  for (const teamName of allTeams) {
    const timeline = snapshots.map(snap => {
      const t = snap.standingsSnapshot.find(x => x.team === teamName);
      return t ? {
        pts: t.pts || 0, pos: t.pos,
        gf: t.goalsFor || 0, ga: t.goalsAgainst || 0,
      } : null;
    }).filter(Boolean);

    if (timeline.length < 2) continue;

    const gains = [];
    for (let i = 1; i < timeline.length; i++) {
      gains.push(timeline[i].pts - timeline[i - 1].pts);
    }

    const avgGain  = gains.reduce((a, b) => a + b, 0) / gains.length;
    const last5    = gains.slice(-5);
    const last5Avg = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : avgGain;

    // Utolsó 5 snapshot átlagai
    const last5snaps = timeline.slice(-5);
    const avgGF5  = last5snaps.reduce((s, t) => s + t.gf, 0) / last5snaps.length;
    const avgGA5  = last5snaps.reduce((s, t) => s + t.ga, 0) / last5snaps.length;

    // Trend: korai vs késői pozíció átlag
    const half    = Math.floor(timeline.length / 2);
    const earlyAvgPos = timeline.slice(0, half).reduce((s, t) => s + t.pos, 0) / half;
    const lateAvgPos  = timeline.slice(-half).reduce((s, t)  => s + t.pos, 0) / half;
    const trend   = lateAvgPos < earlyAvgPos - 1 ? 'up' : lateAvgPos > earlyAvgPos + 1 ? 'down' : 'same';

    // Győzelem / döntetlen / vereség arány
    const wins   = gains.filter(g => g >= 3).length;
    const draws  = gains.filter(g => g === 1).length;
    const losses = gains.filter(g => g === 0).length;
    const total  = wins + draws + losses;

    forms[teamName] = {
      avgPtsPerRound: Math.round(avgGain  * 100) / 100,
      last5Avg:       Math.round(last5Avg * 100) / 100,
      avgGF5:         Math.round(avgGF5   * 10)  / 10,
      avgGA5:         Math.round(avgGA5   * 10)  / 10,
      trend,
      winRate:   total ? Math.round(wins   / total * 100) : 0,
      drawRate:  total ? Math.round(draws  / total * 100) : 0,
      lossRate:  total ? Math.round(losses / total * 100) : 0,
      snapCount: timeline.length,
      // Forma bónusz Elo-ban: átlagtól való eltérés
      eloBonus: Math.round((last5Avg - 1.5) * 18),
    };
  }
  return forms;
}

// ─── Precíz lokális számítás ──────────────────────────────────────────────────
function computeLocalTips(matches, aiStandings, forms) {
  const n      = aiStandings.length || 20;
  const maxPts = Math.max(...aiStandings.map(t => t.pts || 0), 1);

  return matches.map(m => {
    const aiH = aiStandings.find(t => t.team === m.home);
    const aiA = aiStandings.find(t => t.team === m.away);
    const fH  = forms[m.home];
    const fA  = forms[m.away];

    const posH = aiH?.pos ?? Math.round(n / 2);
    const posA = aiA?.pos ?? Math.round(n / 2);
    const ptsH = aiH?.pts ?? 0;
    const ptsA = aiA?.pts ?? 0;

    const eloH = teamElo(posH, ptsH, n, maxPts, fH?.eloBonus ?? 0) + HOME_ELO_BONUS;
    const eloA = teamElo(posA, ptsA, n, maxPts, fA?.eloBonus ?? 0);
    const eloDiff = eloH - HOME_ELO_BONUS - eloA;

    const rawH = eloToWinProb(eloH, eloA);
    const rawA = eloToWinProb(eloA, eloH);
    const dr   = drawRate(eloDiff);
    const pool = 1 - dr;

    let homePct = Math.round(rawH * pool * 100);
    let awayPct = Math.round(rawA * pool * 100);
    let drawPct = 100 - homePct - awayPct;

    // Minimumok
    homePct = Math.max(homePct, 8);
    awayPct = Math.max(awayPct, 8);
    drawPct = Math.max(drawPct, 8);
    // Normalizálás
    const s = homePct + drawPct + awayPct;
    homePct = Math.round(homePct / s * 100);
    drawPct = Math.round(drawPct / s * 100);
    awayPct = 100 - homePct - drawPct;

    // xG: history gólátlag > tabella gólátlag > default
    const xGH = fH?.avgGF5 ?? (aiH ? (aiH.goalsFor || 50) / Math.max(n * 1.5, 1) : 1.8);
    const xGA = fA?.avgGF5 ?? (aiA ? (aiA.goalsFor || 50) / Math.max(n * 1.5, 1) : 1.8);
    const xGTotal = xGH + xGA;

    const over15Pct = Math.round(overXGoals(xGTotal, 1) * 100);
    const over25Pct = Math.round(overXGoals(xGTotal, 2) * 100);

    const label = Math.abs(eloDiff) > 250 ? 'nagy erőfölény' : Math.abs(eloDiff) > 100 ? 'közepes különbség' : 'kiegyenlített';
    const fav   = homePct >= awayPct ? m.home : m.away;

    return {
      home: m.home, away: m.away,
      homePct, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 68
        ? `xG ≈ ${xGTotal.toFixed(1)}, magas gólszám várható`
        : `xG ≈ ${xGTotal.toFixed(1)}, szoros, alacsony gólszámú mérkőzés`,
      over25Comment: over25Pct >= 55
        ? '3+ gól valószínű, mindkét csapat támadó játékot játszik'
        : '3 gólnál több nem várható, inkább defenzív meccs',
      analysis: `${fav} az esélyes (${label}). Tabella: ${posH}. vs ${posA}. hely, Elo-különbség: ${Math.abs(Math.round(eloDiff))} pont.${fH ? ` ${m.home} forma: ${fH.trend === 'up' ? 'emelkedő' : fH.trend === 'down' ? 'eső' : 'stabil'} (${fH.winRate}% win rate).` : ''}${fA ? ` ${m.away} forma: ${fA.trend === 'up' ? 'emelkedő' : fA.trend === 'down' ? 'eső' : 'stabil'} (${fA.winRate}% win rate).` : ''}`,
      _eloH: Math.round(eloH - HOME_ELO_BONUS),
      _eloA: Math.round(eloA),
      _xGTotal: xGTotal,
      source: 'local',
    };
  });
}

// ─── Eredmény validálás ──────────────────────────────────────────────────────
function validateResults(results, matches) {
  return results.map((r, i) => {
    let h = Math.max(8, Math.round(Number(r.homePct) || 0));
    let d = Math.max(8, Math.round(Number(r.drawPct) || 0));
    let a = Math.max(8, Math.round(Number(r.awayPct) || 0));
    const sum = h + d + a;
    if (sum !== 100 && sum > 0) {
      h = Math.round(h / sum * 100);
      d = Math.round(d / sum * 100);
      a = 100 - h - d;
    }
    return {
      ...r,
      home:    r.home || matches[i]?.home || '?',
      away:    r.away || matches[i]?.away || '?',
      homePct: h, drawPct: d, awayPct: a,
    };
  });
}

// ─── LLM hívás ────────────────────────────────────────────────────────────────
async function callLLM(systemPrompt, userPrompt) {
  // 1. llm7.io
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      const txt  = data.choices?.[0]?.message?.content;
      if (txt) return txt;
    }
  } catch (e) {
    console.warn('[match-tips] llm7.io:', e.message);
  }

  // 2. Anthropic fallback
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
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        return data.content?.[0]?.text || null;
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic:', e.message);
    }
  }
  return null;
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
    const n      = aiStandings.length || 20;
    const maxPts = Math.max(...aiStandings.map(t => t.pts || 0), 1);

    // Forma adatok
    const forms = buildTeamForms(history || []);

    // Lokális Elo-Poisson számítás (referencia az AI-nak is)
    const localTips = computeLocalTips(matches, aiStandings, forms);

    // ── AI kontextus összeállítása ────────────────────────────────────────
    const tableCtx = aiStandings.length
      ? aiStandings.map(t => {
          const elo  = teamElo(t.pos, t.pts || 0, n, maxPts);
          const gd   = (t.goalsFor || 0) - (t.goalsAgainst || 0);
          const form = forms[t.team];
          const fStr = form
            ? ` | forma: ${form.trend === 'up' ? '↑emelkedő' : form.trend === 'down' ? '↓eső' : '→stabil'} | W/D/L: ${form.winRate}%/${form.drawRate}%/${form.lossRate}% | utolsó5: ${form.last5Avg}pt/forduló | xG: ${form.avgGF5}:${form.avgGA5}`
            : '';
          return `${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${String(t.pts||0).padStart(3)}pt  GF:${String(t.goalsFor||0).padStart(3)}  GA:${String(t.goalsAgainst||0).padStart(3)}  GD:${String(gd).padStart(4)}  Elo:${elo}${fStr}`;
        }).join('\n')
      : 'Tabella nem elérhető';

    // Meccs lista Elo + Poisson referenciával
    const matchCtx = matches.map((m, i) => {
      const loc = localTips[i];
      const aiH = aiStandings.find(t => t.team === m.home);
      const aiA = aiStandings.find(t => t.team === m.away);
      const fH  = forms[m.home];
      const fA  = forms[m.away];
      return [
        `\n━ MECCS ${i+1}: ${m.home} (HAZAI) vs ${m.away} (VENDÉG)`,
        `  ${m.home}: ${aiH ? aiH.pos + '. hely, ' + aiH.pts + 'pt' : '?'}, Elo≈${loc._eloH}${fH ? `, forma: ${fH.trend === 'up' ? '↑' : fH.trend === 'down' ? '↓' : '→'}, win%: ${fH.winRate}%` : ''}`,
        `  ${m.away}: ${aiA ? aiA.pos + '. hely, ' + aiA.pts + 'pt' : '?'}, Elo≈${loc._eloA}${fA ? `, forma: ${fA.trend === 'up' ? '↑' : fA.trend === 'down' ? '↓' : '→'}, win%: ${fA.winRate}%` : ''}`,
        `  Elo-különbség: ${Math.abs(loc._eloH - loc._eloA)} pont (${loc._eloH > loc._eloA ? m.home + ' az erősebb' : m.away + ' az erősebb'})`,
        `  xG összesen: ≈${loc._xGTotal?.toFixed(2) || '?'}`,
        `  Matematikai referencia (Elo+Poisson): Hazai ${loc.homePct}% | Döntetlen ${loc.drawPct}% | Vendég ${loc.awayPct}%`,
        `  Over 1.5 referencia: ${loc.over15Pct}% | Over 2.5 referencia: ${loc.over25Pct}%`,
      ].join('\n');
    }).join('\n');

    const systemPrompt = `Te egy profi virtuális futball statisztikus és Elo-rendszer szakértő vagy.

TUDÁSOD:
- Elo-rendszer: a magasabb Elo csapat egyértelműen erősebb, a különbség logaritmikusan skálázódik
- Hazai pálya előny valós értéke: 5-7% (kb. 50 Elo pont) – SOHA nem fordítja meg a nagy erőkülönbséget
- Döntetlen valószínűsége: nagy Elo-különbségnél (>250) max 13%, kis különbségnél (<50) max 30%
- xG (Expected Goals) alapján Poisson-eloszlással számolsz gól valószínűséget
- A tabella pozíció + pontszám + forma EGYÜTT adja a valódi erőt

KÖTELEZŐ LOGIKA:
- Ha az Elo-különbség > 200: az erősebb csapat >65% valószínűséggel nyer
- Ha az Elo-különbség > 300: az erősebb csapat >72% valószínűséggel nyer
- A matematikai referenciától csak forma adat alapján térhetsz el, maximum ±7%
- Minden kimenetelre minimum 8%
- homePct + drawPct + awayPct = PONTOSAN 100`;

    const userPrompt = `TABELLA ÉS FORMA ADATOK:
${tableCtx}

MECCSEK ELO + POISSON REFERENCIÁVAL:
${matchCtx}

FELADAT: Elemezd az összes meccset. A matematikai referencia helyes – az AI elemzésed ettől maximum ±7%-ban térhet el, kizárólag ha a forma adatok (W/D/L arány, utolsó 5 forduló, trend) egyértelműen indokolják.

Adj vissza KIZÁRÓLAG valid JSON tömböt, semmi más szöveg:
[
  {
    "home": "csapatnév",
    "away": "csapatnév",
    "homePct": X,
    "drawPct": X,
    "awayPct": X,
    "over15Pct": X,
    "over25Pct": X,
    "over15Comment": "Magyar szöveg – hivatkozz az xG értékre",
    "over25Comment": "Magyar szöveg",
    "analysis": "2-3 mondat magyarul: kik az esélyek, miért, tabella pozícióra és formára hivatkozva"
  }
]`;

    const llmText = await callLLM(systemPrompt, userPrompt);
    let results = null, source = 'local';

    if (llmText) {
      try {
        const clean  = llmText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const match  = clean.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(match ? match[0] : clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
          results = validateResults(parsed, matches);
          source  = 'ai';
        }
      } catch (e) {
        console.warn('[match-tips] parse hiba:', e.message);
      }
    }

    if (!results) {
      results = localTips.map(({ _eloH, _eloA, _xGTotal, ...r }) => r);
      source  = 'local';
    }

    return new Response(JSON.stringify({ results, source, count: results.length }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    console.error('[match-tips]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
