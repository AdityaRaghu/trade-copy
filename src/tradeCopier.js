import crypto from 'node:crypto';
import { KiteApiError, KiteClient } from './kiteClient.js';
import { readJsonFile, writeJsonFile } from './storage.js';

const LEADER = 'leader';
const FOLLOWER = 'follower';
const TERMINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const ACTIONABLE = new Set(['OPEN', 'COMPLETE', 'TRIGGER PENDING', 'MODIFIED', 'UPDATE']);
const TOKEN_TTL = 16 * 3_600_000;
const MAX_RETRIES = 2;
const RETRY_MS = 800;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;

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

function recordTimestamp(value) {
  const ts = value?.updatedAt ?? value?.createdAt ?? value?.loginTime;
  const ms = ts ? new Date(ts).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function pickLegacyFollowerEntry(entries, preferredId) {
  const pairs = Object.entries(entries ?? {})
    .filter(([id, value]) => /^follower(?:_\d+)?$/.test(id) && value && typeof value === 'object');

  if (preferredId) {
    const preferred = pairs.find(([id]) => id === preferredId);
    if (preferred) return preferred;
  }

  if (!pairs.length) return [null, null];
  pairs.sort((a, b) => recordTimestamp(b[1]) - recordTimestamp(a[1]));
  return pairs[0];
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
  } else {
    order.market_protection = undefined;
  }

  return order;
}

