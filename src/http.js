// Dependency-free HTTP(S) GET client for the DPX desktop-release channel.
//
// `dpx` must run without runtime dependencies, so this module implements the
// small HTTP surface the release channel needs: GET with redirects, an optional
// HTTP CONNECT proxy, and hard timeouts. Only identity encoding is requested,
// therefore no decompression is required.
//
// The desktop launcher implements the same release contract in Rust
// (`desktop-shell/src-tauri/src/update.rs`). Keep both sides aligned with
// `docs/desktop-release.md`.

import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_MAX_REDIRECTS = 5;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;
const PROXY_ENVIRONMENT_KEYS = [
  'DPX_HTTP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy',
];

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * A failure that is worth trying again: a stalled or reset connection, or a
 * server-side status that is expected to be temporary.
 */
export function isRetryable(error) {
  if (!(error instanceof HttpError)) return false;
  if (error.status !== undefined) return RETRYABLE_STATUS.has(error.status);
  return /timed out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|Connection closed|Connection failed|Cannot connect|Proxy connection timed out/i
    .test(error.message);
}

/**
 * The proxy an update check/download should use when the caller passes none.
 * Uses the ambient proxy environment so a machine behind a proxy keeps working
 * without extra flags, but never invents a proxy of its own.
 */
export function defaultProxy(env = process.env) {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    const value = env?.[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeProxy(proxy) {
  const value = String(proxy).trim();
  if (!value) return undefined;
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (url.protocol !== 'http:') throw new Error(`Only an http:// CONNECT proxy is supported, got ${url.protocol}//`);
  if (!url.port) url.port = '80';
  return url;
}

function openTunnel(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const authority = `${target.host}:${target.port}`;
    const socket = connectTcp({ host: proxy.hostname, port: Number(proxy.port) });
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeout, () => fail(new HttpError(`Proxy connection timed out after ${timeout} ms: ${proxy.host}:${proxy.port}`)));
    socket.once('error', error => fail(new HttpError(`Cannot reach proxy ${proxy.host}:${proxy.port}: ${error.message}`)));
    socket.once('connect', () => {
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive'];
      if (proxy.username) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password ?? '')}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      let buffer = Buffer.alloc(0);
      const onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffer.length > MAX_HEADER_BYTES) fail(new HttpError('Proxy CONNECT response headers are too large.'));
          return;
        }
        socket.off('data', onData);
        const status = Number(buffer.subarray(0, end).toString('latin1').split(' ')[1]);
        if (status !== 200) {
          fail(new HttpError(`Proxy refused CONNECT ${authority} with status ${status}.`, { status }));
          return;
        }
        settled = true;
        socket.setTimeout(0);
        resolve(socket);
      };
      socket.on('data', onData);
    });
  });
}

function targetPort(target) {
  if (target.port) return Number(target.port);
  return target.protocol === 'https:' ? 443 : 80;
}

function connectTarget(target, { proxy, timeout }) {
  return new Promise((resolve, reject) => {
    const secure = target.protocol === 'https:';
    const port = targetPort(target);
    const connect = () => {
      const socket = secure
        ? connectTls({ host: target.hostname, port, servername: target.hostname })
        : connectTcp({ host: target.hostname, port });
      socket.once('error', error => reject(new HttpError(`Cannot connect to ${target.host}: ${error.message}`)));
      socket.once(secure ? 'secureConnect' : 'connect', () => resolve(socket));
      socket.setTimeout(timeout, () => {
        socket.destroy();
        reject(new HttpError(`Connection timed out after ${timeout} ms: ${target.host}`));
      });
    };
    if (!proxy) {
      connect();
      return;
    }
    openTunnel(proxy, { host: target.hostname, port }, timeout).then(socket => {
      if (!secure) {
        resolve(socket);
        return;
      }
      const secured = connectTls({ socket, servername: target.hostname });
      secured.once('error', error => reject(new HttpError(`TLS handshake with ${target.host} failed: ${error.message}`)));
      secured.once('secureConnect', () => resolve(secured));
    }).catch(reject);
  });
}

function parseHead(text) {
  const [statusLine, ...headerLines] = text.split('\r\n');
  const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (!match) throw new HttpError(`Malformed HTTP status line: ${JSON.stringify(statusLine)}`);
  const headers = {};
  for (const line of headerLines) {
    const index = line.indexOf(':');
    if (index < 1) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(match[1]), headers };
}

