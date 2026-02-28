// api/standings.js – Vercel Edge Function
export const config = { runtime: 'edge' };

const SEASON_ID = '3061001';

// Fallback data from screenshot (frissítsd manuálisan ha szükséges)
const FALLBACK_STANDINGS = [
  { pos: 1,  team: 'Manchester Kék', goalsFor: 34, goalsAgainst: 20, pts: 38, trend: 'same' },
  { pos: 2,  team: 'Liverpool',       goalsFor: 30, goalsAgainst: 15, pts: 30, trend: 'up' },
  { pos: 3,  team: 'Vörös Ördögök',   goalsFor: 38, goalsAgainst: 24, pts: 29, trend: 'down' },
  { pos: 4,  team: 'Fulham',          goalsFor: 25, goalsAgainst: 20, pts: 28, trend: 'up' },
  { pos: 5,  team: 'Everton',         goalsFor: 27, goalsAgainst: 14, pts: 27, trend: 'down' },
  { pos: 6,  team: 'Chelsea',         goalsFor: 24, goalsAgainst: 17, pts: 26, trend: 'up' },
  { pos: 7,  team: 'London Ágyúk',    goalsFor: 21, goalsAgainst: 19, pts: 26, trend: 'up' },
  { pos: 8,  team: 'Wolverhampton',   goalsFor: 28, goalsAgainst: 26, pts: 25, trend: 'down' },
  { pos: 9,  team: 'Newcastle',       goalsFor: 23, goalsAgainst: 24, pts: 23, trend: 'up' },
  { pos: 10, team: 'Tottenham',       goalsFor: 20, goalsAgainst: 26, pts: 23, trend: 'down' },
  { pos: 11, team: 'Brentford',       goalsFor: 14, goalsAgainst: 15, pts: 21, trend: 'up' },
  { pos: 12, team: 'West Ham',        goalsFor: 21, goalsAgainst: 26, pts: 20, trend: 'down' },
  { pos: 13, team: 'Nottingham',      goalsFor: 18, goalsAgainst: 29, pts: 18, trend: 'up' },
  { pos: 14, team: 'Aston Oroszlán',  goalsFor: 15, goalsAgainst: 29, pts: 16, trend: 'down' },
  { pos: 15, team: 'Brighton',        goalsFor: 13, goalsAgainst: 35, pts: 12, trend: 'same' },
  { pos: 16, team: 'Crystal Palace',  goalsFor: 12, goalsAgainst: 24, pts: 10, trend: 'same' },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
  'Origin': 'https://s5.sir.sportradar.com',
};

// Sportradar widget API endpoint-ok – ezeket próbáljuk
const ENDPOINTS = [
  `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/config_season_standings/${SEASON_ID}`,
  `https://ls.sir.sportradar.com/scigamingvirtuals/hu/gismo/config_season_standings/${SEASON_ID}`,
  `https://ls.sir.sportradar.com/scigamingvirtuals/hu/Europe:London/gismo/config_season_standings/${SEASON_ID}`,
  `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/config/season_standings/${SEASON_ID}`,
  `https://ls.sir.sportradar.com/scigamingvirtuals/hu/gismo/config/season_standings/${SEASON_ID}`,
];

function parseTrend(val) {
  if (!val) return 'same';
  if (typeof val === 'number') return val > 0 ? 'up' : val < 0 ? 'down' : 'same';
  const v = String(val).toLowerCase();
  if (v === 'up' || v === '+' || v === 'increase') return 'up';
  if (v === 'down' || v === '-' || v === 'decrease') return 'down';
  return 'same';
}

function findStandingsRecursive(obj, depth = 0) {
  if (depth > 15 || !obj || typeof obj !== 'object') return [];

  for (const key of ['rows', 'items', 'standings', 'table', 'teams']) {
    if (Array.isArray(obj[key]) && obj[key].length >= 3) {
      const mapped = obj[key].map((item, i) => ({
        pos: item.rank ?? item.pos ?? (i + 1),
        team: item.team?.abbr || item.team?.name?.short || item.abbreviation || item.short || item.name?.short || item.name || '???',
        goalsFor: item.goalsfor ?? item.goals_for ?? item.gf ?? item.goalsFor ?? 0,
        goalsAgainst: item.goalsagainst ?? item.goals_against ?? item.ga ?? item.goalsAgainst ?? 0,
        pts: item.pts ?? item.points ?? 0,
        trend: parseTrend(item.trend ?? item.form),
      })).filter(r => r.team !== '???');
      if (mapped.length >= 3) return mapped;
    }
  }

  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null) {
      const result = findStandingsRecursive(val, depth + 1);
      if (result.length >= 3) return result;
    }
  }

  return [];
}

async function tryFetchStandings() {
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      const standings = findStandingsRecursive(data);
      if (standings.length >= 3) return { standings, source: 'api' };
    } catch (_) {
      // try next
    }
  }
  return null;
}

export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=55, stale-while-revalidate=110',
  };

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  // Próbáljuk az API-t
  const apiResult = await tryFetchStandings();

  if (apiResult && apiResult.standings.length >= 3) {
    return new Response(
      JSON.stringify({ standings: apiResult.standings, source: 'api', ...(debug ? { apiResult } : {}) }),
      { status: 200, headers: corsHeaders }
    );
  }

  // Fallback: hardcoded data
  return new Response(
    JSON.stringify({ standings: FALLBACK_STANDINGS, source: 'fallback' }),
    { status: 200, headers: corsHeaders }
  );
}
