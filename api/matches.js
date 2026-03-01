// api/matches.js – Vercel Edge Function – FINAL VERSION

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
  'Cache-Control': 's-maxage=8, stale-while-revalidate=16',
};

// ── Season ID cache ──
let currentSeasonId = '3061347';
let lastSeasonCheck = 0;
const SEASON_CHECK_INTERVAL = 10000; // 10 másodperc

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
    lastSeasonCheck = now;
  }
  return currentSeasonId;
}

// ── HTML oldal lekérése ──
async function fetchHtml(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.text();
}

// ── Aktív forduló kinyerése a tab listából ──
// <li ... class="... active"><a ... aria-controls="subType-md-pane-21-12" ...>12</a>
function getActiveRound(html) {
  // Keressük az active tab-ot
  const activeMatch = html.match(/class="[^"]*\bactive\b[^"]*">\s*<a[^>]+aria-controls="subType-md-pane-21-(\d+)"/);
  if (activeMatch) return parseInt(activeMatch[1]);
  // Fallback: aria-selected="true"
  const selectedMatch = html.match(/aria-selected="true"[^>]*>(\d+)<\/a>/);
  if (selectedMatch) return parseInt(selectedMatch[1]);
  return null;
}

// ── Összes elérhető forduló kinyerése ──
function getAllRounds(html) {
  const rounds = [];
  const re = /aria-controls="subType-md-pane-21-(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    rounds.push(parseInt(m[1]));
  }
  return [...new Set(rounds)].sort((a, b) => a - b);
}

// ── Meccsek parse-olása a results/fixtures HTML-ből ──
// A struktúra (results oldal, te küldted):
//   <tr class="no-hover ..."><td ...>Forduló N</td></tr>  ← fejléc
//   <tr class="cursor-pointer">
//     <td ...><div><div>14:43</div></div></td>            ← idő
//     <td class="divide ...">
//       <div class="col-xs-5">
//         <div class="hidden-xs-up visible-sm-up wrap">Tottenham</div>  ← hazai
//       </div>
//       <div class="col-xs-2">-</div>
//       <div class="col-xs-5">
//         <div class="hidden-xs-up visible-sm-up wrap">Brighton</div>   ← vendég
//       </div>
//     </td>
//     <td ...>félide eredmény</td>
//     <td ...>RJ eredmény</td>   ← ez kell nekünk
//   </tr>
//
// Upcoming meccs: a score TD-ben csak "-" van (col-xs-2 tartalmaz "-")
// Lejátszott meccs: a score TD-kben számok vannak
function parseRoundHtml(html, round, isUpcoming) {
  const matches = [];
  const seen = new Set();

  // Split a cursor-pointer TR-ekre
  const parts = html.split('<tr class="cursor-pointer">');

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].split('</tr>')[0];

    // ── Csapatnevek ──
    const nameMatches = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]{2,60})\s*<\/div>/g)];
    if (nameMatches.length < 2) continue;
    const home = nameMatches[0][1].trim();
    const away = nameMatches[1][1].trim();
    if (!home || !away || home === away) continue;

    // ── Logo ID-k ──
    const logoMatches = [...chunk.matchAll(/\/medium\/(\d{4,7})\.png/g)];
    const logoIds = [];
    const seenIds = new Set();
    for (const m of logoMatches) {
      if (!seenIds.has(m[1])) { seenIds.add(m[1]); logoIds.push(m[1]); }
    }

    // ── Idő ──
    const timeM = chunk.match(/<div><div>(\d{1,2}:\d{2})<\/div><\/div>/);
    const time = timeM ? timeM[1] : null;

    // ── Eredmény (RJ = utolsó TD) ──
    // A chunk-ban több TD van: idő | meccs | félidő | RJ
    // A RJ eredmény az utolsó osztályban van: class="text-center mobile-width-5..."
    // Keressük a >N<sup></sup> mintázatot
    const allNums = [...chunk.matchAll(/>(\d+)<sup><\/sup>/g)].map(m => parseInt(m[1]));

    let hs = null, as = null;
    let detectedUpcoming = true;

    if (allNums.length >= 2) {
      // Az utolsó két szám a RJ eredmény (van félidő is előtte, az első 2)
      // Ha pontosan 2 szám van → csak RJ → hs, as
      // Ha 4 szám van → [ht_h, ht_a, rj_h, rj_a]
      if (allNums.length >= 4) {
        hs = allNums[allNums.length - 2];
        as = allNums[allNums.length - 1];
      } else {
        hs = allNums[0];
        as = allNums[1];
      }
      detectedUpcoming = false;
    }

    const actualUpcoming = isUpcoming !== null ? isUpcoming : detectedUpcoming;

    const key = [home, away].sort().join('|||');
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = { round, home, away, hid: logoIds[0] || null, aid: logoIds[1] || null, time };
    if (actualUpcoming) {
      matches.push({ ...entry, upcoming: true });
    } else {
      matches.push({ ...entry, upcoming: false, hs, as });
    }
  }

  return matches;
}

// ── HANDLER ──
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
    const seasonId = await findCurrentSeasonId();

    // ── 1. Fixtures főoldal lekérése → aktív forduló meghatározása ──
    const fixturesUrl = `${BASE_URL}/season/${seasonId}/fixtures`;
    const fixturesHtml = await fetchHtml(fixturesUrl);

    const activeRound = getActiveRound(fixturesHtml);
    const allRounds = getAllRounds(fixturesHtml);

    console.log(`[matches] seasonId=${seasonId} activeRound=${activeRound} allRounds=${allRounds.join(',')}`);

    if (!activeRound) throw new Error('Nem sikerült meghatározni az aktív fordulót');

    // ── 2. Aktív forduló meccseit a fixtures oldalból parse-oljuk ──
    // A fixtures oldalon már benne vannak az aktív forduló meccsek
    const nextFixtures = parseRoundHtml(fixturesHtml, activeRound, true);
    console.log(`[matches] nextFixtures from main page: ${nextFixtures.length}`);

    // Ha a főoldalon nincs elég, próbáljuk a round-specifikus URL-t
    let upcomingMatches = nextFixtures;
    if (upcomingMatches.length === 0) {
      try {
        const roundUrl = `${BASE_URL}/season/${seasonId}/fixtures/round/21-${activeRound}`;
        const roundHtml = await fetchHtml(roundUrl);
        upcomingMatches = parseRoundHtml(roundHtml, activeRound, true);
        console.log(`[matches] nextFixtures from round URL: ${upcomingMatches.length}`);
      } catch (e) {
        console.warn(`[matches] round URL failed: ${e.message}`);
      }
    }

    // ── 3. Előző fordulók eredményei (max 5 visszafelé) ──
    const recentResults = [];
    const pastRounds = [];
    for (let r = activeRound - 1; r >= Math.max(1, activeRound - 5); r--) {
      pastRounds.push(r);
    }

    await Promise.allSettled(
      pastRounds.map(async (r) => {
        try {
          const roundUrl = `${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`;
          const roundHtml = await fetchHtml(roundUrl);
          const matches = parseRoundHtml(roundHtml, r, false);
          recentResults.push(...matches);
          console.log(`[matches] round ${r}: ${matches.length} results`);
        } catch (e) {
          console.warn(`[matches] round ${r} failed: ${e.message}`);
        }
      })
    );

    // Rendezés forduló szerint (legújabb először)
    recentResults.sort((a, b) => b.round - a.round);

    // ── 4. Válasz összeállítása ──
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
