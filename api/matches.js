// api/matches.js – Vercel Edge Function
// Meccsek scrape-elése a sportradar season oldalról

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
// Season ID felderítés
// ─────────────────────────────────────────────────────────────
let currentSeasonId = '3061347';
let lastCategoryCheck = 0;
const CHECK_INTERVAL = 120000;

async function findCurrentSeasonId() {
  const now = Date.now();
  if (now - lastCategoryCheck < CHECK_INTERVAL) return currentSeasonId;
  try {
    const res = await fetch(CATEGORY_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const linkRegex = new RegExp(
      `<a\\s+class="list-group-item"\\s+href="[^"]*/season/(\\d+)"[^>]*>\\s*<span\\s+class="vertical-align-middle">\\s*${LEAGUE_NAME}\\s*<\\/span>`, 'i'
    );
    const match = html.match(linkRegex);
    if (match?.[1]) currentSeasonId = match[1];
    lastCategoryCheck = now;
  } catch (e) {
    console.error('[SeasonCheck]', e.message);
    lastCategoryCheck = now;
  }
  return currentSeasonId;
}

// ─────────────────────────────────────────────────────────────
// HTML Parser
// A sportradar season oldal struktúrája (a user által megadott HTML alapján):
//   <tr class="cursor-pointer">
//     <td class="text-center">
//       <span><div title="Virtuális...">VLLM</div><div title="">6</div></span>
//     </td>
//     <td class="divide text-center">
//       <div class="row">
//         <div class="col-xs-4"> ← HAZAI
//           <div class="hidden-xs-up visible-sm-up wrap">Liverpool</div>
//           <img src=".../medium/276507.png">
//         </div>
//         <div class="col-xs-4"> ← IDŐK/EREDMÉNY
//           <div class="text-center">14:06</div>
//           <div class="text-center"><div aria-label="Eredm.">
//             <div class="inline-block">-<sup></sup></div> : <div class="inline-block">-<sup></sup></div>
//           </div></div>
//         </div>
//         <div class="col-xs-4"> ← VENDÉG
//           <img src=".../medium/276501.png">
//           <div class="hidden-xs-up visible-sm-up wrap">Everton</div>
//         </div>
//       </div>
//     </td>
//   </tr>
// ─────────────────────────────────────────────────────────────
function parseMatches(html) {
  const upcoming = [];
  const results = [];
  const seen = new Set();
  function key(a, b) { return [a, b].sort().join('|||'); }

  // Split a cursor-pointer TR-ekre
  // A split karakter: '<tr class="cursor-pointer">'
  const parts = html.split('<tr class="cursor-pointer">');

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].split('</tr>')[0];
    if (!chunk.includes('VLLM')) continue;

    // ── Forduló szám ──
    // <div title="Virtuális Labdarúgás Liga Mód Retail">VLLM</div><div title="">6</div>
    let round = null;
    const r1 = chunk.match(/VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/);
    if (r1) round = parseInt(r1[1]);
    if (!round) {
      // Tágabb keresés
      const r2 = chunk.match(/VLLM[\s\S]{0,50}<div[^>]*>(\d+)<\/div>/);
      if (r2) round = parseInt(r2[1]);
    }
    if (!round || round < 1 || round > 9999) continue;

    // ── Csapatnevek ──
    // "hidden-xs-up visible-sm-up wrap" div → teljes csapatnév
    const nameMatches = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]{2,50})\s*<\/div>/g)];
    if (nameMatches.length < 2) continue;
    const home = nameMatches[0][1].trim();
    const away = nameMatches[1][1].trim();
    if (!home || !away) continue;

    // ── Logo ID-k ──
    const logoIds = [...new Set([...chunk.matchAll(/\/medium\/(\d{5,7})\.png/g)].map(m => m[1]))];

    // ── Idő ──
    const timeM = chunk.match(/<div class="text-center">(\d{1,2}:\d{2})<\/div>/);
    const time = timeM ? timeM[1] : null;

    // ── Upcoming vs Lejátszott ──
    // Upcoming: a score részben nincs szám, csak "-" jelek
    // Lejátszott: konkrét számok vannak a score részben
    //
    // A score blokk: aria-label="Eredm." div
    // Upcoming:   >-<sup></sup></div> ... >-<sup></sup>
    // Lejátszott: >2<sup></sup></div> ... >1<sup></sup>
    const scoreBlock = chunk.match(/aria-label="Eredm\."([\s\S]{0,600}?)(?=<\/div>\s*<\/div>\s*<\/div>)/);

    let isUpcoming = false;
    let hs = null, as = null;

    if (scoreBlock) {
      const sb = scoreBlock[1];
      // Számok keresése a sup-ok előtt
      const nums = [...sb.matchAll(/>(\d+)<sup>/g)].map(m => parseInt(m[1]));
      if (nums.length >= 2) {
        hs = nums[0];
        as = nums[1];
        isUpcoming = false;
      } else {
        // Nincs szám → upcoming
        isUpcoming = true;
      }
    } else {
      // Ha nincs scoreBlock → upcoming
      isUpcoming = true;
    }

    const k = key(home, away);
    if (seen.has(k)) continue;
    seen.add(k);

    const entry = { round, home, away, hid: logoIds[0]||null, aid: logoIds[1]||null, time };

    if (isUpcoming) {
      upcoming.push({ ...entry, upcoming: true });
    } else {
      results.push({ ...entry, upcoming: false, hs, as });
    }
  }

  // ── Fallback: ha a cursor-pointer split nem működött ──
  if (upcoming.length === 0 && results.length === 0 && html.includes('VLLM')) {
    console.log('[parser] cursor-pointer split yielded 0, trying generic TR split');
    return parseMatchesFallback(html);
  }

  return { upcoming, results };
}

