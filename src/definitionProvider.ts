import * as vscode from 'vscode';
import * as path from 'path';
import { CodeTreeProvider, Lang, PERL_EXTS, JS_EXTS, SH_EXTS, langForExtension, SHEBANG_SHELL_RE, FILE_REF_RE } from './treeProvider';

// Mirrors PERL_SUB_RE's namespaced-sub capture (Foo::Bar::baz) and the JS patterns' $-prefixed names,
// so the clicked word matches the full name parsers.ts indexed the definition under.
const DEFINITION_WORD_RE = /[A-Za-z_$][\w$]*(?:::\w+)*/;

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
  const exts = [...PERL_EXTS, ...JS_EXTS, ...SH_EXTS];
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
    if (lang) {
      const range = document.getWordRangeAtPosition(position, DEFINITION_WORD_RE);
      if (range) {
        const locations = await this.provider.findDefinitions(document.getText(range), lang);
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
}
