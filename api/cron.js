// api/cron.js – Háttér cron job (Vercel Cron)
// Minden 10 percben fut – senki se figyeli az oldalt, mégis menti a history-t és frissíti az AI-t
// Vercel Cron: ingyenes plan = max 2 cron / nap, Pro = percenként is futhat

export const config = { runtime: 'edge' };

const BASE_URL      = 'https://vsport-elo.vercel.app/tippek.html'; // ← CSERÉLD KI a saját Vercel URL-edre!
const CRON_SECRET   = process.env.CRON_SECRET || '';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ── KV helpers ────────────────────────────────────────────────────────────────
function kvUrl(path) {
  const base = process.env.KV_REST_API_URL;
  if (!base) throw new Error('KV_REST_API_URL nincs beállítva');
  return `${base}${path}`;
}
function kvHeaders() {
  const token = process.env.KV_REST_API_TOKEN;
  if (!token) throw new Error('KV_REST_API_TOKEN nincs beállítva');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function kvGet(key) {
  try {
    const res = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), {
      headers: kvHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.result ?? null;
    if (result === null) return null;
    if (typeof result === 'object' && result.value !== undefined) {
      return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    }
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
  } catch { return null; }
}
async function kvSet(key, value) {
  const res = await fetch(kvUrl('/pipeline'), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KV SET hiba: ${res.status}`);
  return true;
}

// ── Fingerprint – UGYANOLYAN mint a kliensben ─────────────────────────────────
function calcFP(standings) {
  return standings.map(t => `${t.pos}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ── Standings lekérése saját API-ból ─────────────────────────────────────────
async function fetchStandings() {
  const res = await fetch(`${BASE_URL}/api/standings?liga=pl`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Standings API hiba: ${res.status}`);
  const data = await res.json();
  if (!data.standings || data.standings.length < 2) throw new Error('Üres standings válasz');
  return { standings: data.standings, seasonId: data.seasonId || null };
}

// ── Változás detektálás ───────────────────────────────────────────────────────
const CRON_STATE_KEY = 'vsport:cron_state';

async function loadCronState() {
  const raw = await kvGet(CRON_STATE_KEY);
  if (!raw) return { lastFP: null, lastTotalPts: null, lastSeasonId: null, lastStandings: [] };
  try { return JSON.parse(raw); } catch { return { lastFP: null, lastTotalPts: null, lastSeasonId: null, lastStandings: [] }; }
}
async function saveCronState(state) {
  await kvSet(CRON_STATE_KEY, JSON.stringify(state));
}

function detectChangeType(newStandings, newSeasonId, state) {
  const newFP = calcFP(newStandings);
  const newTotalPts = newStandings.reduce((s, t) => s + (t.pts || 0), 0);

  // Szezonváltás detektálás
  if (newSeasonId && state.lastSeasonId && String(newSeasonId) !== String(state.lastSeasonId)) {
    return 'season';
  }
  // Pontösszeg drasztikus csökkenés = új szezon
  if (state.lastTotalPts !== null && state.lastTotalPts > 100 && newTotalPts < state.lastTotalPts * 0.3) {
    return 'season';
  }
  // Forduló változás
  if (state.lastFP !== null && state.lastFP !== newFP) {
    return 'round';
  }
  return null;
}

// ── History entry mentés ──────────────────────────────────────────────────────
const HISTORY_KEY = 'vsport:league_history';
const MAX_ENTRIES = 150;

async function saveHistoryEntry(prevStandings, newStandings, changeType, seasonId) {
  const movers = [];
  newStandings.forEach(t => {
    const p = prevStandings.find(x => x.team === t.team);
    if (p) {
      const ptsDiff = (t.pts || 0) - (p.pts || 0);
      if (p.pos !== t.pos || ptsDiff !== 0) {
        movers.push({
          team: t.team, fromPos: p.pos, toPos: t.pos,
          ptsDiff, dir: t.pos < p.pos ? 'up' : (t.pos > p.pos ? 'down' : 'same'),
        });
      }
    }
  });

  const fullSnapshot = newStandings.map(t => ({
    pos: t.pos, team: t.team,
    pts: t.pts || 0, goalsFor: t.goalsFor || 0, goalsAgainst: t.goalsAgainst || 0,
    gd: (t.goalsFor || 0) - (t.goalsAgainst || 0),
    trend: t.trend || 'same', logo: t.logo || null,
  }));

  const entry = {
    fingerprint: calcFP(newStandings),
    timestamp: new Date().toISOString(),
    seasonId: seasonId || '?',
    changeType,
    totalPts: newStandings.reduce((s, t) => s + (t.pts || 0), 0),
    totalGoalsFor: newStandings.reduce((s, t) => s + (t.goalsFor || 0), 0),
    totalGoalsAgainst: newStandings.reduce((s, t) => s + (t.goalsAgainst || 0), 0),
    teamCount: newStandings.length,
    top3: newStandings.slice(0, 3).map(t => ({ pos: t.pos, team: t.team, pts: t.pts || 0, goalsFor: t.goalsFor || 0, goalsAgainst: t.goalsAgainst || 0 })),
    bottom3: newStandings.slice(-3).map(t => ({ pos: t.pos, team: t.team, pts: t.pts || 0 })),
    movers,
    standingsSnapshot: fullSnapshot,
  };

  // Duplikáció ellenőrzés
  const raw = await kvGet(HISTORY_KEY);
  let entries = [];
  if (raw) { try { entries = JSON.parse(raw); } catch { entries = []; } }

  const exists = entries.some(e =>
    e.fingerprint === entry.fingerprint &&
    String(e.seasonId || '?') === String(entry.seasonId || '?')
  );
  if (exists) return { saved: false, reason: 'duplicate' };

  entries.unshift(entry);
  const trimmed = entries.slice(0, MAX_ENTRIES);
  await kvSet(HISTORY_KEY, JSON.stringify(trimmed));
  return { saved: true, count: trimmed.length };
}

// ── AI generálás triggere ─────────────────────────────────────────────────────
async function triggerAIGeneration(standings, seasonId, force = false) {
  const res = await fetch(`${BASE_URL}/api/ai-prediction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ standings, seasonId, force }),
    signal: AbortSignal.timeout(60000), // AI lassabb lehet
  });
  if (!res.ok) throw new Error(`AI API hiba: ${res.status}`);
  return res.json();
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req) {

  // Biztonsági ellenőrzés: csak Vercel Cron vagy titkos kulccsal hívható
  // Vercel automatikusan küldi az Authorization: Bearer <CRON_SECRET> fejlécet
  const authHeader = req.headers.get('authorization') || '';
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: corsHeaders,
    });
  }

  const log = [];
  const now = new Date().toISOString();
  log.push(`[cron] Start: ${now}`);

  try {
    // 1. Standings lekérése
    const { standings, seasonId } = await fetchStandings();
    log.push(`[cron] Standings OK: ${standings.length} csapat, seasonId=${seasonId}`);

    // 2. Előző állapot betöltése
    const state = await loadCronState();
    log.push(`[cron] State: lastFP=${state.lastFP?.slice(0, 40) || 'none'}, lastSeasonId=${state.lastSeasonId}`);

    // 3. Változás detektálás
    const changeType = detectChangeType(standings, seasonId, state);
    log.push(`[cron] ChangeType: ${changeType || 'none'}`);

    let historySaved = false;
    let aiTriggered = false;

    if (changeType) {
      // 4a. History mentés (ha van előző állapot)
      if (state.lastStandings && state.lastStandings.length > 0) {
        const histResult = await saveHistoryEntry(state.lastStandings, standings, changeType, seasonId);
        historySaved = histResult.saved;
        log.push(`[cron] History: ${histResult.saved ? `saved (total: ${histResult.count})` : `skip (${histResult.reason})`}`);
      } else {
        log.push('[cron] History: skip (no previous state)');
      }

      // 4b. AI generálás trigger
      try {
        const aiResult = await triggerAIGeneration(standings, seasonId, changeType === 'season');
        aiTriggered = aiResult.regenerated === true;
        log.push(`[cron] AI: ${aiTriggered ? 'regenerated ✓' : 'already current'}`);
      } catch (aiErr) {
        log.push(`[cron] AI ERROR: ${aiErr.message}`);
      }
    } else {
      log.push('[cron] No change – skip history & AI');

      // Ha nincs változás de nincs AI adat, generáljuk le
      const aiRaw = await kvGet('vsport:ai_prediction');
      if (!aiRaw) {
        log.push('[cron] No AI data found, triggering first generation...');
        try {
          const aiResult = await triggerAIGeneration(standings, seasonId, false);
          aiTriggered = true;
          log.push(`[cron] AI first-gen: ${aiResult.regenerated ? 'done ✓' : 'already exists'}`);
        } catch (aiErr) {
          log.push(`[cron] AI first-gen ERROR: ${aiErr.message}`);
        }
      }
    }

    // 5. Állapot mentése
    await saveCronState({
      lastFP: calcFP(standings),
      lastTotalPts: standings.reduce((s, t) => s + (t.pts || 0), 0),
      lastSeasonId: seasonId,
      lastStandings: standings,
      lastRun: now,
    });
    log.push('[cron] State saved ✓');

    return new Response(JSON.stringify({
      ok: true,
      changeType: changeType || 'none',
      historySaved,
      aiTriggered,
      standingsCount: standings.length,
      seasonId,
      log,
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    log.push(`[cron] FATAL: ${err.message}`);
    console.error('[cron] Fatal error:', err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message, log }), {
      status: 500, headers: corsHeaders,
    });
  }
}