function parseMatchesFallback(html) {
  const upcoming = [], results = [];
  const seen = new Set();
  function key(a, b) { return [a, b].sort().join('|||'); }

  // Minden TR-t megpróbálunk, nem csak cursor-pointer
  const parts = html.split(/<tr[\s>]/i);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].split(/<\/tr>/i)[0];
    if (!chunk.includes('VLLM')) continue;

    const r = chunk.match(/VLLM[\s\S]{0,100}>(\d+)<\/div>/);
    if (!r) continue;
    const round = parseInt(r[1]);
    if (!round || round < 1 || round > 9999) continue;

    const nameMatches = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]{2,50})\s*<\/div>/g)];
    if (nameMatches.length < 2) continue;
    const home = nameMatches[0][1].trim();
    const away = nameMatches[1][1].trim();

    const logoIds = [...new Set([...chunk.matchAll(/\/medium\/(\d{5,7})\.png/g)].map(m => m[1]))];
    const timeM = chunk.match(/<div class="text-center">(\d{1,2}:\d{2})<\/div>/);
    const time = timeM ? timeM[1] : null;

    const nums = [...chunk.matchAll(/>(\d+)<sup>/g)].map(m => parseInt(m[1]));
    const isUpcoming = nums.length < 2;

    const k = key(home, away);
    if (seen.has(k)) continue;
    seen.add(k);

    const entry = { round, home, away, hid: logoIds[0]||null, aid: logoIds[1]||null, time };
    if (isUpcoming) upcoming.push({ ...entry, upcoming: true });
    else results.push({ ...entry, upcoming: false, hs: nums[0], as: nums[1] });
  }

  return { upcoming, results };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';
  const raw   = searchParams.get('raw') === '1';

  try {
    const seasonId = await findCurrentSeasonId();
    const seasonUrl = `${BASE_URL}/season/${seasonId}`;
    console.log(`[matches] Fetching: ${seasonUrl}`);

    const res = await fetch(seasonUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const hasCursorPointer = html.includes('cursor-pointer');
    const hasVLLM = html.includes('VLLM');
    const trCount = (html.match(/<tr/gi) || []).length;

    console.log(`[matches] HTML ${html.length}ch, VLLM:${hasVLLM}, cursor-pointer:${hasCursorPointer}, TR:${trCount}`);

    // ?raw=1 → nyers diagnózis
    if (raw) {
      const vllmIdx = html.indexOf('VLLM');
      const snippet = vllmIdx >= 0
        ? html.slice(Math.max(0, vllmIdx - 300), vllmIdx + 4000)
        : html.slice(0, 4000);
      return new Response(
        JSON.stringify({ seasonId, htmlLength: html.length, hasVLLM, hasCursorPointer, trCount, snippet }),
        { status: 200, headers: corsHeaders }
      );
    }

    if (!hasVLLM) throw new Error(`VLLM nem található (${html.length} chars)`);

    const { upcoming, results } = parseMatches(html);
    console.log(`[matches] upcoming:${upcoming.length} results:${results.length}`);

    const upRounds = [...new Set(upcoming.map(m => m.round))].sort((a, b) => a - b);
    const nextRound = upRounds[0] ?? null;
    const nextFixtures = upcoming.filter(m => m.round === nextRound);
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
      payload.allUpcoming = upcoming;
      payload.allResults = results.slice(0, 20);
      payload.htmlStats = { length: html.length, hasVLLM, hasCursorPointer, trCount };
      const vllmIdx = html.indexOf('VLLM');
      if (vllmIdx >= 0) payload.vllmSnippet = html.slice(Math.max(0, vllmIdx - 200), vllmIdx + 3000);
    }

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[matches] Error:', error.message);
    return new Response(
      JSON.stringify({ nextFixtures: [], nextRound: null, recentResults: [], lastRound: null, error: error.message }),
      { status: 200, headers: corsHeaders }
    );
  }
}
