// api/matches.js – Vercel Edge Function
// Ugyanazt a szezon-felderítési logikát használja mint a standings.js

export const config = { runtime: 'edge' };

const BASE_URL     = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;
const LEAGUE_NAME  = 'Virtuális Labdarúgás Liga Mód Retail';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
};

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

// ── Szezon ID cache (ugyanúgy mint standings.js-ben) ─────────────────────────
let currentSeasonId   = '3061347';
let lastCategoryCheck = 0;
const CHECK_INTERVAL  = 120_000; // 2 perc

async function findCurrentSeasonId() {
  const now = Date.now();
  if (now - lastCategoryCheck < CHECK_INTERVAL) return currentSeasonId;

  try {
    console.log(`[SeasonCheck] Checking ${CATEGORY_URL}`);
    const res = await fetch(CATEGORY_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();

    // Ugyanaz a regex mint standings.js-ben: megkeresi a liga linkjét a kategória oldalon
    const linkRegex = new RegExp(
      `<a\\s+class="list-group-item"\\s+href="[^"]*/season/(\\d+)"[^>]*>\\s*<span\\s+class="vertical-align-middle">\\s*${LEAGUE_NAME}\\s*<\\/span>`,
      'i'
    );
    const match = html.match(linkRegex);

    if (match?.[1]) {
      const newId = match[1];
      if (newId !== currentSeasonId) {
        console.log(`[SeasonCheck] Season ID: ${currentSeasonId} → ${newId}`);
        currentSeasonId = newId;
      }
    } else {
      // Fallback regex-ek ha a HTML struktúra kicsit eltér
      const fallbacks = [
        // Bármilyen /season/XXXXXX link ami közelében van a liga neve
        new RegExp(`href="[^"]*/season/(\\d+)"[^>]*>[\\s\\S]{0,200}?${LEAGUE_NAME}`, 'i'),
        // Fordítva: liga neve majd link
        new RegExp(`${LEAGUE_NAME}[\\s\\S]{0,200}?href="[^"]*/season/(\\d+)"`, 'i'),
        // Csak az összes season link közül a legnagyobb ID (legújabb szezon)
        /href="[^"]*\/season\/(\d+)"/g,
      ];

      let found = false;
      for (let i = 0; i < 2; i++) {
        const fm = html.match(fallbacks[i]);
        if (fm?.[1]) {
          console.log(`[SeasonCheck] Fallback ${i + 1} found ID: ${fm[1]}`);
          currentSeasonId = fm[1];
          found = true;
          break;
        }
      }

      if (!found) {
        // Ha semmi sem működött, vegyük a legnagyobb season ID-t az oldalon
        const allIds = [...html.matchAll(/\/season\/(\d+)/g)]
          .map(m => parseInt(m[1]))
          .filter(n => n > 1_000_000); // sportradar ID-k általában 7 jegyűek
        if (allIds.length > 0) {
          const maxId = String(Math.max(...allIds));
          console.log(`[SeasonCheck] Using max season ID found: ${maxId}`);
          currentSeasonId = maxId;
        } else {
          console.warn(`[SeasonCheck] No season ID found, keeping: ${currentSeasonId}`);
        }
      }
    }
  } catch (e) {
    console.error(`[SeasonCheck] Error: ${e.message}. Keeping: ${currentSeasonId}`);
  }

  lastCategoryCheck = Date.now();
  return currentSeasonId;
}

// ── HTML fetch ────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.text();
}

// ── Aktív forduló keresése ────────────────────────────────────────────────────

function getActiveRound(html) {
  // 1. <li> elemek bejárása, active vagy aria-selected=true bennük
  const liRe = /<li[^>]*>([\s\S]{0,600}?)<\/li>/g;
  let liM;
  while ((liM = liRe.exec(html)) !== null) {
    const li = liM[0];
    if (!/active|aria-selected="true"/.test(li)) continue;
    const r = li.match(/subType-md-pane-21-(\d+)/);
    if (r) return parseInt(r[1]);
    const r2 = li.match(/aria-controls="[^"]*-(\d+)"/);
    if (r2) return parseInt(r2[1]);
  }
  // 2. aria-selected=true közelében lévő pane ID
  const s1 = html.match(/aria-selected="true"[\s\S]{0,400}?subType-md-pane-21-(\d+)/);
  if (s1) return parseInt(s1[1]);
  const s2 = html.match(/subType-md-pane-21-(\d+)[\s\S]{0,400}?aria-selected="true"/);
  if (s2) return parseInt(s2[1]);
  // 3. Aktív pane div (Bootstrap tab-pane active / show)
  const p1 = html.match(/id="subType-md-pane-21-(\d+)"[^>]*class="[^"]*(?:active|show)\b/);
  if (p1) return parseInt(p1[1]);
  const p2 = html.match(/class="[^"]*(?:active|show)\b[^"]*"[^>]*id="subType-md-pane-21-(\d+)"/);
  if (p2) return parseInt(p2[1]);
  // 4. active class + aria-controls kombináció
  const p3 = html.match(/class="[^"]*\bactive\b[^"]*"[^>]*>[\s\S]{0,300}?aria-controls="subType-md-pane-21-(\d+)"/);
  if (p3) return parseInt(p3[1]);
  // 5. JSON adat az oldalban
  for (const key of ['"activeRound"', '"currentRound"', '"round"']) {
    const jr = html.match(new RegExp(key + '\\s*:\\s*(\\d+)'));
    if (jr) return parseInt(jr[1]);
  }
  return null;
}

