/**
 * ============================================
 * AI CODE STUDIO - BROWSER AI AGENT
 * Playwright-based browser automation with MCP
 * ============================================
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { chromium, Browser, Page, BrowserContext } from 'playwright';

const fastify = Fastify({ logger: true });
let browser: Browser;
const sessions = new Map<string, BrowserSession>();

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastActivity: Date;
}

// ============================================
// BROWSER MANAGEMENT
// ============================================

async function initBrowser() {
  browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  console.log('Browser initialized');
}

async function getSession(sessionId: string): Promise<BrowserSession> {
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = new Date();
    return session;
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'AI Code Studio Browser Agent',
  });
  const page = await context.newPage();

  const session: BrowserSession = {
    context,
    page,
    lastActivity: new Date(),
  };

  sessions.set(sessionId, session);
  return session;
}

// ============================================
// API ROUTES
// ============================================

fastify.post('/api/browser/agent', async (request, reply) => {
  const { instruction, startUrl, sessionId = 'default' } = request.body as {
    instruction: string;
    startUrl?: string;
    sessionId?: string;
  };

  try {
    const session = await getSession(sessionId);
    const { page } = session;

    // Navigate to start URL if provided
    if (startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    }

    // Execute instruction using AI planning
    const result = await executeInstruction(page, instruction);

    // Take screenshot
    const screenshot = await page.screenshot({ encoding: 'base64' });

    return {
      result,
      screenshot,
      url: page.url(),
      title: await page.title(),
    };
  } catch (error) {
    return reply.code(500).send({ error: String(error) });
  }
});

// ============================================
// INSTRUCTION EXECUTOR
// ============================================

interface ActionResult {
  success: boolean;
  action: string;
  data?: any;
  error?: string;
}

async function executeInstruction(page: Page, instruction: string): Promise<ActionResult> {
  const lower = instruction.toLowerCase();

  try {
    // Navigation
    if (lower.includes('go to') || lower.includes('navigate to')) {
      const urlMatch = instruction.match(/(?:go to|navigate to)\s+(\S+)/i);
      if (urlMatch) {
        let url = urlMatch[1];
        if (!url.startsWith('http')) {
          url = 'https://' + url;
        }
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { success: true, action: 'navigate', data: { url } };
      }
    }

    // Search
    if (lower.includes('search for') || lower.includes('search')) {
      const searchMatch = instruction.match(/search(?:\s+for)?\s+["']?(.+?)["']?$/i);
      if (searchMatch) {
        const query = searchMatch[1];
        // Try common search input selectors
        const searchInput = await page.$('input[type="search"], input[name="q"], input[placeholder*="search" i]');
        if (searchInput) {
          await searchInput.fill(query);
          await searchInput.press('Enter');
          await page.waitForLoadState('domcontentloaded');
          return { success: true, action: 'search', data: { query } };
        }
      }
    }

    // Click
    if (lower.includes('click')) {
      const clickMatch = instruction.match(/click(?:\s+on)?\s+(?:the\s+)?["']?(.+?)["']?$/i);
      if (clickMatch) {
        const target = clickMatch[1];
        // Try text content first
        const element = await page.$(`text="${target}"`) ||
                       await page.$(`[aria-label="${target}"]`) ||
                       await page.$(`button:has-text("${target}")`) ||
                       await page.$(`a:has-text("${target}")`);
        
        if (element) {
          await element.click();
          return { success: true, action: 'click', data: { target } };
        }
      }
    }

    // Type
    if (lower.includes('type') || lower.includes('enter')) {
      const typeMatch = instruction.match(/(?:type|enter)\s+["'](.+?)["']/i);
      const inMatch = instruction.match(/in(?:to)?\s+(?:the\s+)?(.+?)$/i);
      
      if (typeMatch) {
        const text = typeMatch[1];
        const selector = inMatch?.[1] || 'input:visible';
        
        const input = await page.$(selector);
        if (input) {
          await input.fill(text);
          return { success: true, action: 'type', data: { text, selector } };
        }
      }
    }

    // Extract/Find
    if (lower.includes('find') || lower.includes('extract') || lower.includes('get')) {
      const extractMatch = instruction.match(/(?:find|extract|get)\s+(?:all\s+)?(.+)/i);
      if (extractMatch) {
        const target = extractMatch[1].toLowerCase();
        
        let selector = '*';
        if (target.includes('link')) selector = 'a[href]';
        if (target.includes('button')) selector = 'button';
        if (target.includes('image')) selector = 'img';
        if (target.includes('heading')) selector = 'h1, h2, h3';
        if (target.includes('text')) selector = 'p, span, div';

        const elements = await page.$$(selector);
        const data = await Promise.all(
          elements.slice(0, 20).map(async (el) => ({
            tag: await el.evaluate(e => e.tagName),
            text: (await el.textContent())?.trim().slice(0, 100),
            href: await el.getAttribute('href'),
          }))
        );

        return { success: true, action: 'extract', data };
      }
    }

    // Screenshot
    if (lower.includes('screenshot')) {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      return { success: true, action: 'screenshot', data: { screenshot } };
    }

    // Scroll
    if (lower.includes('scroll')) {
      if (lower.includes('down')) {
        await page.evaluate(() => window.scrollBy(0, 500));
      } else if (lower.includes('up')) {
        await page.evaluate(() => window.scrollBy(0, -500));
      } else if (lower.includes('top')) {
        await page.evaluate(() => window.scrollTo(0, 0));
      } else if (lower.includes('bottom')) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }
      return { success: true, action: 'scroll' };
    }

    // Wait
    if (lower.includes('wait')) {
      const timeMatch = instruction.match(/wait\s+(\d+)\s*(?:seconds?|s)/i);
      const ms = timeMatch ? parseInt(timeMatch[1]) * 1000 : 2000;
      await page.waitForTimeout(Math.min(ms, 10000));
      return { success: true, action: 'wait', data: { ms } };
    }

    return { success: false, action: 'unknown', error: 'Could not understand instruction' };
  } catch (error) {
    return { success: false, action: 'error', error: String(error) };
  }
}

// ============================================
// MCP SERVER (Model Context Protocol)
// ============================================

fastify.register(websocket);

fastify.register(async function (fastify) {
  fastify.get('/mcp', { websocket: true }, (connection) => {
    const sessionId = `mcp-${Date.now()}`;

    connection.socket.on('message', async (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString());

        if (message.method === 'tools/list') {
          connection.socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'browser_navigate',
                  description: 'Navigate to a URL',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      url: { type: 'string', description: 'URL to navigate to' },
                    },
                    required: ['url'],
                  },
                },
                {
                  name: 'browser_click',
                  description: 'Click an element on the page',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      selector: { type: 'string', description: 'CSS selector or text content' },
                    },
                    required: ['selector'],
                  },
                },
                {
                  name: 'browser_type',
                  description: 'Type text into an input',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      selector: { type: 'string', description: 'CSS selector for input' },
                      text: { type: 'string', description: 'Text to type' },
                    },
                    required: ['selector', 'text'],
                  },
                },
                {
                  name: 'browser_screenshot',
                  description: 'Take a screenshot of the current page',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'browser_extract',
                  description: 'Extract data from the page',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      selector: { type: 'string', description: 'CSS selector to extract' },
                    },
                    required: ['selector'],
                  },
                },
              ],
            },
          }));
        }

        if (message.method === 'tools/call') {
          const session = await getSession(sessionId);
          const { page } = session;
          const { name, arguments: args } = message.params;
          let result: any;

          try {
            switch (name) {
              case 'browser_navigate':
                await page.goto(args.url, { waitUntil: 'domcontentloaded' });
                result = { url: page.url(), title: await page.title() };
                break;

              case 'browser_click':
                await page.click(args.selector);
                result = { clicked: args.selector };
                break;

              case 'browser_type':
                await page.fill(args.selector, args.text);
                result = { typed: args.text };
                break;

              case 'browser_screenshot':
                const screenshot = await page.screenshot({ encoding: 'base64' });
                result = { screenshot };
                break;

              case 'browser_extract':
                const elements = await page.$$(args.selector);
                result = await Promise.all(
                  elements.map(async (el) => ({
                    text: await el.textContent(),
                    html: await el.innerHTML(),
                  }))
                );
                break;
            }

            connection.socket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
            }));
          } catch (error) {
            connection.socket.send(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -1, message: String(error) },
            }));
          }
        }
      } catch (err) {
        console.error('MCP WebSockets Error:', err);
      }
    });
  });
});

// ============================================
// CLEANUP
// ============================================

// Clean up old sessions every 5 minutes
setInterval(() => {
  const now = new Date();
  for (const [id, session] of sessions) {
    if (now.getTime() - session.lastActivity.getTime() > 15 * 60 * 1000) {
      session.context.close().catch(() => {});
      sessions.delete(id);
      console.log(`Cleaned up session: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// START SERVER
// ============================================

const start = async () => {
  try {
    await initBrowser();
    const port = parseInt(process.env.PORT || '8080');
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Browser agent running on port ${port}`);
  } catch (e) {
    console.error('Failed to start browser agent:', e);
  }
};

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  for (const session of sessions.values()) {
    await session.context.close().catch(() => {});
  }
  await browser?.close().catch(() => {});
  process.exit(0);
});
