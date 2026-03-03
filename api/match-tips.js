// api/match-tips.js – v5: Elo-alapú precíz modell + erős AI prompt
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Forma számítás history alapján ───────────────────────────────────────
function buildFormContext(historyEntries) {
  if (!historyEntries || !historyEntries.length) return null;

  const snapshots = historyEntries
    .filter(e => e.standingsSnapshot && e.standingsSnapshot.length)
    .slice(0, 15)
    .reverse();

  if (snapshots.length < 2) return null;

  const teamForms = {};
  const allTeams = new Set(snapshots.flatMap(s => s.standingsSnapshot.map(t => t.team)));

  allTeams.forEach(teamName => {
    const snapDetail = snapshots.map(snap => {
      const t = snap.standingsSnapshot.find(x => x.team === teamName);
      return t ? { pts: t.pts, pos: t.pos, goalsFor: t.goalsFor || 0, goalsAgainst: t.goalsAgainst || 0 } : null;
    }).filter(Boolean);

    if (snapDetail.length < 2) return;

    const gains = [];
    for (let i = 1; i < snapDetail.length; i++) {
      gains.push(snapDetail[i].pts - snapDetail[i - 1].pts);
    }
    const avgGain  = gains.reduce((a, b) => a + b, 0) / gains.length;
    const last3    = gains.slice(-3);
    const last3Avg = last3.length ? last3.reduce((a, b) => a + b, 0) / last3.length : avgGain;

    const avgGF = snapDetail.reduce((s, t) => s + t.goalsFor, 0)     / snapDetail.length;
    const avgGA = snapDetail.reduce((s, t) => s + t.goalsAgainst, 0) / snapDetail.length;

    teamForms[teamName] = {
      avgPtsPerRound: Math.round(avgGain   * 100) / 100,
      last3AvgPts:    Math.round(last3Avg  * 100) / 100,
      avgGoalsFor:    Math.round(avgGF     * 10)  / 10,
      avgGoalsAgainst:Math.round(avgGA     * 10)  / 10,
      currentPos:     snapDetail[snapDetail.length - 1].pos,
      currentPts:     snapDetail[snapDetail.length - 1].pts,
      snapCount:      snapDetail.length,
      trend: last3Avg > 2.2 ? 'kiváló' : last3Avg > 1.5 ? 'jó' : last3Avg > 0.8 ? 'közepes' : 'gyenge',
    };
  });

  return Object.keys(teamForms).length ? teamForms : null;
}

