// api/matches.js – Vercel Edge Function
// Szezon ID: azonos módszer mint standings.js
// Aktív forduló: közvetlen round URL-ek scan-elése (nem HTML tab-detektálás)

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

// ── Szezon ID cache – UGYANOLYAN mint standings.js ───────────────────────────
let currentSeasonId   = '3061347';
let lastCategoryCheck = 0;
const CHECK_INTERVAL  = 120_000;

async function findCurrentSeasonId() {
  const now = Date.now();
  if (now - lastCategoryCheck < CHECK_INTERVAL) return currentSeasonId;

  try {
    const res = await fetch(CATEGORY_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Elsődleges: pontos link + liga neve (standings.js-sel azonos)
    const linkRegex = new RegExp(
      `<a\\s+class="list-group-item"\\s+href="[^"]*/season/(\\d+)"[^>]*>\\s*<span\\s+class="vertical-align-middle">\\s*${LEAGUE_NAME}\\s*<\\/span>`,
      'i'
    );
    const match = html.match(linkRegex);
    if (match?.[1]) {
      currentSeasonId = match[1];
    } else {
      // Fallback: legnagyobb 7-jegyű season ID az oldalon
      const allIds = [...html.matchAll(/\/season\/(\d+)/g)]
        .map(m => parseInt(m[1]))
        .filter(n => n > 1_000_000);
      if (allIds.length > 0) currentSeasonId = String(Math.max(...allIds));
    }
  } catch (e) {
    console.error(`[SeasonCheck] ${e.message}`);
  }

  lastCategoryCheck = Date.now();
  return currentSeasonId;
}

// ── HTML fetch ────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Match parser ──────────────────────────────────────────────────────────────

function parseRoundHtml(html, round, forceUpcoming = false) {
  const matches = [];
  const seen    = new Set();
  const parts   = html.split('<tr class="cursor-pointer">');

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].split('</tr>')[0];

    const names = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]{2,60})\s*<\/div>/g)];
    if (names.length < 2) continue;
    const home = names[0][1].trim();
    const away = names[1][1].trim();
    if (!home || !away || home === away) continue;

    const logoIds = [...new Set([...chunk.matchAll(/\/medium\/(\d{4,7})\.png/g)].map(m => m[1]))];
    const timeM   = chunk.match(/<div><div>(\d{1,2}:\d{2})<\/div><\/div>/);
    const time    = timeM ? timeM[1] : null;

    const nums = [...chunk.matchAll(/>(\d+)<sup><\/sup>/g)].map(m => parseInt(m[1]));
    let hs = null, as = null, hasScore = false;
    if (nums.length >= 2) {
      hasScore = true;
      if (nums.length >= 4) { hs = nums[nums.length - 2]; as = nums[nums.length - 1]; }
      else                   { hs = nums[0]; as = nums[1]; }
    }

    const key = [home, away].sort().join('|||');
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = { round, home, away, hid: logoIds[0] ?? null, aid: logoIds[1] ?? null, time };
    if (!forceUpcoming && hasScore) matches.push({ ...entry, upcoming: false, hs, as });
    else                            matches.push({ ...entry, upcoming: true });
  }
  return matches;
}

// ── Aktív forduló meghatározása közvetlen round URL scan-nel ─────────────────
// A tab-detektálás nem megbízható React SPA-nál.
// Ehelyett: bináris kereséssel megtaláljuk az első fordulót ahol még nincs eredmény.

