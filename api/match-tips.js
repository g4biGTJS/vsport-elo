// api/match-tips.js – v3: CSAK history + AI tabella alapú elemzés
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Forma számítás history alapján ────────────────────────────────────────
function buildFormContext(historyEntries) {
  if (!historyEntries || !historyEntries.length) return null;

  const snapshots = historyEntries
    .filter(e => e.standingsSnapshot && e.standingsSnapshot.length)
    .slice(0, 8)
    .reverse();

  if (snapshots.length < 2) return null;

  const teamForms = {};
  const allTeams = new Set(snapshots.flatMap(s => s.standingsSnapshot.map(t => t.team)));

  allTeams.forEach(teamName => {
    const pts = snapshots.map(snap => {
      const t = snap.standingsSnapshot.find(x => x.team === teamName);
      return t ? t.pts : null;
    }).filter(v => v !== null);

    if (pts.length < 2) return;

    const recentGains = [];
    for (let i = 1; i < Math.min(pts.length, 4); i++) {
      recentGains.push(pts[i] - pts[i - 1]);
    }

    const avgGain = recentGains.reduce((a, b) => a + b, 0) / recentGains.length;
    const lastSnap = snapshots[snapshots.length - 1].standingsSnapshot.find(t => t.team === teamName);
    const firstSnap = snapshots[0].standingsSnapshot.find(t => t.team === teamName);
    const posTrend = firstSnap && lastSnap ? firstSnap.pos - lastSnap.pos : 0;

    // Per-snapshot adatok (gólok, pozíció, pont) az összes rögzített fordulóból
    const snapDetail = snapshots.map(snap => {
      const t = snap.standingsSnapshot.find(x => x.team === teamName);
      return t ? { pos: t.pos, pts: t.pts, goalsFor: t.goalsFor || 0, goalsAgainst: t.goalsAgainst || 0 } : null;
    }).filter(Boolean);

    const avgGoalsFor     = snapDetail.reduce((s, t) => s + t.goalsFor, 0)     / snapDetail.length;
    const avgGoalsAgainst = snapDetail.reduce((s, t) => s + t.goalsAgainst, 0) / snapDetail.length;

    teamForms[teamName] = {
      avgPtsPerRound: Math.round(avgGain * 10) / 10,
      positionTrend: posTrend,
      recentGains,
      avgGoalsFor:     Math.round(avgGoalsFor * 10) / 10,
      avgGoalsAgainst: Math.round(avgGoalsAgainst * 10) / 10,
      trend: avgGain > 1.8 ? 'erős' : avgGain > 1.2 ? 'közepes' : 'gyenge',
      posLabel: posTrend > 0 ? `+${posTrend} hely` : posTrend < 0 ? `${posTrend} hely` : 'stabil',
      snapCount: snapDetail.length,
    };
  });

  return teamForms;
}

// ─── Lokális fallback – CSAK history + AI tabella alapján ──────────────────
function computeLocalTips(matches, aiStandings, formData) {
  return matches.map(m => {
    const ai    = (aiStandings || []).find(t => t.team === m.home);
    const aiA   = (aiStandings || []).find(t => t.team === m.away);
    const form  = formData ? formData[m.home] : null;
    const formA = formData ? formData[m.away] : null;

    const aiPos  = ai  ? ai.pos  : 10;
    const aiPosA = aiA ? aiA.pos : 10;
    const aiPts  = ai  ? ai.pts  : 0;
    const aiPtsA = aiA ? aiA.pts : 0;

    const homeScore =
      (20 - aiPos) * 3 + aiPts * 0.5 +
      (form ? form.avgPtsPerRound * 5 + form.positionTrend * 0.8 + form.avgGoalsFor * 0.5 : 0) + 30;

    const awayScore =
      (20 - aiPosA) * 3 + aiPtsA * 0.5 +
      (formA ? formA.avgPtsPerRound * 5 + formA.positionTrend * 0.8 + formA.avgGoalsFor * 0.5 : 0);

    const total = Math.max(homeScore + awayScore, 1);
    let homePct = Math.min(Math.max(Math.round((homeScore / total) * 80), 20), 70);
    let awayPct = Math.min(Math.max(Math.round((awayScore / total) * 65), 10), 55);
    const drawPct = Math.max(100 - homePct - awayPct, 5);
    const homePctFinal = 100 - drawPct - awayPct;

    const avgGF = ((form?.avgGoalsFor || 4) + (formA?.avgGoalsFor || 4)) / 2;
    const over15Pct = Math.min(Math.max(Math.round(55 + avgGF * 1.2), 40), 92);
    const over25Pct = Math.min(Math.max(Math.round(35 + avgGF * 0.9), 22), 82);

    const favorit = homePctFinal >= awayPct ? m.home : m.away;
    const formTxt  = form  ? ` ${m.home} forma: ${form.trend} (${form.avgPtsPerRound} pt/forduló, ${form.posLabel}).`  : '';
    const formTxtA = formA ? ` ${m.away} forma: ${formA.trend} (${formA.avgPtsPerRound} pt/forduló, ${formA.posLabel}).` : '';

    return {
      home: m.home, away: m.away,
      homePct: homePctFinal, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 60 ? 'Mindkét csapat sokat lő, magas gólvárakozás' : 'Szoros, taktikai meccs – alacsony gólszám várható',
      over25Comment: over25Pct >= 55 ? 'Gólgazdag összecsapás valószínűsíthető' : 'Inkább zárt, defenzív mérkőzés várható',
      analysis: `${favorit} az esélyes az AI előrejelzés és a history forma alapján.${formTxt}${formTxtA}`,
      source: 'local'
    };
  });
}