// ─── Elo-alapú precíz modell ───────────────────────────────────────────────
// Elo skála: 1000–1900 (tabella pozíció + pontszám alapján)
// Hazai pálya bónusz: +50 Elo pont (~5-7% előny közel azonos erőknél)
function eloWinProb(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function teamElo(pos, pts, totalTeams, maxPts, formBonus = 0) {
  const posScore = ((totalTeams - pos) / Math.max(totalTeams - 1, 1)) * 600; // 0–600
  const ptsScore = maxPts > 0 ? (pts / maxPts) * 300 : 0;                    // 0–300
  return 1000 + posScore + ptsScore + formBonus;
}

function computeLocalTips(matches, aiStandings, formData) {
  const n      = (aiStandings || []).length || 20;
  const maxPts = Math.max(...(aiStandings || []).map(t => t.pts || 0), 1);
  const HOME_BONUS = 50;

  return matches.map(m => {
    const aiH = (aiStandings || []).find(t => t.team === m.home);
    const aiA = (aiStandings || []).find(t => t.team === m.away);
    const fH  = formData ? formData[m.home] : null;
    const fA  = formData ? formData[m.away] : null;

    const posH = aiH ? aiH.pos : Math.round(n / 2);
    const posA = aiA ? aiA.pos : Math.round(n / 2);
    const ptsH = aiH ? (aiH.pts || 0) : 0;
    const ptsA = aiA ? (aiA.pts || 0) : 0;

    // Forma bónusz: eltérés az átlagtól (+/- 20 Elo)
    const formBonusH = fH ? (fH.last3AvgPts - 1.5) * 13 : 0;
    const formBonusA = fA ? (fA.last3AvgPts - 1.5) * 13 : 0;

    const eloH = teamElo(posH, ptsH, n, maxPts, formBonusH) + HOME_BONUS;
    const eloA = teamElo(posA, ptsA, n, maxPts, formBonusA);

    const rawH = eloWinProb(eloH, eloA);
    const rawA = eloWinProb(eloA, eloH);

    // Döntetlen ráta: Elo különbség alapján
    const diff     = Math.abs(eloH - HOME_BONUS - eloA);
    const drawRate = Math.max(0.08, Math.min(0.30, 0.27 - (diff / 300) * 0.15));

    const winPool = 1 - drawRate;
    let homePct   = Math.round(rawH * winPool * 100);
    let drawPct   = Math.round(drawRate * 100);
    let awayPct   = 100 - homePct - drawPct;

    // Minimumok
    if (awayPct < 8) { awayPct = 8; homePct = 100 - drawPct - awayPct; }
    if (homePct < 8) { homePct = 8; awayPct = 100 - drawPct - homePct; }
    if (drawPct < 8) { drawPct = 8; awayPct = 100 - homePct - drawPct; }

    // xG becslés
    const xGH = fH ? fH.avgGoalsFor  : (aiH ? (aiH.goalsFor  || 50) / Math.max(n * 1.5, 1) : 2.0);
    const xGA = fA ? fA.avgGoalsFor  : (aiA ? (aiA.goalsFor  || 50) / Math.max(n * 1.5, 1) : 2.0);
    const xG  = xGH + xGA;

    // Poisson P(>1.5) = 1 - P(0) - P(1), P(>2.5) = 1 - P(0) - P(1) - P(2)
    const p0 = Math.exp(-xG);
    const p1 = xG * p0;
    const p2 = (xG ** 2 / 2) * p0;
    const over15Pct = Math.round(Math.min(Math.max((1 - p0 - p1) * 100, 25), 95));
    const over25Pct = Math.round(Math.min(Math.max((1 - p0 - p1 - p2) * 100, 15), 90));

    const eloDiff   = Math.round(eloH - HOME_BONUS - eloA);
    const diffLabel = Math.abs(eloDiff) > 200
      ? 'nagy erőkülönbség'
      : Math.abs(eloDiff) > 80 ? 'közepes különbség' : 'kiegyenlített';
    const favorit   = homePct >= awayPct ? m.home : m.away;

    return {
      home: m.home, away: m.away,
      homePct, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 65
        ? `Várható gólszám ~${xG.toFixed(1)}, gólgazdag meccs`
        : `Várható gólszám ~${xG.toFixed(1)}, szoros küzdelem`,
      over25Comment: over25Pct >= 55
        ? '3+ gól valószínű, mindkét csapat támadó'
        : '3 gólnál több nem várható',
      analysis: `${favorit} az esélyes (${diffLabel}, ${posH}. vs ${posA}. hely). Elo különbség: ${Math.abs(eloDiff)} pont.${fH ? ` ${m.home} forma: ${fH.trend}.` : ''}${fA ? ` ${m.away} forma: ${fA.trend}.` : ''}`,
      _eloH: Math.round(eloH - HOME_BONUS),
      _eloA: Math.round(eloA),
      source: 'local',
    };
  });
}

// ─── Validálás ────────────────────────────────────────────────────────────
function validateAndFix(results, matches) {
  return results.map((r, i) => {
    let h = Math.max(0, Math.round(Number(r.homePct) || 0));
    let d = Math.max(0, Math.round(Number(r.drawPct) || 0));
    let a = Math.max(0, Math.round(Number(r.awayPct) || 0));
    const sum = h + d + a;
    if (sum > 0 && sum !== 100) {
      h = Math.round((h / sum) * 100);
      d = Math.round((d / sum) * 100);
      a = 100 - h - d;
    }
    if (a < 8) { a = 8; h = 100 - d - a; }
    if (h < 8) { h = 8; a = 100 - d - h; }
    if (d < 8) { d = 8; a = 100 - h - d; }
    return {
      ...r,
      home:    r.home    || matches[i]?.home || '?',
      away:    r.away    || matches[i]?.away || '?',
      homePct: h, drawPct: d, awayPct: a,
    };
  });
}

// ─── LLM hívás ────────────────────────────────────────────────────────────
async function callLLM(prompt) {
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Te egy precíz futball statisztikus vagy. Mindig matematikailag konzisztens, logikus válaszokat adsz. A tabella pozíció különbség MINDIG arányosan tükröződik az esélyekben. A hazai pálya előny valós értéke mindössze 5-7%, soha nem fordítja meg az erőviszonyokat.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 3500,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
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
          max_tokens: 3500,
          system: 'Te egy precíz futball statisztikus vagy. Mindig matematikailag konzisztens, logikus válaszokat adsz. A tabella pozíció különbség MINDIG arányosan tükröződik az esélyekben. A hazai pálya előny valós értéke mindössze 5-7%.',
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        return data.content?.[0]?.text || null;
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic hiba:', e.message);
    }
  }
  return null;
}

