import { ContractError, MAX_BYTES, UPSTREAM_URL, normalizeRequest, normalizeResponse } from './contracts.js';

const ENDPOINT = '/api/ai';
const ALLOWED_HEADERS = ['content-type', 'x-ai-stage'];
const encoder = new TextEncoder();

class DeadlineError extends Error {}

function originList(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError('SERVICE_UNAVAILABLE', 503);
  const origins = value.split(',').map(item => item.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch (_) { throw new ContractError('SERVICE_UNAVAILABLE', 503); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new ContractError('SERVICE_UNAVAILABLE', 503);
    }
  }
  return new Set(origins);
}

function responseHeaders(origin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  });
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function failure(status, code, origin) {
  const headers = responseHeaders(origin);
  if (status === 429) headers.set('Retry-After', '60');
  return new Response(JSON.stringify({ error: { code } }), { status, headers });
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new DeadlineError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DeadlineError()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new DeadlineError());
      else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function boundedText(message, signal, oversizedStatus) {
  if (!message.body) throw new ContractError(oversizedStatus === 413 ? 'INVALID_REQUEST' : 'INVALID_UPSTREAM_RESPONSE', oversizedStatus === 413 ? 400 : 502);
  const advertised = message.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BYTES)) {
    message.body.cancel().catch(() => {});
    throw new ContractError('BODY_TOO_LARGE', oversizedStatus);
  }
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new ContractError('BODY_TOO_LARGE', oversizedStatus);
      chunks.push(value);
    }
  } catch (error) {
    // Cancellation is best-effort; never let an uncooperative stream hold the response open.
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { throw new ContractError('INVALID_JSON', oversizedStatus === 413 ? 400 : 502); }
}

function readJson(text, upstream = false) {
  try { return JSON.parse(text); }
  catch (_) { throw new ContractError(upstream ? 'INVALID_UPSTREAM_RESPONSE' : 'INVALID_REQUEST', upstream ? 502 : 400); }
}

function configuration(env, now) {
  if (env.SERVICE_ENABLED !== 'true') throw new ContractError('SERVICE_DISABLED', 403);
  const key = env.DEEPSEEK_API_KEY;
  if (typeof key !== 'string' || !key || key.length > 512 || /\s/.test(key)) {
    throw new ContractError('SERVICE_UNAVAILABLE', 503);
  }
  if (!env.IP_RATE_LIMITER || typeof env.IP_RATE_LIMITER.limit !== 'function' ||
      !env.SERVICE_RATE_LIMITER || typeof env.SERVICE_RATE_LIMITER.limit !== 'function') {
    throw new ContractError('SERVICE_UNAVAILABLE', 503);
  }
  // Optional absolute cutoff. Never calculate a new 30-day window at startup/deployment.
  if (env.DEMO_EXPIRES_AT) {
    const value = env.DEMO_EXPIRES_AT;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new ContractError('SERVICE_UNAVAILABLE', 503);
    }
    if (now() >= Date.parse(value)) throw new ContractError('DEMO_EXPIRED', 403);
  }
  return key;
}

async function rateLimit(env, request, signal) {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) throw new ContractError('INVALID_CALLER', 403);
  let perIp;
  let shared;
  try {
    perIp = await raceAbort(env.IP_RATE_LIMITER.limit({ key: `ip:${ip}` }), signal);
    if (perIp?.success !== true) {
      if (perIp?.success === false) throw new ContractError('RATE_LIMITED', 429);
      throw new ContractError('SERVICE_UNAVAILABLE', 503);
    }
    shared = await raceAbort(env.SERVICE_RATE_LIMITER.limit({ key: 'shared-ai-demo' }), signal);
    if (shared?.success === false) throw new ContractError('RATE_LIMITED', 429);
    if (shared?.success !== true) throw new ContractError('SERVICE_UNAVAILABLE', 503);
  } catch (error) {
    if (error instanceof ContractError || error instanceof DeadlineError) throw error;
    throw new ContractError('SERVICE_UNAVAILABLE', 503);
  }
}

function containsSecret(value, secret, depth = 0) {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    if (value.includes(secret)) return true;
    const decoded = value.replace(/\\u([0-9a-f]{4})/gi, (_match, digits) => String.fromCharCode(parseInt(digits, 16)));
    if (decoded.includes(secret)) return true;
    try {
      const nested = JSON.parse(value);
      if (nested !== value && containsSecret(nested, secret, depth + 1)) return true;
    } catch (_) { /* Plain-text responses are also supported. */ }
    return decoded !== value && containsSecret(decoded, secret, depth + 1);
  }
  if (value && typeof value === 'object') return Object.values(value).some(item => containsSecret(item, secret, depth + 1));
  return false;
}