function readResponse(socket, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let head;
    let mode;
    let remaining = 0;
    let body = [];
    let bodyLength = 0;
    let settled = false;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      if (error) reject(error); else resolve(value);
    };

    const collect = chunk => {
      bodyLength += chunk.length;
      if (bodyLength > maxBodyBytes) {
        settle(new HttpError(`Response body exceeds the ${maxBodyBytes} byte limit.`));
        return false;
      }
      body.push(chunk);
      return true;
    };

    const consumeChunked = () => {
      while (true) {
        if (mode === 'chunk-size') {
          const end = buffer.indexOf('\r\n');
          if (end < 0) return;
          const size = Number.parseInt(buffer.subarray(0, end).toString('latin1').trim().split(';')[0], 16);
          if (!Number.isSafeInteger(size) || size < 0) {
            settle(new HttpError('Malformed chunked response.'));
            return;
          }
          buffer = buffer.subarray(end + 2);
          if (size === 0) {
            mode = 'chunk-trailer';
            continue;
          }
          remaining = size;
          mode = 'chunk-data';
        }
        if (mode === 'chunk-data') {
          if (buffer.length < remaining + 2) return;
          if (!collect(buffer.subarray(0, remaining))) return;
          buffer = buffer.subarray(remaining + 2);
          remaining = 0;
          mode = 'chunk-size';
          continue;
        }
        if (mode === 'chunk-trailer') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0 && buffer.length >= 2 && buffer.subarray(0, 2).toString('latin1') === '\r\n') {
            settle(null, { head, body: Buffer.concat(body) });
            return;
          }
          if (end < 0) return;
          settle(null, { head, body: Buffer.concat(body) });
          return;
        }
        return;
      }
    };

    const parse = () => {
      if (!head) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffer.length > MAX_HEADER_BYTES) settle(new HttpError('Response headers are too large.'));
          return;
        }
        head = parseHead(buffer.subarray(0, end).toString('latin1'));
        buffer = buffer.subarray(end + 4);
        if (head.status === 204 || head.status === 304 || (head.status >= 100 && head.status < 200)) {
          settle(null, { head, body: Buffer.alloc(0) });
          return;
        }
        if (/\bchunked\b/i.test(head.headers['transfer-encoding'] ?? '')) {
          mode = 'chunk-size';
        } else if (head.headers['content-length'] !== undefined) {
          remaining = Number(head.headers['content-length']);
          if (!Number.isSafeInteger(remaining) || remaining < 0) {
            settle(new HttpError('Malformed Content-Length header.'));
            return;
          }
          mode = 'length';
        } else {
          mode = 'close';
        }
      }
      if (mode === 'length') {
        if (buffer.length < remaining) return;
        if (!collect(buffer.subarray(0, remaining))) return;
        buffer = buffer.subarray(remaining);
        settle(null, { head, body: Buffer.concat(body) });
        return;
      }
      if (mode === 'close') {
        if (buffer.length && !collect(buffer)) return;
        buffer = Buffer.alloc(0);
        return;
      }
      consumeChunked();
    };

    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    };
    const onError = error => settle(new HttpError(`Connection failed: ${error.message}`));
    const onEnd = () => {
      if (!head) {
        settle(new HttpError('Connection closed before the response headers were complete.'));
        return;
      }
      if (mode === 'close') {
        settle(null, { head, body: Buffer.concat(body) });
        return;
      }
      settle(new HttpError('Connection closed before the response body was complete.'));
    };
    const onClose = () => onEnd();

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    socket.once('close', onClose);
  });
}

function requestOnce({ target, proxy, headers, timeout, maxBodyBytes }) {
  return connectTarget(target, { proxy, timeout }).then(socket => new Promise((resolve, reject) => {
    const request = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Accept-Encoding: identity',
      'Connection: close',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '', '',
    ].join('\r\n');
    readResponse(socket, maxBodyBytes).then(response => {
      socket.destroy();
      resolve(response);
    }, error => {
      socket.destroy();
      reject(error);
    });
    socket.once('error', error => reject(new HttpError(`Connection failed: ${error.message}`)));
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new HttpError(`Request timed out after ${timeout} ms: ${target.href}`));
    });
    socket.write(request, 'latin1');
  }));
}

/**
 * GET a URL, following redirects, and return the whole body.
 *
 * Transient failures are retried: publishing channels sit behind proxies and CDNs
 * that occasionally stall or reset a connection, and a single flake should not
 * turn "check for updates" into an error the user has to retry by hand.
 *
 * @returns {Promise<{url: string, status: number, headers: Record<string,string>, body: Buffer}>}
 */
export async function httpGet(url, options = {}) {
  const { retries = DEFAULT_RETRIES, retryDelayMs = 750 } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await httpGetOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryable(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

async function httpGetOnce(url, options = {}) {
  const {
    proxy,
    headers = {},
    timeout = DEFAULT_TIMEOUT,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = options;
  const parsedProxy = proxy ? normalizeProxy(proxy) : undefined;
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new HttpError(`Unsupported protocol: ${current.protocol}//`);
    }
    const { head, body } = await requestOnce({ target: current, proxy: parsedProxy, headers, timeout, maxBodyBytes });
    const location = head.headers.location;
    if (head.status >= 300 && head.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    return { url: current.href, status: head.status, headers: head.headers, body };
  }
  throw new HttpError(`Too many redirects (${maxRedirects}) starting at ${url}.`);
}

/** GET a JSON document. Throws when the status is not 2xx. */
export async function httpGetJson(url, options = {}) {
  const response = await httpGet(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(`GET ${response.url} failed with status ${response.status}.`, { status: response.status, url: response.url });
  }
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch (error) {
    throw new HttpError(`GET ${response.url} did not return valid JSON: ${error.message}`, { status: response.status, url: response.url });
  }
}

/** GET a binary document, failing closed on a non-2xx status. */
export async function httpGetBuffer(url, options = {}) {
  const response = await httpGet(url, options);
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(`GET ${response.url} failed with status ${response.status}.`, { status: response.status, url: response.url });
  }
  return { ...response, body: response.body };
}
