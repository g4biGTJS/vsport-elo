// api/match-tips.js – v4: Gemini 2.5 Flash, nincs hazai előny
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GEMINI_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDgpQrXm0Et2lWoXdIr_se6h8mEMgeZDDI';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_KEY}`;

// ── Gemini hívás ──────────────────────────────────────────────────────────────
async function callGemini(prompt, temp = 0.35) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: temp,
        maxOutputTokens: 3000,
      },
    }),
    signal: AbortSignal.timeout(35000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Gemini hiba: ${res.status} – ${err}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ── Forma számítás history alapján ────────────────────────────────────────────
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
    for (let i = 1; i < Math.min(pts.length, 4); i++) recentGains.push(pts[i] - pts[i - 1]);

    const avgGain = recentGains.reduce((a, b) => a + b, 0) / recentGains.length;
    const lastSnap  = snapshots[snapshots.length - 1].standingsSnapshot.find(t => t.team === teamName);
    const firstSnap = snapshots[0].standingsSnapshot.find(t => t.team === teamName);
    const posTrend  = firstSnap && lastSnap ? firstSnap.pos - lastSnap.pos : 0;

    teamForms[teamName] = {
      avgPtsPerRound: Math.round(avgGain * 10) / 10,
      positionTrend:  posTrend,
      trend: avgGain > 1.8 ? 'erős' : avgGain > 1.2 ? 'közepes' : 'gyenge',
      posLabel: posTrend > 0 ? `+${posTrend} hely` : posTrend < 0 ? `${posTrend} hely` : 'stabil',
    };
  });

  return teamForms;
}

// ── Lokális fallback – szimmetrikus, nincs hazai előny ────────────────────────
function computeLocalTips(matches, standings, aiStandings, formData) {
  return matches.map(m => {
    const live  = standings.find(t => t.team === m.home);
    const liveA = standings.find(t => t.team === m.away);
    const ai    = (aiStandings || []).find(t => t.team === m.home);
    const aiA   = (aiStandings || []).find(t => t.team === m.away);
    const form  = formData ? formData[m.home] : null;
    const formA = formData ? formData[m.away] : null;

    const homeScore =
      (live ? live.pts * 1.5 + ((live.goalsFor||0)-(live.goalsAgainst||0)) * 0.8 + (20 - live.pos) * 2 : 20) +
      (ai   ? (20 - ai.pos) * 1.5 : 0) +
      (form ? form.avgPtsPerRound * 4 + form.positionTrend * 0.5 : 0);

    const awayScore =
      (liveA ? liveA.pts * 1.5 + ((liveA.goalsFor||0)-(liveA.goalsAgainst||0)) * 0.8 + (20 - liveA.pos) * 2 : 20) +
      (aiA   ? (20 - aiA.pos) * 1.5 : 0) +
      (formA ? formA.avgPtsPerRound * 4 + formA.positionTrend * 0.5 : 0);

    const total = Math.max(homeScore + awayScore, 1);
    let homePct = Math.min(Math.max(Math.round((homeScore / total) * 75), 15), 75);
    let awayPct = Math.min(Math.max(Math.round((awayScore / total) * 75), 15), 75);
    const drawPct = Math.max(100 - homePct - awayPct, 5);
    const homePctFinal = 100 - drawPct - awayPct;

    const avgGF = ((live?.goalsFor || 4) + (liveA?.goalsFor || 4)) / 2;
    const over15Pct = Math.min(Math.max(Math.round(55 + avgGF * 1.2), 40), 92);
    const over25Pct = Math.min(Math.max(Math.round(35 + avgGF * 0.9), 22), 82);

    const favorit   = homePctFinal >= awayPct ? m.home : m.away;
    const formTxt   = form  ? ` ${m.home} forma: ${form.trend} (${form.avgPtsPerRound} pt/forduló).`  : '';
    const formTxtA  = formA ? ` ${m.away} forma: ${formA.trend} (${formA.avgPtsPerRound} pt/forduló).` : '';

    return {
      home: m.home, away: m.away,
      homePct: homePctFinal, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 60 ? 'Mindkét csapat sokat lő, magas gólvárakozás' : 'Szoros, taktikai meccs – alacsony gólszám várható',
      over25Comment: over25Pct >= 55 ? 'Gólgazdag összecsapás valószínűsíthető' : 'Inkább zárt, defenzív mérkőzés várható',
      analysis: `${favorit} az esélyes a tabella és forma alapján.${formTxt}${formTxtA}`,
      source: 'local',
    };
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { matches, standings, aiPrediction, history } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches' }), { status: 400, headers: corsHeaders });
    }

    // Kontextus összeállítása
    const liveCtx = (standings || []).length
      ? standings.map(t =>
          `${t.pos}. ${t.team} – ${t.pts}pt | GF:${t.goalsFor} GA:${t.goalsAgainst} GD:${(t.goalsFor||0)-(t.goalsAgainst||0)} | trend:${t.trend||'same'}`
        ).join('\n')
      : 'Nem elérhető';

    const aiStandings = aiPrediction?.standings || [];
    const aiCtx = aiStandings.length
      ? aiStandings.map(t => `${t.pos}. ${t.team} – előrejelzett végső pont: ${t.pts}`).join('\n')
      : 'Nem elérhető';

    const formData = buildFormContext(history || []);
    const formCtx = formData && Object.keys(formData).length
      ? Object.entries(formData).map(([team, f]) =>
          `${team}: ${f.trend} forma | ${f.avgPtsPerRound} pt/forduló | pozíció trend: ${f.posLabel}`
        ).join('\n')
      : 'Nem elérhető';

    const matchList = matches.map((m, i) => `${i+1}. ${m.home} vs ${m.away}`).join('\n');

    const prompt = `Te egy profi virtuális futball elemző vagy. Három adatforrás alapján elemezd meg a meccseket:

━━━ 1. ÉLŐ TABELLA (jelenlegi állás) ━━━
${liveCtx}

━━━ 2. AI SZEZONVÉGI ELŐREJELZÉS ━━━
${aiCtx}

━━━ 3. CSAPATOK FORMÁJA (history alapján) ━━━
${formCtx}

━━━ ELEMZENDŐ MECCSEK ━━━
${matchList}

Minden meccshez adj meg a következő JSON struktúrában:
- homePct: az első csapat győzelem % (egész, 0-100)
- drawPct: döntetlen % (egész, 0-100)
- awayPct: a második csapat győzelem % (egész, 0-100)
- over15Pct: 1.5 gól felett % (egész, 0-100)
- over25Pct: 2.5 gól felett % (egész, 0-100)
- over15Comment: 1 mondat magyarul
- over25Comment: 1 mondat magyarul
- analysis: 2-3 mondat magyarul – KI az esélyes és MIÉRT

SZABÁLYOK:
1. homePct + drawPct + awayPct = PONTOSAN 100
2. Vedd figyelembe MINDHÁROM adatforrást
3. NINCS hazai pálya előny – kizárólag tabella, statisztika és forma számít
4. Reális százalékok – minimum 15% a gyengébb csapatnak is
5. Az analysis-ban MINDIG nevesítsd az esélyes csapatot

CSAK valid JSON tömböt adj vissza, semmi más szöveget vagy markdown-t:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"..."}]`;

    const llmText = await callGemini(prompt);
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
      results = computeLocalTips(matches, standings || [], aiStandings, formData);
      source = 'local';
    }

    return new Response(JSON.stringify({ results, source, count: results.length }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    console.error('[match-tips]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
