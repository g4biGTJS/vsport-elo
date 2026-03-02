// api/snapshot.js – Vercel Edge Function (cron által hívva 5 percenként)
// Lekéri az aktuális tabellát, elmenti Upstash Redis-be snapshot-ként.
// Szükséges env változók: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

export const config = { runtime: 'edge' };

const BASE_URL     = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';
const CATEGORY_URL = `${BASE_URL}/category/1111`;
const LEAGUE_NAME  = 'Virtuális Labdarúgás Liga Mód Retail';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'hu-HU,hu;q=0.9',
  'Referer': 'https://s5.sir.sportradar.com/',
};

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

// ── Upstash Redis helper ──────────────────────────────────────────────────────
async function kv(cmd, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash env vars missing');

  const res = await fetch(`${url}/${[cmd, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

// ── Season ID ─────────────────────────────────────────────────────────────────
async function findSeasonId() {
  const cached = await kv('GET', 'vsport:seasonId').catch(() => null);

  const res = await fetch(CATEGORY_URL, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return cached || '3061347';
  const html = await res.text();

  const linkRegex = new RegExp(
    `<a\\s+class="list-group-item"\\s+href="[^"]*/season/(\\d+)"[^>]*>\\s*<span\\s+class="vertical-align-middle">\\s*${LEAGUE_NAME}\\s*<\\/span>`,
    'i'
  );
  const match = html.match(linkRegex);
  let seasonId = match?.[1];

  if (!seasonId) {
    const allIds = [...html.matchAll(/\/season\/(\d+)/g)].map(m => parseInt(m[1])).filter(n => n > 1_000_000);
    if (allIds.length > 0) seasonId = String(Math.max(...allIds));
  }

  if (seasonId) await kv('SET', 'vsport:seasonId', seasonId).catch(() => {});
  return seasonId || cached || '3061347';
}

// ── Standings parser ──────────────────────────────────────────────────────────
function parsePL(html) {
  const standings = [];
  const parts = html.split(/<tr[^>]*>/);
  for (let i = 1; i < parts.length; i++) {
    const row = parts[i].split('</tr>')[0];
    const posMatch = row.match(/class="margin-left-medium[^"]*"[^>]*>\s*(\d+)\s*<\/div>/);
    if (!posMatch) continue;
    const pos = parseInt(posMatch[1]);
    if (isNaN(pos) || pos < 1 || pos > 30) continue;

    const nameMatch = row.match(/class="hidden-xs-up visible-sm-up wrap">([^<]+)<\/div>/);
    if (!nameMatch) continue;
    const team = nameMatch[1].trim();

    const logoMatch = row.match(/src="(https:\/\/vgls\.betradar\.com\/ls\/s5_crest\/scigamingvirtuals\/medium\/\d+\.png)"/);
    const logo = logoMatch ? logoMatch[1] : null;

    const tdRe = /<td([^>]*)>\s*(-?\d+)\s*<\/td>/g;
    const tdList = [];
    let tm;
    while ((tm = tdRe.exec(row)) !== null) tdList.push({ cls: tm[1], val: parseInt(tm[2]) });
    if (tdList.length < 6) continue;

    const hiddenTds  = tdList.filter(t => t.cls.includes('hidden-xs-up'));
    const visibleTds = tdList.filter(t => !t.cls.includes('hidden-xs-up'));
    let goalsFor, goalsAgainst, pts;
    if (hiddenTds.length >= 2) {
      goalsFor = hiddenTds[0].val; goalsAgainst = hiddenTds[1].val;
      pts = visibleTds[visibleTds.length - 1]?.val ?? 0;
    } else {
      goalsFor = tdList[4]?.val ?? 0; goalsAgainst = tdList[5]?.val ?? 0;
      pts = tdList[7]?.val ?? tdList[tdList.length - 1]?.val ?? 0;
    }
    if (goalsFor < 0 || goalsAgainst < 0 || pts < 0) continue;
    standings.push({ pos, team, logo, goalsFor, goalsAgainst, pts, trend: 'same' });
  }
  const seen = new Set();
  return standings
    .filter(r => { if (seen.has(r.pos)) return false; seen.add(r.pos); return true; })
    .sort((a, b) => a.pos - b.pos);
}

// ── Save snapshot to Redis ────────────────────────────────────────────────────
async function saveSnapshot(standings, seasonId) {
  if (!standings || !standings.length) return false;

  // Load existing history
  let history;
  try {
    const raw = await kv('GET', 'vsport:history');
    history = raw ? JSON.parse(raw) : { seasonId: null, snapshots: [] };
  } catch (e) {
    history = { seasonId: null, snapshots: [] };
  }

  // Season reset detection
  const totalPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const lastTotal = history.snapshots.length
    ? history.snapshots[history.snapshots.length - 1].standings.reduce((s, t) => s + t.pts, 0)
    : null;

  const seasonChanged = seasonId && history.seasonId && seasonId !== history.seasonId;
  const ptsCrashed    = lastTotal !== null && lastTotal > 100 && totalPts < lastTotal * 0.3;
  const newStart      = totalPts === 0;

  if (seasonChanged || ptsCrashed || newStart) {
    history = { seasonId, snapshots: [] };
  }
  if (seasonId) history.seasonId = seasonId;

  // Only save if standings changed
  const last = history.snapshots[history.snapshots.length - 1];
  if (last) {
    const changed = standings.some(t => {
      const prev = last.standings.find(p => p.team === t.team);
      if (!prev) return true;
      return prev.pts !== t.pts || prev.goalsFor !== t.goalsFor || prev.goalsAgainst !== t.goalsAgainst;
    });
    if (!changed) return false; // semmi új, nem mentjük
  }

  history.snapshots.push({
    ts: Date.now(),
    standings: standings.map(t => ({
      team: t.team, pos: t.pos,
      pts: t.pts || 0,
      goalsFor: t.goalsFor || 0,
      goalsAgainst: t.goalsAgainst || 0,
      logo: t.logo || null,
    })),
  });

  // Max 500 snapshot
  if (history.snapshots.length > 500) history.snapshots = history.snapshots.slice(-500);

  // Save – Upstash max value ~1MB, JSON tömörítés nélkül elég
  await kv('SET', 'vsport:history', JSON.stringify(history));
  return true;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  try {
    const seasonId = await findSeasonId();
    const standingsUrl = `${BASE_URL}/season/${seasonId}`;

    const res = await fetch(standingsUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Standings fetch failed: HTTP ${res.status}`);

    const html      = await res.text();
    const standings = parsePL(html);

    if (standings.length < 2) throw new Error('Nem sikerült tabellát parsolni');

    const saved = await saveSnapshot(standings, seasonId);

    return new Response(JSON.stringify({
      ok: true,
      saved,
      seasonId,
      rows: standings.length,
      ts: Date.now(),
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[snapshot] Error:', error.message);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 200, headers: corsHeaders });
  }
}
