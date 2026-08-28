import * as vscode from 'vscode';
import * as path from 'path';
import { CodeTreeProvider, TreeNode } from './treeProvider';

// TODO: make this a user setting; hardcoded for the first version.
const EXTENSIONS = ['.pl', '.pm', '.cgi', '.html', '.js', '.css'];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new CodeTreeProvider(EXTENSIONS);
  await provider.refresh();

  const treeView = vscode.window.createTreeView('jchCodeTree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('jchCodeTree.refresh', () => provider.refresh())
  );

  // Files only open on a second click within this window; a single click just
  // toggles the tree's expand/collapse (VS Code's default row-click behavior).
  // Functions have no children to expand, so they open on every click.
  const DOUBLE_CLICK_MS = 400;
  const lastFileClickAt = new Map<string, number>();

  context.subscriptions.push(
    vscode.commands.registerCommand('jchCodeTree.openItem', async (node: TreeNode) => {
      if (node.kind === 'file') {
        const key = node.uri.fsPath;
        const now = Date.now();
        const prev = lastFileClickAt.get(key);
        if (prev !== undefined && now - prev <= DOUBLE_CLICK_MS) {
          lastFileClickAt.delete(key);
        } else {
          lastFileClickAt.set(key, now);
          return;
        }
      }
      const doc = await vscode.workspace.openTextDocument(node.uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = node.kind === 'function' ? node.line ?? 0 : 0;
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    })
  );

  // Keep the tree in sync with files appearing/disappearing on disk.
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRebuild = () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => provider.refresh(), 300);
  };

  const globExts = EXTENSIONS.map(e => e.slice(1)).join(',');
  const watcher = vscode.workspace.createFileSystemWatcher(`**/*.{${globExts}}`);
  watcher.onDidCreate(scheduleRebuild);
  watcher.onDidDelete(scheduleRebuild);
  context.subscriptions.push(watcher);

  // Re-parse a file's function list once its edits are saved.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme === 'file') provider.invalidateFile(doc.uri);
    })
  );

  // Highlight the enclosing function in the tree as the cursor moves.
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      const uri = e.textEditor.document.uri;
      if (uri.scheme !== 'file') return;
      if (!EXTENSIONS.includes(path.extname(uri.fsPath).toLowerCase())) return;

      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(async () => {
        const line = e.selections[0].active.line;
        const node = await provider.findFunctionAtLine(uri.fsPath, line);
        if (!node) return;
        try {
          await treeView.reveal(node, { select: true, focus: false, expand: false });
        } catch {
          // tree not visible or node no longer present - not worth surfacing
        }
      }, 150);
    })
  );
}

export function deactivate(): void {}
