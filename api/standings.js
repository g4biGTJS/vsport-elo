// api/standings.js – Vercel Edge Function
// Premier Liga: s5.sir.sportradar.com HTML scrape
// Automatikus szezon ID felderítéssel

export const config = { runtime: 'edge' };

const BASE_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;
const LEAGUE_NAME = 'Virtuális Labdarúgás Liga Mód Retail';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
};

// Cache a legutóbb talált szezon ID-nak
let currentSeasonId = '3061057'; // Alapértelmezett (jelenlegi)
let lastCategoryCheck = 0;
const CHECK_INTERVAL = 120000; // 2 perc (120 000 ms)

// ─────────────────────────────────────────────────────────────
// Új szezon ID felderítése a kategória oldalról
// ─────────────────────────────────────────────────────────────
async function findCurrentSeasonId() {
  const now = Date.now();
  // Ha 2 percen belül már ellenőriztük, használjuk a cache-elt értéket
  if (now - lastCategoryCheck < CHECK_INTERVAL) {
    return currentSeasonId;
  }

  try {
    console.log(`[SeasonCheck] Checking for new season at ${CATEGORY_URL}`);
    const res = await fetch(CATEGORY_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    // Keresés: <a class="list-group-item" href="/scigamingvirtuals/hu/1/season/3061057"><span class="vertical-align-middle">Virtuális Labdarúgás Liga Mód Retail</span></a>
    // Pontosabb regex: megkeresi a linket, ami a LEAGUE_NAME-t tartalmazza, és kinyeri az ID-t
    const linkRegex = new RegExp(`<a\\s+class="list-group-item"\\s+href="[^"]*/season/(\\d+)"[^>]*>\\s*<span\\s+class="vertical-align-middle">\\s*${LEAGUE_NAME}\\s*<\\/span>`, 'i');
    const match = html.match(linkRegex);

    if (match && match[1]) {
      const newId = match[1];
      if (newId !== currentSeasonId) {
        console.log(`[SeasonCheck] New season detected! ID changed from ${currentSeasonId} to ${newId}`);
        currentSeasonId = newId;
      } else {
        console.log(`[SeasonCheck] Season ID unchanged: ${currentSeasonId}`);
      }
    } else {
      console.warn(`[SeasonCheck] Could not find league "${LEAGUE_NAME}" on category page. Keeping ID: ${currentSeasonId}`);
    }

    lastCategoryCheck = now;
    return currentSeasonId;

  } catch (error) {
    console.error(`[SeasonCheck] Error checking category page: ${error.message}. Using cached ID: ${currentSeasonId}`);
    // Hiba esetén a legutolsó ismert ID-t használjuk
    lastCategoryCheck = now; // Megjegyezzük, hogy próbálkoztunk, ne próbálja újra azonnal
    return currentSeasonId;
  }
}

// ─────────────────────────────────────────────
// PREMIER LIGA parser (s5.sir.sportradar.com)
// (A parser függvény változatlan marad, de a forrás URL-t dinamikusan kapja)
// ─────────────────────────────────────────────
function parsePL(html) {
  const standings = [];
  const parts = html.split(/<tr[^>]*>/);

  for (let i = 1; i < parts.length; i++) {
    const row = parts[i].split('</tr>')[0];

    const posMatch = row.match(/class="margin-left-medium[^"]*"[^>]*>\s*(\d+)\s*<\/div>/);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;

    let trend = 'same';
    if (row.includes('title="Előrébb lépett"'))  trend = 'up';
    if (row.includes('title="Hátrább lépett"')) trend = 'down';

    const nameMatch = row.match(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/);
    if (!nameMatch) continue;
    const team = nameMatch[1].trim();

    const logoMatch = row.match(/src="(https:\/\/vgls\.betradar\.com\/ls\/s5_crest\/scigamingvirtuals\/medium\/\d+\.png)"/);
    const logo = logoMatch ? logoMatch[1] : null;

    const tdRe = /<td([^>]*)>\s*(-?\d+)\s*<\/td>/g;
    const tdList = [];
    let tm;
    while ((tm = tdRe.exec(row)) !== null) {
      tdList.push({ cls: tm[1], val: parseInt(tm[2]) });
    }
    if (tdList.length < 6) continue;

    const hiddenTds  = tdList.filter(t => t.cls.includes('hidden-xs-up'));
    const visibleTds = tdList.filter(t => !t.cls.includes('hidden-xs-up'));

    let goalsFor, goalsAgainst, pts;

    if (hiddenTds.length >= 2) {
      goalsFor     = hiddenTds[0].val;
      goalsAgainst = hiddenTds[1].val;
      pts          = visibleTds[visibleTds.length - 1]?.val ?? 0;
    } else {
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

// (A parseSL függvény változatlan marad, mert az más forrást használ)
function parseSL(html) {
  // ... (A meglévő parseSL függvény tartalma) ...
  // A helytakarékosság miatt itt nincs újra bemásolva, de a fájlban benne kell hagyni.
  const standings = [];
  const splitParts = html.split(/<tr\s+id="(vsm-vflm-livetable-row-\d+)"[^>]*>/);
  for (let i = 1; i < splitParts.length; i += 2) {
    const rowRaw = splitParts[i + 1];
    if (!rowRaw) continue;
    const row = rowRaw.split('</tr>')[0];
    const posM = row.match(/vsm-livetable-pos[\s\S]*?<span class="vsm-current"[^>]*>(\d+)<\/span>/);
    if (!posM) continue;
    const pos = parseInt(posM[1]);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;
    let trend = 'same';
    const trendM = row.match(/title="(\d+)-&gt;(\d+)"/);
    if (trendM) {
      const prev = parseInt(trendM[1]), curr = parseInt(trendM[2]);
      trend = curr < prev ? 'up' : curr > prev ? 'down' : 'same';
    }
    const teamM = row.match(/vsm-livetable-team[\s\S]*?<span[^>]*>([^<]{2,10})<\/span>/);
    if (!teamM) continue;
    const team = teamM[1].trim();
    if (!team) continue;
    let goalsFor = 0, goalsAgainst = 0;
    const scoreM = row.match(/vsm-livetable-score[\s\S]*?<span class="vsm-current"[^>]*>(\d+):(\d+)<\/span>/);
    if (scoreM) {
      goalsFor = parseInt(scoreM[1]);
      goalsAgainst = parseInt(scoreM[2]);
    }
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

// Fallback adatok (változatlanok)
const FALLBACK_PL = [ /* ... (a meglévő FALLBACK_PL) ... */ ];
const FALLBACK_SL = [ /* ... (a meglévő FALLBACK_SL) ... */ ];

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

  // --- PL Specifikus logika: Dinamikus szezon ID ---
  let srcUrl;
  if (liga === 'pl') {
    const seasonId = await findCurrentSeasonId();
    srcUrl = `https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/${seasonId}`;
    console.log(`[Handler] Using PL URL: ${srcUrl}`);
  } else {
    // SL esetén a meglévő SOURCES objektumot használjuk
    srcUrl = SOURCES.sl;
  }

  const parser  = liga === 'sl' ? parseSL : parsePL;
  const fallback = liga === 'sl' ? FALLBACK_SL : FALLBACK_PL;

  if (!srcUrl) {
    return new Response(JSON.stringify({ standings: fallback, source: 'fallback' }), { status: 200, headers: corsHeaders });
  }

  // URL-ek listájának építése (PL-nél csak egy van, SL-nél több)
  const urlsToTry = [srcUrl];
  if (liga === 'sl') {
    // Hozzávesszük az extra SL endpointokat is
    urlsToTry.push(...[
      'https://schedulerzrh.aitcloud.de/retail_scheduler/widget/livetable/schedule:f94efd4aed2cae288d1ab3abaf828b38',
      'https://schedulerzrh.aitcloud.de/retail_scheduler/display/livetable/schedule:f94efd4aed2cae288d1ab3abaf828b38',
      'https://schedulerzrh.aitcloud.de/retail_scheduler/livetable/f94efd4aed2cae288d1ab3abaf828b38',
    ]);
  }

  let lastErr = null;
  for (const tryUrl of urlsToTry) {
    try {
      const res = await fetch(tryUrl, {
        headers: { ...FETCH_HEADERS, 'Referer': 'https://schedulerzrh.aitcloud.de/' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { lastErr = `HTTP ${res.status} from ${tryUrl}`; continue; }

      const html = await res.text();

      if (liga === 'sl' && !html.includes('vsm-vflm-livetable-row-')) {
        lastErr = `No vsm rows in ${tryUrl}`;
        continue;
      }

      const standings = parser(html);

      if (debug) {
        return new Response(
          JSON.stringify({ standings, source: 'scrape', usedUrl: tryUrl, rowCount: standings.length, htmlSnippet: html.slice(0, 2000) }),
          { status: 200, headers: corsHeaders }
        );
      }

      if (standings.length >= 2) {
        // Siker esetén visszaküldjük a standings mellett a jelenlegi szezon ID-t is (opcionális, de hasznos lehet)
        const responseBody = {
          standings,
          source: 'scrape',
          usedUrl: tryUrl,
          ...(liga === 'pl' && { seasonId: currentSeasonId }) // Csak PL-nél adjuk hozzá
        };
        return new Response(JSON.stringify(responseBody), { status: 200, headers: corsHeaders });
      }

      lastErr = `Parsed 0 rows from ${tryUrl}`;
    } catch (err) {
      lastErr = err.message;
    }
  }

  // Minden próbálkozás sikertelen
  return new Response(
    JSON.stringify({ standings: fallback, source: 'fallback', error: lastErr }),
    { status: 200, headers: corsHeaders }
  );
}
