// api/match-tips.js – v3: Javított elemzés, hazai/vendég előny nélkül
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Csapat erő-pontszám kiszámítása ────────────────────────────────────────
// Visszaad egy 0–100 közötti értéket a csapat aktuális erejéről
function teamStrength(teamName, standings, aiStandings, formData) {
  const live = standings.find(t => t.team === teamName);
  const ai   = (aiStandings || []).find(t => t.team === teamName);
  const form = formData ? formData[teamName] : null;
  const total = standings.length || 20;

  let score = 0;
  let weight = 0;

  // 1. Élő tabella (40% súly)
  if (live) {
    const maxPts = standings[0]?.pts || 1;
    const ptsPct    = (live.pts / maxPts) * 100;                          // 0–100
    const gdNorm    = Math.min(Math.max(((live.goalsFor||0) - (live.goalsAgainst||0) + 30) / 60 * 100, 0), 100);
    const posPct    = ((total - live.pos) / (total - 1)) * 100;           // 1. hely = 100
    const liveScore = ptsPct * 0.5 + gdNorm * 0.25 + posPct * 0.25;
    score  += liveScore * 0.40;
    weight += 0.40;
  }

  // 2. AI szezonvégi előrejelzés (35% súly)
  if (ai) {
    const aiTotal  = aiStandings.length || total;
    const aiPosPct = ((aiTotal - ai.pos) / (aiTotal - 1)) * 100;
    const aiPtsPct = ai.pts ? Math.min((ai.pts / 100) * 100, 100) : aiPosPct;
    const aiScore  = aiPosPct * 0.6 + aiPtsPct * 0.4;
    score  += aiScore * 0.35;
    weight += 0.35;
  }

  // 3. Forma (25% súly)
  if (form) {
    const maxPpR   = 3.0; // max lehetséges pont/forduló
    const formPct  = Math.min((form.avgPtsPerRound / maxPpR) * 100, 100);
    const trendPct = Math.min(Math.max(50 + form.positionTrend * 5, 0), 100);
    const fScore   = formPct * 0.7 + trendPct * 0.3;
    score  += fScore * 0.25;
    weight += 0.25;
  }

  // Normalizálás ha nincs minden adat
  if (weight === 0) return 50;
  return score / weight; // 0–100
}

// ─── Erőből valószínűség ─────────────────────────────────────────────────────
// ELO-szerű konverzió: erőkülönbség → valószínűség
function strengthToProb(sA, sB) {
  // Logisztikus transzformáció
  const diff = (sA - sB) / 20; // skálázás
  const probA = 1 / (1 + Math.exp(-diff));
  return probA; // 0–1, sA nyerési valószínűsége
}

// ─── Gól-várható kiszámítása ──────────────────────────────────────────────────
function expectedGoals(teamName, standings) {
  const t = standings.find(x => x.team === teamName);
  if (!t || !t.goalsFor) return 1.3; // ligaátlag
  const gamesPlayed = t.wins + t.draws + t.losses || 1;
  return (t.goalsFor / gamesPlayed);
}

// ─── Forma számítás history alapján ─────────────────────────────────────────
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
    for (let i = 1; i < Math.min(pts.length, 5); i++) {
      recentGains.push(pts[i] - pts[i - 1]);
    }

    // Súlyozott átlag – újabb eredmények fontosabbak
    const weighted = recentGains.reduce((acc, v, i) => {
      const w = i + 1;
      return { sum: acc.sum + v * w, wt: acc.wt + w };
    }, { sum: 0, wt: 0 });
    const avgGain = weighted.wt > 0 ? weighted.sum / weighted.wt : 0;

    const lastSnap  = snapshots[snapshots.length - 1].standingsSnapshot.find(t => t.team === teamName);
    const firstSnap = snapshots[0].standingsSnapshot.find(t => t.team === teamName);
    const posTrend  = firstSnap && lastSnap ? firstSnap.pos - lastSnap.pos : 0;

    // Konsisztencia – szórás
    const mean = recentGains.reduce((a, b) => a + b, 0) / recentGains.length;
    const variance = recentGains.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recentGains.length;
    const consistency = Math.max(0, 1 - Math.sqrt(variance) / 3); // 0–1

    teamForms[teamName] = {
      avgPtsPerRound: Math.round(avgGain * 10) / 10,
      positionTrend: posTrend,
      recentGains,
      consistency: Math.round(consistency * 100),
      trend: avgGain > 2.0 ? 'kiváló' : avgGain > 1.5 ? 'erős' : avgGain > 1.0 ? 'közepes' : avgGain > 0.5 ? 'gyenge' : 'rossz',
      posLabel: posTrend > 0 ? `+${posTrend} hely` : posTrend < 0 ? `${posTrend} hely` : 'stabil'
    };
  });

  return teamForms;
}

