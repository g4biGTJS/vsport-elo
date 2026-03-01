// api/matches.js – Vercel Edge Function

export const config = { runtime: 'edge' };

const BASE_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
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
    // Try multiple patterns for seasonId
    const patterns = [
      /"currentseasonid"\s*:\s*(\d+)/,
      /currentSeasonId['"]\s*:\s*['"]?(\d+)/i,
      /season\/(\d+)\/fixtures/,
      /"seasonId"\s*:\s*(\d+)/i,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m?.[1]) {
        currentSeasonId = m[1];
        break;
      }
    }
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

/**
 * Comprehensive active round detection using many strategies.
 * Returns the active round number or null.
 */
function getActiveRound(html) {
  // Strategy 1: aria-selected="true" on a tab that contains a round number
  // Look for: aria-controls="subType-md-pane-21-N" with nearby aria-selected="true"
  // Find all tab items and check which has aria-selected=true
  const tabItemRegex = /<li[^>]*class="[^"]*"[^>]*>([\s\S]{0,500}?)<\/li>/g;
  let tabMatch;
  while ((tabMatch = tabItemRegex.exec(html)) !== null) {
    const li = tabMatch[0];
    if (/aria-selected="true"/.test(li) || /\bactive\b/.test(li)) {
      const roundInPane = li.match(/subType-md-pane-21-(\d+)/);
      if (roundInPane) return parseInt(roundInPane[1]);
      const roundInControl = li.match(/aria-controls="[^"]*-(\d+)"/);
      if (roundInControl) return parseInt(roundInControl[1]);
    }
  }

  // Strategy 2: active tab link with aria-controls
  const activeAnchor = html.match(/class="[^"]*\bactive\b[^"]*"[^>]*>[\s\S]{0,300}?aria-controls="subType-md-pane-21-(\d+)"/);
  if (activeAnchor) return parseInt(activeAnchor[1]);

  // Strategy 3: anchor with aria-selected=true, then find nearby pane id
  const selectedAnchorBlock = html.match(/aria-selected="true"[\s\S]{0,300}?subType-md-pane-21-(\d+)/);
  if (selectedAnchorBlock) return parseInt(selectedAnchorBlock[1]);

  // Strategy 4: reverse – pane id near aria-selected=true
  const paneNearSelected = html.match(/subType-md-pane-21-(\d+)[\s\S]{0,300}?aria-selected="true"/);
  if (paneNearSelected) return parseInt(paneNearSelected[1]);

  // Strategy 5: active class on anchor, look backward for pane
  const p5 = html.match(/aria-controls="subType-md-pane-21-(\d+)"[\s\S]{0,500}?class="[^"]*\bactive\b/);
  if (p5) return parseInt(p5[1]);

  // Strategy 6: find tab block (the whole nav/ul containing tabs) and find selected
  const tabNav = html.match(/<(?:ul|nav)[^>]*subType-md-tab[\s\S]{0,8000}?<\/(?:ul|nav)>/);
  if (tabNav) {
    const tabBlock = tabNav[0];
    // Find active/selected li
    const activeLiMatch = tabBlock.match(/<li[^>]*(?:active|aria-selected="true")[^>]*>[\s\S]{0,300}?<\/li>/);
    if (activeLiMatch) {
      const r = activeLiMatch[0].match(/subType-md-pane-21-(\d+)/);
      if (r) return parseInt(r[1]);
      const n = activeLiMatch[0].match(/>\s*(\d+)\s*</);
      if (n) return parseInt(n[1]);
    }
    // Fallback: last pane referenced (usually the current round)
    const allPanes = [...tabBlock.matchAll(/subType-md-pane-21-(\d+)/g)].map(m => parseInt(m[1]));
    if (allPanes.length > 0) {
      // The active tab is often the last one rendered as "active" or the highest number visible
      // Try to find selected state
      const selectedIdx = tabBlock.search(/aria-selected="true"/);
      if (selectedIdx >= 0) {
        // Find last pane reference before this position
        let lastPane = null;
        const paneRe = /subType-md-pane-21-(\d+)/g;
        let pm;
        while ((pm = paneRe.exec(tabBlock)) !== null) {
          if (pm.index < selectedIdx) lastPane = parseInt(pm[1]);
        }
        if (lastPane !== null) return lastPane;
      }
    }
  }

  // Strategy 7: look for pane div that is shown (not hidden), extract round
  // Active pane: <div ... id="subType-md-pane-21-N" ... class="... active ...">
  const activePaneDiv = html.match(/id="subType-md-pane-21-(\d+)"[^>]*class="[^"]*\bactive\b/);
  if (activePaneDiv) return parseInt(activePaneDiv[1]);
  const activePaneDiv2 = html.match(/class="[^"]*\bactive\b[^"]*"[^>]*id="subType-md-pane-21-(\d+)"/);
  if (activePaneDiv2) return parseInt(activePaneDiv2[1]);

  // Strategy 8: show class (Bootstrap tab-pane show active)
  const showActive = html.match(/id="subType-md-pane-21-(\d+)"[^>]*class="[^"]*\bshow\b/);
  if (showActive) return parseInt(showActive[1]);

  // Strategy 9: data-active or similar attributes
  const dataActive = html.match(/data-round="(\d+)"[^>]*(?:active|selected)/);
  if (dataActive) return parseInt(dataActive[1]);

  // Strategy 10: infer from URL or JSON data embedded in page
  const jsonRound = html.match(/"activeRound"\s*:\s*(\d+)/i);
  if (jsonRound) return parseInt(jsonRound[1]);
  const jsonRound2 = html.match(/"currentRound"\s*:\s*(\d+)/i);
  if (jsonRound2) return parseInt(jsonRound2[1]);
  const jsonRound3 = html.match(/"round"\s*:\s*(\d+)/i);
  if (jsonRound3) return parseInt(jsonRound3[1]);

  return null;
}

