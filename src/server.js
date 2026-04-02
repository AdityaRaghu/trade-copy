import http from 'node:http';

import { config, requireKiteCredentials } from './config.js';
import { TradeCopier } from './tradeCopier.js';

const copier = new TradeCopier({ config });
await copier.resume();

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

		if (req.method === 'GET' && url.pathname === '/') {
			return sendHtml(res, renderHome(copier.getStatus()));
		}

		if (req.method === 'GET' && url.pathname === '/health') {
			return sendJson(res, 200, {
				ok: true,
				status: copier.getStatus(),
			});
		}

		if (req.method === 'GET' && url.pathname === '/api/status') {
			return sendJson(res, 200, copier.getStatus());
		}

		if (req.method === 'GET' && url.pathname === '/auth/start') {
			const account = url.searchParams.get('account');
			if (!['leader', 'follower'].includes(account)) {
				return sendJson(res, 400, {
					error: 'Use /auth/start?account=leader or /auth/start?account=follower',
				});
			}
			requireKiteCredentials(account);

			res.writeHead(302, {
				Location: copier.buildLoginUrl(account),
			});
			res.end();
			return;
		}

		if (req.method === 'GET' && url.pathname === '/auth/zerodha/callback') {
			const account = url.searchParams.get('account');
			const requestToken = url.searchParams.get('request_token');
			const status = url.searchParams.get('status');

			if (status !== 'success' || !account || !requestToken) {
				return sendHtml(
					res,
					renderMessage(
						'Authentication failed',
						'The callback did not include a successful Zerodha login response.',
					),
					400,
				);
			}
			requireKiteCredentials(account);

			const session = await copier.completeLogin(account, requestToken);
			return sendHtml(
				res,
				renderMessage(
					'Authentication complete',
					`${account} is now connected as ${session.userId}. You can close this tab and go back to the dashboard.`,
				),
			);
		}

		if (req.method === 'POST' && url.pathname === '/api/fanout') {
			requireKiteCredentials(['leader', 'follower']);
			const body = await readJsonBody(req);
			const result = await copier.fanoutPlaceOrder(body);
			return sendJson(res, 200, result);
		}

		if (req.method === 'POST' && url.pathname === '/api/simulate/leader-order') {
			const body = await readJsonBody(req);
			await copier.simulateSourceOrder(body);
			return sendJson(res, 200, {
				ok: true,
				status: copier.getStatus(),
			});
		}

		sendJson(res, 404, { error: 'Route not found' });
	} catch (error) {
		const statusCode = error.status && Number.isInteger(error.status) ? error.status : 500;
		sendJson(res, statusCode, {
			error: error.message,
			details: error.body ?? undefined,
		});
	}
});

if (process.env.SKIP_SERVER_LISTEN === 'true') {
	console.info('Trade copier booted with SKIP_SERVER_LISTEN=true');
} else {
	server.listen(config.port, config.host, () => {
		console.info(
			`Trade copier listening on http://${config.host}:${config.port} (dry_run=${config.dryRun})`,
		);
	});
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		await copier.shutdown();
		server.close(() => process.exit(0));
	});
}

function sendJson(res, statusCode, data) {
	res.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
	});
	res.end(JSON.stringify(data, null, 2));
}

function sendHtml(res, html, statusCode = 200) {
	res.writeHead(statusCode, {
		'Content-Type': 'text/html; charset=utf-8',
	});
	res.end(html);
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}

	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) {
		return {};
	}

	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error('Request body must be valid JSON.');
	}
}

