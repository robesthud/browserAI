// ============================================
// AI CODE STUDIO - CORS BYPASS PROXY ROUTE
// ============================================

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export async function proxyRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { url } = request.query as { url?: string };

    if (!url) {
      return reply.code(400).send({ error: 'Missing url parameter' });
    }

    try {
      let targetUrl = url;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      const parsedUrl = new URL(targetUrl);
      const origin = parsedUrl.origin;

      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });

      if (!response.ok) {
        return reply.code(response.status).send({ error: `Failed to fetch target URL: ${response.statusText}` });
      }

      const contentType = response.headers.get('content-type') || '';
      
      // If it's an HTML page, rewrite URLs so they go through the proxy as well
      if (contentType.includes('text/html')) {
        let html = await response.text();

        // Rewrite relative URLs to absolute, then wrap them in proxy URL
        // 1. Rewrite relative paths for stylesheets, scripts, images
        html = html.replace(/(src|href|action)="\/(?!\/)/g, `$1="${origin}/`);
        html = html.replace(/(src|href|action)='\/(?!\/)/g, `$1='${origin}/`);

        // 2. Wrap links, forms, and scripts so they load through this proxy
        // Specifically for HTML navigation: <a href="http://..."> and <form action="http://...">
        html = html.replace(/(href|action)="((http|https):\/\/[^"]+)"/g, (match, attr, val) => {
          // Exclude static resources if we only want to proxy HTML pages, but for CORS bypass, proxying everything is safer
          if (val.match(/\.(png|jpg|jpeg|gif|css|js|svg|woff|woff2|ico)$/i)) {
            return `${attr}="${val}"`;
          }
          return `${attr}="/api/proxy?url=${encodeURIComponent(val)}"`;
        });

        // 3. Inject frame message-passing helpers or remove frame-busting scripts
        const injection = `
          <script>
            // Frame busting bypass
            window.self = window.top;
            
            // Capture link clicks and notify parent
            document.addEventListener('click', function(e) {
              const anchor = e.target.closest('a');
              if (anchor && anchor.href) {
                // If it is already proxied, notify parent
                const urlParam = new URL(anchor.href).searchParams.get('url');
                if (urlParam) {
                  window.parent.postMessage({ type: 'BROWSER_NAVIGATION', url: urlParam }, '*');
                } else {
                  window.parent.postMessage({ type: 'BROWSER_NAVIGATION', url: anchor.href }, '*');
                }
              }
            }, true);
          </script>
        `;
        html = html.replace('</head>', `${injection}</head>`);

        // Strip frame security headers
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.removeHeader('X-Frame-Options');
        reply.removeHeader('Content-Security-Policy');
        return reply.send(html);
      }

      // For binary or other non-HTML resources (images, css, js), return directly or redirect
      const arrayBuffer = await response.arrayBuffer();
      reply.header('Content-Type', contentType);
      reply.removeHeader('X-Frame-Options');
      reply.removeHeader('Content-Security-Policy');
      return reply.send(Buffer.from(arrayBuffer));
    } catch (error) {
      console.error('CORS Proxy Error:', error);
      return reply.code(500).send({ error: `Proxy Error: ${String(error)}` });
    }
  });
}
