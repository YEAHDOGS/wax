/**
 * @file HTTP plumbing shared by every function in `/api`.
 *
 * The functions in this directory are adapters and nothing more. Each one
 * parses a request, calls a handler from `@wax/core`, and serialises what comes
 * back. No product logic lives in `/api` — if you find yourself writing an
 * `if` about vinyl in here, it belongs in `packages/core/src/handlers.js`.
 *
 * Vercel's Node runtime is used rather than the Edge runtime, because
 * `/api/stream.js` proxies audio and wants Node's stream piping.
 */

import { ApiError } from '@wax/core';

/**
 * Read the bearer token off a request.
 *
 * Checks the `Authorization` header first, then an `access_token` query
 * parameter. The query fallback exists for exactly one caller: `<audio>` and
 * `<img>` elements cannot set headers, so a streamed URL has to carry its
 * credential inline. It is deliberately not used anywhere else.
 *
 * @param {import('http').IncomingMessage & { query?: Record<string, string> }} req
 * @returns {?string}
 */
export function bearer(req) {
  const header = req.headers?.authorization ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const fromQuery = req.query?.access_token;
  return typeof fromQuery === 'string' && fromQuery ? fromQuery : null;
}

/**
 * Parse a JSON request body.
 *
 * Vercel usually parses this already and hands back an object; when it does
 * not (empty content-type, raw stream) this falls back to reading the stream.
 * An empty body is `{}`, not an error — several endpoints take no arguments.
 *
 * @param {import('http').IncomingMessage & { body?: unknown }} req
 * @returns {Promise<Record<string, any>>}
 */
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return req.body ? JSON.parse(req.body) : {};
    } catch {
      throw new ApiError(400, 'bad_json', 'Request body is not valid JSON.');
    }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'bad_json', 'Request body is not valid JSON.');
  }
}

/**
 * Send a JSON response.
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Nothing this API returns is cacheable by a shared cache: every response is
  // either scoped to a session or a live figure.
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Send an HTML response.
 *
 * The alert-history page (`/api/alerts/history`) is standalone static HTML —
 * the same no-store policy as JSON applies, because every row on it is
 * session-scoped.
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
export function html(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * Permit the Expo dev server, and any origin in the demo, to call this API.
 *
 * The app and the API are same-origin in production, so this matters only for
 * `expo start --web` on :8081 talking to `vercel dev` on :3000. It is written
 * permissively on purpose and should be tightened to an allowlist the moment
 * anything here touches a real user's data.
 *
 * @param {import('http').ServerResponse} res
 */
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Wrap a handler with CORS, preflight, method dispatch and error mapping.
 *
 * `routes` maps an HTTP method to a function. A method that is not present
 * gets a 405 naming the ones that are, rather than a bare status.
 *
 * @param {Record<string, (req: any, res: any) => unknown>} routes
 * @returns {(req: any, res: any) => Promise<void>}
 *
 * @example
 * export default route({
 *   GET: async (req, res) => json(res, 200, listAlerts(bearer(req))),
 * });
 */
export function route(routes) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const fn = routes[req.method];
    if (!fn) {
      res.setHeader('Allow', Object.keys(routes).join(', '));
      json(res, 405, {
        error: 'method_not_allowed',
        message: `${req.method} is not supported here. Try ${Object.keys(routes).join(' or ')}.`,
      });
      return;
    }

    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        json(res, err.status, { error: err.code, message: err.message });
        return;
      }
      // A genuine bug. Log the detail server-side, tell the client nothing it
      // could use to probe the internals.
      console.error('[api] unhandled', err);
      json(res, 500, { error: 'internal', message: 'Something broke on our side.' });
    }
  };
}

/**
 * Read a single string query parameter.
 *
 * Vercel gives repeated parameters as an array; this takes the first, so
 * `?state=live&state=caught` is not a type error waiting to happen.
 *
 * @param {any} req
 * @param {string} name
 * @returns {?string}
 */
export function param(req, name) {
  const value = req.query?.[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value !== '' ? value : null;
}
