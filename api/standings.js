// api/standings.js – Vercel Edge Function
// Premier Liga: s5.sir.sportradar.com HTML scrape
// Spanyol Liga:  schedulerzrh.aitcloud.de VSM widget HTML scrape

export const config = { runtime: 'edge' };

const SOURCES = {
  pl: 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061001',
  // SL: try multiple endpoints - the main page embeds the livetable widget
  sl: 'https://schedulerzrh.aitcloud.de/retail_scheduler/display/index/schedule:f94efd4aed2cae288d1ab3abaf828b38',
};

// Extra SL endpoints to try if main doesn't contain vsm rows
const SL_EXTRA_ENDPOINTS = [
  'https://schedulerzrh.aitcloud.de/retail_scheduler/widget/livetable/schedule:f94efd4aed2cae288d1ab3abaf828b38',
  'https://schedulerzrh.aitcloud.de/retail_scheduler/display/livetable/schedule:f94efd4aed2cae288d1ab3abaf828b38',
  'https://schedulerzrh.aitcloud.de/retail_scheduler/livetable/f94efd4aed2cae288d1ab3abaf828b38',
];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
};

// ─────────────────────────────────────────────
// PREMIER LIGA parser (s5.sir.sportradar.com)
// Oszlopok: Poz | trend | Csapat | M | G | D | V | LG* | KG* | Gólk | PTK | Forma
// *LG, KG: "hidden-xs-up visible-sm-up" – néha hiányzik a szerver válaszából!
// FIX: TD-ket class alapján azonosítjuk, nem pozíció szerint
// ─────────────────────────────────────────────
function parsePL(html) {
  const standings = [];

  // TR-eket split-tel szétvágjuk (megbízhatóbb mint greedy regex)
  const parts = html.split(/<tr[^>]*>/);

  for (let i = 1; i < parts.length; i++) {
    const row = parts[i].split('</tr>')[0];

    // ── Pozíció ──
    const posMatch = row.match(/class="margin-left-medium[^"]*"[^>]*>\s*(\d+)\s*<\/div>/);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;

    // ── Trend ──
    let trend = 'same';
    if (row.includes('title="Előrébb lépett"'))  trend = 'up';
    if (row.includes('title="Hátrább lépett"')) trend = 'down';

    // ── Csapatnév ──
    const nameMatch = row.match(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/);
    if (!nameMatch) continue;
    const team = nameMatch[1].trim();

    // ── Logo ──
    const logoMatch = row.match(/src="(https:\/\/vgls\.betradar\.com\/ls\/s5_crest\/scigamingvirtuals\/medium\/\d+\.png)"/);
    const logo = logoMatch ? logoMatch[1] : null;

    // ── Statisztikák ──
    // Minden TD kinyerése osztályával + értékével
    const tdRe = /<td([^>]*)>\s*(-?\d+)\s*<\/td>/g;
    const tdList = [];
    let tm;
    while ((tm = tdRe.exec(row)) !== null) {
      tdList.push({ cls: tm[1], val: parseInt(tm[2]) });
    }
    if (tdList.length < 6) continue;

    // LG és KG a "hidden-xs-up visible-sm-up" osztályú TD-kben van
    const hiddenTds  = tdList.filter(t => t.cls.includes('hidden-xs-up'));
    const visibleTds = tdList.filter(t => !t.cls.includes('hidden-xs-up'));

    let goalsFor, goalsAgainst, pts;

    if (hiddenTds.length >= 2) {
      // Teljes nézet: LG=hiddenTds[0], KG=hiddenTds[1]
      // PTK = utolsó visible plain TD (a Forma előtt)
      goalsFor     = hiddenTds[0].val;
      goalsAgainst = hiddenTds[1].val;
      pts          = visibleTds[visibleTds.length - 1]?.val ?? 0;
    } else {
      // Szűkített nézet, index alapján:
      // 0=M 1=G 2=D 3=V 4=LG 5=KG 6=Gólk 7=PTK
      goalsFor     = tdList[4]?.val ?? 0;
      goalsAgainst = tdList[5]?.val ?? 0;
      pts          = tdList[7]?.val ?? tdList[tdList.length - 1]?.val ?? 0;
    }

    if (goalsFor < 0 || goalsAgainst < 0 || pts < 0) continue;

    standings.push({ pos, team, logo, goalsFor, goalsAgainst, pts, trend });
  }

  const seen = new Set();
  return standings
    .filter(r => { if (seen.has(r.pos)) return false; seen.add(r.pos); return true; })
    .sort((a, b) => a.pos - b.pos);
}
// ─────────────────────────────────────────────
// SPANYOL LIGA parser (schedulerzrh VSM widget)
// Valós struktúra:
//   <tr id="vsm-vflm-livetable-row-276513" class="vsm-livetable-row vsm-row-position-5">
//   Pozíció:  <span class="vsm-current">5</span>  (első ilyen a sorban)
//   Trend:    <i class="vsm-icon vsm-icon-position-up" title="7->5">
//             title="prev->curr" – kisebb curr = up
//   Csapat:   <td class="vsm-livetable-team"><span ...>VLC</span>
//   Gólok:    <td class="vsm-livetable-score">...<span class="vsm-current">29:26</span>
//   Pont:     <td class="vsm-livetable-points">...<span class="vsm-current">28</span>
// ─────────────────────────────────────────────
function parseSL(html) {
  const standings = [];

  // A sorok KÖZÖTT nincs sortörés – a TR-eket az id alapján vágjuk szét
  // Split megközelítés: megkeressük az összes TR kezdetét és tartalma a következő TR-ig tart
  const splitParts = html.split(/<tr\s+id="(vsm-vflm-livetable-row-\d+)"[^>]*>/);
  // splitParts: [előtte, id1, tartalom1, id2, tartalom2, ...]

  for (let i = 1; i < splitParts.length; i += 2) {
    // i = id, i+1 = tartalom (</tr>-ig)
    const rowRaw = splitParts[i + 1];
    if (!rowRaw) continue;
    // Levágjuk a </tr> utáni részt
    const row = rowRaw.split('</tr>')[0];

    // ── Pozíció ──
    const posM = row.match(/vsm-livetable-pos[\s\S]*?<span class="vsm-current"[^>]*>(\d+)<\/span>/);
    if (!posM) continue;
    const pos = parseInt(posM[1]);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;

    // ── Trend: title="prev-&gt;curr" ──
    let trend = 'same';
    const trendM = row.match(/title="(\d+)-&gt;(\d+)"/);
    if (trendM) {
      const prev = parseInt(trendM[1]), curr = parseInt(trendM[2]);
      trend = curr < prev ? 'up' : curr > prev ? 'down' : 'same';
    }

    // ── Csapatnév ──
    const teamM = row.match(/vsm-livetable-team[\s\S]*?<span[^>]*>([^<]{2,10})<\/span>/);
    if (!teamM) continue;
    const team = teamM[1].trim();
    if (!team) continue;

    // ── Gólok ──
    let goalsFor = 0, goalsAgainst = 0;
    const scoreM = row.match(/vsm-livetable-score[\s\S]*?<span class="vsm-current"[^>]*>(\d+):(\d+)<\/span>/);
    if (scoreM) {
      goalsFor = parseInt(scoreM[1]);
      goalsAgainst = parseInt(scoreM[2]);
    }

    // ── Pontok ──
    const ptsM = row.match(/vsm-livetable-points[\s\S]*?<span class="vsm-current"[^>]*>(\d+)<\/span>/);
    if (!ptsM) continue;
    const pts = parseInt(ptsM[1]);

    standings.push({ pos, team, logo: null, goalsFor, goalsAgainst, pts, trend });
  }

  const seen = new Set();
  return standings
    .filter(r => { if (seen.has(r.pos)) return false; seen.add(r.pos); return true; })
    .sort((a, b) => a.pos - b.pos);
}
// ─────────────────────────────────────────────
// FALLBACKEK
// ─────────────────────────────────────────────
const FALLBACK_PL = [
  { pos: 1,  team: 'Manchester Kék', goalsFor: 34, goalsAgainst: 20, pts: 38, trend: 'same', logo: null },
  { pos: 2,  team: 'Liverpool',       goalsFor: 30, goalsAgainst: 15, pts: 30, trend: 'up',   logo: null },
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
  { pos: 14, team: 'Aston Oroszlán',  goalsFor: 15, goalsAgainst: 29, pts: 16, trend: 'down', logo: null },
  { pos: 15, team: 'Brighton',        goalsFor: 13, goalsAgainst: 35, pts: 12, trend: 'same', logo: null },
  { pos: 16, team: 'Crystal Palace',  goalsFor: 12, goalsAgainst: 24, pts: 10, trend: 'same', logo: null },
];

