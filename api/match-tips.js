// api/match-tips.js – v4: okosabb AI prompt + javított fallback logika
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

// ─── Lokális fallback – JAVÍTOTT logika ───────────────────────────────────
// Kulcs elvek:
// 1. A tabella pozíció különbség legyen a FŐ tényező
// 2. Hazai pálya előny legyen KICSI (5-8%), nem domináljon
// 3. Chelsea 1. vs Nottingham utolsó → ~70-75% Chelsea eséllyel függetlenül hazai pályától
function computeLocalTips(matches, aiStandings, formData) {
  const totalTeams = (aiStandings || []).length || 20;

  return matches.map(m => {
    const ai    = (aiStandings || []).find(t => t.team === m.home);
    const aiA   = (aiStandings || []).find(t => t.team === m.away);
    const form  = formData ? formData[m.home] : null;
    const formA = formData ? formData[m.away] : null;

    // Pozíció (alacsonyabb = jobb, ezért megfordítjuk)
    const homePos = ai  ? ai.pos  : Math.round(totalTeams / 2);
    const awayPos = aiA ? aiA.pos : Math.round(totalTeams / 2);
    const homePts = ai  ? (ai.pts  || 0) : 0;
    const awayPts = aiA ? (aiA.pts || 0) : 0;

    // Alap erő: pozíció fordítva (1. hely = totalTeams pont, utolsó = 1 pont)
    const homePosScore = (totalTeams + 1) - homePos;
    const awayPosScore = (totalTeams + 1) - awayPos;

    // Pont alapú erő
    const maxPts = Math.max(homePts, awayPts, 1);
    const homePtsScore = (homePts / maxPts) * 20;
    const awayPtsScore = (awayPts / maxPts) * 20;

    // Forma bónusz (history alapján, kis súly)
    const homeFormBonus = form  ? form.avgPtsPerRound * 2 + form.positionTrend * 0.5 : 0;
    const awayFormBonus = formA ? formA.avgPtsPerRound * 2 + formA.positionTrend * 0.5 : 0;

    // Hazai pálya előny: KICSI fix bónusz (3-5 pont a 0-100 skálán)
    const homePenaltyBonus = 4;

    // Összesített erő
    const homeStrength = homePosScore + homePtsScore + homeFormBonus + homePenaltyBonus;
    const awayStrength = awayPosScore + awayPtsScore + awayFormBonus;

    const totalStrength = Math.max(homeStrength + awayStrength, 1);

    // Nyers arányok
    let homeRaw = (homeStrength / totalStrength) * 100;
    let awayRaw = (awayStrength / totalStrength) * 100;

    // Döntetlen: erőkülönbség alapján változik
    // Nagy különbség → kis döntetlen esély, kis különbség → nagy döntetlen esély
    const strengthDiff = Math.abs(homeRaw - awayRaw);
    // Ha diff < 5: ~28% döntetlen, ha diff > 40: ~10% döntetlen
    const drawPct = Math.round(Math.max(10, 28 - strengthDiff * 0.45));

    // Elosztjuk a maradékot az arányok szerint
    const remaining = 100 - drawPct;
    let homePct = Math.round((homeRaw / (homeRaw + awayRaw)) * remaining);
    let awayPct = remaining - homePct;

    // Határok: min 8%, max 85%
    homePct = Math.min(Math.max(homePct, 8), 85);
    awayPct = Math.min(Math.max(awayPct, 8), 85);
    // Normalizálás hogy összeg = 100
    const total = homePct + drawPct + awayPct;
    if (total !== 100) {
      homePct += (100 - total);
    }

    // Gól valószínűség
    const homeGF = ai?.goalsFor || (form?.avgGoalsFor ? form.avgGoalsFor * 10 : 50);
    const awayGF = aiA?.goalsFor || (formA?.avgGoalsFor ? formA.avgGoalsFor * 10 : 50);
    const avgExpectedGoals = ((homeGF + awayGF) / 2) / Math.max(totalTeams * 1.5, 1);
    const over15Pct = Math.min(Math.max(Math.round(50 + avgExpectedGoals * 40), 38), 92);
    const over25Pct = Math.min(Math.max(Math.round(30 + avgExpectedGoals * 35), 20), 82);

    const favorit = homePct >= awayPct ? m.home : m.away;
    const posDiff = Math.abs(homePos - awayPos);
    const strengthLabel = posDiff >= totalTeams * 0.6 ? 'nagy különbség' : posDiff >= totalTeams * 0.3 ? 'közepes különbség' : 'kiegyenlített erők';
    const formTxt  = form  ? ` ${m.home} forma: ${form.trend}.`  : '';
    const formTxtA = formA ? ` ${m.away} forma: ${formA.trend}.` : '';

    return {
      home: m.home, away: m.away,
      homePct, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 62 ? 'Mindkét csapat sokat lő, magas gólvárakozás' : 'Szoros, taktikai meccs – alacsony gólszám várható',
      over25Comment: over25Pct >= 55 ? 'Gólgazdag összecsapás valószínűsíthető' : 'Inkább zárt, defenzív mérkőzés várható',
      analysis: `${favorit} az esélyes (${strengthLabel} – tabella: ${homePos}. vs ${awayPos}.).${formTxt}${formTxtA}`,
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
        temperature: 0.25,   // ← csökkentve: konzisztensebb, logikusabb válaszok
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
    const { matches, aiPrediction, history } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches' }), { status: 400, headers: corsHeaders });
    }

    // 1. AI szezonvégi előrejelzés
    const aiStandings = aiPrediction?.standings || [];
    const totalTeams = aiStandings.length || 20;

    const aiCtx = aiStandings.length
      ? aiStandings.map(t =>
          `${String(t.pos).padStart(2)}. ${t.team} – várható végső pont: ${t.pts} | trend: ${t.trend || 'same'}`
        ).join('\n')
      : 'Nem elérhető';

    // 2. Forma – CSAK history snapshots alapján
    const formData = buildFormContext(history || []);
    let formCtx = 'Nem elérhető';
    if (formData && Object.keys(formData).length) {
      formCtx = Object.entries(formData)
        .map(([team, f]) =>
          `${team}: ${f.trend} forma | ${f.avgPtsPerRound} pt/forduló | pozíció trend: ${f.posLabel} | átl. gól: ${f.avgGoalsFor}:${f.avgGoalsAgainst}`
        )
        .join('\n');
    }

    // 3. Meccs lista – pozíció különbség is szerepel a promptban
    const matchList = matches.map((m, i) => {
      const homeTeam = aiStandings.find(t => t.team === m.home);
      const awayTeam = aiStandings.find(t => t.team === m.away);
      const homePos = homeTeam ? homeTeam.pos : '?';
      const awayPos = awayTeam ? awayTeam.pos : '?';
      const homePts = homeTeam ? homeTeam.pts : '?';
      const awayPts = awayTeam ? awayTeam.pts : '?';
      return `${i+1}. ${m.home} (HAZAI, ${homePos}. hely, ${homePts}pt) vs ${m.away} (VENDÉG, ${awayPos}. hely, ${awayPts}pt)`;
    }).join('\n');

    // ── JAVÍTOTT Prompt ────────────────────────────────────────────────────
    const prompt = `Te egy profi virtuális futball statisztikus vagy. Elemezd az alábbi meccseket LOGIKUSAN és ARÁNYOSAN.

━━━ 1. AI SZEZONVÉGI ELŐREJELZÉS (${totalTeams} csapat) ━━━
${aiCtx}

━━━ 2. CSAPATOK FORMÁJA (history alapján) ━━━
${formCtx}

━━━ ELEMZENDŐ MECCSEK (pozíciók már megadva!) ━━━
${matchList}

━━━ KÖTELEZŐ LOGIKAI SZABÁLYOK ━━━

LEGFONTOSABB: A tabella pozíció különbség ARÁNYOSAN tükröződjön az esélyekben!

Példák hogy mit VÁROK:
- 1. hely vs 20. (utolsó) hely → kb. 72-78% az éllovas javára, ~10-12% a kieső csapatnak
- 1. hely vs 20. hely, DE felcserélve (utolsó játszik otthon): kb. 65-70% az éllovas javára (mert hazai pálya csak ~5-8% bónuszt jelent, NEM fordítja meg az erőviszonyokat!)
- 5. hely vs 8. hely → kb. 45-52% az 5. helynek, kiegyenlített meccs
- 1. hely vs 10. hely → kb. 58-65% az éllosnak

HAZAI PÁLYA ELŐNY: Valós értéke CSAK 5-8%! Nem fordítja meg az erőviszonyokat ha nagy a különbség.

DÖNTETLEN esély: Közel azonos erő esetén 25-30%, nagy különbségnél 10-15%.

JSON formátum (CSAK ezt add vissza, semmi más szöveg):
[
  {
    "home": "...",
    "away": "...",
    "homePct": X,
    "drawPct": X,
    "awayPct": X,
    "over15Pct": X,
    "over25Pct": X,
    "over15Comment": "1 mondat magyarul",
    "over25Comment": "1 mondat magyarul",
    "analysis": "2-3 mondat magyarul – nevesítsd a favorit csapatot és a tabella pozícióra hivatkozz"
  }
]

ELLENŐRZÉS: homePct + drawPct + awayPct = PONTOSAN 100 minden meccsnél!`;

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
          // Validálás: összeg legyen 100 minden meccsnél
          results = parsed.map((r, i) => {
            const h = Math.round(r.homePct || 0);
            const d = Math.round(r.drawPct || 0);
            const a = Math.round(r.awayPct || 0);
            const sum = h + d + a;
            // Ha nem 100, korrigáljuk a legnagyobb értéken
            let fh = h, fd = d, fa = a;
            if (sum !== 100) {
              const diff = 100 - sum;
              if (fh >= fd && fh >= fa) fh += diff;
              else if (fd >= fh && fd >= fa) fd += diff;
              else fa += diff;
            }
            return {
              ...r,
              home: r.home || matches[i]?.home || '?',
              away: r.away || matches[i]?.away || '?',
              homePct: fh, drawPct: fd, awayPct: fa,
            };
          });
          source = 'ai';
        }
      } catch (e) {
        console.warn('[match-tips] JSON parse hiba, lokális fallback:', e.message);
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
