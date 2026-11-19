# REST protocol spec (github-core-clone-01)

Source of truth: kit `sdk/conformance/checks-rest.ts` (`restProtocolChecks`,
5 checks) + `sdk/conformance/rest-client.ts`, and `RULES.txt` § "The wire
contract". Implementation: `src/http.ts` — every REST handler must use it;
do **not** write ad-hoc `res.writeHead` / `JSON.stringify` replies in handlers.

## The 5 protocol checks

| # | Check id | What the suite does | Expected reply |
|---|----------|---------------------|----------------|
| 1 | `protocol.content-type-json` | Calls 6 endpoints and inspects each reply: `GET /api/v3/`, `GET /api/v3/meta`, `GET /api/v3/repos/{o}/{r}`, `GET …/issues`, `GET /api/v3/no-such-route-content-type` (unknown), `GET {repo}` **without** a token. | Every reply `Content-Type: application/json` (the checker accepts `application/json`, `application/vnd.github+json`, `+json`, with optional `; charset=…`) and body must not look like HTML (no `text/html` type, body must not start with `<`). Applies to success **and** error replies, including the 401. |
| 2 | `protocol.unknown-route-json-404` | `GET /api/v3/no-such-route/<repoPrefix>` with a token. | `404`, JSON body `{ "message": "<non-empty string>" }` (shape `messageShape`), `Content-Type: application/json`, no HTML. Same rule for **any** unknown route under `/api/v3` (and, per RULES.txt, any unknown route at all). |
| 3 | `protocol.malformed-body-400` | `POST /api/v3/user/repos` with raw body `{"name":` and `Content-Type: application/json`. | `400`, JSON body `{ "message": "<non-empty string>" }`. Any handler that parses a JSON body must return 400 (not 500, not HTML) on unparseable JSON — use `parseJsonBody()` + `sendError(res, 400, …)`. |
| 4 | `protocol.request-id` | Calls `GET /api/v3/`, `GET {repo}`, unknown route, and `GET {repo}` without a token; inspects each reply. | **Every** reply carries a non-empty `X-GitHub-Request-Id` header — success, 404, 401 alike. `sendJson()` generates one (`crypto.randomUUID()`) on every reply unless the caller supplies one. The id is header-only, never stored, so randomness cannot break replay determinism. |
| 5 | `protocol.error-message` | (a) `GET` a never-created repo; (b) `GET {repo}` without a token; (c) `POST …/issues` with an unknown label. | (a) `404` + `{ "message": … }`; (b) `401` + `{ "message": … }`; (c) `422` + `{ "message": … }`. All three: JSON body with a **non-empty string** `message`, `Content-Type: application/json`. Use `sendError(res, status, message)` — never a bare status, never HTML. |

## General wire rules (apply to every REST reply)

- **JSON always.** `Content-Type: application/json; charset=utf-8` on every
  reply, including `204` (no body, `Content-Length: 0`, headers still set)
  and every error. Never `text/html`, never a Node default error page.
- **`X-GitHub-Request-Id`: non-empty on every reply** (see check 4).
  No `X-RateLimit-*` header is required.
- **Error shape:** `{"message": "<string>"}` — a string, non-empty.
  `sendError(res, status, message)` is the only way handlers answer errors.
- **Auth — 401 without a token.** `authCheck(req)`: `Authorization: Bearer
  <non-empty>` is the viewer (store.ts: *any* non-empty Bearer token is
  `adaiversen`, id 1000; no validation against `MAKEFUN_SHOP_TOKEN`).
  Missing header, `Bearer` with an empty token, or a non-Bearer scheme →
  `401 {"message": …}`. This applies to every protected resource
  (`/api/v3/repos/…`, `/api/v3/user/…`, …). Exceptions (starter behaviour,
  not auth-checked): `GET /healthz` and `GET /api/v3/` (the API root).
  Same repo name under another owner is `404`, never `403`.
- **404 JSON for unknown routes.** Any route no handler claims → `404
  {"message": "Not Found"}` via `sendError`, with JSON content type and a
  request id. This includes unknown `/api/v3/…` paths and unknown
  top-level paths (git/GraphQL/MCP have their own surfaces; a REST-shaped
  request to a path they do not claim still gets JSON 404, not HTML).
- **400 for malformed JSON bodies.** `readBody()` + `parseJsonBody()`:
  empty body is ok (`value === undefined`, handler decides if a body was
  required); unparseable JSON → `400 {"message": …}`. A body that exceeds
  `MAX_BODY_BYTES` (10 MiB) is rejected by `readBody()` — handler answers
  400/413 as JSON, never crashes the process.
- **`GET /api/v3/` (API root).** `200` JSON (loose object, e.g.
  `{current_user_url, rate_limit_url}`) **with an `X-OAuth-Scopes` header**
  (starter value: `repo, read:org`). The check only requires the header to
  be present; `sendJson(res, 200, body, {'x-oauth-scopes': 'repo, read:org'})`.
- **Pagination (supporting rule, `repos.pagination`).** List endpoints use
  `paginate(items, query, absoluteCollectionUrl)`: `page` default 1,
  `per_page` default 30, clamped 1–100. When more than one page exists,
  `sendJson` must carry `Link: <url>; rel="next", …` with an **absolute,
  same-origin** `next` URL (`?page=N&per_page=M` preserved); no `Link`
  header on a single page. The suite walks the `next` chain (max 20 pages)
  and requires all 30 seeded repos, no repeats, ≤ `per_page` items/page.

## Helpers (`src/http.ts`) — contract for handlers / app.ts

- `sendJson(res, status, body, headers?)` — the only way to answer.
  Sets JSON content type + request id; `204` sends no body.
- `sendError(res, status, message)` — `sendJson(res, status, {message})`.
- `readBody(req): Promise<Buffer>` — whole body, 10 MiB cap.
- `parseJsonBody(raw): {ok, value?, error?}` — empty body ok/undefined.
- `authCheck(req): boolean` — non-empty `Bearer` token.
- `requestId(): string` — `crypto.randomUUID()`, non-empty.
- `paginate(items, query, baseUrl?): {page, linkHeader}` — see above;
  `query` is `URLSearchParams` or a plain record; `baseUrl` must be the
  absolute collection URL for a same-origin `Link` header.