// ─── Handler ───────────────────────────────────────────────────────────────
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

    const formData     = buildFormContext(history || []);
    const localTips    = computeLocalTips(matches, aiStandings, formData);

    // AI kontextus – részletes tabella
    const aiCtx = aiStandings.length
      ? aiStandings.map(t =>
          `${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${String(t.pts).padStart(3)}pt  ` +
          `GF:${String(t.goalsFor||0).padStart(3)}  GA:${String(t.goalsAgainst||0).padStart(3)}  ` +
          `GD:${String((t.goalsFor||0)-(t.goalsAgainst||0)).padStart(4)}  trend:${t.trend||'same'}`
        ).join('\n')
      : 'Nem elérhető';

    const formCtx = formData && Object.keys(formData).length
      ? Object.entries(formData)
          .map(([team, f]) =>
            `${team}: ${f.trend} | utolsó 3 forduló: ${f.last3AvgPts}pt | összesített: ${f.avgPtsPerRound}pt/forduló | gól lőtt/kapott: ${f.avgGoalsFor}/${f.avgGoalsAgainst}`
          ).join('\n')
      : 'Nincs history';

    // Meccs lista Elo referenciaértékekkel
    const matchList = matches.map((m, i) => {
      const loc  = localTips[i];
      const aiH  = aiStandings.find(t => t.team === m.home);
      const aiA  = aiStandings.find(t => t.team === m.away);
      return [
        `${i + 1}. ${m.home} (HAZAI) vs ${m.away} (VENDÉG)`,
        `   ${m.home}: ${aiH ? aiH.pos + '. hely, ' + aiH.pts + 'pt' : 'ismeretlen'}, Elo≈${loc._eloH}`,
        `   ${m.away}: ${aiA ? aiA.pos + '. hely, ' + aiA.pts + 'pt' : 'ismeretlen'}, Elo≈${loc._eloA}`,
        `   Elo-alapú referencia: Hazai ${loc.homePct}% | Döntetlen ${loc.drawPct}% | Vendég ${loc.awayPct}%`,
      ].join('\n');
    }).join('\n\n');

    const prompt = `Te egy profi virtuális futball statisztikus vagy. Elemezd az alábbi meccseket PONTOSAN.

━━━ SZEZONVÉGI AI TABELLA (${n} csapat) ━━━
${aiCtx}

━━━ CSAPATOK FORMÁJA ━━━
${formCtx}

━━━ MECCSEK – ELO REFERENCIÁVAL ━━━
${matchList}

━━━ KÖTELEZŐ SZABÁLYOK ━━━

1. Az Elo-alapú referencia matematikailag helyes. Az AI eredményed ettől maximum ±8%-ban térhet el,
   és CSAK akkor, ha a forma adatok egyértelműen indokolják.

2. HAZAI PÁLYA = csak 5-7% bónusz. Soha nem fordítja meg a tabella erőviszonyokat.
   Példa: ha az 1. hely az utolsó ellen vendégként játszik → kb. 65-70% az 1. helynek.
   Ha az 1. hely otthon játszik az utolsó ellen → kb. 72-78% az 1. helynek.

3. DÖNTETLEN: nagy Elo-különbségnél (>200) max 15%, kis különbségnél (<50) max 30%.

4. MINDEN kimenetelre MINIMUM 8%.

5. homePct + drawPct + awayPct = PONTOSAN 100.

CSAK valid JSON tömböt adj vissza, semmi más szöveg:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"2-3 mondat magyarul, favorit megnevezésével és a tabella pozíciókra hivatkozva"}]`;

    const llmText = await callLLM(prompt);
    let results = null;
    let source  = 'local';

    if (llmText) {
      try {
        const clean  = llmText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const match  = clean.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(match ? match[0] : clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
          results = validateAndFix(parsed, matches);
          source  = 'ai';
        }
      } catch (e) {
        console.warn('[match-tips] JSON parse hiba:', e.message);
      }
    }

    // Fallback: lokális Elo-modell (belső mezők törlése)
    if (!results) {
      results = localTips.map(({ _eloH, _eloA, ...r }) => r);
      source  = 'local';
    }

    return new Response(JSON.stringify({ results, source, count: results.length }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    console.error('[match-tips]', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
}
