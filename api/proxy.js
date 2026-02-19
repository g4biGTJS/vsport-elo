const http = require('http');
const https = require('https');
const { URL } = require('url');

const TARGET_BASE = 'http://schedulerzrh.aitcloud.de';
const TARGET_HOST = 'schedulerzrh.aitcloud.de';

module.exports = async (req, res) => {
  try {
    // ── Build the target URL from query param "path" + any remaining query string
    const rawPath = (req.query.path || '').replace(/^\/+/, '');
    const extra = Object.entries(req.query)
      .filter(([k]) => k !== 'path')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const targetUrl = `${TARGET_BASE}/${rawPath}${extra ? '?' + extra : ''}`;

    // ── Forward cookies the browser already has for this session
    const browserCookies = req.headers['cookie'] || '';

    const result = await fetchFollowingRedirects(targetUrl, browserCookies, [], 0);

    // ── Forward Set-Cookie back to browser (so next request carries them)
    if (result.setCookies.length > 0) {
      // Strip domain/secure flags so browser stores them under our Vercel domain
      const cleaned = result.setCookies.map(c =>
        c
          .replace(/;\s*domain=[^;]*/gi, '')
          .replace(/;\s*secure/gi, '')
          .replace(/;\s*samesite=[^;]*/gi, '')
      );
      res.setHeader('Set-Cookie', cleaned);
    }

    // ── Strip headers that block iframe embedding, forward the rest
    const STRIP = new Set([
      'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
      'x-content-type-options', 'strict-transport-security',
      'transfer-encoding', 'connection', 'keep-alive',
      'set-cookie', // handled above
    ]);
    for (const [k, v] of Object.entries(result.headers)) {
      if (!STRIP.has(k.toLowerCase())) {
        try { res.setHeader(k, v); } catch (_) {}
      }
    }
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ct = (result.headers['content-type'] || '').toLowerCase();

    if (ct.includes('text/html')) {
      let body = result.body;

      // 1. Rewrite absolute URLs on the target domain → /proxy/...
      body = body.replace(
        /(['"\(])\s*https?:\/\/schedulerzrh\.aitcloud\.de(\/[^'"\)\s>]*)/gi,
        (_, q, path) => `${q}/proxy${path}`
      );

      // 2. Rewrite root-relative URLs → /proxy/...
      body = body.replace(
        /(href|src|action|data-src|data-href)\s*=\s*(['"])(\/(?!proxy)[^'"]*)\2/gi,
        (_, attr, q, path) => `${attr}=${q}/proxy${path}${q}`
      );

      // 3. Rewrite url(...) in inline CSS
      body = body.replace(
        /url\(\s*(['"]?)(\/(?!proxy)[^'"\)]*)\1\s*\)/gi,
        (_, q, path) => `url(${q}/proxy${path}${q})`
      );

      // 4. Inject <base> so any remaining relative URLs resolve correctly,
      //    and override any existing CSP meta tag
      const baseTag = `<base href="${TARGET_BASE}/">`;
      if (/<head[^>]*>/i.test(body)) {
        body = body.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
      } else {
        body = baseTag + body;
      }

      // 5. Remove meta CSP tags
      body = body.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*>/gi, '');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(result.status).end(body);

    } else if (ct.includes('css') || ct.includes('javascript') || ct.includes('text/')) {
      // Rewrite URLs inside CSS/JS too
      let body = result.body || result.bodyBuffer.toString('utf8');
      body = body.replace(
        /(['"\(])\s*https?:\/\/schedulerzrh\.aitcloud\.de(\/[^'"\)\s]*)/gi,
        (_, q, path) => `${q}/proxy${path}`
      );
      body = body.replace(
        /url\(\s*(['"]?)(\/(?!proxy)[^'"\)]*)\1\s*\)/gi,
        (_, q, path) => `url(${q}/proxy${path}${q})`
      );
      res.status(result.status).end(body);

    } else {
      // Binary assets (images, fonts, etc.) — pass through raw
      res.status(result.status).end(result.bodyBuffer);
    }

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).end(`Proxy error: ${err.message}`);
  }
};

// ─────────────────────────────────────────────
// Fetch with redirect following + cookie jar
// ─────────────────────────────────────────────
function fetchFollowingRedirects(url, browserCookies, cookieJar, depth) {
  return new Promise((resolve, reject) => {
    if (depth > 12) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return reject(new Error(`Bad URL: ${url}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;

    // Merge browser cookies + our accumulated jar
    const allCookies = mergeCookies(browserCookies, cookieJar.join('; '));

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.7,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection':      'close',
        ...(allCookies ? { 'Cookie': allCookies } : {}),
      },
      timeout: 15000,
    };

    const req = lib.request(opts, (resp) => {
      const status = resp.statusCode;

      // Collect any Set-Cookie headers from this hop
      const newCookies = [].concat(resp.headers['set-cookie'] || []);
      // Extract just name=value pairs for the jar
      const jarValues = newCookies.map(c => c.split(';')[0].trim());
      const updatedJar = mergeCookiesArray(cookieJar, jarValues);

      if ([301, 302, 303, 307, 308].includes(status)) {
        let loc = resp.headers['location'];
        if (!loc) { resp.resume(); return reject(new Error('Redirect missing Location')); }
        // Resolve relative redirects
        if (!loc.startsWith('http')) {
          loc = new URL(loc, `${parsed.protocol}//${parsed.host}`).toString();
        }
        resp.resume(); // drain body
        resolve(fetchFollowingRedirects(loc, browserCookies, updatedJar, depth + 1));
        return;
      }

      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        const isText = ct.includes('text') || ct.includes('json') || ct.includes('javascript') || ct.includes('xml');
        resolve({
          status,
          headers:    resp.headers,
          bodyBuffer,
          body:       isText ? bodyBuffer.toString('utf8') : null,
          setCookies: newCookies,   // raw Set-Cookie strings to forward to browser
        });
      });
      resp.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function mergeCookies(a, b) {
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  return `${a}; ${b}`;
}

// Merge new name=value pairs into jar, overwriting duplicates
function mergeCookiesArray(jar, newPairs) {
  const map = new Map();
  for (const c of jar) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq).trim(), c);
  }
  for (const c of newPairs) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq).trim(), c);
  }
  return [...map.values()];
}
