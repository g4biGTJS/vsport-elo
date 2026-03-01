// api/matches.js – Vercel Edge Function
// Javított parser: kezeli a tényleges HTML struktúrát

export const config = { runtime: 'edge' };

const SEASON_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061176';

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

// ─── HELPER: logo ID kinyerése URL-ből ───────────────────────────
function extractLogoIds(chunk) {
  const ids = [];
  for (const m of chunk.matchAll(/\/medium\/(\d{5,7})\.png/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// ─── HELPER: csapatnevek kinyerése ───────────────────────────────
function extractTeamNames(chunk) {
  // Elsődleges: teljes név (visible-sm-up)
  const names = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]+?)\s*<\/div>/g)]
    .map(m => m[1].trim()).filter(Boolean);
  if (names.length >= 2) return names;

  // Fallback: rövidített név (hidden-sm-up)
  const short = [...chunk.matchAll(/class="hidden-sm-up wrap">\s*([^<]+?)\s*<\/div>/g)]
    .map(m => m[1].trim()).filter(Boolean);
  return short;
}

// ─── HELPER: eredmény parse ───────────────────────────────────────
// Visszaad: { upcoming: true } VAGY { upcoming: false, hs, as }
function parseScore(chunk) {
  const scoreSection = chunk.match(/aria-label="Eredm\."([\s\S]*?)(?:<\/div>\s*){3}/);
  const section = scoreSection ? scoreSection[1] : chunk;

  // Dash = upcoming
  const dashCount = (section.match(/<div class="inline-block[^"]*">\s*-\s*<sup>/g) || []).length;
  if (dashCount >= 2) return { upcoming: true };

  // Számok = eredmény
  const nums = [...section.matchAll(/<div class="inline-block[^"]*">\s*(\d+)\s*<sup>/g)]
    .map(m => parseInt(m[1]));
  if (nums.length >= 2) return { upcoming: false, hs: nums[0], as: nums[1] };

  return null;
}

// ─── HELPER: idő kinyerése ────────────────────────────────────────
function parseTime(chunk) {
  const m = chunk.match(/<div class="text-center">\s*(\d{1,2}:\d{2})\s*<\/div>/);
  return m ? m[1] : null;
}

// ─── PARSER STRATÉGIA 1: TR alapú (eredeti) ───────────────────────
function parseByTR(html) {
  const results = [], upcoming = [];

  // Forduló szám keresése a sorban – többféle minta
  const roundPatterns = [
    />VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/,           // eredeti
    /title="VLLM"[^>]*>\s*(\d+)\s*</,                   // title attribútum
    />VLLM\s*(\d+)</,                                     // közvetlen
    /data-roundnumber="(\d+)"/,                           // data attribútum
    /round[^"]*"[^>]*>(\d+)<\/div>/i,                    // általános round
  ];

  const parts = html.split('<tr class="cursor-pointer">');
  for (let i = 1; i < parts.length; i++) {
    const row = parts[i].split('</tr>')[0];

    let round = null;
    for (const pat of roundPatterns) {
      const m = row.match(pat);
      if (m) { round = parseInt(m[1]); break; }
    }
    if (!round || round < 1 || round > 999) continue;

    const names = extractTeamNames(row);
    if (names.length < 2) continue;

    const logoIds = extractLogoIds(row);
    const time = parseTime(row);
    const score = parseScore(row);
    if (!score) continue;

    const entry = { round, home: names[0], away: names[1], hid: logoIds[0]||null, aid: logoIds[1]||null, time };
    if (score.upcoming) upcoming.push({ ...entry, upcoming: true });
    else results.push({ ...entry, upcoming: false, hs: score.hs, as: score.as });
  }
  return { results, upcoming };
}

// ─── PARSER STRATÉGIA 2: TD.divide alapú (az általad mutatott HTML) ───
// A meccsek <td class="divide text-center" data-form-cell=""> cellákban vannak
// Több TD = egy sor menetben (pl. 5 meccs egymás után)
// A forduló számot a legközelebbi >VLLM</div> vagy hasonló szülő elem tartalmazza
function parseByTD(html) {
  const results = [], upcoming = [];

  // Forduló számok keresése – a TD-k előtt/körül
  // Struktúra: <div>VLLM</div><div title="">21</div> → de lehet más helyen is
  const roundBlocks = [...html.matchAll(/>VLLM<\/div>[\s\S]{0,200}?<div[^>]*>(\d+)<\/div>/g)];

  // TD cellák kinyerése
  const tdParts = html.split('<td class="divide text-center" data-form-cell="">');

  for (let i = 1; i < tdParts.length; i++) {
    const cell = tdParts[i].split('</td>')[0];

    const names = extractTeamNames(cell);
    if (names.length < 2) continue;

    const logoIds = extractLogoIds(cell);
    const time = parseTime(cell);
    const score = parseScore(cell);
    if (!score) continue;

    // Forduló keresése: visszafelé nézünk a HTML-ben az i. TD előtt
    const beforeCell = tdParts.slice(0, i).join('<td class="divide text-center" data-form-cell="">');
    let round = null;

    // Több minta a forduló számhoz
    const roundPats = [
      />VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/g,
      /title="VLLM"\s*>\s*(\d+)\s*</g,
      /roundnumber[^>]*>(\d+)</g,
    ];

    for (const pat of roundPats) {
      const allMatches = [...beforeCell.matchAll(pat)];
      if (allMatches.length > 0) {
        const lastMatch = allMatches[allMatches.length - 1];
        const candidate = parseInt(lastMatch[1]);
        if (candidate >= 1 && candidate <= 999) { round = candidate; break; }
      }
    }

    // Ha nem találtunk forduló számot, próbáljunk generikusabb módszerrel
    if (!round) {
      // Keresünk bármilyen forduló-szerű számot a közvetlen kontextusban
      const contextBefore = beforeCell.slice(-500);
      const anyRound = contextBefore.match(/<div[^>]*title="[^"]*"[^>]*>\s*(\d{1,3})\s*<\/div>/g);
      if (anyRound) {
        const nums = anyRound.map(s => parseInt(s.match(/(\d+)/)[1])).filter(n => n>=1 && n<=999);
        if (nums.length) round = nums[nums.length-1];
      }
    }

    // Ha még mindig nincs, becsüljük: hányadik cella ez a TD-k között?
    // 5 meccs/menet logika: az i. TD → Math.ceil(i/5). menet
    // Ez durva becslés, de jobb mint null
    if (!round) round = Math.ceil(i / 5);

    const entry = { round, home: names[0], away: names[1], hid: logoIds[0]||null, aid: logoIds[1]||null, time };
    if (score.upcoming) upcoming.push({ ...entry, upcoming: true });
    else results.push({ ...entry, upcoming: false, hs: score.hs, as: score.as });
  }

  return { results, upcoming };
}

// ─── KOMBINÁLT PARSER ─────────────────────────────────────────────
function parseMatches(html) {
  // Először TR-alapú parsert próbálunk
  const trResult = parseByTR(html);
  if (trResult.results.length + trResult.upcoming.length > 0) {
    console.log(`[Parser] TR strategy: ${trResult.results.length} results, ${trResult.upcoming.length} upcoming`);
    return trResult;
  }

  // Ha TR nem hozott semmit, TD-alapút próbálunk
  const tdResult = parseByTD(html);
  console.log(`[Parser] TD strategy: ${tdResult.results.length} results, ${tdResult.upcoming.length} upcoming`);
  return tdResult;
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
    const hasDivideTD = html.includes('data-form-cell=""');

    if (debug) {
      const { results, upcoming } = parseMatches(html);

      // Extra debug: megmutatjuk az első TD-t ha van
      let tdSnippet = null;
      if (hasDivideTD) {
        const tdIdx = html.indexOf('<td class="divide text-center" data-form-cell="">');
        tdSnippet = html.slice(tdIdx, tdIdx + 1500);
      }

      // Extra debug: megmutatjuk az első TR-t ha van
      let trSnippet = null;
      if (hasCursorTR) {
        const trIdx = html.indexOf('<tr class="cursor-pointer">');
        trSnippet = html.slice(trIdx, trIdx + 2000);
      }

      return new Response(JSON.stringify({
        htmlLen, hasVLLM, hasCursorTR, hasDivideTD,
        totalResults: results.length,
        totalUpcoming: upcoming.length,
        results: results.slice(0, 5),
        upcoming: upcoming.slice(0, 5),
        trSnippet,
        tdSnippet,
        htmlStart: html.slice(0, 500),
      }), { status: 200, headers: corsHeaders });
    }

    if (!hasVLLM && !hasDivideTD) {
      return new Response(JSON.stringify({
        error: `Got JS bundle instead of HTML (len=${htmlLen}, hasVLLM=${hasVLLM}, hasCursorTR=${hasCursorTR}, hasDivideTD=${hasDivideTD})`,
        hint: 'Try /api/matches?debug=1',
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    const { results, upcoming } = parseMatches(html);

    if (results.length === 0 && upcoming.length === 0) {
      return new Response(JSON.stringify({
        error: `Parsed 0 matches (htmlLen=${htmlLen}, hasCursorTR=${hasCursorTR}, hasDivideTD=${hasDivideTD})`,
        hint: 'Try /api/matches?debug=1 to see HTML snippets',
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    // Utolsó 3 forduló eredményei
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
