// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line normalised for matching at a tier (SPEC section 5). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** Positions where O matches F at tier, at or after `from` (occurrences may overlap). */
function occurrences(o: string[], f: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > f.length) return out;
  const on = o.map((l) => norm(l, tier));
  for (let i = Math.max(0, from); i + o.length <= f.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(f[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier at which O occurs in F at or after `from`, or -1. */
function firstTier(o: string[], f: string[], strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrences(o, f, t, from).length > 0) return t;
  }
  return -1;
}

/** One line of a hunk or chunk: context, removed, or added. */
type Op = { kind: 'ctx' | 'del' | 'add'; text: string };
function opOld(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}
function opNew(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'del').map((o) => o.text);
}
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
/**
 * Replace the lines at `at` (the match of opOld) by the ops: context lines are written as the
 * file's own matched lines, other new lines are re-indented at tier 2 (SPEC section 5).
 */
function applyOps(f: string[], at: number, ops: Op[], tier: number): string[] {
  const o = opOld(ops);
  const out = f.slice(0, at);
  const reindent = tier === 2 && o.length > 0;
  const find = reindent ? leadOf(f[at] ?? '') : '';
  const pind = reindent ? leadOf(o[0]!) : '';
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
class Tree {
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
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
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
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** One hunk of a unified section (SPEC section 6). */
interface Hunk {
  a: number;
  ops: Op[];
  noEol: boolean;
  plusNoEol: boolean;
  hasPlus: boolean;
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
  /** True once a `---`/`+++` pair has named the paths (SPEC section 6: rename from/to name them only when no pair does). */
  pairSet: boolean;
}

const hunkHead = (line: string): number | null => {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
};
const headPath = (line: string): string => {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
};
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** Apply a section's hunks, in order, to a file's text (SPEC section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const o = opOld(h.ops);
    if (o.length === 0) {
      const ins = opNew(h.ops);
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !h.noEol;
      d += ins.length;
      continue;
    }
    const tier = firstTier(o, f.lines, strict, 0);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(o, f.lines, tier, 0);
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
    f.lines = applyOps(f.lines, best, h.ops, tier);
    if (atEnd) f.final = !h.noEol;
    d += opNew(h.ops).length - o.length;
  }
  return joinFile(f);
}

/** One unified section as one edit (SPEC section 6). */
function applyUniSection(sec: UniSection, tree: Tree, strict: boolean): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
  if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
  if (sec.create || oldP === null) {
    const target = newP ?? oldP;
    if (target === null) return;
    if (tree.get(target) !== null) throw new Fail('exists', target);
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
    if (tree.get(target) === null) throw new Fail('missing', target);
    tree.now.set(target, null);
    return;
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const result = applyHunks(before, sec.hunks, strict, oldP);
    tree.now.set(oldP, null);
    tree.now.set(newP, result);
    tree.moves.push([oldP, newP]);
    return;
  }
  const p = oldP ?? newP;
  if (p === null) return;
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
}

/** Read a unified diff patch into edits (SPEC section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let i = 0;
  let cur: UniSection | null = null;
  let inHeader = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [], pairSet: false };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldRaw = headPath(line);
      const newRaw = headPath(lines[i + 1]!);
      const oldP = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
      const newP = newRaw === '/dev/null' ? null : stripAB(newRaw);
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
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHead(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
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
      const ops: Op[] = [];
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
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        const p = headPath(line);
        cur.newPath = p === '/dev/null' ? null : stripAB(p);
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
  return sections.map((sec) => (tree: Tree) => applyUniSection(sec, tree, strict));
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Read a SEARCH/REPLACE patch into edits (SPEC section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
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
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
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
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const tier = firstTier(b.oldLines, f.lines, strict, 0);
    if (tier < 0) throw new Fail('no-match', b.path);
    const occ = occurrences(b.oldLines, f.lines, tier, 0);
    if (occ.length > 1) throw new Fail('ambiguous', b.path);
    const ops: Op[] = [
      ...b.oldLines.map((t): Op => ({ kind: 'del', text: t })),
      ...b.newLines.map((t): Op => ({ kind: 'add', text: t })),
    ];
    f.lines = applyOps(f.lines, occ[0]!, ops, tier);
    tree.now.set(b.path, joinFile(f));
  });
}

/** One chunk of a V4A Update File section (SPEC section 8). */
interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

/** Read a V4A patch into edits (SPEC section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
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
    } else if (!blank(line)) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (cur !== null) rawSections.push(cur);
  const sections: VSection[] = rawSections.map((s) => {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      const addLines: string[] = [];
      for (const r of s.raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      return { kind: 'add', path: s.path, lineNo: s.lineNo, addLines, moveTo: null, chunks: [] };
    }
    if (s.kind === 'delete') {
      for (const r of s.raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      return { kind: 'delete', path: s.path, lineNo: s.lineNo, addLines: [], moveTo: null, chunks: [] };
    }
    let moveTo: string | null = null;
    const chunks: VChunk[] = [];
    let curChunk: VChunk | null = null;
    let seenBody = false;
    let afterEof = false;
    for (const r of s.raw) {
      const l = r.text;
      if (l.startsWith('*** Move to: ')) {
        if (seenBody || moveTo !== null) throw new Exit2(`error: parse ${r.no}`);
        moveTo = l.slice('*** Move to: '.length).trim();
        seenBody = true;
        continue;
      }
      if (l === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${r.no}`);
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
        if (afterEof) throw new Exit2(`error: parse ${r.no}`);
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
      throw new Exit2(`error: parse ${r.no}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
    return { kind: 'update', path: s.path, lineNo: s.lineNo, addLines: [], moveTo, chunks };
  });
  return sections.map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tier = firstTier([ch.anchor], f.lines, strict, cursor);
        if (tier < 0) throw new Fail('no-match', sec.path);
        const occ = occurrences([ch.anchor], f.lines, tier, cursor);
        cursor = occ[0]! + 1;
      }
      const o = opOld(ch.ops);
      if (o.length === 0) {
        const ins = opNew(ch.ops);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const tier = firstTier(o, f.lines, strict, cursor);
      if (tier < 0) throw new Fail('no-match', sec.path);
      let occ = occurrences(o, f.lines, tier, cursor);
      if (ch.eof) {
        occ = occ.filter((p) => p + o.length === f.lines.length);
        if (occ.length === 0) throw new Fail('no-match', sec.path);
      }
      const at = occ[0]!;
      f.lines = applyOps(f.lines, at, ch.ops, tier);
      cursor = at + opNew(ch.ops).length;
    }
    const result = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, result);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, result);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
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
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
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
          rmSync(oldP, { force: true });
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
        if (now === null) rmSync(p, { force: true });
        else {
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


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
