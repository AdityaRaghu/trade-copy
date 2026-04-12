import crypto from 'node:crypto';
import { KiteApiError, KiteClient } from './kiteClient.js';
import { readJsonFile, writeJsonFile } from './storage.js';

const LEADER = 'leader';
const TERMINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const ACTIONABLE = new Set(['OPEN', 'COMPLETE', 'TRIGGER PENDING', 'MODIFIED', 'UPDATE']);
const TOKEN_TTL = 16 * 3_600_000;
const MAX_RETRIES = 2;
const RETRY_MS = 800;

// ── utils ─────────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
const upper = v => String(v ?? '').trim().toUpperCase();
const lower = v => String(v ?? '').trim().toLowerCase();
const makeId = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const makeTag = (pre, suf) => `${pre}${suf}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);

function tokenExpired(s) {
  if (!s?.createdAt) return true;
  return Date.now() - new Date(s.createdAt).getTime() > TOKEN_TTL;
}
function tokenAge(s) {
  if (!s?.createdAt) return 'unknown';
  const ms = Date.now() - new Date(s.createdAt).getTime();
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
function isSelfTagged(order, prefix) {
  return [order?.tag, ...(order?.tags ?? [])].filter(Boolean)
    .map(t => String(t).toUpperCase())
    .some(t => t.startsWith(String(prefix).toUpperCase()));
}
function refPrice(order) {
  const avg = num(order.average_price);
  if (avg > 0) return avg;
  const lim = num(order.price);
  return lim > 0 ? lim : 0;
}
function roundTick(price, tick = 0.05, mode = 'nearest') {
  if (!Number.isFinite(price) || price <= 0 || tick <= 0) return 0;
  const s = price / tick;
  const r = mode === 'floor' ? Math.floor(s) : mode === 'ceil' ? Math.ceil(s) : Math.round(s);
  return Number((r * tick).toFixed(2));
}
function followerLimitPrice(order, cfg) {
  const ref = refPrice(order);
  if (ref <= 0) return 0;
  const dev = Math.max(0, num(cfg.maxPriceDeviationPercent, 1.0));
  return upper(order.transaction_type) === 'BUY'
    ? roundTick(ref * (1 + dev / 100), cfg.priceTickSize, 'floor')
    : roundTick(ref * (1 - dev / 100), cfg.priceTickSize, 'ceil');
}
function serializeError(err) {
  if (err instanceof KiteApiError)
    return { name: err.name, message: err.message, status: err.status, errorType: err.errorType, body: err.body };
  return { name: err?.name ?? 'Error', message: err?.message ?? String(err) };
}

// ── exported pure functions ───────────────────────────────────────────────────
export function normalizeOrderStatus(s) { return upper(s).replace(/\s+/g, ' ').trim(); }

export function normalizeOrderInput(o = {}) {
  return {
    variety: lower(o.variety || 'regular'),
    exchange: upper(o.exchange),
    tradingsymbol: String(o.tradingsymbol ?? '').trim(),
    transaction_type: upper(o.transaction_type),
    order_type: upper(o.order_type),
    quantity: Math.trunc(num(o.quantity)),
    product: upper(o.product),
    validity: upper(o.validity || 'DAY'),
    disclosed_quantity: Math.max(0, Math.trunc(num(o.disclosed_quantity))),
    price: num(o.price),
    trigger_price: num(o.trigger_price),
    market_protection: o.market_protection == null ? undefined : String(o.market_protection),
  };
}

export function isActionableSourceOrder(order, cfg = {}) {
  const status = normalizeOrderStatus(order.status);
  if (cfg.followMarketOrdersAsLimit && upper(order.order_type) === 'MARKET')
    return status === 'COMPLETE';
  if (TERMINAL.has(status) && status !== 'COMPLETE') return false;
  if (ACTIONABLE.has(status)) return true;
  return Boolean(order.exchange_order_id);
}

export function validateOrderAgainstPolicy(order, cfg) {
  const r = [];
  if (!cfg.allowedVarieties.includes(order.variety)) r.push(`Variety ${order.variety} is not allowed.`);
  if (!cfg.allowedExchanges.includes(order.exchange)) r.push(`Exchange ${order.exchange} is not allowed.`);
  if (!cfg.allowedProducts.includes(order.product)) r.push(`Product ${order.product} is not allowed.`);
  if (!cfg.allowedOrderTypes.includes(order.order_type)) r.push(`Order type ${order.order_type} is not allowed.`);
  if (!cfg.allowMarketOrders && order.order_type === 'MARKET') r.push('Market orders are disabled.');
  if (!order.tradingsymbol) r.push('Missing trading symbol.');
  if (order.quantity <= 0) r.push('Quantity must be greater than zero.');
  if (cfg.maxQuantityPerOrder > 0 && order.quantity > cfg.maxQuantityPerOrder)
    r.push(`Quantity ${order.quantity} exceeds MAX_QUANTITY_PER_ORDER=${cfg.maxQuantityPerOrder}.`);
  return { ok: r.length === 0, reasons: r };
}

export function buildFollowerOrder(sourceOrder, cfg, { traceId } = {}) {
  const norm = normalizeOrderInput(sourceOrder);
  let qty =Math.floor(norm.quantity * num(cfg.quantityMultiplier, 1));
  if (cfg.lotSize > 0)
    qty = Math.floor(qty / cfg.lotSize) * cfg.lotSize;
  if (cfg.maxLots > 0 && cfg.lotSize > 0)
    qty = Math.min(qty, cfg.maxLots * cfg.lotSize);
  const tag = makeTag(cfg.tagPrefix, traceId ?? String(sourceOrder.order_id ?? makeId()).slice(-8));
  const order = { ...norm, quantity: qty, tag };

  if (cfg.followMarketOrdersAsLimit && upper(order.order_type) === 'MARKET') {
    const lp = followerLimitPrice(sourceOrder, cfg);
    if (lp > 0)
      return { ...order, order_type: 'LIMIT', price: lp, trigger_price: 0, market_protection: undefined };
    // average_price was 0 → fall through to protected market order
  }

  if (['MARKET', 'SL-M'].includes(upper(order.order_type))) {
    const mp = String(order.market_protection ?? '').trim();
    if (!mp || mp === '0') order.market_protection = String(cfg.marketProtection ?? '-1');
  }

  return order;
}

// ── TradeCopier ───────────────────────────────────────────────────────────────
export class TradeCopier {
  constructor({ config, logger = console }) {
    this.cfg = config;
    this.logger = logger;

    this.clients = { [LEADER]: this._mkClient(LEADER) };
    for (const f of this._followers()) this.clients[f.id] = this._mkClient(f.id);

    this.tokens = readJsonFile(config.tokenStoreFile, { [LEADER]: null, followers: {} });
    this.tokens.followers ??= {};

    // Migrate old single-follower token format
    if (this.tokens.follower && !Object.keys(this.tokens.followers).length) {
      const first = this._followers()[0];
      if (first) { this.tokens.followers[first.id] = this.tokens.follower; delete this.tokens.follower; this._persistTokens(); }
    }

    this.runtime = readJsonFile(config.runtimeStoreFile, { mirroredOrders: {}, recentEvents: [] });

    // Migrate old single-follower runtime format
    const first = this._followers()[0];
    for (const entry of Object.values(this.runtime.mirroredOrders)) {
      if (entry.followerOrderId && !entry.followers && first) {
        entry.followers = { [first.id]: { mirrorStatus: entry.mirrorStatus, followerOrderId: entry.followerOrderId, followerVariety: entry.followerVariety, errors: entry.errors } };
        ['followerOrderId', 'followerVariety', 'mirrorStatus', 'blockedReasons', 'errors'].forEach(k => delete entry[k]);
      }
    }

    this.sourceSocket = null;
    this.socketState = 'disconnected';
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.isShuttingDown = false;
    this.inFlight = new Set();
  }

  getStatus() {
    return {
      dryRun: this.cfg.dryRun,
      sourceSocketState: this.socketState,
      quantityMultiplier: this.cfg.quantityMultiplier,
      leader: this._sessionSummary(LEADER),
      followers: this._followers().map(f => ({ id: f.id, label: f.label, ...this._sessionSummary(f.id) })),
      recentEvents: this.runtime.recentEvents,
      mirroredOrders: Object.keys(this.runtime.mirroredOrders).length,
    };
  }

  buildLoginUrl(account) { return this._client(account).buildLoginUrl({ account }); }
  isSessionExpired(account) { return tokenExpired(this._getSession(account)); }
  getSessionAge(account) { return tokenAge(this._getSession(account)); }

  async completeLogin(account, requestToken) {
    const raw = await this._client(account).exchangeRequestToken(requestToken);
    const session = {
      account, userId: raw.user_id, userName: raw.user_name,
      apiKey: this._acctCfg(account).apiKey,
      accessToken: raw.access_token, publicToken: raw.public_token,
      loginTime: raw.login_time, createdAt: nowIso(),
    };
    this._setSession(account, session);
    this._persistTokens();
    await this._snapshotPositions(account, session.accessToken);
    this._log('auth.success', `${account} account authenticated`, { account, userId: session.userId });
    if (account === LEADER) this.startSourceStream(true);
    return session;
  }

  async resume() {
    for (const id of [LEADER, ...this._followerIds()]) {
      const s = this._getSession(id);
      if (s?.accessToken && tokenExpired(s))
        this._log('auth.expired', `${id} token expired (${tokenAge(s)}). Re-authenticate.`, { account: id });
    }
    const ls = this._getSession(LEADER);
    if (ls?.accessToken) {
      if (tokenExpired(ls)) { this._log('stream.skip', 'Leader token expired – re-authenticate before market opens'); return; }
      this.startSourceStream();
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sourceSocket?.readyState < WebSocket.CLOSING) this.sourceSocket.close();
  }

  async fanoutPlaceOrder(rawOrder) {
    const traceId = makeId();
    const leaderSession = this._requireSession(LEADER);
    const leaderOrder = normalizeOrderInput(rawOrder);
    leaderOrder.tag = makeTag(`${this.cfg.tagPrefix}L`, traceId);
    this._patchMp(leaderOrder, this.cfg);

    const entries = this._followers().map(f => {
      const cfg = this._mergedCfg(f.id);
      return { f, cfg, order: buildFollowerOrder(leaderOrder, cfg, { traceId }) };
    });

    const errors = [
      ...validateOrderAgainstPolicy(leaderOrder, this.cfg).reasons.map(r => `Leader: ${r}`),
      ...entries.flatMap(({ f, cfg, order }) =>
        validateOrderAgainstPolicy(order, cfg).reasons.map(r => `${f.id}: ${r}`)
      ),
    ];
    if (errors.length) throw new Error(errors.join(' '));

    if (this.cfg.dryRun) {
      const payload = { traceId, mode: 'dry_run', leaderOrder, followers: entries.map(({ f, order }) => ({ followerId: f.id, label: f.label, order })) };
      this._log('fanout.dry_run', 'Dry-run fan-out prepared', payload);
      return payload;
    }

    const settled = await Promise.allSettled([
      this._client(LEADER).placeOrder(leaderSession.accessToken, leaderOrder),
      ...entries.map(({ f, order }) => Promise.resolve().then(() => {
        const s = this._requireSession(f.id);
        return this._client(f.id).placeOrder(s.accessToken, order);
      })),
    ]);

    const result = {
      traceId, mode: 'live', leaderOrder, leaderResult: settleResult(settled[0]),
      followers: entries.map(({ f, order }, i) => ({ followerId: f.id, label: f.label, order, result: settleResult(settled[i + 1]) })),
    };
    this._log('fanout.live', 'Fan-out order submitted', result);
    return result;
  }

  async simulateSourceOrder(order) {
    return this.handleSourceOrder({ ...order, order_id: order.order_id ?? `SIM-${Date.now()}` });
  }

  startSourceStream(force = false) {
    const s = this.tokens[LEADER];
    if (!s?.accessToken) { this._log('stream.skip', 'Leader not authenticated'); return; }
    if (tokenExpired(s)) {
      this.socketState = 'token_expired';
      this._log('stream.token_expired', `Leader token expired (${tokenAge(s)}). Re-authenticate.`, { userId: s.userId });
      return;
    }
    if (!force && this.sourceSocket && (this.sourceSocket.readyState === WebSocket.OPEN || this.sourceSocket.readyState === WebSocket.CONNECTING))
      return;
    if (force && this.sourceSocket?.readyState < WebSocket.CLOSING) this.sourceSocket.close();

    this.socketState = 'connecting';
    this._log('stream.connecting', 'Connecting to leader order stream', { userId: s.userId });

    const socket = this._client(LEADER).connectOrderStream({
      accessToken: s.accessToken,
      onOpen: () => {
        if (socket !== this.sourceSocket) return;
        this.socketState = 'connected';
        this.reconnectAttempt = 0;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this._log('stream.connected', 'Leader order stream connected', { userId: s.userId });
      },
      onClose: (event) => {
        if (socket !== this.sourceSocket) return;
        this.socketState = 'disconnected';
        this.sourceSocket = null;
        this._log('stream.closed', 'Leader order stream closed', { code: event.code, reason: event.reason || 'No reason provided' });
        this._scheduleReconnect();
      },
      onError: (err) => {
        if (socket !== this.sourceSocket) return;
        this._log('stream.error', 'Leader order stream error', { message: err?.message ?? String(err) });
      },
      onOrder: (order) => {
        this.handleSourceOrder(order).catch(err =>
          this._log('mirror.error', 'Failed to process source order', { orderId: order?.order_id, message: err.message })
        );
      },
      onMessage: (msg) => {
        if (socket !== this.sourceSocket) return;
        if (msg?.type === 'error') this._log('stream.error_message', 'Leader stream error message', { message: msg.data });
      },
    });

    this.sourceSocket = socket;
  }

  async handleSourceOrder(order) {
    if (!order?.order_id) return;
    if (isSelfTagged(order, this.cfg.tagPrefix)) {
      this._log('mirror.ignored', 'Skipped self-originated order', { orderId: order.order_id, tag: order.tag });
      return;
    }
    if (order.parent_order_id) {
      this._log('mirror.ignored', 'Skipped child order update', { orderId: order.order_id, parentOrderId: order.parent_order_id });
      return;
    }

    const status = normalizeOrderStatus(order.status);
    const mapping = this.runtime.mirroredOrders[order.order_id];
    const followerMap = mapping?.followers ?? {};
    const anyPlaced = Object.values(followerMap).some(f => Boolean(f?.followerOrderId));

    if (status === 'CANCELLED' && this.cfg.replicateCancellations && anyPlaced) {
      await this._replicateCancellation(order, followerMap); return;
    }
    if (status === 'MODIFIED' && this.cfg.replicateModifications && anyPlaced) {
      await this._replicateModification(order, followerMap); return;
    }

    const pending = this._followers().filter(f => !followerMap[f.id]?.mirrorStatus);
    if (!pending.length) return;

    if (this.inFlight.has(order.order_id)) {
      this._log('mirror.ignored', 'Skipped duplicate source order while in-flight', { orderId: order.order_id, status });
      return;
    }
    if (!isActionableSourceOrder(order, this.cfg)) {
      this._log('mirror.waiting', 'Source order not actionable yet', { orderId: order.order_id, status });
      return;
    }

    this.inFlight.add(order.order_id);
    try {
      const results = await Promise.allSettled(pending.map(f => this._mirrorToFollower(order, f, status)));
      results.forEach((r, i) => {
        if (r.status === 'rejected')
          this._log('mirror.error', 'Failed to process source order', { orderId: order.order_id, followerId: pending[i].id, message: r.reason?.message });
      });
    } finally {
      this.inFlight.delete(order.order_id);
    }
  }

  // ── private ───────────────────────────────────────────────────────────────
  async _mirrorToFollower(order, followerCfg, status) {
    const { id } = followerCfg;
    const cfg = this._mergedCfg(id);
    const fo = buildFollowerOrder(order, cfg);
    const policy = validateOrderAgainstPolicy(fo, cfg);

    if (!policy.ok) {
      this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'blocked', blockedReasons: policy.reasons });
      this._log('mirror.blocked', 'Follower order blocked by policy', { orderId: order.order_id, followerId: id, reasons: policy.reasons });
      return;
    }
    if (fo.quantity <= 0) {
      this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'skipped', blockedReasons: ['Quantity became 0 after multiplier.'] });
      this._log('mirror.skipped', 'Follower order skipped after multiplier', { orderId: order.order_id, followerId: id });
      return;
    }
    const leaderPre =this.runtime.preConnectPositions?.leader ?? {};
    const followerPre =this.runtime.preConnectPositions?.[id] ?? {};
    const symbol = fo.tradingsymbol;
    const leaderPreQty = leaderPre[symbol] ?? 0;
    if (leaderPreQty !== 0){
      const isBuy = upper(fo.transaction_type) === 'BUY';
      const isSquareingOff = (leaderPreQty < 0 && isBuy) || (leaderPreQty > 0 && !isBuy);
      if (isSquareingOff && (followerPre[symbol] ?? 0) === 0) {
        this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'skipped', blockedReasons: [`Square off pre connect ${symbol} position skipped - follower was not tin this trade`] });
        this._log('mirror.skipped_preconnect', 'Skipped pre connect square off for  ${id}',{orderId: order.order_id, followerId: id, symbol, leaderPreQty });
          return;
        }
      }
    if (this.cfg.dryRun) {
      this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'dry_run', followerPreview: fo });
      this._log('mirror.dry_run', 'Dry-run follower order prepared', { orderId: order.order_id, followerId: id, followerOrder: fo });
      return;
    }
  

    const session = this._requireSession(id);
    if (tokenExpired(session)) {
      this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'error', errors: { name: 'TokenExpired', message: `Token expired (${tokenAge(session)}). Re-authenticate.` } });
      this._log('mirror.token_expired', `${id} token expired – cannot place order`, { orderId: order.order_id, followerId: id });
      return;
    }

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          this._log('mirror.retry', `Retrying ${id} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, { orderId: order.order_id });
          await sleep(RETRY_MS * attempt);
        }
        const placed = await this._client(id).placeOrder(session.accessToken, fo);
        this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'placed', followerOrderId: placed.order_id, followerVariety: fo.variety });
        this._log('mirror.placed', 'Follower order placed', { sourceOrderId: order.order_id, followerId: id, followerOrderId: placed.order_id, attempt: attempt + 1 });
        return placed;
      } catch (err) {
        lastErr = err;
        if (err instanceof KiteApiError && err.status >= 400 && err.status < 500) break;
      }
    }
    this._saveFollower(order.order_id, id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'error', errors: serializeError(lastErr) });
    throw lastErr;
  }

  async _replicateCancellation(sourceOrder, followerMap) {
    if (this.cfg.dryRun) { this._log('cancel.dry_run', 'Dry-run cancellation prepared', { sourceOrderId: sourceOrder.order_id }); return; }
    await Promise.allSettled(
      Object.entries(followerMap)
        .filter(([, s]) => s?.followerOrderId)
        .map(([id, state]) => Promise.resolve().then(async () => {
          const sess = this._requireSession(id);
          await this._client(id).cancelOrder(sess.accessToken, { variety: state.followerVariety, orderId: state.followerOrderId });
          this._saveFollower(sourceOrder.order_id, id, { mirrorStatus: 'cancelled' });
          this._log('cancel.live', 'Follower cancellation sent', { sourceOrderId: sourceOrder.order_id, followerId: id, followerOrderId: state.followerOrderId });
        }).catch(err => {
          this._log('cancel.error', 'Follower cancellation failed', { sourceOrderId: sourceOrder.order_id, followerId: id, message: err.message });
        }))
    );
  }

  async _replicateModification(sourceOrder, followerMap) {
    if (this.cfg.dryRun) { this._log('modify.dry_run', 'Dry-run modification prepared', { sourceOrderId: sourceOrder.order_id }); return; }
    await Promise.allSettled(
      Object.entries(followerMap)
        .filter(([, s]) => s?.followerOrderId)
        .map(([id, state]) => Promise.resolve().then(async () => {
          const sess = this._requireSession(id);
          if (tokenExpired(sess)) { this._log('modify.error', `${id} token expired – cannot modify`, { sourceOrderId: sourceOrder.order_id }); return; }
          const cfg = this._mergedCfg(id);
          await this._client(id).modifyOrder(sess.accessToken, {
            variety: state.followerVariety, order_id: state.followerOrderId,
            quantity: Math.floor(num(sourceOrder.quantity) * cfg.quantityMultiplier),
            price: num(sourceOrder.price), trigger_price: num(sourceOrder.trigger_price),
            order_type: upper(sourceOrder.order_type), validity: upper(sourceOrder.validity || 'DAY'),
            disclosed_quantity: Math.trunc(num(sourceOrder.disclosed_quantity)),
          });
          this._saveFollower(sourceOrder.order_id, id, { mirrorStatus: 'modified' });
          this._log('modify.live', 'Follower modification sent', { sourceOrderId: sourceOrder.order_id, followerId: id });
        }).catch(err => {
          this._log('modify.error', 'Follower modification failed', { sourceOrderId: sourceOrder.order_id, followerId: id, message: err.message });
        }))
    );
  }

  _scheduleReconnect() {
    if (this.isShuttingDown || this.reconnectTimer) return;
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt++;
    this._log('stream.reconnect_scheduled', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.isShuttingDown) this.startSourceStream(); }, delay);
  }

  _followers() { return this.cfg.accounts?.followers ?? []; }
  _followerIds() { return this._followers().map(f => f.id); }

  _acctCfg(account) {
    if (account === LEADER) return this.cfg.accounts.leader;
    const f = this._followers().find(x => x.id === account);
    if (!f) throw new Error(`Unknown account "${account}".`);
    return f;
  }

  _mergedCfg(followerId) { return { ...this.cfg, ...this._acctCfg(followerId) }; }

  _mkClient(account) {
    const c = typeof account === 'string' ? this._acctCfg(account) : account;
    if (!c?.apiKey || !c?.apiSecret) return null;
    return new KiteClient({ apiKey: c.apiKey, apiSecret: c.apiSecret });
  }

  _client(account) {
    const c = this.clients[account];
    if (!c) throw new Error(`Kite client not configured for ${account}. Check your .env.`);
    return c;
  }

  _getSession(account) {
    return account === LEADER ? this.tokens[LEADER] : this.tokens.followers?.[account];
  }
  _setSession(account, session) {
    if (account === LEADER) this.tokens[LEADER] = session;
    else { this.tokens.followers ??= {}; this.tokens.followers[account] = session; }
  }
  _requireSession(account) {
    const s = this._getSession(account);
    if (!s?.accessToken) throw new Error(`Authenticate the ${account} account first.`);
    return s;
  }
  _sessionSummary(account) {
    const s = this._getSession(account);
    const cfg = this._acctCfg(account);
    const configured = Boolean(cfg?.apiKey && cfg?.apiSecret && cfg?.redirectUrl);
    if (!s) return { configured, connected: false };
    const expired = tokenExpired(s);
    return { configured, connected: !expired, expired, tokenAge: tokenAge(s), userId: s.userId, userName: s.userName, loginTime: s.loginTime };
  }
  _saveFollower(sourceOrderId, followerId, updates) {
    const m = this.runtime.mirroredOrders[sourceOrderId] ??= { sourceOrderId, followers: {}, updatedAt: nowIso() };
    m.followers ??= {};
    m.followers[followerId] = { ...(m.followers[followerId] ?? {}), ...updates, followerId, updatedAt: nowIso() };
    m.updatedAt = nowIso();
    this._persistRuntime();
  }
  _patchMp(order, cfg) {
    if (['MARKET', 'SL-M'].includes(upper(order.order_type))) {
      const mp = String(order.market_protection ?? '').trim();
      if (!mp || mp === '0') order.market_protection = String(cfg.marketProtection ?? '-1');
    }
  }
  _persistTokens() { writeJsonFile(this.cfg.tokenStoreFile, this.tokens); }
  _persistRuntime() {
    // Prune entries older than 2 days to prevent unbounded growth
    const cutoff = Date.now() - 2 * 24 * 3_600_000;
    for (const [id, entry] of Object.entries(this.runtime.mirroredOrders)) {
      if (entry.updatedAt && new Date(entry.updatedAt).getTime() < cutoff)
        delete this.runtime.mirroredOrders[id];
    }
    writeJsonFile(this.cfg.runtimeStoreFile, this.runtime);
  }
  _log(type, summary, detail) {
    const event = { at: nowIso(), type, summary, detail };
    this.runtime.recentEvents = [event, ...(this.runtime.recentEvents ?? [])].slice(0, this.cfg.logBufferSize);
    this._persistRuntime();
    const target = type.endsWith('.error') ? this.logger.error : this.logger.info;
    target?.(`[${event.at}] ${summary}`, detail ?? '');
  }
}

function settleResult(r) {
  return r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: serializeError(r.reason) };
}