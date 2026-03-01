// api/matches.js – Vercel Edge Function v4
// JAVÍTÁS: data-form-cell = tabella forma oszlop cellák
// Minden csapatsorban az upcoming cella = következő meccs
// Deduplikáció: hazai+vendég csapat sora is tartalmazza ugyanazt

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

// ─── HELPERS ──────────────────────────────────────────────────────

function extractTeamNames(chunk) {
  const names = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]+?)\s*<\/div>/g)]
    .map(m => m[1].trim()).filter(Boolean);
  if (names.length >= 2) return names;
  return [...chunk.matchAll(/class="hidden-sm-up wrap">\s*([^<]+?)\s*<\/div>/g)]
    .map(m => m[1].trim()).filter(Boolean);
}

function extractLogoIds(chunk) {
  const ids = [];
  for (const m of chunk.matchAll(/\/medium\/(\d{5,7})\.png/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

function parseTime(chunk) {
  const m = chunk.match(/<div class="text-center">\s*(\d{1,2}:\d{2})\s*<\/div>/);
  return m ? m[1] : null;
}

// Közvetlen dash/szám keresés – NEM függ a scoreSection regex-tól
function parseScore(chunk) {
  const dashCount = (chunk.match(/<div class="inline-block[^"]*">\s*-\s*<sup>/g) || []).length;
  if (dashCount >= 2) return { upcoming: true };

  const nums = [...chunk.matchAll(/<div class="inline-block[^"]*">\s*(\d+)\s*<sup>/g)]
    .map(m => parseInt(m[1]));
  if (nums.length >= 2) return { upcoming: false, hs: nums[0], as: nums[1] };

  return null;
}

// Deduplikációs kulcs: home+away alfabetikus sorban
function matchKey(home, away) {
  return [home, away].sort().join('|||');
}

// ─── PARSER 1: FORMA CELLÁK (tabella nézethez) ────────────────────
// A tabella soraiban minden csapathoz tartoznak form-cell TD-k.
// Az upcoming (- : -) cellák = következő menet.
// Ugyanaz a meccs kétszer jelenik meg → deduplikáció szükséges.
function parseFormCells(html) {
  const upcoming = [];
  const results = [];
  const seenKeys = new Set();

  // TR soronként feldolgozás
  const trParts = html.split(/<tr[^>]*>/);

  for (const trRaw of trParts) {
    const tr = trRaw.split('</tr>')[0];
    if (!tr.includes('data-form-cell')) continue;

    // Form cellák ebből a TR-ből
    const tdParts = tr.split('<td class="divide text-center" data-form-cell="">');

    for (let j = 1; j < tdParts.length; j++) {
      const cell = tdParts[j].split('</td>')[0];

      const names = extractTeamNames(cell);
      if (names.length < 2) continue;

      const score = parseScore(cell);
      if (!score) continue;

      const key = matchKey(names[0], names[1]);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const logoIds = extractLogoIds(cell);
      const time = parseTime(cell);

      const entry = {
        home: names[0],
        away: names[1],
        hid: logoIds[0] || null,
        aid: logoIds[1] || null,
        time,
      };

      if (score.upcoming) {
        upcoming.push({ ...entry, upcoming: true });
      } else {
        results.push({ ...entry, upcoming: false, hs: score.hs, as: score.as });
      }
    }
  }

  return { results, upcoming };
}

// ─── PARSER 2: cursor-pointer TR (fixtures/schedule nézet) ────────
function parseCursorTR(html) {
  const results = [], upcoming = [];
  const roundPatterns = [
    />VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/,
    /title="VLLM"[^>]*>\s*(\d+)\s*</,
    />VLLM\s*(\d+)</,
    /data-roundnumber="(\d+)"/,
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

// ─── FORDULÓ SZÁM BECSLÉS ─────────────────────────────────────────
function inferRound(html) {
  const m = html.match(/>VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/);
  return m ? parseInt(m[1]) : null;
}

// ─── KOMBINÁLT PARSER ─────────────────────────────────────────────
function parseMatches(html) {
  // 1. cursor-pointer TR (fixtures nézet)
  const tr = parseCursorTR(html);
  if (tr.results.length + tr.upcoming.length >= 3) {
    return { ...tr, method: 'cursor-tr' };
  }

  // 2. Forma cellák (tabella nézet – a mi esetünk)
  const fc = parseFormCells(html);
  if (fc.results.length + fc.upcoming.length > 0) {
    const estimatedRound = inferRound(html);
    fc.upcoming = fc.upcoming.map(m => ({ ...m, round: estimatedRound || 1 }));
    fc.results  = fc.results.map(m  => ({ ...m, round: estimatedRound ? estimatedRound - 1 : 1 }));
    return { ...fc, method: 'form-cells' };
  }

  return { results: [], upcoming: [], method: 'none' };
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
    const hasFormCell = html.includes('data-form-cell=""');

    if (debug) {
      const parsed = parseMatches(html);

      let formSnippet = null;
      if (hasFormCell) {
        const idx = html.indexOf('<td class="divide text-center" data-form-cell="">');
        formSnippet = html.slice(idx, idx + 1200);
      }
      let trSnippet = null;
      if (hasCursorTR) {
        const idx = html.indexOf('<tr class="cursor-pointer">');
        trSnippet = html.slice(idx, idx + 1500);
      }

      return new Response(JSON.stringify({
        htmlLen, hasVLLM, hasCursorTR, hasFormCell,
        method: parsed.method,
        totalResults: parsed.results.length,
        totalUpcoming: parsed.upcoming.length,
        results: parsed.results.slice(0, 3),
        upcoming: parsed.upcoming.slice(0, 5),
        formSnippet,
        trSnippet,
        htmlStart: html.slice(0, 400),
      }), { status: 200, headers: corsHeaders });
    }

    if (!hasVLLM && !hasFormCell && !hasCursorTR) {
      return new Response(JSON.stringify({
        error: `JS bundle vagy üres válasz (len=${htmlLen})`,
        hint: 'Try /api/matches?debug=1',
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    const parsed = parseMatches(html);

    if (parsed.results.length === 0 && parsed.upcoming.length === 0) {
      return new Response(JSON.stringify({
        error: `0 meccs (len=${htmlLen}, method=${parsed.method}, formCell=${hasFormCell}, cursorTR=${hasCursorTR})`,
        hint: 'Try /api/matches?debug=1',
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    const rounds = [...new Set(parsed.results.map(m => m.round))].sort((a, b) => b - a);
    const lastRounds = rounds.slice(0, 3);
    const recentResults = parsed.results.filter(m => lastRounds.includes(m.round));

    const upRounds = [...new Set(parsed.upcoming.map(m => m.round))].sort((a, b) => a - b);
    const nextRound = upRounds[0] ?? null;
    const nextFixtures = parsed.upcoming.filter(m => m.round === nextRound);

    return new Response(JSON.stringify({
      recentResults,
      nextFixtures,
      nextRound,
      lastRound: lastRounds[0] ?? null,
      source: 'scrape',
      method: parsed.method,
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message,
      recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
    }), { status: 200, headers: corsHeaders });
  }
}
