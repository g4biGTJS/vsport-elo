// api/matches.js – Vercel Edge Function
// Scrape-eli a sportradar Premier Liga season oldalát
// Visszaadja: az utolsó 2-3 lejátszott forduló eredményeit + a következő forduló meccseit

export const config = { runtime: 'edge' };

const SEASON_URL = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1/season/3061057';
const LOGO_BASE  = 'https://vgls.betradar.com/ls/s5_crest/scigamingvirtuals/medium/';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
};

// ─────────────────────────────────────────────────────────────────
// HTML PARSER
// Struktúra (a tényleges HTML snippetek alapján):
//
// <tr class="cursor-pointer">
//   <td ...> <div title="Virtuális...">VLLM</div><div title="">21</div> </td>  ← round szám
//   <td class="divide text-center">
//     <div class="row flex-items-xs-middle">
//       <div class="col-xs-4 [win-color]">   ← hazai (win-color = győztes)
//         <div class="hidden-xs-up visible-sm-up wrap">Manchester Kék</div>
//         <img src="...276510.png">
//       </div>
//       <div class="col-xs-4">
//         <div>20:26</div>                    ← idő
//         <div aria-label="Eredm.">
//           <div class="inline-block [win-color]">2</div> : <div>1</div>  ← eredmény
//           VAGY: <div>-</div> : <div>-</div>                             ← nincs eredmény
//         </div>
//       </div>
//       <div class="col-xs-4 [win-color]">   ← vendég
//         <img src="...276501.png">
//         <div class="hidden-xs-up visible-sm-up wrap">Everton</div>
//       </div>
//     </div>
//   </td>
// </tr>
// ─────────────────────────────────────────────────────────────────
function parseMatches(html) {
  const results = [];   // lejátszott meccsek
  const upcoming = [];  // következő meccsek

  // Minden TR-t feldolgozunk
  const trParts = html.split(/<tr[^>]*class="cursor-pointer"[^>]*>/);

  for (let i = 1; i < trParts.length; i++) {
    const row = trParts[i].split('</tr>')[0];

    // ── Forduló szám ──
    // <div title="">21</div>  (a VLLM div után következik)
    const roundM = row.match(/>VLLM<\/div>\s*<div[^>]*>(\d+)<\/div>/);
    if (!roundM) continue;
    const round = parseInt(roundM[1]);
    if (isNaN(round)) continue;

    // ── Hazai és vendég csapat neve ──
    const teamNames = [];
    const nameRe = /class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/g;
    let nm;
    while ((nm = nameRe.exec(row)) !== null) {
      teamNames.push(nm[1].trim());
    }
    if (teamNames.length < 2) continue;
    const [home, away] = teamNames;

    // ── Logo ID-k (276XXX) ──
    const logoIds = [];
    const logoRe = /\/medium\/(\d+)\.png/g;
    let lm;
    while ((lm = logoRe.exec(row)) !== null) {
      if (!logoIds.includes(lm[1])) logoIds.push(lm[1]);
    }

    // ── Eredmény: van-e konkrét szám? ──
    // aria-label="Eredm." utáni részből kinyerjük
    const scoreSection = row.match(/aria-label="Eredm\."([^]*?)(?=<div class="col-xs-4 )/)?.[1] || '';

    // Keressük a konkrét számokat (nem dash)
    const scoreNums = [...scoreSection.matchAll(/<div class="inline-block[^"]*">\s*(\d+)\s*<sup>/g)].map(m => parseInt(m[1]));

    // Idő az eredmény blokk előtt
    const timeM = row.match(/<div class="text-center">\s*(\d{1,2}:\d{2})\s*<\/div>/);
    const time = timeM ? timeM[1] : null;

    const hid = logoIds[0] || null;
    const aid = logoIds[1] || null;

    if (scoreNums.length >= 2) {
      // Lejátszott meccs
      const hs = scoreNums[0];
      const as_ = scoreNums[1];
      results.push({ round, home, away, hid, aid, hs, as: as_, time });
    } else {
      // Következő meccs (nincs eredmény)
      upcoming.push({ round, home, away, hid, aid, time });
    }
  }

  return { results, upcoming };
}

// ─────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
  };

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get('debug') === '1';

  try {
    const res = await fetch(SEASON_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `HTTP ${res.status}`, results: [], upcoming: [] }),
        { status: 200, headers: corsHeaders }
      );
    }

    const html = await res.text();
    const { results, upcoming } = parseMatches(html);

    // Utolsó 2-3 forduló eredményeit adjuk vissza (legújabbtól)
    const rounds = [...new Set(results.map(m => m.round))].sort((a, b) => b - a);
    const lastRounds = rounds.slice(0, 3);
    const recentResults = results.filter(m => lastRounds.includes(m.round));

    // Következő forduló (legkisebb round szám az upcomingban)
    const nextRounds = [...new Set(upcoming.map(m => m.round))].sort((a, b) => a - b);
    const nextRound = nextRounds[0];
    const nextFixtures = upcoming.filter(m => m.round === nextRound);

    if (debug) {
      return new Response(
        JSON.stringify({
          totalResults: results.length,
          totalUpcoming: upcoming.length,
          availableRounds: rounds,
          nextRound,
          recentResults,
          nextFixtures,
          htmlLen: html.length,
          htmlSnippet: html.slice(0, 3000),
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        recentResults,
        nextFixtures,
        nextRound,
        lastRound: lastRounds[0] ?? null,
        source: results.length > 0 ? 'scrape' : 'empty',
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message, results: [], upcoming: [] }),
      { status: 200, headers: corsHeaders }
    );
  }
}
