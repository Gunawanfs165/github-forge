// src/mcp.ts — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Speaks both protocol eras the rules accept:
//   modern 2026-07-28: `server/discover` (no handshake, no session required)
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`,
//           with an optional Mcp-Session-Id echoed back.
// Every request needs `Authorization: Bearer <non-empty>` (any such token is the
// viewer, adaiversen); without it the answer is HTTP 401. All tools act on the
// same Store the REST surface uses, so an object created over MCP reads back
// over REST with the same id.
//
// Wiring (in app.ts): read the request body into a Buffer, then
//   const handled = await handleMcp(store, req, res, rawBody);
//   if (!handled) { /* fall through to the other routes */ }
// The Store instance must be the same one the REST handlers use.

import { randomUUID } from 'node:crypto';
import { NOW, VIEWER, nodeId, type Issue, type Pull, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const CURRENT_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

// The git author/committer line a merge commit carries (the store's fixed clock).
const GIT_AUTHOR = 'ada iversen <adaiversen@example.invalid> 1739177997 +0000';

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The tool list, one fixed literal: two tools/list calls answer the same list
 * byte for byte (no timestamps, no randomness, deterministic order).
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer (or by owner when given).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; defaults to the viewer.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all; defaults to open.', enum: ['open', 'closed', 'all'] },
        full_name: { type: 'string', description: 'The "owner/repo" full name, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name, as an alternative to owner and repo.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------- small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A JSON-RPC error object. */
function rpcError(code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return error;
}

/** A successful tool result: text JSON plus the structured object. */
function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** A failed tool execution (the call itself succeeded): isError:true. */
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * owner/repo out of a tool's arguments, accepting the suite's synonyms:
 * owner/owner_login, repo/repository, or a "owner/repo" full_name.
 */
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = nonEmptyString(args.owner) ?? nonEmptyString(args.owner_login) ?? nonEmptyString(args.org) ?? '';
  let repo = nonEmptyString(args.repo) ?? nonEmptyString(args.repository) ?? nonEmptyString(args.repository_name) ?? '';
  const full = nonEmptyString(args.full_name) ?? nonEmptyString(args.repo_full_name) ?? '';
  if (full.includes('/')) {
    const [fullOwner, fullRepo] = full.split('/', 2);
    if (owner === '' && fullOwner !== undefined && fullOwner !== '') owner = fullOwner;
    if (repo === '' && fullRepo !== undefined && fullRepo !== '') repo = fullRepo;
  }
  return { owner, repo };
}

/** A pull request number out of the arguments (pull_number, or its synonyms). */
function pullNumberOf(args: Record<string, unknown>): number | null {
  const raw = args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/** The tree a commit points at, or null when the ref has no commit. */
function treeOfCommit(store: Store, r: Repo, sha: string): string | null {
  if (sha === '') return null;
  const obj = r.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const tree = store.parseCommit(obj.data).tree;
  return tree === '' ? null : tree;
}

// ---------------------------------------------------------------- tool implementations

function createRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const name = nonEmptyString(args.name) ?? nonEmptyString(args.repo) ?? nonEmptyString(args.repository);
  if (name === null) return toolErr('Missing required argument: name');
  const owner = nonEmptyString(args.owner) ?? nonEmptyString(args.owner_login) ?? VIEWER.login;
  const description = typeof args.description === 'string' ? args.description : '';
  if (store.getRepo(owner, name) !== undefined) return toolErr(`Repository ${owner}/${name} already exists`);
  const repo = store.createRepo(name, description, owner);
  if (args.private === true) repo.private = true;
  return toolOk(store.repoJson(repo));
}

function getRepo(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = ownerRepoOf(args);
  if (owner === '' || repo === '') return toolErr('Missing required argument: owner and repo');
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolErr(`Repository not found: ${owner}/${repo}`);
  return toolOk(store.repoJson(found));
}

function createIssue(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = ownerRepoOf(args);
  const title = nonEmptyString(args.title);
  if (owner === '' || repo === '' || title === null) return toolErr('Missing required argument: owner, repo and title');
  const r = store.getRepo(owner, repo);
  if (r === undefined) return toolErr(`Repository not found: ${owner}/${repo}`);
  const number = r.nextIssue++;
  const id = store.nextId();
  const issue: Issue = {
    id,
    number,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    labels: [],
    user: store.viewerUser(),
    assignees: [],
    comments: [],
    created_at: NOW,
    updated_at: NOW,
    closed_at: null,
    html_url: `/${owner}/${repo}/issues/${number}`,
    url: `/api/v3/repos/${owner}/${repo}/issues/${number}`,
    comments_url: `/api/v3/repos/${owner}/${repo}/issues/${number}/comments`,
    labels_url: `/api/v3/repos/${owner}/${repo}/issues/${number}/labels{/name}`,
    repository_url: `/api/v3/repos/${owner}/${repo}`,
    node_id: nodeId('Issue', id),
  };
  r.issues.push(issue);
  return toolOk(store.issueJson(r, issue));
}

function listIssues(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = ownerRepoOf(args);
  if (owner === '' || repo === '') return toolErr('Missing required argument: owner and repo');
  const r = store.getRepo(owner, repo);
  if (r === undefined) return toolErr(`Repository not found: ${owner}/${repo}`);
  const state = typeof args.state === 'string' ? args.state : 'open';
  const list = r.issues
    .filter((issue) => (state === 'all' ? true : issue.state === state))
    .map((issue) => store.issueJson(r, issue));
  return toolOk(list);
}

function createPullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = ownerRepoOf(args);
  const title = nonEmptyString(args.title);
  const head = nonEmptyString(args.head) ?? nonEmptyString(args.head_ref) ?? nonEmptyString(args.head_branch);
  const base = nonEmptyString(args.base) ?? nonEmptyString(args.base_ref) ?? nonEmptyString(args.base_branch);
  if (owner === '' || repo === '' || title === null || head === null || base === null) {
    return toolErr('Missing required argument: owner, repo, title, head and base');
  }
  const r = store.getRepo(owner, repo);
  if (r === undefined) return toolErr(`Repository not found: ${owner}/${repo}`);
  const headSha = r.branches.get(head) ?? '';
  const baseSha = r.branches.get(base) ?? '';
  const number = r.nextPull++;
  const id = store.nextId();
  const repoJson = store.repoJson(r);
  const pull: Pull = {
    id,
    number,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    merged: false,
    mergeable: true,
    merge_commit_sha: null,
    head: { ref: head, sha: headSha, label: `${owner}:${head}`, repo: repoJson },
    base: { ref: base, sha: baseSha, label: `${owner}:${base}`, repo: repoJson },
    user: store.viewerUser(),
    created_at: NOW,
    updated_at: NOW,
    closed_at: null,
    merged_at: null,
    html_url: `/${owner}/${repo}/pull/${number}`,
    url: `/api/v3/repos/${owner}/${repo}/pulls/${number}`,
    node_id: nodeId('PullRequest', id),
    _files: [],
    _headTreeOid: treeOfCommit(store, r, headSha),
    _baseTreeOid: treeOfCommit(store, r, baseSha),
  };
  r.pulls.push(pull);
  return toolOk(store.pullJson(r, pull));
}

/**
 * Merge an open pull request the way the REST merge does: one squash commit
 * carrying the head tree onto the base branch, then the pull is closed and
 * merged, so REST reads merged:true.
 */
function mergePullRequest(store: Store, args: Record<string, unknown>): Record<string, unknown> {
  const { owner, repo } = ownerRepoOf(args);
  const number = pullNumberOf(args);
  if (owner === '' || repo === '' || number === null) return toolErr('Missing required argument: owner, repo and pull_number');
  const r = store.getRepo(owner, repo);
  if (r === undefined) return toolErr(`Repository not found: ${owner}/${repo}`);
  const pull = r.pulls.find((p) => p.number === number);
  if (pull === undefined) return toolErr(`Pull request #${number} not found`);
  if (pull.merged || pull.state !== 'open') return toolErr(`Pull request #${number} is already ${pull.merged ? 'merged' : pull.state}`);
  const baseRef = pull.base.ref;
  const headRef = pull.head.ref;
  const baseSha = r.branches.get(baseRef) ?? pull.base.sha ?? '';
  const headSha = r.branches.get(headRef) ?? pull.head.sha ?? '';
  let treeOid = treeOfCommit(store, r, headSha);
  if (treeOid === null) treeOid = store.buildTree(r, new Map());
  const parents = baseSha === '' ? '' : `parent ${baseSha}\n`;
  const message = `${pull.title} (#${pull.number})`;
  const commitText = `tree ${treeOid}\n${parents}author ${GIT_AUTHOR}\ncommitter ${GIT_AUTHOR}\n\n${message}\n`;
  const mergeOid = store.putObject(r, 'commit', Buffer.from(commitText, 'utf8'));
  r.branches.set(baseRef, mergeOid);
  r.refs.set(`refs/heads/${baseRef}`, mergeOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = NOW;
  pull.closed_at = NOW;
  pull.merge_commit_sha = mergeOid;
  pull.updated_at = NOW;
  pull.base.sha = mergeOid;
  return toolOk(store.pullJson(r, pull));
}

