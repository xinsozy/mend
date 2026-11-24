// main.ts is mend, the CLI SPEC.md specifies. It applies an edit that an AI model wrote to a tree of text
// files, in four formats: unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8) and text-editor tool calls as JSON (section 9), with line matching at three tiers
// (section 5), safe paths, the output and exit codes of section 2, and the all-or-nothing write of
// section 10. Node 22 and its standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its line break, its lines, and whether it ends with a line break (section 3). */
interface FText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function trimEndWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Line equality at one matching tier (section 5): 0 exact, 1 trailing whitespace ignored, 2 both sides ignored. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Every 0-based position where O occurs in the file's lines at the tier; occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(file[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at or after `from`;
 * with eofOnly only occurrences that end at the file's last line count. Null when O occurs nowhere. */
function findTier(file: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): TierHit | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let occ = occurrences(file, o, t).filter((i) => i >= from);
    if (eofOnly) occ = occ.filter((i) => i + o.length === file.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** N replaces the k matched lines at `at`. A context line (nCtx[j] is its index in O) is written as the
 * file's own matched line, never the patch's. At tier 2 every other line of N is re-indented: the leading
 * spaces and tabs of O's first line are replaced by those of the file's first matched line. */
function replaceLines(file: string[], at: number, o: string[], n: string[], nCtx: (number | null)[], tier: number): string[] {
  const out = file.slice(0, at);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWS(file[at]!);
    p = leadWS(o[0]!);
  }
  for (let j = 0; j < n.length; j++) {
    const c = nCtx[j];
    if (c !== null && c !== undefined) {
      out.push(file[at + c]!);
      continue;
    }
    let line = n[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  out.push(...file.slice(at + o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** What the parsers need besides the patch lines: strict matching, and the list of move pairs that
 * succeeded, so the output can print `R <old> -> <new>` for them (section 2). */
interface Ctx {
  strict: boolean;
  moves: [string, string][];
}

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

/* ------------------------------------------------------------------ section 6: unified diffs */

interface UHunk {
  a: number;
  o: string[];
  n: string[];
  nCtx: (number | null)[];
  noNL: boolean;
  lastPlusNoNL: boolean;
  hasPlus: boolean;
  plus: string[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** A `--- `/`+++ ` path: the text after the four characters, up to the first tab, with surrounding
 * spaces removed; a leading `a/` or `b/` is removed. `/dev/null` means no file, so null. */
function cleanDiffPath(s: string): string | null {
  let t = s.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Parse one hunk body starting at `start` (the line after the header). Returns the hunk and the
 * index of the first line after the body. Empty lines at the end of a body are not part of it. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: UHunk; next: number } {
  const raw: { k: string; text: string }[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push({ k: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      i++;
    } else break;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.k === ' ' && last.text === '') raw.pop();
    else break;
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let j = 0; j < raw.length; j++) {
    const r = raw[j]!;
    if (r.k === ' ' || r.k === '+') lastCtxPlus = j;
    if (r.k === '+') lastPlus = j;
  }
  const noNL = lastCtxPlus >= 0 && raw[lastCtxPlus + 1] !== undefined && raw[lastCtxPlus + 1]!.k === '\\';
  const lastPlusNoNL = lastPlus >= 0 && raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]!.k === '\\';
  const o: string[] = [];
  const nn: string[] = [];
  const nCtx: (number | null)[] = [];
  const plus: string[] = [];
  for (const r of raw) {
    if (r.k === ' ') {
      o.push(r.text);
      nn.push(r.text);
      nCtx.push(o.length - 1);
    } else if (r.k === '-') {
      o.push(r.text);
    } else if (r.k === '+') {
      nn.push(r.text);
      nCtx.push(null);
      plus.push(r.text);
    }
  }
  return { hunk: { a, o, n: nn, nCtx, noNL, lastPlusNoNL, hasPlus: plus.length > 0, plus }, next: i };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let i = 0;
  const n = lines.length;
  let cur: USection | null = null;
  let state: 'none' | 'header' | 'between' = 'none';
  let pairSeen = false;

  const startDiff = (l: string): void => {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    cur = { diffOld: m[1]!, diffNew: m[2]!, pairOld: null, pairNew: null, renOld: null, renNew: null, create: false, del: false, hunks: [] };
    sections.push(cur);
    state = 'header';
    pairSeen = false;
  };
  const startPair = (oldL: string, newL: string): void => {
    cur = { diffOld: null, diffNew: null, pairOld: cleanDiffPath(oldL), pairNew: cleanDiffPath(newL), renOld: null, renNew: null, create: false, del: false, hunks: [] };
    sections.push(cur);
    state = 'header';
    pairSeen = true;
  };
  const parseHunk = (): void => {
    const m = HUNK_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    const a = parseInt(m[1]!, 10);
    const r = parseHunkBody(lines, i + 1, a);
    cur.hunks.push(r.hunk);
    i = r.next;
    state = 'between';
  };

  while (i < n) {
    const l = lines[i]!;
    if (state === 'none') {
      if (l.startsWith('diff --git ')) {
        startDiff(l);
        i++;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startPair(l, lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (state === 'header') {
      if (l.startsWith('diff --git ')) {
        startDiff(l);
        i++;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!pairSeen) {
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          cur!.pairOld = cleanDiffPath(l);
          cur!.pairNew = cleanDiffPath(lines[i + 1]!);
          pairSeen = true;
          i += 2;
          continue;
        }
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          startPair(l, lines[i + 1]!);
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur!.renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur!.renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur!.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur!.del = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        parseHunk();
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      startDiff(l);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startPair(l, lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      parseHunk();
      continue;
    }
    i++;
  }
  return sections;
}

/** The section's old path: the `---`/`+++` pair wins, then `rename from`/`to`, then `diff --git`. */
function secOld(s: USection): string | null {
  return s.pairOld ?? s.renOld ?? s.diffOld;
}
function secNew(s: USection): string | null {
  return s.pairNew ?? s.renNew ?? s.diffNew;
}

/** Apply one hunk to the file as the hunks before it left it; `d` is the sum over those hunks of
 * (N's length minus O's length). Returns the new file, or a Fail for the section's path. */
function applyUHunk(f: FText, h: UHunk, d: number, strict: boolean, path: string): FText | Fail {
  if (h.o.length === 0) {
    const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
    const atEnd = pos === f.lines.length;
    const lines = f.lines.slice(0, pos).concat(h.n, f.lines.slice(pos));
    return { br: f.br, lines, final: atEnd ? !h.noNL : f.final };
  }
  const hit = findTier(f.lines, h.o, strict, 0, false);
  if (hit === null) return new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = hit.occ[0]!;
  for (const o of hit.occ) {
    if (Math.abs(o - target) < Math.abs(best - target)) best = o;
  }
  const at = best;
  const lines = replaceLines(f.lines, at, h.o, h.n, h.nCtx, hit.tier);
  const matchedEnd = at + h.o.length === f.lines.length;
  return { br: f.br, lines, final: matchedEnd ? !h.noNL : f.final };
}

function unifiedEdit(sec: USection, strict: boolean, moves: [string, string][]): Edit {
  const oldP = secOld(sec);
  const newP = secNew(sec);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if ((oldP === null || sec.create) && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastWithPlus: UHunk | null = null;
      for (const h of sec.hunks) {
        for (const l of h.plus) plus.push(l);
        if (h.hasPlus) lastWithPlus = h;
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastWithPlus !== null && !lastWithPlus.lastPlusNoNL ? '\n' : '');
      tree.now.set(newP, text);
      return;
    }
    if ((newP === null || sec.del) && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let f = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyUHunk(f, h, d, strict, oldP);
        if (r instanceof Fail) throw r;
        d += h.n.length - h.o.length;
        f = r;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      moves.push([oldP, newP]);
      return;
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    let f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUHunk(f, h, d, strict, oldP);
      if (r instanceof Fail) throw r;
      d += h.n.length - h.o.length;
      f = r;
    }
    tree.now.set(oldP, joinFile(f));
  };
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, ctx.strict, ctx.moves));
}

/* ------------------------------------------------------- section 7: SEARCH/REPLACE blocks */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let j = searchIdx + 1;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j++;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    j = sep + 1;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      j++;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  const path = b.path;
  const oldLines = b.oldLines;
  const newLines = b.newLines;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const hit = findTier(f.lines, oldLines, strict, 0, false);
    if (hit === null) throw new Fail('no-match', path);
    if (hit.occ.length > 1) throw new Fail('ambiguous', path);
    const at = hit.occ[0]!;
    const out: FText = { br: f.br, lines: replaceLines(f.lines, at, oldLines, newLines, newLines.map(() => null), hit.tier), final: f.final };
    tree.now.set(path, joinFile(out));
  };
}

function srEdits(lines: string[], ctx: Ctx): Edit[] {
  return parseSearchReplace(lines).map((b) => srEdit(b, ctx.strict));
}

/* ---------------------------------------------------------------- section 8: V4A patches */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  nCtx: (number | null)[];
}

type VSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = l.slice(ADD_PREFIX.length).trim();
    } else if (l.startsWith(DELETE_PREFIX)) {
      kind = 'delete';
      path = l.slice(DELETE_PREFIX.length).trim();
    } else if (l.startsWith(UPDATE_PREFIX)) {
      kind = 'update';
      path = l.slice(UPDATE_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < last) {
      const x = lines[i]!;
      if (x.startsWith(ADD_PREFIX) || x.startsWith(DELETE_PREFIX) || x.startsWith(UPDATE_PREFIX)) break;
      raw.push({ text: x, idx: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind: 'add', path, content });
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      sections.push({ kind: 'delete', path });
      continue;
    }
    let moveTo: string | null = null;
    let p = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith(MOVE_PREFIX)) {
      moveTo = raw[0]!.text.slice(MOVE_PREFIX.length).trim();
      p = 1;
    }
    const chunks: VChunk[] = [];
    let cur: { anchor: string | null; eof: boolean; o: string[]; n: string[]; nCtx: (number | null)[] } | null = null;
    let chunkCount = 0;
    const finish = (): void => {
      if (cur !== null) {
        chunks.push({ anchor: cur.anchor, eof: cur.eof, o: cur.o, n: cur.n, nCtx: cur.nCtx });
        cur = null;
      }
    };
    for (let k = p; k < raw.length; k++) {
      const { text, idx } = raw[k]!;
      if (text.startsWith('@@')) {
        finish();
        const anchor = text.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], nCtx: [] };
        chunkCount++;
        continue;
      }
      if (text === '*** End of File') {
        if (cur !== null) {
          cur.eof = true;
          finish();
        }
        continue;
      }
      if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
        if (cur === null) {
          if (chunkCount === 0) {
            cur = { anchor: null, eof: false, o: [], n: [], nCtx: [] };
            chunkCount++;
          } else {
            throw new Exit2(`error: parse ${idx + 1}`);
          }
        }
        if (text === '') {
          cur.o.push('');
          cur.n.push('');
          cur.nCtx.push(cur.o.length - 1);
        } else if (text[0] === ' ') {
          const t = text.slice(1);
          cur.o.push(t);
          cur.n.push(t);
          cur.nCtx.push(cur.o.length - 1);
        } else if (text[0] === '-') {
          cur.o.push(text.slice(1));
        } else {
          cur.n.push(text.slice(1));
          cur.nCtx.push(null);
        }
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    finish();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    sections.push({ kind: 'update', path, moveTo, chunks });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Apply one V4A chunk: the anchor, when there is one, moves the cursor past the first line at or
 * after it equal to the anchor; O is then taken at its first occurrence at or after the cursor, or,
 * for an end-of-file chunk, only one that ends at the file's last line. The cursor moves to just
 * after the lines written. */
function applyV4aChunk(f: FText, ch: VChunk, cursor: number, strict: boolean, path: string): { file: FText; cursor: number } | Fail {
  let cur = cursor;
  if (ch.anchor !== null) {
    const hit = findTier(f.lines, [ch.anchor], strict, cur, false);
    if (hit === null) return new Fail('no-match', path);
    cur = hit.occ[0]! + 1;
  }
  if (ch.o.length === 0) {
    const pos = ch.eof ? f.lines.length : Math.min(cur, f.lines.length);
    const lines = f.lines.slice(0, pos).concat(ch.n, f.lines.slice(pos));
    return { file: { br: f.br, lines, final: f.final }, cursor: pos + ch.n.length };
  }
  const hit = findTier(f.lines, ch.o, strict, cur, ch.eof);
  if (hit === null) return new Fail('no-match', path);
  const at = hit.occ[0]!;
  const lines = replaceLines(f.lines, at, ch.o, ch.n, ch.nCtx, hit.tier);
  return { file: { br: f.br, lines, final: f.final }, cursor: at + ch.n.length };
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((s) => {
    if (s.kind === 'add') {
      const content = s.content;
      const path = s.path;
      return (tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const path = s.path;
      return (tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    const path = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let f = splitFile(cur);
      let cursor = 0;
      for (const ch of chunks) {
        const r = applyV4aChunk(f, ch, cursor, ctx.strict, path);
        if (r instanceof Fail) throw r;
        f = r.file;
        cursor = r.cursor;
      }
      const out = joinFile(f);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, out);
        ctx.moves.push([path, moveTo]);
      } else {
        tree.now.set(path, out);
      }
    };
  });
}

/* ------------------------------------------------------------ sections 1, 2 and 10: the CLI */

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, ctx);
    else if (kind === 'search-replace') edits = srEdits(lines, ctx);
    else edits = v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const sorted = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: { key: string; line: string }[] = [];
  for (const p of sorted) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.line === `D ${oldP}` || rows[i]!.line === `A ${newP}`) rows.splice(i, 1);
      }
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of sorted) {
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