// ─── Lokális fallback számítás ───────────────────────────────────────────────
function computeLocalTips(matches, standings, aiStandings, formData) {
  return matches.map(m => {
    const sHome = teamStrength(m.home, standings, aiStandings, formData);
    const sAway = teamStrength(m.away, standings, aiStandings, formData);

    // Alap győzelmi valószínűségek (hazai/vendég NEM számít)
    const pHome = strengthToProb(sHome, sAway);
    const pAway = 1 - pHome;

    // Döntetlen valószínűség: erőegyenlőségkor maximális (~28%), nagy különbségnél kisebb
    const balance = 1 - Math.abs(pHome - pAway) * 2;
    const drawBase = 0.10 + balance * 0.18; // 10–28%

    // Normalizálás hogy összeg = 100%
    const rawHome = pHome * (1 - drawBase);
    const rawAway = pAway * (1 - drawBase);
    const total = rawHome + rawAway + drawBase;

    let homePct = Math.round((rawHome / total) * 100);
    let awayPct = Math.round((rawAway / total) * 100);
    let drawPct = 100 - homePct - awayPct;
    if (drawPct < 5) { drawPct = 5; homePct = Math.max(homePct - 3, 5); awayPct = 100 - homePct - drawPct; }

    // Gól-várakozás
    const xgHome = expectedGoals(m.home, standings);
    const xgAway = expectedGoals(m.away, standings);
    const xgTotal = xgHome + xgAway;

    // Poisson-közelítés: P(gólok > 1.5) és P(gólok > 2.5)
    const over15Pct = Math.round(Math.min(Math.max(100 - Math.exp(-xgTotal) * (1 + xgTotal) * 100, 30), 95));
    const over25Pct = Math.round(Math.min(Math.max(100 - Math.exp(-xgTotal) * (1 + xgTotal + xgTotal**2/2) * 100, 15), 88));

    const favorit = homePct >= awayPct ? m.home : m.away;
    const form   = formData?.[m.home];
    const formA  = formData?.[m.away];
    const formTxt  = form  ? ` ${m.home} forma: ${form.trend} (${form.avgPtsPerRound} pt/ford, ${form.posLabel}).` : '';
    const formTxtA = formA ? ` ${m.away} forma: ${formA.trend} (${formA.avgPtsPerRound} pt/ford, ${formA.posLabel}).` : '';
    const aiH = (aiStandings||[]).find(t => t.team === m.home);
    const aiA = (aiStandings||[]).find(t => t.team === m.away);
    const aiTxt = (aiH && aiA) ? ` AI előrejelzés: ${m.home} ${aiH.pos}. vs ${m.away} ${aiA.pos}. helyezés szezon végén.` : '';

    return {
      home: m.home, away: m.away,
      homePct, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 65
        ? `Mindkét csapat gólveszélyes (xG: ${xgHome.toFixed(1)}+${xgAway.toFixed(1)}), magas gólvárakozás`
        : `Alacsony gólátlag alapján szoros, taktikai meccs várható`,
      over25Comment: over25Pct >= 55
        ? 'Gólgazdag összecsapás valószínűsíthető az xG-adatok alapján'
        : 'Inkább zárt, defenzív mérkőzés várható',
      analysis: `${favorit} az esélyes az erősorrendet figyelembe véve (erő: ${Math.round(sHome)} vs ${Math.round(sAway)}).${formTxt}${formTxtA}${aiTxt}`,
      source: 'local'
    };
  });
}