// ---------------------------------------------------------------- JSON-RPC dispatch

/** Which required arguments a tools/call is missing, for the -32602 error. */
function missingRequired(tool: string, args: Record<string, unknown>): string[] {
  const { owner, repo } = ownerRepoOf(args);
  switch (tool) {
    case 'create_repo': {
      const name = nonEmptyString(args.name) ?? nonEmptyString(args.repo) ?? nonEmptyString(args.repository);
      return name === null ? ['name'] : [];
    }
    case 'get_repo':
    case 'list_issues':
      return [...(owner === '' ? ['owner'] : []), ...(repo === '' ? ['repo'] : [])];
    case 'create_issue':
      return [...(owner === '' ? ['owner'] : []), ...(repo === '' ? ['repo'] : []), ...(nonEmptyString(args.title) === null ? ['title'] : [])];
    case 'create_pull_request': {
      const head = nonEmptyString(args.head) ?? nonEmptyString(args.head_ref);
      const base = nonEmptyString(args.base) ?? nonEmptyString(args.base_ref);
      return [
        ...(owner === '' ? ['owner'] : []),
        ...(repo === '' ? ['repo'] : []),
        ...(nonEmptyString(args.title) === null ? ['title'] : []),
        ...(head === null ? ['head'] : []),
        ...(base === null ? ['base'] : []),
      ];
    }
    case 'merge_pull_request':
      return [...(owner === '' ? ['owner'] : []), ...(repo === '' ? ['repo'] : []), ...(pullNumberOf(args) === null ? ['pull_number'] : [])];
    default:
      return [];
  }
}

