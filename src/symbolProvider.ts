import * as vscode from 'vscode';
import { CodeTreeProvider, Lang, PERL_EXTS, SH_EXTS, parseFunctions } from './treeProvider';
import { langForDocument } from './definitionProvider';

// JS/TS are left out: VS Code's built-in TypeScript support already provides their symbols,
// and adding ours would show every function twice in Outline and Ctrl+T.
const SYMBOL_LANGS = new Set<Lang>(['perl', 'sh']);

export function buildSymbolSelector(): vscode.DocumentSelector {
  const filters: vscode.DocumentFilter[] = [...PERL_EXTS, ...SH_EXTS].map(ext => ({ scheme: 'file', pattern: `**/*${ext}` }));
  filters.push({ scheme: 'file', language: 'shellscript' });
  return filters;
}

/** Outline, breadcrumbs and Ctrl+Shift+O. A function's range runs until the next one starts (no end detection). */
export class FunctionDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const lang = langForDocument(document);
    if (!lang || !SYMBOL_LANGS.has(lang)) return [];
    const infos = parseFunctions(lang, document.getText());
    return infos.map((info, i) => {
      const lastLine = i + 1 < infos.length ? infos[i + 1].line - 1 : document.lineCount - 1;
      const range = new vscode.Range(info.line, 0, lastLine, document.lineAt(lastLine).text.length);
      const selection = document.lineAt(info.line).range;
      return new vscode.DocumentSymbol(info.name, '', vscode.SymbolKind.Function, range, selection);
    });
  }
}

export class FunctionWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly provider: CodeTreeProvider) {}

  provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    return this.provider.searchSymbols(query, SYMBOL_LANGS);
  }
}
