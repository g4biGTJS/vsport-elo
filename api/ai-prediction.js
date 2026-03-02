// api/ai-prediction.js – Globális AI előrejelzés (Vercel KV)
// Minden felhasználó ugyanazt az AI táblát látja.
// Az AI generálás a szerveren fut, nem a kliensnél.
// Automatikusan újragenerálja, ha fordulóváltás van.

export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const AI_KEY        = 'vsport:ai_prediction';
const AI_META_KEY   = 'vsport:ai_meta';
const LLM7_URL      = 'https://api.llm7.io/v1/chat/completions';
const LLM7_KEY      = '/WF1cs8NieiVJAvBfBR+n5Fb/vxRW1oSmv3EqtTSTRxWQBGMexqcI4Xivs+BqTXfNYMZI8OUFZpv5YAA0FOjcumYWgcG8AkhePVVO8zCVKQo3GMYfArXw2yPPKY7w3tRvofNvQ==';
const BASE_URL      = 'https://s5.sir.sportradar.com/scigamingvirtuals/hu/1';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9',
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
  const res = await fetch(kvUrl(`/get/${key}`), { headers: kvHeaders(), signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}
async function kvSet(key, value) {
  const res = await fetch(kvUrl(`/set/${key}`), {
    method: 'POST',
    headers: kvHeaders(),
    body: JSON.stringify({ value }),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}

// ── Standings fingerprint ─────────────────────────────────────────────────────
function fingerprint(standings) {
  return standings.map(t => `${t.team}:${t.pts}:${t.goalsFor}:${t.goalsAgainst}`).join('|');
}

// ── AI hívás ──────────────────────────────────────────────────────────────────
async function callAI(prompt, temp = 0.85) {
  const res = await fetch(LLM7_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM7_KEY}` },
    body: JSON.stringify({
      model: 'default',
      messages: [{ role: 'user', content: prompt }],
      temperature: temp,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`LLM7 hiba: ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

// ── History context builder ───────────────────────────────────────────────────
async function getHistoryContext() {
  try {
    const raw = await kvGet('vsport:league_history');
    if (!raw) return '';
    const entries = JSON.parse(raw);
    if (!entries.length) return '';
    const recent = entries.slice(0, 8);
    const lines = recent.map(e => {
      const d = new Date(e.timestamp);
      const dateStr = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
      const moversStr = (e.movers || []).slice(0, 5).map(m => `${m.team}(${m.fromPos}→${m.toPos})`).join(', ');
      const top3Str = (e.top3 || []).map(t => `${t.pos}.${t.team}(${t.pts}pt)`).join(', ');
      return `  [${dateStr}] Top3: ${top3Str}${moversStr ? ` | Mozdulatok: ${moversStr}` : ''}`;
    });
    return `\nLIGA ELŐZMÉNYEK (utolsó ${recent.length} forduló):\n${lines.join('\n')}\n`;
  } catch (e) {
    return '';
  }
}

// ── AI generálás ──────────────────────────────────────────────────────────────
async function generatePrediction(standings, seasonId) {
  const historyContext = await getHistoryContext();
  const allTeamsData = standings.map(t => `${t.pos}. ${t.team}: ${t.pts}pt, ${t.goalsFor||0}:${t.goalsAgainst||0}`).join('\n');
  const totalPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const seasonNote = totalPts < 50 ? 'MEGJEGYZÉS: Szezon eleje, kevés meccsel. Becsüld a várható szezonvégi állást!' : '';

  const prompt = `Te egy virtuális futball liga profí elemzője vagy. A jelenlegi tabella alapján készíts előrejelzést a szezon végére!

JELENLEGI TABELLA:
${allTeamsData}
${historyContext}
${seasonNote}

FELADAT:
Elemezd az aktuális állást és a liga történetét, majd adj egy valósághű, független szezonvégi előrejelzést.
- Figyelj a trendekre (ki emelkedik, ki visszaeshet)
- Ha vannak előzmények, használd fel a mintákat
- Az előrejelzés lehet hasonló a jelenlegihez, ha az adatok ezt indokolják
- trend mező: "up" (emelkedő forma), "down" (visszaeső), "same" (stagnáló)

Válaszolj KIZÁRÓLAG kompakt JSON tömbbel, minden mező SZÁM legyen:
[{"pos":1,"team":"Név","goalsFor":72,"goalsAgainst":28,"pts":87,"trend":"up"},...]`;

  const text = await callAI(prompt);
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('[');
  if (start === -1) throw new Error('JSON nem található az AI válaszban');
  let depth = 0, end = start;
  for (; end < clean.length; end++) {
    if (clean[end] === '[') depth++;
    else if (clean[end] === ']') { depth--; if (depth === 0) break; }
  }
  const parsed = JSON.parse(clean.slice(start, end + 1));
  const aiStandings = parsed.map((r, i) => {
    const rawPts = r.pts ?? r.points ?? r.Pts ?? r.pont ?? 0;
    const pts = parseInt(String(rawPts), 10) || 0;
    return {
      pos: parseInt(String(r.pos || (i + 1)), 10),
      team: String(r.team || r.name || r.csapat || '–'),
      goalsFor: parseInt(String(r.goalsFor ?? r.gf ?? 0), 10) || 0,
      goalsAgainst: parseInt(String(r.goalsAgainst ?? r.ga ?? 0), 10) || 0,
      pts,
      trend: String(r.trend || 'same'),
    };
  });

  if (!aiStandings.length) throw new Error('Üres AI tabella');

  // Fallback ha minden pts=0
  const totalAIPts = aiStandings.reduce((s, t) => s + t.pts, 0);
  if (totalAIPts === 0) {
    aiStandings.forEach((t, i) => {
      const base = standings[i]?.pts || 0;
      t.pts = Math.max(0, base + Math.round((Math.random() - 0.4) * 8));
    });
  }

  // Elemzés szöveg
  const top3 = aiStandings.slice(0, 3).map(t => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const bot3 = aiStandings.slice(-3).map(t => `${t.pos}. ${t.team} (${t.pts}pt)`).join(', ');
  const analysisPrompt = `Rövid elemzés MAGYARUL (max 4 mondat):\nAI előrejelzés – Top 3: ${top3}\nUtolsó 3: ${bot3}${historyContext}\nMiért lehetnek ilyen helyzetben a szezon végén?`;
  const analysis = await callAI(analysisPrompt, 0.7);

  return {
    standings: aiStandings,
    analysis,
    generatedAt: new Date().toISOString(),
    basedOnFingerprint: fingerprint(standings),
    seasonId: seasonId || null,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const { searchParams } = new URL(req.url);

  try {
    // GET – aktuális AI előrejelzés + meta lekérése
    if (req.method === 'GET') {
      const rawPred = await kvGet(AI_KEY);
      const rawMeta = await kvGet(AI_META_KEY);
      const prediction = rawPred ? JSON.parse(rawPred) : null;
      const meta = rawMeta ? JSON.parse(rawMeta) : null;

      return new Response(JSON.stringify({
        prediction,
        meta,
        hasData: !!prediction,
      }), { status: 200, headers: corsHeaders });
    }

    // POST – generálás kérése (a kliens küldi a standings-ot)
    // Vagy force=true paraméterrel erőltetett újragenerálás
    if (req.method === 'POST') {
      const body = await req.json();
      const { standings, seasonId, force, currentFingerprint } = body;

      if (!standings || !standings.length) {
        return new Response(JSON.stringify({ error: 'Hiányzó standings' }), {
          status: 400, headers: corsHeaders,
        });
      }

      // Ha nem force, ellenőrizzük, hogy szükséges-e újragenerálás
      if (!force) {
        const rawMeta = await kvGet(AI_META_KEY);
        const meta = rawMeta ? JSON.parse(rawMeta) : null;
        if (meta && meta.basedOnFingerprint === fingerprint(standings)) {
          // Már van aktuális előrejelzés ehhez a fordulóhoz
          const rawPred = await kvGet(AI_KEY);
          if (rawPred) {
            return new Response(JSON.stringify({
              prediction: JSON.parse(rawPred),
              meta,
              regenerated: false,
              reason: 'already_current',
            }), { status: 200, headers: corsHeaders });
          }
        }
      }

      // Generálás
      console.log('[ai-prediction] Generating new prediction...');
      const prediction = await generatePrediction(standings, seasonId);

      // Mentés KV-ba
      await kvSet(AI_KEY, JSON.stringify(prediction));
      await kvSet(AI_META_KEY, JSON.stringify({
        generatedAt: prediction.generatedAt,
        basedOnFingerprint: prediction.basedOnFingerprint,
        seasonId: prediction.seasonId,
      }));

      return new Response(JSON.stringify({
        prediction,
        regenerated: true,
      }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: corsHeaders,
    });

  } catch (err) {
    console.error('[ai-prediction]', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
}
