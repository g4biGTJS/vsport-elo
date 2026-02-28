// api/standings.js  – Vercel Serverless Function
// Lekéri a Sportradar virtual league oldalát és visszaadja az állást JSON-ban.

export const config = { runtime: 'edge' };

const LEAGUES = {
  premier: 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061001',
  spanyol: null, // karbantartás alatt
};

// Sportradar az adatokat egy beágyazott JSON-ban adja vissza az oldalon belül.
// Próbáljuk kinyerni a __NEXT_DATA__ vagy a window.__STATE__ objektumból.
async function fetchStandings(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Próbáljuk megtalálni a standings adatokat a HTML-ben
  // A Sportradar widget általában __NEXT_DATA__ vagy embedded JSON formában tárolja
  let standings = [];

  // 1. próba: __NEXT_DATA__
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      standings = extractFromNextData(data);
      if (standings.length > 0) return standings;
    } catch (e) { /* folytatás */ }
  }

  // 2. próba: window.__INITIAL_STATE__ vagy hasonló
  const stateMatch = html.match(/window\.__(?:INITIAL_STATE|STATE|DATA)__\s*=\s*({[\s\S]*?});/);
  if (stateMatch) {
    try {
      const data = JSON.parse(stateMatch[1]);
      standings = extractFromState(data);
      if (standings.length > 0) return standings;
    } catch (e) { /* folytatás */ }
  }

  // 3. próba: inline JSON tömb keresés standings/table kulcsra
  const tableMatch = html.match(/"standings"\s*:\s*(\[[\s\S]*?\])/);
  if (tableMatch) {
    try {
      const data = JSON.parse(tableMatch[1]);
      standings = extractFromStandingsArray(data);
      if (standings.length > 0) return standings;
    } catch (e) { /* folytatás */ }
  }

  return []; // nem sikerült parse-olni
}

function extractFromNextData(data) {
  // Rekurzívan keresünk standings/table tömböt
  return findStandings(data);
}

function extractFromState(data) {
  return findStandings(data);
}

function extractFromStandingsArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item, i) => ({
    pos: i + 1,
    team: item.team?.name?.short || item.name?.short || item.abbreviation || '???',
    goalsFor: item.goalsFor ?? item.scored ?? 0,
    goalsAgainst: item.goalsAgainst ?? item.conceded ?? 0,
    pts: item.points ?? item.pts ?? 0,
    trend: 'same',
  })).filter(r => r.team !== '???');
}

function findStandings(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return [];

  // Keresünk standings tömböt
  for (const key of ['rows', 'standings', 'table', 'items', 'teams']) {
    if (Array.isArray(obj[key]) && obj[key].length > 3) {
      const mapped = extractFromStandingsArray(obj[key]);
      if (mapped.length > 3) return mapped;
    }
  }

  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const result = findStandings(val, depth + 1);
      if (result.length > 3) return result;
    }
  }

  return [];
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const liga = searchParams.get('liga') || 'premier';

  const url = LEAGUES[liga];

  if (!url) {
    return new Response(JSON.stringify({ error: 'maintenance', standings: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
      },
    });
  }

  try {
    const standings = await fetchStandings(url);
    return new Response(JSON.stringify({ standings }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, standings: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
