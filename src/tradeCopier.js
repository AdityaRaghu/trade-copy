import crypto from 'node:crypto';

import { KiteApiError, KiteClient } from './kiteClient.js';
import { readJsonFile, writeJsonFile } from './storage.js';

const SOURCE_ACCOUNT = 'leader';
const FOLLOWER_ACCOUNT = 'follower';
const TERMINAL_STATUSES = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const ACTIONABLE_SOURCE_STATUSES = new Set([
  'OPEN',
  'COMPLETE',
  'TRIGGER PENDING',
  'MODIFIED',
  'UPDATE',
]);

// Kite tokens expire at ~6 AM IST next day. Warn after 16 hours.
const TOKEN_MAX_AGE_MS = 16 * 60 * 60 * 1000;
// Max retries for transient follower order failures
const MAX_PLACE_RETRIES = 2;
const RETRY_DELAY_MS = 800;

function defaultTokens() {
  return {
    [SOURCE_ACCOUNT]: null,
    [FOLLOWER_ACCOUNT]: null,
  };
}

function defaultRuntime() {
  return {
    mirroredOrders: {},
    recentEvents: [],
  };
}

function nowIso() {
  return new Date().toISOString();
}

function trimRecentEvents(events, maxSize) {
  return events.slice(0, maxSize);
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function makeTraceId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function makeOrderTag(prefix, suffix) {
  return `${prefix}${suffix}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
}

function isTokenExpired(session) {
  if (!session?.createdAt) {
    return true;
  }
  const age = Date.now() - new Date(session.createdAt).getTime();
  return age > TOKEN_MAX_AGE_MS;
}

function tokenAgeLabel(session) {
  if (!session?.createdAt) {
    return 'unknown';
  }
  const ageMs = Date.now() - new Date(session.createdAt).getTime();
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${mins}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSelfTagged(order, prefix) {
  const tags = new Set(
    [order?.tag, ...(order?.tags ?? [])]
      .filter(Boolean)
      .map((item) => String(item).toUpperCase()),
  );
  return [...tags].some((tag) => tag.startsWith(String(prefix).toUpperCase()));
}

export function normalizeOrderStatus(status) {
  return upper(status).replace(/\s+/g, ' ').trim();
}

export function normalizeOrderInput(order = {}) {
  return {
    variety: lower(order.variety || 'regular'),
    exchange: upper(order.exchange),
    tradingsymbol: String(order.tradingsymbol ?? '').trim(),
    transaction_type: upper(order.transaction_type),
    order_type: upper(order.order_type),
    quantity: Math.trunc(numeric(order.quantity)),
    product: upper(order.product),
    validity: upper(order.validity || 'DAY'),
    disclosed_quantity: Math.max(0, Math.trunc(numeric(order.disclosed_quantity))),
    price: numeric(order.price),
    trigger_price: numeric(order.trigger_price),
    market_protection:
      order.market_protection == null ? undefined : String(order.market_protection),
  };
}

export function isActionableSourceOrder(order) {
  const status = normalizeOrderStatus(order.status);
  if (TERMINAL_STATUSES.has(status) && status !== 'COMPLETE') {
    return false;
  }

  if (ACTIONABLE_SOURCE_STATUSES.has(status)) {
    return true;
  }

  return Boolean(order.exchange_order_id);
}

export function validateOrderAgainstPolicy(order, config) {
  const reasons = [];

  if (!config.allowedVarieties.includes(order.variety)) {
    reasons.push(`Variety ${order.variety} is not allowed.`);
  }

  if (!config.allowedExchanges.includes(order.exchange)) {
    reasons.push(`Exchange ${order.exchange} is not allowed.`);
  }

  if (!config.allowedProducts.includes(order.product)) {
    reasons.push(`Product ${order.product} is not allowed.`);
  }

  if (!config.allowedOrderTypes.includes(order.order_type)) {
    reasons.push(`Order type ${order.order_type} is not allowed.`);
  }

  if (!config.allowMarketOrders && order.order_type === 'MARKET') {
    reasons.push('Market orders are disabled.');
  }

  if (!order.tradingsymbol) {
    reasons.push('Missing trading symbol.');
  }

  if (order.quantity <= 0) {
    reasons.push('Quantity must be greater than zero.');
  }

  if (config.maxQuantityPerOrder > 0 && order.quantity > config.maxQuantityPerOrder) {
    reasons.push(
      `Quantity ${order.quantity} exceeds MAX_QUANTITY_PER_ORDER=${config.maxQuantityPerOrder}.`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

export function buildFollowerOrder(sourceOrder, config, { traceId } = {}) {
  const normalized = normalizeOrderInput(sourceOrder);
  const multipliedQuantity = Math.floor(
    normalized.quantity * numeric(config.quantityMultiplier, 1),
  );

  const followerOrder = {
    ...normalized,
    quantity: multipliedQuantity,
    tag: makeOrderTag(
      config.tagPrefix,
      traceId ?? String(sourceOrder.order_id ?? makeTraceId()).slice(-8),
    ),
  };

  if (
    ['MARKET', 'SL-M'].includes(followerOrder.order_type) &&
    followerOrder.market_protection == null
  ) {
    followerOrder.market_protection = config.marketProtection;
  }

  return followerOrder;
}

export class TradeCopier {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.kiteClients = {
      [SOURCE_ACCOUNT]: this.createKiteClient(SOURCE_ACCOUNT),
      [FOLLOWER_ACCOUNT]: this.createKiteClient(FOLLOWER_ACCOUNT),
    };

    this.tokens = readJsonFile(config.tokenStoreFile, defaultTokens());
    this.runtime = readJsonFile(config.runtimeStoreFile, defaultRuntime());

    this.sourceSocket = null;
    this.sourceSocketState = 'disconnected';
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.isShuttingDown = false;
  }

  getStatus() {
    return {
      dryRun: this.config.dryRun,
      sourceSocketState: this.sourceSocketState,
      quantityMultiplier: this.config.quantityMultiplier,
      leader: summarizeSession(
        this.tokens[SOURCE_ACCOUNT],
        this.getAccountConfig(SOURCE_ACCOUNT),
      ),
      follower: summarizeSession(
        this.tokens[FOLLOWER_ACCOUNT],
        this.getAccountConfig(FOLLOWER_ACCOUNT),
      ),
      recentEvents: this.runtime.recentEvents,
      mirroredOrders: Object.keys(this.runtime.mirroredOrders).length,
    };
  }

  isSessionExpired(account) {
    return isTokenExpired(this.tokens[account]);
  }

  getSessionAge(account) {
    return tokenAgeLabel(this.tokens[account]);
  }

  buildLoginUrl(account) {
    return this.getClient(account).buildLoginUrl({ account });
  }

  async completeLogin(account, requestToken) {
    const session = await this.getClient(account).exchangeRequestToken(requestToken);
    const storedSession = {
      account,
      userId: session.user_id,
      userName: session.user_name,
      apiKey: this.getAccountConfig(account).apiKey,
      accessToken: session.access_token,
      publicToken: session.public_token,
      loginTime: session.login_time,
      createdAt: nowIso(),
    };

    this.tokens[account] = storedSession;
    this.persistTokens();
    this.recordEvent('auth.success', `${account} account authenticated`, {
      account,
      userId: storedSession.userId,
      loginTime: storedSession.loginTime,
    });

    if (account === SOURCE_ACCOUNT) {
      this.startSourceStream();
    }

    return storedSession;
  }

  async resume() {
    // Warn about expired tokens on startup
    for (const account of [SOURCE_ACCOUNT, FOLLOWER_ACCOUNT]) {
      const session = this.tokens[account];
      if (session?.accessToken && isTokenExpired(session)) {
        this.recordEvent('auth.expired', `${account} token appears expired (age: ${tokenAgeLabel(session)}). Please re-authenticate.`, {
          account,
          userId: session.userId,
          tokenAge: tokenAgeLabel(session),
        });
      }
    }

    if (this.tokens[SOURCE_ACCOUNT]?.accessToken) {
      if (isTokenExpired(this.tokens[SOURCE_ACCOUNT])) {
        this.recordEvent(
          'stream.skip',
          'Leader token is expired – re-authenticate the leader account before market opens',
        );
        return;
      }
      this.startSourceStream();
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sourceSocket && this.sourceSocket.readyState < WebSocket.CLOSING) {
      this.sourceSocket.close();
    }
  }

  async fanoutPlaceOrder(rawOrder) {
    const leaderSession = this.requireSession(SOURCE_ACCOUNT);
    const followerSession = this.requireSession(FOLLOWER_ACCOUNT);
    const traceId = makeTraceId();

    const leaderOrder = normalizeOrderInput(rawOrder);
    leaderOrder.tag = makeOrderTag(`${this.config.tagPrefix}L`, traceId);
    if (
      ['MARKET', 'SL-M'].includes(leaderOrder.order_type) &&
      leaderOrder.market_protection == null
    ) {
      leaderOrder.market_protection = this.config.marketProtection;
    }

    const followerOrder = buildFollowerOrder(leaderOrder, this.config, { traceId });

    const leaderPolicy = validateOrderAgainstPolicy(leaderOrder, this.config);
    const followerPolicy = validateOrderAgainstPolicy(followerOrder, this.config);
    const errors = [
      ...leaderPolicy.reasons.map((reason) => `Leader: ${reason}`),
      ...followerPolicy.reasons.map((reason) => `Follower: ${reason}`),
    ];

    if (errors.length > 0) {
      throw new Error(errors.join(' '));
    }

    if (this.config.dryRun) {
      const payload = {
        traceId,
        mode: 'dry_run',
        leaderOrder,
        followerOrder,
      };
      this.recordEvent('fanout.dry_run', 'Dry-run fan-out prepared', payload);
      return payload;
    }

    const leaderClient = this.getClient(SOURCE_ACCOUNT);
    const followerClient = this.getClient(FOLLOWER_ACCOUNT);
    const [leaderResult, followerResult] = await Promise.allSettled([
      leaderClient.placeOrder(leaderSession.accessToken, leaderOrder),
      followerClient.placeOrder(followerSession.accessToken, followerOrder),
    ]);

    const result = {
      traceId,
      mode: 'live',
      leaderOrder,
      followerOrder,
      leaderResult: settleResult(leaderResult),
      followerResult: settleResult(followerResult),
    };

    this.recordEvent('fanout.live', 'Fan-out order submitted', result);
    return result;
  }

  async simulateSourceOrder(order) {
    return this.handleSourceOrder({
      ...order,
      order_id: order.order_id ?? `SIM-${Date.now()}`,
    });
  }

  startSourceStream() {
    const sourceSession = this.tokens[SOURCE_ACCOUNT];
    if (!sourceSession?.accessToken) {
      this.recordEvent(
        'stream.skip',
        'Leader stream not started because the leader account is not authenticated',
      );
      return;
    }

    if (isTokenExpired(sourceSession)) {
      this.sourceSocketState = 'token_expired';
      this.recordEvent(
        'stream.token_expired',
        `Leader token expired (age: ${tokenAgeLabel(sourceSession)}). Re-authenticate to resume.`,
        { userId: sourceSession.userId, tokenAge: tokenAgeLabel(sourceSession) },
      );
      return;
    }

    if (this.sourceSocket && this.sourceSocket.readyState < WebSocket.CLOSING) {
      this.sourceSocket.close();
    }

    this.sourceSocketState = 'connecting';
    this.recordEvent('stream.connecting', 'Connecting to leader order stream', {
      userId: sourceSession.userId,
    });

    this.sourceSocket = this.getClient(SOURCE_ACCOUNT).connectOrderStream({
      accessToken: sourceSession.accessToken,
      onOpen: () => {
        this.sourceSocketState = 'connected';
        this.reconnectAttempt = 0; // Reset backoff on successful connection
        this.recordEvent('stream.connected', 'Leader order stream connected', {
          userId: sourceSession.userId,
        });
      },
      onClose: (event) => {
        this.sourceSocketState = 'disconnected';
        this.recordEvent('stream.closed', 'Leader order stream closed', {
          code: event.code,
          reason: event.reason || 'No reason provided',
        });
        this.scheduleReconnect();
      },
      onError: (error) => {
        this.recordEvent('stream.error', 'Leader order stream error', {
          message: error?.message ?? String(error),
        });
      },
      onOrder: (order) => {
        this.handleSourceOrder(order).catch((error) => {
          this.recordEvent('mirror.error', 'Failed to process source order', {
            orderId: order?.order_id,
            message: error.message,
          });
        });
      },
      onMessage: (message) => {
        if (message?.type === 'error') {
          this.recordEvent('stream.error_message', 'Leader stream error message', {
            message: message.data,
          });
        }
      },
    });
  }

  scheduleReconnect() {
    if (this.isShuttingDown || this.reconnectTimer) {
      return;
    }

    // Exponential backoff: 2s → 4s → 8s → 16s → 30s (max)
    const baseDelay = 2000;
    const maxDelay = 30_000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempt), maxDelay);
    this.reconnectAttempt += 1;

    this.recordEvent('stream.reconnect_scheduled', `Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isShuttingDown) {
        this.startSourceStream();
      }
    }, delay);
  }

  async handleSourceOrder(order) {
    if (!order?.order_id) {
      return;
    }

    if (isSelfTagged(order, this.config.tagPrefix)) {
      this.recordEvent('mirror.ignored', 'Skipped self-originated order', {
        orderId: order.order_id,
        tag: order.tag,
      });
      return;
    }

    if (order.parent_order_id) {
      this.recordEvent('mirror.ignored', 'Skipped child order update', {
        orderId: order.order_id,
        parentOrderId: order.parent_order_id,
      });
      return;
    }

    const normalizedStatus = normalizeOrderStatus(order.status);
    const mapping = this.runtime.mirroredOrders[order.order_id];

    if (
      normalizedStatus === 'CANCELLED' &&
      this.config.replicateCancellations &&
      mapping?.followerOrderId
    ) {
      await this.replicateCancellation(order, mapping);
      return;
    }

    if (
      normalizedStatus === 'MODIFIED' &&
      this.config.replicateModifications &&
      mapping?.followerOrderId
    ) {
      await this.replicateModification(order, mapping);
      return;
    }

    if (mapping?.mirrorStatus) {
        return;
      }
  
      if (!isActionableSourceOrder(order)) {
        this.recordEvent('mirror.waiting', 'Source order update not actionable yet', {
          orderId: order.order_id,
          status: normalizedStatus,
        });
        return;
      }
  
      const followerOrder = buildFollowerOrder(order, this.config);
      const policy = validateOrderAgainstPolicy(followerOrder, this.config);
  
      if (!policy.ok) {
        this.runtime.mirroredOrders[order.order_id] = {
          sourceOrderId: order.order_id,
          mirrorStatus: 'blocked',
          blockedReasons: policy.reasons,
          updatedAt: nowIso(),
        };
        this.persistRuntime();
        this.recordEvent('mirror.blocked', 'Follower order blocked by policy', {
          orderId: order.order_id,
          reasons: policy.reasons,
        });
        return;
      }
  
      if (followerOrder.quantity <= 0) {
        this.runtime.mirroredOrders[order.order_id] = {
          sourceOrderId: order.order_id,
          mirrorStatus: 'skipped',
          blockedReasons: ['Follower quantity became 0 after multiplier.'],
          updatedAt: nowIso(),
        };
        this.persistRuntime();
        this.recordEvent('mirror.skipped', 'Follower order skipped after multiplier', {
          orderId: order.order_id,
          sourceQuantity: order.quantity,
          multiplier: this.config.quantityMultiplier,
        });
        return;
      }

      if (this.config.dryRun) {
        this.runtime.mirroredOrders[order.order_id] = {
          sourceOrderId: order.order_id,
          mirrorStatus: 'dry_run',
          followerPreview: followerOrder,
          updatedAt: nowIso(),
        };
        this.persistRuntime();
        this.recordEvent('mirror.dry_run', 'Dry-run follower order prepared', {
          orderId: order.order_id,
          followerOrder,
        });
        return;
      }
  
      const followerSession = this.requireSession(FOLLOWER_ACCOUNT);
  
      // Check if follower token is expired before placing
      if (isTokenExpired(followerSession)) {
        this.runtime.mirroredOrders[order.order_id] = {
          sourceOrderId: order.order_id,
          mirrorStatus: 'error',
          updatedAt: nowIso(),
          errors: { name: 'TokenExpired', message: `Follower token expired (age: ${tokenAgeLabel(followerSession)}). Re-authenticate.` },
        };
        this.persistRuntime();
        this.recordEvent('mirror.token_expired', 'Follower token expired — cannot place order. Re-authenticate.', {
          orderId: order.order_id,
          tokenAge: tokenAgeLabel(followerSession),
        });
        return;
      }
  
      let lastError;
      for (let attempt = 0; attempt <= MAX_PLACE_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            this.recordEvent('mirror.retry', `Retrying follower order (attempt ${attempt + 1}/${MAX_PLACE_RETRIES + 1})`, {
              orderId: order.order_id,
            });
            await sleep(RETRY_DELAY_MS * attempt);
          }
  
          const placed = await this.getClient(FOLLOWER_ACCOUNT).placeOrder(
            followerSession.accessToken,
            followerOrder,
          );
  
          this.runtime.mirroredOrders[order.order_id] = {
            sourceOrderId: order.order_id,
            sourceStatus: normalizedStatus,
            followerOrderId: placed.order_id,
            followerVariety: followerOrder.variety,
            mirrorStatus: 'placed',
            updatedAt: nowIso(),
          };
          this.persistRuntime();
  
          this.recordEvent('mirror.placed', 'Follower order placed', {
            sourceOrderId: order.order_id,
            followerOrderId: placed.order_id,
            attempt: attempt + 1,
          });
          return;
        } catch (error) {
          lastError = error;
  
          // Don't retry on client errors (4xx) — only on transient/network errors
          if (error instanceof KiteApiError && error.status >= 400 && error.status < 500) {
            break;
          }
        }
      }
  
      this.runtime.mirroredOrders[order.order_id] = {
        sourceOrderId: order.order_id,
        mirrorStatus: 'error',
        updatedAt: nowIso(),
        errors: serializeError(lastError),
      };
      this.persistRuntime();
  
      throw lastError;
    }
  
    async replicateCancellation(sourceOrder, mapping) {
        if (this.config.dryRun) {
          this.recordEvent('cancel.dry_run', 'Dry-run follower cancellation prepared', {
            sourceOrderId: sourceOrder.order_id,
            followerOrderId: mapping.followerOrderId,
          });
          return;
        }
    
        const followerSession = this.requireSession(FOLLOWER_ACCOUNT);
        try {
          await this.getClient(FOLLOWER_ACCOUNT).cancelOrder(followerSession.accessToken, {
            variety: mapping.followerVariety,
            order_id: mapping.followerOrderId,
          });
          mapping.mirrorStatus = 'cancelled';
          mapping.updatedAt = nowIso();
          this.persistRuntime();
          this.recordEvent('cancel.live', 'Follower order cancellation sent', {
            sourceOrderId: sourceOrder.order_id,
            followerOrderId: mapping.followerOrderId,
          });
        } catch (error) {
          this.recordEvent('cancel.error', 'Follower cancellation failed', {
            sourceOrderId: sourceOrder.order_id,
            followerOrderId: mapping.followerOrderId,
            message: error.message,
          });
        }
      }
    
      async replicateModification(sourceOrder, mapping) {
        const followerSession = this.requireSession(FOLLOWER_ACCOUNT);
        const followerPatch = {
          variety: mapping.followerVariety,
          order_id: mapping.followerOrderId,
          quantity: Math.floor(numeric(sourceOrder.quantity) * this.config.quantityMultiplier),
          price: numeric(sourceOrder.price),
          trigger_price: numeric(sourceOrder.trigger_price),
          order_type: upper(sourceOrder.order_type),
          validity: upper(sourceOrder.validity || 'DAY'),
          disclosed_quantity: Math.trunc(numeric(sourceOrder.disclosed_quantity)),
        };
    
        if (this.config.dryRun) {
          this.recordEvent('modify.dry_run', 'Dry-run follower modification prepared', {
            sourceOrderId: sourceOrder.order_id,
            followerOrderId: mapping.followerOrderId,
            followerPatch,
          });
          return;
        }

        try {
            await this.getClient(FOLLOWER_ACCOUNT).modifyOrder(
              followerSession.accessToken,
              followerPatch,
            );
            mapping.mirrorStatus = 'modified';
            mapping.updatedAt = nowIso();
            this.persistRuntime();
            this.recordEvent('modify.live', 'Follower order modification sent', {
              sourceOrderId: sourceOrder.order_id,
              followerOrderId: mapping.followerOrderId,
            });
          } catch (error) {
            this.recordEvent('modify.error', 'Follower modification failed', {
              sourceOrderId: sourceOrder.order_id,
              followerOrderId: mapping.followerOrderId,
              message: error.message,
            });
          }
        }
      
        requireSession(account) {
          const session = this.tokens[account];
          if (!session?.accessToken) {
            throw new Error(`Authenticate the ${account} account first.`);
          }
          return session;
        }
      
        createKiteClient(account) {
            const accountConfig = this.getAccountConfig(account);
            if (!isAccountConfigured(accountConfig)) {
              return null;
            }
        
            return new KiteClient({
              apiKey: accountConfig.apiKey,
              apiSecret: accountConfig.apiSecret,
            });
          }

          getClient(account) {
            const client = this.kiteClients[account];
            if (!client) {
              throw new Error(
                `Kite credentials are not configured for ${account}. Update your .env first.`,
              );
            }
        
            return client;
          }
        
          getAccountConfig(account) {
            const accountConfig = this.config.accounts?.[account];
            if (!accountConfig) {
              throw new Error(`Unknown account "${account}". Expected leader or follower.`);
            }
        
            return accountConfig;
          }
        
          persistTokens() {
            writeJsonFile(this.config.tokenStoreFile, this.tokens);
          }
        
          persistRuntime() {
            writeJsonFile(this.config.runtimeStoreFile, this.runtime);
          }
        
          recordEvent(type, summary, detail = undefined) {
            const event = {
              at: nowIso(),
              type,
              summary,
              detail,
            };
        
            this.runtime.recentEvents = trimRecentEvents(
              [event, ...(this.runtime.recentEvents ?? [])],
              this.config.logBufferSize,
            );
            this.persistRuntime();

            const target = type.endsWith('.error') ? this.logger.error : this.logger.info;
    target?.(`[${event.at}] ${summary}`, detail ?? '');
  }
}

function settleResult(result) {
    if (result.status === 'fulfilled') {
      return {
        ok: true,
        value: result.value,
      };
    }
  
    return {
      ok: false,
      error: serializeError(result.reason),
    };
  }
  
  function serializeError(error) {
    if (error instanceof KiteApiError) {
      return {
        name: error.name,
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        body: error.body,
      };
    }
  
    return {
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
    };
  }
  
  function summarizeSession(session, accountConfig) {
    if (!session) {
      return {
        configured: isAccountConfigured(accountConfig),
        connected: false,
      };
    }

    const expired = isTokenExpired(session);
  return {
    configured: isAccountConfigured(accountConfig),
    connected: !expired,
    expired,
    tokenAge: tokenAgeLabel(session),
    userId: session.userId,
    userName: session.userName,
    loginTime: session.loginTime,
    createdAt: session.createdAt,
  };
}

function isAccountConfigured(accountConfig) {
  return Boolean(
    accountConfig?.apiKey &&
      accountConfig?.apiSecret &&
      accountConfig?.redirectUrl,
  );
}
          