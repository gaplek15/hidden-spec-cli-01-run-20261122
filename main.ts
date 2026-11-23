// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies an edit an AI model wrote, in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), to the tree of text files in the working
// directory, all or nothing. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
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

// ---------- Section 5: a file's lines, and finding old lines in them at three tiers ----------

interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every 0-based position where `old` matches `lines` at `tier`, from `from` on; occurrences may overlap. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i += 1) {
    if (eofOnly && i + old.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (!tierEq(lines[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** One line of an old/new pair: a context line belongs to both sides, an old line only to the old side. */
interface PairLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/**
 * The lines that replace a matched run. A context line is written as the file's own matched line; at tier 2
 * every other new line is re-indented, its old leading whitespace swapped for the file's.
 */
function replacementFor(fileLines: string[], pos: number, oldItems: PairLine[], newItems: PairLine[], tier: number): string[] {
  const oldCtxAt: number[] = [];
  oldItems.forEach((it, idx) => {
    if (it.kind === 'ctx') oldCtxAt.push(idx);
  });
  const fileLead = leadWs(fileLines[pos] ?? '');
  const oldLead = oldItems.length > 0 ? leadWs(oldItems[0]!.text) : '';
  const out: string[] = [];
  let ctxSeen = 0;
  for (const it of newItems) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oldCtxAt[ctxSeen]!]!);
      ctxSeen += 1;
    } else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(oldLead)) {
      out.push(fileLead + it.text.slice(oldLead.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

// ---------- Section 6: unified diffs ----------

type HunkItem =
  | { kind: 'ctx' | 'old' | 'new'; text: string }
  | { kind: 'mark'; text: string };

interface Hunk {
  start: number;
  items: HunkItem[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  renameFrom?: string | null;
  renameTo?: string | null;
  newFile: boolean;
  deleted: boolean;
  hasHead: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: the text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Whether a `\` line follows the hunk's last context or `+` line; false when it has no such line. */
function hunkNoEol(items: HunkItem[]): boolean {
  let lastIdx = -1;
  items.forEach((it, idx) => {
    if (it.kind === 'ctx' || it.kind === 'new') lastIdx = idx;
  });
  return lastIdx >= 0 && items[lastIdx + 1]?.kind === 'mark';
}

/** Whether a `\` line follows the last `+` line across a creation's hunks. */
function creationNoEol(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi -= 1) {
    const items = hunks[hi]!.items;
    let lastNew = -1;
    items.forEach((it, idx) => {
      if (it.kind === 'new') lastNew = idx;
    });
    if (lastNew >= 0) return items[lastNew + 1]?.kind === 'mark';
  }
  return false;
}

function hunkSides(h: Hunk): { oldItems: PairLine[]; newItems: PairLine[]; noEol: boolean } {
  const oldItems: PairLine[] = [];
  const newItems: PairLine[] = [];
  for (const it of h.items) {
    if (it.kind === 'ctx') {
      oldItems.push({ kind: 'ctx', text: it.text });
      newItems.push({ kind: 'ctx', text: it.text });
    } else if (it.kind === 'old') oldItems.push({ kind: 'old', text: it.text });
    else if (it.kind === 'new') newItems.push({ kind: 'new', text: it.text });
  }
  return { oldItems, newItems, noEol: hunkNoEol(h.items) };
}

/** Apply a section's hunks, in order, to a file's text; the hunk's path names it in a no-match failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let finalBreak = f.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { oldItems, newItems, noEol } = hunkSides(h);
    const oldTexts = oldItems.map((i) => i.text);
    if (oldTexts.length === 0) {
      const pos = Math.max(0, Math.min(h.start + d, lines.length));
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...newItems.map((i) => i.text), ...lines.slice(pos)];
      if (atEnd) finalBreak = !noEol;
      d += newItems.length;
      continue;
    }
    let found: { tier: number; occ: number[] } | null = null;
    for (const t of tiers(strict)) {
      const occ = occurrencesAt(lines, oldTexts, t, 0, false);
      if (occ.length > 0) {
        found = { tier: t, occ };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    const target = h.start - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + oldTexts.length === lines.length;
    const rep = replacementFor(lines, best, oldItems, newItems, found.tier);
    lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + oldTexts.length)];
    if (atEnd) finalBreak = !noEol;
    d += newItems.length - oldItems.length;
  }
  return joinFile(lines, f.br, finalBreak);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({ newFile: false, deleted: false, hasHead: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasHead || cur.hunks.length > 0) {
        if (cur !== null) sections.push(cur);
        cur = fresh();
      }
      cur.headOld = headerPath(line);
      cur.headNew = headerPath(lines[i + 1]!);
      cur.hasHead = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: HunkItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          items.push({ kind: 'ctx', text: '' });
          j += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') {
          items.push({ kind: 'ctx', text: l.slice(1) });
          j += 1;
          continue;
        }
        if (c === '-') {
          items.push({ kind: 'old', text: l.slice(1) });
          j += 1;
          continue;
        }
        if (c === '+') {
          items.push({ kind: 'new', text: l.slice(1) });
          j += 1;
          continue;
        }
        if (c === '\\') {
          items.push({ kind: 'mark', text: l.slice(1) });
          j += 1;
          continue;
        }
        break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      cur.hunks.push({ start: Number(m[1]), items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        const v = line.slice(12).trim();
        cur.renameFrom = v === '/dev/null' ? null : v;
      } else if (line.startsWith('rename to ')) {
        const v = line.slice(10).trim();
        cur.renameTo = v === '/dev/null' ? null : v;
      } else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.headOld !== undefined ? sec.headOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.headNew !== undefined ? sec.headNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = newP === null || sec.deleted;
  return (tree) => {
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null || newP === undefined) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      }
      const noEol = creationNoEol(sec.hunks);
      tree.now.set(newP, plus.length === 0 ? '' : `${plus.join('\n')}${noEol ? '' : '\n'}`);
      return;
    }
    if (isDelete) {
      if (oldP === null || oldP === undefined) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, after);
      tree.recordMove(oldP, newP);
      return;
    }
    const p = oldP ?? newP;
    if (p === null || p === undefined) return;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '<<<<<<< SEARCH') j += 1;
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE' && lines[k]!.trimEnd() !== '<<<<<<< SEARCH') k += 1;
    if (k >= lines.length || lines[k]!.trimEnd() !== '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let p = i - 1; p > prevEnd; p -= 1) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    blocks.push({ path, oldLines, newLines });
    prevEnd = k;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    let found: { tier: number; occ: number[] } | null = null;
    for (const t of tiers(strict)) {
      const occ = occurrencesAt(f.lines, b.oldLines, t, 0, false);
      if (occ.length > 0) {
        found = { tier: t, occ };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const oldItems: PairLine[] = b.oldLines.map((text) => ({ kind: 'old', text }));
    const newItems: PairLine[] = b.newLines.map((text) => ({ kind: 'new', text }));
    const rep = replacementFor(f.lines, pos, oldItems, newItems, found.tier);
    const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile(out, f.br, f.finalBreak));
  };
}

// ---------- Section 8: V4A patches ----------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: PairLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo?: string;
  addLines?: string[];
  chunks?: V4aChunk[];
  lineNo: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const raw: { text: string; no: number }[] = [];
    i += 1;
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind, path, addLines, lineNo: headerLine });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind, path, lineNo: headerLine });
    } else {
      let moveTo: string | undefined;
      let at = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).trim();
        at = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let closed = false;
      for (; at < raw.length; at += 1) {
        const r = raw[at]!;
        if (r.text.startsWith('@@')) {
          const anchorText = r.text.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          chunks.push(cur);
          closed = false;
          continue;
        }
        if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (closed) throw new Exit2(`error: parse ${r.no}`);
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (r.text === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (r.text[0] === ' ') cur.items.push({ kind: 'ctx', text: r.text.slice(1) });
          else if (r.text[0] === '-') cur.items.push({ kind: 'old', text: r.text.slice(1) });
          else cur.items.push({ kind: 'new', text: r.text.slice(1) });
          continue;
        }
        if (r.text.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
          closed = true;
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, chunks, lineNo: headerLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const ls = s.addLines!;
      tree.now.set(s.path, ls.length === 0 ? '' : `${ls.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of s.chunks!) {
      if (ch.anchor !== null) {
        let foundIdx: number | null = null;
        for (const t of tiers(strict)) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (tierEq(lines[k]!, ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx !== null) break;
        }
        if (foundIdx === null) throw new Fail('no-match', s.path);
        cursor = foundIdx + 1;
      }
      const oldItems = ch.items.filter((it) => it.kind !== 'new');
      const newItems = ch.items.filter((it) => it.kind !== 'old');
      const oldTexts = oldItems.map((it) => it.text);
      if (oldTexts.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, pos), ...newItems.map((it) => it.text), ...lines.slice(pos)];
        cursor = pos + newItems.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (const t of tiers(strict)) {
        const occ = occurrencesAt(lines, oldTexts, t, cursor, ch.eof);
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', s.path);
      const rep = replacementFor(lines, found.pos, oldItems, newItems, found.tier);
      lines = [...lines.slice(0, found.pos), ...rep, ...lines.slice(found.pos + oldTexts.length)];
      cursor = found.pos + rep.length;
    }
    const after = joinFile(lines, f.br, f.finalBreak);
    if (s.moveTo !== undefined) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, after);
      tree.recordMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, after);
    }
  };
}

// ---------- Section 10: running the edits, in order, all or nothing ----------

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
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
