// api/standings.js – Vercel Edge Function
// Sportradar gismo API-t hívja közvetlenül (nem scrape-el HTML-t)

export const config = { runtime: 'edge' };

// A widget URL-ből kinyert season ID
const SEASON_ID = '3061001';

// Sportradar belső gismo API endpointok (ezeket használja a widget maga is)
const ENDPOINTS = [
  `https://ls.sir.sportradar.com/scigamingvirtuals/hu/Europe:London/gismo/config/season_standings/${SEASON_ID}`,
  `https://ls.sir.sportradar.com/scigamingvirtuals/hu/gismo/config/season_standings/${SEASON_ID}`,
  `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/config/season_standings/${SEASON_ID}`,
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
  'Origin': 'https://s5.sir.sportradar.com',
};

async function tryEndpoint(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = await res.json();
  return data;
}

function parseGismoStandings(data) {
  // Gismo API tipikus struktúra: doc[0].data.standing[0].rows[]
  const standings = [];
  
  try {
    const doc = data?.doc?.[0]?.data;
    
    // Próbáljuk meg különböző helyeken megtalálni a standings adatot
    const standingGroups = doc?.standing || doc?.standings || doc?.table || [];
    
    for (const group of (Array.isArray(standingGroups) ? standingGroups : [standingGroups])) {
      const rows = group?.rows || group?.items || [];
      if (rows.length > 0) {
        rows.forEach((row, i) => {
          standings.push({
            pos: row.rank ?? row.pos ?? (i + 1),
            team: row.team?.abbr || row.team?.name?.short || row.abbreviation || row.name?.short || '???',
            goalsFor: row.goalsfor ?? row.goals_for ?? row.gf ?? 0,
            goalsAgainst: row.goalsagainst ?? row.goals_against ?? row.ga ?? 0,
            pts: row.pts ?? row.points ?? 0,
            trend: parseTrend(row.trend ?? row.form),
          });
        });
        if (standings.length > 0) return standings;
      }
    }
  } catch (e) {
    // fallthrough
  }

  // Rekurzív keresés ha a fenti nem működött
  return findStandingsRecursive(data);
}

function parseTrend(val) {
  if (!val) return 'same';
  if (typeof val === 'number') return val > 0 ? 'up' : val < 0 ? 'down' : 'same';
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    if (v === 'up' || v === '+' || v === 'increase') return 'up';
    if (v === 'down' || v === '-' || v === 'decrease') return 'down';
  }
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
      })).filter(r => r.team !== '???' && r.pts > 0);
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

export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=55, stale-while-revalidate=110',
  };

  // Próbáljuk végig az endpointokat
  let lastError = null;
  let rawData = null;

  for (const endpoint of ENDPOINTS) {
    try {
      rawData = await tryEndpoint(endpoint);
      break; // ha sikerült, kilépünk
    } catch (e) {
      lastError = e;
    }
  }

  if (!rawData) {
    return new Response(
      JSON.stringify({ error: lastError?.message || 'All endpoints failed', standings: [], raw: null }),
      { status: 200, headers: corsHeaders }
    );
  }

  const standings = parseGismoStandings(rawData);

  // Ha debug kell: visszaadjuk a raw-t is (fejlesztéshez)
  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  return new Response(
    JSON.stringify({
      standings,
      ...(debug ? { raw: rawData } : {}),
    }),
    { status: 200, headers: corsHeaders }
  );
}
