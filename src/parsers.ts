export interface FunctionInfo {
  name: string;
  /** 0-based line index where the function starts */
  line: number;
}

/** Matches `sub name {`, `sub name;` (forward decl) is skipped by requiring a brace or end of line body. */
const PERL_SUB_RE = /^\s*sub\s+([A-Za-z_]\w*(?:::\w+)*)\b/;

const PERL_PACKAGE_RE = /^\s*package\s+([A-Za-z_]\w*(?:::\w+)*)/;

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

/** `package Foo::Bar;` (and block form `package Foo::Bar {`) lines, in file order. */
export function parsePerlPackages(text: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  for (const [line, i] of perlCodeLines(text)) {
    const m = PERL_PACKAGE_RE.exec(line);
    if (m) results.push({ name: m[1], line: i });
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
  // class method / object method shorthand: name(...) {  /  private async name(...): Type {
  /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*(?:static\s+)?(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/,
];

export function parseJsFunctions(text: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of JS_PATTERNS) {
      const m = re.exec(line);
      if (m && !JS_CONTROL_KEYWORDS.has(m[1])) {
        results.push({ name: m[1], line: i });
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
