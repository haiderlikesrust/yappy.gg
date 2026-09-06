import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export async function checkSupportBrowser({ app, sql, appealUrl, check }) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const root = fileURLToPath(new URL('../../../web/', import.meta.url));
  const output = fileURLToPath(new URL('../../../.tools/', import.meta.url));
  await mkdir(output, { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/v1/support/')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const response = await app.inject({ method: req.method, url: req.url,
          headers: { 'content-type': 'application/json' },
          ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}) });
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' }); res.end(response.body); return;
      }
      let path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
      if (!extname(path)) path = resolve(path, 'index.html');
      const data = await readFile(path);
      const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }[extname(path)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    const reset = () => sql`delete from rate_limits where action in ('support.submit', 'support.context')`;
    const fill = async () => {
      await page.locator('#email').fill('browser@example.invalid');
      await page.locator('#message').fill('I would like help reviewing my account access, please.');
    };
    const ready = () => page.locator('#email:enabled').waitFor();
    await reset();
    await page.goto(base + '/support'); await ready();
    check('support stylesheet applies on the bare /support route', await page.locator('.support-card').first().evaluate(el => getComputedStyle(el).borderRadius === '24px'));
    await page.screenshot({ path: resolve(output, 'support-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(output, 'support-mobile.png'), fullPage: true });
    check('support form loads without trailing slash and fits mobile width', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await fill();
    // Lose the response after the real API commits, then retry in the UI.
    let firstId;
    await page.route('**/v1/support/tickets', async route => {
      firstId = route.request().postDataJSON().requestId;
      await route.fetch(); await route.abort('failed');
    }, { times: 1 });
    await page.locator('#submit').click();
    await page.locator('#submit-error:visible').waitFor();
    check('network failure preserves the form and never shows false success', await page.locator('#success').isHidden() && await page.locator('#message').inputValue() !== '');
    await page.locator('#submit').click(); await page.locator('#success:visible').waitFor();
    check('browser retry confirms the original durable ticket', (await sql`select id from support_tickets where request_id = ${firstId}`).length === 1 && /^SUP-/.test(await page.locator('#reference').textContent()));
    await page.screenshot({ path: resolve(output, 'support-confirmation.png'), fullPage: true });
    await reset();
    await page.goto(base + '/support/?topic=appeal' + new URL(appealUrl).hash); await ready();
    check('appeal opens signed out with the case linked and topic fixed', await page.locator('#case').isVisible() && await page.locator('#topic').isDisabled() && await page.locator('#topic').inputValue() === 'appeal');
    await page.screenshot({ path: resolve(output, 'support-appeal.png'), fullPage: true });
    await fill(); await page.locator('#submit').click(); await page.locator('#success:visible').waitFor();
    check('browser appeal shows a receipt and review reminder', await page.locator('#appeal-reminder').isVisible() && !page.url().includes('#appeal'));
    await reset();
    await page.goto(base + '/support/#appeal=expired');
    await page.locator('#link-error:visible').waitFor();
    check('expired case link blocks submission but leaves the draft editable', await page.locator('#email').isEnabled() && await page.locator('#submit').isDisabled());
    await page.locator('#unlink').click(); await ready();
    check('expired link offers an explicit signed-out fallback', !page.url().includes('#') && await page.locator('#topic').inputValue() === 'appeal');
    await page.route('**/v1/support/config', route => route.fulfill({ json: { available: false, email: null } }));
    await page.goto(base + '/support/'); await page.locator('#availability').filter({ hasText: 'temporarily unavailable' }).waitFor();
    await fill();
    check('unavailable form preserves typing and offers retry while disabling send', await page.locator('#email-link').isVisible() && await page.locator('#submit').isDisabled() && await page.locator('#email').isEnabled() && await page.locator('#retry-connection').isVisible());
    await page.unroute('**/v1/support/config');
    await page.locator('#retry-connection').click();
    await page.locator('#submit:enabled').waitFor();
    check('connection recovery enables submission without losing the draft', await page.locator('#email').inputValue() === 'browser@example.invalid' && (await page.locator('#message').inputValue()).includes('reviewing my account'));
    await reset();
    await page.locator('#submit').click(); await page.locator('#success:visible').waitFor();
    check('request submits successfully after recovering an unavailable connection', /^SUP-/.test(await page.locator('#reference').textContent()));
    await page.route('**/v1/support/config', route => route.abort('failed'));
    await page.goto(base + '/support/');
    await page.locator('#retry-connection:visible').waitFor();
    await fill();
    check('network preflight failure never locks the form', await page.locator('#email').isEnabled() && await page.locator('#success').isHidden());
    await page.unroute('**/v1/support/config');
    await page.locator('#retry-connection').click(); await page.locator('#submit:enabled').waitFor();
    check('network preflight can be retried without reloading', await page.locator('#message').inputValue() !== '');
    // A local file preview has no origin root. Root-absolute assets silently
    // broke this path while the shared document stylesheet still loaded.
    await page.route('https://api.yappy.gg/v1/support/config', route => route.fulfill({ json: { available: false, email: null } }));
    await page.goto(new URL('../../../web/support/index.html', import.meta.url).href);
    await page.locator('#availability').filter({ hasText: 'temporarily unavailable' }).waitFor();
    check('local file preview loads both form styling and JavaScript', await page.locator('.support-card').first().evaluate(el => getComputedStyle(el).borderRadius === '20px'));
    await page.screenshot({ path: resolve(output, 'support-file-preview.png'), fullPage: true });
    check('support UI has no uncaught JavaScript errors', errors.length === 0);
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