const KNOWN_TOOLS = new Set(TOOLS.map((tool) => tool.name));

/** Run one tools/call; returns { result } or { error } (a JSON-RPC error object). */
function callTool(store: Store, params: Record<string, unknown>): { result?: unknown; error?: Record<string, unknown> } {
  const name = params.name;
  if (typeof name !== 'string' || name === '') {
    return { error: rpcError(JSON_RPC_INVALID_PARAMS, 'tools/call needs a tool name') };
  }
  if (!KNOWN_TOOLS.has(name)) {
    return { error: rpcError(JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`) };
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const missing = missingRequired(name, args);
  if (missing.length > 0) {
    return { error: rpcError(JSON_RPC_INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`) };
  }
  let result: Record<string, unknown>;
  switch (name) {
    case 'create_repo':
      result = createRepo(store, args);
      break;
    case 'get_repo':
      result = getRepo(store, args);
      break;
    case 'create_issue':
      result = createIssue(store, args);
      break;
    case 'list_issues':
      result = listIssues(store, args);
      break;
    case 'create_pull_request':
      result = createPullRequest(store, args);
      break;
    case 'merge_pull_request':
      result = mergePullRequest(store, args);
      break;
    default:
      return { error: rpcError(JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`) };
  }
  return { result };
}

function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/** The initialize answer: echo the revision the client offered when it is one we speak. */
function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : CURRENT_REVISION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

/** Answer one JSON-RPC request object; returns null for a notification (no reply body). */
function dispatch(store: Store, message: Record<string, unknown>): { id: unknown; result?: unknown; error?: Record<string, unknown> } | null {
  const method = message.method;
  const id = message.id;
  // A message without an id is a notification: no reply (notifications/initialized).
  if (id === undefined || (typeof method === 'string' && method.startsWith('notifications/'))) return null;
  if (typeof method !== 'string' || method === '') {
    return { id: id ?? null, error: rpcError(JSON_RPC_INVALID_REQUEST, 'Invalid Request: a method name is required') };
  }
  const params = isRecord(message.params) ? message.params : {};
  switch (method) {
    case 'server/discover':
      return { id, result: discoverResult() };
    case 'initialize':
      return { id, result: initializeResult(params) };
    case 'ping':
      return { id, result: {} };
    case 'tools/list':
      return { id, result: { tools: TOOLS } };
    case 'tools/call': {
      const outcome = callTool(store, params);
      if (outcome.error !== undefined) return { id, error: outcome.error };
      return { id, result: outcome.result };
    }
    default:
      return { id, error: rpcError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`) };
  }
}

