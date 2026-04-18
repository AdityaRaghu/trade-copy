import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function loadEnvFile(envPath = path.join(projectRoot, '.env')) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

const bool = (v, d = false) => {
  if (v == null || v === '') return d;
  const s = String(v).trim();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return d;
};
const num = (v, d) => { if (v == null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const csv = (v, d) => v ? v.split(',').map(s => s.trim()).filter(Boolean) : [...d];

loadEnvFile();
const port = num(process.env.PORT, 8787);
const defaultRedirectUrl = `http://127.0.0.1:${port}/auth/zerodha/callback`;
const FOLLOWER = 'follower';

function creds(prefix) {
  return {
    apiKey: process.env[`${prefix}_KITE_API_KEY`] ?? process.env.KITE_API_KEY ?? '',
    apiSecret: process.env[`${prefix}_KITE_API_SECRET`] ?? process.env.KITE_API_SECRET ?? '',
    redirectUrl: process.env[`${prefix}_KITE_REDIRECT_URL`] ?? process.env.KITE_REDIRECT_URL ?? defaultRedirectUrl,
  };
}

const globalDefs = {
  quantityMultiplier: num(process.env.FOLLOW_QUANTITY_MULTIPLIER ?? process.env.FOLLOWER_QUANTITY_MULTIPLIER, 1),
  maxQuantityPerOrder: num(process.env.MAX_QUANTITY_PER_ORDER, 0),
  maxPriceDeviationPercent: num(process.env.MAX_PRICE_DEVIATION_PERCENT, 1.0),
  marketProtection: process.env.MARKET_PROTECTION ?? '-1',
  followMarketOrdersAsLimit: bool(process.env.FOLLOW_MARKET_ORDERS_AS_LIMIT, true),
  priceTickSize: num(process.env.PRICE_TICK_SIZE, 0.05),
  lotSize: num(process.env.LOT_SIZE, 0),
  maxLots: num(process.env.MAX_LOTS, 0),
};

function followerConfig(prefix, label) {
  return {
    id: FOLLOWER,
    label,
    ...creds(prefix),
    quantityMultiplier: num(process.env[`${prefix}_QUANTITY_MULTIPLIER`], globalDefs.quantityMultiplier),
    maxQuantityPerOrder: num(process.env[`${prefix}_MAX_QUANTITY_PER_ORDER`], globalDefs.maxQuantityPerOrder),
    maxPriceDeviationPercent: num(process.env[`${prefix}_MAX_PRICE_DEVIATION_PERCENT`], globalDefs.maxPriceDeviationPercent),
    marketProtection: process.env[`${prefix}_MARKET_PROTECTION`] ?? globalDefs.marketProtection,
    followMarketOrdersAsLimit: bool(process.env[`${prefix}_FOLLOW_MARKET_ORDERS_AS_LIMIT`], globalDefs.followMarketOrdersAsLimit),
    priceTickSize: num(process.env[`${prefix}_PRICE_TICK_SIZE`], globalDefs.priceTickSize),
    lotSize: num(process.env[`${prefix}_LOT_SIZE`], globalDefs.lotSize),
    maxLots: num(process.env[`${prefix}_MAX_LOTS`], globalDefs.maxLots),
  };
}

export const config = {
  projectRoot, host: process.env.HOST ?? '127.0.0.1', port,
  accounts: {
    leader: creds('LEADER'),
    follower: followerConfig('FOLLOWER', process.env.FOLLOWER_LABEL ?? 'Follower'),
  },
  dryRun: bool(process.env.DRY_RUN, true),
  ...globalDefs,
  allowMarketOrders: bool(process.env.ALLOW_MARKET_ORDERS, true),
  allowedVarieties: csv(process.env.ALLOWED_VARIETIES, ['regular', 'amo']),
  allowedExchanges: csv(process.env.ALLOWED_EXCHANGES, ['NSE', 'BSE', 'NFO', 'MCX']),
  allowedProducts: csv(process.env.ALLOWED_PRODUCTS, ['MIS', 'NRML', 'CNC']),
  allowedOrderTypes: csv(process.env.ALLOWED_ORDER_TYPES, ['MARKET', 'LIMIT', 'SL', 'SL-M']),
  replicateCancellations: bool(process.env.REPLICATE_CANCELLATIONS, true),
  replicateModifications: bool(process.env.REPLICATE_MODIFICATIONS, false),
  tagPrefix: (process.env.ORDER_TAG_PREFIX ?? 'CPY').replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'CPY',
  logBufferSize: num(process.env.LOG_BUFFER_SIZE, 200),
  tokenStoreFile: path.resolve(projectRoot, process.env.TOKEN_STORE_FILE ?? 'data/tokens.json'),
  runtimeStoreFile: path.resolve(projectRoot, process.env.RUNTIME_STORE_FILE ?? 'data/runtime.json'),
};

export function getAccountConfig(account) {
  if (account === 'leader') return config.accounts.leader;
  if (account === FOLLOWER) return config.accounts.follower;
  throw new Error(`Unknown account "${account}".`);
}

export const hasKiteCredentials = account => {
  const c = getAccountConfig(account);
  return Boolean(c.apiKey && c.apiSecret && c.redirectUrl);
};

export function requireKiteCredentials(accounts) {
  const missing = (Array.isArray(accounts) ? accounts : [accounts]).filter(a => !hasKiteCredentials(a));
  if (missing.length) throw new Error(`Missing Kite credentials for: ${missing.join(', ')}. Check your .env.`);
}