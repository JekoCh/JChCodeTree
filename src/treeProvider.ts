import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { parsePerlFunctions, parsePerlPackages, parseJsFunctions, parseHtmlFunctions, parseShFunctions, FunctionInfo, PackageInfo } from './parsers';

export const SHEBANG_SHELL_RE = /^#!.*\b(?:bash|zsh|ksh|dash|sh)\b/;
/** A path-like token: something/like/this.ext — used to spot file references for "open this file". */
export const FILE_REF_RE = /[\w./-]+\.\w+/;
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'CVS']);

type NodeKind = 'folder' | 'file' | 'package' | 'function';
export type Lang = 'perl' | 'js' | 'html' | 'sh';
const LANGS = new Set<string>(['perl', 'js', 'html', 'sh']);

/** Functions in HTML <script> blocks are JS: calls between .html and .js files resolve to each other. */
function langFamily(lang: Lang): Lang {
  return lang === 'html' ? 'js' : lang;
}

type DefEntry = { uri: vscode.Uri; line: number; lang: Lang; /** Perl: package in effect at the sub */ pkg?: string };

/** Shown extension -> its parser ('none' = shown without functions). Reloaded from settings on every build(). */
let extensionKinds = new Map<string, Lang | 'none'>();

/** Reads JChCodeTree.extensions; VS Code merges the user's entries over the package.json defaults. */
function loadExtensionSetting(): void {
  const raw = vscode.workspace.getConfiguration('JChCodeTree').get<Record<string, string>>('extensions', {});
  extensionKinds = new Map();
  for (const [ext, kind] of Object.entries(raw)) {
    if (kind === 'hide') continue;
    const key = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
    extensionKinds.set(key, LANGS.has(kind) ? kind as Lang : 'none');
  }
}

export function extensionsFor(lang: Lang): string[] {
  return [...extensionKinds].filter(([, kind]) => kind === lang).map(([ext]) => ext);
}

export function langForExtension(ext: string): Lang | undefined {
  const kind = extensionKinds.get(ext);
  return kind === 'none' ? undefined : kind;
}

/** Minimal VS Code-style glob -> RegExp (**, *, ?, {a,b}, [...]), for '/'-separated workspace-relative paths. */
function globToRegExp(glob: string): RegExp {
  glob = glob.replace(/^\/+|\/+$/g, '');
  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // '**/' is zero or more folders; any other '**' is anything
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; inGroup = true; }
    else if (c === '}' && inGroup) { re += ')'; inGroup = false; }
    else if (c === ',' && inGroup) re += '|';
    else if (c === '[' && glob.indexOf(']', i) > i) {
      const end = glob.indexOf(']', i);
      re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** True when the relative path, or any folder on the way to it, matches one of the patterns. */
function isExcluded(rel: string, excludes: RegExp[]): boolean {
  if (!excludes.length) return false;
  const parts = rel.split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (excludes.some(re => re.test(prefix))) return true;
  }
  return false;
}

export function parseFunctions(lang: Lang, text: string): FunctionInfo[] {
  if (lang === 'perl') return parsePerlFunctions(text);
  if (lang === 'js') return parseJsFunctions(text);
  if (lang === 'html') return parseHtmlFunctions(text);
  return parseShFunctions(text);
}

/** Perl package in effect at a 0-based line ('main' before any `package` statement). */
export function packageAtLine(packages: FunctionInfo[], line: number): string {
  let pkg = 'main';
  for (const p of packages) {
    if (p.line > line) break;
    pkg = p.name;
  }
  return pkg;
}

export class TreeNode {
  /** File nodes: the in-progress/finished function parse; cleared by invalidateFile() */
  loading?: Promise<void>;
  /** File nodes: bumped by invalidateFile(), so a parse that was overtaken doesn't write stale results */
  loadGen = 0;
  children?: TreeNode[];
  lang?: Lang;
  /** Perl files: `package` statements, loaded together with the functions */
  packages?: PackageInfo[];
  /** File nodes: every function node, flat - `children` may group them under package nodes */
  functions?: TreeNode[];

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
  /** name -> definition locations, lazily built across the whole project; dropped on any change. */
  private definitionIndex?: Map<string, DefEntry[]>;
  /** Perl package name -> where it is declared; rebuilt together with definitionIndex. */
  private packageIndex = new Map<string, { uri: vscode.Uri; line: number }[]>();
  /** Bumped whenever definitionIndex is dropped, so an index built across a change isn't cached. */
  private indexGen = 0;
  /** Bumped by each build(); only the latest build may publish its tree. */
  private buildGen = 0;

  async refresh(): Promise<void> {
    if (!(await this.build())) return;
    this.dropDefinitionIndex();
    this._onDidChangeTreeData.fire();
  }

