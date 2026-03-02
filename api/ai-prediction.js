// api/ai-prediction.js – Globális AI előrejelzés (Vercel KV)
// FIX v2: kvSet pipeline-alapú; minden fordulóváltásnál automatikus regenerálás

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
  const res = await fetch(kvUrl(`/get/${encodeURIComponent(key)}`), {
    headers: kvHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    return null; // soft fail – nem blokkolja a generálást
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

// FIX: Pipeline POST – elkerüli az URL path méretkorlátot
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
    signal: AbortSignal.timeout(35000),
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
    if (!Array.isArray(entries) || !entries.length) return '';

    // Utolsó 6 forduló teljes tabelláival
    const recent = entries.slice(0, 6);
    const lines = recent.map((e, idx) => {
      const d = new Date(e.timestamp);
      const dateStr = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
      const roundLabel = idx === 0 ? 'LEGUTÓBBI FORDULÓ' : `${idx + 1}. korábbi`;

      // Teljes standings snapshot ha van
      const snap = e.standingsSnapshot || [];
      let standingsStr = '';
      if (snap.length) {
        standingsStr = snap.map(t => {
          const gd = (t.goalsFor || 0) - (t.goalsAgainst || 0);
          const gdStr = gd >= 0 ? `+${gd}` : String(gd);
          return `    ${String(t.pos).padStart(2)}. ${t.team}: ${t.pts}pt  ${t.goalsFor||0}:${t.goalsAgainst||0}(${gdStr})`;
        }).join('\n');
      } else {
        // Fallback régi formátum
        standingsStr = (e.top3 || []).map(t => `    ${t.pos}. ${t.team}: ${t.pts}pt`).join('\n');
      }

      // Változások
      const moversStr = (e.movers || [])
        .filter(m => m.dir !== 'same')
        .slice(0, 6)
        .map(m => `${m.team}(${m.fromPos}→${m.toPos}${m.ptsDiff ? `,+${m.ptsDiff}pt` : ''})`)
        .join(', ');

      return `\n  [${dateStr} – ${roundLabel}]\n${standingsStr}${moversStr ? `\n  Elmozdulások: ${moversStr}` : ''}\n  ÖsszPont: ${e.totalPts||'?'}, Gólok: ${e.totalGoalsFor||'?'}:${e.totalGoalsAgainst||'?'}`;
    });

    return `\n═══ LIGA ELŐZMÉNYEK (utolsó ${recent.length} forduló – teljes tabella) ═══\n${lines.join('\n')}\n═══ VÉGE ═══\n`;
  } catch (e) {
    console.warn('[getHistoryContext]', e.message);
    return '';
  }
}

// ── AI generálás ──────────────────────────────────────────────────────────────
async function generatePrediction(standings, seasonId) {
  const historyContext = await getHistoryContext();
  const allTeamsData = standings.map(t => `${t.pos}. ${t.team}: ${t.pts}pt, ${t.goalsFor||0}:${t.goalsAgainst||0}`).join('\n');
  const totalPts = standings.reduce((s, t) => s + (t.pts || 0), 0);
  const seasonNote = totalPts < 50 ? 'MEGJEGYZÉS: Szezon eleje, kevés meccsel. Becsüld a várható szezonvégi állást!' : '';

  const prompt = `Te egy virtuális futball liga profi elemzője vagy. A teljes historikus adatok alapján készíts szezonvégi előrejelzést!

JELENLEGI TABELLA (${standings.length} csapat):
${allTeamsData}
${historyContext}
${seasonNote}

ELEMZÉSI FELADAT:
1. Vizsgáld meg a TRENDEKET: ki emelkedik, ki esik vissza, ki stagnál
2. Nézd meg a GÓL-STATISZTIKÁKAT: melyik csapat támadó/védekező ereje nő vagy csökken
3. Használd fel a HISTORIKUS FORDULÓKAT (ha vannak): milyen minta látszik?
4. Becsüld a SZEZONVÉGI állást realisztikusan

SZABÁLYOK:
- trend mező: "up" (emelkedő), "down" (visszaeső), "same" (stagnáló)
- A pontszámok legyenek realisztikusak a jelenlegi álláshoz képest
- A gólok is legyenek arányosak
- Ha a szezon eleje van, extrapolálj a teljes szezonra

Válaszolj KIZÁRÓLAG valid JSON tömbbel, semmi más szöveg:
[{"pos":1,"team":"Csapatnév","goalsFor":72,"goalsAgainst":28,"pts":87,"trend":"up"},...]

FONTOS: pontosan ${standings.length} csapatot adj vissza, mindegyiket!`;

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
  const top3 = aiStandings.slice(0, 3).map(t => `${t.pos}. ${t.team} (${t.pts}pt, ${t.goalsFor}:${t.goalsAgainst})`).join(', ');
  const bot3 = aiStandings.slice(-3).map(t => `${t.pos}. ${t.team} (${t.pts}pt, ${t.goalsFor}:${t.goalsAgainst})`).join(', ');
  const upTeams = aiStandings.filter(t => t.trend === 'up').map(t => t.team).join(', ') || 'nincs';
  const downTeams = aiStandings.filter(t => t.trend === 'down').map(t => t.team).join(', ') || 'nincs';
  const analysisPrompt = `Rövid elemzés MAGYARUL (max 4-5 mondat, legyen konkrét és informatív):\nAI előrejelzés – Top 3: ${top3}\nKieső zóna: ${bot3}\nEmelkedő trend: ${upTeams}\nCsökkenő trend: ${downTeams}${historyContext}\nMiért lehetnek ilyen helyzetben a szezon végén? Milyen trendek vezethetek ide?`;
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

  try {
    // GET – aktuális AI előrejelzés + meta lekérése
    if (req.method === 'GET') {
      const rawPred = await kvGet(AI_KEY);
      const rawMeta = await kvGet(AI_META_KEY);

      let prediction = null;
      let meta = null;

      if (rawPred) {
        try { prediction = JSON.parse(rawPred); } catch (e) {
          console.error('[ai GET] prediction parse hiba:', e.message);
        }
      }
      if (rawMeta) {
        try { meta = JSON.parse(rawMeta); } catch (e) {
          console.error('[ai GET] meta parse hiba:', e.message);
        }
      }

      return new Response(JSON.stringify({
        prediction,
        meta,
        hasData: !!prediction,
      }), { status: 200, headers: corsHeaders });
    }

    // POST – generálás kérése (a kliens küldi a standings-ot)
    if (req.method === 'POST') {
      const body = await req.json();
      const { standings, seasonId, force } = body;

      if (!standings || !standings.length) {
        return new Response(JSON.stringify({ error: 'Hiányzó standings' }), {
          status: 400, headers: corsHeaders,
        });
      }

      const currentFP = fingerprint(standings);

      // Ha nem force, ellenőrizzük, hogy szükséges-e újragenerálás
      if (!force) {
        const rawMeta = await kvGet(AI_META_KEY);
        if (rawMeta) {
          let meta = null;
          try { meta = JSON.parse(rawMeta); } catch (e) {}
          if (meta && meta.basedOnFingerprint === currentFP) {
            const rawPred = await kvGet(AI_KEY);
            if (rawPred) {
              let prediction = null;
              try { prediction = JSON.parse(rawPred); } catch (e) {}
              if (prediction) {
                return new Response(JSON.stringify({
                  prediction,
                  meta,
                  regenerated: false,
                  reason: 'already_current',
                }), { status: 200, headers: corsHeaders });
              }
            }
          }
        }
      }

      // Generálás
      console.log('[ai-prediction] Generating new prediction... force=', force, 'fp=', currentFP.slice(0, 60));
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
