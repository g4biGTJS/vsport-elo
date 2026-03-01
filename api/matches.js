// api/matches.js – Vercel Edge Function v5
// A valódi HTML struktúra: sima <tr><td> sorok
// Egy sor: [VLLM|14] [Crystal Palace] [03:59 / -:-] [Wolverhampton]
// hasVLLM=true, hasCursorTR=false, hasFormCell=false → sima TR/TD!

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

// Kiszedi a látható szöveget egy HTML darabból (tagek nélkül)
function innerText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Logo ID kinyerése
function extractLogoIds(chunk) {
  const ids = [];
  for (const m of chunk.matchAll(/\/(?:medium|small|big)\/(\d{5,7})\.png/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// Csapatneveket kinyerése több mintával
function extractTeamNames(chunk) {
  // 1. hidden-xs-up (eredeti sportradar)
  const long = [...chunk.matchAll(/class="hidden-xs-up visible-sm-up wrap">\s*([^<]+?)\s*<\/div>/g)]
    .map(m => m[1].trim()).filter(Boolean);
  if (long.length >= 2) return long;

  // 2. Bármilyen inline szöveg TD-ben (fallback)
  // A TD tartalmát text-ként olvassuk
  const text = innerText(chunk);
  return [];
}

// Deduplikáció kulcs
function matchKey(home, away) {
  return [home, away].sort().join('|||');
}

// ─── FŐ PARSER: sima TR/TD struktúra ─────────────────────────────
// Struktúra a képből:
// <tr>
//   <td>VLLM\n14</td>          ← BAJ/F/K oszlop: liga rövidítés + forduló
//   <td>Crystal Palace</td>    ← hazai csapat
//   <td>03:59\n- : -</td>      ← idő + eredmény
//   <td>Wolverhampton</td>     ← vendég csapat
// </tr>
function parsePlainTR(html) {
  const upcoming = [];
  const results = [];
  const seenKeys = new Set();

  // Az összes TR sort feldolgozzuk
  // Több split minta: <tr>, <tr class="...">, <tr id="...">
  const trSections = html.split(/<tr[\s>]/);

  for (let i = 1; i < trSections.length; i++) {
    const tr = trSections[i].split('</tr>')[0];

    // Csak azok a sorok érdekelnek amelyek VLLM-et tartalmaznak
    if (!tr.includes('VLLM')) continue;

    // TD cellák kinyerése
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(tr)) !== null) {
      tds.push(tdMatch[1]);
    }

    if (tds.length < 3) continue;

    // Forduló keresése: az a TD ami VLLM-et tartalmaz
    let round = null;
    let homeIdx = -1, awayIdx = -1, centerIdx = -1;

    for (let t = 0; t < tds.length; t++) {
      const txt = innerText(tds[t]);
      if (txt.includes('VLLM')) {
        // Forduló szám: szám az ugyanebben a TD-ben
        const roundM = txt.match(/(\d+)/);
        if (roundM) round = parseInt(roundM[1]);
      }
    }

    // Ha nincs forduló, skip
    if (!round) continue;

    // Csapatnevek és középső (idő/eredmény) TD azonosítása
    // Stratégia: a középső TD időt tartalmaz (HH:MM formátum)
    // A hazai TD az idő előtt, a vendég TD az idő után van
    for (let t = 0; t < tds.length; t++) {
      const txt = innerText(tds[t]);
      if (/\d{1,2}:\d{2}/.test(txt) && (txt.includes('-') || /\d+\s*:\s*\d+/.test(txt))) {
        centerIdx = t;
        homeIdx = t - 1;
        awayIdx = t + 1;
        break;
      }
    }

    if (homeIdx < 0 || awayIdx >= tds.length || centerIdx < 0) continue;

    const home = innerText(tds[homeIdx]).trim();
    const away = innerText(tds[awayIdx]).trim();
    const center = innerText(tds[centerIdx]);

    if (!home || !away || home.length < 2 || away.length < 2) continue;
    // Kiszűrjük ha a "csapatnév" csak szám vagy fejléc szöveg
    if (/^[\d\s:.-]+$/.test(home) || /^[\d\s:.-]+$/.test(away)) continue;

    const key = matchKey(home, away);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Idő kinyerése
    const timeM = center.match(/(\d{1,2}:\d{2})/);
    const time = timeM ? timeM[1] : null;

    // Logo ID-k a teljes TR-ből
    const logoIds = extractLogoIds(tr);

    // Eredmény: dash = upcoming, szám:szám = played
    const isDash = center.includes('- : -') || center.includes('-:-') ||
                   /^[\s\d:.-]*-[\s\d:.-]*$/.test(center.replace(/\d{1,2}:\d{2}/, ''));
    const scoreMatch = center.match(/(\d+)\s*:\s*(\d+)(?!\d)/);  // pl. "2 : 1" de nem "03:59"

    const entry = {
      round,
      home,
      away,
      hid: logoIds[0] || null,
      aid: logoIds[1] || null,
      time,
    };

    if (isDash && !scoreMatch) {
      upcoming.push({ ...entry, upcoming: true });
    } else if (scoreMatch) {
      results.push({ ...entry, upcoming: false, hs: parseInt(scoreMatch[1]), as: parseInt(scoreMatch[2]) });
    } else if (isDash) {
      upcoming.push({ ...entry, upcoming: true });
    }
  }

  return { results, upcoming };
}

// ─── FALLBACK: VLLM blokkok keresése ──────────────────────────────
// Ha a fenti sem működik, keressük a VLLM szó körüli szövegblokkokat
function parseVLLMBlocks(html) {
  const upcoming = [];
  const results = [];
  const seenKeys = new Set();

  // Minden VLLM előfordulás körüli ~500 karakter
  const regex = /VLLM[\s\S]{0,600}/g;
  let m;

  while ((m = regex.exec(html)) !== null) {
    const block = m[0];

    // Forduló szám
    const roundM = block.match(/VLLM[\s<>/\w"=]*?(\d+)/);
    if (!roundM) continue;
    const round = parseInt(roundM[1]);
    if (round < 1 || round > 999) continue;

    // Idő
    const timeM = block.match(/(\d{1,2}:\d{2})/g);
    if (!timeM || timeM.length === 0) continue;

    // Az első idő adat a meccs ideje (nem a vegeredmény ami szintén HH:MM alakú lehet)
    // Keresünk 03:xx típusú időt (virtuális liga ~4 perces meccsek)
    const matchTime = timeM.find(t => {
      const mins = parseInt(t.split(':')[0]);
      return mins >= 0 && mins <= 10; // virtuális meccs max ~10 perc visszaszámláló
    }) || timeM[0];

    // Szöveg az egész blokkból
    const text = innerText(block);

    // Csapatneveket próbálunk kinyerni: az idő előtt és után lévő szavak
    const timePos = text.indexOf(matchTime);
    if (timePos < 0) continue;

    const before = text.slice(0, timePos).trim();
    const after = text.slice(timePos + matchTime.length).trim();

    // Utolsó "szó" a before részből = hazai csapat
    const beforeWords = before.split(/\s{2,}|\n/).map(s => s.trim()).filter(s => s.length > 2 && !/^\d+$/.test(s));
    const afterWords = after.split(/\s{2,}|\n/).map(s => s.trim()).filter(s => s.length > 2 && !/^\d+$/.test(s));

    if (beforeWords.length === 0 || afterWords.length === 0) continue;

    const home = beforeWords[beforeWords.length - 1];
    const away = afterWords[0];

    if (!home || !away) continue;

    const key = matchKey(home, away);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Eredmény
    const afterScore = after.slice(away.length).trim();
    const scoreMatch = afterScore.match(/^(\d+)\s*:\s*(\d+)/);
    const hasDash = after.includes('- :') || after.includes('- : -');

    const logoIds = extractLogoIds(block);
    const entry = { round, home, away, hid: logoIds[0]||null, aid: logoIds[1]||null, time: matchTime };

    if (hasDash && !scoreMatch) upcoming.push({ ...entry, upcoming: true });
    else if (scoreMatch) results.push({ ...entry, upcoming: false, hs: parseInt(scoreMatch[1]), as: parseInt(scoreMatch[2]) });
    else if (hasDash) upcoming.push({ ...entry, upcoming: true });
  }

  return { results, upcoming };
}

// ─── KOMBINÁLT PARSER ─────────────────────────────────────────────
function parseMatches(html) {
  // 1. Sima TR/TD struktúra
  const plain = parsePlainTR(html);
  if (plain.results.length + plain.upcoming.length >= 3) {
    return { ...plain, method: 'plain-tr' };
  }

  // 2. VLLM blokk kereső
  const vllm = parseVLLMBlocks(html);
  if (vllm.results.length + vllm.upcoming.length >= 3) {
    return { ...vllm, method: 'vllm-blocks' };
  }

  // Ha valamelyik talált valamit (akár <3 meccset)
  if (plain.upcoming.length > 0) return { ...plain, method: 'plain-tr-partial' };
  if (vllm.upcoming.length > 0) return { ...vllm, method: 'vllm-blocks-partial' };

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

    // VLLM körüli snippet mindig
    let vllmSnippet = null;
    if (hasVLLM) {
      const idx = html.indexOf('VLLM');
      vllmSnippet = html.slice(Math.max(0, idx - 200), idx + 600);
    }

    if (debug) {
      const parsed = parseMatches(html);

      // Első TR ami VLLM-et tartalmaz
      let vllmTRSnippet = null;
      const trIdx = html.search(/<tr[\s>][^<]*VLLM|<tr[\s>][\s\S]{0,500}?VLLM/);
      if (trIdx >= 0) vllmTRSnippet = html.slice(trIdx, trIdx + 800);

      return new Response(JSON.stringify({
        htmlLen, hasVLLM, hasCursorTR, hasFormCell,
        method: parsed.method,
        totalResults: parsed.results.length,
        totalUpcoming: parsed.upcoming.length,
        results: parsed.results.slice(0, 3),
        upcoming: parsed.upcoming.slice(0, 5),
        // Leghasznosabb debug infó:
        vllmSnippet,           // VLLM körüli ~800 karakter
        vllmTRSnippet,         // Első VLLM-et tartalmazó TR
        htmlStart: html.slice(0, 300),
      }), { status: 200, headers: corsHeaders });
    }

    if (!hasVLLM) {
      return new Response(JSON.stringify({
        error: `Nincs VLLM a HTML-ben (len=${htmlLen}) – valószínűleg JS bundle`,
        hint: 'Try /api/matches?debug=1',
        recentResults: [], nextFixtures: [], nextRound: null, lastRound: null, source: 'error',
      }), { status: 200, headers: corsHeaders });
    }

    const parsed = parseMatches(html);

    if (parsed.results.length === 0 && parsed.upcoming.length === 0) {
      return new Response(JSON.stringify({
        error: `0 meccs (method=${parsed.method})`,
        vllmSnippet,
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
