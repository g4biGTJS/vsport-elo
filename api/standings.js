// api/standings.js – Vercel Edge Function
// Scrape-eli a Sportradar HTML oldalt – pontos parser a valós struktúra alapján

export const config = { runtime: 'edge' };

const SOURCES = {
  pl: 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061001',
};

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://vfscigaming.aitcloud.de/',
};

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

// Pontos parser a valós Sportradar HTML struktúra alapján
function parseStandingsFromHTML(html) {
  const standings = [];

  // Minden <tr ...> sort megkeresünk
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];

    // ── 1. Pozíció ──
    // <div class="margin-left-medium padding-bottom padding-top ">16</div>
    const posMatch = rowHtml.match(/class="margin-left-medium[^"]*"[^>]*>\s*(\d+)\s*<\/div>/);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;

    // ── 2. Trend ──
    // title="Hátrább lépett" = down, title="Előrébb lépett" = up, nincs title = same
    let trend = 'same';
    if (/title="Előrébb lépett"/.test(rowHtml))  trend = 'up';
    if (/title="Hátrább lépett"/.test(rowHtml)) trend = 'down';

    // ── 3. Csapatnév ──
    // <div class="hidden-xs-up visible-sm-up wrap">Crystal Palace</div>
    const nameMatch = rowHtml.match(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/);
    if (!nameMatch) continue;
    const team = nameMatch[1].trim();
    if (!team || team.length < 2) continue;

    // ── 4. Csapat logo URL ──
    // https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/276509.png
    const logoMatch = rowHtml.match(/src="(https:\/\/vgls\.betradar\.com\/ls\/s5_crest\/scigamingvirtuals\/medium\/\d+\.png)"/);
    const logo = logoMatch ? logoMatch[1] : null;

    // ── 5. TD adatok ──
    // Sorrend: [0]=Poz | [1]=Trend | [2]=Csapat | [3]=M | [4]=G | [5]=D | [6]=V | [7]=LG | [8]=KG | [9]=Gólk | [10]=PTK | [11]=Forma
    const tdValues = [...rowHtml.matchAll(/<td[^>]*>\s*(\d+)\s*<\/td>/g)]
      .map(m => parseInt(m[1]));

    // Legalább 8 szám kell (M, G, D, V, LG, KG, Gólk, PTK)
    if (tdValues.length < 7) continue;

    // A TD-k sorrendben: M, G, D, V, LG, KG, Gólk(különbség negatív is lehet), PTK
    // A negatív számokat (Gólkülönbség) külön kezeljük
    const allTdNums = [...rowHtml.matchAll(/<td[^>]*>\s*(-?\d+)\s*<\/td>/g)]
      .map(m => parseInt(m[1]));

    // Minimum 8 TD szám kell
    if (allTdNums.length < 7) continue;

    // LG = allTdNums[4], KG = allTdNums[5], PTK = utolsó előtti vagy 7. index
    const goalsFor     = allTdNums[4] ?? 0;
    const goalsAgainst = allTdNums[5] ?? 0;
    const pts          = allTdNums[7] ?? allTdNums[allTdNums.length - 1] ?? 0;

    standings.push({ pos, team, logo, goalsFor, goalsAgainst, pts, trend });
  }

  // Deduplikáció és rendezés pozíció szerint
  const seen = new Set();
  return standings
    .filter(r => { if (seen.has(r.pos)) return false; seen.add(r.pos); return true; })
    .sort((a, b) => a.pos - b.pos);
}

// Fallback – a képről leolvasott állás (amíg a scrape nem működik)
const FALLBACK = [
  { pos: 1,  team: 'Manchester Kék', goalsFor: 34, goalsAgainst: 20, pts: 38, trend: 'same', logo: 'https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/276505.png' },
  { pos: 2,  team: 'Liverpool',       goalsFor: 30, goalsAgainst: 15, pts: 30, trend: 'up',   logo: 'https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/276506.png' },
  { pos: 3,  team: 'Vörös Ördögök',   goalsFor: 38, goalsAgainst: 24, pts: 29, trend: 'down', logo: null },
  { pos: 4,  team: 'Fulham',          goalsFor: 25, goalsAgainst: 20, pts: 28, trend: 'up',   logo: null },
  { pos: 5,  team: 'Everton',         goalsFor: 27, goalsAgainst: 14, pts: 27, trend: 'down', logo: null },
  { pos: 6,  team: 'Chelsea',         goalsFor: 24, goalsAgainst: 17, pts: 26, trend: 'up',   logo: null },
  { pos: 7,  team: 'London Ágyúk',    goalsFor: 21, goalsAgainst: 19, pts: 26, trend: 'up',   logo: null },
  { pos: 8,  team: 'Wolverhampton',   goalsFor: 28, goalsAgainst: 26, pts: 25, trend: 'down', logo: null },
  { pos: 9,  team: 'Newcastle',       goalsFor: 23, goalsAgainst: 24, pts: 23, trend: 'up',   logo: null },
  { pos: 10, team: 'Tottenham',       goalsFor: 20, goalsAgainst: 26, pts: 23, trend: 'down', logo: null },
  { pos: 11, team: 'Brentford',       goalsFor: 14, goalsAgainst: 15, pts: 21, trend: 'up',   logo: null },
  { pos: 12, team: 'West Ham',        goalsFor: 21, goalsAgainst: 26, pts: 20, trend: 'down', logo: null },
  { pos: 13, team: 'Nottingham',      goalsFor: 18, goalsAgainst: 29, pts: 18, trend: 'up',   logo: null },
  { pos: 14, team: 'Aston Oroszlán',  goalsFor: 15, goalsAgainst: 29, pts: 16, trend: 'down', logo: 'https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/276504.png' },
  { pos: 15, team: 'Brighton',        goalsFor: 13, goalsAgainst: 35, pts: 12, trend: 'same', logo: 'https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/276511.png' },
  { pos: 16, team: 'Crystal Palace',  goalsFor: 12, goalsAgainst: 24, pts: 10, trend: 'same', logo: 'https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/276509.png' },
];

export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=8, stale-while-revalidate=16',
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

    if (debug) {
      // Debug módban visszaadjuk a nyers HTML-t is (csak az első 5000 karaktert)
      return new Response(
        JSON.stringify({ standings, source: standings.length >= 3 ? 'scrape' : 'fallback_parse_fail', htmlSnippet: html.slice(0, 5000), rowCount: standings.length }),
        { status: 200, headers: corsHeaders }
      );
    }

    if (standings.length >= 3) {
      return new Response(
        JSON.stringify({ standings, source: 'scrape' }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Scrape sikertelen → fallback
    return new Response(
      JSON.stringify({ standings: FALLBACK, source: 'fallback' }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ standings: FALLBACK, source: 'fallback', error: err.message }),
      { status: 200, headers: corsHeaders }
    );
  }
}
