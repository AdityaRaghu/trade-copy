import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildFollowerOrder,
  isActionableSourceOrder,
  normalizeOrderInput,
  TradeCopier,
  validateOrderAgainstPolicy,
} from '../src/tradeCopier.js';

const config = {
  quantityMultiplier: 1.5,
  marketProtection: '-1',
  followMarketOrdersAsLimit: true,
  maxPriceDeviationPercent: 0.30,
  priceTickSize: 0.05,
  tagPrefix: 'CPY',
  maxQuantityPerOrder: 10,
  allowMarketOrders: true,
  allowedVarieties: ['regular', 'amo'],
  allowedExchanges: ['NSE', 'NFO'],
  allowedProducts: ['MIS', 'CNC'],
  allowedOrderTypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
};

test('buildFollowerOrder converts completed market buy to bounded limit order', () => {
  const followerOrder = buildFollowerOrder(
    {
      order_id: '12345',
      variety: 'regular',
      exchange: 'NSE',
      tradingsymbol: 'INFY',
      transaction_type: 'BUY',
      order_type: 'MARKET',
      quantity: 2,
      product: 'MIS',
      validity: 'DAY',
      price: 0,
      trigger_price: 0,
      average_price: 71.7,
      market_protection: '0',
      status: 'COMPLETE',
    },
    config,
    { traceId: 'ABCD1234' },
  );

  assert.equal(followerOrder.quantity, 3);
  assert.equal(followerOrder.order_type, 'LIMIT');
  assert.equal(followerOrder.price, 71.9);
  assert.equal(followerOrder.market_protection, undefined);
  assert.match(followerOrder.tag, /^CPYABCD1234/);
});

test('isActionableSourceOrder waits for leader fill for market orders', () => {
  assert.equal(
    isActionableSourceOrder(
      {
        status: 'OPEN',
        order_type: 'MARKET',
        average_price: 0,
      },
      config,
    ),
    false,
  );

  assert.equal(
    isActionableSourceOrder(
      {
        status: 'COMPLETE',
        order_type: 'MARKET',
        average_price: 71.7,
      },
      config,
    ),
    true,
  );

  assert.equal(
    isActionableSourceOrder(
      {
        status: 'OPEN',
        order_type: 'LIMIT',
        exchange_order_id: '1100',
      },
      config,
    ),
    true,
  );
});

test('validateOrderAgainstPolicy blocks disallowed settings', () => {
  const result = validateOrderAgainstPolicy(
    normalizeOrderInput({
      variety: 'co',
      exchange: 'BSE',
      tradingsymbol: 'SBIN',
      transaction_type: 'BUY',
      order_type: 'MARKET',
      quantity: 11,
      product: 'NRML',
      validity: 'DAY',
    }),
    config,
  );

  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('Variety')));
  assert.ok(result.reasons.some((reason) => reason.includes('Exchange')));
  assert.ok(result.reasons.some((reason) => reason.includes('Product')));
  assert.ok(result.reasons.some((reason) => reason.includes('Quantity')));
});

test('TradeCopier uses separate app credentials for leader and follower logins', () => {
  const copier = new TradeCopier({
    config: {
      host: '127.0.0.1',
      port: 8787,
      accounts: {
        leader: {
          apiKey: 'leaderKey',
          apiSecret: 'leaderSecret',
          redirectUrl: 'http://127.0.0.1:8787/auth/zerodha/callback',
        },
        follower: {
          apiKey: 'followerKey',
          apiSecret: 'followerSecret',
          redirectUrl: 'http://127.0.0.1:8787/auth/zerodha/callback',
        },
      },
      dryRun: true,
      quantityMultiplier: 1,
      maxQuantityPerOrder: 0,
      allowMarketOrders: true,
      marketProtection: '-1',
      followMarketOrdersAsLimit: true,
      maxPriceDeviationPercent: 0.30,
      priceTickSize: 0.05,
      allowedVarieties: ['regular'],
      allowedExchanges: ['NSE'],
      allowedProducts: ['MIS'],
      allowedOrderTypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
      replicateCancellations: true,
      replicateModifications: false,
      tagPrefix: 'CPY',
      logBufferSize: 10,
      tokenStoreFile: path.join('/tmp', 'trade-copier-test-tokens.json'),
      runtimeStoreFile: path.join('/tmp', 'trade-copier-test-runtime.json'),
    },
    logger: {
      info() {},
      error() {},
    },
  });

  const leaderUrl = new URL(copier.buildLoginUrl('leader'));
  const followerUrl = new URL(copier.buildLoginUrl('follower'));

  assert.equal(leaderUrl.searchParams.get('api_key'), 'leaderKey');
  assert.equal(followerUrl.searchParams.get('api_key'), 'followerKey');
});