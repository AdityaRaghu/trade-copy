import crypto from 'node:crypto';

const API_BASE_URL = 'https://api.kite.trade';
const LOGIN_BASE_URL = 'https://kite.zerodha.com/connect/login';
const WEBSOCKET_BASE_URL = 'wss://ws.kite.trade';

export class KiteApiError extends Error {
  constructor(message, { status, errorType, body } = {}) {
    super(message);
    this.name = 'KiteApiError';
    this.status = status;
    this.errorType = errorType;
    this.body = body;
  }
}

function toFormEncoded(body) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }

    params.append(key, String(value));
  }

  return params;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}
 
function buildAuthorizationHeader(apiKey, accessToken) {
    return `token ${apiKey}:${accessToken}`;
  }
  
export class KiteClient {
    constructor({ apiKey, apiSecret }) {
      this.apiKey = apiKey;
      this.apiSecret = apiSecret;
    }
  
    buildLoginUrl({ account }) {
      const url = new URL(LOGIN_BASE_URL);
      url.searchParams.set('v', '3');
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set(
        'redirect_params',
        new URLSearchParams({ account }).toString(),
      );
      return url.toString();
    }
  
    async exchangeRequestToken(requestToken) {
      const checksum = crypto
        .createHash('sha256')
        .update(`${this.apiKey}${requestToken}${this.apiSecret}`)
        .digest('hex');
  
      return this.request('POST', '/session/token', {
        body: {
          api_key: this.apiKey,
          request_token: requestToken,
          checksum,
        },
      });
    }
  
    async getProfile(accessToken) {
      return this.request('GET', '/user/profile', { accessToken });
    }

    async placeOrder(accessToken, order) {
        const variety = order.variety ?? 'regular';
        const payload = { ...order };
        delete payload.variety;
    
        return this.request('POST', `/orders/${encodeURIComponent(variety)}`, {
          accessToken,
          body: payload,
        });
      }
    
      async modifyOrder(accessToken, order) {
        const variety = order.variety ?? 'regular';
        const orderId = order.order_id;
        const payload = { ...order };
        delete payload.variety;
        delete payload.order_id;
    
        return this.request(
          'PUT',
          `/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`,
          {
            accessToken,
            body: payload,
          },
        );
      }
    
      async cancelOrder(accessToken, { variety = 'regular', orderId, parentOrderId }) {
        const body = parentOrderId ? { parent_order_id: parentOrderId } : undefined;
        return this.request(
          'DELETE',
          `/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`,
          {
            accessToken,
            body,
          },
        );
      }
    
      connectOrderStream({
        accessToken,
        onOpen,
        onClose,
        onError,
        onOrder,
        onMessage,
      }) {
        const url = new URL(WEBSOCKET_BASE_URL);
        url.searchParams.set('api_key', this.apiKey);
        url.searchParams.set('access_token', accessToken);
    
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
    
        socket.addEventListener('open', () => {
          onOpen?.();
        });
    
        socket.addEventListener('close', (event) => {
          onClose?.(event);
        });
    
        socket.addEventListener('error', (event) => {
          onError?.(event.error ?? event);
        });
    
        socket.addEventListener('message', async (event) => {
          const incoming = await normalizeMessageData(event.data);
          if (typeof incoming !== 'string') {
            return;
          }
    
          try {
            const payload = JSON.parse(incoming);
            if (payload?.type === 'order' && payload.data) {
              onOrder?.(payload.data);
              return;
            }
            onMessage?.(payload);
          } catch (error) {
            onMessage?.({ type: 'raw', data: incoming });
          }
        });
    
        return socket; 
      }

      async request(method, endpoint, { accessToken, body } = {}) {
        const headers = {
          'X-Kite-Version': '3',
        };
    
        let requestBody;
        if (body) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          requestBody = toFormEncoded(body).toString();
        }
    
        if (accessToken) {
          headers.Authorization = buildAuthorizationHeader(this.apiKey, accessToken);
        }
    
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
          method,
          headers,
          body: requestBody,
        });
    
        const parsed = await parseResponse(response);
        if (!response.ok) {
          throw new KiteApiError(
            parsed.message ?? `Kite API request failed for ${endpoint}`,
            {
              status: response.status,
              errorType: parsed.error_type,
              body: parsed,
            },
          );
        }
    
        return parsed.data ?? parsed;
      }
    }
    
    async function normalizeMessageData(value) {
        if (typeof value === 'string') {
          return value;
        }
      
        if (value instanceof Blob) {
          return value.text();
        }
      
        if (value instanceof ArrayBuffer) {
          return Buffer.from(value).toString('utf8');
        }
      
        return value;
      }