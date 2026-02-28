// api/standings.js – Vercel Edge Function
// Scrape-eli a Sportradar HTML oldalt és kiszedi a tabella adatokat

export const config = { runtime: 'edge' };

const SOURCES = {
  pl: 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061001',
};

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://vfscigaming.aitcloud.de/',
  'Origin': 'https://vfscigaming.aitcloud.de',
};

function parseTrendFromClass(cls = '') {
  if (/up|positive|increase|arrow-up/i.test(cls)) return 'up';
  if (/down|negative|decrease|arrow-down/i.test(cls)) return 'down';
  return 'same';
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

function parseStandingsFromHTML(html) {
  const standings = [];

  // ── 1. kísérlet: beágyazott JSON keresése ──
  const jsonPatterns = [
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});\s*<\/script>/,
    /window\.__data\s*=\s*(\{[\s\S]+?\});\s*<\/script>/,
    /"standings"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
    /"rows"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
  ];

  for (const pat of jsonPatterns) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      const rows = extractRowsDeep(obj);
      if (rows.length >= 3) return rows;
    } catch (_) {}
  }

  // ── 2. kísérlet: HTML táblázat sorok parse ──
  // Sportradar oldal struktúra (a képből): Poz | Csapat | M | G | D | V | LG | KG | Gólk. | PTK | Forma
  const trRegex = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const trAttrs = trMatch[1];
    const trContent = trMatch[2];

    const tds = [...trContent.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)]
      .map(m => ({ cls: m[1], text: stripTags(m[2]) }));

    if (tds.length < 9) continue;

    const pos = parseInt(tds[0].text);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;

    const team = tds[1].text;
    if (!team || team.length < 2 || /^\d+$/.test(team)) continue;

    const nums = tds.slice(2).map(t => parseInt(t.text)).filter(n => !isNaN(n));
    if (nums.length < 7) continue;

    // Oszlop sorrend: M(0) G(1) D(2) V(3) LG(4) KG(5) Gólk(6) PTK(7)
    const goalsFor     = nums[4] ?? 0;
    const goalsAgainst = nums[5] ?? 0;
    const pts          = nums[7] ?? nums[nums.length - 1] ?? 0;

    const trend = parseTrendFromClass(trAttrs + tds[0].cls);

    standings.push({ pos, team, goalsFor, goalsAgainst, pts, trend });
  }

  // Deduplikáció, rendezés
  const seen = new Set();
  return standings
    .filter(r => { if (seen.has(r.pos)) return false; seen.add(r.pos); return true; })
    .sort((a, b) => a.pos - b.pos);
}

function extractRowsDeep(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return [];
  for (const key of ['rows', 'items', 'standings', 'table', 'teams']) {
    if (Array.isArray(obj[key]) && obj[key].length >= 3) {
      const mapped = obj[key].map((item, i) => ({
        pos: item.rank ?? item.pos ?? item.position ?? (i + 1),
        team: item.team?.abbr || item.team?.name?.short || item.teamName || item.name?.short || item.name || item.abbreviation || '???',
        goalsFor: item.goalsfor ?? item.goals_for ?? item.gf ?? item.goalsFor ?? 0,
        goalsAgainst: item.goalsagainst ?? item.goals_against ?? item.ga ?? item.goalsAgainst ?? 0,
        pts: item.pts ?? item.points ?? item.pkt ?? 0,
        trend: parseTrendFromClass(String(item.trend ?? item.form ?? '')),
      })).filter(r => r.team !== '???');
      if (mapped.length >= 3) return mapped;
    }
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null) {
      const r = extractRowsDeep(val, depth + 1);
      if (r.length >= 3) return r;
    }
  }
  return [];
}

// Fallback – aktuális állás (képről leolvasva), addig él amíg a scrape nem működik
const FALLBACK = [
  { pos: 1,  team: 'Manchester Kék', goalsFor: 34, goalsAgainst: 20, pts: 38, trend: 'same' },
  { pos: 2,  team: 'Liverpool',       goalsFor: 30, goalsAgainst: 15, pts: 30, trend: 'up'   },
  { pos: 3,  team: 'Vörös Ördögök',   goalsFor: 38, goalsAgainst: 24, pts: 29, trend: 'down' },
  { pos: 4,  team: 'Fulham',          goalsFor: 25, goalsAgainst: 20, pts: 28, trend: 'up'   },
  { pos: 5,  team: 'Everton',         goalsFor: 27, goalsAgainst: 14, pts: 27, trend: 'down' },
  { pos: 6,  team: 'Chelsea',         goalsFor: 24, goalsAgainst: 17, pts: 26, trend: 'up'   },
  { pos: 7,  team: 'London Ágyúk',    goalsFor: 21, goalsAgainst: 19, pts: 26, trend: 'up'   },
  { pos: 8,  team: 'Wolverhampton',   goalsFor: 28, goalsAgainst: 26, pts: 25, trend: 'down' },
  { pos: 9,  team: 'Newcastle',       goalsFor: 23, goalsAgainst: 24, pts: 23, trend: 'up'   },
  { pos: 10, team: 'Tottenham',       goalsFor: 20, goalsAgainst: 26, pts: 23, trend: 'down' },
  { pos: 11, team: 'Brentford',       goalsFor: 14, goalsAgainst: 15, pts: 21, trend: 'up'   },
  { pos: 12, team: 'West Ham',        goalsFor: 21, goalsAgainst: 26, pts: 20, trend: 'down' },
  { pos: 13, team: 'Nottingham',      goalsFor: 18, goalsAgainst: 29, pts: 18, trend: 'up'   },
  { pos: 14, team: 'Aston Oroszlán',  goalsFor: 15, goalsAgainst: 29, pts: 16, trend: 'down' },
  { pos: 15, team: 'Brighton',        goalsFor: 13, goalsAgainst: 35, pts: 12, trend: 'same' },
  { pos: 16, team: 'Crystal Palace',  goalsFor: 12, goalsAgainst: 24, pts: 10, trend: 'same' },
];

export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=55, stale-while-revalidate=110',
  };

  const { searchParams } = new URL(req.url);
  const liga  = searchParams.get('liga') || 'pl';
  const debug = searchParams.get('debug') === '1';

  const srcUrl = SOURCES[liga];
  if (!srcUrl) {
    return new Response(JSON.stringify({ standings: FALLBACK, source: 'fallback' }), { status: 200, headers: corsHeaders });
  }

  try {
    const res = await fetch(srcUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const standings = parseStandingsFromHTML(html);

    if (standings.length >= 3) {
      return new Response(
        JSON.stringify({ standings, source: 'scrape', ...(debug ? { htmlSnippet: html.slice(0, 4000) } : {}) }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Scrape nem adott eredményt → fallback
    return new Response(
      JSON.stringify({
        standings: FALLBACK,
        source: 'fallback',
        ...(debug ? { htmlSnippet: html.slice(0, 4000), parseResult: standings } : {}),
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ standings: FALLBACK, source: 'fallback', error: err.message }),
      { status: 200, headers: corsHeaders }
    );
  }
}
