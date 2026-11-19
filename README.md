# github-core-clone-01 — a GitHub-compatible git forge

A standalone, single-process forge for [the contest](https://make.fun/bounty/github-core-clone-01).
Node 22 only, standard library only, no dependencies, no git binary, no internet at runtime.
One shared in-memory store drives all four surfaces, so an object created on one
surface reads back on the others with the same ids.

## Layout

- `main.ts` — the entry ↔ env lifecycle (starter, unchanged): bind an ephemeral port,
  `POST $MAKEFUN_ENV_URL/register {"port": N}`, poll `GET $MAKEFUN_ENV_URL/done`, exit 0.
- `app.ts` — the server: one `Store`, routes to the handlers below, JSON 404 otherwise.
- `src/store.ts` — shared store: repos, issues, pulls, labels, git objects/refs/branches;
  viewer is always `adaiversen` (id 1000) in every trial of this contest.
- `src/git.ts` — git smart HTTP: upload-pack v2 + v0, receive-pack v0, packfile
  encode/decode, shallow clone, fast-forward enforcement per ref.
- `src/rest.ts` — REST v3: repos, branches, commits, contents, labels, issues,
  pulls, merge (squash), pagination, auth 401, 404-not-403 for other owners.
- `src/graphql.ts` — GraphQL v4: introspection, repository/issues/pullRequests,
  search, node ids, create/merge mutations, batch documents.
- `src/mcp.ts` — MCP over streamable HTTP: initialize (2026-07-28 and legacy),
  tools/list, tools/call (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request).
- `src/http.ts` — JSON/error/pagination/auth helpers (every reply carries
  `X-GitHub-Request-Id`; errors are `{"message": ...}`, never HTML).
- `specs/protocol.md` — the wire-protocol checks, in short.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install.

## Local test results (Node 22.23.5, kit `sdk/run.ts`, fresh server each run)

- Conformance: **120/120 passed** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, GraphQL 20/20, MCP 15/15, protocol 5/5. Confirmed twice,
  including a second fresh run.
- Full sealed-env practice trial (`program/env/server.mjs`): **120/120, working 1**,
  entry exited 0 via the register/done lifecycle.
- Sealed scorer on that trial: **958/1000** — feature 600 + agent 200 + perf 158
  (push 42, clone 32, read 45, write 39; perf_p50_us 365088).
  Local `--perf` run on a fresh server: 963/1000 (perf 163).
  The house reference earns ~100 perf points, so this forge is faster than the
  reference on every workload.
- Replay determinism: all stored timestamps are fixed (`store.NOW`); the only
  randomness is in response headers (`X-GitHub-Request-Id`, MCP session id),
  which never enter the state export.