// ─── LLM hívás ──────────────────────────────────────────────────────────────
async function callLLM(prompt) {
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.35,
        max_tokens: 3000
      }),
      signal: AbortSignal.timeout(28000)
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
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(28000)
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

// ─── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    // standings-t szándékosan FIGYELMEN KÍVÜL HAGYJUK
    const { matches, aiPrediction, history } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches' }), { status: 400, headers: corsHeaders });
    }

    // 1. AI szezonvégi előrejelzés
    const aiStandings = aiPrediction?.standings || [];
    const aiCtx = aiStandings.length
      ? aiStandings.map(t =>
          `${t.pos}. ${t.team} – várható végső pont: ${t.pts} | trend: ${t.trend || 'same'}`
        ).join('\n')
      : 'Nem elérhető';

    // 2. Forma – CSAK history snapshots alapján
    const formData = buildFormContext(history || []);
    let formCtx = 'Nem elérhető';
    if (formData && Object.keys(formData).length) {
      formCtx = Object.entries(formData)
        .map(([team, f]) =>
          `${team}: ${f.trend} forma | ${f.avgPtsPerRound} pt/forduló | pozíció trend: ${f.posLabel} | átl. gól: ${f.avgGoalsFor}:${f.avgGoalsAgainst} | ${f.snapCount} mérés`
        )
        .join('\n');
    }

    // 3. Meccs lista
    const matchList = matches.map((m, i) =>
      `${i+1}. ${m.home} (HAZAI) vs ${m.away} (VENDÉG)`
    ).join('\n');

    // ── Prompt – CSAK AI tabella + history ────────────────────────────────
    const prompt = `Te egy profi virtuális futball elemző vagy. KIZÁRÓLAG az alábbi két adatforrás alapján elemezd a meccseket – ne használj más információt:

━━━ 1. AI SZEZONVÉGI ELŐREJELZÉS (várható végső sorrend) ━━━
${aiCtx}

━━━ 2. CSAPATOK FORMÁJA – HISTORY SNAPSHOTS ALAPJÁN ━━━
(rögzített fordulók átlagai: pont/forduló, pozíció változás, gólátlag)
${formCtx}

━━━ ELEMZENDŐ MECCSEK ━━━
${matchList}

Minden meccshez adj meg a következő JSON struktúrában:
- homePct: hazai győzelem % (egész, 0-100)
- drawPct: döntetlen % (egész, 0-100)
- awayPct: vendég győzelem % (egész, 0-100)
- over15Pct: 1.5 gól felett % (egész, 0-100)
- over25Pct: 2.5 gól felett % (egész, 0-100)
- over15Comment: 1 mondat magyarul (a history gólátlag alapján indokold)
- over25Comment: 1 mondat magyarul
- analysis: 2-3 mondat magyarul – KI az esélyes és MIÉRT, hivatkozva az AI előrejelzésre ÉS a history formára

SZABÁLYOK:
1. homePct + drawPct + awayPct = PONTOSAN 100
2. CSAK az AI tabella és a history forma számít – más adatot ne használj
3. Ha a forma és az AI előrejelzés ellentmond egymásnak, magyarázd meg melyiket és miért súlyozod jobban
4. Reális, differenciált százalékok (ne 33-33-33 vagy 50-50)
5. Az analysis-ban MINDIG nevesítsd a favorit csapatot

CSAK valid JSON tömböt adj vissza, semmi más szöveget:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"..."}]`;

    // ── LLM hívás ──────────────────────────────────────────────────────────
    const llmText = await callLLM(prompt);
    let results = null;
    let source = 'local';

    if (llmText) {
      try {
        const clean = llmText.replace(/```json|```/g, '').trim();
        const jsonMatch = clean.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
          results = parsed.map((r, i) => ({
            ...r,
            home: r.home || matches[i]?.home || '?',
            away: r.away || matches[i]?.away || '?',
          }));
          source = 'ai';
        }
      } catch (e) {
        console.warn('[match-tips] JSON parse hiba, lokális fallback');
      }
    }

    if (!results) {
      results = computeLocalTips(matches, aiStandings, formData);
      source = 'local';
    }

    return new Response(JSON.stringify({ results, source, count: results.length }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    console.error('[match-tips]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
