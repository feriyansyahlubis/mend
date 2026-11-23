// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It implements all ten sections of SPEC.md: the command line, the output and exit codes, safe paths, format
// detection, three-tier line matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write with move reporting (section 10).
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

/** A file as lines: its break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

// ---- Section 5: matching lines at three tiers ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/**
 * The occurrences of pat in lines at or after start, at the first tier (0, 1, 2; only 0 when strict) where at
 * least one occurs. With eofOnly only occurrences ending at the file's last line count (V4A end-of-file chunks).
 * Occurrences may overlap; positions are 0-based and in increasing order.
 */
function findOccurrences(
  lines: string[],
  pat: string[],
  start: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const norm = t === 0 ? (s: string): string => s : t === 1 ? stripTrail : stripBoth;
    const p = pat.map(norm);
    const pos: number[] = [];
    for (let i = start; i + pat.length <= lines.length; i++) {
      if (eofOnly && i + pat.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < pat.length; j++) {
        if (norm(lines[i + j]!) !== p[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Build the replacement lines N for a match. fileMatched holds the file's own matched lines (O's span);
 * nCtx[j] is the index into O of N[j] when N[j] is a context line, else -1. A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line of N is re-indented: F is the leading
 * spaces/tabs of the file's first matched line, P those of O's first line; a non-empty, non-whitespace-only
 * line of N starting with P has that P replaced by F. At tiers 0 and 1 N's lines are written as they are.
 */
function buildNew(fileMatched: string[], o: string[], n: string[], nCtx: number[], tier: number): string[] {
  if (tier !== 2) {
    return n.map((line, j) => (nCtx[j]! >= 0 ? fileMatched[nCtx[j]!]! : line));
  }
  const f = leadingWs(fileMatched[0] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((line, j) => {
    if (nCtx[j]! >= 0) return fileMatched[nCtx[j]!]!;
    if (line === '' || line.trim() === '') return line;
    if (line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in the patch's order; the output phase keeps only those that still look like a move. */
  readonly moves: { old: string; new: string }[] = [];
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

// ---- Section 6: unified diffs ----

interface UniHunk {
  a: number;
  o: string[];
  n: string[];
  /** For each line of n: its index into o when it is a context line, else -1. */
  nCtx: number[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** The hunk's `+` lines, in order (for creations). */
  plus: string[];
  /** A `\` line follows the hunk's last `+` line. */
  plusNoNl: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function parseDiffPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

function buildHunk(a: number, body: string[]): UniHunk {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  const plus: string[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      nCtx.push(o.length);
      o.push(t);
      n.push(t);
      lastCtxOrPlus = k;
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      const t = bl.slice(1);
      nCtx.push(-1);
      n.push(t);
      plus.push(t);
      lastCtxOrPlus = k;
      lastPlus = k;
    } else if (bl === '') {
      nCtx.push(o.length);
      o.push('');
      n.push('');
      lastCtxOrPlus = k;
    }
    // A `\` line refers to the body line before it and adds no O/N line.
  }
  const followsBackslash = (idx: number): boolean =>
    idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return { a, o, n, nCtx, noNl: followsBackslash(lastCtxOrPlus), plus, plusNoNl: followsBackslash(lastPlus) };
}

/** Apply one section's hunks, in order, to a file model; d tracks the running line-count drift. */
function applyHunks(model: FileModel, hunks: UniHunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...h.n);
      if (atEnd) model.finalBreak = !h.noNl;
      d += h.n.length;
      continue;
    }
    const occ = findOccurrences(model.lines, h.o, 0, strict, false);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + h.o.length === model.lines.length;
    const built = buildNew(model.lines.slice(best, best + h.o.length), h.o, h.n, h.nCtx, occ.tier);
    model.lines.splice(best, h.o.length, ...built);
    if (runsToEnd) model.finalBreak = !h.noNl;
    d += h.n.length - h.o.length;
  }
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const isCreate = sec.oldPath === null || sec.newFile;
  const isDelete = sec.newPath === null || sec.deletedFile;
  const kind: 'create' | 'delete' | 'move' | 'change' = isCreate
    ? 'create'
    : isDelete
      ? 'delete'
      : sec.oldPath !== sec.newPath
        ? 'move'
        : 'change';
  if (kind === 'create') {
    const p = sec.newPath;
    return (tree) => {
      if (p === null) return; // both sides /dev/null: no file is named, nothing to create.
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        if (h.plus.length > 0) {
          plus.push(...h.plus);
          noNl = h.plusNoNl;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
    };
  }
  if (kind === 'delete') {
    const p = sec.oldPath;
    return (tree) => {
      if (p === null) return; // both sides /dev/null: no file is named, nothing to delete.
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const oldP = sec.oldPath!;
  const newP = sec.newPath!;
  const isMove = kind === 'move';
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = splitFile(cur);
    applyHunks(model, sec.hunks, oldP, strict);
    const out = joinFile(model);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let phase: 'header' | 'hunks' = 'header';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      phase = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseDiffPath(line);
      const newP = parseDiffPath(lines[i + 1]!);
      if (cur !== null && phase === 'header' && !cur.hasPair) {
        // The section's own header pair: it names this section's paths.
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
      } else {
        cur = { oldPath: oldP, newPath: newP, hasPair: true, newFile: false, deletedFile: false, hunks: [] };
        sections.push(cur);
        phase = 'header';
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line, i + 1);
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      phase = 'hunks';
      continue;
    }
    if (cur === null) {
      i += 1;
      continue;
    }
    if (phase === 'header') {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = parseDiffPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = splitFile(cur);
    const occ = findOccurrences(model.lines, oldLines, 0, strict, false);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', path);
    const p = occ.pos[0]!;
    const nCtx = newLines.map(() => -1);
    const built = buildNew(model.lines.slice(p, p + oldLines.length), oldLines, newLines, nCtx, occ.tier);
    model.lines.splice(p, oldLines.length, ...built);
    tree.now.set(path, joinFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  nCtx: number[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, content: string[], baseLine: number, updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  for (let k = 0; k < content.length; k++) {
    const line = content[k]!;
    const ln = baseLine + k;
    if (k === 0 && line.startsWith('*** Move to: ')) {
      moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchorText = line.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, o: [], n: [], nCtx: [] };
      started = true;
      continue;
    }
    if (line.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, o: [], n: [], nCtx: [] };
        started = true;
      }
      if (line.startsWith(' ')) {
        const t = line.slice(1);
        cur.nCtx.push(cur.o.length);
        cur.o.push(t);
        cur.n.push(t);
      } else if (line.startsWith('-')) {
        cur.o.push(line.slice(1));
      } else if (line.startsWith('+')) {
        cur.nCtx.push(-1);
        cur.n.push(line.slice(1));
      } else {
        cur.nCtx.push(cur.o.length);
        cur.o.push('');
        cur.n.push('');
      }
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(curText);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findOccurrences(model.lines, [chunk.anchor], cursor, strict, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? model.lines.length : cursor;
        model.lines.splice(at, 0, ...chunk.n);
        cursor = at + chunk.n.length;
      } else {
        const occ = findOccurrences(model.lines, chunk.o, cursor, strict, chunk.eof);
        if (occ === null) throw new Fail('no-match', path);
        const p = occ.pos[0]!;
        const built = buildNew(model.lines.slice(p, p + chunk.o.length), chunk.o, chunk.n, chunk.nCtx, occ.tier);
        model.lines.splice(p, chunk.o.length, ...built);
        cursor = p + built.length;
      }
    }
    const out = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    let end = last;
    for (let j = i + 1; j < last; j++) {
      const lj = lines[j]!;
      if (lj.startsWith('*** Add File: ') || lj.startsWith('*** Delete File: ') || lj.startsWith('*** Update File: ')) {
        end = j;
        break;
      }
    }
    const content = lines.slice(i + 1, end);
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else if (cl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, content, i + 2, i + 1, strict));
    }
    i = end;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Sections 1, 2 and 10: invocation, output and exit codes, order and atomicity ----

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
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
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rMoves = tree.moves.filter((m) => {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.get(m.new);
    return wasOld !== null && nowOld === null && wasNew === null && nowNew !== null;
  });
  const rOlds = new Set(rMoves.map((m) => m.old));
  const rNews = new Set(rMoves.map((m) => m.new));
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOlds.has(p) || rNews.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of rMoves) rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