// ---------------------------------------------------------------- HTTP plumbing

function pathOf(req: any): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The session id for this response: the client's, echoed, or a fresh one. */
function sessionIdOf(req: any): string {
  const header = req.headers?.['mcp-session-id'];
  if (typeof header === 'string' && header !== '') return header;
  return randomUUID();
}

function sendJson(res: any, status: number, body: unknown, sessionId: string): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'mcp-session-id': sessionId,
  });
  res.end(text);
}

function sendRpc(res: any, status: number, id: unknown, result: unknown, sessionId: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, result }, sessionId);
}

function sendRpcError(res: any, status: number, id: unknown, code: number, message: string, sessionId: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }, sessionId);
}

/**
 * Handle one HTTP request aimed at /mcp. Returns true when the path is /mcp
 * (the response is then sent), false otherwise (the caller routes elsewhere).
 * Stateless per request apart from the shared Store: two concurrent tools/call
 * requests keep their own JSON-RPC ids and answer for their own arguments.
 */
export async function handleMcp(store: Store, req: any, res: any, rawBody: Buffer): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  const sessionId = sessionIdOf(req);
  const method = req.method ?? 'GET';

  // A legacy session close: DELETE with the session id, best-effort.
  if (method === 'DELETE') {
    const auth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
    if (!/^Bearer \S+$/.test(auth)) {
      sendJson(res, 401, { message: 'Requires authentication' }, sessionId);
      return true;
    }
    res.writeHead(204, { 'mcp-session-id': sessionId });
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, sessionId);
    return true;
  }

  // Auth first: any non-empty Bearer token is the viewer; missing/empty is 401.
  const auth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
  if (!/^Bearer \S+$/.test(auth)) {
    sendJson(res, 401, { message: 'Requires authentication' }, sessionId);
    return true;
  }

  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  let message: unknown;
  try {
    message = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendRpcError(res, 400, null, JSON_RPC_PARSE_ERROR, 'Parse error', sessionId);
    return true;
  }
  if (!isRecord(message)) {
    sendRpcError(res, 400, null, JSON_RPC_INVALID_REQUEST, 'Invalid Request: a JSON-RPC object is required', sessionId);
    return true;
  }

  const answer = dispatch(store, message);
  if (answer === null) {
    // A notification (notifications/initialized): 202, no body.
    res.writeHead(202, { 'mcp-session-id': sessionId });
    res.end();
    return true;
  }
  if (answer.error !== undefined) {
    sendRpcError(res, 200, answer.id ?? null, (answer.error as Record<string, unknown>).code as number, (answer.error as Record<string, unknown>).message as string, sessionId);
    return true;
  }
  // Plain JSON answers (the client sends Accept: application/json,
  // text/event-stream and reads either); SSE is not needed for one response.
  sendRpc(res, 200, answer.id ?? null, answer.result, sessionId);
  return true;
}
