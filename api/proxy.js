const http  = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const ALLOWED = ['schedulerzrh.aitcloud.de', 'vfscigaming.aitcloud.de'];

// In-memory cookie jar: { sessionId -> Map<host, Map<name, value>> }
const SESSION_JARS = new Map();

function getJar(sid, host) {
  if (!SESSION_JARS.has(sid)) SESSION_JARS.set(sid, new Map());
  const byHost = SESSION_JARS.get(sid);
  if (!byHost.has(host)) byHost.set(host, new Map());
  return byHost.get(host);
}

function jarToCookieHeader(sid, host) {
  const jar = getJar(sid, host);
  // Also include cookies from parent domain (aitcloud.de)
  const parent = getJar(sid, 'aitcloud.de');
  const all = new Map([...parent, ...jar]);
  return [...all.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeSetCookies(sid, host, setCookieHeaders) {
  const jar = getJar(sid, host);
  for (const raw of setCookieHeaders) {
    const parts = raw.split(';').map(s => s.trim());
    const [nameVal] = parts;
    const eq = nameVal.indexOf('=');
    if (eq < 1) continue;
    const name  = nameVal.slice(0, eq).trim();
    const value = nameVal.slice(eq + 1).trim();
    // Check if domain attr applies to parent
    const domainPart = parts.find(p => p.toLowerCase().startsWith('domain='));
    const domainVal  = domainPart ? domainPart.slice(7).replace(/^\./, '') : host;
    getJar(sid, domainVal).set(name, value);
  }
}

module.exports = async (req, res) => {
  try {
    // ── Get or create session ID
    let sid = '';
    const cookieHdr = req.headers['cookie'] || '';
    const sidMatch  = cookieHdr.match(/(?:^|;\s*)_psid=([^;]+)/);
    if (sidMatch) {
      sid = sidMatch[1];
    } else {
      sid = crypto.randomBytes(16).toString('hex');
      res.setHeader('Set-Cookie', `_psid=${sid}; Path=/; SameSite=Lax`);
    }

    // ── Build target URL
    let targetUrl;
    if (req.query.url) {
      targetUrl = decodeURIComponent(req.query.url);
    } else {
      const rawPath = (req.query.path || '').replace(/^\/+/, '');
      const extra   = Object.entries(req.query)
        .filter(([k]) => !['path', 'url'].includes(k))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      targetUrl = `http://schedulerzrh.aitcloud.de/${rawPath}${extra ? '?' + extra : ''}`;
    }

    // Safety check
    const parsedTarget = new URL(targetUrl);
    if (!ALLOWED.some(h => parsedTarget.hostname === h)) {
      return res.status(403).end('Forbidden host');
    }

    // ── Fetch with our server-side cookie jar
    const result = await fetchFollowingRedirects(targetUrl, sid, 0);

    // ── Strip embedding-blocking headers, forward safe ones
    const STRIP = new Set([
      'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
      'x-content-type-options', 'strict-transport-security',
      'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
    ]);
    for (const [k, v] of Object.entries(result.headers)) {
      if (!STRIP.has(k.toLowerCase())) {
        try { res.setHeader(k, v); } catch (_) {}
      }
    }
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ct       = (result.headers['content-type'] || '').toLowerCase();
    const finalUrl = result.finalUrl || targetUrl;

    if (ct.includes('text/html')) {
      let body = result.body;

      // 1. Rewrite absolute aitcloud URLs → /proxy?url=...
      body = body.replace(
        /(["'`(])\s*(https?:\/\/(?:[\w-]+\.)*aitcloud\.de)(\/[^"'`\s)>]*)/gi,
        (_, q, base, path) => `${q}/proxy?url=${encodeURIComponent(base + path)}`
      );

      // 2. Rewrite root-relative URLs in attributes
      body = body.replace(
        /((?:href|src|action|data-src|data-href)\s*=\s*)(["'])(\/(?!proxy\b|\/)[^"']*)\2/gi,
        (_, attr, q, path) => {
          try {
            const abs = new URL(path, finalUrl).toString();
            return `${attr}${q}/proxy?url=${encodeURIComponent(abs)}${q}`;
          } catch { return _; }
        }
      );

      // 3. Rewrite url() in inline styles
      body = body.replace(
        /url\(\s*(["']?)(\/(?!proxy\b)[^"')]+)\1\s*\)/gi,
        (_, q, path) => {
          try {
            const abs = new URL(path, finalUrl).toString();
            return `url(${q}/proxy?url=${encodeURIComponent(abs)}${q})`;
          } catch { return _; }
        }
      );

      // 4. Remove meta CSP
      body = body.replace(/<meta[^>]+http-equiv\s*=\s*["']content-security-policy["'][^>]*\/?>/gi, '');

      // 5. Inject JS interceptor for dynamic fetch/XHR/WebSocket
      const injected = `<script>
(function(){
  var _BASE = '${finalUrl}';
  function rewrite(url){
    if(!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('/proxy')) return url;
    try {
      var abs = new URL(url, _BASE).toString();
      if(abs.includes('aitcloud.de')) return '/proxy?url='+encodeURIComponent(abs);
    } catch(e){}
    return url;
  }
  // fetch
  var _fetch = window.fetch;
  window.fetch = function(input, init){
    if(typeof input === 'string') input = rewrite(input);
    else if(input && input.url) input = new Request(rewrite(input.url), input);
    return _fetch.call(this, input, init);
  };
  // XHR
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, url){
    url = rewrite(url);
    return _open.apply(this, [m, url].concat([].slice.call(arguments,2)));
  };
})();
</script>`;
      body = body.replace(/(<head[^>]*>)/i, `$1${injected}`);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(result.status).end(body);
    }

    if (ct.includes('css')) {
      let body = result.body || result.bodyBuffer.toString('utf8');
      body = body.replace(
        /(https?:\/\/(?:[\w-]+\.)*aitcloud\.de)(\/[^"'\s)]*)/gi,
        (_, base, path) => `/proxy?url=${encodeURIComponent(base + path)}`
      );
      return res.status(result.status).end(body);
    }

    if (ct.includes('javascript')) {
      let body = result.body || result.bodyBuffer.toString('utf8');
      body = body.replace(
        /(["'`])(https?:\/\/(?:[\w-]+\.)*aitcloud\.de)(\/[^"'`\s)]*)/gi,
        (_, q, base, path) => `${q}/proxy?url=${encodeURIComponent(base + path)}`
      );
      return res.status(result.status).end(body);
    }

    // Binary
    return res.status(result.status).end(result.bodyBuffer);

  } catch (err) {
    console.error('[proxy]', err.message);
    return res.status(502).end(`Proxy error: ${err.message}`);
  }
};

// ── HTTP fetch with server-side cookie jar + redirect following ──
function fetchFollowingRedirects(url, sid, depth) {
  return new Promise((resolve, reject) => {
    if (depth > 15) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(e); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const cookies = jarToCookieHeader(sid, parsed.hostname);

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection':      'close',
        'Referer':         `http://schedulerzrh.aitcloud.de/`,
        ...(cookies ? { Cookie: cookies } : {}),
      },
      timeout: 20000,
    };

    const req = lib.request(opts, (resp) => {
      // Store any Set-Cookie from this hop
      const setCookies = [].concat(resp.headers['set-cookie'] || []);
      if (setCookies.length) storeSetCookies(sid, parsed.hostname, setCookies);

      const status = resp.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        let loc = resp.headers['location'];
        if (!loc) { resp.resume(); return reject(new Error('Redirect with no Location')); }
        if (!loc.startsWith('http')) loc = new URL(loc, `${parsed.protocol}//${parsed.host}`).toString();
        resp.resume();
        return resolve(fetchFollowingRedirects(loc, sid, depth + 1));
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
          finalUrl:   url,
        });
      });
      resp.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timed out')); });
    req.on('error', reject);
    req.end();
  });
}
