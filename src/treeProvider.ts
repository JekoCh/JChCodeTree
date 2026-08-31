import * as vscode from 'vscode';
import * as path from 'path';
import { parsePerlFunctions, parseJsFunctions, FunctionInfo } from './parsers';

const PERL_EXTS = new Set(['.pl', '.pm', '.cgi']);
const JS_EXTS = new Set(['.js']);

export type NodeKind = 'folder' | 'file' | 'function';

export interface SerializedNode {
  id: string;
  label: string;
  kind: NodeKind;
  line?: number;
  hasChildren: boolean;
}

export class TreeNode {
  functionsLoaded = false;
  children?: TreeNode[];

  constructor(
    public kind: NodeKind,
    public label: string,
    public uri: vscode.Uri,
    public parent?: TreeNode,
    public line?: number
  ) {}
}

function sortFolderChildren(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  for (const child of node.children) {
    if (child.kind === 'folder') sortFolderChildren(child);
  }
}

export class CodeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: TreeNode[] = [];
  /** fsPath -> file TreeNode, rebuilt on every refresh() for cursor-sync lookups */
  private fileIndex = new Map<string, TreeNode>();
  /** stable id (uri-based) -> node, used by the webview UI which can't hold object references */
  private allNodes = new Map<string, TreeNode>();

  constructor(private extensions: string[]) {}

  async refresh(): Promise<void> {
    await this.build();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label);
    if (node.kind === 'folder') {
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = 'folder';
    } else if (node.kind === 'file') {
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      const ext = path.extname(node.uri.fsPath).toLowerCase();
      const parseable = PERL_EXTS.has(ext) || JS_EXTS.has(ext);
      item.collapsibleState = parseable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      item.contextValue = 'file';
      item.command = { command: 'jchCodeTree.openItem', title: 'Open', arguments: [node] };
    } else {
      item.iconPath = new vscode.ThemeIcon('symbol-method');
      item.contextValue = 'function';
      item.command = { command: 'jchCodeTree.openItem', title: 'Open', arguments: [node] };
    }
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) return this.roots;
    if (node.kind === 'folder') return node.children ?? [];
    if (node.kind === 'file') {
      if (!node.functionsLoaded) await this.loadFunctions(node);
      return node.children ?? [];
    }
    return [];
  }

  getParent(node: TreeNode): vscode.ProviderResult<TreeNode> {
    return node.parent;
  }

  private async loadFunctions(fileNode: TreeNode): Promise<void> {
    fileNode.functionsLoaded = true;
    const ext = path.extname(fileNode.uri.fsPath).toLowerCase();
    let infos: FunctionInfo[] = [];
    try {
      const bytes = await vscode.workspace.fs.readFile(fileNode.uri);
      const text = Buffer.from(bytes).toString('utf8');
      if (PERL_EXTS.has(ext)) infos = parsePerlFunctions(text);
      else if (JS_EXTS.has(ext)) infos = parseJsFunctions(text);
    } catch {
      infos = [];
    }
    fileNode.children = infos.map(
      info => new TreeNode('function', info.name, fileNode.uri, fileNode, info.line)
    );
  }

  /** Drops the cached function list for a file so the next expand re-parses it from disk. */
  invalidateFile(uri: vscode.Uri): void {
    const node = this.fileIndex.get(uri.fsPath);
    if (node) {
      node.functionsLoaded = false;
      node.children = undefined;
      this._onDidChangeTreeData.fire(node);
    }
  }

  findFileNode(fsPath: string): TreeNode | undefined {
    return this.fileIndex.get(fsPath);
  }

  private isParseable(uri: vscode.Uri): boolean {
    const ext = path.extname(uri.fsPath).toLowerCase();
    return PERL_EXTS.has(ext) || JS_EXTS.has(ext);
  }

  /** Stable id derived from the node's uri (+ line for functions), so it survives a tree rebuild. */
  idFor(node: TreeNode): string {
    const id =
      node.kind === 'function' ? `${node.uri.toString()}::fn::${node.line}` : node.uri.toString();
    this.allNodes.set(id, node);
    return id;
  }

  resolveNode(id: string): TreeNode | undefined {
    return this.allNodes.get(id);
  }

  /** Serialized children for the webview UI, which can only exchange plain JSON with the extension host. */
  async getSerializedChildren(id?: string): Promise<SerializedNode[]> {
    let node: TreeNode | undefined;
    if (id !== undefined) {
      node = this.allNodes.get(id);
      if (!node) return []; // stale id (e.g. from before a full rebuild) - nothing to expand
    }
    const children = await this.getChildren(node);
    return children.map(c => ({
      id: this.idFor(c),
      label: c.label,
      kind: c.kind,
      line: c.line,
      hasChildren: c.kind === 'folder' || (c.kind === 'file' && this.isParseable(c.uri)),
    }));
  }

  /** Root-to-node id chain, so the webview can expand ancestors before revealing a node. */
  getAncestorChainIds(id: string): string[] {
    const node = this.allNodes.get(id);
    if (!node) return [];
    const chain: string[] = [];
    let current: TreeNode | undefined = node;
    while (current) {
      chain.unshift(this.idFor(current));
      current = current.parent;
    }
    return chain;
  }

  /** Returns the function node whose body covers the given 0-based line, or the file node if none matches. */
  async findFunctionAtLine(fsPath: string, line: number): Promise<TreeNode | undefined> {
    const fileNode = this.fileIndex.get(fsPath);
    if (!fileNode) return undefined;
    if (!fileNode.functionsLoaded) await this.loadFunctions(fileNode);
    const children = fileNode.children ?? [];
    let best: TreeNode | undefined;
    for (const child of children) {
      if (child.line !== undefined && child.line <= line) {
        if (!best || (best.line !== undefined && child.line > best.line)) best = child;
      }
    }
    return best ?? fileNode;
  }

  async findFunctionIdAtLine(fsPath: string, line: number): Promise<string | undefined> {
    const node = await this.findFunctionAtLine(fsPath, line);
    return node ? this.idFor(node) : undefined;
  }

  private async build(): Promise<void> {
    this.fileIndex.clear();
    this.allNodes.clear();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const globExts = this.extensions.map(e => e.replace(/^\./, '')).join(',');
    const roots: TreeNode[] = [];

    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, `**/*.{${globExts}}`);
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      const root = new TreeNode('folder', folder.name, folder.uri);
      root.children = [];
      const dirMap = new Map<string, TreeNode>();
      dirMap.set('', root);

      for (const uri of uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
        const rel = path.relative(folder.uri.fsPath, uri.fsPath);
        const parts = rel.split(path.sep);
        let dirKey = '';
        let parent = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const nextKey = dirKey ? `${dirKey}/${parts[i]}` : parts[i];
          let dirNode = dirMap.get(nextKey);
          if (!dirNode) {
            dirNode = new TreeNode('folder', parts[i], vscode.Uri.joinPath(folder.uri, nextKey), parent);
            dirNode.children = [];
            parent.children!.push(dirNode);
            dirMap.set(nextKey, dirNode);
          }
          parent = dirNode;
          dirKey = nextKey;
        }
        const fileNode = new TreeNode('file', parts[parts.length - 1], uri, parent);
        parent.children!.push(fileNode);
        this.fileIndex.set(uri.fsPath, fileNode);
      }

      sortFolderChildren(root);
      roots.push(root);
    }

    this.roots = roots;
  }
}