const FALLBACK_SL = [
  { pos: 1,  team: 'MAF', goalsFor: 45, goalsAgainst: 22, pts: 46, trend: 'same', logo: null },
  { pos: 2,  team: 'SEP', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 3,  team: 'RSO', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 4,  team: 'BAR', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 5,  team: 'VLC', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 6,  team: 'GET', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 7,  team: 'SEZ', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 8,  team: 'VIL', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 9,  team: 'GIR', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 10, team: 'MAL', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 11, team: 'ALA', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 12, team: 'BIL', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 13, team: 'OSA', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 14, team: 'ELC', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 15, team: 'VIG', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
  { pos: 16, team: 'MAP', goalsFor: 0,  goalsAgainst: 0,  pts: 0,  trend: 'same', logo: null },
];

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────
export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=8, stale-while-revalidate=16',
  };

  const { searchParams } = new URL(req.url);
  const liga  = searchParams.get('liga') || 'pl';
  const debug = searchParams.get('debug') === '1';

  const srcUrl  = SOURCES[liga];
  const parser  = liga === 'sl' ? parseSL : parsePL;
  const fallback = liga === 'sl' ? FALLBACK_SL : FALLBACK_PL;

  if (!srcUrl) {
    return new Response(JSON.stringify({ standings: fallback, source: 'fallback' }), { status: 200, headers: corsHeaders });
  }

  // Build list of URLs to try
  const urlsToTry = [srcUrl];
  if (liga === 'sl') urlsToTry.push(...SL_EXTRA_ENDPOINTS);

  let lastErr = null;
  for (const tryUrl of urlsToTry) {
    try {
      const res = await fetch(tryUrl, {
        headers: { ...FETCH_HEADERS, 'Referer': 'https://schedulerzrh.aitcloud.de/' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { lastErr = `HTTP ${res.status} from ${tryUrl}`; continue; }

      const html = await res.text();

      // Quick check: does this page contain our rows?
      if (liga === 'sl' && !html.includes('vsm-vflm-livetable-row-')) {
        lastErr = `No vsm rows in ${tryUrl} (html len=${html.length})`;
        if (debug) console.log(`[SL debug] No rows at ${tryUrl}, snippet:`, html.slice(0, 500));
        continue;
      }

      const standings = parser(html);

      if (debug) {
        return new Response(
          JSON.stringify({ standings, source: standings.length >= 2 ? 'scrape' : 'parse_fail', usedUrl: tryUrl, rowCount: standings.length, htmlSnippet: html.slice(0, 8000) }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (standings.length >= 2) {
        return new Response(JSON.stringify({ standings, source: 'scrape', usedUrl: tryUrl }), { status: 200, headers: corsHeaders });
      }

      lastErr = `Parsed 0 rows from ${tryUrl}`;
    } catch (err) {
      lastErr = err.message;
    }
  }

  // All endpoints failed
  return new Response(
    JSON.stringify({ standings: fallback, source: 'fallback', error: lastErr }),
    { status: 200, headers: corsHeaders }
  );
}
