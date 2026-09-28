export interface FunctionInfo {
  name: string;
  /** 0-based line index where the function starts */
  line: number;
  /** JS: the object path before the name - `App.Admin` in `App.Admin.check = function` */
  qualifier?: string;
}

/** Matches `sub name {`, `sub name;` (forward decl) is skipped by requiring a brace or end of line body. */
const PERL_SUB_RE = /^\s*sub\s+([A-Za-z_]\w*(?:::\w+)*)\b/;

/** `package Foo::Bar;` / `package Foo::Bar 1.2 {` (group 2 = `;` or `{`), or a lone brace. */
const PERL_PACKAGE_TOKEN_RE = /\bpackage\s+([A-Za-z_]\w*(?:::\w+)*)(?:\s+v?[\d._]+)?\s*([;{])|[{}]/g;
/** `<<EOF`, `<<"EOF"`, `<<'EOF'`, `<<~EOF` - the body lines until the terminator are skipped. */
const PERL_HEREDOC_RE = /<<(~?)(?:"([^"]+)"|'([^']+)'|([A-Za-z_]\w*))/g;

/** Perl source lines with their index, skipping POD blocks (=head1 ... =cut) and stopping at __END__/__DATA__. */
function perlCodeLines(text: string): [string, number][] {
  const out: [string, number][] = [];
  const lines = text.split(/\r?\n/);
  let inPod = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^=[a-zA-Z]/.test(line)) {
      inPod = !line.startsWith('=cut');
      continue;
    }
    if (inPod) continue;
    if (/^__(?:END|DATA)__\b/.test(line)) break;
    out.push([line, i]);
  }
  return out;
}

export function parsePerlFunctions(text: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  for (const [line, i] of perlCodeLines(text)) {
    const m = PERL_SUB_RE.exec(line);
    if (m) {
      results.push({ name: m[1], line: i });
    }
  }
  return results;
}

export interface PackageInfo extends FunctionInfo {
  /** false for the implicit switch back to the outer package where a package's block closes */
  declared: boolean;
}

/** A line with string literals, escaped braces and `#` comments removed, for brace counting. */
function perlCodeOnly(line: string): string {
  return line
    .replace(/\\./g, '')
    .replace(/"[^"]*"|'[^']*'/g, '')
    .replace(/(^|[^$])#.*/, '$1');
}

/**
 * Package switches in file order. A package lasts until the end of the block it is declared in:
 * `package Foo { ... }` until its closing brace, `{ package Foo; ... }` until the enclosing `}`,
 * a file-level `package Foo;` until the next one. Where a scope ends, a `declared: false` entry
 * switches back to the outer package (`main` at file level). Braces are counted approximately:
 * strings, comments and heredoc bodies are skipped, regexes are not.
 */
export function parsePerlPackages(text: string): PackageInfo[] {
  const results: PackageInfo[] = [];
  const scopes: { name: string; depth: number }[] = [];   // active package scopes, innermost last
  const current = () => scopes[scopes.length - 1]?.name ?? 'main';
  let depth = 0;
  let heredocEnd: { tag: string; indented: boolean }[] = [];
  for (const [line, i] of perlCodeLines(text)) {
    if (heredocEnd.length) {
      const { tag, indented } = heredocEnd[0];
      if ((indented ? line.trim() : line) === tag) heredocEnd.shift();
      continue;
    }
    const code = perlCodeOnly(line);
    for (const m of code.matchAll(PERL_PACKAGE_TOKEN_RE)) {
      if (m[1]) {
        results.push({ name: m[1], line: i, declared: true });
        if (m[2] === '{') depth++;
        scopes.push({ name: m[1], depth });
      } else if (m[0] === '{') {
        depth++;
      } else {
        depth = Math.max(0, depth - 1);
        const before = current();
        while (scopes.length && depth < scopes[scopes.length - 1].depth) scopes.pop();
        if (current() !== before) results.push({ name: current(), line: i, declared: false });
      }
    }
    heredocEnd = [...line.matchAll(PERL_HEREDOC_RE)].map(h => ({ tag: h[2] ?? h[3] ?? h[4], indented: h[1] === '~' }));
  }
  return results;
}

const JS_CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return',
  'else', 'do', 'with', 'try', 'finally',
]);

const JS_PATTERNS: RegExp[] = [
  // function foo(...)  /  export async function* foo<T>(...)
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/,
  // const foo = function(...)
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
  // const foo = (...) => ...   /  const foo = (x: string): number => ...
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=>{]+)?=>/,
  // foo = function(...)  /  App.save = function(...)  /  this.x = (a) => ...
  // DOM event handlers (`el.onclick = function`) are skipped: anonymous callbacks, not named functions.
  /^\s*(?:(?<qualifier>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.)?(?!on(?:click|dblclick|mouse[a-z]*|key[a-z]*|load|unload|beforeunload|change|input|submit|reset|focus|focusin|focusout|blur|error|abort|resize|scroll|select|contextmenu|drag[a-z]*|drop|touch[a-z]*|pointer[a-z]*|wheel|readystatechange|message|open|close|progress|timeout|hashchange|popstate|storage|paste|copy|cut|animation[a-z]*|transition[a-z]*)\s*=)(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/,
  // class method / object method shorthand: name(...) {  /  private async name(...): Type {
  // A `function` inside the parens means a call taking a callback (`$(function() {`, `setTimeout(function () {`).
  /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*(?:static\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?![^)]*\bfunction\b)[^)]*\)\s*(?::\s*[^{]+)?\{/,
];

export function parseJsFunctions(text: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of JS_PATTERNS) {
      const m = re.exec(line);
      const name = m?.groups?.name ?? m?.[1];
      if (name && !JS_CONTROL_KEYWORDS.has(name)) {
        const qualifier = m!.groups?.qualifier;
        results.push(qualifier ? { name, line: i, qualifier } : { name, line: i });
        break;
      }
    }
  }
  return results;
}

/** JS functions inside <script>...</script> blocks; everything else is blanked out so line numbers stay put. */
export function parseHtmlFunctions(text: string): FunctionInfo[] {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let masked = '';
  let pos = 0;
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const bodyStart = m.index! + m[0].indexOf('>') + 1;
    masked += blank(text.slice(pos, bodyStart)) + m[1];
    pos = bodyStart + m[1].length;
  }
  masked += blank(text.slice(pos));
  return parseJsFunctions(masked);
}

const SH_PATTERNS: RegExp[] = [
  // function name {  /  function name() {
  /^\s*function\s+([A-Za-z_]\w*)\s*(?:\(\))?\s*\{/,
  // name() {
  /^\s*([A-Za-z_]\w*)\s*\(\)\s*\{/,
];

export function parseShFunctions(text: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of SH_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        results.push({ name: m[1], line: i });
        break;
      }
    }
  }
  return results;
}
