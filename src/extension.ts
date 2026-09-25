import * as vscode from 'vscode';
import * as path from 'path';
import { CodeTreeProvider, TreeNode, FILE_REF_RE } from './treeProvider';
import { FunctionDefinitionProvider, buildDefinitionSelector } from './definitionProvider';
import { FunctionDocumentSymbolProvider, FunctionWorkspaceSymbolProvider, buildSymbolSelector } from './symbolProvider';
import { checkForUpdate } from './updater';

// TODO: make this a user setting; hardcoded for the first version.
// Extensionless shell scripts (detected via shebang) are handled separately in treeProvider.ts.
const EXTENSIONS = ['.pl', '.pm', '.cgi', '.html', '.js', '.css', '.ts', '.tsx', '.sh', '.json'];

async function openNodeInEditor(node: TreeNode): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(node.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const line = node.kind === 'function' ? node.line ?? 0 : 0;
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function openLocation(location: vscode.Location): Promise<void> {
  await vscode.window.showTextDocument(location.uri, {
    preview: false,
    selection: new vscode.Range(location.range.start, location.range.start),
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  void checkForUpdate(context);

  const provider = new CodeTreeProvider(EXTENSIONS);
  await provider.refresh();

  const treeView = vscode.window.createTreeView('JChCodeTree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('JChCodeTree.refresh', () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(buildDefinitionSelector(), new FunctionDefinitionProvider(provider)),
    vscode.languages.registerDocumentSymbolProvider(buildSymbolSelector(), new FunctionDocumentSymbolProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new FunctionWorkspaceSymbolProvider(provider))
  );

  // Tree context menu.
  context.subscriptions.push(
    vscode.commands.registerCommand('JChCodeTree.copyName', (node: TreeNode) =>
      vscode.env.clipboard.writeText(node.label)),
    vscode.commands.registerCommand('JChCodeTree.copyRelativePath', (node: TreeNode) =>
      vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(node.uri, false))),
    vscode.commands.registerCommand('JChCodeTree.openToSide', async (node: TreeNode) => {
      const pos = new vscode.Position(node.kind === 'function' ? node.line ?? 0 : 0, 0);
      await vscode.window.showTextDocument(node.uri, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(pos, pos),
      });
    }),
    vscode.commands.registerCommand('JChCodeTree.revealInExplorer', (node: TreeNode) =>
      vscode.commands.executeCommand('revealInExplorer', node.uri))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('JChCodeTree.openSelectedFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const range = editor.document.getWordRangeAtPosition(editor.selection.active, FILE_REF_RE);
      if (!range) {
        vscode.window.setStatusBarMessage('Code Tree: no file reference under the cursor', 2000);
        return;
      }

      const text = editor.document.getText(range);
      const locations = await provider.resolveFileReference(text, editor.document.uri);
      if (locations.length === 0) {
        vscode.window.setStatusBarMessage(`Code Tree: no file found for "${text}"`, 2000);
        return;
      }

      if (locations.length === 1) {
        await openLocation(locations[0]);
        return;
      }

      const picked = await vscode.window.showQuickPick(
        locations.map(loc => ({ label: vscode.workspace.asRelativePath(loc.uri), location: loc })),
        { placeHolder: `Multiple matches for "${text}"` }
      );
      if (picked) await openLocation(picked.location);
    })
  );

  // Files only open on a second click within this window; a single click just
  // toggles the tree's expand/collapse (VS Code's default row-click behavior).
  // Functions have no children to expand, so they open on every click.
  const DOUBLE_CLICK_MS = 400;
  const lastFileClickAt = new Map<string, number>();

  context.subscriptions.push(
    vscode.commands.registerCommand('JChCodeTree.openItem', async (node: TreeNode) => {
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

  // Watches everything (not just known extensions) so extensionless shell scripts
  // appearing/disappearing also trigger a rebuild; scheduleRebuild is debounced.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(scheduleRebuild);
  watcher.onDidDelete(scheduleRebuild);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('JChCodeTree.showHiddenFiles') || e.affectsConfiguration('JChCodeTree.showSymlinks')) {
        provider.refresh();
      }
    })
  );

  // Re-parse a file's function list as it is edited (debounced per file), and when it is
  // closed, since unsaved edits it was parsed from may have been discarded.
  const editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const uri = e.document.uri;
      if (uri.scheme !== 'file' || e.contentChanges.length === 0) return;
      clearTimeout(editTimers.get(uri.fsPath));
      editTimers.set(uri.fsPath, setTimeout(() => {
        editTimers.delete(uri.fsPath);
        provider.invalidateFile(uri);
      }, 500));
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.scheme === 'file') provider.invalidateFile(doc.uri);
    })
  );

  // Highlight the enclosing function in the tree as the cursor moves.
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      const uri = e.textEditor.document.uri;
      if (uri.scheme !== 'file') return;

      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(async () => {
        const line = e.selections[0].active.line;
        const node = await provider.findFunctionAtLine(uri.fsPath, line);
        // reveal() forces the view visible even when the user closed/hid it,
        // so only call it while the tree is already showing.
        if (node && treeView.visible) {
          try {
            await treeView.reveal(node, { select: true, focus: false, expand: false });
          } catch {
            // node no longer present - not worth surfacing
          }
        }
      }, 150);
    })
  );
}

export function deactivate(): void {}
