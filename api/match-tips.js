// api/ai-prediction.js – v6: PRECÍZ MATEMATIKAI ELŐREJELZÉS
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AI_KEY = 'vsport:ai_prediction';
const AI_META_KEY = 'vsport:ai_meta';

// ─── KV helpers ─────────────────────────────────────────────────────────
function kvUrl(path) {
  const base = process.env.KV_REST_API_URL;
  if (!base) throw new Error('KV_REST_API_URL nincs beállítva');
  return `${base}${path}`;
}

function kvHeaders() {
  const token = process.env.KV_REST_API_TOKEN;
  if (!token) throw new Error('KV_REST_API_TOKEN nincs beállítva');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function kvGet(key) {
  try {
    const res = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), {
      headers: kvHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.result ?? null;
    if (result === null) return null;
    
    // Vercel KV formátum kezelése
    if (typeof result === 'object' && result.value !== undefined) {
      return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    }
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  const res = await fetch(kvUrl('/set'), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify({ [key]: value }),
    signal: AbortSignal.timeout(10000),
  });
  return res.ok;
}

function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ─── HISTORY ADATOK FELDOLGOZÁSA ───────────────────────────────────────
async function loadHistoryFromKV(seasonId) {
  try {
    // Először szezon-specifikus kulcs
    if (seasonId) {
      const raw = await kvGet(`vsport:league_history:season:${seasonId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    }
    // Fallback: legacy kulcs
    const raw = await kvGet('vsport:league_history');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn('[ai-prediction] History betöltési hiba:', e.message);
  }
  return [];
}

function calculateTeamStats(history, teamName) {
  if (!history || !history.length) return null;
  
  // Csak az adott csapat snapshotjai
  const teamSnapshots = [];
  
  for (const entry of history) {
    const team = entry.standingsSnapshot?.find(t => t.team === teamName);
    if (team) {
      teamSnapshots.push({
        timestamp: new Date(entry.timestamp).getTime(),
        pos: team.pos,
        pts: team.pts || 0,
        gf: team.goalsFor || 0,
        ga: team.goalsAgainst || 0,
      });
    }
  }
  
  if (teamSnapshots.length < 2) return null;
  
  // Rendezés időrendben
  teamSnapshots.sort((a, b) => a.timestamp - b.timestamp);
  
  // Statisztikák számítása
  const first = teamSnapshots[0];
  const last = teamSnapshots[teamSnapshots.length - 1];
  
  // Pozíció változás
  const posChange = first.pos - last.pos; // pozitív = javult
  
  // Pont változás
  const ptsChange = last.pts - first.pts;
  
  // Pont per snapshot (átlagos pontgyarapodás)
  const ptsGains = [];
  for (let i = 1; i < teamSnapshots.length; i++) {
    ptsGains.push(teamSnapshots[i].pts - teamSnapshots[i - 1].pts);
  }
  const avgPtsPerRound = ptsGains.length 
    ? ptsGains.reduce((a, b) => a + b, 0) / ptsGains.length 
    : 0;
  
  // Utolsó 3 snapshot átlaga
  const last3 = teamSnapshots.slice(-3);
  const last3AvgPts = last3.reduce((sum, s) => sum + s.pts, 0) / last3.length;
  const last3AvgGF = last3.reduce((sum, s) => sum + s.gf, 0) / last3.length;
  const last3AvgGA = last3.reduce((sum, s) => sum + s.ga, 0) / last3.length;
  
  // Trend meghatározása
  let trend = 'same';
  if (posChange >= 2) trend = 'up';
  else if (posChange <= -2) trend = 'down';
  else if (last3AvgPts > avgPtsPerRound * 1.2) trend = 'up';
  else if (last3AvgPts < avgPtsPerRound * 0.8) trend = 'down';
  
  return {
    snapshots: teamSnapshots.length,
    firstPos: first.pos,
    lastPos: last.pos,
    posChange,
    ptsChange,
    avgPtsPerRound: Math.round(avgPtsPerRound * 100) / 100,
    last3AvgPts: Math.round(last3AvgPts * 100) / 100,
    last3AvgGF: Math.round(last3AvgGF * 10) / 10,
    last3AvgGA: Math.round(last3AvgGA * 10) / 10,
    trend,
  };
}

// ─── ELO SZÁMÍTÁS ─────────────────────────────────────────────────────
function calculateElo(pos, pts, totalTeams, maxPts, formBonus = 0) {
  // Pozíció alapú erősség (1. hely = 700, utolsó = 0)
  const posStrength = ((totalTeams - pos) / Math.max(totalTeams - 1, 1)) * 700;
  
  // Pontszám alapú erősség (max 300)
  const ptsStrength = maxPts > 0 ? (pts / maxPts) * 300 : 0;
  
  // Alap Elo = 1200 + pozíció erősség + pont erősség + forma bónusz
  return Math.round(1200 + posStrength + ptsStrength + formBonus);
}

// ─── VÁRHATÓ GÓLOK (xG) SZÁMÍTÁSA ────────────────────────────────────
function calculateExpectedGoals(team, opponent, teamStats, oppStats) {
  // Alap xG
  let xG = 1.4;
  
  // Pozíció alapú korrekció
  if (team.pos <= 3) xG *= 1.25; // Top csapatok többet lőnek
  else if (team.pos >= 14) xG *= 0.8; // Gyengébbek kevesebbet
  
  // Forma alapú korrekció (ha van history)
  if (teamStats) {
    const formFactor = teamStats.last3AvgGF / 1.5; // 1.5 az átlagos gól/meccs
    xG *= Math.min(1.3, Math.max(0.7, formFactor));
  }
  
  // Ellenfél védelem alapú korrekció
  if (oppStats) {
    const defenseFactor = oppStats.last3AvgGA / 1.5;
    xG *= Math.min(1.2, Math.max(0.8, 2 - defenseFactor));
  }
  
  return Math.min(3.5, Math.max(0.7, xG));
}

// ─── POISSON VALÓSZÍNŰSÉG ────────────────────────────────────────────
function poissonProbability(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

// Mérkőzés eredmény valószínűsége Poisson alapján
function matchProbabilities(xgHome, xgAway) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  
  // Számoljunk 0-10 gólig
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const prob = poissonProbability(xgHome, h) * poissonProbability(xgAway, a);
      if (h > a) homeWin += prob;
      else if (h === a) draw += prob;
      else awayWin += prob;
    }
  }
  
  return { homeWin, draw, awayWin };
}

// ─── FŐ ELŐREJELZÉS ──────────────────────────────────────────────────
function generatePrediction(standings, history) {
  const totalTeams = standings.length;
  const maxPts = Math.max(...standings.map(t => t.pts || 0), 1);
  
  // Csapat statisztikák a historyból
  const teamStats = {};
  for (const team of standings) {
    const stats = calculateTeamStats(history, team.team);
    if (stats) teamStats[team.team] = stats;
  }
  
  // Elo számítás minden csapatnak
  const teamElo = {};
  for (const team of standings) {
    const stats = teamStats[team.team];
    const formBonus = stats ? Math.min(150, Math.max(-150, stats.posChange * 10)) : 0;
    teamElo[team.team] = calculateElo(team.pos, team.pts, totalTeams, maxPts, formBonus);
  }
  
  // Szimuláljuk a hátralévő mérkőzéseket
  // Becsüljük meg a lejátszott fordulók számát
  const avgPtsPerTeam = standings.reduce((sum, t) => sum + (t.pts || 0), 0) / totalTeams;
  const playedRounds = Math.max(1, Math.round(avgPtsPerTeam / 2.7)); // 2.7 pont/forduló átlagosan
  const remainingRounds = Math.max(0, 34 - playedRounds);
  
  // Várható pontok számítása minden csapatnak
  const projectedPts = {};
  
  for (const team of standings) {
    const stats = teamStats[team.team];
    let basePts = team.pts || 0;
    
    if (remainingRounds > 0) {
      // Alap pont/forduló ráta
      let ptsPerRound = 1.35; // Átlagos pont/forduló
      
      // Pozíció alapú korrekció
      if (team.pos <= 3) ptsPerRound = 2.0;
      else if (team.pos <= 6) ptsPerRound = 1.8;
      else if (team.pos <= 10) ptsPerRound = 1.5;
      else if (team.pos <= 14) ptsPerRound = 1.2;
      else ptsPerRound = 0.9;
      
      // Forma alapú korrekció
      if (stats) {
        if (stats.trend === 'up') ptsPerRound *= 1.15;
        else if (stats.trend === 'down') ptsPerRound *= 0.85;
        
        // Utolsó 3 forduló átlaga
        if (stats.last3AvgPts > 0) {
          ptsPerRound = (ptsPerRound + stats.last3AvgPts) / 2;
        }
      }
      
      // Elo alapú korrekció (erősebb csapat több pontot szerez)
      const avgElo = Object.values(teamElo).reduce((a, b) => a + b, 0) / totalTeams;
      const eloFactor = teamElo[team.team] / avgElo;
      ptsPerRound *= Math.min(1.3, Math.max(0.7, eloFactor));
      
      const projectedExtra = ptsPerRound * remainingRounds;
      projectedPts[team.team] = Math.round(basePts + projectedExtra);
    } else {
      projectedPts[team.team] = basePts;
    }
  }
  
  // Rendezés várható pontok szerint
  const sortedTeams = [...standings].sort((a, b) => {
    const ptsA = projectedPts[a.team] || a.pts;
    const ptsB = projectedPts[b.team] || b.pts;
    return ptsB - ptsA;
  });
  
  // Végeredmény összeállítása
  const result = [];
  
  for (let i = 0; i < sortedTeams.length; i++) {
    const team = sortedTeams[i];
    const projPts = projectedPts[team.team] || team.pts;
    const stats = teamStats[team.team];
    
    // Trend meghatározása (várható pozíció vs aktuális)
    let trend = 'same';
    const currentPos = standings.findIndex(t => t.team === team.team) + 1;
    const projectedPos = i + 1;
    
    if (projectedPos < currentPos) trend = 'up';
    else if (projectedPos > currentPos) trend = 'down';
    
    // Gólok extrapolálása
    const goalFactor = projPts / Math.max(team.pts, 1);
    const projGF = Math.round((team.goalsFor || 0) * goalFactor * 0.95);
    const projGA = Math.round((team.goalsAgainst || 0) * goalFactor * 0.95);
    
    result.push({
      pos: i + 1,
      team: team.team,
      goalsFor: projGF,
      goalsAgainst: projGA,
      pts: projPts,
      trend,
      currentPos,
    });
  }
  
  return {
    standings: result,
    meta: {
      playedRounds,
      remainingRounds,
      totalTeams,
      historyUsed: history?.length || 0,
    }
  };
}

// ─── ELEMZÉS GENERÁLÁSA ───────────────────────────────────────────────
function generateAnalysis(prediction, currentStandings, historyCount) {
  const { standings, meta } = prediction;
  const { playedRounds, remainingRounds } = meta;
  
  const top3 = standings.slice(0, 3).map(t => `${t.team} (${t.pts} pt)`).join(', ');
  const bottom3 = standings.slice(-3).map(t => `${t.team} (${t.pts} pt)`).join(', ');
  
  const risers = standings
    .filter(t => t.trend === 'up' && t.currentPos > t.pos)
    .map(t => `${t.team} (${t.currentPos}→${t.pos})`)
    .slice(0, 3)
    .join(', ') || 'nincs';
  
  const fallers = standings
    .filter(t => t.trend === 'down' && t.currentPos < t.pos)
    .map(t => `${t.team} (${t.currentPos}→${t.pos})`)
    .slice(0, 3)
    .join(', ') || 'nincs';
  
  const champ = standings[0]?.team || '?';
  const champPts = standings[0]?.pts || 0;
  const secondDiff = standings[0]?.pts - (standings[1]?.pts || 0);
  
  let analysis = `🏆 **SZEZONVÉGI ELŐREJELZÉS**\n\n`;
  analysis += `📊 **Állás ${playedRounds} forduló után** – ${remainingRounds} forduló van hátra\n\n`;
  
  analysis += `**Top 3:** ${top3}\n`;
  analysis += `**Kiesők:** ${bottom3}\n\n`;
  
  analysis += `**Emelkedők:** ${risers}\n`;
  analysis += `**Esők:** ${fallers}\n\n`;
  
  analysis += `**Bajnok esélyes:** ${champ} (${champPts} pont)\n`;
  if (secondDiff > 0) {
    analysis += `Előny a második előtt: ${secondDiff} pont\n`;
  }
  
  if (historyCount > 0) {
    analysis += `\n📈 A becslés ${historyCount} korábbi forduló adatai alapján készült.`;
  } else {
    analysis += `\n⚠️ Nincs history adat – a becslés csak az aktuális álláson alapul.`;
  }
  
  return analysis;
}

// ─── HANDLER ───────────────────────────────────────────────────────────
export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  // GET – meglévő előrejelzés lekérése
  if (req.method === 'GET') {
    try {
      const rawPred = await kvGet(AI_KEY);
      const rawMeta = await kvGet(AI_META_KEY);
      
      let prediction = null;
      let meta = null;
      
      if (rawPred) {
        try { prediction = JSON.parse(rawPred); } catch {}
      }
      if (rawMeta) {
        try { meta = JSON.parse(rawMeta); } catch {}
      }
      
      return new Response(
        JSON.stringify({ prediction, meta, hasData: !!prediction }),
        { status: 200, headers: corsHeaders }
      );
    } catch (err) {
      console.error('[ai-prediction GET]', err);
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
  
  // POST – új előrejelzés generálása
  if (req.method === 'POST') {
    try {
      const { standings, seasonId, force } = await req.json();
      
      if (!standings || !standings.length) {
        return new Response(
          JSON.stringify({ error: 'Hiányzó vagy üres standings' }),
          { status: 400, headers: corsHeaders }
        );
      }
      
      const currentFP = fingerprint(standings);
      
      // Ellenőrizzük, hogy van-e már aktuális előrejelzés
      if (!force) {
        const rawMeta = await kvGet(AI_META_KEY);
        if (rawMeta) {
          try {
            const meta = JSON.parse(rawMeta);
            const seasonChanged = seasonId && meta.seasonId && String(seasonId) !== String(meta.seasonId);
            
            if (!seasonChanged && meta.basedOnFingerprint === currentFP) {
              const rawPred = await kvGet(AI_KEY);
              if (rawPred) {
                try {
                  const prediction = JSON.parse(rawPred);
                  return new Response(
                    JSON.stringify({ 
                      prediction, 
                      meta, 
                      regenerated: false, 
                      reason: 'already_current' 
                    }),
                    { status: 200, headers: corsHeaders }
                  );
                } catch {}
              }
            }
          } catch {}
        }
      }
      
      console.log('[ai-prediction] Generálás...', { seasonId, force });
      
      // History betöltése
      const history = await loadHistoryFromKV(seasonId);
      
      // Előrejelzés generálása
      const result = generatePrediction(standings, history);
      const prediction = result.standings;
      const meta = result.meta;
      
      // Elemzés generálása
      const analysis = generateAnalysis(
        { standings: prediction, meta }, 
        standings, 
        history.length
      );
      
      const finalPrediction = {
        standings: prediction,
        analysis,
        generatedAt: new Date().toISOString(),
        basedOnFingerprint: currentFP,
        seasonId: seasonId || null,
        ...meta,
      };
      
      // Mentés KV-ba
      await kvSet(AI_KEY, JSON.stringify(finalPrediction));
      await kvSet(AI_META_KEY, JSON.stringify({
        generatedAt: finalPrediction.generatedAt,
        basedOnFingerprint: currentFP,
        seasonId: seasonId || null,
      }));
      
      return new Response(
        JSON.stringify({ 
          prediction: finalPrediction, 
          regenerated: true,
          historyUsed: history.length,
        }),
        { status: 200, headers: corsHeaders }
      );
      
    } catch (err) {
      console.error('[ai-prediction POST]', err);
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
  
  // Minden más metódus tiltva
  return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: corsHeaders }
  );
}
