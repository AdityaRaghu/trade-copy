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

const niftyCfg = { ...cfg, quantityMultiplier: 1, followMarketOrdersAsLimit: false, maxQuantityPerOrder: 0, lotSize: 65 };
test('buildFollowerOrder rounds quantity down to nearest lot size', () => {
  const fo = buildFollowerOrder({
    order_id: '20', variety: 'regular', exchange: 'NFO', tradingsymbol: 'NIFTY25APR23500CE',
    transaction_type: 'BUY', order_type: 'LIMIT', quantity: 200, product: 'MIS',
    validity: 'DAY', price: 150, trigger_price: 0, average_price: 0, status: 'OPEN',
  }, { ...niftyCfg, maxLots: 0 });
  // 200 x 1 = 200, floor(200/65)*65 = 195
  assert.equal(fo.quantity, 195);
});

test('buildFollowerOrder caps at maxLots * lotSize', () => {
  const fo = buildFollowerOrder({
    order_id: '21', variety: 'regular', exchange: 'NFO', tradingsymbol: 'NIFTY25APR23500CE',
    transaction_type: 'SELL', order_type: 'LIMIT', quantity: 650, product: 'MIS',
    validity: 'DAY', price: 150, trigger_price: 0, average_price: 0, status: 'OPEN',
  }, { ...niftyCfg, maxLots: 5 });
  // 650 qty (10 lots) capped at 5*65=325
  assert.equal(fo.quantity, 325);
});

test('buildFollowerOrder with maxLots=1 always results in exactly 1 lot', () => {
  const fo = buildFollowerOrder({
    order_id: '22', variety: 'regular', exchange: 'NFO', tradingsymbol: 'NIFTY25APR23500CE',
    transaction_type: 'BUY', order_type: 'LIMIT', quantity: 650, product: 'MIS',
    validity: 'DAY', price: 150, trigger_price: 0, average_price: 0, status: 'OPEN',
  }, { ...niftyCfg, maxLots: 1 });
  assert.equal(fo.quantity, 65);
});

test('buildFollowerOrder with exact 1 lot (65 qty) stays 65 with maxLots=1', () => {
  const fo = buildFollowerOrder({
    order_id: '23', variety: 'regular', exchange: 'NFO', tradingsymbol: 'NIFTY25APR23500CE',
    transaction_type: 'SELL', order_type: 'LIMIT', quantity: 65, product: 'MIS',
    validity: 'DAY', price: 150, trigger_price: 0, average_price: 0, status: 'OPEN',
  }, { ...niftyCfg, maxLots: 1 });
  assert.equal(fo.quantity, 65);
});

// —— pre-connect position guard tests ——————————————————————————————————————————————————————————————

function makeCopier() {
  return new TradeCopier({
    config: {
      host: '127.0.0.1', port: 8787,
      accounts: {
        leader: { apiKey: 'lKey', apiSecret: 'lSec', redirectUrl: 'http://127.0.0.1:8787/auth/zerodha/callback' },
        followers: [
          { id: 'follower_1', label: 'F1', apiKey: 'fKey', apiSecret: 'fSec', redirectUrl: 'http://127.0.0.1:8787/auth/zerodha/callback',
            quantityMultiplier: 1, maxQuantityPerOrder: 0, maxPriceDeviationPercent: 1.0, marketProtection: '-1',
            followMarketOrdersAsLimit: false, priceTickSize: 0.05, lotSize: 65, maxLots: 1 },
        ],
      },
      dryRun: true, quantityMultiplier: 1, maxQuantityPerOrder: 0, allowMarketOrders: true,
      marketProtection: '-1', followMarketOrdersAsLimit: false, maxPriceDeviationPercent: 1.0,
      priceTickSize: 0.05, lotSize: 65, maxLots: 1,
      allowedVarieties: ['regular'], allowedExchanges: ['NSE', 'NFO'], allowedProducts: ['MIS'],
      allowedOrderTypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'], replicateCancellations: true,
      replicateModifications: false, tagPrefix: 'CPY', logBufferSize: 10,
      tokenStoreFile: path.join('/tmp', 'trade-copier-test-tokens-pre.json'),
      runtimeStoreFile: path.join('/tmp', 'trade-copier-test-runtime-pre.json'),
    },
    logger: { info() {}, error() {} },
  });
}

const squareOffOrder = {
  variety: 'regular', exchange: 'NFO', tradingsymbol: 'NIFTY25APR23500CE',
  transaction_type: 'BUY', order_type: 'LIMIT', quantity: 65, product: 'MIS',
  validity: 'DAY', price: 150, trigger_price: 0, average_price: 0,
  status: 'OPEN', exchange_order_id: 'EX999',
};

test('pre-connect guard skips square-off when follower has no pre-connect position', async () => {
  const copier = makeCopier();
  copier.runtime.preConnectedPositions = {
    leader: { 'NIFTY25APR23500CE': -65 },
    follower_1: {},
  };
  await copier.simulateSourceOrder({ ...squareOffOrder, order_id: 'SKIP001' });
  const saved = copier.runtime.mirroredOrders['SKIP001']?.followers?.follower_1;
  assert.ok(saved, 'Expected follower entry to be saved');
  assert.equal(saved.mirrorStatus, 'skipped');
  assert.ok(saved.blockedReasons?.[0]?.includes('pre-connect'));
});

test('pre-connect guard allows square-off when follower also has pre-connect position', async () => {
  const copier = makeCopier();
  copier.runtime.preConnectedPositions = {
    leader: { 'NIFTY25APR23500CE': -65 },
    follower_1: { 'NIFTY25APR23500CE': -65 },
  };
  await copier.simulateSourceOrder({ ...squareOffOrder, order_id: 'ALLOW001' });
  const saved = copier.runtime.mirroredOrders['ALLOW001']?.followers?.follower_1;
  assert.ok(saved, 'Expected follower entry to be saved');
  assert.equal(saved.mirrorStatus, 'dry_run');
});

test('pre-connect guard allows fresh entry when no pre-connect positions exist', async () => {
  const copier = makeCopier();
  copier.runtime.preConnectedPositions = { leader: {}, follower_1: {} };
  await copier.simulateSourceOrder({ ...squareOffOrder, order_id: 'FRESH001' });
  const saved = copier.runtime.mirroredOrders['FRESH001']?.followers?.follower_1;
  assert.ok(saved, 'Expected follower entry to be saved');
  assert.equal(saved.mirrorStatus, 'dry_run');
});

test('pre-connect guard allows adding to pre-connect long (same direction, not a square-off)', async () => {
  const copier = makeCopier();
  copier.runtime.preConnectedPositions = {
    leader: { 'NIFTY25APR23500CE': 65 },  // leader was LONG before connect
    follower_1: {},
  };
  // BUY when leader has positive pre-connect = adding to long, not square-off
  await copier.simulateSourceOrder({ ...squareOffOrder, transaction_type: 'BUY', order_id: 'ADDLONG001' });
  const saved = copier.runtime.mirroredOrders['ADDLONG001']?.followers?.follower_1;
  assert.ok(saved, 'Expected follower entry to be saved');
  assert.equal(saved.mirrorStatus, 'dry_run');
});