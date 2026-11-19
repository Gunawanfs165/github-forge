// git smart HTTP: protocol v2 upload-pack, v0 upload-pack and v0 receive-pack.
//
// Serves /{owner}/{repo}.git/... against the shared Store. No git binary, no
// dependencies beyond node:crypto / node:zlib. Objects are stored loose in
// Repo.objects; refs live in Repo.refs (+ Repo.branches for refs/heads/*).
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v2 when the
//        Git-Protocol: version=2 header is present, else v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0 only)
//   POST /{owner}/{repo}.git/git-upload-pack   (v2 ls-refs / fetch, or v0
//        want/have/done when no version=2 header is sent)
//   POST /{owner}/{repo}.git/git-receive-pack  (v0, report-status, side-band-64k)
//
// A push never creates a repository: a missing repo is 404 JSON. Every ref
// update must fast-forward; a refused ref is reported per-ref as
// "ng <ref> non-fast-forward" while the other refs in the same push still apply.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, Repo, Store } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-forge/1.0';
const PKT_LINE_MAX = 65520;
/** Largest pack chunk inside one sideband pkt-line: 65520 - 4 (length) - 1 (band). */
const SIDEBAND_CHUNK = 65515;
const HEX40 = /^[0-9a-f]{40}$/;

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX - 4}-byte maximum`);
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Sequential pkt-line reader over a complete buffer; `rest()` is the raw tail after the first flush. */
class PktReader {
  private off = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get offset(): number {
    return this.off;
  }

  rest(): Buffer {
    return this.buf.subarray(this.off);
  }

  next(): Pkt | null {
    if (this.off === this.buf.length) return null;
    if (this.off + 4 > this.buf.length) throw new Error(`truncated pkt-line: ${this.buf.length - this.off} trailing byte(s)`);
    const head = this.buf.subarray(this.off, this.off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      this.off += 4;
      return { kind: 'flush' };
    }
    if (len === 1) {
      this.off += 4;
      return { kind: 'delim' };
    }
    if (len === 2) {
      this.off += 4;
      return { kind: 'response-end' };
    }
    if (len === 3 || len > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (this.off + len > this.buf.length) throw new Error(`truncated pkt-line: ${len} announced, ${this.buf.length - this.off} available`);
    const payload = this.buf.subarray(this.off + 4, this.off + len);
    this.off += len;
    return { kind: 'data', payload };
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

function sendJson(res: any, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBytes(res: any, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------
// object model helpers
// ---------------------------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(off, sp).toString('utf8'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** The target of an annotated tag object, or null. */
function tagTarget(data: Buffer): string | null {
  const m = data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
  return m ? m[1] : null;
}

/** Follow a tag chain to the first non-tag object id, or null when it cannot be followed. */
function peelToNonTag(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type !== 'tag') return cur;
    if (seen.has(cur)) return null;
    seen.add(cur);
    const next = tagTarget(obj.data);
    if (!next) return null;
    cur = next;
  }
}

interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
}

/** Every ref, sorted by name, with the peeled target for annotated tags. */
function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const info: RefInfo = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToNonTag(repo, oid);
      if (peeled && peeled !== oid) info.peeled = peeled;
    }
    out.push(info);
  }
  return out;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.default_branch}`;
}

function headOid(repo: Repo): string {
  return repo.refs.get(headTarget(repo)) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// fetch planning: which commits / objects to send, and the shallow boundary
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  /** The client sent `done`: negotiation is over, so (like git) no acknowledgments section. */
  done?: boolean;
  /** `deepen-relative`: the deepen value counts from the client's current shallow boundary. */
  deepenRelative?: boolean;
  /** `include-tag`: also send tag objects pointing at the commits being sent. */
  includeTag?: boolean;
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  error?: string;
}

/**
 * Every object the client already holds: the full closure of its haves, except that traversal
 * never crosses one of its shallow boundary commits (their parents are not held).
 */
function haveClosure(store: Store, repo: Repo, haves: readonly string[], oldShallow: ReadonlySet<string>): Set<string> {
  const set = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || set.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    set.add(oid);
    if (obj.type === 'commit') {
      const commit = store.parseCommit(obj.data);
      stack.push(commit.tree);
      if (!oldShallow.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target) stack.push(target);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    }
  }
  return set;
}

/** The objects of the selected commits (commit -> tree -> blobs), plus extras, minus held objects. */
function collectPackObjects(
  store: Store,
  repo: Repo,
  commits: ReadonlySet<string>,
  extra: readonly string[],
  exclude: ReadonlySet<string>,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const seen = new Set<string>();
  const stack = [...commits, ...extra];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || seen.has(oid) || exclude.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') stack.push(store.parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target) stack.push(target);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    }
  }
  return out;
}