function getAllRounds(html) {
  const rounds = [];
  const re = /aria-controls="subType-md-pane-21-(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) rounds.push(parseInt(m[1]));
  // Also check pane IDs directly
  const re2 = /id="subType-md-pane-21-(\d+)"/g;
  while ((m = re2.exec(html)) !== null) rounds.push(parseInt(m[1]));
  const unique = [...new Set(rounds)].sort((a, b) => a - b);
  return unique;
}

/**
 * Smart fallback: if getActiveRound fails, determine active round by:
 * - Finding the highest round that has past results (scores present), plus 1
 * - Or finding the round whose pane contains upcoming matches (no scores)
 */
async function detectActiveRoundFromRounds(allRounds, seasonId) {
  if (allRounds.length === 0) return null;

  // Try rounds from highest to lowest, find last completed round, active = next
  for (let i = allRounds.length - 1; i >= 0; i--) {
    const r = allRounds[i];
    try {
      const html = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`);
      const matches = parseRoundHtml(html, r, null);
      const hasUpcoming = matches.some(m => m.upcoming);
      const hasResults = matches.some(m => !m.upcoming);
      if (hasUpcoming) return r; // This round has upcoming matches = active
      if (hasResults && i < allRounds.length - 1) return allRounds[i + 1]; // Next round
    } catch (e) {
      // skip
    }
  }
  // Default to last round
  return allRounds[allRounds.length - 1];
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

    // ?raw=1 → debug info about the HTML structure
    if (raw) {
      const tabIdx = fixturesHtml.indexOf('subType-md-tab');
      const snippetIdx = tabIdx >= 0 ? Math.max(0, tabIdx - 200) : 0;
      const tabSnippet = fixturesHtml.slice(snippetIdx, snippetIdx + 5000);
      const allPanes = [...fixturesHtml.matchAll(/subType-md-pane-21-(\d+)/g)].map(m => m[1]);
      const allSelected = [...fixturesHtml.matchAll(/aria-selected="([^"]+)"/g)].map(m => m[1]);
      const allActiveClasses = [...fixturesHtml.matchAll(/class="([^"]*active[^"]*)"/g)].map(m => m[1]);
      const detectedActive = getActiveRound(fixturesHtml);
      return new Response(JSON.stringify({
        seasonId,
        htmlLength: fixturesHtml.length,
        tabFound: tabIdx >= 0,
        allPaneRounds: allPanes,
        allAriaSelected: allSelected.slice(0, 20),
        allActiveClasses: allActiveClasses.slice(0, 15),
        detectedActiveRound: detectedActive,
        tabSnippet,
      }, null, 2), { status: 200, headers: corsHeaders });
    }

    let activeRound = getActiveRound(fixturesHtml);
    const allRounds = getAllRounds(fixturesHtml);
    console.log(`[matches] seasonId=${seasonId} activeRound=${activeRound} rounds=${allRounds.join(',')}`);

    // If active round detection failed, use smart fallback
    if (!activeRound) {
      console.warn('[matches] Primary active round detection failed, using smart fallback...');
      activeRound = await detectActiveRoundFromRounds(allRounds, seasonId);
    }

    if (!activeRound) {
      // Last resort: use highest available round
      if (allRounds.length > 0) {
        activeRound = allRounds[allRounds.length - 1];
        console.warn(`[matches] Using last resort: highest round ${activeRound}`);
      } else {
        throw new Error('Nem sikerült meghatározni az aktív fordulót és nincsenek elérhető fordulók');
      }
    }

    // Active round matches
    let upcomingMatches = parseRoundHtml(fixturesHtml, activeRound, true);
    if (upcomingMatches.length === 0) {
      try {
        const roundHtml = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${activeRound}`);
        upcomingMatches = parseRoundHtml(roundHtml, activeRound, true);
      } catch (e) { console.warn(`[matches] round URL failed: ${e.message}`); }
    }

    // Past rounds results
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

    if (debug) {
      payload.allRounds = allRounds;
      payload.activeRound = activeRound;
      payload.detectionMethod = 'multi-strategy';
    }

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[matches] Fatal:', error.message);
    return new Response(
      JSON.stringify({ nextFixtures: [], nextRound: null, recentResults: [], lastRound: null, error: error.message, seasonId: currentSeasonId }),
      { status: 200, headers: corsHeaders }
    );
  }
}
