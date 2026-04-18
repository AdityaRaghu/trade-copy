import http from 'node:http';
import { config, requireKiteCredentials } from './config.js';
import { TradeCopier } from './tradeCopier.js';

const copier = new TradeCopier({ config });
await copier.resume();

const knownAccounts = new Set(['leader', 'follower']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { method, pathname: p } = { method: req.method, pathname: url.pathname };

    if (method === 'GET' && p === '/') return sendHtml(res, renderHome(copier.getStatus()));
    if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true, status: copier.getStatus() });
    if (method === 'GET' && p === '/api/status') return sendJson(res, 200, copier.getStatus());

    if (method === 'GET' && p === '/auth/start') {
      const account = url.searchParams.get('account');
      if (!account || !knownAccounts.has(account))
        return sendJson(res, 400, { error: `Unknown account. Use: ${[...knownAccounts].join(', ')}` });
      requireKiteCredentials(account);
      res.writeHead(302, { Location: copier.buildLoginUrl(account) });
      res.end();
      return;
    }

    if (method === 'GET' && p === '/auth/zerodha/callback') {
      const account = url.searchParams.get('account');
      const requestToken = url.searchParams.get('request_token');
      if (url.searchParams.get('status') !== 'success' || !account || !knownAccounts.has(account) || !requestToken)
        return sendHtml(res, renderMsg('Authentication failed', 'The callback did not include a successful Zerodha login response.'), 400);
      requireKiteCredentials(account);
      const session = await copier.completeLogin(account, requestToken);
      return sendHtml(res, renderMsg('Authentication complete', `${account} connected as ${session.userId}. You can close this tab.`));
    }

    if (method === 'POST' && p === '/api/fanout') {
      requireKiteCredentials([...knownAccounts]);
      return sendJson(res, 200, await copier.fanoutPlaceOrder(await readJsonBody(req)));
    }

    if (method === 'POST' && p === '/api/simulate/leader-order') {
      await copier.simulateSourceOrder(await readJsonBody(req));
      return sendJson(res, 200, { ok: true, status: copier.getStatus() });
    }

    sendJson(res, 404, { error: 'Route not found' });
  } catch (error) {
    const code = error.status && Number.isInteger(error.status) ? error.status : 500;
    sendJson(res, code, { error: error.message, details: error.body ?? undefined });
  }
});

if (process.env.SKIP_SERVER_LISTEN === 'true') {
  console.info('Trade copier booted with SKIP_SERVER_LISTEN=true');
} else {
  server.listen(config.port, config.host, () =>
    console.info(`Trade copier listening on http://${config.host}:${config.port} (dry_run=${config.dryRun})`)
  );
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => { await copier.shutdown(); server.close(() => process.exit(0)); });

const sendJson = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data, null, 2)); };
const sendHtml = (res, html, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Request body must be valid JSON.'); }
}

const esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function acctRow(label, info, id) {
  if (!info.configured) return `<p><b>${esc(label)}:</b> <span style="color:#c00">Not configured</span> — add API keys to .env</p>`;
  if (info.expired) return `<p><b>${esc(label)}:</b> <span style="color:#c00">TOKEN EXPIRED</span> (${esc(info.userId)}, ${esc(info.tokenAge)}) — <a href="/auth/start?account=${esc(id)}">Re-authenticate</a></p>`;
  if (info.connected) return `<p><b>${esc(label)}:</b> <span style="color:#16803c">${esc(info.userId)}</span> (age: ${esc(info.tokenAge)})</p>`;
  return `<p><b>${esc(label)}:</b> <span style="color:#b45309">Not connected</span> — <a href="/auth/start?account=${esc(id)}">Connect now</a></p>`;
}

