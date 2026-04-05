import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function loadEnvFile(envPath = path.join(projectRoot, '.env')) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseNumber(value, defaultValue) {
    if (value == null || value === '') {
      return defaultValue;
    }
  
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }
  
  function parseCsv(value, defaultValues) {
    if (!value) {
      return [...defaultValues];
    }
  
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  
  loadEnvFile();
  
  const port = parseNumber(process.env.PORT, 8787);
  const defaultRedirectUrl = `http://127.0.0.1:${port}/auth/zerodha/callback`;
  
  function buildAccountConfig(envPrefix) {
    return {
      apiKey:
        process.env[`${envPrefix}_KITE_API_KEY`] ??
        process.env.KITE_API_KEY ??
        '',
      apiSecret:
        process.env[`${envPrefix}_KITE_API_SECRET`] ??
        process.env.KITE_API_SECRET ??
        '',
      redirectUrl:
        process.env[`${envPrefix}_KITE_REDIRECT_URL`] ??
        process.env.KITE_REDIRECT_URL ??
        defaultRedirectUrl,
    };
  }
  
  export const config = {
    projectRoot,
    host: process.env.HOST ?? '127.0.0.1',
    port,
    accounts: {
      leader: buildAccountConfig('LEADER'),
      follower: buildAccountConfig('FOLLOWER'),
    },
    dryRun: parseBoolean(process.env.DRY_RUN, true),
    quantityMultiplier: parseNumber(
      process.env.FOLLOW_QUANTITY_MULTIPLIER,
      1,
    ),
    maxQuantityPerOrder: parseNumber(process.env.MAX_QUANTITY_PER_ORDER, 0),
    allowMarketOrders: parseBoolean(process.env.ALLOW_MARKET_ORDERS, true),
    marketProtection: process.env.MARKET_PROTECTION ?? '-1',
    followMarketOrdersAsLimit: parseBoolean(
      process.env.FOLLOW_MARKET_ORDERS_AS_LIMIT,
      true,
    ),
    maxPriceDeviationPercent: parseNumber(
      process.env.MAX_PRICE_DEVIATION_PERCENT,
      0.30,
    ),
    priceTickSize: parseNumber(process.env.PRICE_TICK_SIZE, 0.05),
    allowedVarieties: parseCsv(process.env.ALLOWED_VARIETIES, ['regular', 'amo']),
    allowedExchanges: parseCsv(process.env.ALLOWED_EXCHANGES, [
      'NSE',
      'BSE',
      'NFO',
      'MCX',
    ]),
    allowedProducts: parseCsv(process.env.ALLOWED_PRODUCTS, ['MIS', 'NRML', 'CNC']),
    allowedOrderTypes: parseCsv(process.env.ALLOWED_ORDER_TYPES, [
      'MARKET',
      'LIMIT',
      'SL',
      'SL-M',
    ]),
    replicateCancellations: parseBoolean(
      process.env.REPLICATE_CANCELLATIONS,
      true,
    ),
    replicateModifications: parseBoolean(
      process.env.REPLICATE_MODIFICATIONS,
      false,
    ),
    tagPrefix: (process.env.ORDER_TAG_PREFIX ?? 'CPY').replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'CPY',
    logBufferSize: parseNumber(process.env.LOG_BUFFER_SIZE, 200),
    tokenStoreFile: path.resolve(
      projectRoot,
      process.env.TOKEN_STORE_FILE ?? 'data/tokens.json',
    ),
    runtimeStoreFile: path.resolve(
      projectRoot,
      process.env.RUNTIME_STORE_FILE ?? 'data/runtime.json',
    ),
  };
  
  export function getAccountConfig(account) {
    const accountConfig = config.accounts?.[account];
    if (!accountConfig) {
      throw new Error(`Unknown account "${account}". Expected leader or follower.`);
    }
  
    return accountConfig;
  }
  
  export function hasKiteCredentials(account) {
    const accountConfig = getAccountConfig(account);
    return Boolean(
      accountConfig.apiKey &&
        accountConfig.apiSecret &&
        accountConfig.redirectUrl,
    );
  }
  
  export function requireKiteCredentials(accounts) {
    const requiredAccounts = Array.isArray(accounts) ? accounts : [accounts];
    const missing = requiredAccounts.filter((account) => !hasKiteCredentials(account));
  
    if (missing.length === 0) {
      return;
    }
  
    const accountInstructions = missing
      .map((account) => {
        const prefix = account.toUpperCase();
        return `${prefix}_KITE_API_KEY, ${prefix}_KITE_API_SECRET, and ${prefix}_KITE_REDIRECT_URL`;
      })
      .join('; ');
  
    throw new Error(
      `Missing Kite credentials for ${missing.join(', ')}. Set ${accountInstructions} in .env,
      or use shared KITE_API_KEY, KITE_API_SECRET, and KITE_REDIRECT_URL if Zerodha has approved one multi-user app.`,
    );
  }