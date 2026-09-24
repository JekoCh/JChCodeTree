import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

// Best-effort `git pull` when the folder is inside a git clone; failures (not a repo,
// offline, auth needed) are ignored and whatever .vsix is already there gets used.
function gitPull(folder: string): Promise<void> {
  return new Promise(resolve => {
    execFile('git', ['-C', folder, 'pull', '--ff-only', '-q'],
      { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      () => resolve());
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

// Pulls and looks in JChCodeTree.updateFolder for a <name>-x.y.z.vsix newer than the running
// version, installs it and offers a window reload. Empty setting = disabled.
export async function checkForUpdate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.getConfiguration('JChCodeTree').get<string>('updateFolder', '').trim()
    .replace(/^~(?=\/|$)/, os.homedir());
  if (!folder) return;

  await gitPull(folder);

  const { name, version: current } = context.extension.packageJSON as { name: string; version: string };
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+\\.\\d+\\.\\d+)\\.vsix$`, 'i');

  let entries: string[];
  try {
    entries = await fs.readdir(folder);
  } catch {
    return; // folder not reachable (e.g. network share offline) - try again next start
  }

  let best: { version: string; file: string } | undefined;
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m && isNewer(m[1], best?.version ?? current)) best = { version: m[1], file: entry };
  }
  if (!best) return;

  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(path.join(folder, best.file)));
  } catch (err) {
    vscode.window.showWarningMessage(`Code Tree: update to ${best.version} failed: ${err}`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Code Tree updated to ${best.version}. Reload the window to use it.`,
    'Reload'
  );
  if (choice === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
