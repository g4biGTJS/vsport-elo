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

    // ?raw=1 → mutasd meg az összes feed kulcsot a beágyazott JSON-ból
    if (raw) {
      const url = `${BASE_URL}/season/${seasonId}`;
      const res = await fetch(url, {
        headers: { ...FETCH_HEADERS, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(12000),
      });
      const html = await res.text();

      // Keressük meg az összes "fetchedData" kulcsot
      const fetchedDataIdx = html.indexOf('"fetchedData"');
      const feedKeys = [];
      const feedKeyRegex = /"(stats_[^"]+|gismo_[^"]+|season_[^"]+|match[^"]+|fixture[^"]+|result[^"]+)":\s*\{/gi;
      let m;
      while ((m = feedKeyRegex.exec(html)) !== null) {
        feedKeys.push(m[1]);
        if (feedKeys.length > 50) break;
      }

      // Keressük meg a fetchedData block kezdetét és tárjuk fel a top-level kulcsokat
      const topKeys = [];
      if (fetchedDataIdx >= 0) {
        const blockStart = html.indexOf('{', fetchedDataIdx + 13);
        // Manuálisan keressük a közvetlen gyermek kulcsokat
        const topKeyRegex = /"([^"]{5,80})":\s*\{"event"/g;
        topKeyRegex.lastIndex = fetchedDataIdx;
        let tk;
        while ((tk = topKeyRegex.exec(html)) !== null) {
          topKeys.push(tk[1]);
          if (topKeys.length > 30) break;
        }
      }

      // Keressük az összes gismo URL-t is a HTML-ben
      const gismoUrls = [];
      const gismoRegex = /gismo\/([a-z_]+)\/(\d+)/gi;
      while ((m = gismoRegex.exec(html)) !== null) {
        const key = `${m[1]}/${m[2]}`;
        if (!gismoUrls.includes(key)) gismoUrls.push(key);
        if (gismoUrls.length > 30) break;
      }

      return new Response(
        JSON.stringify({
          seasonId,
          htmlLength: html.length,
          fetchedDataFound: fetchedDataIdx >= 0,
          topLevelFeedKeys: topKeys,
          allFeedKeys: feedKeys,
          gismoUrlsInPage: gismoUrls,
          // Mutassuk meg a fetchedData első 3000 karakterét
          fetchedDataSnippet: fetchedDataIdx >= 0
            ? html.slice(fetchedDataIdx, fetchedDataIdx + 3000)
            : 'NOT FOUND',
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Ha nem raw, próbáljuk a gismo API-t különböző feed nevekkel
    const feedsToTry = [
      'stats_season_fixtures',
      'stats_season_results',
      'stats_season_overview',
      'stats_season_matches',
      'stats_season_fixtures2',
      'stats_season_lastx',
      'stats_season_nextx',
    ];

    const results = {};
    for (const feed of feedsToTry) {
      try {
        const url = `https://s5.sir.sportradar.com/scigamingvirtuals/hu/gismo/${feed}/${seasonId}`;
        const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(5000) });
        results[feed] = { status: r.status, ok: r.ok };
        if (r.ok) {
          const json = await r.json();
          results[feed].keys = Object.keys(json?.data || json || {}).slice(0, 10);
          results[feed].sample = JSON.stringify(json).slice(0, 500);
        }
      } catch (e) {
        results[feed] = { error: e.message };
      }
    }

    return new Response(
      JSON.stringify({ seasonId, feedProbe: results }),
      { status: 200, headers: corsHeaders }
    );

  } catch (error) {
    console.error('[matches] Fatal:', error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 200, headers: corsHeaders }
    );
  }
}
