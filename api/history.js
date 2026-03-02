// api/history.js – Globális liga történet (Vercel KV)
// FIX v2: kvSet pipeline-alapú (POST body), nem URL path encoding

export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const HISTORY_KEY = 'vsport:league_history';
const MAX_ENTRIES = 150;

// ── Vercel KV REST client ─────────────────────────────────────────────────────
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
  // Upstash néha {value: "..."} formában adja vissza
  if (typeof result === 'object' && result !== null && result.value !== undefined) {
    return typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
  }
  // Ha már objektum (Upstash auto-parsed JSON)
  if (typeof result === 'object') return JSON.stringify(result);
  return String(result);
}

// FIX: Pipeline POST helyett URL path encoding – elkerüli a méretkorlátot
async function kvSet(key, value) {
  // Pipeline endpoint: [["SET", "key", "value"]]
  const res = await fetch(kvUrl('/pipeline'), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify([['SET', key, value]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.status);
    throw new Error(`KV SET hiba: ${res.status} – ${errText}`);
  }
  const data = await res.json();
  // Pipeline response: [{result: "OK"}]
  if (Array.isArray(data) && data[0]?.result !== 'OK') {
    console.error('[KV SET pipeline result]', JSON.stringify(data[0]));
  }
  return true;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // GET – összes történet lekérése
    if (req.method === 'GET') {
      const raw = await kvGet(HISTORY_KEY);
      let entries = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          entries = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          console.error('[history GET] JSON parse hiba:', e.message, '| raw snippet:', String(raw).slice(0, 200));
          entries = [];
        }
      }
      return new Response(JSON.stringify({ entries, count: entries.length }), {
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

      // Aktuális lista lekérése
      const raw = await kvGet(HISTORY_KEY);
      let entries = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          entries = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          console.error('[history POST] JSON parse hiba:', e.message);
          entries = [];
        }
      }

      // Duplikáció ellenőrzés – fingerprint ÉS seasonId alapján
      const exists = entries.some(e => 
        e.fingerprint === entry.fingerprint && 
        String(e.seasonId||'?') === String(entry.seasonId||'?')
      );
      if (exists) {
        return new Response(JSON.stringify({ saved: false, reason: 'duplicate' }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      // Hozzáadás és mentés
      entries.unshift(entry);
      const trimmed = entries.slice(0, MAX_ENTRIES);
      await kvSet(HISTORY_KEY, JSON.stringify(trimmed));

      return new Response(JSON.stringify({ saved: true, count: trimmed.length }), {
        status: 200,
        headers: corsHeaders,
      });
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
