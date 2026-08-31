import * as vscode from 'vscode';
import * as path from 'path';
import { CodeTreeProvider, TreeNode } from './treeProvider';
import { CodeTreeWebview } from './webviewPanel';

// TODO: make this a user setting; hardcoded for the first version.
const EXTENSIONS = ['.pl', '.pm', '.cgi', '.html', '.js', '.css'];

async function openNodeInEditor(node: TreeNode, viewColumn?: vscode.ViewColumn): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(node.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn });
  const line = node.kind === 'function' ? node.line ?? 0 : 0;
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new CodeTreeProvider(EXTENSIONS);
  await provider.refresh();

  const treeView = vscode.window.createTreeView('jchCodeTree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Once the webview tab is dragged into its own OS window, "the active editor
  // column" resolves to wherever the user last clicked - which can be that
  // same detached window. Pin webview-triggered opens to column one so files
  // always land back in the main project window instead.
  const webview = new CodeTreeWebview(context, provider, node =>
    openNodeInEditor(node, vscode.ViewColumn.One)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jchCodeTree.refresh', () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jchCodeTree.openInEditor', () => webview.reveal())
  );

  // In the sidebar tree, files only open on a second click within this window;
  // a single click just toggles expand/collapse (VS Code's default row-click
  // behavior). Functions have no children to expand, so they open on every
  // click. The webview editor tab handles this itself via real dblclick events,
  // so it calls openNodeInEditor directly instead of going through this command.
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
      await openNodeInEditor(node);
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

  // Relay the same tree-data-changed signal (per-file invalidation, or a full
  // rebuild) to the webview editor tab, if it's open.
  context.subscriptions.push(
    provider.onDidChangeTreeData(node => {
      if (!webview.isOpen) return;
      if (node) webview.notifyInvalidated(node);
      else webview.notifyReload();
    })
  );

  // Highlight the enclosing function in both the sidebar tree and the webview
  // (if open) as the cursor moves.
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
        if (node) {
          try {
            await treeView.reveal(node, { select: true, focus: false, expand: false });
          } catch {
            // tree not visible or node no longer present - not worth surfacing
          }
        }
        if (webview.isOpen) {
          const id = await provider.findFunctionIdAtLine(uri.fsPath, line);
          webview.highlight(id);
        }
      }, 150);
    })
  );
}

export function deactivate(): void {}
