// api/matches.js – Vercel Edge Function
// 
// ARCHITECTURE:
// A sportradar s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057
// egy SPA shell-t ad vissza (nem SSR HTML meccsadatokkal).
// A standings.js az ÁLLÁSTÁBLÁT parse-eli ugyanerről az URL-ről
// mert az állástábla a CSS-ben inline van (CSS-ből szedik ki a pozíciókat).
//
// A MECCSADATOK megszerzéséhez több stratégiát próbálunk:
// 1. sportradar publikus JSON API (ha létezik)
// 2. vfscigaming aitcloud main widget oldal -> schedule hash kinyerése
// 3. schedulerzrh livetable endpoint hash-sel
// 4. Sportradar SR season sub-routes

export const config = { runtime: 'edge' };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
};

const JSON_HEADERS = {
  ...HEADERS,
  'Accept': 'application/json,text/javascript,*/*;q=0.01',
};

// ─── PARSER: cursor-pointer TR sorok (tesztelve ✓) ──────────────
function parseOneRow(row) {
  const roundM = row.match(/>VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/);
  if (!roundM) return null;
  const round = parseInt(roundM[1]);
  if (isNaN(round) || round < 1 || round > 99) return null;

  const names = [...row.matchAll(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/g)].map(m => m[1].trim());
  if (names.length < 2) return null;

  const logoIds = [];
  for (const m of row.matchAll(/src="https:\/\/vgls\.betradar\.com\/ls\/s5_crest\/scigamingvirtuals\/medium\/(\d+)\.png"/g)) {
    if (!logoIds.includes(m[1])) logoIds.push(m[1]);
  }

  const timeM = row.match(/<div class="text-center">\s*(\d{1,2}:\d{2})\s*<\/div>/);
  const scoreM = row.match(/aria-label="Eredm\."([\s\S]*?)<\/div><\/div><\/div>/);
  if (!scoreM) return null;
  const sec = scoreM[1];

  const dashes = [...sec.matchAll(/<div class="inline-block[^"]*">\s*-\s*<sup>/g)];
  const nums   = [...sec.matchAll(/<div class="inline-block[^"]*">\s*(\d+)\s*<sup>/g)].map(m => parseInt(m[1]));

  const base = { round, home: names[0], away: names[1], hid: logoIds[0]||null, aid: logoIds[1]||null, time: timeM?timeM[1]:null };
  if (dashes.length >= 2) return { ...base, upcoming: true };
  if (nums.length >= 2)   return { ...base, upcoming: false, hs: nums[0], as: nums[1] };
  return null;
}

function parseHTML(html) {
  const results = [], upcoming = [];
  const parts = html.split('<tr class="cursor-pointer">');
  for (let i = 1; i < parts.length; i++) {
    const m = parseOneRow(parts[i].split('</tr>')[0]);
    if (m) (m.upcoming ? upcoming : results).push(m);
  }
  return { results, upcoming };
}

// ─── SPORTRADAR JSON API PARSER ───────────────────────────────────
function parseJsonApi(data) {
  // Próbáljuk különböző JSON struktúrákat
  const results = [], upcoming = [];
  const now = new Date();

  const events = data.events || data.results || data.fixtures || data.matches || data.data || [];
  for (const ev of events) {
    const round  = ev.round?.number ?? ev.round ?? ev.tournament_round?.number;
    const home   = ev.home?.name   ?? ev.homeTeam?.name ?? ev.competitors?.find(c=>c.qualifier==='home')?.name;
    const away   = ev.away?.name   ?? ev.awayTeam?.name ?? ev.competitors?.find(c=>c.qualifier==='away')?.name;
    if (!round || !home || !away) continue;

    const hs = ev.home_score ?? ev.homeScore ?? ev.period_scores?.reduce((s,p)=>s+(p.home_score||0),0);
    const as_ = ev.away_score ?? ev.awayScore ?? ev.period_scores?.reduce((s,p)=>s+(p.away_score||0),0);
    const status = ev.status ?? ev.match_status;
    const isPlayed = ['closed','ended','finished'].includes(status?.toLowerCase()) || (hs !== undefined && as_ !== undefined);

    if (isPlayed && hs !== undefined) {
      results.push({ round, home, away, hid: null, aid: null, time: null, upcoming: false, hs, as: as_ });
    } else {
      upcoming.push({ round, home, away, hid: null, aid: null, time: null, upcoming: true });
    }
  }
  return { results, upcoming };
}

// ─── FETCH HELPER ─────────────────────────────────────────────────
async function tryFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.json ? JSON_HEADERS : HEADERS,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return opts.json ? res.json() : res.text();
}

// ─── BUILD RESPONSE ───────────────────────────────────────────────
function buildResponse(results, upcoming, meta, debug, corsHeaders) {
  const rounds = [...new Set(results.map(m => m.round))].sort((a,b) => b-a);
  const lastRounds = rounds.slice(0, 3);
  const recentResults = results.filter(m => lastRounds.includes(m.round));

  const upRounds = [...new Set(upcoming.map(m => m.round))].sort((a,b) => a-b);
  const nextRound = upRounds[0] ?? null;
  const nextFixtures = upcoming.filter(m => m.round === nextRound);

  return new Response(JSON.stringify({
    recentResults, nextFixtures, nextRound,
    lastRound: lastRounds[0] ?? null,
    source: 'scrape',
    ...(debug ? { ...meta, totalResults: results.length, totalUpcoming: upcoming.length } : { usedUrl: meta.usedUrl }),
  }), { status: 200, headers: corsHeaders });
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
  const errors = [];

  // ═══ 1. Sportradar JSON API próbák ═══
  const jsonUrls = [
    `https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/results.json`,
    `https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/fixtures.json`,
    `https://s5.sir.sportradar.com/scigamingvirtuals/hu/api/v1/sport/1/season/3061057/results`,
    `https://s5.sir.sportradar.com/scigamingvirtuals/hu/api/sport/1/season/3061057/results`,
  ];

  for (const url of jsonUrls) {
    try {
      const data = await tryFetch(url, { json: true });
      const { results, upcoming } = parseJsonApi(data);
      if (results.length > 0 || upcoming.length > 0) {
        return buildResponse(results, upcoming, { usedUrl: url }, debug, corsHeaders);
      }
      errors.push(`JSON ${url}: 0 matches`);
    } catch(e) { errors.push(`JSON ${url}: ${e.message}`); }
  }

  // ═══ 2. vfscigaming widget főoldal -> schedule hash kinyerés ═══
  try {
    const widgetHtml = await tryFetch(
      'https://vfscigaming.aitcloud.de/vflmshop/retail/index?clientid=4997&lang=hu&style=scigamingcdn&screen=betradar_vflm_one_screen&channel=0',
      { headers: { ...HEADERS, 'Referer': 'https://vfscigaming.aitcloud.de/' } }
    );

    if (debug) errors.push(`widget html len=${widgetHtml.length}, has_VLLM=${widgetHtml.includes('VLLM')}, has_cursor=${widgetHtml.includes('cursor-pointer')}`);

    // cursor-pointer sorok közvetlen parse-elás
    if (widgetHtml.includes('cursor-pointer') && widgetHtml.includes('VLLM')) {
      const { results, upcoming } = parseHTML(widgetHtml);
      if (results.length > 0 || upcoming.length > 0) {
        return buildResponse(results, upcoming, { usedUrl: 'vfscigaming-widget' }, debug, corsHeaders);
      }
    }

    // schedule hash kinyerés
    const hashMatches = [...widgetHtml.matchAll(/schedule[:\-_]([a-f0-9]{32})/gi)];
    const hashes = [...new Set(hashMatches.map(m => m[1]))];
    if (debug) errors.push(`found hashes: ${hashes.join(',') || 'none'}`);

    for (const hash of hashes) {
      const schedUrls = [
        `https://schedulerzrh.aitcloud.de/retail_scheduler/display/index/schedule:${hash}`,
        `https://schedulerzrh.aitcloud.de/retail_scheduler/widget/livetable/schedule:${hash}`,
        `https://schedulerzrh.aitcloud.de/retail_scheduler/display/livetable/schedule:${hash}`,
      ];
      for (const url of schedUrls) {
        try {
          const html = await tryFetch(url);
          if (html.includes('cursor-pointer') && html.includes('VLLM')) {
            const { results, upcoming } = parseHTML(html);
            if (results.length > 0 || upcoming.length > 0) {
              return buildResponse(results, upcoming, { usedUrl: url, hash }, debug, corsHeaders);
            }
          }
        } catch(e) { errors.push(`sched[${hash}]: ${e.message}`); }
      }
    }
  } catch(e) { errors.push(`widget: ${e.message}`); }

  // ═══ 3. Sportradar HTML sub-routes ═══
  const srUrls = [
    'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/results',
    'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/fixtures',
    'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/schedule',
    'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057/matches',
  ];

  for (const url of srUrls) {
    try {
      const html = await tryFetch(url);
      if (html.includes('cursor-pointer') && html.includes('VLLM')) {
        const { results, upcoming } = parseHTML(html);
        if (results.length > 0 || upcoming.length > 0) {
          return buildResponse(results, upcoming, { usedUrl: url }, debug, corsHeaders);
        }
        errors.push(`SR HTML ${url}: 0 matches (len=${html.length})`);
      } else {
        errors.push(`SR HTML ${url}: no data (len=${html.length})`);
      }
    } catch(e) { errors.push(`SR HTML ${url}: ${e.message}`); }
  }

  // ═══ 4. schedulerzrh clientid alapján ═══
  const clientUrls = [
    'https://schedulerzrh.aitcloud.de/retail_scheduler/display/index?clientid=4997',
    'https://schedulerzrh.aitcloud.de/retail_scheduler/widget/schedule?clientid=4997',
  ];
  for (const url of clientUrls) {
    try {
      const html = await tryFetch(url);
      if (html.includes('cursor-pointer') || html.includes('vsm-')) {
        const { results, upcoming } = parseHTML(html);
        if (results.length > 0 || upcoming.length > 0) {
          return buildResponse(results, upcoming, { usedUrl: url }, debug, corsHeaders);
        }
        if (debug) errors.push(`clientid ${url}: len=${html.length}, snippet: ${html.slice(0,200)}`);
      }
    } catch(e) { errors.push(`clientid ${url}: ${e.message}`); }
  }

  // Minden sikertelen
  return new Response(JSON.stringify({
    error: 'All strategies failed',
    details: errors,
    recentResults: [], nextFixtures: [],
    nextRound: null, lastRound: null,
    source: 'error',
  }), { status: 200, headers: corsHeaders });
}
