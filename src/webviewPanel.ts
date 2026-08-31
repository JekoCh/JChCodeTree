import * as vscode from 'vscode';
import { CodeTreeProvider, TreeNode } from './treeProvider';

/**
 * Mirrors the sidebar tree as an editor-area tab. VS Code reliably lets editor
 * tabs be dragged out into a separate OS window (unlike sidebar/panel views,
 * which don't support that in this VS Code version) - that's the whole reason
 * this exists alongside the native TreeView.
 */
export class CodeTreeWebview {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly provider: CodeTreeProvider,
    private readonly openNode: (node: TreeNode) => Promise<void>
  ) {}

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'jchCodeTreeWebview',
      'Code Tree',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (message: any) => {
      switch (message.type) {
        case 'ready': {
          const children = await this.provider.getSerializedChildren();
          this.post({ type: 'root', children });
          break;
        }
        case 'expand': {
          const children = await this.provider.getSerializedChildren(message.id);
          this.post({ type: 'children', id: message.id, children, awaitingPath: message.awaitingPath });
          break;
        }
        case 'open': {
          const node = this.provider.resolveNode(message.id);
          if (node) await this.openNode(node);
          break;
        }
      }
    });
  }

  /** A file's cached functions went stale (saved); re-fetch it in the webview if it's expanded there. */
  notifyInvalidated(node: TreeNode): void {
    this.post({ type: 'invalidated', id: this.provider.idFor(node) });
  }

  /** Files/folders appeared or disappeared - ask the webview to reload from root. */
  notifyReload(): void {
    this.post({ type: 'reload' });
  }

  highlight(id: string | undefined): void {
    const path = id ? this.provider.getAncestorChainIds(id) : [];
    this.post({ type: 'highlight', path });
  }

  private post(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css')
    );
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicon', 'codicon.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js')
    );
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconCssUri}">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<ul id="tree" role="tree"></ul>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
