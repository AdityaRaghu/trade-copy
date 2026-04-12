import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildFollowerOrder, isActionableSourceOrder, normalizeOrderInput, TradeCopier, validateOrderAgainstPolicy } from '../src/tradeCopier.js';

const cfg = {
  quantityMultiplier: 1.5, marketProtection: '-1', tagPrefix: 'CPY',
  maxQuantityPerOrder: 10, allowMarketOrders: true,
  followMarketOrdersAsLimit: true, maxPriceDeviationPercent: 0.30, priceTickSize: 0.05,
  allowedVarieties: ['regular', 'amo'], allowedExchanges: ['NSE', 'NFO'],
  allowedProducts: ['MIS', 'CNC'], allowedOrderTypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
};

test('buildFollowerOrder converts completed market buy to bounded limit order', () => {
  const fo = buildFollowerOrder({
    order_id: '12345', variety: 'regular', exchange: 'NSE', tradingsymbol: 'INFY',
    transaction_type: 'BUY', order_type: 'MARKET', quantity: 2, product: 'MIS',
    validity: 'DAY', price: 0, trigger_price: 0, average_price: 71.7, market_protection: '0', status: 'COMPLETE',
  }, cfg, { traceId: 'ABCD1234' });

  assert.equal(fo.quantity, 3);
  assert.equal(fo.order_type, 'LIMIT');
  assert.equal(fo.price, 71.9);
  assert.equal(fo.market_protection, undefined);
  assert.match(fo.tag, /^CPYABCD1234/);
});

test('buildFollowerOrder falls back to protected market order when average_price is 0', () => {
  const fo = buildFollowerOrder({
    order_id: '99999', variety: 'regular', exchange: 'NSE', tradingsymbol: 'INFY',
    transaction_type: 'BUY', order_type: 'MARKET', quantity: 1, product: 'MIS',
    validity: 'DAY', price: 0, trigger_price: 0, average_price: 0, market_protection: '0', status: 'COMPLETE',
  }, cfg, { traceId: 'FALLBACK1' });

  assert.equal(fo.order_type, 'MARKET');
  assert.equal(fo.market_protection, '-1');
});

test('isActionableSourceOrder waits for leader fill for market orders', () => {
  assert.equal(isActionableSourceOrder({ status: 'OPEN', order_type: 'MARKET', average_price: 0 }, cfg), false);
  assert.equal(isActionableSourceOrder({ status: 'COMPLETE', order_type: 'MARKET', average_price: 71.7 }, cfg), true);
  assert.equal(isActionableSourceOrder({ status: 'COMPLETE', order_type: 'MARKET', average_price: 0 }, cfg), true);
  assert.equal(isActionableSourceOrder({ status: 'OPEN', order_type: 'LIMIT', exchange_order_id: '1100' }, cfg), true);
});

test('validateOrderAgainstPolicy blocks disallowed settings', () => {
  const result = validateOrderAgainstPolicy(
    normalizeOrderInput({ variety: 'co', exchange: 'BSE', tradingsymbol: 'SBIN', transaction_type: 'BUY', order_type: 'MARKET', quantity: 11, product: 'NRML', validity: 'DAY' }),
    cfg,
  );
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(r => r.includes('Variety')));
  assert.ok(result.reasons.some(r => r.includes('Exchange')));
  assert.ok(result.reasons.some(r => r.includes('Product')));
  assert.ok(result.reasons.some(r => r.includes('Quantity')));
});

test('TradeCopier uses separate app credentials for leader and follower logins', () => {
  const copier = new TradeCopier({
    config: {
      host: '127.0.0.1', port: 8787,
      accounts: {
        leader: { apiKey: 'leaderKey', apiSecret: 'leaderSecret', redirectUrl: 'http://127.0.0.1:8787/auth/zerodha/callback' },
        followers: [
          { id: 'follower_1', label: 'F1', apiKey: 'followerKey', apiSecret: 'followerSecret', redirectUrl: 'http://127.0.0.1:8787/auth/zerodha/callback',
            quantityMultiplier: 1, maxQuantityPerOrder: 0, maxPriceDeviationPercent: 1.0, marketProtection: '-1', followMarketOrdersAsLimit: true, priceTickSize: 0.05 },
        ],
      },
      dryRun: true, quantityMultiplier: 1, maxQuantityPerOrder: 0, allowMarketOrders: true,
      marketProtection: '-1', followMarketOrdersAsLimit: true, maxPriceDeviationPercent: 1.0, priceTickSize: 0.05,
      allowedVarieties: ['regular'], allowedExchanges: ['NSE'], allowedProducts: ['MIS'],
      allowedOrderTypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'], replicateCancellations: true,
      replicateModifications: false, tagPrefix: 'CPY', logBufferSize: 10,
      tokenStoreFile: path.join('/tmp', 'trade-copier-test-tokens.json'),
      runtimeStoreFile: path.join('/tmp', 'trade-copier-test-runtime.json'),
    },
    logger: { info() {}, error() {} },
  });

  const leaderUrl = new URL(copier.buildLoginUrl('leader'));
  const followerUrl = new URL(copier.buildLoginUrl('follower_1'));
  assert.equal(leaderUrl.searchParams.get('api_key'), 'leaderKey');
  assert.equal(followerUrl.searchParams.get('api_key'), 'followerKey');
});