  private dropDefinitionIndex(): void {
    this.definitionIndex = undefined;
    this.indexGen++;
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
    } else if (node.kind === 'package') {
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      item.contextValue = 'package';
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
      await this.ensureFunctions(node);
      return node.children ?? [];
    }
    if (node.kind === 'package') return node.children ?? [];
    return [];
  }

  getParent(node: TreeNode): vscode.ProviderResult<TreeNode> {
    return node.parent;
  }

  /**
   * Parses a file's functions once; concurrent callers (tree, cursor sync, definition index) share
   * the same parse. If the file is invalidated mid-parse, waits for the fresh parse instead.
   */
  private async ensureFunctions(fileNode: TreeNode): Promise<void> {
    for (;;) {
      const load = (fileNode.loading ??= this.loadFunctions(fileNode));
      await load;
      if (fileNode.loading === load) return;
    }
  }

  private async loadFunctions(fileNode: TreeNode): Promise<void> {
    const gen = fileNode.loadGen;
    let infos: FunctionInfo[] = [];
    let packages: PackageInfo[] | undefined;
    try {
      const text = await this.readText(fileNode.uri);
      infos = parseFunctions(fileNode.lang!, text);
      if (fileNode.lang === 'perl') packages = parsePerlPackages(text);
    } catch {
      infos = [];
    }
    if (gen !== fileNode.loadGen) return;
    fileNode.packages = packages;
    fileNode.functions = infos.map(
      info => new TreeNode('function', info.name, fileNode.uri, fileNode, info.line)
    );
    fileNode.children = this.groupByPackage(fileNode);
  }

  /**
   * Functions of a file whose subs span 2+ packages go under one node per package (file order,
   * subs before the first `package` under `main`); otherwise they stay flat under the file.
   */
  private groupByPackage(fileNode: TreeNode): TreeNode[] {
    const functions = fileNode.functions!;
    if (!fileNode.packages?.length) return functions;
    const groups = new Map<string, TreeNode>();
    for (const fn of functions) {
      const pkg = packageAtLine(fileNode.packages, fn.line!);
      let group = groups.get(pkg);
      if (!group) {
        const decl = fileNode.packages.find(p => p.declared && p.name === pkg);
        group = new TreeNode('package', pkg, fileNode.uri, fileNode, decl?.line);
        group.children = [];
        groups.set(pkg, group);
      }
      group.children!.push(fn);
      fn.parent = group;
    }
    if (groups.size < 2) {
      for (const fn of functions) fn.parent = fileNode;
      return functions;
    }
    return [...groups.values()];
  }

  /** An open editor may hold unsaved edits - read what the user sees, not the disk copy. */
  private async readText(uri: vscode.Uri): Promise<string> {
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    return openDoc
      ? openDoc.getText()
      : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  }

  /**
   * Shift+F12: every whole-word occurrence of a known function's name in files of the same
   * language - a text search, so comments/strings/hash keys with that name count too.
   * `Foo::bar` is searched as `bar`, which also finds `Foo::bar(...)` and plain `bar(...)`.
   */
  async findReferences(name: string, lang: Lang): Promise<vscode.Location[]> {
    const index = await this.ensureDefinitionIndex();
    const short = name.slice(name.lastIndexOf(':') + 1);
    const known = [name, short].some(n => index.get(n)?.some(e => e.lang === lang));
    if (!known) return [];

    const escaped = short.replace(/[$]/g, '\\$&');
    const re = new RegExp(`(?<![\\w$@%])${escaped}(?![\\w$])`, 'g');
    const files = [...this.fileIndex.values()].filter(n => n.lang === lang);
    const perFile = await Promise.all(files.map(async fileNode => {
      const found: vscode.Location[] = [];
      let text: string;
      try {
        text = await this.readText(fileNode.uri);
      } catch {
        return found;
      }
      text.split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(re)) {
          found.push(new vscode.Location(fileNode.uri, new vscode.Range(i, m.index!, i, m.index! + short.length)));
        }
      });
      return found;
    }));
    return perFile.flat();
  }

  /** Drops the cached function list for a file so the next expand re-parses it. */
  async invalidateFile(uri: vscode.Uri): Promise<void> {
    const node = await this.resolveFileNode(uri.fsPath);
    if (node) {
      node.loading = undefined;
      node.loadGen++;
      node.children = undefined;
      node.functions = undefined;
      this.dropDefinitionIndex();
      this._onDidChangeTreeData.fire(node);
    }
  }

  private async ensureDefinitionIndex(): Promise<Map<string, DefEntry[]>> {
    if (this.definitionIndex) return this.definitionIndex;
    const gen = this.indexGen;
    const fileNodes = [...this.fileIndex.values()].filter(n => n.lang !== undefined);
    await Promise.all(fileNodes.map(n => this.ensureFunctions(n)));

    const index = new Map<string, DefEntry[]>();
    const packages = new Map<string, { uri: vscode.Uri; line: number }[]>();
    for (const fileNode of fileNodes) {
      for (const child of fileNode.functions ?? []) {
        const line = child.line ?? 0;
        const pkg = fileNode.packages ? packageAtLine(fileNode.packages, line) : undefined;
        const entry = { uri: fileNode.uri, line, lang: fileNode.lang!, pkg };
        const list = index.get(child.label);
        if (list) list.push(entry);
        else index.set(child.label, [entry]);
      }
      for (const p of fileNode.packages ?? []) {
        if (!p.declared) continue;
        const list = packages.get(p.name);
        if (list) list.push({ uri: fileNode.uri, line: p.line });
        else packages.set(p.name, [{ uri: fileNode.uri, line: p.line }]);
      }
    }
    // Cache only if nothing changed while building; otherwise use it for this call and rebuild next time.
    if (gen === this.indexGen) this.definitionIndex = index;
    this.packageIndex = packages;
    return index;
  }

  /**
   * Go to Definition, restricted to the caller's language. When the call site pins it down, only
   * those matches are returned, so F12 jumps straight there instead of listing every `sub new`:
   *  - with a qualifier (`Foo::bar`, `Foo->bar`): subs declared in package Foo;
   *  - without one: subs in the caller's own file and package.
   * Otherwise (e.g. an inherited method) every same-language definition is returned.
   */
  async findDefinitions(
    name: string,
    lang: Lang,
    from: { uri: vscode.Uri; pkg?: string; qualifier?: string }
  ): Promise<vscode.Location[]> {
    const index = await this.ensureDefinitionIndex();
    const all = (index.get(name) ?? []).filter(e => langFamily(e.lang) === langFamily(lang));
    const pinned = from.qualifier
      ? all.filter(e => e.pkg === from.qualifier)
      : all.filter(e => e.uri.fsPath === from.uri.fsPath && e.pkg === from.pkg);
    return (pinned.length ? pinned : all).map(e => new vscode.Location(e.uri, new vscode.Position(e.line, 0)));
  }

  /** Where a Perl package (`use Foo::Bar;`) is declared. */
  async findPackage(name: string): Promise<vscode.Location[]> {
    await this.ensureDefinitionIndex();
    return (this.packageIndex.get(name) ?? []).map(p => new vscode.Location(p.uri, new vscode.Position(p.line, 0)));
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
    await this.ensureFunctions(fileNode);
    let best: TreeNode | undefined;
    for (const child of fileNode.functions ?? []) {
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
  private async walkFolder(root: vscode.Uri, showHidden: boolean, excludes: RegExp[]): Promise<vscode.Uri[]> {
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
        // Checked per entry, so an excluded folder is never descended into.
        if (isExcluded(path.relative(root.fsPath, uri.fsPath), excludes)) return;
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
    if (ext) return extensionKinds.has(ext) ? 'plain' : 'skip';

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

  /**
   * Builds the tree into fresh roots/index and publishes them only if no newer build started
   * meanwhile - overlapping refreshes must not mix two trees. Returns false when superseded.
   */
  private async build(): Promise<boolean> {
    const gen = ++this.buildGen;
    const fileIndex = new Map<string, TreeNode>();
    loadExtensionSetting();
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots: TreeNode[] = [];
    const config = vscode.workspace.getConfiguration('JChCodeTree');
    const showHidden = config.get<boolean>('showHiddenFiles', false);
    const showSymlinks = config.get<boolean>('showSymlinks', false);

    for (const folder of folders) {
      if (!showHidden && path.basename(folder.uri.fsPath).startsWith('.')) continue;
      const filesExclude = vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, unknown>>('exclude', {});
      const excludes = [
        ...Object.keys(filesExclude).filter(k => filesExclude[k] === true),
        ...vscode.workspace.getConfiguration('JChCodeTree', folder.uri).get<string[]>('exclude', []),
      ].map(globToRegExp);
      const uris = showSymlinks
        ? await this.walkFolder(folder.uri, showHidden, excludes)
        : await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/{node_modules,.git}/**');
      const realRoot = !showSymlinks && folder.uri.scheme === 'file'
        ? await fsp.realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath)
        : undefined;
      const classified = await Promise.all(
        uris.map(async uri => {
          const rel = path.relative(folder.uri.fsPath, uri.fsPath);
          if (!showHidden && rel.split(path.sep).some(p => p.startsWith('.'))) {
            return { uri, lang: 'skip' as const };
          }
          if (isExcluded(rel, excludes)) return { uri, lang: 'skip' as const };
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
        fileIndex.set(uri.fsPath, fileNode);
      }

      sortFolderChildren(root);
      roots.push(root);
    }

    if (gen !== this.buildGen) return false;
    this.fileIndex = fileIndex;
    this.roots = roots;
    return true;
  }
}