function getAllRounds(html) {
  const re1 = /aria-controls="subType-md-pane-21-(\d+)"/g;
  const re2 = /id="subType-md-pane-21-(\d+)"/g;
  const nums = [];
  let m;
  while ((m = re1.exec(html)) !== null) nums.push(parseInt(m[1]));
  while ((m = re2.exec(html)) !== null) nums.push(parseInt(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}

// ── Match parser (eredeti logika megőrzve) ────────────────────────────────────

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
    const time  = timeM ? timeM[1] : null;

    const allNums = [...chunk.matchAll(/>(\d+)<sup><\/sup>/g)].map(m => parseInt(m[1]));
    let hs = null, as = null, detectedUpcoming = true;
    if (allNums.length >= 2) {
      if (allNums.length >= 4) { hs = allNums[allNums.length - 2]; as = allNums[allNums.length - 1]; }
      else                     { hs = allNums[0]; as = allNums[1]; }
      detectedUpcoming = false;
    }

    const actualUpcoming = isUpcoming !== null ? isUpcoming : detectedUpcoming;
    const key = [home, away].sort().join('|||');
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = { round, home, away, hid: logoIds[0] ?? null, aid: logoIds[1] ?? null, time };
    if (actualUpcoming) matches.push({ ...entry, upcoming: true });
    else                matches.push({ ...entry, upcoming: false, hs, as });
  }
  return matches;
}

// ── Smart fallback: fordulók scan-elése ha az aktív nem detektálható ──────────

async function detectActiveRoundByScan(allRounds, seasonId) {
  if (!allRounds.length) return null;
  // Legmagasabbtól lefele: az első ahol még van upcoming meccs
  for (let i = allRounds.length - 1; i >= 0; i--) {
    const r = allRounds[i];
    try {
      const html    = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`);
      const matches = parseRoundHtml(html, r, null);
      if (matches.some(m => m.upcoming))  return r;
      if (matches.some(m => !m.upcoming) && i < allRounds.length - 1) return allRounds[i + 1];
    } catch (e) { /* skip */ }
  }
  return allRounds[allRounds.length - 1];
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
  const raw   = searchParams.get('raw')   === '1';

  try {
    // ── 1. Szezon ID (standings.js-sel azonos módszer) ──
    const seasonId = await findCurrentSeasonId();
    console.log(`[matches] seasonId=${seasonId}`);

    const fixturesUrl  = `${BASE_URL}/season/${seasonId}/fixtures`;
    const fixturesHtml = await fetchHtml(fixturesUrl);

    // ?raw=1 → debug
    if (raw) {
      const tabIdx = fixturesHtml.indexOf('subType-md-tab');
      const allPanes    = [...fixturesHtml.matchAll(/subType-md-pane-21-(\d+)/g)].map(m => m[1]);
      const allSelected = [...fixturesHtml.matchAll(/aria-selected="([^"]+)"/g)].map(m => m[1]);
      const allActive   = [...fixturesHtml.matchAll(/class="([^"]*active[^"]*)"/g)].map(m => m[1]);
      const snippetIdx  = tabIdx >= 0 ? Math.max(0, tabIdx - 200) : 0;
      return new Response(JSON.stringify({
        seasonId,
        htmlLength: fixturesHtml.length,
        tabFound: tabIdx >= 0,
        allPaneRounds: allPanes,
        allAriaSelected: allSelected.slice(0, 20),
        allActiveClasses: allActive.slice(0, 15),
        detectedActiveRound: getActiveRound(fixturesHtml),
        tabSnippet: fixturesHtml.slice(snippetIdx, snippetIdx + 4000),
      }, null, 2), { status: 200, headers: corsHeaders });
    }

    // ── 2. Aktív forduló detektálás ──
    let activeRound = getActiveRound(fixturesHtml);
    const allRounds = getAllRounds(fixturesHtml);
    console.log(`[matches] activeRound=${activeRound} allRounds=${allRounds.join(',')}`);

    if (!activeRound && allRounds.length > 0) {
      console.warn('[matches] Aktív forduló nem detektálható, smart scan indul...');
      activeRound = await detectActiveRoundByScan(allRounds, seasonId);
    }

    if (!activeRound && allRounds.length > 0) {
      activeRound = allRounds[allRounds.length - 1];
      console.warn(`[matches] Last resort: ${activeRound}`);
    }

    if (!activeRound) throw new Error('Nem sikerült meghatározni az aktív fordulót');

    // ── 3. Aktív forduló meccsek ──
    let upcomingMatches = parseRoundHtml(fixturesHtml, activeRound, true);
    if (upcomingMatches.length === 0) {
      try {
        const roundHtml = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${activeRound}`);
        upcomingMatches = parseRoundHtml(roundHtml, activeRound, true);
      } catch (e) {
        console.warn(`[matches] round URL failed: ${e.message}`);
      }
    }

    // ── 4. Elmúlt 5 forduló eredményei ──
    const recentResults = [];
    const pastRounds    = [];
    for (let r = activeRound - 1; r >= Math.max(1, activeRound - 5); r--) pastRounds.push(r);

    await Promise.allSettled(pastRounds.map(async r => {
      try {
        const roundHtml = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`);
        recentResults.push(...parseRoundHtml(roundHtml, r, false));
      } catch (e) {
        console.warn(`[matches] round ${r} failed: ${e.message}`);
      }
    }));

    recentResults.sort((a, b) => b.round - a.round);

    const payload = {
      nextFixtures: upcomingMatches,
      nextRound: activeRound,
      recentResults,
      lastRound:    recentResults[0]?.round ?? null,
      seasonId,
      source: 'sportradar-html',
      totalUpcoming: upcomingMatches.length,
      totalResults:  recentResults.length,
    };

    if (debug) {
      payload.allRounds   = allRounds;
      payload.activeRound = activeRound;
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
        seasonId: currentSeasonId,
      }),
      { status: 200, headers: corsHeaders }
    );
  }
}
