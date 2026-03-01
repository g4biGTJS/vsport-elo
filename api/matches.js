// api/matches.js – Vercel Edge Function – DIAGNOSTIC v5

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
  'Cache-Control': 'no-store',
};

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
    const m = html.match(/"currentseasonid"\s*:\s*(\d+)/);
    if (m?.[1]) currentSeasonId = m[1];
    lastCategoryCheck = now;
  } catch (e) { console.error('[SeasonCheck]', e.message); lastCategoryCheck = Date.now(); }
  return currentSeasonId;
}

// Brace-matched JSON object kinyerése adott kulcs után
function extractJsonBlock(html, searchStr) {
  const idx = html.indexOf(searchStr);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx + searchStr.length);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < Math.min(start + 1000000, html.length); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// Az összes top-level fetchedData kulcs kinyerése
function getFetchedDataKeys(html) {
  const keys = [];
  const re = /"([^"]{3,100})":\{"event"/g;
  let m;
  while ((m = re.exec(html)) !== null) { keys.push(m[1]); if (keys.length > 50) break; }
  return keys;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') ?? 'fixtures';

  try {
    const seasonId = await findCurrentSeasonId();

    // ── MODE: fixtures ──
    // A /season/ID/fixtures oldal fetchedData kulcsait és mintáit mutatja
    if (mode === 'fixtures') {
      const url = `${BASE_URL}/season/${seasonId}/fixtures`;
      const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
      const html = await res.text();

      const keys = getFetchedDataKeys(html);
      const matchIds = [...new Set([...html.matchAll(/"matchid"\s*:\s*(\d{8,12})/g)].map(m => m[1]))];;

      // Minden kulcshoz vegyük ki az első 500 karaktert
      const samples = {};
      for (const key of keys) {
        const block = extractJsonBlock(html, `"${key}":`);
        if (block) samples[key] = JSON.stringify(block).slice(0, 600);
      }

      return new Response(JSON.stringify({
        seasonId, url, htmlLength: html.length,
        feedKeys: keys,
        matchIdCount: matchIds.length,
        matchIds: matchIds.slice(0, 20),
        feedSamples: samples,
      }, null, 2), { status: 200, headers: corsHeaders });
    }

    // ── MODE: results ──
    // A /season/ID/results oldal
    if (mode === 'results') {
      const url = `${BASE_URL}/season/${seasonId}/results`;
      const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
      const html = await res.text();

      const keys = getFetchedDataKeys(html);
      const matchIds = [...new Set([...html.matchAll(/"matchid"\s*:\s*(\d{8,12})/g)].map(m => m[1]))];

      const samples = {};
      for (const key of keys) {
        const block = extractJsonBlock(html, `"${key}":`);
        if (block) samples[key] = JSON.stringify(block).slice(0, 600);
      }

      return new Response(JSON.stringify({
        seasonId, url, htmlLength: html.length,
        feedKeys: keys,
        matchIdCount: matchIds.length,
        matchIds: matchIds.slice(0, 20),
        feedSamples: samples,
      }, null, 2), { status: 200, headers: corsHeaders });
    }

    // ── MODE: formtable ──
    // A season főoldalból kinyert matchidek
    if (mode === 'formtable') {
      const url = `${BASE_URL}/season/${seasonId}`;
      const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) });
      const html = await res.text();
      const matchIds = [...new Set([...html.matchAll(/"matchid"\s*:\s*(\d{8,12})/g)].map(m => m[1]))];
      return new Response(JSON.stringify({
        seasonId, matchIdCount: matchIds.length, matchIds
      }, null, 2), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Használj: ?mode=fixtures | ?mode=results | ?mode=formtable' }), {
      status: 400, headers: corsHeaders,
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 200, headers: corsHeaders });
  }
}
