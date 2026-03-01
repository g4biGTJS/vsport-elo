// api/matches.js – Vercel Edge Function – DIAGNOSTIC v4

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
  'Cache-Control': 'no-store',
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

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') ?? 'probe';

  try {
    const seasonId = await findCurrentSeasonId();

    // ── MODE: probe ──
    // Próbáljuk meg a különböző sportradar JSON API végpontokat
    if (mode === 'probe') {
      const endpoints = [
        // Ismert gismo endpointok virtual sports-hoz
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_fixtures/${seasonId}`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_results/${seasonId}`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_fixtures2/${seasonId}`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_matches/${seasonId}`,
        // Round-based
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_round_matchlist/${seasonId}`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_matchlist/${seasonId}`,
        // Tournament-based (tid=56369 a leagueSummaryból)
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_fixtures/56369`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_season_results/56369`,
        // Fixtures a season page-ről más path-szal
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/${seasonId}/fixtures`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/${seasonId}/results`,
        // Egy ismert matchid alapján (1398008817 a formtable-ből)
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_match_get/1398008817`,
      ];

      const results = {};
      await Promise.allSettled(
        endpoints.map(async (url) => {
          const key = url.replace('https://s5.sir.sportradar.com/scigamingvirtuals/hu/', '');
          try {
            const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(5000) });
            results[key] = { status: r.status };
            if (r.ok) {
              const text = await r.text();
              results[key].length = text.length;
              results[key].sample = text.slice(0, 400);
            }
          } catch (e) {
            results[key] = { error: e.message };
          }
        })
      );

      return new Response(JSON.stringify({ seasonId, mode: 'probe', results }, null, 2), {
        status: 200, headers: corsHeaders,
      });
    }

    // ── MODE: matchid ──
    // Egy konkrét meccs adatainak lekérése (matchid a formtable-ből)
    if (mode === 'matchid') {
      const matchId = searchParams.get('id') ?? '1398008817';
      const urls = [
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_match_get/${matchId}`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/stats_match_info/${matchId}`,
        `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/match_infopage/${matchId}`,
      ];
      const results = {};
      for (const url of urls) {
        const key = url.split('/gismo/')[1];
        try {
          const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(5000) });
          results[key] = { status: r.status };
          if (r.ok) {
            const text = await r.text();
            results[key].length = text.length;
            results[key].sample = text.slice(0, 800);
          }
        } catch (e) {
          results[key] = { error: e.message };
        }
      }
      return new Response(JSON.stringify({ matchId, results }, null, 2), {
        status: 200, headers: corsHeaders,
      });
    }

    // ── MODE: formtable ──
    // A formtable-ből kinyert matchidek listája
    if (mode === 'formtable') {
      const pageRes = await fetch(`${BASE_URL}/season/${seasonId}`, {
        headers: { ...FETCH_HEADERS, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(12000),
      });
      const html = await pageRes.text();
      const matchIds = [...new Set([...html.matchAll(/"matchid"\s*:\s*(\d{9,12})/g)].map(m => m[1]))];
      return new Response(JSON.stringify({ seasonId, matchIdCount: matchIds.length, matchIds: matchIds.slice(0, 30) }), {
        status: 200, headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ error: 'Ismeretlen mode. Használj: ?mode=probe, ?mode=matchid, ?mode=formtable' }), {
      status: 400, headers: corsHeaders,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 200, headers: corsHeaders });
  }
}
