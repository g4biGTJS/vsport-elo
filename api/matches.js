// api/matches.js – Vercel Edge Function
// 
// Forrás: https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057
// Ez az oldal SSR HTML-t ad vissza ami tartalmazza:
//   - az utolsó forduló 5(+) meccsének eredményeit
//   - a következő forduló 5(+) meccsét (- : - eredménnyel)
//
// FONTOS: A szerver Accept header alapján dönt:
//   Accept: text/html -> 264KB SSR HTML (tartalmazza a meccseket) ✓
//   Accept: */*, application/json -> 565KB JS bundle ✗
//
// A meccssorok: <tr class="cursor-pointer">
// Forduló: >VLLM</div><div title="">21</div>
// Csapat:  class="hidden-xs-up visible-sm-up wrap">Brighton</div>
// Eredmény: aria-label="Eredm." -> inline-block divek (szám VAGY dash)

export const config = { runtime: 'edge' };

const SEASON_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057';

// Pontosan a böngésző által küldött headereket utánozzuk
// text/html ELSŐ helyen -> SSR HTML-t kapunk vissza
const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://s5.sir.sportradar.com/',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// ─── PARSER (tesztelve a valódi HTML-en ✓) ───────────────────────
// Bemenet: egy <tr class="cursor-pointer"> sor tartalma
// Kimenet: meccs objektum vagy null
function parseOneRow(row) {
  // Forduló szám: >VLLM</div><div title="">21</div>
  const roundM = row.match(/>VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/);
  if (!roundM) return null;
  const round = parseInt(roundM[1]);
  if (isNaN(round) || round < 1 || round > 99) return null;

  // Csapatnevek: class="hidden-xs-up visible-sm-up wrap">Brighton</div>
  const names = [...row.matchAll(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/g)]
    .map(m => m[1].trim());
  if (names.length < 2) return null;

  // Logo ID-k: srcset="...medium/276511.png..." vagy src="...medium/276511.png"
  // (az img src-ben nincs https://, de a srcset-ben van – mindkettőt keressük)
  const logoIds = [];
  for (const m of row.matchAll(/\/medium\/(\d{6})\.png/g)) {
    if (!logoIds.includes(m[1])) logoIds.push(m[1]);
  }

  // Mérkőzés ideje
  const timeM = row.match(/<div class="text-center">\s*(\d{1,2}:\d{2})\s*<\/div>/);

  // Eredmény: aria-label="Eredm." szekció
  const scoreM = row.match(/aria-label="Eredm\."([\s\S]*?)<\/div><\/div><\/div>/);
  if (!scoreM) return null;
  const sec = scoreM[1];

  // Dash = következő meccs, szám = lejátszott meccs
  const dashes = [...sec.matchAll(/<div class="inline-block[^"]*">\s*-\s*<sup>/g)];
  const nums   = [...sec.matchAll(/<div class="inline-block[^"]*">\s*(\d+)\s*<sup>/g)]
    .map(m => parseInt(m[1]));

  const base = {
    round,
    home: names[0],
    away: names[1],
    hid:  logoIds[0] || null,
    aid:  logoIds[1] || null,
    time: timeM ? timeM[1] : null,
  };

  if (dashes.length >= 2) return { ...base, upcoming: true };
  if (nums.length >= 2)   return { ...base, upcoming: false, hs: nums[0], as: nums[1] };
  return null;
}

function parseMatches(html) {
  const results = [], upcoming = [];
  const parts = html.split('<tr class="cursor-pointer">');
  for (let i = 1; i < parts.length; i++) {
    const m = parseOneRow(parts[i].split('</tr>')[0]);
    if (m) (m.upcoming ? upcoming : results).push(m);
  }
  return { results, upcoming };
}

// ─── HANDLER ──────────────────────────────────────────────────────
export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=20, stale-while-revalidate=40',
  };

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  try {
    const res = await fetch(SEASON_URL, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return new Response(JSON.stringify({
        error: `HTTP ${res.status}`,
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    const html = await res.text();
    const htmlLen = html.length;
    const hasVLLM = html.includes('VLLM');
    const hasCursorTR = html.includes('<tr class="cursor-pointer">');

    if (debug) {
      const { results, upcoming } = parseMatches(html);
      return new Response(JSON.stringify({
        htmlLen, hasVLLM, hasCursorTR,
        totalResults: results.length,
        totalUpcoming: upcoming.length,
        results,
        upcoming,
        // HTML snippet a cursor-pointer TR körül (nem CSS!)
        snippet: hasCursorTR
          ? html.slice(html.indexOf('<tr class="cursor-pointer">'), html.indexOf('<tr class="cursor-pointer">') + 3000)
          : html.slice(0, 2000),
      }), { status: 200, headers: corsHeaders });
    }

    if (!hasVLLM || !hasCursorTR) {
      // Valószínűleg JS bundle-t kaptunk, nem SSR HTML-t
      return new Response(JSON.stringify({
        error: `Got JS bundle instead of HTML (len=${htmlLen}, hasVLLM=${hasVLLM}, hasCursorTR=${hasCursorTR})`,
        hint: 'Server returned JS bundle. Try accessing /api/matches?debug=1 to inspect.',
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    const { results, upcoming } = parseMatches(html);

    if (results.length === 0 && upcoming.length === 0) {
      return new Response(JSON.stringify({
        error: `Parsed 0 matches (htmlLen=${htmlLen})`,
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    // Utolsó 3 forduló eredményei (legújabbtól visszafelé)
    const rounds = [...new Set(results.map(m => m.round))].sort((a, b) => b - a);
    const lastRounds = rounds.slice(0, 3);
    const recentResults = results.filter(m => lastRounds.includes(m.round));

    // Következő forduló
    const upRounds = [...new Set(upcoming.map(m => m.round))].sort((a, b) => a - b);
    const nextRound = upRounds[0] ?? null;
    const nextFixtures = upcoming.filter(m => m.round === nextRound);

    return new Response(JSON.stringify({
      recentResults,
      nextFixtures,
      nextRound,
      lastRound: lastRounds[0] ?? null,
      source: 'scrape',
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message,
      recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
    }), { status: 200, headers: corsHeaders });
  }
}
