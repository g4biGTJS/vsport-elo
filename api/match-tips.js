// api/match-tips.js – v7: javított AI hívás, helyes Authorization, erős lokális fallback
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ════════════════════════════════════════════════════════════════════════════
// § 1. POISSON / DIXON-COLES
// ════════════════════════════════════════════════════════════════════════════

function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k < 0) return 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function dixonColes(lH, lA, rho = -0.13) {
  const MAX = 10;
  let pH = 0, pD = 0, pA = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      let p = poisson(lH, h) * poisson(lA, a);
      if      (h===0&&a===0) p *= Math.max(1 - lH*lA*rho, 0);
      else if (h===1&&a===0) p *= Math.max(1 + lA*rho, 0);
      else if (h===0&&a===1) p *= Math.max(1 + lH*rho, 0);
      else if (h===1&&a===1) p *= Math.max(1 - rho, 0);
      if (h > a) pH += p; else if (h === a) pD += p; else pA += p;
    }
  }
  const t = Math.max(pH + pD + pA, 1e-10);
  return { home: pH/t, draw: pD/t, away: pA/t };
}

function probOver(lH, lA, threshold) {
  const MAX = 14;
  let pUnder = 0;
  for (let h = 0; h <= MAX; h++)
    for (let a = 0; a <= MAX; a++)
      if (h+a <= threshold) pUnder += poisson(lH, h) * poisson(lA, a);
  return Math.min(Math.max(1 - pUnder, 0), 1);
}

function clamp(v, lo, hi) { return Math.min(Math.max(Math.round(v), lo), hi); }

function norm100(a, b, c) {
  a = Math.max(a, 5); b = Math.max(b, 8); c = Math.max(c, 5);
  const s = a + b + c;
  const ra = Math.round(a/s*100);
  const rb = Math.round(b/s*100);
  const rc = 100 - ra - rb;
  return [Math.max(ra, 5), Math.max(rb, 8), Math.max(rc, 5)];
}

// ════════════════════════════════════════════════════════════════════════════
// § 2. CSAPATERŐ SZÁMÍTÁS
// ════════════════════════════════════════════════════════════════════════════

function computeStrength(teamName, standings, aiStandings, formData) {
  const n    = Math.max(standings.length, 1);
  const live = standings.find(t => t.team === teamName);
  const ai   = (aiStandings || []).find(t => t.team === teamName);
  const form = formData?.[teamName] ?? null;
  const parts = [];

  // A) AI szezonvégi tábla (50%)
  if (ai && aiStandings && aiStandings.length > 0) {
    const aiN   = aiStandings.length;
    const aiPos = (aiN - ai.pos) / Math.max(aiN - 1, 1) * 100;
    const maxPt = Math.max(...aiStandings.map(t => t.pts || 0), 90);
    const aiPts = Math.min((ai.pts || 0) / maxPt * 100, 100);
    const aiGD  = ai.goalsFor && ai.goalsAgainst
      ? Math.min(Math.max(((ai.goalsFor - ai.goalsAgainst) + 40) / 80 * 100, 0), 100) : 50;
    parts.push({ score: aiPos * 0.55 + aiPts * 0.30 + aiGD * 0.15, weight: 0.50 });
  }

  // B) Élő tábla (35%)
  if (live) {
    const gp   = Math.max((live.wins||0)+(live.draws||0)+(live.losses||0), 1);
    const ppgN = live.pts / gp / 3 * 100;
    const gd   = ((live.goalsFor||0)-(live.goalsAgainst||0)) / gp;
    const gdN  = Math.min(Math.max((gd + 3) / 6 * 100, 0), 100);
    const posN = (n - live.pos) / Math.max(n-1, 1) * 100;
    const xgR  = (live.goalsAgainst||0) > 0
      ? Math.min((live.goalsFor||0) / (live.goalsAgainst||1) / 2.5 * 100, 100) : 60;
    parts.push({ score: ppgN*0.40 + gdN*0.25 + posN*0.20 + xgR*0.15, weight: 0.35 });
  }

  // C) Forma (15%)
  if (form) {
    const fN  = Math.min(Math.max(form.avgPtsPerRound / 3 * 100, 0), 100);
    const tN  = Math.min(Math.max((form.positionTrend + 10) / 20 * 100, 0), 100);
    const cN  = form.consistency ?? 50;
    const l3  = form.last3 || '';
    const wCount = (l3.match(/W/g)||[]).length;
    const lCount = (l3.match(/L/g)||[]).length;
    const l3Score = 50 + (wCount - lCount) * 12;
    parts.push({ score: fN*0.40 + tN*0.25 + cN*0.20 + l3Score*0.15, weight: 0.15 });
  }

  if (parts.length === 0) return 50;
  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  return parts.reduce((s, p) => s + p.score * (p.weight / totalW), 0);
}

