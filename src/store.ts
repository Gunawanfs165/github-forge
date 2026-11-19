// Shared in-memory store for the forge. Single process, no persistence needed:
// the suite drives one trial per process. All handlers (REST, GraphQL, MCP, git)
// share this store so an object created on one surface reads back on the others
// with the same ids.
// Viewer is ALWAYS adaiversen (id 1000) in every trial of this contest
// (kit sdk/conformance/wire.ts buildScenario().viewer.login). Auth: any request
// with `Authorization: Bearer <non-empty>` is the viewer; missing/wrong -> 401.
import { createHash } from 'node:crypto';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User', avatar_url: '', html_url: '/adaiversen' };
export const NOW = '2025-02-10T08:19:57.000Z'; // fixed timestamp for determinism (replay must be byte-identical in state export; created_at values are not in state export, but keep stable anyway)

export function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
export function gitObjectId(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, content]));
}

export interface GitObject { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; }
export interface Label { id: number; name: string; color: string; description: string; url: string; }
export interface IssueComment { id: number; body: string; user: any; created_at: string; updated_at: string; html_url: string; url: string; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: any; assignees: any[]; comments: IssueComment[];
  created_at: string; updated_at: string; closed_at: string | null;
  html_url: string; url: string; comments_url: string; labels_url: string;
  repository_url: string; node_id: string;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergeable: boolean; merge_commit_sha: string | null;
  head: { ref: string; sha: string; label: string; repo: any | null };
  base: { ref: string; sha: string; label: string; repo: any | null };
  user: any; created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null;
  html_url: string; url: string; node_id: string;
  // internal: file list for merge/files, head commit message list
  _files: { filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string }[];
  _headTreeOid: string | null; _baseTreeOid: string | null;
}
export interface Repo {
  id: number; name: string; full_name: string; owner: any; description: string;
  private: boolean; fork: boolean; default_branch: string;
  created_at: string; updated_at: string; pushed_at: string;
  html_url: string; url: string; clone_url: string; git_url: string; ssh_url: string;
  issues: Issue[]; pulls: Pull[]; labels: Label[];
  branches: Map<string, string>; // branch -> commit oid
  refs: Map<string, string>; // full ref -> oid
  objects: Map<string, GitObject>;
  nextIssue: number; nextPull: number; nextLabelId: number; nextCommentId: number;
  // contents commits: keep a flat file view per branch derived from git trees at read time
}

let nextRepoId = 5000;
let nextGlobalId = 100000;

