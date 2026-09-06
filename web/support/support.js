'use strict';
(() => {
  const $ = id => document.getElementById(id);
  // Production never accepts a query-string API override or sends case links
  // to arbitrary hosts. Local development serves a same-origin API proxy.
  const local = ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(location.hostname);
  const api = local ? `${location.origin}/v1` : 'https://api.yappy.gg/v1';
  const params = new URLSearchParams(location.search);
  let appealToken = new URLSearchParams(location.hash.slice(1)).get('appeal') || undefined;
  let requestId = crypto.randomUUID();
  let available = false, linkReady = !appealToken, busy = false;
  const form = $('support-form');
  if (['account', 'bug', 'appeal', 'other'].includes(params.get('topic'))) $('topic').value = params.get('topic');
  $('client').value = (params.get('client') || '').slice(0, 160);
  if (appealToken) $('topic').value = 'appeal';

  function updateTopic() {
    const appeal = $('topic').value === 'appeal';
    $('message-label').textContent = appeal ? 'What would you like us to review?' : 'What happened?';
    $('message').placeholder = appeal ? 'Explain why you believe the suspension should be reviewed. Include any context we may have missed.' : 'Tell us what happened and what you need help with.';
    $('submit').firstElementChild.textContent = busy ? 'Sending…' : appeal ? 'Send appeal' : 'Send request';
  }
  function updateEnabled() {
    $('fields').disabled = !available || !linkReady || busy;
    $('topic').disabled = Boolean(appealToken);
    updateTopic();
  }
  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(`${api}/support${path}`, { method: body ? 'POST' : 'GET',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        credentials: 'omit', cache: 'no-store', signal: controller.signal });
      const data = await res.json();
      if (!res.ok) {
        const wait = Number(data.error?.retryAfter || res.headers.get('Retry-After'));
        const message = res.status === 429 ? `Too many requests. Please try again${wait > 0 ? ` in ${Math.ceil(wait / 60)} minute(s)` : ' later'}.`
          : data.error?.message || 'Your request could not be sent. Please try again.';
        throw new Error(message);
      }
      return data;
    } catch (error) {
      if (error instanceof TypeError || error.name === 'AbortError' || error instanceof SyntaxError) {
        throw new Error('We couldn’t reach support. Check your connection and try again.');
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function initialize() {
    await Promise.allSettled([
      (async () => {
        try {
          const config = await request('/config');
          available = config.available === true;
          $('availability').hidden = available;
          if (!available) $('availability').textContent = 'The form is temporarily unavailable. You can still email us below.';
          if (typeof config.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) {
            $('email-link').textContent = config.email;
            $('email-link').href = `mailto:${encodeURIComponent(config.email)}`;
          }
        } catch { $('availability').textContent = 'We couldn’t connect. Reload to try again, or email us below.'; }
        updateEnabled();
      })(),
      (async () => {
        if (!appealToken) return;
        try {
          const context = await request('/appeal-context', { appealToken });
          $('account').value = context.account || '';
          $('case-details').textContent = `${context.account ? `@${context.account} · ` : ''}Case ${context.caseReference}`;
          $('case').hidden = false;
          linkReady = true;
        } catch (error) {
          $('link-error-message').textContent = error.message;
          $('link-error').hidden = false;
        }
        updateEnabled();
      })(),
    ]);
  }
  $('unlink').addEventListener('click', () => {
    appealToken = undefined; linkReady = true; requestId = crypto.randomUUID();
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    $('link-error').hidden = true; updateEnabled(); $('email').focus();
  });
  form.addEventListener('input', () => {
    if (busy) return;
    requestId = crypto.randomUUID();
    $('submit-error').hidden = true;
    $('count').textContent = `${$('message').value.length.toLocaleString()} / 6,000`;
    updateTopic();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !available || !linkReady || !form.reportValidity()) return;
    if ($('message').value.trim().length < 20) {
      $('submit-error').textContent = 'Please add at least 20 characters of detail.';
      $('submit-error').hidden = false; $('message').focus(); return;
    }
    const body = { requestId, category: $('topic').value, email: $('email').value.trim(),
      account: $('account').value.trim(), message: $('message').value.trim(), client: $('client').value.trim(),
      ...(appealToken ? { appealToken } : {}) };
    busy = true; $('submit-error').hidden = true; updateEnabled();
    try {
      const result = await request('/tickets', body);
      if (!result.ticket?.reference) throw new Error('We couldn’t confirm your request. Please try again.');
      $('reference').textContent = result.ticket.reference;
      $('reply-email').textContent = body.email;
      $('appeal-reminder').hidden = body.category !== 'appeal';
      $('intake').hidden = true; $('success').hidden = false; $('success').focus();
      $('success').scrollIntoView({ block: 'center' });
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (error) {
      $('submit-error').textContent = error.message;
      $('submit-error').hidden = false;
    } finally { busy = false; updateEnabled(); }
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('reference').textContent); $('copy').textContent = 'Copied'; }
    catch { $('copy').textContent = 'Select the reference above to copy it'; }
  });
  $('another').addEventListener('click', () => {
    form.reset(); appealToken = undefined; linkReady = true; requestId = crypto.randomUUID();
    $('case').hidden = true; $('success').hidden = true; $('intake').hidden = false;
    $('copy').textContent = 'Copy reference'; $('count').textContent = '0 / 6,000';
    updateEnabled(); $('topic').focus();
  });
  updateTopic(); initialize();
})();
