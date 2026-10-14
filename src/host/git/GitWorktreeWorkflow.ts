import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type GitService, isSameWorktreePath } from './GitService';
import type { AiBranchNameService } from '../aiBranchName/AiBranchNameService';
import { promptBranchName } from '../ui/promptBranchName';
import { getBranchCleanCharacter, sanitizeBranchName, validateBranchNameInput } from '../utils/branchNameSanitizer';
import { isSameOrChildPath } from '../utils/repoPath';
import { t } from '../utils/l10n';

/** Interactive policy shared by the command palette and both commit panel surfaces. */
export class GitWorktreeWorkflow {
  constructor(private readonly aiBranchNameService?: AiBranchNameService) {}

  private hasUnsavedEditors(worktreePath: string): boolean {
    const normalize = (filePath: string): string => {
      let value = path.resolve(filePath);
      let existing = value;
      // New unsaved files may not exist yet; resolve aliases through the nearest existing parent.
      for (;;) {
        try { value = path.resolve(fs.realpathSync.native(existing), path.relative(existing, value)); break; }
        catch {
          const parent = path.dirname(existing);
          if (parent === existing) break;
          existing = parent;
        }
      }
      return process.platform === 'win32' ? value.toLowerCase() : value;
    };
    return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
      && (isSameOrChildPath(worktreePath, document.uri.fsPath)
        || isSameOrChildPath(normalize(worktreePath), normalize(document.uri.fsPath))));
  }

  async addToWorkspace(worktreePath: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some(folder => isSameWorktreePath(folder.uri.fsPath, worktreePath))) return;
    if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(worktreePath) })) {
      throw new Error(t('Could not add the worktree to the workspace.'));
    }
  }

  async open(worktreePath: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), { forceNewWindow: true });
  }

  private async offerOpen(worktreePath: string, message: string): Promise<void> {
    const open = t('Open in New Window');
    const add = t('Add Folder to Workspace');
    const choice = await vscode.window.showInformationMessage(message, open, add);
    try {
      if (choice === open) await this.open(worktreePath);
      if (choice === add) await this.addToWorkspace(worktreePath);
    } catch (error) {
      // The worktree already exists: a failed follow-up must not report creation as failed.
      void vscode.window.showErrorMessage(String(error));
    }
  }

  async create(repo: GitService, repoName: string, onCreated: () => Promise<void>): Promise<boolean> {
    const [branches, worktrees] = await Promise.all([repo.getBranches(), repo.getWorktrees()]);
    const items = [
      { label: `$(add) ${t('Create new branch…')}`, branch: undefined, occupied: undefined },
      ...branches.map(branch => {
        const localName = branch.isRemote
          ? branch.name.slice((branch.remoteName?.length ?? branch.name.indexOf('/')) + 1)
          : branch.name;
        const occupied = worktrees.find(w => w.branchShort === localName);
        return {
          label: `${branch.isRemote ? '$(cloud)' : '$(git-branch)'} ${branch.name}`,
          description: occupied ? t('Already open in {0}', occupied.path)
            : branch.isRemote ? t('Create or use local branch {0}', localName) : undefined,
          branch, occupied,
        };
      }),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: t('Select branch for new worktree'), title: t('New Worktree — Branch'), matchOnDescription: true,
    });
    if (!picked) return false;
    if (picked.occupied) {
      void this.offerOpen(picked.occupied.path, t('Branch "{0}" is already used by worktree at {1}.',
        picked.occupied.branchShort, picked.occupied.path));
      return false;
    }

    let newBranch: string | undefined;
    let commitish: string | undefined;
    if (!picked.branch) {
      const base = await vscode.window.showInputBox({
        title: t('New Worktree — Starting Point'),
        prompt: t('Branch, tag or commit to start from. Uncommitted changes stay in the original worktree.'),
        value: 'HEAD', placeHolder: 'HEAD, main, origin/main, v1.0.0',
        validateInput: async value => {
          try { await repo.resolveTagCommit(value.trim() || 'HEAD'); return undefined; }
          catch { return t('Commit reference cannot be resolved to a commit.'); }
        },
      });
      if (base === undefined) return false;
      // Fix the selected base before later prompts; moving HEAD must not change it.
      commitish = await repo.resolveTagCommit(base.trim() || 'HEAD');
      const input = await promptBranchName(this.aiBranchNameService, [repo.repoId], {
        prompt: t('New branch name'), placeHolder: t('e.g. feature/my-feature'), title: t('New Worktree — New Branch Name'),
        validateInput: async value => {
          const local = validateBranchNameInput(value);
          if (local?.severity === vscode.InputBoxValidationSeverity.Error) return local;
          const error = await repo.validateNewBranchName(sanitizeBranchName(value.trim(), getBranchCleanCharacter()));
          return error ?? local;
        },
      });
      if (!input?.trim()) return false;
      newBranch = sanitizeBranchName(input.trim(), getBranchCleanCharacter());
    }

    const branchName = newBranch ?? picked.branch!.name;
    const defaultPath = path.join(path.dirname(repo.rootPath), `${path.basename(repo.rootPath)}--${branchName.replace(/[\\/:*?"<>|]/g, '-')}`);
    const input = await vscode.window.showInputBox({
      prompt: t('Path for the new worktree directory'), value: defaultPath, title: t('New Worktree — Directory Path'),
      validateInput: async value => {
        if (!value.trim()) return t('Worktree directory path cannot be empty.');
        try {
          await fs.promises.lstat(path.resolve(repo.rootPath, value.trim()));
          return t('Worktree directory already exists. Choose a different path.');
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : String(error);
        }
      },
    });
    if (!input?.trim()) return false;
    const worktreePath = path.resolve(repo.rootPath, input.trim());
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Creating worktree…', repoName), cancellable: false },
      () => repo.createWorktree(worktreePath, { branch: picked.branch?.name, newBranch, commitish }),
    );
    await onCreated();
    void this.offerOpen(worktreePath, t('VersionDock [{0}]: Worktree created at {1}', repoName, worktreePath));
    return true;
  }

  async remove(repo: GitService, worktreePath: string, force = false): Promise<boolean> {
    const info = await repo.getWorktreeRemovalInfo(worktreePath);
    if (info.shelfCount) throw new Error(t('This worktree contains {0} shelves. Restore or move them before removing it.', info.shelfCount));
    // Disk status does not include unsaved editors. Never remove their backing directory.
    if (this.hasUnsavedEditors(info.entry.path)) throw new Error(t('Save or close unsaved editors in this worktree before removing it.'));
    const dirty = info.changedCount > 0 || info.ignoredCount > 0;
    const remove = dirty || force ? t('Force Remove') : t('Remove Worktree');
    const open = t('Open in New Window');
    const message = dirty || force
      ? t('Permanently remove worktree "{0}" at {1}? It has {2} changed or untracked entries and {3} ignored entries. All files in this directory will be deleted. Existing branches will be kept.',
        info.entry.branchShort || info.entry.head.slice(0, 8), info.entry.path, info.changedCount, info.ignoredCount)
      : t('Remove worktree "{0}" at {1}? The directory will be deleted. Existing branches will be kept.',
        info.entry.branchShort || info.entry.head.slice(0, 8), info.entry.path);
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, remove, open);
    if (choice === open) { await this.open(info.entry.path); return false; }
    if (choice !== remove) return false;
    // Recheck editors after the dialog; GitService rechecks disk/lock/shelf state under write locks.
    if (this.hasUnsavedEditors(info.entry.path)) {
      throw new Error(t('Save or close unsaved editors in this worktree before removing it.'));
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Removing worktree…'), cancellable: false },
      () => repo.deleteWorktree(info.entry.path, dirty || force),
    );
    const folders = vscode.workspace.workspaceFolders ?? [];
    const index = folders.findIndex(folder => isSameWorktreePath(folder.uri.fsPath, info.entry.path));
    if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
    return true;
  }
}