function renderHome(status) {
  const follower = status.follower;
  const warn = [
    (!status.leader.connected || status.leader.expired) ? 'Leader needs re-authentication.' : null,
    (follower && (!follower.connected || follower.expired)) ? `${esc(follower.label ?? follower.id)} needs re-authentication.` : null,
  ].filter(Boolean);
  const streamColor = status.sourceSocketState === 'connected' ? '#16803c' : status.sourceSocketState === 'token_expired' ? '#c00' : '#b45309';
  const events = (status.recentEvents ?? []).slice(0, 15).map(e => `<li><b>${esc(e.type)}</b> ${esc(e.summary)}<br><small>${esc(e.at)}</small></li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Trade Mirror</title>
<style>:root{--bg:#f6f4ef;--card:#fffdf8;--ink:#1c1d1f;--muted:#5d646d;--accent:#005f73;--border:#d9d1c6}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,rgba(0,95,115,.08),transparent 26%),linear-gradient(180deg,#f2ede5,var(--bg));color:var(--ink);font-family:"IBM Plex Sans","Segoe UI",sans-serif}main{max-width:960px;margin:0 auto;padding:32px 20px 48px}h1,h2{font-family:"IBM Plex Serif",Georgia,serif}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px;box-shadow:0 14px 30px rgba(28,29,31,.05)}.pill{display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(0,95,115,.1);color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase}.pill-live{background:rgba(22,128,60,.12);color:#16803c}.pill-dry{background:rgba(180,83,9,.12);color:#b45309}a{color:var(--accent);text-decoration:none;font-weight:600;margin-right:12px}pre{background:#1f2933;color:#f8fafc;border-radius:14px;padding:14px;overflow:auto;font-size:13px}ul{padding-left:18px}li{margin-bottom:10px}.muted{color:var(--muted)}.step-num{display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:14px;margin-right:8px}</style>
</head><body><main>
<span class="pill">Mirror Mode</span>
<span class="pill ${status.dryRun ? 'pill-dry' : 'pill-live'}">${status.dryRun ? 'DRY RUN' : 'LIVE'}</span>
<h1>Trade Mirror Dashboard</h1>
<p class="muted">Copies leader trades to the follower account. Auto-refreshes every 30s.</p>
${warn.length ? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:12px;padding:14px 18px;margin-bottom:16px"><b style="color:#92400e">Action needed:</b> <span style="color:#78350f">${warn.join(' ')} Tokens expire daily at ~6 AM IST.</span></div>` : ''}
<div class="grid"><section class="card">
<h2>Account status</h2>
${acctRow('Leader', status.leader, 'leader')}
${follower ? acctRow(follower.label ?? follower.id, follower, follower.id) : '<p><b>Follower:</b> <span style="color:#b45309">Not configured.</span></p>'}
<p><b>WebSocket:</b> <span style="color:${streamColor}">${esc(status.sourceSocketState)}</span></p>
<p><b>Default qty multiplier:</b> ${esc(String(status.quantityMultiplier))}x</p>
<p><b>Orders mirrored:</b> ${esc(String(status.mirroredOrders))}</p>
</section>
<section class="card"><h2>Daily checklist</h2>
<p><span class="step-num">1</span> Start server (<code>npm start</code>)</p>
<p><span class="step-num">2</span> <a href="/auth/start?account=leader">Connect leader</a></p>
<p><span class="step-num">3</span> Connect follower from the status panel</p>
<p><span class="step-num">4</span> Keep open until 3:30 PM</p>
<p class="muted" style="margin-top:8px">Re-authenticate every morning before 9:15 AM.</p>
</section></div>
<section class="card" style="margin-top:16px"><h2>Recent events</h2>
<ul>${events || '<li>No events yet.</li>'}</ul></section>
</main></body></html>`;
}

function renderMsg(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;padding:32px;font-family:"IBM Plex Sans","Segoe UI",sans-serif;background:#f6f4ef;color:#1c1d1f}article{max-width:720px;margin:10vh auto 0;background:#fffdf8;border:1px solid #d9d1c6;border-radius:18px;padding:24px}</style></head><body><article><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a href="/">Return to dashboard</a></p></article></body></html>`;
}