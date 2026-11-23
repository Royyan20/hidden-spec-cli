// mend — one patch tool for every AI edit format, written to SPEC.md.
//
// The program reads a patch (unified diff, SEARCH/REPLACE blocks, V4A, or
// JSON edits), applies it to the tree of text files in the working directory,
// and writes every change or none. A failed edit is reported on stdout with
// `error: <code> <path>` and the run exits 1; a malformed patch or bad usage
// exits 2. The four formats and the three matching tiers are SPEC sections
// 5 through 9; the command line, output and exit codes are sections 1, 2 and
// 10. Node 22, standard library only; invoked as `node main.ts [options]
// [PATCH]`.
//
// When the grader runs it with MAKEFUN_ENV_URL set, the tail of this file
// hands over to runner.ts; leave that hand-over and runner.ts untouched.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseExit {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file broken into lines, its line break, and whether it ends with one (SPEC section 3). */
interface SplitDoc {
  lines: string[];
  br: string;
  final: boolean;
}
function splitDoc(text: string): SplitDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinDoc(f: SplitDoc): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line as a matching tier sees it (SPEC section 5). */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** Every place O matches F at tier, at or after `from` (matches may overlap). */
function locateAll(o: string[], f: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > f.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= f.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(f[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs in F at or after `from`, or -1. */
function pickTier(o: string[], f: string[], strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (locateAll(o, f, t, from).length > 0) return t;
  }
  return -1;
}

/** One line of a hunk or chunk: context, removed, or added. */
type LineOp = { kind: 'ctx' | 'del' | 'add'; text: string };
function oldSide(ops: LineOp[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}
function newSide(ops: LineOp[]): string[] {
  return ops.filter((o) => o.kind !== 'del').map((o) => o.text);
}
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
/**
 * Replace the lines at `at` (the match of oldSide) with the ops: context
 * lines are written as the file's own matched lines, and at tier 2 the other
 * new lines are re-indented to the match's indent (SPEC section 5).
 */
function spliceOps(f: string[], at: number, ops: LineOp[], tier: number): string[] {
  const o = oldSide(ops);
  const out = f.slice(0, at);
  const reindent = tier === 2 && o.length > 0;
  const find = reindent ? leadWs(f[at] ?? '') : '';
  const pind = reindent ? leadWs(o[0]!) : '';
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(f[at + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else if (reindent && op.text !== '' && op.text.trim() !== '' && op.text.startsWith(pind)) {
      out.push(find + op.text.slice(pind.length));
    } else {
      out.push(op.text);
    }
  }
  out.push(...f.slice(at + o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class WorkTree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order: [old path, new path]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Whether `p` is a directory in the tree as the edits leave it: some file
   * in the effective tree sits under it — one on disk that no earlier edit
   * deleted or moved away, or one an earlier edit created. A directory on
   * disk whose files were all deleted or moved away by earlier edits is NOT a
   * directory in the effective tree (SPEC section 10: edits see the tree as
   * earlier edits left it), so creating a file there must succeed. Creating a
   * file where a directory is must fail with `exists` (SPEC section 2), not
   * crash the write (EISDIR on writeFileSync). */
  isDir(p: string): boolean {
    const prefix = `${p}/`;
    for (const [k, v] of this.now) {
      if (v !== null && k.startsWith(prefix)) return true;
    }
    return this.diskHasFileUnder(p);
  }
  /** Whether a file on disk under `p/` is still in the effective tree: it is
   * not in `now` (so the disk copy stands). A file `now` marks deleted is not
   * in the tree, and a file `now` holds non-null is already caught above. */
  private diskHasFileUnder(p: string): boolean {
    let names: string[];
    try {
      names = readdirSync(p);
    } catch {
      return false;
    }
    for (const name of names) {
      const child = `${p}/${name}`;
      let dir = false;
      let file = false;
      try {
        const st = statSync(child);
        dir = st.isDirectory();
        file = st.isFile();
      } catch {
        continue;
      }
      if (dir) {
        if (this.diskHasFileUnder(child)) return true;
      } else if (file && !this.now.has(child)) {
        return true;
      }
    }
    return false;
  }
  /** Whether one of `p`'s proper ancestors is a file in the tree as the edits
   * leave it (on disk, or created by an earlier edit). Creating a file there
   * must fail with `exists`, not crash the write (ENOTDIR on mkdirSync). */
  blockedByFile(p: string): boolean {
    const parts = p.split('/');
    let q = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      q = q === '' ? parts[i]! : `${q}/${parts[i]!}`;
      if (this.get(q) !== null) return true;
    }
    return false;
  }
  /** Whether a create/move target cannot be written: it is a directory, or one
   * of its ancestors is a file. */
  createBlocked(p: string): boolean {
    return this.isDir(p) || this.blockedByFile(p);
  }
}

type PatchEdit = (tree: WorkTree) => void;

function sniffFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonOne(v: unknown): PatchEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: WorkTree): string => {
    if (!isSafe(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null || tree.createBlocked(p)) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new EditFail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** One hunk of a unified section (SPEC section 6). */
interface DiffHunk {
  a: number;
  ops: LineOp[];
  noEol: boolean;
  plusNoEol: boolean;
  hasPlus: boolean;
}
interface DiffSec {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: DiffHunk[];
  /** True once a `---`/`+++` pair has named the paths (SPEC section 6: rename from/to name them only when no pair does). */
  pairSet: boolean;
}

const hunkAt = (line: string): number | null => {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
};
const hdrPath = (line: string): string => {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
};
const dropAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** Apply a section's hunks, in order, to a file's text (SPEC section 6). */
function runHunks(before: string, hunks: DiffHunk[], strict: boolean, path: string): string {
  const f = splitDoc(before);
  let d = 0;
  for (const h of hunks) {
    const o = oldSide(h.ops);
    if (o.length === 0) {
      const ins = newSide(h.ops);
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !h.noEol;
      d += ins.length;
      continue;
    }
    const tier = pickTier(o, f.lines, strict, 0);
    if (tier < 0) throw new EditFail('no-match', path);
    const occ = locateAll(o, f.lines, tier, 0);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === f.lines.length;
    f.lines = spliceOps(f.lines, best, h.ops, tier);
    if (atEnd) f.final = !h.noEol;
    d += newSide(h.ops).length - o.length;
  }
  return joinDoc(f);
}

/** One unified section as one edit (SPEC section 6). */
function applySection(sec: DiffSec, tree: WorkTree, strict: boolean): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (oldP !== null && !isSafe(oldP)) throw new EditFail('unsafe', oldP);
  if (newP !== null && !isSafe(newP)) throw new EditFail('unsafe', newP);
  if (sec.create || oldP === null) {
    const target = newP ?? oldP;
    if (target === null) return;
    if (tree.get(target) !== null || tree.createBlocked(target)) throw new EditFail('exists', target);
    const plus: string[] = [];
    for (const h of sec.hunks) for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
    let noEol = false;
    for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
      const h = sec.hunks[hi]!;
      if (h.hasPlus) {
        noEol = h.plusNoEol;
        break;
      }
    }
    tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    return;
  }
  if (sec.remove || newP === null) {
    const target = oldP ?? newP;
    if (target === null) return;
    if (tree.get(target) === null) throw new EditFail('missing', target);
    tree.now.set(target, null);
    return;
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    const before = tree.get(oldP);
    if (before === null) throw new EditFail('missing', oldP);
    if (tree.get(newP) !== null || tree.createBlocked(newP)) throw new EditFail('exists', newP);
    const result = runHunks(before, sec.hunks, strict, oldP);
    tree.now.set(oldP, null);
    tree.now.set(newP, result);
    tree.moves.push([oldP, newP]);
    return;
  }
  const p = oldP ?? newP;
  if (p === null) return;
  const before = tree.get(p);
  if (before === null) throw new EditFail('missing', p);
  tree.now.set(p, runHunks(before, sec.hunks, strict, p));
}

/** Read a unified diff patch into edits (SPEC section 6). */
function parseUnified(lines: string[], strict: boolean): PatchEdit[] {
  const sections: DiffSec[] = [];
  const n = lines.length;
  let i = 0;
  let cur: DiffSec | null = null;
  let inHeader = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new ParseExit(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [], pairSet: false };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldRaw = hdrPath(line);
      const newRaw = hdrPath(lines[i + 1]!);
      const oldP = oldRaw === '/dev/null' ? null : dropAB(oldRaw);
      const newP = newRaw === '/dev/null' ? null : dropAB(newRaw);
      // A pair names the paths only while the current section has no pair yet
      // (SPEC section 6: a section starts at a ---/+++ pair "not already part of
      // a section's header"; the pair that opened the section, or the pair after
      // a diff --git line, is its header's pair — a further pair before the first
      // hunk starts a new section instead of overwriting the paths).
      if (cur !== null && inHeader && !cur.pairSet) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pairSet = true;
      } else {
        cur = { oldPath: oldP, newPath: newP, create: false, remove: false, hunks: [], pairSet: true };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseExit(`error: parse ${i + 1}`);
      const a = hunkAt(line);
      if (a === null) throw new ParseExit(`error: parse ${i + 1}`);
      inHeader = false;
      const raw: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const ops: LineOp[] = [];
      for (const bl of raw) {
        if (bl === '') ops.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') ops.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') ops.push({ kind: 'del', text: bl.slice(1) });
        else if (bl[0] === '+') ops.push({ kind: 'add', text: bl.slice(1) });
      }
      let noEol = false;
      let plusNoEol = false;
      let hasPlus = false;
      for (let k = raw.length - 1; k >= 0; k -= 1) {
        const bl = raw[k]!;
        if (bl[0] === '+') {
          hasPlus = true;
          if (raw[k + 1] !== undefined && raw[k + 1]![0] === '\\') plusNoEol = true;
          break;
        }
      }
      for (let k = raw.length - 1; k >= 0; k -= 1) {
        const bl = raw[k]!;
        if (bl === '' || bl[0] === ' ' || bl[0] === '+') {
          if (raw[k + 1] !== undefined && raw[k + 1]![0] === '\\') noEol = true;
          break;
        }
      }
      cur.hunks.push({ a, ops, noEol, plusNoEol, hasPlus });
      i = j;
      continue;
    }
    if (cur === null) {
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new ParseExit(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        const p = hdrPath(line);
        cur.newPath = p === '/dev/null' ? null : dropAB(p);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.pairSet) cur.oldPath = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.pairSet) cur.newPath = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => (tree: WorkTree) => applySection(sec, tree, strict));
}

function parseJson(text: string, lines: string[]): PatchEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseExit('error: parse 1');
  const edits: PatchEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseExit(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseExit(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonOne(x);
      if (e === null) throw new ParseExit(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: PatchEdit | null = null;
    try {
      e = jsonOne(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseExit(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Read a SEARCH/REPLACE patch into edits (SPEC section 7). */
function parseSearchReplace(lines: string[], strict: boolean): PatchEdit[] {
  const n = lines.length;
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseExit(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new ParseExit(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseExit(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => (tree: WorkTree) => {
    if (!isSafe(b.path)) throw new EditFail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null || tree.createBlocked(b.path)) throw new EditFail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new EditFail('missing', b.path);
    const f = splitDoc(before);
    const tier = pickTier(b.oldLines, f.lines, strict, 0);
    if (tier < 0) throw new EditFail('no-match', b.path);
    const occ = locateAll(b.oldLines, f.lines, tier, 0);
    if (occ.length > 1) throw new EditFail('ambiguous', b.path);
    const ops: LineOp[] = [
      ...b.oldLines.map((t): LineOp => ({ kind: 'del', text: t })),
      ...b.newLines.map((t): LineOp => ({ kind: 'add', text: t })),
    ];
    f.lines = spliceOps(f.lines, occ[0]!, ops, tier);
    tree.now.set(b.path, joinDoc(f));
  });
}

/** One chunk of a V4A Update File section (SPEC section 8). */
interface V4Chunk {
  anchor: string | null;
  ops: LineOp[];
  eof: boolean;
}
interface V4Sec {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4Chunk[];
}

/** Read a V4A patch into edits (SPEC section 8). */
function parseV4a(lines: string[], strict: boolean): PatchEdit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseExit('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseExit(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseExit(`error: parse ${n + 1}`);
  const rawSections: { kind: 'add' | 'delete' | 'update'; path: string; lineNo: number; raw: { text: string; no: number }[] }[] = [];
  let cur: { kind: 'add' | 'delete' | 'update'; path: string; lineNo: number; raw: { text: string; no: number }[] } | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const isAdd = line.startsWith('*** Add File: ');
    const isDel = line.startsWith('*** Delete File: ');
    const isUpd = line.startsWith('*** Update File: ');
    if (isAdd || isDel || isUpd) {
      if (cur !== null) rawSections.push(cur);
      const kind = isAdd ? 'add' : isDel ? 'delete' : 'update';
      const prefix = isAdd ? '*** Add File: ' : isDel ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo: i + 1, raw: [] };
      continue;
    }
    if (cur !== null) {
      cur.raw.push({ text: line, no: i + 1 });
    } else if (!isBlank(line)) {
      throw new ParseExit(`error: parse ${i + 1}`);
    }
  }
  if (cur !== null) rawSections.push(cur);
  const sections: V4Sec[] = rawSections.map((s) => {
    while (s.raw.length > 0 && isBlank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      const addLines: string[] = [];
      for (const r of s.raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new ParseExit(`error: parse ${r.no}`);
      }
      return { kind: 'add', path: s.path, lineNo: s.lineNo, addLines, moveTo: null, chunks: [] };
    }
    if (s.kind === 'delete') {
      for (const r of s.raw) {
        if (!isBlank(r.text)) throw new ParseExit(`error: parse ${r.no}`);
      }
      return { kind: 'delete', path: s.path, lineNo: s.lineNo, addLines: [], moveTo: null, chunks: [] };
    }
    let moveTo: string | null = null;
    const chunks: V4Chunk[] = [];
    let curChunk: V4Chunk | null = null;
    let seenBody = false;
    let afterEof = false;
    for (const r of s.raw) {
      const l = r.text;
      if (l.startsWith('*** Move to: ')) {
        if (seenBody || moveTo !== null) throw new ParseExit(`error: parse ${r.no}`);
        moveTo = l.slice('*** Move to: '.length).trim();
        seenBody = true;
        continue;
      }
      if (l === '*** End of File') {
        if (curChunk === null) throw new ParseExit(`error: parse ${r.no}`);
        curChunk.eof = true;
        curChunk = null;
        afterEof = true;
        seenBody = true;
        continue;
      }
      if (l.startsWith('@@')) {
        curChunk = { anchor: l.slice(2).trim() || null, ops: [], eof: false };
        chunks.push(curChunk);
        afterEof = false;
        seenBody = true;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (afterEof) throw new ParseExit(`error: parse ${r.no}`);
        if (curChunk === null) {
          curChunk = { anchor: null, ops: [], eof: false };
          chunks.push(curChunk);
        }
        if (l === '') curChunk.ops.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') curChunk.ops.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') curChunk.ops.push({ kind: 'del', text: l.slice(1) });
        else curChunk.ops.push({ kind: 'add', text: l.slice(1) });
        afterEof = false;
        seenBody = true;
        continue;
      }
      throw new ParseExit(`error: parse ${r.no}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseExit(`error: parse ${s.lineNo}`);
    return { kind: 'update', path: s.path, lineNo: s.lineNo, addLines: [], moveTo, chunks };
  });
  return sections.map((sec) => (tree: WorkTree) => {
    if (!isSafe(sec.path)) throw new EditFail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null || tree.createBlocked(sec.path)) throw new EditFail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new EditFail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !isSafe(sec.moveTo)) throw new EditFail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new EditFail('missing', sec.path);
    if (sec.moveTo !== null && (tree.get(sec.moveTo) !== null || tree.createBlocked(sec.moveTo))) throw new EditFail('exists', sec.moveTo);
    const f = splitDoc(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tier = pickTier([ch.anchor], f.lines, strict, cursor);
        if (tier < 0) throw new EditFail('no-match', sec.path);
        const occ = locateAll([ch.anchor], f.lines, tier, cursor);
        cursor = occ[0]! + 1;
      }
      const o = oldSide(ch.ops);
      if (o.length === 0) {
        const ins = newSide(ch.ops);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const tier = pickTier(o, f.lines, strict, cursor);
      if (tier < 0) throw new EditFail('no-match', sec.path);
      let occ = locateAll(o, f.lines, tier, cursor);
      if (ch.eof) {
        occ = occ.filter((p) => p + o.length === f.lines.length);
        if (occ.length === 0) throw new EditFail('no-match', sec.path);
      }
      const at = occ[0]!;
      f.lines = spliceOps(f.lines, at, ch.ops, tier);
      cursor = at + newSide(ch.ops).length;
    }
    const result = joinDoc(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, result);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, result);
    }
  });
}

/** Remove a file on disk, tolerating it already being gone — including when
 * its parent directory was removed by dropDir, which makes the path fail
 * with ENOTDIR instead of ENOENT. The file is gone either way. */
function dropFile(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') return;
    throw e;
  }
}

/** Remove a directory at `p` on disk, if one is there. A create or move was
 * only allowed when no file in the effective tree sits under it, so it holds
 * only files this patch already deleted or moved away; removing it lets the
 * file be written instead of crashing the write with EISDIR. */
function dropDir(p: string): void {
  try {
    if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  } catch { /* not there, or not a directory */ }
}

function execute(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? sniffFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: PatchEdit[];
  try {
    edits = kind === 'json' ? parseJson(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseExit('error: parse 1');
  } catch (e) {
    if (e instanceof ParseExit) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; text: string; write: () => void }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      usedOld.add(oldP);
      usedNew.add(newP);
      entries.push({
        key: newP,
        text: `R ${oldP} -> ${newP}`,
        write: () => {
          dropFile(oldP);
          dropDir(newP);
          mkdirSync(dirname(newP), { recursive: true });
          writeFileSync(newP, tree.get(newP)!);
        },
      });
    }
  }
  for (const p of tree.now.keys()) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({
      key: p,
      text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`,
      write: () => {
        if (now === null) dropFile(p);
        else {
          dropDir(p);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      },
    });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) for (const e of entries) e.write();
  const rows = entries.map((e) => e.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialUrl);
} else {
  const r = execute(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}


