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

/** Version installed by this window but not yet running (no reload yet) - later checks compare against it. */
let installedVersion: string | undefined;
let inFlight: Promise<void> | undefined;

// Compares the running version with package.json on GitHub; if GitHub is newer, downloads
// its .vsix, installs it and offers a window reload. Automatic checks skip when autoUpdate is off
// and stay silent on network errors (the next check retries); a manual check always runs and reports.
export function checkForUpdate(context: vscode.ExtensionContext, manual = false): Promise<void> {
  if (!manual && !vscode.workspace.getConfiguration('JChCodeTree').get<boolean>('autoUpdate', true)) {
    return Promise.resolve();
  }
  inFlight ??= runCheck(context, manual).finally(() => { inFlight = undefined; });
  return inFlight;
}

/** Re-checks every JChCodeTree.autoUpdateIntervalHours (0 = startup only); call again after a settings change. */
export function startPeriodicUpdateCheck(context: vscode.ExtensionContext): vscode.Disposable {
  const hours = vscode.workspace.getConfiguration('JChCodeTree').get<number>('autoUpdateIntervalHours', 4);
  if (!(hours > 0)) return new vscode.Disposable(() => {});
  const timer = setInterval(() => void checkForUpdate(context), hours * 3600 * 1000);
  return new vscode.Disposable(() => clearInterval(timer));
}

async function runCheck(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const { name, version: running } = context.extension.packageJSON as { name: string; version: string };
  const current = installedVersion ?? running;

  let latest: string;
  try {
    latest = JSON.parse((await download(RAW_BASE + 'package.json')).toString('utf8')).version;
    if (!isNewer(latest, current)) {
      if (manual) {
        const msg = installedVersion
          ? `Code Tree ${installedVersion} is already installed. Reload the window to use it.`
          : `Code Tree is up to date (${running}).`;
        vscode.window.showInformationMessage(msg);
      }
      return;
    }
  } catch (err) {
    if (manual) vscode.window.showWarningMessage(`Code Tree: update check failed: ${err}`);
    return;
  }

  // Every open window runs this check, and globalStorage is shared between them. Reinstalling a
  // version another window already installed deletes it first, so a second install that then
  // fails leaves no extension at all - hence the on-disk check and the per-version lock.
  if (await installedOnDisk(context, latest)) {
    promptReload(latest);
    return;
  }
  const storage = context.globalStorageUri.fsPath;
  const lock = path.join(storage, `${name}-${latest}.lock`);
  // Per-window file name: another window's cleanup must not delete this window's download.
  const file = path.join(storage, `${name}-${latest}-${process.pid}.vsix`);
  try {
    await fs.mkdir(storage, { recursive: true });
    if (!(await acquireLock(lock))) {
      // Another window is installing - wait for it, then offer this window a reload too.
      if (manual) vscode.window.showInformationMessage(`Code Tree ${latest} is being installed by another window.`);
      if (await waitForUnlock(lock) && await installedOnDisk(context, latest)) promptReload(latest);
      return;
    }
  } catch (err) {
    vscode.window.showWarningMessage(`Code Tree: update to ${latest} failed: ${err}`);
    return;
  }

  try {
    // Re-check under the lock: another window may have finished between the first check and the lock.
    if (!(await installedOnDisk(context, latest))) {
      let data: Buffer;
      try {
        data = await download(`${RAW_BASE}version/${name}-${latest}.vsix`);
      } catch (err) {
        if (manual) vscode.window.showWarningMessage(`Code Tree: update check failed: ${err}`);
        return;
      }
      await fs.writeFile(file, data);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    }
  } catch (err) {
    vscode.window.showWarningMessage(`Code Tree: update to ${latest} failed: ${err}`);
    return;
  } finally {
    await fs.rm(file, { force: true });
    await fs.rm(lock, { force: true });
  }
  promptReload(latest);
}

function promptReload(version: string): void {
  installedVersion = version;
  // Not awaited: an unanswered prompt must not keep the check "in flight".
  void vscode.window.showInformationMessage(
    `Code Tree updated to ${version}. Reload the window to use it.`,
    'Reload'
  ).then(choice => {
    if (choice === 'Reload') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}

/** True when `version` sits next to the running extension (e.g. installed by another window). */
async function installedOnDisk(context: vscode.ExtensionContext, version: string): Promise<boolean> {
  const dir = path.join(path.dirname(context.extensionPath), `${context.extension.id}-${version}`.toLowerCase());
  try {
    await fs.access(path.join(dir, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

/** A lock older than this is left over from a crashed window. */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** Polls until another window removes the lock; false if it is still there after `timeoutMs`. */
async function waitForUnlock(file: string, timeoutMs = 2 * 60 * 1000): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      await fs.access(file);
    } catch {
      return true;
    }
  }
  return false;
}

/** Creates `file` exclusively; false while another window holds it. */
async function acquireLock(file: string): Promise<boolean> {
  try {
    await (await fs.open(file, 'wx')).close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const { mtimeMs } = await fs.stat(file);
    if (Date.now() - mtimeMs < LOCK_STALE_MS) return false;
    await fs.rm(file, { force: true });
    return acquireLock(file);
  }
}
