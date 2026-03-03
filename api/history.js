// api/history.js – v3: per-season history + szezonváltás detektálás
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HISTORY_KEY_PREFIX = 'vsport:league_history:season:';
const LEGACY_HISTORY_KEY = 'vsport:league_history';
const ACTIVE_SEASON_KEY  = 'vsport:active_season';
const MAX_ENTRIES = 150;

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
  const res = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), {
    headers: kvHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`KV GET hiba: ${res.status}`);
  }
  const data = await res.json();
  const result = data.result ?? null;
  if (result === null || result === undefined) return null;
  if (typeof result === 'object' && result !== null && result.value !== undefined)
    return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  if (typeof result === 'object') return JSON.stringify(result);
  return String(result);
}

async function kvSet(key, value) {
  const res = await fetch(kvUrl('/pipeline'), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => String(res.status));
    throw new Error(`KV SET hiba: ${res.status} – ${errText}`);
  }
  return true;
}

function historyKey(seasonId) {
  if (!seasonId || seasonId === 'unknown') return LEGACY_HISTORY_KEY;
  return `${HISTORY_KEY_PREFIX}${seasonId}`;
}

async function handleSeasonTransition(newSeasonId) {
  if (!newSeasonId || newSeasonId === 'unknown') return false;
  try {
    const rawActive = await kvGet(ACTIVE_SEASON_KEY);
    const activeSeasonId = rawActive ? String(rawActive).trim() : null;
    if (activeSeasonId && activeSeasonId !== String(newSeasonId)) {
      console.log(`[history] SZEZONVÁLTÁS DETEKTÁLVA: ${activeSeasonId} → ${newSeasonId}`);
      await kvSet(ACTIVE_SEASON_KEY, String(newSeasonId));
      return true;
    }
    if (!activeSeasonId) await kvSet(ACTIVE_SEASON_KEY, String(newSeasonId));
    return false;
  } catch (e) {
    console.warn('[handleSeasonTransition]', e.message);
    return false;
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const seasonId = url.searchParams.get('seasonId') || null;

    // GET – szezon-specifikus history lekérése
    if (req.method === 'GET') {
      const key = historyKey(seasonId);
      let raw = await kvGet(key);

      // Fallback legacy kulcsra csak ha ugyanaz a szezon (ne keveredjen régi+új)
      if (!raw && key !== LEGACY_HISTORY_KEY) {
        const rawActive = await kvGet(ACTIVE_SEASON_KEY);
        const activeSeason = rawActive ? String(rawActive).trim() : null;
        if (!activeSeason || activeSeason === String(seasonId)) {
          raw = await kvGet(LEGACY_HISTORY_KEY);
        }
        // Ha különböző szezon: raw marad null → tiszta lap
      }

      let entries = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          entries = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          console.error('[history GET] parse hiba:', e.message);
          entries = [];
        }
      }

      return new Response(JSON.stringify({ entries, count: entries.length, seasonId }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // POST – új bejegyzés hozzáadása
    if (req.method === 'POST') {
      const body = await req.json();
      const { entry } = body;

      if (!entry || !entry.fingerprint) {
        return new Response(JSON.stringify({ error: 'Hiányzó entry.fingerprint' }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const entrySeasonId = entry.seasonId || seasonId || null;
      entry.seasonId = entrySeasonId;

      // Szezonváltás detektálás
      const seasonChanged = await handleSeasonTransition(entrySeasonId);
      const key = historyKey(entrySeasonId);

      let entries = [];
      if (!seasonChanged) {
        const raw = await kvGet(key);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            entries = Array.isArray(parsed) ? parsed : [];
          } catch (e) {
            console.error('[history POST] parse hiba:', e.message);
            entries = [];
          }
        }
      } else {
        console.log(`[history] Új szezon (${entrySeasonId}): history reset, tiszta lappal indul`);
        // entries marad [], a régi szezon history megmarad a régi kulcson
      }

      // Duplikáció ellenőrzés fingerprint alapján
      const exists = entries.some(e => e.fingerprint === entry.fingerprint);
      if (exists) {
        return new Response(JSON.stringify({ saved: false, reason: 'duplicate', seasonChanged }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      entries.unshift(entry);
      const trimmed = entries.slice(0, MAX_ENTRIES);
      await kvSet(key, JSON.stringify(trimmed));

      return new Response(JSON.stringify({
        saved: true,
        count: trimmed.length,
        seasonId: entrySeasonId,
        seasonChanged,
      }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: corsHeaders,
    });

  } catch (err) {
    console.error('[history]', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