// ════════════════════════════════════════════════════════════════════════════
// § 3. HISTORY / FORMA FELDOLGOZÁS
// ════════════════════════════════════════════════════════════════════════════

function buildFormContext(historyEntries) {
  if (!historyEntries?.length) return null;
  const snapshots = historyEntries
    .filter(e => e.standingsSnapshot?.length >= 2)
    .slice(0, 8)
    .reverse();
  if (snapshots.length < 2) return null;

  const allTeams = new Set(snapshots.flatMap(s => s.standingsSnapshot.map(t => t.team)));
  const result = {};

  allTeams.forEach(teamName => {
    const ptsArr = snapshots
      .map(snap => snap.standingsSnapshot.find(t => t.team === teamName)?.pts ?? null)
      .filter(v => v !== null);
    if (ptsArr.length < 2) return;

    const gains = [];
    for (let i = 1; i < ptsArr.length; i++) gains.push(ptsArr[i] - ptsArr[i-1]);

    const alpha = 0.40;
    let ewma = gains[0];
    for (let i = 1; i < gains.length; i++) ewma = alpha * gains[i] + (1-alpha) * ewma;

    const firstPos = snapshots[0].standingsSnapshot.find(t => t.team === teamName)?.pos ?? null;
    const lastPos  = snapshots[snapshots.length-1].standingsSnapshot.find(t => t.team === teamName)?.pos ?? null;
    const posTrend = (firstPos !== null && lastPos !== null) ? firstPos - lastPos : 0;

    const mean = gains.reduce((a, b) => a+b, 0) / gains.length;
    const variance = gains.reduce((a, b) => a+(b-mean)**2, 0) / gains.length;
    const consistency = Math.round(Math.max(0, 1 - Math.sqrt(variance)/3) * 100);
    const last3 = gains.slice(-3).map(g => g>=3?'W':g===1?'D':'L').join('');

    result[teamName] = {
      avgPtsPerRound: Math.round(ewma * 100) / 100,
      positionTrend: posTrend,
      consistency,
      last3,
      trend: ewma>=2.5?'kiváló':ewma>=1.8?'erős':ewma>=1.2?'közepes':ewma>=0.5?'gyenge':'rossz',
      posLabel: posTrend>0?`+${posTrend} hely`:posTrend<0?`${posTrend} hely`:'stabil',
    };
  });
  return Object.keys(result).length > 0 ? result : null;
}