function renderHome(status) {
	const recentEvents = (status.recentEvents ?? [])
		.slice(0, 15)
		.map(
			(event) =>
				`<li><strong>${escapeHtml(event.type)}</strong> ${escapeHtml(
					event.summary,
				)}<br><small>${escapeHtml(event.at)}</small></li>`,
		)
		.join('');

	const simulateExample = escapeHtml(
		JSON.stringify(
			{
				order_id: 'SIM-1001',
				status: 'OPEN',
				variety: 'regular',
				exchange: 'NFO',
				tradingsymbol: 'NIFTY2530620000PE',
				transaction_type: 'SELL',
				order_type: 'LIMIT',
				quantity: 75,
				product: 'NRML',
				validity: 'DAY',
				disclosed_quantity: 0,
				price: 150,
				trigger_price: 0,
			},
			null,
			2,
		),
	);

function accountStatusHtml(label, info) {
	if (!info.configured) {
		return `<p><strong>${label}:</strong> <span style="color:#c00">Not configured</span> — add API keys to .env</p>`;
	}
	if (info.expired) {
		return `<p><strong>${label}:</strong> <span style="color:#c00">TOKEN EXPIRED</span> (was ${escapeHtml(info.userId)},
age: ${escapeHtml(info.tokenAge)}) — <a href="/auth/start?account=${label.toLowerCase()}">Re-authenticate</a></p>`;
	}
	if (info.connected) {
		return `<p><strong>${label}:</strong> <span style="color:#16803c">${escapeHtml(info.userId)}</span> (token age: ${escapeHtml(info.tokenAge)})</p>`;
	}
	return `<p><strong>${label}:</strong> <span style="color:#b45309">Not connected</span> — <a href="/auth/start?account=${label.toLowerCase()}">Connect now</a></p>`;
}

const leaderHtml = accountStatusHtml('Leader', status.leader);
const followerHtml = accountStatusHtml('Follower', status.follower);

// Show a prominent warning banner when tokens are expired or not connected
const needsAttention = !status.leader.connected || !status.follower.connected || status.leader.expired || status.follower.expired;
const warningBanner = needsAttention
	? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:12px;padding:14px 18px;margin-bottom:16px">
		<strong style="color:#92400e">Action needed before market opens:</strong>
		<span style="color:#78350f">
			${!status.leader.connected || status.leader.expired ? 'Leader account needs (re-)authentication. ' : ''}
			${!status.follower.connected || status.follower.expired ? 'Follower account needs (re-)authentication. ' : ''}
			Kite tokens expire daily at ~6 AM IST.
		</span>
	</div>`
	: `''`;

const streamColor = status.sourceSocketState === 'connected' ? '#16803c'
	: status.sourceSocketState === 'token_expired' ? '#c00'
	: '#b45309';

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="30" />
    <title>Trade Mirror - Dashboard</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f4ef;
        --card: #fffdf8;
        --ink: #1c1d1f;
        --muted: #5d646d;
        --accent: #005f73;
        --border: #d9d1c6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top right, rgba(0, 95, 115, 0.08), transparent 26%),
          linear-gradient(180deg, #f2ede5 0%, var(--bg) 100%);
        color: var(--ink);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1, h2 { font-family: "IBM Plex Serif", Georgia, serif; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 14px 30px rgba(28, 29, 31, 0.05);
      }
      .pill {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(0, 95, 115, 0.1);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      .pill-live {
        background: rgba(22, 128, 60, 0.12);
        color: #16803c;
      }
      .pill-dry {
        background: rgba(180, 83, 9, 0.12);
        color: #b45309;
      }
      a {
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
        margin-right: 12px;
      }
      pre {
        background: #1f2933;
        color: #f8fafc;
        border-radius: 14px;
        padding: 14px;
        overflow: auto;
        font-size: 13px;
      }
      ul {
        padding-left: 18px;
      }
      li {
        margin-bottom: 10px;
      }
      .muted {
        color: var(--muted);
      }
      .step-num {
        display: inline-block;
        width: 28px;
        height: 28px;
        line-height: 28px;
        text-align: center;
        border-radius: 50%;
        background: var(--accent);
        color: #fff;
        font-weight: 700;
        font-size: 14px;
        margin-right: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <span class="pill">Mirror Mode</span>
      <span class="pill ${status.dryRun ? 'pill-dry' : 'pill-live'}">${status.dryRun ? 'DRY RUN' : 'LIVE'}</span>
      <h1>Trade Mirror Dashboard</h1>
      <p class="muted">
        Copies your friend's (leader) trades into your (follower) account in near real-time.
        This page auto-refreshes every 30 seconds.
      </p>

      ${warningBanner}

      <div class="grid">
        <section class="card">
          <h2>Account status</h2>
          ${leaderHtml}
          ${followerHtml}
          <p><strong>WebSocket stream:</strong> <span style="color:${streamColor}">${escapeHtml(status.sourceSocketState)}</span></p>
          <p><strong>Quantity multiplier:</strong> ${escapeHtml(String(status.quantityMultiplier))}x</p>
          <p><strong>Orders mirrored:</strong> ${escapeHtml(String(status.mirroredOrders))}</p>
        </section>

        <section class="card">
          <h2>Daily checklist</h2>
          <p><span class="step-num">1</span> Start server (<code>npm start</code>)</p>
          <p><span class="step-num">2</span> <a href="/auth/start?account=leader">Connect leader</a> (your friend logs in)</p>
          <p><span class="step-num">3</span> <a href="/auth/start?account=follower">Connect follower</a> (you log in)</p>
          <p><span class="step-num">4</span> Keep laptop open until 3:30 PM</p>
          <p class="muted" style="margin-top:8px">Tokens expire at ~6 AM IST daily. Repeat steps 2-3 every morning before 9:15 AM.</p>
        </section>
      </div>

      <section class="card" style="margin-top: 16px;">
        <h2>Test the mirror logic safely</h2>
        <p class="muted">Use the simulate endpoint while <code>DRY_RUN=true</code> to test without real money. This simulates your friend selling an option:</p>
        <pre>curl -X POST http://localhost:${config.port}/api/simulate/leader-order \\
-H "Content-Type: application/json" \\
-d '${simulateExample.replace(/'/g, "\\'")}'</pre>
        </section>

        <section class="card" style="margin-top: 16px;">
          <h2>Recent events</h2>
          <ul>${recentEvents || '<li>No events yet. Connect both accounts to start.</li>'}</ul>
        </section>
      </main>
    </body>
  </html>`;
}

function renderMessage(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        padding: 32px;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: #f6f4ef;
        color: #1c1d1f;
      }
      article {
        max-width: 720px;
        margin: 10vh auto 0;
        background: #fffdf8;
        border: 1px solid #d9d1c6;
        border-radius: 18px;
        padding: 24px;
      }
    </style>
  </head>
  <body>
    <article>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      <p><a href="/">Return to dashboard</a></p>
    </article>
  </body>
</html>`;
}

function escapeHtml(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}