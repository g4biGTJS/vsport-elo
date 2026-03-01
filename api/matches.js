// api/matches.js – Vercel Edge Function
// Sportradar JSON API közvetlen lekérdezés (nem HTML scraping)

export const config = { runtime: 'edge' };

const BASE_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;
const LEAGUE_NAME = 'Virtuális Labdarúgás Liga Mód Retail';

// Sportradar belső JSON API endpointok
const FEED_BASE = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu';
const SEASON_FEED = (seasonId, feed) => `${FEED_BASE}/gismo/${feed}/${seasonId}`;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
  'X-Requested-With': 'XMLHttpRequest',
};

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 's-maxage=8, stale-while-revalidate=16',
};

// ─────────────────────────────────────────────────────────────
// Season ID felderítés – a page HTML-ből kinyerve
// (a JSON-ban van: "currentseasonid":3061347)
// ─────────────────────────────────────────────────────────────
let currentSeasonId = '3061347';
let lastCategoryCheck = 0;
const CHECK_INTERVAL = 120000;

async function findCurrentSeasonId() {
  const now = Date.now();
  if (now - lastCategoryCheck < CHECK_INTERVAL) return currentSeasonId;
  try {
    const res = await fetch(CATEGORY_URL, {
      headers: { ...FETCH_HEADERS, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // A season ID a beágyazott JSON-ban van
    const m = html.match(/"currentseasonid"\s*:\s*(\d+)/);
    if (m?.[1]) currentSeasonId = m[1];
    lastCategoryCheck = now;
  } catch (e) {
    console.error('[SeasonCheck]', e.message);
    lastCategoryCheck = now;
  }
  return currentSeasonId;
}

// ─────────────────────────────────────────────────────────────
// JSON feed lekérése
// ─────────────────────────────────────────────────────────────
async function fetchFeed(seasonId, feedName) {
  const url = SEASON_FEED(seasonId, feedName);
  console.log(`[feed] GET ${url}`);
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${feedName} HTTP ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────
// Alternatív: beágyazott JSON kinyerése a season page-ből
// ─────────────────────────────────────────────────────────────
async function extractEmbeddedData(seasonId) {
  const url = `${BASE_URL}/season/${seasonId}`;
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Season page HTTP ${res.status}`);
  const html = await res.text();

  // A fetchedData objektum a window.__INITIAL_STATE__ vagy hasonló változóban van
  // Próbáljuk kinyerni a stats_season_fixtures és stats_season_results adatokat
  const fixtures = extractFeedFromHtml(html, 'stats_season_fixtures');
  const results  = extractFeedFromHtml(html, 'stats_season_results');

  return { fixtures, results, htmlLength: html.length };
}

function extractFeedFromHtml(html, feedKey) {
  // Keresés: "stats_season_fixtures/3061347":{"event":...,"data":{...}}
  const idx = html.indexOf(`"${feedKey}/`);
  if (idx < 0) return null;
  // Találjuk meg a data: { ... } blokkot
  const dataIdx = html.indexOf('"data":', idx);
  if (dataIdx < 0) return null;
  // Brace matching a JSON objektum kinyeréséhez
  const start = html.indexOf('{', dataIdx + 7);
  if (start < 0) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < Math.min(start + 500000, html.length); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  try {
    return JSON.parse(html.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Match parser – sportradar fixtures JSON struktúrából
// ─────────────────────────────────────────────────────────────
function parseFixtures(data) {
  // data.fixtures vagy data.matches tömbben vannak a mérkőzések
  const matches = data?.fixtures || data?.matches || data?.matchlist || [];
  return matches.map(m => ({
    round: m._round ?? m.round ?? null,
    home: m.homeTeam?.name ?? m.hometeam?.name ?? m.home?.name ?? null,
    away: m.awayTeam?.name ?? m.awayteam?.name ?? m.away?.name ?? null,
    hid: String(m.homeTeam?.uid ?? m.hometeam?.uid ?? m.home?.uid ?? ''),
    aid: String(m.awayTeam?.uid ?? m.awayteam?.uid ?? m.away?.uid ?? ''),
    time: m.time?.time ?? m.matchtime ?? null,
    upcoming: true,
  })).filter(m => m.home && m.away);
}

function parseResults(data) {
  const matches = data?.results || data?.matches || data?.matchlist || [];
  return matches.map(m => {
    const hs = m.result?.home ?? m.homeScore ?? m.hs ?? null;
    const as = m.result?.away ?? m.awayScore ?? m.as ?? null;
    return {
      round: m._round ?? m.round ?? null,
      home: m.homeTeam?.name ?? m.hometeam?.name ?? m.home?.name ?? null,
      away: m.awayTeam?.name ?? m.awayteam?.name ?? m.away?.name ?? null,
      hid: String(m.homeTeam?.uid ?? m.hometeam?.uid ?? m.home?.uid ?? ''),
      aid: String(m.awayTeam?.uid ?? m.awayteam?.uid ?? m.away?.uid ?? ''),
      time: m.time?.time ?? m.matchtime ?? null,
      upcoming: false,
      hs, as,
    };
  }).filter(m => m.home && m.away);
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';
  const raw   = searchParams.get('raw') === '1';

  try {
    const seasonId = await findCurrentSeasonId();
    console.log(`[matches] seasonId: ${seasonId}`);

    // ?raw=1 → debug: mutasd meg mit tartalmaz a beágyazott JSON
    if (raw) {
      const embedded = await extractEmbeddedData(seasonId);
      return new Response(
        JSON.stringify({
          seasonId,
          htmlLength: embedded.htmlLength,
          hasFixtures: !!embedded.fixtures,
          hasResults: !!embedded.results,
          fixturesSample: JSON.stringify(embedded.fixtures)?.slice(0, 2000),
          resultsSample:  JSON.stringify(embedded.results)?.slice(0, 2000),
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Stratégia 1: Közvetlen gismo API hívás
    let upcoming = [], results = [];
    let strategy = 'unknown';

    try {
      const [fixturesJson, resultsJson] = await Promise.all([
        fetchFeed(seasonId, 'stats_season_fixtures'),
        fetchFeed(seasonId, 'stats_season_results'),
      ]);
      upcoming = parseFixtures(fixturesJson?.data ?? fixturesJson);
      results  = parseResults(resultsJson?.data ?? resultsJson);
      strategy = 'gismo-api';
      console.log(`[matches] gismo API: upcoming=${upcoming.length} results=${results.length}`);
    } catch (apiErr) {
      console.warn(`[matches] gismo API failed: ${apiErr.message}, trying embedded JSON`);

      // Stratégia 2: Beágyazott JSON kinyerése a page-ből
      try {
        const embedded = await extractEmbeddedData(seasonId);
        if (embedded.fixtures) upcoming = parseFixtures(embedded.fixtures);
        if (embedded.results)  results  = parseResults(embedded.results);
        strategy = 'embedded-json';
        console.log(`[matches] embedded JSON: upcoming=${upcoming.length} results=${results.length}`);
      } catch (embedErr) {
        console.error(`[matches] embedded JSON failed: ${embedErr.message}`);
        throw new Error(`Minden stratégia meghiúsult: ${apiErr.message} | ${embedErr.message}`);
      }
    }

    const upRounds = [...new Set(upcoming.map(m => m.round))].sort((a, b) => a - b);
    const nextRound = upRounds[0] ?? null;
    const nextFixtures = upcoming.filter(m => m.round === nextRound);

    const doneRounds = [...new Set(results.map(m => m.round))].sort((a, b) => b - a);
    const lastRound = doneRounds[0] ?? null;
    const recentResults = results.filter(m => doneRounds.slice(0, 3).includes(m.round));

    const payload = {
      nextFixtures,
      nextRound,
      recentResults,
      lastRound,
      seasonId,
      strategy,
      source: 'sportradar-json',
      totalUpcoming: upcoming.length,
      totalResults: results.length,
    };

    if (debug) {
      payload.allUpcoming = upcoming;
      payload.allResults = results.slice(0, 30);
    }

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[matches] Fatal error:', error.message);
    return new Response(
      JSON.stringify({
        nextFixtures: [],
        nextRound: null,
        recentResults: [],
        lastRound: null,
        error: error.message,
        seasonId: currentSeasonId,
      }),
      { status: 200, headers: corsHeaders }
    );
  }
}
