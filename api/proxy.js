const http = require('http');
const https = require('https');
const { URL } = require('url');

const ALLOWED_HOSTS = [
  'schedulerzrh.aitcloud.de',
  'vfscigaming.aitcloud.de',
];

module.exports = async (req, res) => {
  try {
    let targetUrl;
    if (req.query.url) {
      targetUrl = decodeURIComponent(req.query.url);
    } else {
      const rawPath = (req.query.path || '').replace(/^\/+/, '');
      const extra = Object.entries(req.query)
        .filter(([k]) => !['path','url'].includes(k))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      targetUrl = `http://schedulerzrh.aitcloud.de/${rawPath}${extra ? '?' + extra : ''}`;
    }

    const parsed = new URL(targetUrl);
    if (!ALLOWED_HOSTS.some(h => parsed.hostname === h)) {
      res.status(403).end('Forbidden host');
      return;
    }

    const browserCookies = req.headers['cookie'] || '';
    const result = await fetchFollowingRedirects(targetUrl, browserCookies, [], 0);

    if (result.setCookies.length > 0) {
      const cleaned = result.setCookies.map(c =>
        c.replace(/;\s*domain=[^;]*/gi, '')
         .replace(/;\s*secure/gi, '')
         .replace(/;\s*samesite=[^;]*/gi, '')
      );
      res.setHeader('Set-Cookie', cleaned);
    }

    const STRIP = new Set([
      'x-frame-options','content-security-policy','content-security-policy-report-only',
      'x-content-type-options','strict-transport-security',
      'transfer-encoding','connection','keep-alive','set-cookie',
    ]);
    for (const [k, v] of Object.entries(result.headers)) {
      if (!STRIP.has(k.toLowerCase())) {
        try { res.setHeader(k, v); } catch (_) {}
      }
    }
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ct = (result.headers['content-type'] || '').toLowerCase();
    const finalBase = result.finalUrl || targetUrl;

    if (ct.includes('text/html')) {
      let body = result.body;

      // Rewrite all aitcloud absolute URLs to go through proxy
      body = body.replace(
        /(https?:\/\/(?:schedulerzrh|vfscigaming)\.aitcloud\.de)(\/[^'"\s>)]*)/gi,
        (_, base, path) => `/proxy?url=${encodeURIComponent(base + path)}`
      );

      // Rewrite root-relative src/href/action
      body = body.replace(
        /(href|src|action|data-src)\s*=\s*(['"])(\/(?!proxy)[^'"]*)\2/gi,
        (_, attr, q, path) => {
          try {
            const abs = new URL(path, finalBase).toString();
            return `${attr}=${q}/proxy?url=${encodeURIComponent(abs)}${q}`;
          } catch(e) { return _; }
        }
      );

      // Rewrite url() in inline CSS
      body = body.replace(
        /url\(\s*(['"]?)(\/(?!proxy)[^'"\)]+)\1\s*\)/gi,
        (_, q, path) => {
          try {
            const abs = new URL(path, finalBase).toString();
            return `url(${q}/proxy?url=${encodeURIComponent(abs)}${q})`;
          } catch(e) { return _; }
        }
      );

      // Remove meta CSP
      body = body.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*\/?>/gi, '');

      // Inject fetch/XHR interceptor so dynamic requests also go through proxy
      const inject = `<script>
(function(){
  var BASE = '${finalBase}';
  var _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    if (url && !url.startsWith('/proxy') && (url.includes('aitcloud.de') || (url.startsWith('/') && !url.startsWith('//')))) {
      try { url = new URL(url, BASE).toString(); } catch(e){}
      input = '/proxy?url=' + encodeURIComponent(url);
    }
    return _fetch(input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, url) {
    if (url && !url.startsWith('/proxy') && (url.includes('aitcloud.de') || (url.startsWith('/') && !url.startsWith('//')))) {
      try { url = new URL(url, BASE).toString(); } catch(e){}
      url = '/proxy?url=' + encodeURIComponent(url);
    }
    return _open.apply(this, [m, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
})();
</script>`;
      body = body.replace(/<head([^>]*)>/i, `<head$1>${inject}`);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(result.status).end(body);

    } else if (ct.includes('css')) {
      let body = result.body || result.bodyBuffer.toString('utf8');
      body = body.replace(
        /(https?:\/\/(?:schedulerzrh|vfscigaming)\.aitcloud\.de)(\/[^'"\s)]*)/gi,
        (_, base, path) => `/proxy?url=${encodeURIComponent(base + path)}`
      );
      res.status(result.status).end(body);

    } else if (ct.includes('javascript')) {
      let body = result.body || result.bodyBuffer.toString('utf8');
      body = body.replace(
        /(https?:\/\/(?:schedulerzrh|vfscigaming)\.aitcloud\.de)(\/[^'"\s)]*)/gi,
        (_, base, path) => `/proxy?url=${encodeURIComponent(base + path)}`
      );
      res.status(result.status).end(body);

    } else {
      res.status(result.status).end(result.bodyBuffer);
    }

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).end(`Proxy error: ${err.message}`);
  }
};

function fetchFollowingRedirects(url, browserCookies, cookieJar, depth) {
  return new Promise((resolve, reject) => {
    if (depth > 12) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error(`Bad URL: ${url}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const allCookies = mergeCookies(browserCookies, cookieJar.join('; '));

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
        ...(allCookies ? { Cookie: allCookies } : {}),
      },
      timeout: 20000,
    };

    const req = lib.request(opts, (resp) => {
      const status = resp.statusCode;
      const newCookies = [].concat(resp.headers['set-cookie'] || []);
      const jarValues = newCookies.map(c => c.split(';')[0].trim());
      const updatedJar = mergeCookiesArray(cookieJar, jarValues);

      if ([301,302,303,307,308].includes(status)) {
        let loc = resp.headers['location'];
        if (!loc) { resp.resume(); return reject(new Error('Redirect missing Location')); }
        if (!loc.startsWith('http')) loc = new URL(loc, `${parsed.protocol}//${parsed.host}`).toString();
        resp.resume();
        resolve(fetchFollowingRedirects(loc, browserCookies, updatedJar, depth + 1));
        return;
      }

      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const ct = (resp.headers['content-type'] || '').toLowerCase();
        const isText = ct.includes('text') || ct.includes('json') || ct.includes('javascript') || ct.includes('xml');
        resolve({ status, headers: resp.headers, bodyBuffer, body: isText ? bodyBuffer.toString('utf8') : null, setCookies: newCookies, finalUrl: url });
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

function mergeCookiesArray(jar, newPairs) {
  const map = new Map();
  for (const c of [...jar, ...newPairs]) {
    const eq = c.indexOf('=');
    if (eq > 0) map.set(c.slice(0, eq).trim(), c);
  }
  return [...map.values()];
}
