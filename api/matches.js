// api/matches.js – Vercel Edge Function
// Meccsek scrape-elése a sportradar season oldalról
// Ugyanazt a season ID felderítést használja mint standings.js

export const config = { runtime: 'edge' };

const BASE_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;
const LEAGUE_NAME = 'Virtuális Labdarúgás Liga Mód Retail';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
};

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 's-maxage=8, stale-while-revalidate=16',
};

// ─────────────────────────────────────────────────────────────
// Season ID felderítés (azonos logika mint standings.js-ben)
// ─────────────────────────────────────────────────────────────
let currentSeasonId = '3061057';
let lastCategoryCheck = 0;
const CHECK_INTERVAL = 120000;

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

    const linkRegex = new RegExp(
      `<a\\s+class="list-group-item"\\s+href="[^"]*/season/(\\d+)"[^>]*>\\s*<span\\s+class="vertical-align-middle">\\s*${LEAGUE_NAME}\\s*<\\/span>`,
      'i'
    );
    const match = html.match(linkRegex);
    if (match?.[1]) currentSeasonId = match[1];
    lastCategoryCheck = now;
  } catch (e) {
    console.error('[SeasonCheck] Error:', e.message);
    lastCategoryCheck = now;
  }
  return currentSeasonId;
}

// ─────────────────────────────────────────────────────────────
// HTML Parser – a sportradar season oldal meccstábláját dolgozza fel
// A tényleges struktúra (a user által megadott HTML alapján):
//
// <tr>
//   <td> VLLM + forduló szám </td>
//   <td>
//     <div class="col-xs-4"> hazai csapat neve + logo </div>
//     <div class="col-xs-4"> idő + eredmény (- : - vagy 2:1) </div>
//     <div class="col-xs-4"> vendég csapat neve + logo </div>
//   </td>
// </tr>
// ─────────────────────────────────────────────────────────────
function parseMatches(html) {
  const upcoming = [];
  const results = [];
  const seen = new Set();

  function matchKey(a, b) { return [a, b].sort().join('|||'); }

  // Minden TR-t megragadunk ami VLLM-et tartalmaz
  const trParts = html.split(/<tr[\s>]/i);

  for (let i = 1; i < trParts.length; i++) {
    const trContent = trParts[i].split(/<\/tr>/i)[0];
    if (!trContent.includes('VLLM')) continue;

    // Forduló szám: a VLLM div után lévő szám
    const roundMatch = trContent.match(/VLLM[\s\S]{0,200}?<div[^>]*>(\d+)<\/div>/);
    if (!roundMatch) continue;
    const round = parseInt(roundMatch[1]);
    if (isNaN(round) || round < 1 || round > 9999) continue;

    // Hazai csapat neve: hidden-xs-up visible-sm-up wrap osztályú div-ben
    // Az első ilyen div a hazai, a második a vendég
    const teamNameMatches = [...trContent.matchAll(/class="hidden-xs-up visible-sm-up wrap">([^<]{2,30})<\/div>/g)];
    if (teamNameMatches.length < 2) continue;

    const home = teamNameMatches[0][1].trim();
    const away = teamNameMatches[1][1].trim();
    if (!home || !away) continue;

    // Logo ID-k: /medium/XXXXXX.png mintából
    const logoMatches = [...trContent.matchAll(/\/medium\/(\d{5,7})\.png/g)];
    const logoIds = [];
    for (const m of logoMatches) {
      if (!logoIds.includes(m[1])) logoIds.push(m[1]);
    }

    // Idő: HH:MM formátum az "aria-label" közelében vagy önállóan
    const timeMatch = trContent.match(/<div class="text-center">(\d{1,2}:\d{2})<\/div>/);
    const time = timeMatch ? timeMatch[1] : null;

    // Eredmény detektálás: 
    // Upcoming: aria-label="Eredm." után "- : -" pattern
    // Played: aria-label="Eredm." után számok
    const resultSection = trContent.match(/aria-label="Eredm\."[\s\S]{0,300}?<\/div>\s*<\/div>\s*<\/div>/);
    let isDash = false;
    let scoreMatch = null;

    if (resultSection) {
      const rs = resultSection[0];
      // Dash check: csak kötőjel van számok nélkül
      const stripped = rs.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      isDash = /^-\s*:\s*-$/.test(stripped.replace(/.*Eredm\.\s*/, '').trim()) ||
               stripped.includes('- : -') ||
               (stripped.match(/-/g) || []).length >= 2 && !(stripped.match(/\d+\s*:\s*\d+/));
      scoreMatch = stripped.match(/(\d+)\s*:\s*(\d+)/);
    } else {
      // Fallback: nincs eredmény section → upcoming
      isDash = true;
    }

    const key = matchKey(home, away);
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = {
      round,
      home,
      away,
      hid: logoIds[0] || null,
      aid: logoIds[1] || null,
      time,
    };

    if (scoreMatch && !isDash) {
      results.push({
        ...entry,
        upcoming: false,
        hs: parseInt(scoreMatch[1]),
        as: parseInt(scoreMatch[2]),
      });
    } else {
      upcoming.push({ ...entry, upcoming: true });
    }
  }

  return { upcoming, results };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  try {
    // 1. Lekérjük az aktuális season ID-t
    const seasonId = await findCurrentSeasonId();
    const seasonUrl = `${BASE_URL}/season/${seasonId}`;

    console.log(`[matches] Fetching season page: ${seasonUrl}`);

    // 2. Letöltjük a season oldalt
    const res = await fetch(seasonUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${seasonUrl}`);
    }

    const html = await res.text();
    console.log(`[matches] HTML length: ${html.length}, has VLLM: ${html.includes('VLLM')}`);

    if (!html.includes('VLLM')) {
      throw new Error('Nem található VLLM tartalom az oldalon');
    }

    // 3. Parsoljuk a meccseket
    const { upcoming, results } = parseMatches(html);
    console.log(`[matches] Parsed: ${upcoming.length} upcoming, ${results.length} results`);

    // 4. Következő forduló meghatározása
    const upRounds = [...new Set(upcoming.map(m => m.round))].sort((a, b) => a - b);
    const nextRound = upRounds[0] ?? null;
    const nextFixtures = upcoming.filter(m => m.round === nextRound);

    // Utolsó befejezett fordulók
    const doneRounds = [...new Set(results.map(m => m.round))].sort((a, b) => b - a);
    const recentResults = results.filter(m => doneRounds.slice(0, 3).includes(m.round));

    const payload = {
      nextFixtures,
      nextRound,
      recentResults,
      lastRound: doneRounds[0] ?? null,
      seasonId,
      source: 'sportradar-scrape',
      totalUpcoming: upcoming.length,
      totalResults: results.length,
    };

    if (debug) {
      payload.htmlSnippet = html.slice(0, 3000);
      payload.allUpcoming = upcoming;
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: corsHeaders,
    });

  } catch (error) {
    console.error('[matches] Error:', error.message);
    return new Response(
      JSON.stringify({
        nextFixtures: [],
        nextRound: null,
        recentResults: [],
        lastRound: null,
        error: error.message,
        source: 'error',
      }),
      { status: 200, headers: corsHeaders }
    );
  }
}
