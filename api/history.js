// api/history.js – Vercel Edge Function
// Visszaadja a szerver oldalon tárolt snapshot históriát.
// Szükséges env változók: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
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

  try {
    const raw = await kv('GET', 'vsport:history');
    const history = raw ? JSON.parse(raw) : { seasonId: null, snapshots: [] };

    return new Response(JSON.stringify(history), { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error('[history] Error:', error.message);
    // Hiba esetén üres történetet adunk vissza (a kliens localStorage-t használ fallback-ként)
    return new Response(
      JSON.stringify({ seasonId: null, snapshots: [], error: error.message }),
      { status: 200, headers: corsHeaders }
    );
  }
}
