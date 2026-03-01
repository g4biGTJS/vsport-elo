// api/matches.js – Vercel Edge Function

export const config = { runtime: 'edge' };

const BASE_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;

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
// JSON blob kinyerése egy adott kulcshoz a HTML-ből
// Pl: extractJsonBlock(html, '"fixtures"') → { ... }
// ─────────────────────────────────────────────────────────────
function extractJsonBlock(html, key) {
  const searchStr = `"${key}":`;
  const idx = html.indexOf(searchStr);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx + searchStr.length);
  if (start < 0) {
    // Esetleg array
    const arrStart = html.indexOf('[', idx + searchStr.length);
    if (arrStart < 0) return null;
    return extractArray(html, arrStart);
  }
  return extractObject(html, start);
}

function extractObject(html, start) {
  let depth = 0;
  for (let i = start; i < Math.min(start + 2000000, html.length); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function extractArray(html, start) {
  let depth = 0;
  for (let i = start; i < Math.min(start + 2000000, html.length); i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Match kinyerés – sportradar match objektumokból
// ─────────────────────────────────────────────────────────────
function extractTeamName(team) {
  return team?.name ?? team?.mediumname ?? team?.abbr ?? null;
}

function extractTeamUid(team) {
  return String(team?.uid ?? team?._id ?? '');
}

function parseMatchArray(arr, forceUpcoming = null) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const m of arr) {
    const home = extractTeamName(m.homeTeam ?? m.hometeam ?? m.home ?? m.teams?.home);
    const away = extractTeamName(m.awayTeam ?? m.awayteam ?? m.away ?? m.teams?.away);
    if (!home || !away) continue;

    const hid = extractTeamUid(m.homeTeam ?? m.hometeam ?? m.home ?? m.teams?.home);
    const aid = extractTeamUid(m.awayTeam ?? m.awayteam ?? m.away ?? m.teams?.away);
    const round = m._round ?? m.round ?? m.roundid ?? null;
    const time = m.time?.time ?? m.time?.date ?? m.matchtime ?? null;

    // Eredmény
    const hs = m.result?.home ?? m.homeScore ?? m.score?.home ?? null;
    const as = m.result?.away ?? m.awayScore ?? m.score?.away ?? null;
    const hasScore = hs !== null && as !== null && hs !== undefined && as !== undefined;

    const isUpcoming = forceUpcoming !== null ? forceUpcoming : !hasScore;

    const entry = { round, home, away, hid, aid, time };
    if (isUpcoming) out.push({ ...entry, upcoming: true });
    else out.push({ ...entry, upcoming: false, hs, as });
  }
  return out;
}

function parseFromData(data, forceUpcoming = null) {
  if (!data) return [];
  // Különböző lehetséges struktúrák
  if (Array.isArray(data)) return parseMatchArray(data, forceUpcoming);
  if (Array.isArray(data.matches)) return parseMatchArray(data.matches, forceUpcoming);
  if (Array.isArray(data.fixtures)) return parseMatchArray(data.fixtures, forceUpcoming);
  if (Array.isArray(data.results)) return parseMatchArray(data.results, forceUpcoming);
  if (Array.isArray(data.events)) return parseMatchArray(data.events, forceUpcoming);
  // Objektum aminek numerikus kulcsai vannak (pl {0: {...}, 1: {...}})
  const vals = Object.values(data);
  if (vals.length > 0 && typeof vals[0] === 'object' && (vals[0]?.homeTeam || vals[0]?.hometeam || vals[0]?.home)) {
    return parseMatchArray(vals, forceUpcoming);
  }
  return [];
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
    const seasonUrl = `${BASE_URL}/season/${seasonId}`;

    const pageRes = await fetch(seasonUrl, {
      headers: { ...FETCH_HEADERS, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(12000),
    });
    if (!pageRes.ok) throw new Error(`Season page HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    // ?raw=1 → debug: minden "fixtures" és "matches" blokk tartalmát mutasd
    if (raw) {
      const fixturesBlock = extractJsonBlock(html, 'fixtures');
      const matchesBlock  = extractJsonBlock(html, 'matches');
      const leagueSummary = extractJsonBlock(html, 'stats_season_leaguesummary/' + seasonId + '/main');
      return new Response(JSON.stringify({
        seasonId,
        htmlLength: html.length,
        fixturesSample:     JSON.stringify(fixturesBlock)?.slice(0, 3000),
        matchesSample:      JSON.stringify(matchesBlock)?.slice(0, 3000),
        leagueSummarySample: JSON.stringify(leagueSummary)?.slice(0, 3000),
      }), { status: 200, headers: corsHeaders });
    }

    // ── Adatok kinyerése ──
    // stats_season_leaguesummary tartalmaz fixtures + results-t
    const leagueSummaryKey = `stats_season_leaguesummary/${seasonId}/main`;
    const summaryBlock = extractJsonBlock(html, leagueSummaryKey);

    let upcoming = [];
    let results  = [];

    if (summaryBlock) {
      // A leaguesummary data-ban van fixtures és results
      const data = summaryBlock?.data ?? summaryBlock;
      upcoming = parseFromData(data?.fixtures ?? data?.nextmatches, true);
      results  = parseFromData(data?.results  ?? data?.lastmatches, false);
      console.log(`[matches] leaguesummary: upcoming=${upcoming.length} results=${results.length}`);
    }

    // Ha nincs elég adat, próbáljuk a "fixtures" és "matches" kulcsokat
    if (upcoming.length === 0) {
      const fixturesBlock = extractJsonBlock(html, 'fixtures');
      if (fixturesBlock) {
        upcoming = parseFromData(fixturesBlock, true);
        console.log(`[matches] fixtures block: upcoming=${upcoming.length}`);
      }
    }

    if (results.length === 0) {
      const matchesBlock = extractJsonBlock(html, 'matches');
      if (matchesBlock) {
        results = parseFromData(matchesBlock, false);
        console.log(`[matches] matches block: results=${results.length}`);
      }
    }

    if (upcoming.length === 0 && results.length === 0) {
      throw new Error('Nem sikerült meccseket kinyerni a JSON-ból');
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
    console.error('[matches] Fatal:', error.message);
    return new Response(
      JSON.stringify({
        nextFixtures: [], nextRound: null,
        recentResults: [], lastRound: null,
        error: error.message, seasonId: currentSeasonId,
      }),
      { status: 200, headers: corsHeaders }
    );
  }
}
