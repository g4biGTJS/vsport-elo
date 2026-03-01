// api/matches.js – Vercel Edge Function
// Sportradar SIR widget belső JSON API-t hív, nem HTML-t scrape-el
// (a widget React SPA, statikus HTML-ből semmi adat nem olvasható)

export const config = { runtime: 'edge' };

const CLIENT   = 'scigamingvirtuals';
const LANG     = 'hu';
const SPORT_ID = 1;
const CAT_ID   = 1111;

// Sportradar belső widget backend API-k
const DATA_API = `https://cp.fn.sportradar.com/common/${LANG}/Intl/gismo`;
const LS_API   = `https://ls.sir.sportradar.com/${CLIENT}/${LANG}/${SPORT_ID}`;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Origin': 'https://s5.sir.sportradar.com',
  'Referer': 'https://s5.sir.sportradar.com/',
};

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.json();
}

async function tryFetchJson(url) {
  try { return await fetchJson(url); }
  catch (e) { console.warn(`[tryFetch] ${e.message}`); return null; }
}

// Deep get helper: tryGet(obj, 'a.b.c') === obj?.a?.b?.c
function tryGet(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

// ── Season detection ─────────────────────────────────────────────────────────

async function getCurrentSeasonId() {
  const attempts = [
    // cp.fn gismo – tournament_seasons
    async () => {
      const d = await tryFetchJson(`${DATA_API}/tournament_seasons/${CAT_ID}`);
      return tryGet(d, 'doc.0.data.tournament.currentseason.id')
          ?? tryGet(d, 'doc.0.data.currentseason.id');
    },
    // ls.sir – category endpoint
    async () => {
      const d = await tryFetchJson(`${LS_API}/category/${CAT_ID}`);
      return tryGet(d, 'doc.0.data.tournament.currentseason.id')
          ?? tryGet(d, 'doc.0.data.currentseason.id');
    },
    // cp.fn gismo – config_tree_mini
    async () => {
      const d = await tryFetchJson(`${DATA_API}/config_tree_mini/1/${CAT_ID}`);
      const items = Object.values(tryGet(d, 'doc.0.data') ?? {});
      for (const item of items) {
        const id = item?.currentseason?.id ?? item?.tournament?.currentseason?.id;
        if (id) return id;
      }
      return null;
    },
    // ls.sir – season list
    async () => {
      const d = await tryFetchJson(`${LS_API}/seasons/${CAT_ID}`);
      const seasons = tryGet(d, 'doc.0.data.seasons') ?? [];
      // Legfrissebb szezon (legnagyobb ID vagy is_current flag)
      const current = seasons.find(s => s.is_current) ?? seasons.at(-1);
      return current?.id ?? null;
    },
  ];

  for (const attempt of attempts) {
    try {
      const id = await attempt();
      if (id) {
        console.log(`[season] found: ${id}`);
        return String(id);
      }
    } catch (e) {
      console.warn(`[season attempt] ${e.message}`);
    }
  }

  throw new Error('Nem sikerült meghatározni az aktuális szezon ID-t');
}

// ── Match parsing from gismo response ────────────────────────────────────────

function normalizeMatch(ev, round) {
  const home = ev.home?.name ?? ev.hometeam?.name ?? ev.teams?.home?.name ?? null;
  const away = ev.away?.name ?? ev.awayteam?.name ?? ev.teams?.away?.name ?? null;
  if (!home || !away) return null;

  const hid  = String(ev.home?.id ?? ev.hometeam?.id ?? '');
  const aid  = String(ev.away?.id ?? ev.awayteam?.id ?? '');
  const time = ev.time ?? ev.starttime ?? ev.scheduled ?? null;
  const status = String(ev.status ?? ev._status ?? '').toLowerCase();
  const isFinished = ['closed', 'ended', 'finished', 'complete', '4', '5'].includes(status);
  const hs = ev.result?.home ?? ev.homegoals ?? ev.score?.home ?? null;
  const as_ = ev.result?.away ?? ev.awaygoals ?? ev.score?.away ?? null;

  return {
    round: parseInt(round),
    home, away, hid, aid, time,
    upcoming: !isFinished,
    ...(isFinished && hs != null ? { hs: parseInt(hs), as: parseInt(as_) } : {}),
  };
}

function parseGismoEvents(data, filterRound = null) {
  const events = data?.events ?? data?.matches ?? data?.fixtures ?? data?.sport_events ?? [];
  const rounds = {};

  for (const ev of events) {
    const round = ev.roundnum ?? ev.round?.id ?? ev._roundnum ?? filterRound;
    if (round == null) continue;
    const match = normalizeMatch(ev, round);
    if (!match) continue;
    if (!rounds[round]) rounds[round] = [];
    rounds[round].push(match);
  }
  return rounds;
}

// ── Fetch all rounds for a season ────────────────────────────────────────────

async function fetchAllRounds(seasonId) {
  const endpoints = [
    `${DATA_API}/fixtures_tournament/${seasonId}`,
    `${LS_API}/season/${seasonId}/fixtures`,
    `${DATA_API}/tournament_fixtures/${seasonId}`,
    `${DATA_API}/season_fixtures/${seasonId}`,
  ];

  for (const url of endpoints) {
    const data = await tryFetchJson(url);
    if (!data) continue;
    const docData = tryGet(data, 'doc.0.data') ?? data?.data ?? data;
    const rounds = parseGismoEvents(docData);
    if (Object.keys(rounds).length > 0) {
      console.log(`[fixtures] got ${Object.keys(rounds).length} rounds from ${url}`);
      return rounds;
    }
  }
  return null;
}

// ── Fetch specific round ──────────────────────────────────────────────────────

async function fetchRound(seasonId, round) {
  const endpoints = [
    `${DATA_API}/fixtures_tournament_round/${seasonId}/${round}`,
    `${LS_API}/season/${seasonId}/fixtures/round/21-${round}`,
    `${DATA_API}/tournament_round_fixtures/${seasonId}/${round}`,
  ];

  for (const url of endpoints) {
    const data = await tryFetchJson(url);
    if (!data) continue;
    const docData = tryGet(data, 'doc.0.data') ?? data?.data ?? data;
    const rounds = parseGismoEvents(docData, round);
    if (rounds[round]?.length > 0) return rounds[round];
  }
  return [];
}

// ── Active round detection ────────────────────────────────────────────────────

function detectActiveRound(rounds) {
  const nums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;

  // Első forduló ahol van upcoming meccs
  for (const r of nums) {
    if (rounds[r].some(m => m.upcoming)) return r;
  }

  // Ha minden lezárt: utolsó
  return nums[nums.length - 1];
}

// ── Smart round scan fallback ─────────────────────────────────────────────────

async function scanRoundsForActive(seasonId, maxRound = 40) {
  const found = {};

  // Párhuzamosan kéri le az összes fordulót
  const results = await Promise.allSettled(
    Array.from({ length: maxRound }, (_, i) => fetchRound(seasonId, i + 1))
  );

  results.forEach((res, idx) => {
    if (res.status === 'fulfilled' && res.value.length > 0) {
      found[idx + 1] = res.value;
    }
  });

  return found;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  try {
    const seasonId = await getCurrentSeasonId();
    console.log(`[matches] seasonId=${seasonId}`);

    // 1. Próbáljuk az egész szezon adatot egyszerre
    let allRounds = await fetchAllRounds(seasonId);

    // 2. Ha nem sikerült, egyenként kérdezzük le
    if (!allRounds || Object.keys(allRounds).length === 0) {
      console.warn('[matches] Egész szezon nem elérhető, fordulók scan-elése...');
      allRounds = await scanRoundsForActive(seasonId, 40);
    }

    if (!allRounds || Object.keys(allRounds).length === 0) {
      throw new Error('Nincs elérhető mérkőzés adat');
    }

    const activeRound = detectActiveRound(allRounds);
    const roundNums = Object.keys(allRounds).map(Number).sort((a, b) => a - b);

    // Következő (aktív) forduló meccsek
    let upcomingMatches = activeRound
      ? (allRounds[activeRound] ?? []).filter(m => m.upcoming)
      : [];

    // Ha az aktív fordulóban nincs upcoming (pl. mind lejátszott), megmutatjuk mind
    if (upcomingMatches.length === 0 && activeRound) {
      upcomingMatches = allRounds[activeRound] ?? [];
    }

    // Elmúlt 5 lezárt forduló
    const pastRounds = roundNums
      .filter(r => r < (activeRound ?? Infinity))
      .slice(-5)
      .reverse();

    const recentResults = pastRounds.flatMap(r =>
      (allRounds[r] ?? []).filter(m => !m.upcoming)
    );

    const payload = {
      nextFixtures: upcomingMatches,
      nextRound: activeRound,
      recentResults,
      lastRound: recentResults[0]?.round ?? null,
      seasonId,
      source: 'sportradar-json-api',
      totalUpcoming: upcomingMatches.length,
      totalResults: recentResults.length,
    };

    if (debug) {
      payload.allRounds = roundNums;
      payload.dataApiBase = DATA_API;
      payload.lsApiBase = LS_API;
    }

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[matches] Fatal:', error.message);
    return new Response(
      JSON.stringify({
        nextFixtures: [],
        nextRound: null,
        recentResults: [],
        lastRound: null,
        error: error.message,
      }),
      { status: 200, headers: corsHeaders }
    );
  }
}
