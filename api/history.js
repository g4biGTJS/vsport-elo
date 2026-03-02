// api/history.js – Vercel Edge Function
// GET              → visszaadja a globális snapshot históriát (Redis)
// GET ?clear=1     → törli a históriát (Redis)

export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

async function kv(cmd, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
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

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
  }

  const { searchParams } = new URL(req.url);

  try {
    // Törlés
    if (searchParams.get('clear') === '1') {
      await kv('DEL', 'vsport:history');
      return new Response(JSON.stringify({ ok: true, cleared: true }), { status: 200, headers: corsHeaders });
    }

    // Olvasás
    const raw = await kv('GET', 'vsport:history');
    const history = raw ? JSON.parse(raw) : { seasonId: null, snapshots: [] };

    return new Response(JSON.stringify(history), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error('[history] Error:', error.message);
    return new Response(
      JSON.stringify({ seasonId: null, snapshots: [], error: error.message }),
      { status: 200, headers: corsHeaders }
    );
  }
}
