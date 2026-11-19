// Shared REST wire helpers for the forge (src/http.ts).
// Every REST handler (REST v3, and the JSON error paths of GraphQL/MCP) must go
// through these helpers so the wire contract holds on every reply.
// Stdlib only, Node 22, erasable TypeScript (no enums / namespaces).
// store.ts is NOT imported here: these helpers are transport-only and know
// nothing about repositories, issues or the viewer.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Maximum request body accepted by readBody (10 MiB; the suite sends small JSON). */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * A request id for X-GitHub-Request-Id. crypto.randomUUID(): non-empty and
 * unique per reply. Determinism note: the id only ever appears in a response
 * header, never in the store / state export, so randomness here cannot make
 * a replay differ.
 */
export function requestId(): string {
  return randomUUID();
}

function headerHas(headers: Readonly<Record<string, string>>, name: string): boolean {
  const want = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === want);
}

/**
 * Answer with a JSON body. Always sets:
 *   Content-Type: application/json; charset=utf-8
 *   X-GitHub-Request-Id: <non-empty> (generated, unless `headers` supplies one)
 * Extra `headers` (e.g. X-OAuth-Scopes, Link) are merged beside them.
 * Status 204 sends no body (Content-Length: 0) but still carries the headers.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  const out: Record<string, string> = { ...headers };
  if (!headerHas(out, 'content-type')) out['content-type'] = JSON_TYPE;
  if (!headerHas(out, 'x-github-request-id')) out['x-github-request-id'] = requestId();
  if (status === 204) {
    out['content-length'] = '0';
    res.writeHead(204, out);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  out['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, out);
  res.end(text);
}

/** Answer with the standard GitHub error body: {"message": "<string>"}, JSON, never HTML. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/**
 * Read the whole request body. Resolves to a Buffer (possibly empty).
 * Rejects on a stream error or when the body exceeds MAX_BODY_BYTES.
 * Callers must catch the rejection and answer 400/413 via sendError.
 */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

export interface ParseJsonResult {
  ok: boolean;
  /** Parsed value; `undefined` when the body was empty / whitespace-only. */
  value?: unknown;
  /** Human-readable reason when ok === false. */
  error?: string;
}

/**
 * Parse a request body as JSON. An empty body is ok with value === undefined
 * (handlers decide whether a body was required). Anything else that is not
 * valid JSON is { ok: false, error } and the handler must answer 400 via
 * sendError (see protocol.md: malformed-body-400).
 */
export function parseJsonBody(raw: Buffer | string): ParseJsonResult {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

/**
 * True when the request carries `Authorization: Bearer <non-empty-token>`.
 * Per store.ts: ANY non-empty Bearer token is the viewer (adaiversen, id 1000);
 * there is no per-token validation against MAKEFUN_SHOP_TOKEN. Missing,
 * empty (`Bearer ` / `Bearer` with no token) or non-Bearer auth is false,
 * and the handler must answer 401 via sendError.
 */
export function authCheck(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match !== null && match[1] !== undefined && match[1].length > 0;
}

export interface PaginateResult<T> {
  /** The items for the requested page (already sliced). */
  page: T[];
  /** GitHub-style Link header value, or null when there is only one page. */
  linkHeader: string | null;
}

type QueryInput = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

function queryValue(query: QueryInput, name: string): string | undefined {
  if (query instanceof URLSearchParams) {
    const v = query.get(name);
    return v === null ? undefined : v;
  }
  const v = query[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function parsePageParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Paginate an already-filtered, already-ordered list (GitHub semantics).
 * Query params: `page` (default 1, min 1) and `per_page` (default 30,
 * clamped to 1..100). Returns the page slice plus a Link header.
 *
 * `baseUrl` is the absolute URL of the collection WITHOUT query string
 * (e.g. `http://host/api/v3/user/repos`); handlers MUST pass it, because
 * the suite follows Link rel="next" and requires it to stay on the same
 * origin (checks-rest.ts reposPagination). Without it, relative `?page=…`
 * links are emitted instead. The header includes rel="next" / "prev" /
 * "first" / "last" only where they apply, and is null on a single page.
 */
export function paginate<T>(items: readonly T[], query: QueryInput, baseUrl?: string): PaginateResult<T> {
  const perPage = Math.min(100, Math.max(1, parsePageParam(queryValue(query, 'per_page'), 30)));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const pageNum = Math.min(totalPages, Math.max(1, parsePageParam(queryValue(query, 'page'), 1)));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page, linkHeader: null };

  const linkFor = (p: number): string => {
    if (baseUrl !== undefined) {
      const url = new URL(baseUrl);
      url.searchParams.set('page', String(p));
      url.searchParams.set('per_page', String(perPage));
      return url.toString();
    }
    return `?page=${p}&per_page=${perPage}`;
  };
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`<${linkFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) parts.push(`<${linkFor(pageNum - 1)}>; rel="prev"`);
  parts.push(`<${linkFor(1)}>; rel="first"`);
  parts.push(`<${linkFor(totalPages)}>; rel="last"`);
  return { page, linkHeader: parts.join(', ') };
}