function upstreamError(status) {
  const known = { 400: 'UPSTREAM_REJECTED', 401: 'UPSTREAM_AUTH', 402: 'INSUFFICIENT_BALANCE', 403: 'UPSTREAM_AUTH', 429: 'UPSTREAM_RATE_LIMITED' };
  if (known[status]) return new ContractError(known[status], status);
  return new ContractError('UPSTREAM_UNAVAILABLE', 502);
}

// Dependencies are injectable only by code, allowing offline tests without a live key.
export function createWorker({ fetchUpstream = (...args) => fetch(...args), timeoutMs, now = Date.now } = {}) {
  return {
    async fetch(request, env) {
      let origin;
      let controller;
      let timer;
      let detach;
      try {
        const url = new URL(request.url);
        if (url.pathname !== ENDPOINT) return failure(404, 'NOT_FOUND');
        const callerOrigin = request.headers.get('origin');
        const allowed = originList(env.ALLOWED_ORIGINS);
        if (!callerOrigin || !allowed.has(callerOrigin)) return failure(403, 'ORIGIN_DENIED');
        origin = callerOrigin;
        if (url.search || url.hash) return failure(400, 'INVALID_REQUEST', origin);

        if (request.method === 'OPTIONS') {
          const requestedMethod = request.headers.get('access-control-request-method');
          const requestedHeaders = request.headers.get('access-control-request-headers');
          const headers = requestedHeaders?.split(',').map(value => value.trim().toLowerCase());
          if (requestedMethod !== 'POST' || !headers?.length || headers.some(name => !ALLOWED_HEADERS.includes(name))) {
            return failure(403, 'PREFLIGHT_DENIED', origin);
          }
          const response = responseHeaders(origin);
          response.set('Access-Control-Allow-Methods', 'POST');
          response.set('Access-Control-Allow-Headers', 'Content-Type, X-AI-Stage');
          response.set('Access-Control-Max-Age', '600');
          return new Response(null, { status: 204, headers: response });
        }
        if (request.method !== 'POST') {
          const response = failure(405, 'METHOD_NOT_ALLOWED', origin);
          response.headers.set('Allow', 'POST, OPTIONS');
          return response;
        }
        if (request.headers.has('authorization') || request.headers.has('cookie')) return failure(400, 'UNEXPECTED_CREDENTIALS', origin);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
            (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')) {
          return failure(415, 'UNSUPPORTED_MEDIA_TYPE', origin);
        }
        const stage = request.headers.get('x-ai-stage');
        if (stage !== '10AM' && stage !== '8PM') return failure(400, 'INVALID_STAGE', origin);
        const secret = configuration(env, now);
        controller = new AbortController();
        const abort = () => controller.abort();
        request.signal.addEventListener('abort', abort, { once: true });
        detach = () => request.signal.removeEventListener('abort', abort);
        if (request.signal.aborted) abort();
        const duration = timeoutMs ?? (stage === '10AM' ? 7000 : 4500);
        timer = setTimeout(abort, duration);

        const incomingText = await boundedText(request, controller.signal, 413);
        const body = normalizeRequest(readJson(incomingText), stage);
        await rateLimit(env, request, controller.signal);
        const response = await raceAbort(fetchUpstream(UPSTREAM_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: controller.signal
        }), controller.signal);
        if (response.status >= 300 && response.status < 400) {
          response.body?.cancel().catch(() => {});
          throw new ContractError('UPSTREAM_REDIRECT_DENIED', 502);
        }
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          throw upstreamError(response.status);
        }
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          response.body?.cancel().catch(() => {});
          throw new ContractError('INVALID_UPSTREAM_RESPONSE', 502);
        }
        const raw = await boundedText(response, controller.signal, 502);
        const result = normalizeResponse(readJson(raw, true), stage);
        const serialized = JSON.stringify(result);
        if (containsSecret(result, secret) || encoder.encode(serialized).length > MAX_BYTES) {
          throw new ContractError('INVALID_UPSTREAM_RESPONSE', 502);
        }
        return new Response(serialized, { status: 200, headers: responseHeaders(origin) });
      } catch (error) {
        if (error instanceof ContractError) return failure(error.status, error.code, origin);
        if (error instanceof DeadlineError || controller?.signal.aborted) return failure(504, 'REQUEST_TIMEOUT', origin);
        return failure(502, 'UPSTREAM_UNAVAILABLE', origin);
      } finally {
        clearTimeout(timer);
        detach?.();
        controller?.abort();
      }
    }
  };
}

export default createWorker();
