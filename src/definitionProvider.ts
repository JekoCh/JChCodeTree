import * as vscode from 'vscode';
import * as path from 'path';
import { CodeTreeProvider, Lang, extensionsFor, langForExtension, packageAtLine, SHEBANG_SHELL_RE, FILE_REF_RE } from './treeProvider';
import { parsePerlPackages } from './parsers';
import { templateKeyAt } from './templates';

// Mirrors PERL_SUB_RE's namespaced-sub capture (Foo::Bar::baz) and the JS patterns' $-prefixed names,
// so the clicked word matches the full name parsers.ts indexed the definition under.
export const DEFINITION_WORD_RE = /[A-Za-z_$][\w$]*(?:::\w+)*/;
/** `Foo::Bar->` right before the word (a class-method call); `$obj->` is excluded by the lookbehind. */
const CLASS_ARROW_RE = /(?<![$@%\w:])([A-Za-z_]\w*(?:::\w+)*)\s*->\s*$/;

/** `App.Admin.` right before the word (a member call); `$obj.`/`this.` included. */
const JS_MEMBER_RE = /(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*$/;

/**
 * The object path a JS call is made on: `App.save()` -> `App`. A member call on
 * something that isn't a plain path (`$('#x').val()`) gets '?', which matches no definition -
 * so it is never pinned to a same-named function in the caller's file.
 */
function jsQualifier(document: vscode.TextDocument, range: vscode.Range): string | undefined {
  const before = document.lineAt(range.start.line).text.slice(0, range.start.character);
  if (!/\.\s*$/.test(before)) return undefined;
  return JS_MEMBER_RE.exec(before)?.[1] ?? '?';
}

/** Same classification as treeProvider's classify(), but off an already-open document (no disk read). */
export function langForDocument(doc: vscode.TextDocument): Lang | undefined {
  const ext = path.extname(doc.uri.fsPath).toLowerCase();
  const known = langForExtension(ext);
  if (known) return known;
  if (ext) return undefined;
  if (path.basename(doc.uri.fsPath).startsWith('.')) return undefined;
  return SHEBANG_SHELL_RE.test(doc.lineAt(0).text) ? 'sh' : undefined;
}

export function buildDefinitionSelector(): vscode.DocumentSelector {
  const exts = [...extensionsFor('perl'), ...extensionsFor('js'), ...extensionsFor('html'), ...extensionsFor('sh')];
  const filters: vscode.DocumentFilter[] = exts.map(ext => ({ scheme: 'file', pattern: `**/*${ext}` }));
  filters.push({ scheme: 'file', language: 'shellscript' });
  return filters;
}

export class FunctionDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly provider: CodeTreeProvider) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | undefined> {
    const lang = langForDocument(document);
    // A variable in <TMPL_VAR/IF/UNLESS/LOOP ...>: where Perl sets it.
    if (lang === 'html') {
      const key = templateKeyAt(document.lineAt(position.line).text, position.character);
      if (key) {
        const locations = await this.provider.findTemplateKey(key, document.uri);
        if (locations.length) return locations;
      }
    }
    if (lang) {
      const range = document.getWordRangeAtPosition(position, DEFINITION_WORD_RE);
      if (range) {
        const word = document.getText(range);
        const locations = lang === 'perl'
          ? await this.perlDefinitions(document, range, word)
          : await this.provider.findDefinitions(word, lang, {
            uri: document.uri,
            qualifier: lang === 'sh' ? undefined : jsQualifier(document, range),
          });
        if (locations.length) return locations;
      }
    }

    // Not a known function (or an unrecognized-lang doc) - maybe the cursor is on a file reference.
    const fileRange = document.getWordRangeAtPosition(position, FILE_REF_RE);
    if (fileRange) {
      const locations = await this.provider.resolveFileReference(document.getText(fileRange), document.uri);
      if (locations.length) return locations;
    }

    return undefined;
  }

  /**
   * `Foo::bar`: a sub declared by that full name, else the package `Foo::bar` itself, else `bar` in package Foo.
   * `bar`: the sub, narrowed by `Foo->bar` / `__PACKAGE__->bar` or the caller's package; else package `bar`
   * (`use Utils;`, the `Foo` in `Foo->new`).
   */
  private async perlDefinitions(document: vscode.TextDocument, range: vscode.Range, word: string): Promise<vscode.Location[]> {
    const pkg = packageAtLine(parsePerlPackages(document.getText()), range.start.line);
    const from = { uri: document.uri, pkg };

    const sep = word.lastIndexOf('::');
    if (sep > 0) {
      const exact = await this.provider.findDefinitions(word, 'perl', from);
      if (exact.length) return exact;
      const module = await this.provider.findPackage(word);
      if (module.length) return module;
      return this.provider.findDefinitions(word.slice(sep + 2), 'perl', { ...from, qualifier: word.slice(0, sep) });
    }

    const before = document.lineAt(range.start.line).text.slice(0, range.start.character);
    const cls = CLASS_ARROW_RE.exec(before)?.[1];
    const qualifier = cls === '__PACKAGE__' ? pkg : cls;
    const subs = await this.provider.findDefinitions(word, 'perl', { ...from, qualifier });
    return subs.length ? subs : this.provider.findPackage(word);
  }
}