function planFetch(store: Store, repo: Repo, args: FetchArgs): FetchPlan {
  const oldShallow = new Set(args.shallow);
  const empty: FetchPlan = { objects: new Map(), shallow: [], unshallow: [] };

  // Resolve the wants to seed commits; tag wants also contribute the tag object itself.
  const seeds: string[] = [];
  const extra: string[] = [];
  for (const want of args.wants) {
    const obj = repo.objects.get(want);
    if (!obj) return { ...empty, error: `object ${want} not found` };
    if (obj.type === 'commit') seeds.push(want);
    else if (obj.type === 'tag') {
      extra.push(want);
      const peeled = peelToNonTag(repo, want);
      if (peeled) {
        const target = repo.objects.get(peeled);
        if (target?.type === 'commit') seeds.push(peeled);
        else if (target) extra.push(peeled);
      }
    } else extra.push(want);
  }

  const haveSet = haveClosure(store, repo, args.haves, oldShallow);

  // BFS levels (minimum edge distance) from the seeds over the whole commit graph.
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seeds) {
    if (!level.has(seed)) {
      level.set(seed, 0);
      queue.push(seed);
    }
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const oid = queue[qi];
    const lv = level.get(oid)!;
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    for (const parent of store.parseCommit(obj.data).parents) {
      if (!level.has(parent)) {
        level.set(parent, lv + 1);
        queue.push(parent);
      }
    }
  }

  const depth = args.depth;
  // `deepen-relative N` counts from the client's current shallow boundary: the new absolute
  // depth is the old boundary's depth plus N (deepest old boundary wins when there are several).
  let effectiveDepth = depth;
  if (args.deepenRelative && depth !== undefined && oldShallow.size) {
    let deepest = -1;
    for (const s of oldShallow) {
      const lv = level.get(s);
      if (lv !== undefined) deepest = Math.max(deepest, lv + 1 + depth);
    }
    if (deepest >= 0) effectiveDepth = deepest;
  }
  const included = new Set<string>();
  for (const [oid, lv] of level) {
    if (haveSet.has(oid)) continue;
    if (effectiveDepth !== undefined && lv >= effectiveDepth) continue;
    included.add(oid);
  }

  // The new shallow boundary: the commits at exactly the requested depth.
  const boundary = new Set<string>();
  if (effectiveDepth !== undefined) {
    for (const [oid, lv] of level) if (lv === effectiveDepth - 1) boundary.add(oid);
  }
  // An old boundary commit stops being shallow once it is an ancestor of a want within the
  // requested depth, is not itself on the new boundary, and every parent is now held or sent.
  const covered = new Set<string>([...included, ...haveSet]);
  const unshallow = new Set<string>();
  for (const s of oldShallow) {
    if (!level.has(s)) continue;
    if (effectiveDepth !== undefined && level.get(s)! >= effectiveDepth) continue;
    if (boundary.has(s)) continue;
    const obj = repo.objects.get(s);
    if (obj?.type !== 'commit') continue;
    if (store.parseCommit(obj.data).parents.every((parent) => covered.has(parent))) unshallow.add(s);
  }
  const shallow = effectiveDepth !== undefined ? [...boundary] : [...oldShallow].filter((s) => !unshallow.has(s));

  // `include-tag`: tag objects pointing at a commit being sent travel with the pack.
  if (args.includeTag) {
    for (const [name, oid] of repo.refs) {
      if (!name.startsWith('refs/tags/')) continue;
      if (extra.includes(oid) || haveSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj?.type !== 'tag') continue;
      const peeled = peelToNonTag(repo, oid);
      if (peeled && included.has(peeled)) extra.push(oid);
    }
  }

  return {
    objects: collectPackObjects(store, repo, included, extra, haveSet),
    shallow: shallow.sort(),
    unshallow: [...unshallow].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// packfile write / read
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A pack v2 of plain objects (no deltas), sorted by id for determinism, with a valid trailer. */
function buildPack(objects: ReadonlyMap<string, GitObject>): Buffer {
  const list = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const [, obj] of list) {
    parts.push(packObjectHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split pack bytes into side-band-64k pkt-lines (band 1). */
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { value: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next: offset };
}

function inflateAt(buf: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a pack v2/v3, resolve OFS_DELTA and REF_DELTA (thin-pack bases come from `resolveBase`),
 * verify the trailer checksum and every declared size. Returns oid -> object; each oid is
 * recomputed from the resolved type and bytes, so a corrupt object cannot pass as its id.
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolvedData?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.value <= 0 || base.value > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.value}`);
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolvedData && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolvedData, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const oid = createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
    entry.resolvedData = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function parseCapabilityList(text: string): Map<string, string> {
  const caps = new Map<string, string>();
  for (const token of text.split(' ')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq < 0) caps.set(token, '');
    else caps.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return caps;
}

function parseLsRefsArgs(lines: readonly string[]): { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } {
  const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line === 'done') args.done = true;
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line === 'include-tag') args.includeTag = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const refs = listRefs(repo);
  const lines: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(pkt(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  } else {
    if (keep('HEAD')) {
      lines.push(pkt(`${headOid(repo)} HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(pkt(`${line}\n`));
    }
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

function v2FetchResponse(store: Store, repo: Repo, args: FetchArgs, plan: FetchPlan): Buffer {
  const pack = buildPack(plan.objects);
  // Sections are delim-separated; only the final section ends with a flush.
  // The acknowledgments section appears only when the client sent haves and has not said
  // `done` yet: ACK each have the server holds plus `ready`, then the pack follows in the
  // same response. With no held have the answer is NAK and the response ends there.
  const parts: Buffer[] = [];
  if (!args.done && args.haves.length > 0) {
    const held = args.haves.filter((oid) => repo.objects.has(oid));
    parts.push(pkt('acknowledgments\n'));
    if (held.length === 0) {
      parts.push(pkt('NAK\n'), FLUSH);
      return Buffer.concat(parts);
    }
    for (const oid of held) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'), DELIM);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'), sideband(pack), FLUSH);
  return Buffer.concat(parts);
}

