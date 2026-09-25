import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { parsePerlFunctions, parseJsFunctions, parseShFunctions, FunctionInfo } from './parsers';

export const PERL_EXTS = new Set(['.pl', '.pm', '.cgi']);
export const JS_EXTS = new Set(['.js', '.ts', '.tsx']);
export const SH_EXTS = new Set(['.sh']);
export const SHEBANG_SHELL_RE = /^#!.*\b(?:bash|zsh|ksh|dash|sh)\b/;
/** A path-like token: something/like/this.ext — used to spot file references for "open this file". */
export const FILE_REF_RE = /[\w./-]+\.\w+/;
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'CVS']);

type NodeKind = 'folder' | 'file' | 'function';
export type Lang = 'perl' | 'js' | 'sh';

export function langForExtension(ext: string): Lang | undefined {
  if (PERL_EXTS.has(ext)) return 'perl';
  if (JS_EXTS.has(ext)) return 'js';
  if (SH_EXTS.has(ext)) return 'sh';
  return undefined;
}

export function parseFunctions(lang: Lang, text: string): FunctionInfo[] {
  if (lang === 'perl') return parsePerlFunctions(text);
  if (lang === 'js') return parseJsFunctions(text);
  return parseShFunctions(text);
}

export class TreeNode {
  functionsLoaded = false;
  children?: TreeNode[];
  lang?: Lang;

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
  private readonly extensionSet: Set<string>;
  /** name -> definition locations, lazily built across the whole project; dropped on any change. */
  private definitionIndex?: Map<string, { uri: vscode.Uri; line: number; lang: Lang }[]>;

  constructor(private extensions: string[]) {
    this.extensionSet = new Set(extensions.map(e => e.toLowerCase()));
  }