export class Store {
  repos = new Map<string, Repo>(); // key owner/name
  constructor() {}
  nextId(): number { return ++nextGlobalId; }
  viewerUser(): any {
    return { login: VIEWER.login, id: VIEWER.id, node_id: nodeId('User', VIEWER.id), avatar_url: '', gravatar_id: '', url: `/api/v3/users/${VIEWER.login}`, html_url: `/${VIEWER.login}`, type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email };
  }
  createRepo(name: string, description = '', ownerLogin: string = VIEWER.login): Repo {
    const id = ++nextRepoId;
    const owner = ownerLogin === VIEWER.login ? this.viewerUser() : { login: ownerLogin, id: 2000, node_id: nodeId('User', 2000), avatar_url: '', url: `/api/v3/users/${ownerLogin}`, html_url: `/${ownerLogin}`, type: 'User', site_admin: false };
    const repo: Repo = {
      id, name, full_name: `${ownerLogin}/${name}`, owner, description, private: false, fork: false,
      default_branch: 'main', created_at: NOW, updated_at: NOW, pushed_at: NOW,
      html_url: `/${ownerLogin}/${name}`, url: `/api/v3/repos/${ownerLogin}/${name}`,
      clone_url: `/${ownerLogin}/${name}.git`, git_url: `/${ownerLogin}/${name}.git`, ssh_url: `git@github.com:${ownerLogin}/${name}.git`,
      issues: [], pulls: [], labels: [
        { id: 1, name: 'bug', color: 'd73a4a', description: "Something isn't working", url: '' },
        { id: 2, name: 'enhancement', color: 'a2eeef', description: 'New feature or request', url: '' },
        { id: 3, name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation', url: '' },
        { id: 4, name: 'question', color: 'd876e3', description: 'Further information is requested', url: '' },
        { id: 5, name: 'good first issue', color: '7057ff', description: 'Good for newcomers', url: '' },
        { id: 6, name: 'help wanted', color: '008672', description: 'Extra attention is needed', url: '' },
      ],
      branches: new Map(), refs: new Map(), objects: new Map(),
      nextIssue: 1, nextPull: 1, nextLabelId: 100, nextCommentId: 1,
    };
    for (const l of repo.labels) l.url = `/api/v3/repos/${ownerLogin}/${name}/labels/${encodeURIComponent(l.name)}`;
    this.repos.set(`${ownerLogin}/${name}`, repo);
    return repo;
  }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(`${owner}/${name}`); }
  repoJson(r: Repo): any {
    return {
      id: r.id, node_id: nodeId('Repository', r.id), name: r.name, full_name: r.full_name,
      owner: r.owner, private: r.private, html_url: r.html_url, description: r.description,
      fork: r.fork, url: r.url, clone_url: r.clone_url, git_url: r.git_url, ssh_url: r.ssh_url,
      created_at: r.created_at, updated_at: r.updated_at, pushed_at: r.pushed_at,
      default_branch: r.default_branch, has_issues: true, has_projects: true, has_wiki: true,
      has_pages: false, has_downloads: true, archived: false, disabled: false,
      open_issues_count: r.issues.filter((i) => i.state === 'open').length,
      license: null, allow_forking: true, is_template: false, topics: [], visibility: 'public',
      forks: 0, open_issues: r.issues.filter((i) => i.state === 'open').length, watchers: 0,
      language: null, size: 0, stargazers_count: 0, watchers_count: 0, forks_count: 0,
    };
  }
  issueJson(r: Repo, i: Issue): any {
    return {
      id: i.id, node_id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state,
      locked: false, user: i.user, labels: i.labels.map((l) => ({ id: l.id, node_id: nodeId('Label', l.id), url: l.url, name: l.name, color: l.color, default: false, description: l.description })),
      assignees: i.assignees, comments: i.comments.length, created_at: i.created_at, updated_at: i.updated_at,
      closed_at: i.closed_at, author_association: 'OWNER', html_url: i.html_url, url: i.url,
      repository_url: i.repository_url, comments_url: i.comments_url, labels_url: i.labels_url,
    };
  }
  pullJson(r: Repo, p: Pull): any {
    return {
      id: p.id, node_id: p.node_id, number: p.number, title: p.title, body: p.body, state: p.state,
      locked: false, user: p.user, created_at: p.created_at, updated_at: p.updated_at,
      closed_at: p.closed_at, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
      merged: p.merged, mergeable: p.mergeable, mergeable_state: p.mergeable ? 'clean' : 'dirty',
      head: { label: p.head.label, ref: p.head.ref, sha: p.head.sha, user: p.user, repo: p.head.repo },
      base: { label: p.base.label, ref: p.base.ref, sha: p.base.sha, user: p.user, repo: p.base.repo },
      html_url: p.html_url, url: p.url, draft: false, author_association: 'OWNER',
      commits_url: `${p.url}/commits`, review_comments_url: `${p.url}/comments`, comments_url: `${p.url}/comments`,
    };
  }
  // ---- git helpers ----
  putObject(r: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = gitObjectId(type, data);
    if (!r.objects.has(oid)) r.objects.set(oid, { type, data });
    return oid;
  }
  // parse a commit object, return {tree, parents, message, authorLine}
  parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; author: string; committer: string } {
    const text = data.toString('utf8');
    const [head, ...rest] = text.split('\n\n');
    const parents: string[] = []; let tree = ''; let author = ''; let committer = '';
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('committer ')) committer = line.slice(10);
    }
    return { tree, parents, message: rest.join('\n\n'), author, committer };
  }
  // walk ancestors of oid (inclusive), return Set
  ancestors(r: Repo, oid: string): Set<string> {
    const seen = new Set<string>(); const stack = [oid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (!cur || cur === '0000000000000000000000000000000000000000' || seen.has(cur)) continue;
      seen.add(cur);
      const obj = r.objects.get(cur);
      if (obj && obj.type === 'commit') {
        const c = this.parseCommit(obj.data);
        for (const p of c.parents) stack.push(p);
      } else if (obj && obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m) stack.push(m[1]);
      }
    }
    return seen;
  }
  isAncestor(r: Repo, anc: string, desc: string): boolean {
    if (anc === '0000000000000000000000000000000000000000') return true;
    return this.ancestors(r, desc).has(anc);
  }
  // flatten tree oid -> Map path -> {oid, mode}
  flattenTree(r: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = r.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    let off = 0; const data = obj.data;
    while (off < data.length) {
      const sp = data.indexOf(0x20, off);
      const mode = data.subarray(off, sp).toString('utf8');
      const nul = data.indexOf(0x00, sp);
      const name = data.subarray(sp + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode === '40000') this.flattenTree(r, oid, path, out);
      else out.set(path, { oid, mode });
      off = nul + 21;
    }
    return out;
  }
  buildTree(r: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // build nested trees from flat map
    const build = (prefix: string): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Set<string>();
      for (const [path, f] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: f.mode, name: rest, oid: f.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const d of [...dirs].sort()) entries.push({ mode: '40000', name: d, oid: build(prefix + d + '/') });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const parts: Buffer[] = [];
      for (const e of entries) {
        parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
        parts.push(Buffer.from(e.oid, 'hex'));
      }
      return this.putObject(r, 'tree', Buffer.concat(parts));
    };
    return build('');
  }
}

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}
export function decodeNodeId(nodeIdStr: string): { kind: string; id: number } | null {
  try {
    const s = Buffer.from(nodeIdStr, 'base64').toString('utf8');
    const [kind, id] = s.split(':');
    return { kind, id: Number(id) };
  } catch { return null; }
}
export function base64UrlEncode(b: Buffer): string { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