function v2FetchError(message: string): Buffer {
  return Buffer.concat([
    pkt('packfile\n'),
    pkt(Buffer.concat([Buffer.from([3]), Buffer.from(`${message}\n`, 'utf8')])),
    FLUSH,
  ]);
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v0FetchError(message: string): Buffer {
  return Buffer.concat([
    pkt(Buffer.concat([Buffer.from([3]), Buffer.from(`${message}\n`, 'utf8')])),
    FLUSH,
  ]);
}

function handleUploadPack(store: Store, req: any, res: any, repo: Repo, rawBody: Buffer): void {
  // v2 when the header says so, or when the body opens with a `command=` pkt-line.
  let isV2 = req.headers?.['git-protocol'] === 'version=2';
  if (!isV2 && rawBody.length >= 4) {
    const head = rawBody.subarray(0, 4).toString('ascii');
    if (/^[0-9a-fA-F]{4}$/.test(head)) {
      const len = Number.parseInt(head, 16);
      if (len > 4 && len <= rawBody.length && rawBody.subarray(4, len).toString('utf8').startsWith('command=')) isV2 = true;
    }
  }

  if (isV2) {
    const reader = new PktReader(rawBody);
    const lines: string[] = [];
    let command = '';
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      if (text.startsWith('command=')) command = text.slice('command='.length).replace(/\n$/, '').trim();
      else lines.push(text);
    }
    if (command === 'ls-refs') {
      sendBytes(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, parseLsRefsArgs(lines)));
    } else if (command === 'fetch') {
      const fetchArgs = parseFetchArgs(lines);
      const plan = planFetch(store, repo, fetchArgs);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', plan.error ? v2FetchError(plan.error) : v2FetchResponse(store, repo, fetchArgs, plan));
    } else {
      sendJson(res, 400, { message: `unknown upload-pack command ${JSON.stringify(command)}` });
    }
    return;
  }

  // v0: wants (+ shallow/deepen) up to the first flush, then haves + done up to the next flush.
  const reader = new PktReader(rawBody);
  const section1: string[] = [];
  const section2: string[] = [];
  let inSection2 = false;
  let sawFlush = false;
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      if (!inSection2) {
        inSection2 = true;
        sawFlush = true;
      } else break;
      continue;
    }
    if (packet.kind !== 'data') continue;
    (inSection2 ? section2 : section1).push(packet.payload.toString('utf8'));
  }
  if (!sawFlush) {
    sendJson(res, 400, { message: 'malformed upload-pack request: no flush after the want list' });
    return;
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const raw of section1) {
    const parts = raw.replace(/\n$/, '').split(' ');
    if (parts[0] === 'want' && parts[1]) args.wants.push(parts[1]);
    else if (parts[0] === 'shallow' && parts[1]) args.shallow.push(parts[1]);
    else if (parts[0] === 'deepen') {
      const n = Number.parseInt(parts[1] ?? '', 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  for (const raw of section2) {
    const parts = raw.replace(/\n$/, '').split(' ');
    if (parts[0] === 'have' && parts[1]) args.haves.push(parts[1]);
  }
  const plan = planFetch(store, repo, args);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', plan.error ? v0FetchError(plan.error) : v0FetchResponse(plan));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyRefUpdate(store: Store, repo: Repo, cmd: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(cmd.ref);
  const setRef = (oid: string): void => {
    repo.refs.set(cmd.ref, oid);
    if (cmd.ref.startsWith('refs/heads/')) repo.branches.set(cmd.ref.slice('refs/heads/'.length), oid);
  };
  const deleteRef = (): void => {
    repo.refs.delete(cmd.ref);
    if (cmd.ref.startsWith('refs/heads/')) repo.branches.delete(cmd.ref.slice('refs/heads/'.length));
  };

  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    deleteRef();
    return { ok: true, reason: '' };
  }
  if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
  if (current === undefined) {
    // Create.
    if (cmd.oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    setRef(cmd.newOid);
    return { ok: true, reason: '' };
  }
  // Update: the old value must match, and the new tip must descend from the current one.
  if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.newOid === current) return { ok: true, reason: '' };
  if (!store.isAncestor(repo, current, cmd.newOid)) return { ok: false, reason: 'non-fast-forward' };
  setRef(cmd.newOid);
  return { ok: true, reason: '' };
}

function handleReceivePack(store: Store, req: any, res: any, repo: Repo, rawBody: Buffer): void {
  const reader = new PktReader(rawBody);
  const commands: PushCommand[] = [];
  let capabilities = new Map<string, string>();
  let sawFlush = false;
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = parseCapabilityList(text.slice(nul + 1).replace(/\n$/, ''));
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !HEX40.test(parts[0]) || !HEX40.test(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (!sawFlush || commands.length === 0) {
    sendJson(res, 400, { message: 'malformed receive-pack request: no command list' });
    return;
  }
  const packBytes = reader.rest();

  // Unpack first: objects land in the store even when a ref update is refused.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const obj of objects.values()) store.putObject(repo, obj.type, obj.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const verdict = applyRefUpdate(store, repo, cmd);
      reportLines.push(verdict.ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${verdict.reason}\n`);
    }
  }

  let body: Buffer;
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    for (const line of reportLines) parts.push(pkt(Buffer.concat([Buffer.from([1]), pkt(line)])));
    // The report-status stream inside band 1 is itself pkt-line framed and flush-terminated:
    // the reader stops at this inner flush. The bare flush below ends the sideband stream.
    parts.push(pkt(Buffer.concat([Buffer.from([1]), FLUSH])));
    parts.push(FLUSH);
    body = Buffer.concat(parts);
  } else {
    body = Buffer.concat([Buffer.concat(reportLines.map((line) => pkt(line))), FLUSH]);
  }
  sendBytes(res, 200, 'application/x-git-receive-pack-result', body);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export async function handleGit(store: Store, req: any, res: any, rawBody: Buffer): Promise<boolean> {
  let pathname: string;
  let search: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    search = url.searchParams;
  } catch {
    return false;
  }
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (!m) return false;

  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(m[1]);
    repoName = decodeURIComponent(m[2]);
  } catch {
    sendJson(res, 400, { message: 'bad repository path' });
    return true;
  }
  const rest = m[3] ?? '';
  const method = (req.method ?? 'GET').toUpperCase();
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);

  try {
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      // A push cannot invent a repository, and neither service advertises one.
      sendJson(res, 404, { message: `Repository ${owner}/${repoName} not found` });
      return true;
    }
    if (method === 'GET' && rest === '/info/refs') {
      const service = search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: `unknown service ${JSON.stringify(service)}` });
        return true;
      }
      const isV2 = service === 'git-upload-pack' && req.headers?.['git-protocol'] === 'version=2';
      sendBytes(res, 200, `application/x-${service}-advertisement`, isV2 ? v2Advertisement() : v0Advertisement(service, repo));
      return true;
    }
    if (method === 'POST' && rest === '/git-upload-pack') {
      handleUploadPack(store, req, res, repo, body);
      return true;
    }
    if (method === 'POST' && rest === '/git-receive-pack') {
      handleReceivePack(store, req, res, repo, body);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    // A malformed git request must never take the server down with it.
    try {
      if (!res.headersSent) sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
      else res.end();
    } catch {
      // The socket is already gone; nothing left to answer.
    }
    return true;
  }
}