  async refresh(): Promise<void> {
    await this.build();
    this.definitionIndex = undefined;
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
      const parseable = node.lang !== undefined;
      item.collapsibleState = parseable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      item.contextValue = 'file';
      item.command = { command: 'JChCodeTree.openItem', title: 'Open', arguments: [node] };
    } else {
      item.iconPath = new vscode.ThemeIcon('symbol-method');
      item.contextValue = 'function';
      item.command = { command: 'JChCodeTree.openItem', title: 'Open', arguments: [node] };
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
    let infos: FunctionInfo[] = [];
    try {
      // An open editor may hold unsaved edits - parse what the user sees, not the disk copy.
      const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fileNode.uri.fsPath);
      const text = openDoc
        ? openDoc.getText()
        : Buffer.from(await vscode.workspace.fs.readFile(fileNode.uri)).toString('utf8');
      infos = parseFunctions(fileNode.lang!, text);
    } catch {
      infos = [];
    }
    fileNode.children = infos.map(
      info => new TreeNode('function', info.name, fileNode.uri, fileNode, info.line)
    );
  }

  /** Drops the cached function list for a file so the next expand re-parses it. */
  async invalidateFile(uri: vscode.Uri): Promise<void> {
    const node = await this.resolveFileNode(uri.fsPath);
    if (node) {
      node.functionsLoaded = false;
      node.children = undefined;
      this.definitionIndex = undefined;
      this._onDidChangeTreeData.fire(node);
    }
  }

  private async ensureDefinitionIndex(): Promise<Map<string, { uri: vscode.Uri; line: number; lang: Lang }[]>> {
    if (this.definitionIndex) return this.definitionIndex;
    const fileNodes = [...this.fileIndex.values()].filter(n => n.lang !== undefined);
    await Promise.all(fileNodes.map(n => (n.functionsLoaded ? Promise.resolve() : this.loadFunctions(n))));

    const index = new Map<string, { uri: vscode.Uri; line: number; lang: Lang }[]>();
    for (const fileNode of fileNodes) {
      for (const child of fileNode.children ?? []) {
        const entry = { uri: fileNode.uri, line: child.line ?? 0, lang: fileNode.lang! };
        const list = index.get(child.label);
        if (list) list.push(entry);
        else index.set(child.label, [entry]);
      }
    }
    this.definitionIndex = index;
    return index;
  }

  /** Project-wide lookup for Go to Definition, restricted to the caller's language. */
  async findDefinitions(name: string, lang: Lang): Promise<vscode.Location[]> {
    const index = await this.ensureDefinitionIndex();
    return (index.get(name) ?? [])
      .filter(e => e.lang === lang)
      .map(e => new vscode.Location(e.uri, new vscode.Position(e.line, 0)));
  }

  /** Project-wide function search for Ctrl+T: case-insensitive, query chars in order (VS Code re-scores). */
  async searchSymbols(query: string, langs: Set<Lang>): Promise<vscode.SymbolInformation[]> {
    const index = await this.ensureDefinitionIndex();
    const q = query.toLowerCase();
    const matches = (name: string): boolean => {
      const n = name.toLowerCase();
      let i = 0;
      for (const ch of n) if (ch === q[i]) i++;
      return i === q.length;
    };
    const results: vscode.SymbolInformation[] = [];
    for (const [name, entries] of index) {
      if (!matches(name)) continue;
      for (const e of entries) {
        if (!langs.has(e.lang)) continue;
        results.push(new vscode.SymbolInformation(
          name,
          vscode.SymbolKind.Function,
          vscode.workspace.asRelativePath(e.uri),
          new vscode.Location(e.uri, new vscode.Position(e.line, 0))
        ));
      }
    }
    return results;
  }

  findFileNode(fsPath: string): TreeNode | undefined {
    return this.fileIndex.get(fsPath);
  }

  /**
   * Resolves a path-like piece of text (e.g. from a require/include/import) to the file it
   * points at: first relative to `fromUri`'s directory, then by matching basename anywhere
   * in the project (approximate, same "good enough" philosophy as the function parsers).
   */
  async resolveFileReference(rawText: string, fromUri: vscode.Uri): Promise<vscode.Location[]> {
    const dir = vscode.Uri.joinPath(fromUri, '..');
    const candidate = vscode.Uri.joinPath(dir, rawText);
    if (await this.fileExists(candidate)) {
      const target = candidate.scheme === 'file' ? vscode.Uri.file(await fsp.realpath(candidate.fsPath)) : candidate;
      return [new vscode.Location(target, new vscode.Position(0, 0))];
    }

    const base = path.basename(rawText);
    const matches = [...this.fileIndex.values()].filter(n => path.basename(n.uri.fsPath) === base);
    return matches.map(n => new vscode.Location(n.uri, new vscode.Position(0, 0)));
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  }

  /** Returns the function node whose body covers the given 0-based line, or the file node if none matches. */
  async findFunctionAtLine(fsPath: string, line: number): Promise<TreeNode | undefined> {
    const fileNode = await this.resolveFileNode(fsPath);
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

  /** Tree node for a path; a file opened through a hidden symlink maps to its real file's node. */
  private async resolveFileNode(fsPath: string): Promise<TreeNode | undefined> {
    const node = this.fileIndex.get(fsPath);
    if (node) return node;
    try {
      return this.fileIndex.get(await fsp.realpath(fsPath));
    } catch {
      return undefined;
    }
  }

  /** Lists files under `root`, following symlinks (independent of search.followSymlinks). */
  private async walkFolder(root: vscode.Uri, showHidden: boolean): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    // Loop guard is per ancestor chain, so `linkdir -> real` still shows alongside `real`.
    const visit = async (dir: vscode.Uri, ancestors: string[]): Promise<void> => {
      let real: string;
      let entries: [string, vscode.FileType][];
      try {
        real = await fsp.realpath(dir.fsPath);
        if (ancestors.includes(real)) return;
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      const chain = [...ancestors, real];
      await Promise.all(entries.map(async ([name, type]) => {
        if (WALK_SKIP_DIRS.has(name) || (!showHidden && name.startsWith('.'))) return;
        const uri = vscode.Uri.joinPath(dir, name);
        if (type & vscode.FileType.Directory) await visit(uri, chain);
        else if (type & vscode.FileType.File) files.push(uri);
      }));
    };
    await visit(root, []);
    return files;
  }

  /** True when the file itself or any folder between it and the workspace root is a symlink (or broken). */
  private async isViaSymlink(uri: vscode.Uri, rootFsPath: string, realRoot: string): Promise<boolean> {
    try {
      const real = await fsp.realpath(uri.fsPath);
      return real !== path.join(realRoot, path.relative(rootFsPath, uri.fsPath));
    } catch {
      return true;
    }
  }

  /** Decides whether a file belongs in the tree and, if so, which parser (if any) applies to it. */
  private async classify(uri: vscode.Uri): Promise<Lang | 'plain' | 'skip'> {
    const ext = path.extname(uri.fsPath).toLowerCase();
    const known = langForExtension(ext);
    if (known) return known;
    if (ext) return this.extensionSet.has(ext) ? 'plain' : 'skip';

    // Extensionless files only qualify when they look like a shell script.
    if (path.basename(uri.fsPath).startsWith('.')) return 'skip';
    try {
      const firstLine = (await this.readHead(uri)).split(/\r?\n/, 1)[0];
      return SHEBANG_SHELL_RE.test(firstLine) ? 'sh' : 'skip';
    } catch {
      return 'skip';
    }
  }

  /** First bytes of a file - enough for a shebang, without reading big extensionless files whole. */
  private async readHead(uri: vscode.Uri): Promise<string> {
    if (uri.scheme !== 'file') return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const fh = await fsp.open(uri.fsPath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  private async build(): Promise<void> {
    this.fileIndex.clear();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots: TreeNode[] = [];
    const config = vscode.workspace.getConfiguration('JChCodeTree');
    const showHidden = config.get<boolean>('showHiddenFiles', false);
    const showSymlinks = config.get<boolean>('showSymlinks', false);

    for (const folder of folders) {
      if (!showHidden && path.basename(folder.uri.fsPath).startsWith('.')) continue;
      const uris = showSymlinks
        ? await this.walkFolder(folder.uri, showHidden)
        : await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/{node_modules,.git}/**');
      const realRoot = !showSymlinks && folder.uri.scheme === 'file'
        ? await fsp.realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath)
        : undefined;
      const classified = await Promise.all(
        uris.map(async uri => {
          if (!showHidden && path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).some(p => p.startsWith('.'))) {
            return { uri, lang: 'skip' as const };
          }
          if (realRoot && await this.isViaSymlink(uri, folder.uri.fsPath, realRoot)) {
            return { uri, lang: 'skip' as const };
          }
          return { uri, lang: await this.classify(uri) };
        })
      );
      const included = classified
        .filter((c): c is { uri: vscode.Uri; lang: Lang | 'plain' } => c.lang !== 'skip')
        .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));

      const root = new TreeNode('folder', folder.name, folder.uri);
      root.children = [];
      const dirMap = new Map<string, TreeNode>();
      dirMap.set('', root);

      for (const { uri, lang } of included) {
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
        fileNode.lang = lang === 'plain' ? undefined : lang;
        parent.children!.push(fileNode);
        this.fileIndex.set(uri.fsPath, fileNode);
      }

      sortFolderChildren(root);
      roots.push(root);
    }

    this.roots = roots;
  }
}