async function findActiveRoundByBinarySearch(seasonId) {
  // 1. lépés: megtudjuk hány forduló van (max 40 próba)
  // Párhuzamosan lekérjük az összes fordulót kisebb batch-ekben
  const MAX_ROUNDS = 40;
  const BATCH = 8;

  let lastKnownRound = 1;

  // Megkeressük a legmagasabb létező fordulót
  for (let start = 1; start <= MAX_ROUNDS; start += BATCH) {
    const end = Math.min(start + BATCH - 1, MAX_ROUNDS);
    const results = await Promise.allSettled(
      Array.from({ length: end - start + 1 }, (_, i) => {
        const r = start + i;
        return fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`)
          .then(html => ({ round: r, html }));
      })
    );
    let anyFound = false;
    for (const res of results) {
      if (res.status === 'fulfilled') {
        // Ha a HTML tartalmaz meccs sorokat, ez egy létező forduló
        if (res.value.html.includes('cursor-pointer')) {
          lastKnownRound = Math.max(lastKnownRound, res.value.round);
          anyFound = true;
        }
      }
    }
    // Ha az egész batch üres volt, már túl vagyunk a szezon végén
    if (!anyFound && start > 1) break;
  }

  console.log(`[matches] lastKnownRound=${lastKnownRound}`);

  // 2. lépés: lineárisan visszafelé keresve megtaláljuk az aktív fordulót
  // (az első ahol van upcoming = nincs eredmény, vagy az utolsó ahol van bármi)
  for (let r = lastKnownRound; r >= 1; r--) {
    try {
      const html    = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`);
      const matches = parseRoundHtml(html, r, false);
      if (matches.length === 0) continue;

      const hasUpcoming = matches.some(m => m.upcoming);
      const hasResults  = matches.some(m => !m.upcoming);

      // Ha van upcoming meccs: ez az aktív forduló
      if (hasUpcoming) return { activeRound: r, roundHtmlCache: { [r]: html } };

      // Ha csak eredmény van és volt felette forduló: az volt az aktív (de már lejátszódott)
      // Visszaadjuk ezt mint "legutóbbi", a következőt keressük majd
      if (hasResults) {
        // Ez már lezárult, az aktív a következő (ha létezik)
        const nextR = r + 1;
        if (nextR <= lastKnownRound) return { activeRound: nextR, roundHtmlCache: {} };
        return { activeRound: r, roundHtmlCache: { [r]: html } };
      }
    } catch (e) { /* skip */ }
  }

  return { activeRound: lastKnownRound, roundHtmlCache: {} };
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
    // 1. Szezon ID – standings.js-sel azonos logika
    const seasonId = await findCurrentSeasonId();
    console.log(`[matches] seasonId=${seasonId}`);

    // 2. Aktív forduló scan-nel (nem HTML tab-detektálással)
    const { activeRound, roundHtmlCache } = await findActiveRoundByBinarySearch(seasonId);
    console.log(`[matches] activeRound=${activeRound}`);

    if (!activeRound) throw new Error('Nem sikerült meghatározni az aktív fordulót');

    // 3. Aktív forduló meccsek (cache-ből ha már van, különben friss lekérés)
    let upcomingHtml = roundHtmlCache[activeRound];
    if (!upcomingHtml) {
      upcomingHtml = await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${activeRound}`);
    }
    const upcomingMatches = parseRoundHtml(upcomingHtml, activeRound, true);

    // 4. Elmúlt 5 forduló eredményei – párhuzamos lekérés
    const pastRoundNums = [];
    for (let r = activeRound - 1; r >= Math.max(1, activeRound - 5); r--) pastRoundNums.push(r);

    const recentResults = [];
    await Promise.allSettled(pastRoundNums.map(async r => {
      try {
        const html    = roundHtmlCache[r] ?? await fetchHtml(`${BASE_URL}/season/${seasonId}/fixtures/round/21-${r}`);
        const matches = parseRoundHtml(html, r, false);
        recentResults.push(...matches.filter(m => !m.upcoming));
      } catch (e) {
        console.warn(`[matches] round ${r} failed: ${e.message}`);
      }
    }));

    recentResults.sort((a, b) => b.round - a.round);

    const payload = {
      nextFixtures:  upcomingMatches,
      nextRound:     activeRound,
      recentResults,
      lastRound:     recentResults[0]?.round ?? null,
      seasonId,
      source:        'sportradar-html',
      totalUpcoming: upcomingMatches.length,
      totalResults:  recentResults.length,
    };

    if (debug) payload.activeRound = activeRound;

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[matches] Fatal:', error.message);
    return new Response(
      JSON.stringify({
        nextFixtures:  [],
        nextRound:     null,
        recentResults: [],
        lastRound:     null,
        error:         error.message,
        seasonId:      currentSeasonId,
      }),
      { status: 200, headers: corsHeaders }
    );
  }
}