// ── TradeCopier ───────────────────────────────────────────────────────────────
export class TradeCopier {
  constructor({ config, logger = console }) {
    this.cfg = config;
    this.logger = logger;
    this.clients = {
      [LEADER]: this._mkClient(LEADER),
      [FOLLOWER]: this._mkClient(FOLLOWER),
    };

    this.tokens = readJsonFile(config.tokenStoreFile, { [LEADER]: null, [FOLLOWER]: null });
    let tokensChanged = false;
    this.legacyFollowerAccount = null;

    if (this.tokens.followers && !this.tokens[FOLLOWER]) {
      const [legacyId, legacySession] = pickLegacyFollowerEntry(this.tokens.followers);
      if (legacySession) {
        this.tokens[FOLLOWER] = { ...legacySession, account: FOLLOWER };
        this.legacyFollowerAccount = legacyId;
        tokensChanged = true;
      }
    }
    if (this.tokens[FOLLOWER]?.account && this.tokens[FOLLOWER].account !== FOLLOWER) {
      this.tokens[FOLLOWER] = { ...this.tokens[FOLLOWER], account: FOLLOWER };
      tokensChanged = true;
    }
    if ('followers' in this.tokens) {
      delete this.tokens.followers;
      tokensChanged = true;
    }
    if (tokensChanged) this._persistTokens();

    this.runtime = readJsonFile(config.runtimeStoreFile, { mirroredOrders: {}, recentEvents: [] });
    this.runtime.preConnectPositions ??= {};

    let runtimeChanged = false;
    const [legacyPreAccount, legacyPrePositions] = pickLegacyFollowerEntry(this.runtime.preConnectPositions, this.legacyFollowerAccount);
    if (!this.runtime.preConnectPositions[FOLLOWER] && legacyPrePositions) {
      this.runtime.preConnectPositions[FOLLOWER] = legacyPrePositions;
      if (!this.legacyFollowerAccount) this.legacyFollowerAccount = legacyPreAccount;
      runtimeChanged = true;
    }
    for (const key of Object.keys(this.runtime.preConnectPositions)) {
      if (key !== LEADER && key !== FOLLOWER) {
        delete this.runtime.preConnectPositions[key];
        runtimeChanged = true;
      }
    }

    for (const entry of Object.values(this.runtime.mirroredOrders)) {
      if (entry.followers) {
        const [legacyId, followerState] = pickLegacyFollowerEntry(entry.followers, this.legacyFollowerAccount);
        if (followerState) {
          Object.assign(entry, { ...followerState, followerId: FOLLOWER });
          if (!this.legacyFollowerAccount) this.legacyFollowerAccount = legacyId;
        }
        delete entry.followers;
        runtimeChanged = true;
      }
      if (entry.followerId && entry.followerId !== FOLLOWER) {
        entry.followerId = FOLLOWER;
        runtimeChanged = true;
      }
    }
    if (runtimeChanged) this._persistRuntime();

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
      lotSize: this.cfg.lotSize,
      maxLots: this.cfg.maxLots,
      maxPriceDeviationPercent: this.cfg.maxPriceDeviationPercent,
      marketProtection: this.cfg.marketProtection,
      followMarketOrdersAsLimit: this.cfg.followMarketOrdersAsLimit,
      replicateCancellations: this.cfg.replicateCancellations,
      replicateModifications: this.cfg.replicateModifications,
      leader: this._sessionSummary(LEADER),
      follower: { id: FOLLOWER, label: this.cfg.accounts.follower?.label, ...this._sessionSummary(FOLLOWER) },
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
    for (const id of [LEADER, FOLLOWER]) {
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
    if (this.sourceSocket?.readyState < WS_CLOSING) this.sourceSocket.close();
  }

  async fanoutPlaceOrder(rawOrder) {
    const traceId = makeId();
    const leaderSession = this._requireSession(LEADER);
    const leaderOrder = normalizeOrderInput(rawOrder);
    leaderOrder.tag = makeTag(`${this.cfg.tagPrefix}L`, traceId);
    this._patchMp(leaderOrder, this.cfg);
    const followerCfg = this._acctCfg(FOLLOWER);
    const followerOrder = buildFollowerOrder(leaderOrder, followerCfg, { traceId });

    const errors = [
      ...validateOrderAgainstPolicy(leaderOrder, this.cfg).reasons.map(r => `Leader: ${r}`),
      ...validateOrderAgainstPolicy(followerOrder, followerCfg).reasons.map(r => `${FOLLOWER}: ${r}`),
    ];
    if (errors.length) throw new Error(errors.join(' '));

    if (this.cfg.dryRun) {
      const payload = {
        traceId,
        mode: 'dry_run',
        leaderOrder,
        follower: { followerId: FOLLOWER, label: followerCfg.label, order: followerOrder },
      };
      this._log('fanout.dry_run', 'Dry-run fan-out prepared', payload);
      return payload;
    }

    const settled = await Promise.allSettled([
      this._client(LEADER).placeOrder(leaderSession.accessToken, leaderOrder),
      Promise.resolve().then(() => {
        const s = this._requireSession(FOLLOWER);
        return this._client(FOLLOWER).placeOrder(s.accessToken, followerOrder);
      }),
    ]);

    const result = {
      traceId, mode: 'live', leaderOrder, leaderResult: settleResult(settled[0]),
      follower: { followerId: FOLLOWER, label: followerCfg.label, order: followerOrder, result: settleResult(settled[1]) },
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
    if (!force && this.sourceSocket && (this.sourceSocket.readyState === WS_OPEN || this.sourceSocket.readyState === WS_CONNECTING))
      return;
    if (force && this.sourceSocket?.readyState < WS_CLOSING) this.sourceSocket.close();

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
    const followerState = mapping ?? {};
    const anyPlaced = Boolean(followerState.followerOrderId);

    if (status === 'CANCELLED' && this.cfg.replicateCancellations && anyPlaced) {
      await this._replicateCancellation(order, followerState); return;
    }
    if (status === 'MODIFIED' && this.cfg.replicateModifications && anyPlaced) {
      await this._replicateModification(order, followerState); return;
    }

    if (followerState.mirrorStatus && followerState.mirrorStatus !== 'error') return;

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
      await this._mirrorToFollower(order, status);
    } catch (err) {
      this._log('mirror.error', 'Failed to process source order', { orderId: order.order_id, followerId: FOLLOWER, message: err?.message });
    } finally {
      this.inFlight.delete(order.order_id);
    }
  }

  // ── private ───────────────────────────────────────────────────────────────
  async _mirrorToFollower(order, status) {
    const cfg = { ...this.cfg, ...this._acctCfg(FOLLOWER) };
    const fo = buildFollowerOrder(order, cfg);
    const policy = validateOrderAgainstPolicy(fo, cfg);

    if (!policy.ok) {
      this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'blocked', blockedReasons: policy.reasons });
      this._log('mirror.blocked', 'Follower order blocked by policy', { orderId: order.order_id, followerId: FOLLOWER, reasons: policy.reasons });
      return;
    }
    if (fo.quantity <= 0) {
      this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'skipped', blockedReasons: ['Quantity became 0 after multiplier.'] });
      this._log('mirror.skipped', 'Follower order skipped after multiplier', { orderId: order.order_id, followerId: FOLLOWER });
      return;
    }
    const leaderPre =this.runtime.preConnectPositions?.leader ?? {};
    const followerPre =this.runtime.preConnectPositions?.[FOLLOWER] ?? {};
    const symbol = fo.tradingsymbol;
    const leaderPreQty = leaderPre[symbol] ?? 0;
    if (leaderPreQty !== 0){
      const isBuy = upper(fo.transaction_type) === 'BUY';
      const isSquareingOff = (leaderPreQty < 0 && isBuy) || (leaderPreQty > 0 && !isBuy);
      if (isSquareingOff && (followerPre[symbol] ?? 0) === 0) {
        this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'skipped', blockedReasons: [`Square off pre connect ${symbol} position skipped - follower was not tin this trade`] });
        this._log('mirror.skipped_preconnect', `Skipped pre connect square off for ${FOLLOWER}`, { orderId: order.order_id, followerId: FOLLOWER, symbol, leaderPreQty });
          return;
        }
      }
    if (this.cfg.dryRun) {
      this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'dry_run', followerPreview: fo });
      this._log('mirror.dry_run', 'Dry-run follower order prepared', { orderId: order.order_id, followerId: FOLLOWER, followerOrder: fo });
      return;
    }
  

    const session = this._requireSession(FOLLOWER);
    if (tokenExpired(session)) {
      this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'error', errors: { name: 'TokenExpired', message: `Token expired (${tokenAge(session)}). Re-authenticate.` } });
      this._log('mirror.token_expired', `${FOLLOWER} token expired – cannot place order`, { orderId: order.order_id, followerId: FOLLOWER });
      return;
    }

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          this._log('mirror.retry', `Retrying ${FOLLOWER} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, { orderId: order.order_id });
          await sleep(RETRY_MS * attempt);
        }
        const placed = await this._client(FOLLOWER).placeOrder(session.accessToken, fo);
        this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'placed', followerOrderId: placed.order_id, followerVariety: fo.variety });
        this._log('mirror.placed', 'Follower order placed', { sourceOrderId: order.order_id, followerId: FOLLOWER, followerOrderId: placed.order_id, attempt: attempt + 1 });
        return placed;
      } catch (err) {
        lastErr = err;
        if (err instanceof KiteApiError && err.status >= 400 && err.status < 500) break;
      }
    }
    this._saveFollower(order.order_id, { sourceOrderId: order.order_id, sourceStatus: status, mirrorStatus: 'error', errors: serializeError(lastErr) });
    throw lastErr;
  }

  async _replicateCancellation(sourceOrder, followerState) {
    if (this.cfg.dryRun) { this._log('cancel.dry_run', 'Dry-run cancellation prepared', { sourceOrderId: sourceOrder.order_id }); return; }
    if (!followerState?.followerOrderId) return;
    try {
      const sess = this._requireSession(FOLLOWER);
      await this._client(FOLLOWER).cancelOrder(sess.accessToken, { variety: followerState.followerVariety, orderId: followerState.followerOrderId });
      this._saveFollower(sourceOrder.order_id, { mirrorStatus: 'cancelled' });
      this._log('cancel.live', 'Follower cancellation sent', { sourceOrderId: sourceOrder.order_id, followerId: FOLLOWER, followerOrderId: followerState.followerOrderId });
    } catch (err) {
      this._log('cancel.error', 'Follower cancellation failed', { sourceOrderId: sourceOrder.order_id, followerId: FOLLOWER, message: err.message });
    }
  }

  async _replicateModification(sourceOrder, followerState) {
    if (this.cfg.dryRun) { this._log('modify.dry_run', 'Dry-run modification prepared', { sourceOrderId: sourceOrder.order_id }); return; }
    if (!followerState?.followerOrderId) return;
    try {
      const sess = this._requireSession(FOLLOWER);
      if (tokenExpired(sess)) { this._log('modify.error', `${FOLLOWER} token expired – cannot modify`, { sourceOrderId: sourceOrder.order_id }); return; }
      const cfg = this._acctCfg(FOLLOWER);
      let modQty = Math.floor(num(sourceOrder.quantity) * cfg.quantityMultiplier);
      if (cfg.lotSize > 0) modQty = Math.floor(modQty / cfg.lotSize) * cfg.lotSize;
      if (cfg.maxLots > 0 && cfg.lotSize > 0) modQty = Math.min(modQty, cfg.maxLots * cfg.lotSize);
      await this._client(FOLLOWER).modifyOrder(sess.accessToken, {
        variety: followerState.followerVariety, order_id: followerState.followerOrderId,
        quantity: modQty,
        price: num(sourceOrder.price), trigger_price: num(sourceOrder.trigger_price),
        order_type: upper(sourceOrder.order_type), validity: upper(sourceOrder.validity || 'DAY'),
        disclosed_quantity: Math.trunc(num(sourceOrder.disclosed_quantity)),
      });
      this._saveFollower(sourceOrder.order_id, { mirrorStatus: 'modified' });
      this._log('modify.live', 'Follower modification sent', { sourceOrderId: sourceOrder.order_id, followerId: FOLLOWER });
    } catch (err) {
      this._log('modify.error', 'Follower modification failed', { sourceOrderId: sourceOrder.order_id, followerId: FOLLOWER, message: err.message });
    }
  }

  _scheduleReconnect() {
    if (this.isShuttingDown || this.reconnectTimer) return;
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt++;
    this._log('stream.reconnect_scheduled', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.isShuttingDown) this.startSourceStream(); }, delay);
  }

  _acctCfg(account) {
    if (account === LEADER) return this.cfg.accounts.leader;
    if (account === FOLLOWER) return this.cfg.accounts.follower;
    throw new Error(`Unknown account "${account}".`);
  }

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
    return account === LEADER ? this.tokens[LEADER] : this.tokens[FOLLOWER];
  }
  _setSession(account, session) {
    if (account === LEADER) this.tokens[LEADER] = session;
    else this.tokens[FOLLOWER] = { ...session, account: FOLLOWER };
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
  async _snapshotPositions(account, accessToken) {
    const positions = await this._client(account).getPositions(accessToken);
    const snapshot = {};

    for (const pos of Array.isArray(positions?.net) ? positions.net : []) {
      const symbol = String(pos?.tradingsymbol ?? '').trim();
      const qty = Math.trunc(num(pos?.quantity ?? pos?.net_quantity, 0));
      if (!symbol || qty === 0) continue;
      snapshot[symbol] = (snapshot[symbol] ?? 0) + qty;
    }

    this.runtime.preConnectPositions ??= {};
    this.runtime.preConnectPositions[account] = snapshot;
    this._persistRuntime();
    return snapshot;
  } catch (err) {
    this._log('position.snapshot.error', '${account}: failed to snapshot positions (non-fatal)', {message: err.message });
    return {};
  }
  _saveFollower(sourceOrderId, updates) {
    const m = this.runtime.mirroredOrders[sourceOrderId] ??= { sourceOrderId, followerId: FOLLOWER, updatedAt: nowIso() };
    Object.assign(m, updates, { followerId: FOLLOWER, updatedAt: nowIso() });
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