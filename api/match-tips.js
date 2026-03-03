// api/match-tips.js – Vercel Edge Function
// Meccs tipp elemzés – tabella alapján AI generálás
export const config = { runtime: 'edge' };

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Lokális számítás fallback (ha nincs LLM) ─────────────────────────────────
function computeLocalTips(matches, standings) {
  return matches.map(m => {
    const home = standings.find(t => t.team === m.home);
    const away = standings.find(t => t.team === m.away);

    const homePts = home ? home.pts : 0;
    const awayPts = away ? away.pts : 0;
    const homeGD  = home ? (home.goalsFor || 0) - (home.goalsAgainst || 0) : 0;
    const awayGD  = away ? (away.goalsFor || 0) - (away.goalsAgainst || 0) : 0;
    const homePos = home ? home.pos : 10;
    const awayPos = away ? away.pos : 10;
    const homeGF  = home ? home.goalsFor || 0 : 4;
    const awayGF  = away ? away.goalsFor || 0 : 4;

    // Erő-index számítás (hazai pályaelőny +10%)
    const homeStr = homePts * 1.5 + homeGD * 0.8 + (20 - homePos) * 2 + 30;
    const awayStr = awayPts * 1.5 + awayGD * 0.8 + (20 - awayPos) * 2 + 5;
    const totalStr = Math.max(homeStr + awayStr, 1);

    let homePct = Math.round((homeStr / totalStr) * 80);
    let awayPct = Math.round((awayStr / totalStr) * 65);
    homePct = Math.min(Math.max(homePct, 20), 70);
    awayPct = Math.min(Math.max(awayPct, 10), 55);
    const drawPct = Math.max(100 - homePct - awayPct, 5);
    const adj = 100 - homePct - drawPct - awayPct;
    const finalHomePct = homePct + adj;

    const avgGF = (homeGF + awayGF) / 2;
    const over15Pct = Math.min(Math.max(Math.round(55 + avgGF * 1.2), 40), 92);
    const over25Pct = Math.min(Math.max(Math.round(35 + avgGF * 0.9), 22), 82);

    const favorit = finalHomePct >= awayPct ? m.home : m.away;
    const pozHome = homePos ? `${homePos}.` : '?';
    const pozAway = awayPos ? `${awayPos}.` : '?';

    return {
      home: m.home, away: m.away,
      homePct: finalHomePct, drawPct, awayPct,
      over15Pct, over25Pct,
      over15Comment: over15Pct >= 60 ? 'Mindkét csapat sokat lő, magas gólvárakozás' : 'Szoros, taktikai meccs – alacsony gólszám várható',
      over25Comment: over25Pct >= 55 ? 'Gólgazdag összecsapás valószínűsíthető' : 'Inkább zárt, defenzív mérkőzés várható',
      analysis: `${favorit} az esélyes győzelemre a jelenlegi tabella és statisztikák alapján. ${m.home} tabella helye: ${pozHome}, ${m.away}: ${pozAway}. A ${finalHomePct >= awayPct ? 'hazai' : 'vendég'} csapat jobb formában van – gólkülönbsége és pontszáma alapján erősebb ellenfélnek számít ebben a meccsen.`,
      source: 'local'
    };
  });
}

// ─── LLM hívás (llm7.io – ugyanaz mint ai-prediction.js) ─────────────────────
async function callLLM(prompt) {
  // 1. Próbálkozás: llm7.io (ingyenes, nincs auth)
  try {
    const res = await fetch('https://api.llm7.io/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 2500
      }),
      signal: AbortSignal.timeout(25000)
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
    }
  } catch (e) {
    console.warn('[match-tips] llm7.io failed:', e.message);
  }

  // 2. Fallback: Anthropic API ha van key (optional)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2500,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (res.ok) {
        const data = await res.json();
        return data.content?.[0]?.text || null;
      }
    } catch (e) {
      console.warn('[match-tips] Anthropic API failed:', e.message);
    }
  }

  return null;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { matches, standings } = body;

    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      return new Response(JSON.stringify({ error: 'Hiányzó matches tömb' }), { status: 400, headers: corsHeaders });
    }

    const standingsCtx = (standings || []).length
      ? standings.map(t => `${t.pos}. ${t.team} – ${t.pts}pt, GF:${t.goalsFor} GA:${t.goalsAgainst} GD:${(t.goalsFor||0)-(t.goalsAgainst||0)}`).join('\n')
      : 'Tabella adat nem elérhető';

    const matchList = matches.map((m, i) => `${i+1}. ${m.home} (HAZAI) vs ${m.away} (VENDÉG)`).join('\n');

    const prompt = `Te egy profi virtuális futball elemző vagy. Az alábbi élő tabella adatok alapján elemezd meg a meccseket:

JELENLEGI TABELLA (Premier Liga Virtuális):
${standingsCtx}

ELEMZENDŐ MECCSEK:
${matchList}

Minden meccshez adj meg PONTOSAN a következő JSON struktúrában választ:
- homePct: hazai győzelem valószínűsége (egész, 0-100)
- drawPct: döntetlen valószínűsége (egész, 0-100)
- awayPct: vendég győzelem valószínűsége (egész, 0-100)
- over15Pct: 1.5 gól felett valószínűsége (egész, 0-100)
- over25Pct: 2.5 gól felett valószínűsége (egész, 0-100)
- over15Comment: rövid magyarázat (1 mondat, magyarul)
- over25Comment: rövid magyarázat (1 mondat, magyarul)
- analysis: részletes elemzés (2-3 mondat, magyarul) – ki az esélyes, miért, tabella adatok alapján

FONTOS:
1. homePct + drawPct + awayPct = PONTOSAN 100
2. Vedd figyelembe a tabella pozíciót, pontszámot, gólkülönbséget
3. Adj reális, differenciált százalékokat (ne mindig 50-50)
4. Nevezd meg egyértelműen a favorit csapatot az analysis-ban

Válaszolj CSAK valid JSON tömbben, minden más szöveg, magyarázat nélkül:
[{"home":"...","away":"...","homePct":X,"drawPct":X,"awayPct":X,"over15Pct":X,"over25Pct":X,"over15Comment":"...","over25Comment":"...","analysis":"..."}]`;

    const llmText = await callLLM(prompt);
    let results;
    let source = 'local';

    if (llmText) {
      try {
        const clean = llmText.replace(/```json|```/g, '').trim();
        const jsonMatch = clean.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
          results = parsed.map((r, i) => ({
            ...r,
            home: r.home || matches[i]?.home || '?',
            away: r.away || matches[i]?.away || '?',
          }));
          source = 'ai';
        }
      } catch (e) {
        console.warn('[match-tips] JSON parse hiba, lokális fallbackre váltás');
      }
    }

    if (!results) {
      results = computeLocalTips(matches, standings || []);
      source = 'local';
    }

    return new Response(JSON.stringify({ results, source, count: results.length }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    console.error('[match-tips]', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
