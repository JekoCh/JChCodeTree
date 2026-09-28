// HTML::Template support: which templates include which, and where Perl sets a template's variables.
// Text-based and approximate, like the function parsers.

import { parsePerlFunctions } from './parsers';

export interface TemplateInclude {
  /** As written in the tag: `settings.html`, `/_head.html` */
  name: string;
  /** 0-based */
  line: number;
}

/** `<TMPL_INCLUDE NAME=x.html>` / `NAME="/x.html"`; `EXPR=` includes can't be followed and are skipped. */
const INCLUDE_RE = /<TMPL_INCLUDE\s+NAME\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

export function parseTemplateIncludes(text: string): TemplateInclude[] {
  const results: TemplateInclude[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(INCLUDE_RE)) results.push({ name: m[1] ?? m[2] ?? m[3], line: i });
  });
  return results;
}

/** Tags whose attributes name template variables. */
const VAR_TAG_RE = /<\/?TMPL_(?:VAR|IF|UNLESS|LOOP|ELSIF)\b([^>]*)>/gi;
const TAG_WORDS = new Set(['NAME', 'EXPR', 'ESCAPE', 'DEFAULT']);
/** Operators and literals inside `EXPR="..."`, which are not variable names. */
const EXPR_WORDS = new Set(['and', 'or', 'not', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'cmp']);

/**
 * The template variable under column `col` of a line, if the column is inside a
 * `<TMPL_VAR|IF|UNLESS|LOOP|ELSIF ...>` tag: the `NAME=` value, the bare name (`<TMPL_IF X>`) or a
 * name inside `EXPR="..."`. Attribute words, escape values and EXPR operators/functions don't count.
 */
export function templateKeyAt(line: string, col: number): string | undefined {
  for (const tag of line.matchAll(VAR_TAG_RE)) {
    const start = tag.index!;
    if (col < start || col > start + tag[0].length) continue;
    const attrsStart = start + tag[0].indexOf(tag[1]);
    const attrs = tag[1];
    for (const w of attrs.matchAll(/[A-Za-z_]\w*/g)) {
      const from = attrsStart + w.index!;
      if (col < from || col > from + w[0].length) continue;
      const before = attrs.slice(0, w.index!);
      const after = attrs.slice(w.index! + w[0].length);
      if (TAG_WORDS.has(w[0].toUpperCase()) && /^\s*=/.test(after)) return undefined;
      if (/ESCAPE\s*=\s*["']?$/i.test(before) || /DEFAULT\s*=\s*["']?$/i.test(before)) return undefined;
      const inExpr = /EXPR\s*=\s*"[^"]*$/i.test(before);
      if (inExpr && (EXPR_WORDS.has(w[0].toLowerCase()) || /^\s*\(/.test(after))) return undefined;
      return w[0];
    }
    return undefined;
  }
  return undefined;
}

export interface KeyOccurrence {
  /** 0-based */
  line: number;
  col: number;
  len: number;
  /** `->{KEY} = ...` - a direct assignment, as opposed to `KEY =>` in some hash */
  direct: boolean;
  /** The key as written in Perl (keys match case-insensitively, like HTML::Template) */
  name: string;
}

export interface PerlTemplateInfo {
  /** Quoted template paths (`'dir/add_edit.html'`) and their lines */
  templateRefs: { path: string; line: number }[];
  /** UPPER-CASED key -> where it is set: `{KEY} =`, `{'KEY'} =`, `KEY =>`, `name => 'KEY'` */
  keys: Map<string, KeyOccurrence[]>;
  /** 0-based start lines of the file's subs, from the same read (for "which sub is this line in") */
  subLines: number[];
}

const KEY_PATTERNS: RegExp[] = [
  // $tmpl->{KEY} = ...   $tmpl->{'KEY'} ||= ...   (not ==, =~)
  /\{\s*(['"]?)([A-Za-z_]\w*)\1\s*\}\s*[|/.+*-]*=(?![=~])/g,
  // KEY => ...   'KEY' => ...
  /(?<![\w$@%>-])(['"]?)([A-Za-z_]\w*)\1\s*=>/g,
  // { name => 'KEY', value => ... }
  /\bname\s*=>\s*(['"])([A-Za-z_]\w*)\1/g,
];

/** `templateExts`: the extensions templates use (the ones parsed as HTML), e.g. ['.html']. */
export function parsePerlTemplateInfo(text: string, templateExts: string[]): PerlTemplateInfo {
  const info: PerlTemplateInfo = { templateRefs: [], keys: new Map(), subLines: parsePerlFunctions(text).map(f => f.line) };
  const exts = templateExts.map(e => e.slice(1).replace(/[.+^$()|\\]/g, '\\$&')).join('|');
  const refRe = exts ? new RegExp(`(['"])([\\w./-]+\\.(?:${exts}))\\1`, 'gi') : undefined;
  text.split(/\r?\n/).forEach((line, i) => {
    if (refRe) for (const m of line.matchAll(refRe)) info.templateRefs.push({ path: m[2], line: i });
    KEY_PATTERNS.forEach((re, p) => {
      for (const m of line.matchAll(re)) {
        const key = m[2];
        const col = m.index! + m[0].lastIndexOf(key);
        const list = info.keys.get(key.toUpperCase());
        const occ = { line: i, col, len: key.length, direct: p === 0, name: key };
        if (list) list.push(occ);
        else info.keys.set(key.toUpperCase(), [occ]);
      }
    });
  });
  return info;
}

/** Does a template path written in code or an include (`dir/x.html`, `/x.html`) point at `fsPath`? */
export function pathEndsWith(fsPath: string, written: string): boolean {
  const target = fsPath.split(/[\\/]/).join('/');
  return target.endsWith('/' + written.replace(/^\/+/, '').replace(/^\.\//, ''));
}