// ─── LLM hívás ───────────────────────────────────────────────────────────────
async function callLLM(prompt) {
  // llm7.io elsődleges
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.25,
        max_tokens: 3500
      }),
      signal: AbortSignal.timeout(28000)
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (text) return text;
    }
  } catch (e) {
    console.warn('[match-tips] llm7.io hiba:', e.message);
  }

  // Anthropic fallback
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
          max_tokens: 3500,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(28000)
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text;
        if (text) return text;
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic hiba:', e.message);
    }
  }

  return null;
}

// ─── Prompt összeállítása ────────────────────────────────────────────────────
function buildPrompt(matches, standings, aiStandings, formData) {
  const total = standings.length || 20;

  // Élő tabella – részletesebb statisztikával
  const liveCtx = standings.length
    ? standings.map(t => {
        const gd = (t.goalsFor||0) - (t.goalsAgainst||0);
        const gp = (t.wins||0) + (t.draws||0) + (t.losses||0) || 1;
        const xg = (t.goalsFor / gp).toFixed(2);
        const xgA = (t.goalsAgainst / gp).toFixed(2);
        return `${t.pos}. ${t.team} | ${t.pts}pt | GK:${t.wins}/${t.draws}/${t.losses} | GF:${t.goalsFor} GA:${t.goalsAgainst} GD:${gd>0?'+':''}${gd} | xG/m:${xg} xGA/m:${xgA}`;
      }).join('\n')
    : 'Nem elérhető';

  // AI előrejelzés
  const aiCtx = (aiStandings||[]).length
    ? aiStandings.map(t => `${t.pos}. ${t.team} – várható végső: ${t.pts}pt`).join('\n')
    : 'Nem elérhető';

  // Forma
  let formCtx = 'Nem elérhető';
  if (formData && Object.keys(formData).length) {
    formCtx = Object.entries(formData)
      .map(([team, f]) =>
        `${team}: ${f.trend} | ${f.avgPtsPerRound}pt/ford | trend: ${f.posLabel} | konzisztencia: ${f.consistency}%`
      ).join('\n');
  }

  // Meccsek – erő-különbséggel előszámolva
  const matchList = matches.map((m, i) => {
    const live  = standings.find(t => t.team === m.home);
    const liveA = standings.find(t => t.team === m.away);
    const gp = live ? (live.wins||0)+(live.draws||0)+(live.losses||0)||1 : 1;
    const gpA = liveA ? (liveA.wins||0)+(liveA.draws||0)+(liveA.losses||0)||1 : 1;
    const xg  = live  ? (live.goalsFor/gp).toFixed(2)  : '?';
    const xgA = liveA ? (liveA.goalsFor/gpA).toFixed(2) : '?';
    const posDiff = live && liveA ? live.pos - liveA.pos : 0;
    const ptsDiff = live && liveA ? live.pts - liveA.pts : 0;
    return `${i+1}. ${m.home} vs ${m.away} | tabella: ${live?.pos||'?'}. vs ${liveA?.pos||'?'}. hely | pontklnb: ${ptsDiff>0?'+':''}${ptsDiff} | xG: ${xg} vs ${xgA}`;
  }).join('\n');

  return `Te egy profi futball statisztikus és elemző vagy. A feladatod KIZÁRÓLAG az objektív csapaterő-összehasonlítás alapján megjósolni a meccsek kimenetelét.

FONTOS SZABÁLY: A mérkőzés helyszíne (hazai/vendég) NEM befolyásolja az elemzést és a valószínűségeket. Csak és kizárólag az alábbi adatok alapján dolgozz.

━━━ ÉLŐVLŐ TABELLA (jelenlegi állás) ━━━
${liveCtx}

━━━ AI SZEZONVÉGI ELŐREJELZÉS ━━━
${aiCtx}

━━━ CSAPATFORMA (utolsó fordulók alapján) ━━━
${formCtx}

━━━ ELEMZENDŐ MECCSEK ━━━
${matchList}

Minden meccshez számítsd ki az alábbi JSON struktúrát:
- homePct: az első csapat győzelmi valószínűsége % (egész)
- drawPct: döntetlen % (egész)
- awayPct: a második csapat győzelmi valószínűsége % (egész)
- over15Pct: legalább 2 gól valószínűsége % (egész)
- over25Pct: legalább 3 gól valószínűsége % (egész)
- over15Comment: 1 mondat magyarul (indoklás az xG adatok és forma alapján)
- over25Comment: 1 mondat magyarul
- analysis: 2-3 mondatos elemzés magyarul – melyik csapat az esélyes és MIÉRT (pontszám, GD, xG, forma, AI-előrejelzés alapján konkrétan)

KÖTELEZŐ SZABÁLYOK:
1. homePct + drawPct + awayPct = PONTOSAN 100
2. A helyszín (hazai/vendég) NEM számít – csak a statisztikák
3. Mindhárom adatforrást vedd figyelembe (tabella + AI + forma)
4. Ha az adatok ellentmondanak egymásnak, ezt jelezd az analysis-ban
5. Reális elosztás: ha az egyik csapat sokkal erősebb, a különbség TÜKRÖZŐDJÖN (pl. 65-20-15)
6. Döntetlen: gyengén differenciált csapatoknál magasabb (~25-28%), nagy különbségnél kisebb (~10-15%)
7. Az analysis-ban MINDIG szerepeljen: ki az esélyes, mi a konkrét statisztikai indok, és mi a kockázat

CSAK valid JSON tömböt adj vissza, semmi más szöveget, magyarázatot:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"..."}]`;
}

