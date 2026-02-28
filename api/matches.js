// api/matches.js – Vercel Edge Function
// Scrape-eli a sportradar Premier Liga season oldalát
// Parser a valódi HTML struktúra alapján tesztelve

export const config = { runtime: 'edge' };

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
};

// Próbálandó URL-ek sorban
const URLS_TO_TRY = [
  'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057',
  'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/fixtures',
  'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/results',
  'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/schedule',
];

// ─────────────────────────────────────────────────────────────────
// PARSER – a valódi HTML struktúra alapján (tesztelve ✓)
//
// Minden meccs egy <tr class="cursor-pointer"> sorban van.
// - Round:  >VLLM</div><div title="">21</div>
// - Teams:  class="hidden-xs-up visible-sm-up wrap">Brighton</div>  (2db)
// - Logos:  src="...medium/276511.png"  (2db, sorrendben)
// - Time:   <div class="text-center">20:26</div>
// - Score:  aria-label="Eredm." -> inline-block divek
//           Eredmény: <div class="inline-block...">0<sup> → szám
//           Következő: <div class="inline-block...">-<sup> → dash
// ─────────────────────────────────────────────────────────────────
function parseOneRow(row) {
  // Forduló szám
  const roundM = row.match(/>VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/);
  if (!roundM) return null;
  const round = parseInt(roundM[1]);
  if (isNaN(round) || round < 1 || round > 99) return null;

  // Csapatnevek
  const names = [...row.matchAll(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/g)]
    .map(m => m[1].trim());
  if (names.length < 2) return null;
  const [home, away] = names;

  // Logo ID-k (sorrend = hazai, vendég)
  const logoIds = [];
  for (const m of row.matchAll(/src="https:\/\/vgls\.betradar\.com\/ls\/s5_crest\/scigamingvirtuals\/medium\/(\d+)\.png"/g)) {
    if (!logoIds.includes(m[1])) logoIds.push(m[1]);
  }

  // Idő
  const timeM = row.match(/<div class="text-center">\s*(\d{1,2}:\d{2})\s*<\/div>/);
  const time = timeM ? timeM[1] : null;

  // Eredmény szekció
  const scoreM = row.match(/aria-label="Eredm\."([\s\S]*?)<\/div><\/div><\/div>/);
  if (!scoreM) return null;
  const sec = scoreM[1];

  const dashes = [...sec.matchAll(/<div class="inline-block[^"]*">\s*-\s*<sup>/g)];
  const nums   = [...sec.matchAll(/<div class="inline-block[^"]*">\s*(\d+)\s*<sup>/g)].map(m => parseInt(m[1]));

  if (dashes.length >= 2) {
    return { round, home, away, hid: logoIds[0]||null, aid: logoIds[1]||null, time, upcoming: true };
  } else if (nums.length >= 2) {
    return { round, home, away, hid: logoIds[0]||null, aid: logoIds[1]||null, time, upcoming: false, hs: nums[0], as: nums[1] };
  }
  return null;
}

function parseMatches(html) {
  const results  = [];
  const upcoming = [];
  const parts = html.split('<tr class="cursor-pointer">');

  for (let i = 1; i < parts.length; i++) {
    const row = parts[i].split('</tr>')[0];
    const match = parseOneRow(row);
    if (!match) continue;
    (match.upcoming ? upcoming : results).push(match);
  }

  return { results, upcoming };
}

// ─────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=20, stale-while-revalidate=40',
  };

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  let lastError = null;

  for (const url of URLS_TO_TRY) {
    try {
      const res = await fetch(url, {
        headers: { ...FETCH_HEADERS, 'Referer': 'https://s5.sir.sportradar.com/' },
        signal: AbortSignal.timeout(9000),
      });

      if (!res.ok) { lastError = `HTTP ${res.status} @ ${url}`; continue; }

      const html = await res.text();

      if (!html.includes('cursor-pointer') || !html.includes('VLLM')) {
        lastError = `No match data in response (len=${html.length}) @ ${url}`;
        if (debug) {
          return new Response(JSON.stringify({ error: lastError, htmlLen: html.length, htmlStart: html.slice(0,2000) }), { status:200, headers: corsHeaders });
        }
        continue;
      }

      const { results, upcoming } = parseMatches(html);

      if (debug) {
        return new Response(JSON.stringify({
          usedUrl: url, totalResults: results.length, totalUpcoming: upcoming.length,
          results: results.slice(0,8), upcoming: upcoming.slice(0,8),
          htmlLen: html.length,
          snippet: html.slice(html.indexOf('cursor-pointer'), html.indexOf('cursor-pointer') + 3000),
        }), { status:200, headers: corsHeaders });
      }

      if (results.length === 0 && upcoming.length === 0) {
        lastError = `Parsed 0 matches @ ${url}`; continue;
      }

      // Utolsó 3 forduló + következő forduló
      const rounds = [...new Set(results.map(m => m.round))].sort((a,b) => b-a);
      const lastRounds = rounds.slice(0, 3);
      const recentResults = results.filter(m => lastRounds.includes(m.round));

      const upRounds = [...new Set(upcoming.map(m => m.round))].sort((a,b) => a-b);
      const nextRound = upRounds[0] ?? null;
      const nextFixtures = upcoming.filter(m => m.round === nextRound);

      return new Response(JSON.stringify({
        recentResults, nextFixtures, nextRound,
        lastRound: lastRounds[0] ?? null,
        source: 'scrape', usedUrl: url,
      }), { status:200, headers: corsHeaders });

    } catch (err) {
      lastError = `${err.message} @ ${url}`;
    }
  }

  return new Response(JSON.stringify({
    error: lastError, recentResults: [], nextFixtures: [],
    nextRound: null, lastRound: null, source: 'error',
  }), { status:200, headers: corsHeaders });
}
