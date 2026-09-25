import * as vscode from 'vscode';
import { CodeTreeProvider, Lang, extensionsFor, parseFunctions } from './treeProvider';
import { DEFINITION_WORD_RE, langForDocument } from './definitionProvider';

// JS/TS are left out: VS Code's built-in TypeScript support already provides their symbols
// and references, and adding ours would show every result twice.
const SYMBOL_LANGS = new Set<Lang>(['perl', 'sh']);

export function buildSymbolSelector(): vscode.DocumentSelector {
  const filters: vscode.DocumentFilter[] = [...extensionsFor('perl'), ...extensionsFor('sh')]
    .map(ext => ({ scheme: 'file', pattern: `**/*${ext}` }));
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

export class FunctionReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly provider: CodeTreeProvider) {}

  async provideReferences(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[]> {
    const lang = langForDocument(document);
    if (!lang || !SYMBOL_LANGS.has(lang)) return [];
    const range = document.getWordRangeAtPosition(position, DEFINITION_WORD_RE);
    if (!range) return [];
    return this.provider.findReferences(document.getText(range), lang);
  }
}