// ─── Validáció és javítás ─────────────────────────────────────────────────────
function validateAndFix(results, matches) {
  return results.map((r, i) => {
    const m = matches[i] || {};
    const home = r.home || m.home || '?';
    const away = r.away || m.away || '?';

    let hp = Math.round(Number(r.homePct) || 33);
    let dp = Math.round(Number(r.drawPct) || 33);
    let ap = Math.round(Number(r.awayPct) || 34);

    // Javítás ha nem 100
    const sum = hp + dp + ap;
    if (sum !== 100) {
      const diff = 100 - sum;
      hp += diff; // a maradékot a hazai-hoz adjuk
      if (hp < 5)  { hp = 5;  }
      if (dp < 5)  { dp = 5;  }
      if (ap < 5)  { ap = 5;  }
      // újra normalizál
      const s2 = hp + dp + ap;
      hp = Math.round(hp / s2 * 100);
      dp = Math.round(dp / s2 * 100);
      ap = 100 - hp - dp;
    }

    return {
      ...r,
      home, away,
      homePct: hp, drawPct: dp, awayPct: ap,
      over15Pct: Math.min(Math.max(Math.round(Number(r.over15Pct)||60), 20), 98),
      over25Pct: Math.min(Math.max(Math.round(Number(r.over25Pct)||40), 10), 92),
      over15Comment: r.over15Comment || 'Gólvárhatóság közepes.',
      over25Comment: r.over25Comment || 'Szoros mérkőzés várható.',
      analysis: r.analysis || 'Kiegyenlített mérkőzés várható.'
    };
  });
}

// ─── Fő handler ──────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { matches, standings, aiPrediction, history } = body;

    if (!matches?.length) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches' }), { status: 400, headers: corsHeaders });
    }

    const safeStandings  = standings || [];
    const aiStandings    = aiPrediction?.standings || [];
    const formData       = buildFormContext(history || []);

    // Prompt összeállítása
    const prompt = buildPrompt(matches, safeStandings, aiStandings, formData);

    // LLM hívás
    const llmText = await callLLM(prompt);
    let results = null;
    let source  = 'local';

    if (llmText) {
      try {
        const clean     = llmText.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, s =>
          s.replace(/```json|```/g, '')
        ).trim();
        const jsonMatch = clean.match(/\[[\s\S]*\]/);
        const parsed    = JSON.parse(jsonMatch ? jsonMatch[0] : clean);

        if (Array.isArray(parsed) && parsed.length > 0) {
          results = validateAndFix(parsed, matches);
          source  = 'ai';
        }
      } catch (e) {
        console.warn('[match-tips] JSON parse hiba, lokális fallback:', e.message);
      }
    }

    if (!results) {
      results = computeLocalTips(matches, safeStandings, aiStandings, formData);
      source  = 'local';
    }

    return new Response(
      JSON.stringify({ results, source, count: results.length }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    console.error('[match-tips] Kritikus hiba:', err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
