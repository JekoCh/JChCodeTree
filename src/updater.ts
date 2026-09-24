import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as https from 'https';

// Public repo; package.json and version/<name>-x.y.z.vsix are committed together by
// `npm run package` + push. HEAD = the default branch.
const RAW_BASE = 'https://raw.githubusercontent.com/JekoCh/JChCodeTree/HEAD/';

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function parseVersion(v: string): number[] {
  return v.split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Compares the running version with package.json on GitHub; if GitHub is newer, downloads
// its .vsix, installs it and offers a window reload. Network errors are silent - next start retries.
export async function checkForUpdate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.getConfiguration('JChCodeTree').get<boolean>('autoUpdate', true)) return;

  const { name, version: current } = context.extension.packageJSON as { name: string; version: string };

  let latest: string;
  let data: Buffer;
  try {
    latest = JSON.parse((await download(RAW_BASE + 'package.json')).toString('utf8')).version;
    if (!isNewer(latest, current)) return;
    data = await download(`${RAW_BASE}version/${name}-${latest}.vsix`);
  } catch {
    return;
  }

  const file = path.join(context.globalStorageUri.fsPath, `${name}-${latest}.vsix`);
  try {
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    await fs.writeFile(file, data);
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
  } catch (err) {
    vscode.window.showWarningMessage(`Code Tree: update to ${latest} failed: ${err}`);
    return;
  } finally {
    await fs.rm(file, { force: true });
  }

  const choice = await vscode.window.showInformationMessage(
    `Code Tree updated to ${latest}. Reload the window to use it.`,
    'Reload'
  );
  if (choice === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
