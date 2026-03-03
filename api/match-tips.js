// api/match-tips.js – v9: TISZTA MATEMATIKAI SZÁMÍTÁS, AI NÉLKÜL
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Hazai pálya előny (Elo pontokban)
const HOME_ADVANTAGE = 65; // ~7-8% hazai előny

// ─── Elo számítás ─────────────────────────────────────────────────────────
function calculateTeamStrength(pos, pts, totalTeams, maxPts, formBonus = 0) {
  // Alap erősség: pozíció (1. hely = 600 pont, utolsó = 0)
  const posStrength = ((totalTeams - pos) / Math.max(totalTeams - 1, 1)) * 600;
  
  // Pontszám alapú erősség (max 300 pont)
  const ptsStrength = maxPts > 0 ? (pts / maxPts) * 300 : 0;
  
  // Összesített Elo (1000 az alap)
  return Math.round(1000 + posStrength + ptsStrength + (formBonus || 0));
}

// Elo alapú győzelmi valószínűség
function eloWinProbability(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

// Poisson eloszlás (gólok számának valószínűsége)
function poissonProbability(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

// Adott gól szám feletti valószínűség
function overGoalsProbability(lambda, goals) {
  if (lambda <= 0) return 0;
  let prob = 0;
  for (let k = 0; k <= Math.floor(goals); k++) {
    prob += poissonProbability(lambda, k);
  }
  return Math.min(0.95, Math.max(0.1, 1 - prob));
}

// Forma bónusz számítása history alapján
function calculateFormBonus(history, teamName) {
  if (!history || !history.length) return 0;
  
  // Csak az utolsó 5 bejegyzés számít
  const recentHistory = history.slice(-5);
  let totalBonus = 0;
  let count = 0;
  
  for (const entry of recentHistory) {
    const team = entry.standingsSnapshot?.find(t => t.team === teamName);
    if (team) {
      // Ha javult a pozíció, + bónusz, ha romlott, - bónusz
      const prevEntry = history[history.indexOf(entry) - 1];
      if (prevEntry) {
        const prevTeam = prevEntry.standingsSnapshot?.find(t => t.team === teamName);
        if (prevTeam) {
          const posChange = prevTeam.pos - team.pos; // pozitív = javult
          totalBonus += posChange * 8; // minden javult hely +8 Elo
          count++;
        }
      }
    }
  }
  
  return count > 0 ? Math.round(totalBonus / count) : 0;
}

// Várható gólok száma (xG) számítása
function calculateExpectedGoals(team, opponent, history, teamName) {
  // Alapértelmezett xG
  let xG = 1.4;
  
  // History alapján pontosítás
  if (history && history.length) {
    const last3 = history.slice(-3);
    let totalGF = 0;
    let totalGA = 0;
    let matches = 0;
    
    for (const entry of last3) {
      const teamData = entry.standingsSnapshot?.find(t => t.team === teamName);
      if (teamData) {
        totalGF += teamData.goalsFor || 0;
        totalGA += teamData.goalsAgainst || 0;
        matches++;
      }
    }
    
    if (matches > 0) {
      // Átlagos lőtt és kapott gól az utolsó 3 mérkőzésen
      const avgGF = totalGF / matches;
      const avgGA = totalGA / matches;
      xG = (avgGF + avgGA) / 2;
    }
  }
  
  // Pozíció alapú korrekció
  if (team && team.pos <= 3) xG *= 1.2; // Top csapatok többet lőnek
  else if (team && team.pos >= 14) xG *= 0.8; // Gyengébb csapatok kevesebbet
  
  return Math.min(3.5, Math.max(0.8, xG));
}

// ─── FŐ SZÁMÍTÓ FÜGGVÉNY ─────────────────────────────────────────────────
function calculateMatchPrediction(match, standings, history) {
  const { home, away } = match;
  
  // Csapatok keresése a tabellában
  const homeTeam = standings.find(t => t.team === home);
  const awayTeam = standings.find(t => t.team === away);
  
  // Ha valamelyik csapat nem található, átlagos értékekkel számolunk
  const totalTeams = standings.length || 12;
  const maxPts = Math.max(...standings.map(t => t.pts || 0), 1);
  
  // Pozíciók (ha nincs csapat, középmezőny)
  const homePos = homeTeam?.pos ?? Math.ceil(totalTeams / 2);
  const awayPos = awayTeam?.pos ?? Math.ceil(totalTeams / 2);
  
  // Pontok
  const homePts = homeTeam?.pts ?? Math.round(maxPts * 0.5);
  const awayPts = awayTeam?.pts ?? Math.round(maxPts * 0.5);
  
  // Forma bónuszok
  const homeBonus = calculateFormBonus(history, home);
  const awayBonus = calculateFormBonus(history, away);
  
  // Elo erősségek
  const homeEloBase = calculateTeamStrength(homePos, homePts, totalTeams, maxPts, homeBonus);
  const awayEloBase = calculateTeamStrength(awayPos, awayPts, totalTeams, maxPts, awayBonus);
  
  // Hazai pálya előny (csak a hazai csapat kapja)
  const homeElo = homeEloBase + HOME_ADVANTAGE;
  const awayElo = awayEloBase;
  
  // Nyers győzelmi valószínűségek
  const rawHomeWin = eloWinProbability(homeElo, awayElo);
  const rawAwayWin = eloWinProbability(awayElo, homeElo);
  
  // Döntetlen valószínűség (minél közelebb van a két csapat, annál nagyobb)
  const eloDiff = Math.abs(homeEloBase - awayEloBase);
  const drawProb = Math.max(0.1, Math.min(0.3, 0.26 - (eloDiff / 1000) * 0.15));
  
  // Normalizálás (összeg = 1)
  const total = rawHomeWin + rawAwayWin + drawProb;
  let homePct = Math.round((rawHomeWin / total) * 100);
  let awayPct = Math.round((rawAwayWin / total) * 100);
  let drawPct = 100 - homePct - awayPct;
  
  // Minimum 5% minden kimenetelre
  if (drawPct < 5) {
    drawPct = 5;
    const remaining = 95;
    homePct = Math.round((rawHomeWin / (rawHomeWin + rawAwayWin)) * remaining);
    awayPct = remaining - homePct;
  }
  
  // Várható gólok (xG) számítása
  const homeXG = calculateExpectedGoals(homeTeam, awayTeam, history, home);
  const awayXG = calculateExpectedGoals(awayTeam, homeTeam, history, away);
  const totalXG = homeXG + awayXG;
  
  // Gól valószínűségek
  const over15Prob = overGoalsProbability(totalXG, 1.5);
  const over25Prob = overGoalsProbability(totalXG, 2.5);
  const over35Prob = overGoalsProbability(totalXG, 3.5);
  
  // Százalékok
  const over15Pct = Math.round(over15Prob * 100);
  const over25Pct = Math.round(over25Prob * 100);
  const over35Pct = Math.round(over35Prob * 100);
  
  // Elemzés szöveg generálása (teljesen sablon alapú)
  const favorite = homePct > awayPct ? home : (awayPct > homePct ? away : 'kiegyenlített');
  const favoriteTerm = favorite === home ? 'hazaiak' : (favorite === away ? 'vendégek' : 'egyik csapat sem');
  
  let analysis = '';
  if (homePct > 60) {
    analysis = `${home} magabiztos győzelemre esélyes. A hazai pálya előny és a jobb tabella pozíció (${homePos}. hely) jelentős fölényt ad.`;
  } else if (awayPct > 60) {
    analysis = `${away} idegenben is esélyesebb. A ${awayPos}. helyezés és a jobb formájuk alapján ők a favoritok.`;
  } else if (homePct > 50) {
    analysis = `${home} számít enyhe favoritnak a hazai pálya előnyének köszönhetően. A két csapat között kicsi a különbség (${homePos}. vs ${awayPos}. hely).`;
  } else if (awayPct > 50) {
    analysis = `${away} lehet előnyben, bár idegenben játszanak. A tabellán elfoglalt pozíciójuk (${awayPos}. hely) jobb formát mutat.`;
  } else {
    analysis = `Teljesen nyílt mérkőzés várható. Mindkét csapat hasonló erősségű (${homePos}. vs ${awayPos}. hely), bármelyik kimenetel benne van.`;
  }
  
  // Gól elemzés
  let over15Comment = '';
  if (totalXG > 2.8) {
    over15Comment = 'Gólgazdag mérkőzés várható, mindkét csapat sokat támad.';
  } else if (totalXG > 2.0) {
    over15Comment = 'Közepes gólszámú meccs lehet, de az 1.5 gól feletti esély magas.';
  } else {
    over15Comment = 'Taktikus, kevés gólt hozó mérkőzésre lehet számítani.';
  }
  
  let over25Comment = '';
  if (totalXG > 3.2) {
    over25Comment = 'Nagy esély van 3 vagy több gólra, a csapatok támadószelleműek.';
  } else if (totalXG > 2.5) {
    over25Comment = 'A 2.5 gól feletti eredmény valószínűbb, mint a 2.5 alatti.';
  } else if (totalXG > 2.0) {
    over25Comment = 'Kérdéses, hogy lesz-e 3 gól, inkább 1-2 gól várható.';
  } else {
    over25Comment = 'Valószínűleg 2 gólnál kevesebb lesz a mérkőzésen.';
  }
  
  return {
    home,
    away,
    homePct,
    drawPct,
    awayPct,
    over15Pct,
    over25Pct,
    over35Pct,
    over15Comment,
    over25Comment,
    analysis,
    // Meta adatok debug-hoz (nem kötelező)
    _homeElo: homeEloBase,
    _awayElo: awayEloBase,
    _homePos: homePos,
    _awayPos: awayPos,
    _totalXG: Math.round(totalXG * 10) / 10,
    _homeXG: Math.round(homeXG * 10) / 10,
    _awayXG: Math.round(awayXG * 10) / 10,
  };
}

// ─── KV helper (history betöltéséhez) ────────────────────────────────────
async function loadHistoryFromKV(seasonId) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  
  if (!baseUrl || !token) return [];
  
  try {
    const key = seasonId 
      ? `vsport:league_history:season:${seasonId}`
      : 'vsport:league_history';
      
    const res = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!res.ok) return [];
    
    const data = await res.json();
    const result = data.result;
    
    if (!result) return [];
    
    // A Vercel KV néha { value: "..." } formátumban adja vissza
    if (typeof result === 'object' && result.value) {
      return JSON.parse(result.value);
    }
    
    // Néha közvetlenül a tömb
    if (Array.isArray(result)) return result;
    
    return [];
  } catch (e) {
    console.warn('[match-tips] KV hiba:', e.message);
    return [];
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  // Csak POST engedélyezett
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { status: 405, headers: corsHeaders }
    );
  }
  
  try {
    const body = await req.json();
    const { matches, standings: realStandings, aiPrediction, seasonId } = body;
    
    // Validáció
    if (!matches || !matches.length) {
      return new Response(
        JSON.stringify({ error: 'Hiányzó vagy üres matches' }), 
        { status: 400, headers: corsHeaders }
      );
    }
    
    // Standings kiválasztása (először a valós, ha nincs, akkor AI)
    let standings = [];
    let standingsSource = 'none';
    
    if (realStandings && realStandings.length >= 8) {
      standings = realStandings;
      standingsSource = 'real';
    } else if (aiPrediction && aiPrediction.standings && aiPrediction.standings.length >= 8) {
      standings = aiPrediction.standings;
      standingsSource = 'ai';
    } else {
      // Ha egyik sincs, használjuk a kombináltat
      standings = [...(realStandings || []), ...(aiPrediction?.standings || [])];
      // Duplikációk eltávolítása
      const seen = new Set();
      standings = standings.filter(t => {
        if (seen.has(t.team)) return false;
        seen.add(t.team);
        return true;
      });
      standingsSource = 'combined';
    }
    
    // Ha még mindig nincs elég adat, hiba
    if (standings.length < 4) {
      return new Response(
        JSON.stringify({ error: 'Nincs elég tabella adat a számításhoz' }), 
        { status: 400, headers: corsHeaders }
      );
    }
    
    // History betöltése
    const kvHistory = await loadHistoryFromKV(seasonId || aiPrediction?.seasonId);
    const clientHistory = body.history || [];
    
    // Összefésülés (fingerprint alapján szűrve)
    const allHistory = [...clientHistory];
    const clientFPs = new Set(clientHistory.map(e => e.fingerprint).filter(Boolean));
    
    for (const entry of kvHistory) {
      if (!clientFPs.has(entry.fingerprint)) {
        allHistory.push(entry);
      }
    }
    
    // Rendezés időrendben
    allHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Eredmények számítása minden meccshez
    const results = matches.map(match => 
      calculateMatchPrediction(match, standings, allHistory)
    );
    
    // Válasz összeállítása
    return new Response(
      JSON.stringify({
        results,
        source: 'mathematical',
        standingsSource,
        historyUsed: allHistory.length,
        timestamp: new Date().toISOString(),
      }),
      { status: 200, headers: corsHeaders }
    );
    
  } catch (err) {
    console.error('[match-tips] HIBA:', err);
    
    return new Response(
      JSON.stringify({ 
        error: 'Szerver hiba történt',
        details: err.message 
      }), 
      { status: 500, headers: corsHeaders }
    );
  }
}