function extractH2HContext(teamA, teamB, historyEntries) {
  if (!historyEntries?.length) return null;
  const snapshots = historyEntries
    .filter(e => e.standingsSnapshot?.length >= 2)
    .slice(0, 8)
    .reverse();
  if (snapshots.length < 2) return null;

  let aWasAhead = 0, bWasAhead = 0, tied = 0;
  let aTrendGains = 0, bTrendGains = 0, rounds = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i-1].standingsSnapshot;
    const curr = snapshots[i].standingsSnapshot;
    const aP = prev.find(t=>t.team===teamA); const aC = curr.find(t=>t.team===teamA);
    const bP = prev.find(t=>t.team===teamB); const bC = curr.find(t=>t.team===teamB);
    if (!aP||!aC||!bP||!bC) continue;
    const aGain = (aC.pts||0) - (aP.pts||0);
    const bGain = (bC.pts||0) - (bP.pts||0);
    aTrendGains += aGain; bTrendGains += bGain; rounds++;
    if (aC.pos < bC.pos) aWasAhead++;
    else if (bC.pos < aC.pos) bWasAhead++;
    else tied++;
  }

  if (rounds === 0) return null;
  return {
    aAvgGain: Math.round(aTrendGains/rounds*100)/100,
    bAvgGain: Math.round(bTrendGains/rounds*100)/100,
    aAheadCount: aWasAhead,
    bAheadCount: bWasAhead,
    tiedCount: tied,
    rounds,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// § 4. XG BECSLÉS
// ════════════════════════════════════════════════════════════════════════════

function ligaAvgXG(standings) {
  const tGP = standings.reduce((s, t) => s + Math.max((t.wins||0)+(t.draws||0)+(t.losses||0), 0), 0);
  const tGF = standings.reduce((s, t) => s + (t.goalsFor||0), 0);
  return tGP > 0 ? tGF/tGP : 1.30;
}

function teamXG(teamName, standings, avg) {
  const t = standings.find(x => x.team === teamName);
  if (!t || !t.goalsFor) return avg;
  const gp = Math.max((t.wins||0)+(t.draws||0)+(t.losses||0), 1);
  const raw = t.goalsFor / gp;
  const w = Math.min(gp/20, 1);
  return raw*w + avg*(1-w);
}

// ════════════════════════════════════════════════════════════════════════════
// § 5. LOKÁLIS FALLBACK SZÁMÍTÁS
// ════════════════════════════════════════════════════════════════════════════

function computeLocalTips(matches, standings, aiStandings, formData, historyEntries) {
  const avg = standings.length ? ligaAvgXG(standings) : 1.30;

  return matches.map(m => {
    const sA = computeStrength(m.home, standings, aiStandings, formData);
    const sB = computeStrength(m.away, standings, aiStandings, formData);

    const k = 0.028;
    const lA = Math.max(avg * Math.exp(k*(sA-sB)), 0.20);
    const lB = Math.max(avg * Math.exp(k*(sB-sA)), 0.20);

    const xgA = teamXG(m.home, standings, avg);
    const xgB = teamXG(m.away, standings, avg);
    const blA = lA*0.55 + xgA*0.45;
    const blB = lB*0.55 + xgB*0.45;

    const dc = dixonColes(blA, blB);
    const [hp, dp, ap] = norm100(dc.home*100, dc.draw*100, dc.away*100);
    const o15 = clamp(probOver(blA, blB, 1)*100, 25, 95);
    const o25 = clamp(probOver(blA, blB, 2)*100, 12, 92);

    const lA_ = standings.find(t => t.team === m.home);
    const lB_ = standings.find(t => t.team === m.away);
    const aiA = (aiStandings||[]).find(t => t.team === m.home);
    const aiB = (aiStandings||[]).find(t => t.team === m.away);
    const fA  = formData?.[m.home];
    const fB  = formData?.[m.away];
    const h2h = extractH2HContext(m.home, m.away, historyEntries);

    const favorit = hp >= ap ? m.home : m.away;
    const diff = Math.abs(hp - ap);
    const certainty = diff>=20?'egyértelműen':diff>=10?'valamelyest':'enyhén';

    const aiTxt = aiA&&aiB
      ? ` AI prognózis: ${m.home} ${aiA.pos}. (${aiA.pts}pt) vs ${m.away} ${aiB.pos}. (${aiB.pts}pt).`
      : '';
    const formTxt = fA&&fB
      ? ` Forma: ${m.home} ${fA.trend}(${fA.last3||'?'}) vs ${m.away} ${fB.trend}(${fB.last3||'?'}).`
      : '';
    const h2hTxt = h2h
      ? ` Utolsó ${h2h.rounds} fordulóban: ${m.home} ${h2h.aAheadCount}× volt előrébb, ${m.away} ${h2h.bAheadCount}×.`
      : '';

    return {
      home: m.home, away: m.away,
      homePct: hp, drawPct: dp, awayPct: ap,
      over15Pct: o15, over25Pct: o25,
      over15Comment: o15>=65
        ? `Gólgazdag meccs várható (xG: ${blA.toFixed(1)}+${blB.toFixed(1)})`
        : `Defenzív meccs, alacsony gólszámmal (xG: ${blA.toFixed(1)}+${blB.toFixed(1)})`,
      over25Comment: o25>=55
        ? 'A csapatok gólátlaga alapján 3+ gól is reális'
        : 'xG-adatok defenzív meccset jeleznek',
      analysis: `${favorit} ${certainty} az esélyes (erőindex: ${Math.round(sA)} vs ${Math.round(sB)}, tabella: ${lA_?.pos||'?'}. vs ${lB_?.pos||'?'}.).${aiTxt}${formTxt}${h2hTxt} Várható gólszám: ${blA.toFixed(2)}–${blB.toFixed(2)}.`,
      source: 'local',
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// § 6. PROMPT ÉPÍTÉS
// ════════════════════════════════════════════════════════════════════════════

function buildPrompt(matches, standings, aiStandings, formData, historyEntries) {
  const avg = standings.length ? ligaAvgXG(standings) : 1.30;

  const aiCtx = (aiStandings||[]).length
    ? `AI SZEZONVÉGI ELŐREJELZÉS (ez az elsődleges forrás!):\n` +
      aiStandings.map(t => {
        const curr = standings.find(s => s.team === t.team);
        const posDiff = curr ? curr.pos - t.pos : 0;
        return `${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${t.pts}pt | GD:${(t.goalsFor||0)-(t.goalsAgainst||0)>=0?'+':''}${(t.goalsFor||0)-(t.goalsAgainst||0)} | jelenlegi: ${curr?.pos||'?'}.${posDiff!==0?` | ${posDiff>0?'↑JAVULÁS':'↓ROMLÁS'} ${Math.abs(posDiff)} hely`:''}`;
      }).join('\n')
    : 'Nincs AI előrejelzés';

  const liveCtx = standings.length
    ? standings.map(t => {
        const gp  = Math.max((t.wins||0)+(t.draws||0)+(t.losses||0), 1);
        const gd  = (t.goalsFor||0)-(t.goalsAgainst||0);
        const ppg = (t.pts/gp).toFixed(2);
        return `${String(t.pos).padStart(2)}. ${t.team.padEnd(22)} ${String(t.pts).padStart(3)}pt | GD:${gd>=0?'+':''}${gd} | ppg:${ppg}`;
      }).join('\n')
    : 'Nem elérhető';

  const formCtx = formData && Object.keys(formData).length
    ? Object.entries(formData)
        .sort((a, b) => b[1].avgPtsPerRound - a[1].avgPtsPerRound)
        .map(([team, f]) => `${team.padEnd(22)} ${f.trend.padEnd(8)} | ${f.avgPtsPerRound}pt/ford | ${f.posLabel} | utolsó3:${f.last3||'?'}`)
        .join('\n')
    : 'Nincs forma adat';

  const matchCtx = matches.map((m, i) => {
    const sA  = computeStrength(m.home, standings, aiStandings, formData);
    const sB  = computeStrength(m.away, standings, aiStandings, formData);
    const xgA = teamXG(m.home, standings, avg);
    const xgB = teamXG(m.away, standings, avg);
    const lA  = standings.find(t => t.team === m.home);
    const lB  = standings.find(t => t.team === m.away);
    const aiA = (aiStandings||[]).find(t => t.team === m.home);
    const aiB = (aiStandings||[]).find(t => t.team === m.away);
    const fA  = formData?.[m.home];
    const fB  = formData?.[m.away];
    const h2h = extractH2HContext(m.home, m.away, historyEntries);

    const lines = [
      `${i+1}. ${m.home} vs ${m.away}`,
      `   Erőindex: ${Math.round(sA)} vs ${Math.round(sB)} (különbség: ${Math.round(sA-sB)>=0?'+':''}${Math.round(sA-sB)})`,
      `   Jelenlegi: ${lA?.pos||'?'}. (${lA?.pts||0}pt) vs ${lB?.pos||'?'}. (${lB?.pts||0}pt)`,
    ];
    if (aiA && aiB)
      lines.push(`   AI prognózis: ${m.home} ${aiA.pos}. (${aiA.pts}pt) vs ${m.away} ${aiB.pos}. (${aiB.pts}pt) ← ELSŐDLEGES`);
    lines.push(`   xG/meccs: ${xgA.toFixed(2)} vs ${xgB.toFixed(2)}`);
    if (fA && fB)
      lines.push(`   Forma: ${m.home} ${fA.trend}(${fA.last3||'?'}) vs ${m.away} ${fB.trend}(${fB.last3||'?'})`);
    if (h2h)
      lines.push(`   Utolsó ${h2h.rounds} forduló: ${m.home} ${h2h.aAheadCount}× előrébb, ${m.away} ${h2h.bAheadCount}×`);
    return lines.join('\n');
  }).join('\n\n');

  return `Te egy profi futball statisztikus vagy. Adatvezérelt meccs-előrejelzést kell készítened.

━━━ AI SZEZONVÉGI ELŐREJELZÉS (ELSŐDLEGES) ━━━
${aiCtx}

━━━ JELENLEGI TABELLA (másodlagos) ━━━
${liveCtx}

━━━ CSAPATFORMA ━━━
${formCtx}

━━━ MECCSEK ━━━
${matchCtx}

━━━ FELADAT ━━━
Minden meccshez JSON objektum:
{"home":"nev","away":"nev","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"1 mondat","over25Comment":"1 mondat","analysis":"2-3 mondat"}

KÖTELEZŐ:
1. homePct + drawPct + awayPct = PONTOSAN 100
2. Csak erőindex, AI tábla, forma számít – helyszín NEM
3. Az AI szezonvégi pozíció a legfontosabb indikátor
4. Nagy különbségnél (erőindex >15): pl. 58-24-18
5. Kis különbségnél (erőindex <5): pl. 37-28-35
6. döntetlen: 8-32%
7. over25 legyen konzisztens az xG-vel (xG < 1.0 → over25 max 40%)
8. analysis: konkrét számok, favorit + indok + kockázat

CSAK valid JSON tömböt adj vissza:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"..."}]`;
}

// ════════════════════════════════════════════════════════════════════════════
// § 7. LLM HÍVÁS – javított, helyes Authorization header
// ════════════════════════════════════════════════════════════════════════════

async function callLLM(prompt) {
  // 1. Anthropic (ha van ANTHROPIC_API_KEY)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.15,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text;
        if (text?.trim()) return text;
      }
    } catch (e) { console.warn('[match-tips] Anthropic hiba:', e.message); }
  }

  // 2. LLM7 fallback – ingyenes, nincs API key szükséges
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.15,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(28000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (text?.trim()) return text;
    }
  } catch (e) { console.warn('[match-tips] LLM7 hiba:', e.message); }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// § 8. JSON PARSE + VALIDÁCIÓ
// ════════════════════════════════════════════════════════════════════════════

function parseAndValidate(llmText, matches) {
  const clean = llmText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let best = null, depth = 0, start = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i]==='[') { if(depth===0) start=i; depth++; }
    else if (clean[i]===']') {
      depth--;
      if (depth===0 && start!==-1) {
        const c = clean.slice(start, i+1);
        if (!best||c.length>best.length) best=c;
        start=-1;
      }
    }
  }
  if (!best) return null;
  let parsed;
  try { parsed = JSON.parse(best); } catch { return null; }
  if (!Array.isArray(parsed)||!parsed.length) return null;

  return parsed.map((r, i) => {
    const m = matches[i] || {};
    let hp = Math.round(Number(r.homePct)||0);
    let dp = Math.round(Number(r.drawPct)||0);
    let ap = Math.round(Number(r.awayPct)||0);
    const s = hp+dp+ap;
    if (s!==100&&s>0) { hp=Math.round(hp/s*100); dp=Math.round(dp/s*100); ap=100-hp-dp; }
    else if (s===0) { hp=38; dp=25; ap=37; }
    [hp, dp, ap] = norm100(hp, dp, ap);
    return {
      home: String(r.home||m.home||'?'),
      away: String(r.away||m.away||'?'),
      homePct: hp, drawPct: dp, awayPct: ap,
      over15Pct:    clamp(Number(r.over15Pct)||60, 25, 95),
      over25Pct:    clamp(Number(r.over25Pct)||40, 12, 90),
      over15Comment: String(r.over15Comment||'Közepes gólvárhatóság.'),
      over25Comment: String(r.over25Comment||'Szoros mérkőzés.'),
      analysis:      String(r.analysis     ||'Kiegyenlített meccs.'),
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// § 9. HANDLER
// ════════════════════════════════════════════════════════════════════════════

export default async function handler(req) {
  if (req.method==='OPTIONS') return new Response(null, {status:204, headers:corsHeaders});
  if (req.method!=='POST')
    return new Response(JSON.stringify({error:'Method not allowed'}), {status:405, headers:corsHeaders});

  try {
    const body = await req.json();
    const { matches, standings, aiPrediction, history } = body;

    if (!matches?.length)
      return new Response(JSON.stringify({error:'Hiányzó matches'}), {status:400, headers:corsHeaders});

    const safeStandings  = Array.isArray(standings)                ? standings               : [];
    const aiStandings    = Array.isArray(aiPrediction?.standings)   ? aiPrediction.standings  : [];
    const historyEntries = Array.isArray(history) ? history.slice(0, 8) : [];
    const formData       = buildFormContext(historyEntries);

    const prompt   = buildPrompt(matches, safeStandings, aiStandings, formData, historyEntries);
    const llmText  = await callLLM(prompt);

    let results = null;
    let source  = 'local';

    if (llmText) {
      const parsed = parseAndValidate(llmText, matches);
      if (parsed?.length) {
        results = parsed;
        source  = 'ai';
      } else {
        console.warn('[match-tips] AI JSON parse sikertelen – lokális fallback');
      }
    }

    if (!results) {
      results = computeLocalTips(matches, safeStandings, aiStandings, formData, historyEntries);
      source  = 'local';
    }

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
    return new Response(JSON.stringify({error: err.message}), {status:500, headers:corsHeaders});
  }
}
