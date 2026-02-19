const http = require('http');
const https = require('https');
const { URL } = require('url');

const TARGET_BASE = 'http://schedulerzrh.aitcloud.de';

module.exports = async (req, res) => {
  // Build target URL
  const rawPath = req.query.path || '';
  const qs = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const targetUrl = `${TARGET_BASE}/${rawPath}${qs ? '?' + qs : ''}`;

  try {
    const result = await fetchWithRedirects(targetUrl, req.headers, 0);

    // Strip/replace security headers that block embedding
    const blocked = [
      'x-frame-options',
      'content-security-policy',
      'x-content-type-options',
      'strict-transport-security',
      'set-cookie',
    ];

    for (const [key, value] of Object.entries(result.headers)) {
      if (!blocked.includes(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch (_) {}
      }
    }

    // Allow framing from anywhere
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const contentType = (result.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/html')) {
      // Rewrite all relative/absolute links to go through our proxy
      let body = result.body;

      // Rewrite absolute URLs pointing to target domain
      body = body.replace(
        /(href|src|action)="(https?:\/\/schedulerzrh\.aitcloud\.de)(\/[^"]*)"/gi,
        (_, attr, _base, path) => `${attr}="/proxy${path}"`
      );
      // Rewrite root-relative URLs
      body = body.replace(
        /(href|src|action)="(\/[^"]*?)"/gi,
        (_, attr, path) => {
          // Don't double-proxy already proxied paths
          if (path.startsWith('/proxy')) return `${attr}="${path}"`;
          return `${attr}="/proxy${path}"`;
        }
      );
      // Inject base tag so relative paths resolve correctly
      body = body.replace(
        /<head([^>]*)>/i,
        `<head$1><base href="${TARGET_BASE}/${rawPath}">`
      );

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(result.status).send(body);
    } else {
      // Binary / CSS / JS — pipe through as-is
      res.status(result.status).send(result.bodyBuffer);
    }
  } catch (err) {
    res.status(502).send(`Proxy error: ${err.message}`);
  }
};

function fetchWithRedirects(url, origHeaders, redirectCount) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) return reject(new Error('Too many redirects'));

    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return reject(e); }

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
      },
      timeout: 15000,
    };

    const request = lib.request(options, (response) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        let location = response.headers['location'];
        if (!location) return reject(new Error('Redirect with no Location'));
        if (!location.startsWith('http')) {
          location = `${parsedUrl.origin}${location.startsWith('/') ? '' : '/'}${location}`;
        }
        // Consume response body before following redirect
        response.resume();
        return resolve(fetchWithRedirects(location, origHeaders, redirectCount + 1));
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const contentType = (response.headers['content-type'] || '').toLowerCase();
        const isText = contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript') || contentType.includes('xml');
        const body = isText ? bodyBuffer.toString('utf8') : null;

        resolve({
          status: response.statusCode,
          headers: response.headers,
          bodyBuffer,
          body,
        });
      });
      response.on('error', reject);
    });

    request.on('timeout', () => { request.destroy(); reject(new Error('Request timed out')); });
    request.on('error', reject);
    request.end();
  });
}
