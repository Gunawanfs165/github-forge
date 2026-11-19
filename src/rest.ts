// REST v3 handler for the forge. Stdlib only, Node 22, no network.
// Serves everything under /api/v3; returns false for any other path so the
// caller can try the git / GraphQL / MCP surfaces. Every reply is JSON with a
// non-empty X-GitHub-Request-Id. Auth: any `Authorization: Bearer <non-empty>`
// is the viewer (adaiversen, id 1000); anything else is 401. A repository
// under any other owner is 404, never 403.
import { createHash } from 'node:crypto';
import { NOW, VIEWER, nodeId, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';

const SCOPES = 'repo, read:org';
const ZERO = '0000000000000000000000000000000000000000';
const GIT_EPOCH = 1739177997; // 2025-02-10T08:19:57Z, matches store.NOW

let requestCounter = 0;

type AnyObj = Record<string, any>;

function reqId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function send(res: any, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': reqId(),
    'x-oauth-scopes': SCOPES,
    ...extra,
  };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body ?? null)}\n`;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function err(res: any, status: number, message: string, extraBody: AnyObj = {}): void {
  send(res, status, { message, ...extraBody });
}

function dec(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parseQuery(req: any): { pathname: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { pathname: u.pathname, query: u.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function authed(req: any): boolean {
  const h = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof h !== 'string') return false;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m !== null && m[1]!.trim().length > 0;
}

function intParam(q: URLSearchParams, name: string, def: number): number {
  const v = q.get(name);
  if (v === null) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** Paginate `items`, send Link + X-Total-Count headers, return the page slice. */
function paginate(req: any, q: URLSearchParams, items: any[]): { page: any[]; headers: Record<string, string> } {
  const total = items.length;
  const perPage = Math.min(100, Math.max(1, intParam(q, 'per_page', 30)));
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pages, Math.max(1, intParam(q, 'page', 1)));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const host = req.headers?.host ? `http://${req.headers.host}` : 'http://localhost';
  const base = new URL(req.url ?? '/', host);
  const linkFor = (p: number): string => {
    const u = new URL(base.toString());
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(p));
    return `<${u.toString()}>`;
  };
  const links: string[] = [];
  if (page < pages) links.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${linkFor(page - 1)}; rel="prev"`);
  if (pages > 1) {
    links.push(`${linkFor(1)}; rel="first"`);
    links.push(`${linkFor(pages)}; rel="last"`);
  }
  const headers: Record<string, string> = { 'x-total-count': String(total) };
  if (links.length > 0) headers.link = links.join(', ');
  return { page: slice, headers };
}

function sendList(res: any, req: any, q: URLSearchParams, items: any[]): void {
  const { page, headers } = paginate(req, q, items);
  send(res, 200, page, headers);
}

// ---- git object helpers -----------------------------------------------------

function commitText(tree: string, parents: string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${VIEWER.login} <${VIEWER.email}> ${GIT_EPOCH} +0000`);
  lines.push(`committer ${VIEWER.login} <${VIEWER.email}> ${GIT_EPOCH} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
}

function makeCommit(store: Store, r: Repo, branch: string, message: string, treeOid: string, parents: string[]): string {
  const oid = store.putObject(r, 'commit', commitText(treeOid, parents, message));
  r.branches.set(branch, oid);
  r.refs.set(`refs/heads/${branch}`, oid);
  r.pushed_at = NOW;
  r.updated_at = NOW;
  return oid;
}

function treeOfCommit(store: Store, r: Repo, commitOid: string): string | null {
  const obj = r.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return store.parseCommit(obj.data).tree;
}

function parseAuthor(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!m) return { name: VIEWER.login, email: VIEWER.email, date: NOW };
  const date = new Date(Number(m[3]) * 1000).toISOString();
  return { name: m[1]!, email: m[2]!, date: Number.isFinite(Date.parse(date)) ? date : NOW };
}

function commitJson(store: Store, r: Repo, sha: string): any {
  const obj = r.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = store.parseCommit(obj.data);
  const author = parseAuthor(c.author);
  const committer = parseAuthor(c.committer);
  return {
    sha,
    node_id: nodeId('Commit', 0) + sha.slice(0, 8),
    commit: {
      author, committer,
      message: c.message.replace(/\n$/, ''),
      tree: { sha: c.tree, url: `/api/v3/repos/${r.full_name}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${r.full_name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `/api/v3/repos/${r.full_name}/git/commits/${sha}`,
    html_url: `/${r.full_name}/commit/${sha}`,
    author: store.viewerUser(),
    committer: store.viewerUser(),
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${r.full_name}/git/commits/${p}`, html_url: `/${r.full_name}/commit/${p}` })),
  };
}

/** Commits reachable from `tip`, tip first, parents after (pre-order DFS). */
function walkCommits(store: Store, r: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (!cur || cur === ZERO || seen.has(cur)) continue;
    const obj = r.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(cur);
    out.push(cur);
    const parents = store.parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

/** Resolve a ref name / sha to a commit oid, or null. */
function resolveCommit(store: Store, r: Repo, ref: string | null | undefined): string | null {
  if (!ref) return r.branches.get(r.default_branch) ?? null;
  const byBranch = r.branches.get(ref);
  if (byBranch) return byBranch;
  const byRef = r.refs.get(ref) ?? r.refs.get(`refs/heads/${ref}`);
  if (byRef) return byRef;
  const obj = r.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  if (obj && obj.type === 'tag') {
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
    if (m) return m[1]!;
  }
  return null;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { additions, deletions };
}

/** Diff base tree -> head tree as pull-file entries. */
function diffFiles(store: Store, r: Repo, baseTree: string | null, headTree: string | null): any[] {
  const base = baseTree ? store.flattenTree(r, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = headTree ? store.flattenTree(r, headTree) : new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: any[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    const oldText = b ? (r.objects.get(b.oid)?.data.toString('utf8') ?? '') : '';
    const newText = h ? (r.objects.get(h.oid)?.data.toString('utf8') ?? '') : '';
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (!b && h) { status = 'added'; additions = countLines(newText); }
    else if (b && !h) { status = 'removed'; deletions = countLines(oldText); }
    else {
      const d = lineDiff(oldText, newText);
      additions = d.additions; deletions = d.deletions;
      if (additions === 0 && deletions === 0) additions = 1;
    }
    out.push({
      sha: h?.oid ?? b!.oid,
      filename: path,
      status,
      additions, deletions,
      changes: additions + deletions,
      blob_url: `/${r.full_name}/blob/${r.branches.get(r.default_branch) ?? ''}/${path}`,
      raw_url: `/${r.full_name}/raw/${r.branches.get(r.default_branch) ?? ''}/${path}`,
      contents_url: `/api/v3/repos/${r.full_name}/contents/${path}`,
      patch: undefined,
    });
  }
  for (const f of out) if (f.patch === undefined) delete f.patch;
  return out;
}

function labelJson(r: Repo, l: Label): any {
  return { id: l.id, node_id: nodeId('Label', l.id), url: l.url, name: l.name, color: l.color, default: false, description: l.description };
}

function findLabel(r: Repo, name: string): Label | undefined {
  return r.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
}

/** Recompute a pull's live head/base shas and mergeability from the store. */
function refreshPull(store: Store, r: Repo, p: Pull): void {
  const headTip = r.branches.get(p.head.ref);
  if (headTip) p.head.sha = headTip;
  const baseTip = r.branches.get(p.base.ref);
  if (baseTip) p.base.sha = baseTip;
  (p as any).mergeable = !pullConflict(store, r, p);
  p.mergeable = (p as any).mergeable;
}

/** True when merging `p` would conflict: head and the current base tip both
 *  changed the same path (relative to the base at PR creation) to different blobs. */
function pullConflict(store: Store, r: Repo, p: Pull): boolean {
  if (p.state !== 'open') return false;
  const baseOrig = (p as any)._baseSha as string | undefined;
  const headTip = r.branches.get(p.head.ref);
  const baseTip = r.branches.get(p.base.ref);
  if (!baseOrig || !headTip || !baseTip) return true;
  if (store.isAncestor(r, headTip, baseTip)) return false; // already contained
  const baseTree = treeOfCommit(store, r, baseOrig);
  const headTree = treeOfCommit(store, r, headTip);
  const curTree = treeOfCommit(store, r, baseTip);
  if (baseTree === null || headTree === null || curTree === null) return true;
  const baseFiles = store.flattenTree(r, baseTree);
  const headFiles = store.flattenTree(r, headTree);
  const curFiles = store.flattenTree(r, curTree);
  const paths = new Set([...headFiles.keys(), ...curFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const c = curFiles.get(path)?.oid ?? null;
    const headChanged = h !== b;
    const baseChanged = c !== b;
    if (headChanged && baseChanged && h !== c) return true;
  }
  return false;
}

function createPullRecord(store: Store, r: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headTip = r.branches.get(head);
  const baseTip = r.branches.get(base);
  if (!headTip || !baseTip) return null;
  const id = store.nextId();
  const number = r.nextPull;
  r.nextPull += 1;
  const headTree = treeOfCommit(store, r, headTip);
  const baseTree = treeOfCommit(store, r, baseTip);
  const p: Pull = {
    id, number, title, body, state: 'open', merged: false, mergeable: true,
    merge_commit_sha: null,
    head: { ref: head, sha: headTip, label: `${r.owner.login}:${head}`, repo: store.repoJson(r) },
    base: { ref: base, sha: baseTip, label: `${r.owner.login}:${base}`, repo: store.repoJson(r) },
    user: store.viewerUser(), created_at: NOW, updated_at: NOW, closed_at: null, merged_at: null,
    html_url: `/${r.full_name}/pull/${number}`, url: `/api/v3/repos/${r.full_name}/pulls/${number}`,
    node_id: nodeId('PullRequest', id),
    _files: diffFiles(store, r, baseTree, headTree),
    _headTreeOid: headTree, _baseTreeOid: baseTree,
  };
  (p as any)._baseSha = baseTip;
  (p as any)._reviews = [];
  r.pulls.push(p);
  return p;
}

// ---- contents helpers -------------------------------------------------------

function contentsCommit(store: Store, r: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
  const tip = r.branches.get(branch);
  const treeOid = tip ? treeOfCommit(store, r, tip) : null;
  const files = treeOid ? store.flattenTree(r, treeOid) : new Map<string, { oid: string; mode: string }>();
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = store.putObject(r, 'blob', content);
    files.set(path, { oid: blobSha, mode: '100644' });
  } else {
    files.delete(path);
  }
  const newTree = store.buildTree(r, files);
  const parents = tip ? [tip] : [];
  const commitSha = makeCommit(store, r, branch, message, newTree, parents);
  return { commitSha, blobSha };
}

function contentsEntries(store: Store, r: Repo, tip: string, dir: string): any[] {
  const treeOid = treeOfCommit(store, r, tip);
  if (!treeOid) return [];
  const flat = store.flattenTree(r, treeOid);
  const prefix = dir === '' ? '' : `${dir}/`;
  const files = new Map<string, any>();
  const dirs = new Set<string>();
  for (const [path, f] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const blob = r.objects.get(f.oid);
      files.set(rest, {
        type: 'file', encoding: 'base64', name: rest, path,
        sha: f.oid, size: blob ? blob.data.length : 0,
        url: `/api/v3/repos/${r.full_name}/contents/${path}`,
        html_url: `/${r.full_name}/blob/${tip}/${path}`,
        download_url: `/${r.full_name}/raw/${tip}/${path}`,
        git_url: `/api/v3/repos/${r.full_name}/git/blobs/${f.oid}`,
      });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  const out: any[] = [];
  for (const d of [...dirs].sort()) {
    out.push({
      type: 'dir', name: d, path: prefix + d, sha: '',
      size: 0, url: `/api/v3/repos/${r.full_name}/contents/${prefix}${d}`,
      html_url: `/${r.full_name}/tree/${tip}/${prefix}${d}`,
      git_url: '',
    });
  }
  for (const name of [...files.keys()].sort()) out.push(files.get(name));
  return out;
}

// ---- main handler -----------------------------------------------------------

export async function handleRest(store: Store, req: any, res: any, rawBody: Buffer): Promise<boolean> {
  const { pathname, query } = parseQuery(req);
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const segs = pathname.split('/').filter((s) => s.length > 0).slice(2).map(dec); // after /api/v3

  // Auth: every /api/v3 request needs a non-empty Bearer token.
  if (!authed(req)) {
    err(res, 401, 'Requires authentication');
    return true;
  }

  // Parse a JSON body when one was sent; malformed JSON is 400.
  let body: AnyObj = {};
  let hasBody = false;
  if (rawBody && rawBody.length > 0) {
    hasBody = true;
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      body = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
      if (Array.isArray(parsed)) body = { _array: parsed } as AnyObj;
    } catch {
      err(res, 400, 'Problems parsing JSON');
      return true;
    }
  }
  void hasBody;

  const viewer = store.viewerUser();

  const getRepoOr404 = (owner: string, name: string): Repo | null => {
    const r = store.getRepo(owner, name);
    if (!r) { err(res, 404, 'Not Found'); return null; }
    return r;
  };

  // GET /api/v3/ and /api/v3
  if (segs.length === 0) {
    if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
    send(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
      notifications_url: '/api/v3/notifications{?since,all,participating}',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    });
    return true;
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
    send(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      git: [],
      web: [],
      api: [],
      pages: [],
      importer: [],
      actions: [],
      packages: [],
      dependabot: [],
    });
    return true;
  }

  // GET /api/v3/rate_limit
  if (segs.length === 1 && segs[0] === 'rate_limit') {
    if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
    send(res, 200, {
      resources: { core: { limit: 5000, remaining: 5000, reset: 1739177997, used: 0 }, search: { limit: 30, remaining: 30, reset: 1739177997, used: 0 }, graphql: { limit: 5000, remaining: 5000, reset: 1739177997, used: 0 } },
      rate: { limit: 5000, remaining: 5000, reset: 1739177997, used: 0 },
    });
    return true;
  }

  // /api/v3/user...
  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
      send(res, 200, viewer);
      return true;
    }
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') {
        const repos = [...store.repos.values()]
          .filter((r) => r.owner.login === VIEWER.login)
          .sort((a, b) => a.id - b.id)
          .map((r) => store.repoJson(r));
        sendList(res, req, query, repos);
        return true;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) { err(res, 422, 'Validation Failed', { errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] }); return true; }
        if (store.getRepo(VIEWER.login, name)) {
          err(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
          return true;
        }
        const repo = store.createRepo(name, typeof body.description === 'string' ? body.description : '', VIEWER.login);
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch) repo.default_branch = body.default_branch;
        send(res, 201, store.repoJson(repo));
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  // /api/v3/users/{login}
  if (segs[0] === 'users' && segs.length === 2) {
    if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
    if (segs[1] === VIEWER.login) { send(res, 200, viewer); return true; }
    err(res, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1]!;
    const repoName = segs[2]!;
    const rest = segs.slice(3);
    const repo = getRepoOr404(owner, repoName);
    if (!repo) return true;

    // Repo itself: GET / PATCH / DELETE
    if (rest.length === 0) {
      if (method === 'GET') { send(res, 200, store.repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch && repo.branches.has(body.default_branch)) repo.default_branch = body.default_branch;
        if (typeof body.name === 'string' && body.name.trim() && body.name !== repo.name) {
          const newName = body.name.trim();
          if (store.getRepo(owner, newName)) { err(res, 422, 'Repository name already exists'); return true; }
          store.repos.delete(`${owner}/${repo.name}`);
          repo.name = newName;
          repo.full_name = `${owner}/${newName}`;
          repo.html_url = `/${owner}/${newName}`;
          repo.url = `/api/v3/repos/${owner}/${newName}`;
          repo.clone_url = `/${owner}/${newName}.git`;
          repo.git_url = `/${owner}/${newName}.git`;
          store.repos.set(`${owner}/${newName}`, repo);
        }
        repo.updated_at = NOW;
        send(res, 200, store.repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.repos.delete(`${owner}/${repoName}`);
        send(res, 204, null);
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- branches ----
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
        const list = [...repo.branches.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, sha]) => ({
            name,
            commit: { sha, url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
            protected: false,
            protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
            protection_url: `/api/v3/repos/${repo.full_name}/branches/${encodeURIComponent(name)}/protection`,
          }));
        sendList(res, req, query, list);
        return true;
      }
      const branch = rest.slice(1).join('/');
      const sha = repo.branches.get(branch);
      if (method === 'GET') {
        if (!sha) { err(res, 404, 'Branch not found'); return true; }
        send(res, 200, {
          name: branch,
          commit: { sha, url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
          protected: false,
          protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
          protection_url: `/api/v3/repos/${repo.full_name}/branches/${encodeURIComponent(branch)}/protection`,
        });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- commits ----
    if (rest[0] === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
        const tip = resolveCommit(store, repo, query.get('sha') ?? undefined);
        if (!tip) { sendList(res, req, query, []); return true; }
        const list = walkCommits(store, repo, tip)
          .map((sha) => commitJson(store, repo, sha))
          .filter(Boolean);
        sendList(res, req, query, list);
        return true;
      }
      if (rest.length === 2) {
        if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
        const sha = resolveCommit(store, repo, rest[1]) ?? rest[1]!;
        const out = commitJson(store, repo, sha);
        if (!out) { err(res, 404, 'Not Found'); return true; }
        send(res, 200, out);
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- contents ----
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveCommit(store, repo, query.get('ref') ?? undefined);
        if (!tip) { err(res, 404, 'Not Found'); return true; }
        const treeOid = treeOfCommit(store, repo, tip);
        if (!treeOid) { err(res, 404, 'Not Found'); return true; }
        const flat = store.flattenTree(repo, treeOid);
        if (filePath === '') {
          send(res, 200, contentsEntries(store, repo, tip, ''));
          return true;
        }
        const entry = flat.get(filePath);
        if (entry) {
          const blob = repo.objects.get(entry.oid);
          const content = blob ? blob.data.toString('base64') : '';
          send(res, 200, {
            type: 'file', encoding: 'base64', name: filePath.split('/').pop(),
            path: filePath, sha: entry.oid, size: blob ? blob.data.length : 0,
            content,
            url: `/api/v3/repos/${repo.full_name}/contents/${filePath}`,
            html_url: `/${repo.full_name}/blob/${tip}/${filePath}`,
            download_url: `/${repo.full_name}/raw/${tip}/${filePath}`,
            git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${entry.oid}`,
            _links: { self: `/api/v3/repos/${repo.full_name}/contents/${filePath}`, git: `/api/v3/repos/${repo.full_name}/git/blobs/${entry.oid}`, html: `/${repo.full_name}/blob/${tip}/${filePath}` },
          });
          return true;
        }
        // Directory?
        const prefix = `${filePath}/`;
        const isDir = [...flat.keys()].some((p) => p.startsWith(prefix));
        if (isDir) {
          send(res, 200, contentsEntries(store, repo, tip, filePath));
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.default_branch;
        if (repo.branches.size > 0 && !repo.branches.has(branch)) { err(res, 404, 'Branch not found'); return true; }
        const tip = repo.branches.get(branch);
        const treeOid = tip ? treeOfCommit(store, repo, tip) : null;
        const flat = treeOid ? store.flattenTree(repo, treeOid) : new Map();
        const existing = flat.get(filePath);
        if (existing && body.sha && body.sha !== existing.oid) {
          err(res, 409, 'Conflict: sha does not match the current blob');
          return true;
        }
        if (typeof body.content !== 'string') { err(res, 422, 'Validation Failed: content is required'); return true; }
        let contentBuf: Buffer;
        try { contentBuf = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64'); }
        catch { err(res, 422, 'Validation Failed: content must be base64'); return true; }
        const message = typeof body.message === 'string' && body.message ? body.message : `Update ${filePath}`;
        const { commitSha, blobSha } = contentsCommit(store, repo, branch, filePath, contentBuf, message);
        send(res, existing ? 200 : 201, {
          content: {
            name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: contentBuf.length,
            url: `/api/v3/repos/${repo.full_name}/contents/${filePath}`,
            html_url: `/${repo.full_name}/blob/${branch}/${filePath}`,
            git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${blobSha}`,
            download_url: `/${repo.full_name}/raw/${branch}/${filePath}`,
            type: 'file', encoding: 'base64',
          },
          commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.full_name}/git/commits/${commitSha}` },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.default_branch;
        const tip = repo.branches.get(branch);
        if (!tip) { err(res, 404, 'Not Found'); return true; }
        const treeOid = treeOfCommit(store, repo, tip);
        const flat = treeOid ? store.flattenTree(repo, treeOid) : new Map();
        const existing = flat.get(filePath);
        if (!existing) { err(res, 404, 'Not Found'); return true; }
        if (body.sha && body.sha !== existing.oid) { err(res, 409, 'Conflict: sha does not match the current blob'); return true; }
        const message = typeof body.message === 'string' && body.message ? body.message : `Delete ${filePath}`;
        const { commitSha } = contentsCommit(store, repo, branch, filePath, null, message);
        send(res, 200, {
          content: null,
          commit: { sha: commitSha, message, url: `/api/v3/repos/${repo.full_name}/git/commits/${commitSha}` },
        });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- labels ----
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') { sendList(res, req, query, repo.labels.map((l) => labelJson(repo, l))); return true; }
        if (method === 'POST') {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name) { err(res, 422, 'Validation Failed: name is required'); return true; }
          const existing = findLabel(repo, name);
          if (existing) { send(res, 201, labelJson(repo, existing)); return true; } // upsert: defaults already exist
          const id = repo.nextLabelId;
          repo.nextLabelId += 1;
          const label: Label = {
            id, name,
            color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
            description: typeof body.description === 'string' ? body.description : '',
            url: `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(name)}`,
          };
          repo.labels.push(label);
          send(res, 201, labelJson(repo, label));
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      const labelName = rest.slice(1).join('/');
      const label = findLabel(repo, labelName);
      if (method === 'GET') {
        if (!label) { err(res, 404, 'Label does not exist'); return true; }
        send(res, 200, labelJson(repo, label));
        return true;
      }
      if (method === 'PATCH') {
        if (!label) { err(res, 404, 'Label does not exist'); return true; }
        if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
        if (typeof body.description === 'string') label.description = body.description;
        if (typeof body.name === 'string' && body.name.trim()) {
          label.name = body.name.trim();
          label.url = `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`;
        }
        send(res, 200, labelJson(repo, label));
        return true;
      }
      if (method === 'DELETE') {
        if (!label) { err(res, 404, 'Label does not exist'); return true; }
        repo.labels = repo.labels.filter((l) => l !== label);
        send(res, 204, null);
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- issues ----
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = (query.get('state') ?? 'open').toLowerCase();
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const labelsQ = query.get('labels');
          if (labelsQ) {
            const wanted = labelsQ.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            list = list.filter((i) => wanted.every((w) => i.labels.some((l) => l.name.toLowerCase() === w)));
          }
          const sort = (query.get('sort') ?? 'created').toLowerCase();
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          const dir = direction === 'asc' ? 1 : -1;
          if (sort === 'comments') list.sort((a, b) => dir * (a.comments.length - b.comments.length) || dir * (a.number - b.number));
          else list.sort((a, b) => dir * (a.number - b.number));
          sendList(res, req, query, list.map((i) => store.issueJson(repo, i)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (!title) { err(res, 422, 'Validation Failed: title is required'); return true; }
          const rawLabels: any[] = Array.isArray(body.labels) ? body.labels : [];
          const labels: Label[] = [];
          for (const raw of rawLabels) {
            const name = typeof raw === 'string' ? raw : raw?.name;
            if (typeof name !== 'string') continue;
            const found = findLabel(repo, name);
            if (!found) { err(res, 422, `Validation Failed: label "${name}" does not exist`); return true; }
            labels.push(found);
          }
          const id = store.nextId();
          const number = repo.nextIssue;
          repo.nextIssue += 1;
          const issue: Issue = {
            id, number, title, body: typeof body.body === 'string' ? body.body : '',
            state: 'open', labels, user: viewer, assignees: [], comments: [],
            created_at: NOW, updated_at: NOW, closed_at: null,
            html_url: `/${repo.full_name}/issues/${number}`,
            url: `/api/v3/repos/${repo.full_name}/issues/${number}`,
            comments_url: `/api/v3/repos/${repo.full_name}/issues/${number}/comments`,
            labels_url: `/api/v3/repos/${repo.full_name}/issues/${number}/labels`,
            repository_url: `/api/v3/repos/${repo.full_name}`,
            node_id: nodeId('Issue', id),
          };
          repo.issues.push(issue);
          send(res, 201, store.issueJson(repo, issue));
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { err(res, 404, 'Not Found'); return true; }
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) { err(res, 404, 'Not Found'); return true; }
          send(res, 200, store.issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) { err(res, 404, 'Not Found'); return true; }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closed_at = body.state === 'closed' ? NOW : null;
          }
          if (Array.isArray(body.labels)) {
            const labels: Label[] = [];
            for (const raw of body.labels) {
              const name = typeof raw === 'string' ? raw : raw?.name;
              const found = typeof name === 'string' ? findLabel(repo, name) : undefined;
              if (!found) { err(res, 422, `Validation Failed: label "${name}" does not exist`); return true; }
              labels.push(found);
            }
            issue.labels = labels;
          }
          issue.updated_at = NOW;
          send(res, 200, store.issueJson(repo, issue));
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { err(res, 404, 'Not Found'); return true; }
        if (method === 'GET') {
          sendList(res, req, query, [...issue.comments]);
          return true;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          if (!text) { err(res, 422, 'Validation Failed: body is required'); return true; }
          const comment = {
            id: store.nextId(), body: text, user: viewer,
            created_at: NOW, updated_at: NOW,
            html_url: `/${repo.full_name}/issues/${num}#issuecomment-${repo.nextCommentId}`,
            url: `/api/v3/repos/${repo.full_name}/issues/comments/${repo.nextCommentId}`,
          };
          repo.nextCommentId += 1;
          issue.comments.push(comment as any);
          issue.updated_at = NOW;
          send(res, 201, comment);
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- pulls ----
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => a.number - b.number);
          for (const p of list) refreshPull(store, repo, p);
          sendList(res, req, query, list.map((p) => store.pullJson(repo, p)));
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' && body.base ? body.base : repo.default_branch;
          if (!title || !head) { err(res, 422, 'Validation Failed: title and head are required'); return true; }
          if (!repo.branches.has(head)) { err(res, 422, `Validation Failed: head branch "${head}" does not exist`); return true; }
          if (!repo.branches.has(base)) { err(res, 422, `Validation Failed: base branch "${base}" does not exist`); return true; }
          const pull = createPullRecord(store, repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if (!pull) { err(res, 422, 'Validation Failed: could not create pull request'); return true; }
          send(res, 201, store.pullJson(repo, pull));
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { err(res, 404, 'Not Found'); return true; }
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) { err(res, 404, 'Not Found'); return true; }
          refreshPull(store, repo, pull);
          send(res, 200, store.pullJson(repo, pull));
          return true;
        }
        if (method === 'PATCH') {
          if (!pull) { err(res, 404, 'Not Found'); return true; }
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            pull.state = body.state;
            pull.closed_at = body.state === 'closed' ? NOW : null;
          }
          pull.updated_at = NOW;
          refreshPull(store, repo, pull);
          send(res, 200, store.pullJson(repo, pull));
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
        if (!pull) { err(res, 404, 'Not Found'); return true; }
        refreshPull(store, repo, pull);
        const baseTree = (pull as any)._baseTreeOid as string | null;
        const headTree = treeOfCommit(store, repo, pull.head.sha);
        const files = diffFiles(store, repo, baseTree, headTree);
        sendList(res, req, query, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'commits') {
        if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
        if (!pull) { err(res, 404, 'Not Found'); return true; }
        const baseAncestors = store.ancestors(repo, (pull as any)._baseSha ?? pull.base.sha);
        const list = walkCommits(store, repo, pull.head.sha)
          .filter((sha) => !baseAncestors.has(sha))
          .map((sha) => commitJson(store, repo, sha))
          .filter(Boolean);
        sendList(res, req, query, list);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'reviews') {
        if (!pull) { err(res, 404, 'Not Found'); return true; }
        const reviews = (pull as any)._reviews ?? [];
        if (method === 'GET') { sendList(res, req, query, reviews); return true; }
        if (method === 'POST') {
          const review = {
            id: store.nextId(), user: viewer,
            body: typeof body.body === 'string' ? body.body : '',
            state: typeof body.event === 'string' ? body.event : 'COMMENTED',
            submitted_at: NOW, html_url: `/${repo.full_name}/pull/${num}#pullrequestreview-${store.nextId()}`,
            pull_request_url: pull.url, author_association: 'OWNER',
          };
          reviews.push(review);
          (pull as any)._reviews = reviews;
          send(res, 201, review);
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') { err(res, 404, 'Not Found'); return true; }
        if (!pull) { err(res, 404, 'Not Found'); return true; }
        if (pull.state === 'closed') { err(res, 405, 'Pull request is already closed'); return true; }
        refreshPull(store, repo, pull);
        if (!pull.mergeable || pullConflict(store, repo, pull)) {
          err(res, 405, 'Merge conflict: pull request cannot be merged');
          return true;
        }
        const headTip = repo.branches.get(pull.head.ref);
        const baseTip = repo.branches.get(pull.base.ref);
        if (!headTip) { err(res, 405, 'Merge conflict: head branch is missing'); return true; }
        const headTree = treeOfCommit(store, repo, headTip);
        if (!headTree) { err(res, 405, 'Merge conflict: head commit is missing'); return true; }
        const message = pull.title;
        const parents = baseTip ? [baseTip] : [];
        const squashSha = makeCommit(store, repo, pull.base.ref, message, headTree, parents);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergeable = false;
        pull.merge_commit_sha = squashSha;
        pull.merged_at = NOW;
        pull.closed_at = NOW;
        pull.updated_at = NOW;
        pull.base.sha = squashSha;
        send(res, 200, { sha: squashSha, merged: true, message });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- git/refs ----
    if (rest[0] === 'git' && rest[1] === 'refs') {
      const refPath = rest.slice(2).join('/');
      if (refPath === '') {
        if (method === 'GET') {
          const list = [...repo.refs.entries()].map(([ref, sha]) => ({
            ref, node_id: nodeId('Ref', 0) + createHash('sha1').update(ref).digest('hex').slice(0, 8),
            url: `/api/v3/repos/${repo.full_name}/git/refs/${ref}`,
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.full_name}/git/${repo.objects.get(sha)?.type ?? 'commits'}/${sha}` },
          }));
          sendList(res, req, query, list);
          return true;
        }
        if (method === 'POST') {
          const ref = typeof body.ref === 'string' ? body.ref : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (!ref || !sha || !repo.objects.has(sha)) { err(res, 422, 'Validation Failed: ref and sha are required'); return true; }
          if (repo.refs.has(ref)) { err(res, 422, 'Validation Failed: Reference already exists'); return true; }
          repo.refs.set(ref, sha);
          if (ref.startsWith('refs/heads/')) repo.branches.set(ref.slice('refs/heads/'.length), sha);
          send(res, 201, {
            ref, node_id: nodeId('Ref', 0),
            url: `/api/v3/repos/${repo.full_name}/git/refs/${ref}`,
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
          });
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        const sha = repo.refs.get(refPath);
        if (!sha) { err(res, 404, 'Not Found'); return true; }
        send(res, 200, {
          ref: refPath, node_id: nodeId('Ref', 0),
          url: `/api/v3/repos/${repo.full_name}/git/refs/${refPath}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
        });
        return true;
      }
      if (method === 'PATCH') {
        const sha = repo.refs.get(refPath);
        if (!sha) { err(res, 404, 'Not Found'); return true; }
        const newSha = typeof body.sha === 'string' ? body.sha : '';
        if (!newSha || !repo.objects.has(newSha)) { err(res, 422, 'Validation Failed: sha does not exist'); return true; }
        repo.refs.set(refPath, newSha);
        if (refPath.startsWith('refs/heads/')) repo.branches.set(refPath.slice('refs/heads/'.length), newSha);
        send(res, 200, {
          ref: refPath, url: `/api/v3/repos/${repo.full_name}/git/refs/${refPath}`,
          object: { sha: newSha, type: repo.objects.get(newSha)?.type ?? 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${newSha}` },
        });
        return true;
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(refPath)) { err(res, 404, 'Not Found'); return true; }
        repo.refs.delete(refPath);
        if (refPath.startsWith('refs/heads/')) repo.branches.delete(refPath.slice('refs/heads/'.length));
        send(res, 204, null);
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }
    // ---- git/trees ----
    if (rest[0] === 'git' && rest[1] === 'trees') {
      if (rest.length === 2 && method === 'POST') {
        const entries = Array.isArray(body.tree) ? body.tree : [];
        let files = new Map<string, { oid: string; mode: string }>();
        if (typeof body.base_tree === 'string' && body.base_tree) files = store.flattenTree(repo, body.base_tree);
        for (const e of entries) {
          if (typeof e?.path !== 'string') continue;
          if (e.sha === null || e.sha === undefined) { files.delete(e.path); continue; }
          files.set(e.path, { oid: e.sha, mode: typeof e.mode === 'string' ? e.mode : '100644' });
        }
        const sha = store.buildTree(repo, files);
        send(res, 201, {
          sha, url: `/api/v3/repos/${repo.full_name}/git/trees/${sha}`,
          tree: entries.map((e: any) => ({ path: e.path, mode: e.mode ?? '100644', type: e.type ?? 'blob', sha: e.sha, url: `/api/v3/repos/${repo.full_name}/git/blobs/${e.sha}` })),
          truncated: false,
        });
        return true;
      }
      if (rest.length === 3 && method === 'GET') {
        let treeOid = rest[2]!;
        const obj = repo.objects.get(treeOid);
        if (obj?.type === 'commit') treeOid = store.parseCommit(obj.data).tree;
        else if (!obj || obj.type !== 'tree') { err(res, 404, 'Not Found'); return true; }
        const recursive = query.get('recursive') === '1';
        const flat = store.flattenTree(repo, treeOid);
        const tree = [...flat.entries()].map(([path, f]) => {
          const blob = repo.objects.get(f.oid);
          return {
            path, mode: f.mode, type: f.mode === '40000' ? 'tree' : 'blob', sha: f.oid,
            size: f.mode === '40000' ? undefined : (blob ? blob.data.length : 0),
            url: `/api/v3/repos/${repo.full_name}/git/${f.mode === '40000' ? 'trees' : 'blobs'}/${f.oid}`,
          };
        });
        const cleaned = tree.map((t) => { if (t.size === undefined) delete (t as any).size; return t; });
        // Non-recursive: only top-level entries.
        const out = recursive ? cleaned : cleaned.filter((t) => !t.path.includes('/'));
        send(res, 200, { sha: treeOid, url: `/api/v3/repos/${repo.full_name}/git/trees/${treeOid}`, tree: out, truncated: false });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- git/blobs ----
    if (rest[0] === 'git' && rest[1] === 'blobs') {
      if (rest.length === 2 && method === 'POST') {
        const content = typeof body.content === 'string' ? body.content : '';
        const buf = body.encoding === 'base64' ? Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64') : Buffer.from(content, 'utf8');
        const sha = store.putObject(repo, 'blob', buf);
        send(res, 201, { sha, url: `/api/v3/repos/${repo.full_name}/git/blobs/${sha}`, size: buf.length });
        return true;
      }
      if (rest.length === 3 && method === 'GET') {
        const obj = repo.objects.get(rest[2]!);
        if (!obj || obj.type !== 'blob') { err(res, 404, 'Not Found'); return true; }
        send(res, 200, {
          sha: rest[2], size: obj.data.length, encoding: 'base64',
          content: obj.data.toString('base64'),
          url: `/api/v3/repos/${repo.full_name}/git/blobs/${rest[2]}`,
        });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // ---- git/commits ----
    if (rest[0] === 'git' && rest[1] === 'commits') {
      if (rest.length === 2 && method === 'POST') {
        const message = typeof body.message === 'string' ? body.message : '';
        const tree = typeof body.tree === 'string' ? body.tree : '';
        if (!message || !tree || !repo.objects.has(tree)) { err(res, 422, 'Validation Failed: message and tree are required'); return true; }
        const parents = Array.isArray(body.parents) ? body.parents.filter((p: any) => typeof p === 'string') : [];
        const author = body.author && typeof body.author === 'object' ? body.author : {};
        const name = typeof author.name === 'string' ? author.name : VIEWER.login;
        const email = typeof author.email === 'string' ? author.email : VIEWER.email;
        const lines = [`tree ${tree}`];
        for (const p of parents) lines.push(`parent ${p}`);
        lines.push(`author ${name} <${email}> ${GIT_EPOCH} +0000`);
        lines.push(`committer ${name} <${email}> ${GIT_EPOCH} +0000`);
        const sha = store.putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8'));
        send(res, 201, {
          sha, node_id: nodeId('Commit', 0),
          url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}`,
          author: { name, email, date: NOW }, committer: { name, email, date: NOW },
          message, tree: { sha: tree, url: `/api/v3/repos/${repo.full_name}/git/trees/${tree}` },
          parents: parents.map((p: string) => ({ sha: p, url: `/api/v3/repos/${repo.full_name}/git/commits/${p}` })),
          verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        });
        return true;
      }
      if (rest.length === 3 && method === 'GET') {
        const out = commitJson(store, repo, rest[2]!);
        if (!out) { err(res, 404, 'Not Found'); return true; }
        const c = store.parseCommit(repo.objects.get(rest[2]!)!.data);
        const author = parseAuthor(c.author);
        const committer = parseAuthor(c.committer);
        send(res, 200, {
          sha: rest[2], node_id: nodeId('Commit', 0),
          url: `/api/v3/repos/${repo.full_name}/git/commits/${rest[2]}`,
          author, committer, message: c.message.replace(/\n$/, ''),
          tree: { sha: c.tree, url: `/api/v3/repos/${repo.full_name}/git/trees/${c.tree}` },
          parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.full_name}/git/commits/${p}` })),
          verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    err(res, 404, 'Not Found');
    return true;
  }

  // Anything else under /api/v3:
  err(res, 404, 'Not Found');
  return true;
}
