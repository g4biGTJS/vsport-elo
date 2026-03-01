// api/matches.js – Vercel Edge Function

export const config = { runtime: 'edge' };

const BASE_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
};

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

let currentSeasonId = '3061347';
let lastSeasonCheck = 0;
const SEASON_CHECK_INTERVAL = 10000;

async function findCurrentSeasonId() {
  const now = Date.now();
  if (now - lastSeasonCheck < SEASON_CHECK_INTERVAL) return currentSeasonId;
  try {
    const res = await fetch(CATEGORY_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/"currentseasonid"\s*:\s*(\d+)/);
    if (m?.[1]) currentSeasonId = m[1];
    lastSeasonCheck = now;
  } catch (e) {
    console.error('[SeasonCheck]', e.message);
    lastSeasonCheck = Date.now();
  }
  return currentSeasonId;
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.text();
}

function getActiveRound(html) {
  // Try all known patterns
  // Pattern 1: class="... active ..."><a ... aria-controls="subType-md-pane-21-12"
  const p1 = html.match(/class="[^"]*\bactive\b[^"]*"[^>]*>\s*<a[^>]+aria-controls="subType-md-pane-21-(\d+)"/);
  if (p1) return parseInt(p1[1]);

  // Pattern 2: aria-selected="true" href="#">12</a>
  const p2 = html.match(/aria-selected="true"[^>]*>\s*(\d+)\s*<\/a>/);
  if (p2) return parseInt(p2[1]);

  // Pattern 3: active li with subType tab
  const p3 = html.match(/subType-md-pane-21-(\d+)[^"]*"\s+aria-selected="true"/);
  if (p3) return parseInt(p3[1]);

  // Pattern 4: find "active" near subType tabs
  const tabBlock = html.match(/subType-md-tab[\s\S]{0,5000}?aria-selected="true"/);
  if (tabBlock) {
    const n = tabBlock[0].match(/subType-md-pane-21-(\d+)/g);
    if (n && n.length > 0) {
      const last = n[n.length - 1].match(/(\d+)$/);
      if (last) return parseInt(last[1]);
    }
  }

  return null;
}

function getAllRounds(html) {
  const rounds = [];
  const re = /aria-controls="subType-md-pane-21-(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) rounds.push(parseInt(m[1]));
  return [...new Set(rounds)].sort((a, b) => a - b);
}

function parseRoundHtml(html, round, isUpcoming) {
  const matches = [];
  const seen = new Set();
  const parts = html.split('<tr class="cursor-pointer">');
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].split('</tr>')[0];
    const nameMatches = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]{2,60})\s*<\/div>/g)];
    if (nameMatches.length < 2) continue;
    const home = nameMatches[0][1].trim();
    const away = nameMatches[1][1].trim();
    if (!home || !away || home === away) continue;
    const logoMatches = [...chunk.matchAll(/\/medium\/(\d{4,7})\.png/g)];
    const logoIds = [...new Set(logoMatches.map(m => m[1]))];
    const timeM = chunk.match(/<div><div>(\d{1,2}:\d{2})<\/div><\/div>/);
    const time = timeM ? timeM[1] : null;
    const allNums = [...chunk.matchAll(/>(\d+)<sup><\/sup>/g)].map(m => parseInt(m[1]));
    let hs = null, as = null, detectedUpcoming = true;
    if (allNums.length >= 2) {
      if (allNums.length >= 4) { hs = allNums[allNums.length - 2]; as = allNums[allNums.length - 1]; }
      else { hs = allNums[0]; as = allNums[1]; }
      detectedUpcoming = false;
    }
    const actualUpcoming = isUpcoming !== null ? isUpcoming : detectedUpcoming;
    const key = [home, away].sort().join('|||');
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { round, home, away, hid: logoIds[0] || null, aid: logoIds[1] || null, time };
    if (actualUpcoming) matches.push({ ...entry, upcoming: true });
    else matches.push({ ...entry, upcoming: false, hs, as });
  }
  return matches;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';
  const raw   = searchParams.get('raw') === '1';

  try {
    const seasonId = await findCurrentSeasonId();
    const fixturesUrl = `${BASE_URL}/season/${seasonId}/fixtures`;
    const fixturesHtml = await fetchHtml(fixturesUrl);

    // ?raw=1 → mutasd meg a tab lista HTML-t
    if (raw) {
      // Keressük a subType-md tab blokkot
      const tabIdx = fixturesHtml.indexOf('subType-md-tab');
      const activeIdx = fixturesHtml.indexOf('active');
      const ariaIdx = fixturesHtml.indexOf('aria-selected="true"');

      // Vegyük ki a tab lista körüli 3000 karaktert
      const snippetIdx = tabIdx >= 0 ? Math.max(0, tabIdx - 200) : 0;
      const tabSnippet = fixturesHtml.slice(snippetIdx, snippetIdx + 3000);

      // Összes subType-md-pane referencia
      const allPanes = [...fixturesHtml.matchAll(/subType-md-pane-21-(\d+)/g)].map(m => m[1]);
      const allSelected = [...fixturesHtml.matchAll(/aria-selected="([^"]+)"/g)].map(m => m[1]);
      const allActive = [...fixturesHtml.matchAll(/class="([^"]*active[^"]*)"/g)].map(m => m[1]);

      return new Response(JSON.stringify({
        seasonId,
        htmlLength: fixturesHtml.length,
        tabFound: tabIdx >= 0,
        activeFound: activeIdx >= 0,
        ariaSelectedFound: ariaIdx >= 0,
        allPaneRounds: allPanes,
        allAriaSelected: allSelected.slice(0, 20),
        allActiveClasses: allActive.slice(0, 10),
        tabSnippet,
      }, null, 2), { status: 200, headers: corsHeaders });
    }

    const activeRound = getActiveRound(fixturesHtml);
    const allRounds = getAllRounds(fixturesHtml);
    console.log(`[matches] seasonId=${seasonId} activeRound=${activeRound} rounds=${allRounds.join(',')}`);

    if (!activeRound) throw new Error('Nem sikerült meghatározni az aktív fordulót');

    // Aktív forduló meccsek
    let upcomingMatches = parseRoundHtml(fixturesHtml, activeRound, true);
    if (upcomingMatches.length === 0) {
      try {
        const roundHtml = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${activeRound}`);
        upcomingMatches = parseRoundHtml(roundHtml, activeRound, true);
      } catch (e) { console.warn(`[matches] round URL failed: ${e.message}`); }
    }

    // Előző fordulók eredményei
    const recentResults = [];
    const pastRounds = [];
    for (let r = activeRound - 1; r >= Math.max(1, activeRound - 5); r--) pastRounds.push(r);

    await Promise.allSettled(pastRounds.map(async (r) => {
      try {
        const roundHtml = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`);
        recentResults.push(...parseRoundHtml(roundHtml, r, false));
      } catch (e) { console.warn(`[matches] round ${r} failed: ${e.message}`); }
    }));

    recentResults.sort((a, b) => b.round - a.round);

    const payload = {
      nextFixtures: upcomingMatches,
      nextRound: activeRound,
      recentResults,
      lastRound: recentResults[0]?.round ?? null,
      seasonId,
      source: 'sportradar-html',
      totalUpcoming: upcomingMatches.length,
      totalResults: recentResults.length,
    };

    if (debug) { payload.allRounds = allRounds; payload.activeRound = activeRound; }

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[matches] Fatal:', error.message);
    return new Response(
      JSON.stringify({ nextFixtures: [], nextRound: null, recentResults: [], lastRound: null, error: error.message, seasonId: currentSeasonId }),
      { status: 200, headers: corsHeaders }
    );
  }
}
