import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-worktree-test-')));
const ui = { pick: undefined, input: undefined, warning: undefined, info: undefined, calls: [] };
const format = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
const vscode = {
  l10n: { t: format }, extensions: { getExtension: () => undefined },
  ProgressLocation: { Notification: 15 }, InputBoxValidationSeverity: { Error: 3, Warning: 2, Info: 1 },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  workspace: {
    textDocuments: [], workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }),
    updateWorkspaceFolders: (index, count, ...folders) => {
      vscode.workspace.workspaceFolders.splice(index, count, ...folders);
      ui.calls.push(['workspace', index, count]); return true;
    },
  },
  commands: { executeCommand: async (...args) => { ui.calls.push(args); } },
  window: {
    showQuickPick: async (items, options) => ui.pick?.(items, options),
    showInputBox: async options => ui.input?.(options),
    showWarningMessage: async (...args) => { ui.calls.push(['warning', ...args]); return ui.warning?.(...args); },
    showInformationMessage: async (...args) => { ui.calls.push(['info', ...args]); return ui.info?.(...args); },
    showErrorMessage: async (...args) => { ui.calls.push(['error', ...args]); },
    withProgress: async (_, operation) => operation({ report() {} }),
  },
};
const bundle = await build({
  stdin: { contents: "export { GitService } from './src/host/git/GitService'; export { GitWorktreeWorkflow } from './src/host/git/GitWorktreeWorkflow'; export { ShelveService, withShelfRemovalGuard } from './src/host/git/ShelveService'; export { CommitPanelProvider } from './src/host/panels/CommitPanelProvider';", resolveDir: project },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode', 'simple-git'],
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id),
  process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder,
});
const { GitService, GitWorktreeWorkflow, ShelveService, withShelfRemovalGuard, CommitPanelProvider } = module.exports;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const workflow = new GitWorktreeWorkflow();
let passed = 0;
function fixture(name) {
  const cwd = path.join(temporary, name); fs.mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Worktree Test');
  git(cwd, 'config', 'user.email', 'worktree@example.invalid'); git(cwd, 'config', 'commit.gpgSign', 'false');
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'base\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'base');
  return { cwd, service: new GitService(name, cwd) };
}
async function worktree(repo, name) {
  const target = path.join(temporary, name);
  await repo.service.createWorktree(target, { newBranch: name });
  return target;
}
async function test(name, fn) {
  ui.pick = ui.input = ui.warning = ui.info = undefined; ui.calls.length = 0;
  vscode.workspace.textDocuments = []; vscode.workspace.workspaceFolders = [];
  await fn(); passed++; console.log(`PASS ${name}`);
}
try {
  const repo = fixture('repo');
  await test('remote selection creates a local tracking branch rather than detached HEAD', async () => {
    const remote = path.join(temporary, 'remote.git'); fs.mkdirSync(remote); git(remote, 'init', '--bare');
    git(repo.cwd, 'remote', 'add', 'origin', remote);
    git(repo.cwd, 'push', 'origin', 'main:remote-topic'); git(repo.cwd, 'fetch', 'origin');
    const target = path.join(temporary, 'remote-topic');
    await repo.service.createWorktree(target, { branch: 'origin/remote-topic' });
    assert.equal(git(target, 'symbolic-ref', '--short', 'HEAD'), 'remote-topic');
    assert.equal(git(target, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/remote-topic');
  });
  await test('existing local branch is reused without resetting it to the remote', async () => {
    git(repo.cwd, 'branch', 'reuse'); git(repo.cwd, 'push', 'origin', 'main:reuse'); git(repo.cwd, 'fetch', 'origin');
    git(repo.cwd, 'checkout', 'reuse'); fs.writeFileSync(path.join(repo.cwd, 'file.txt'), 'local commit\n');
    git(repo.cwd, 'commit', '-am', 'local'); const local = git(repo.cwd, 'rev-parse', 'HEAD'); git(repo.cwd, 'checkout', 'main');
    const target = path.join(temporary, 'reuse'); await repo.service.createWorktree(target, { branch: 'origin/reuse' });
    assert.equal(git(target, 'symbolic-ref', '--short', 'HEAD'), 'reuse');
    assert.equal(git(target, 'rev-parse', 'HEAD'), local);
  });
  await test('new branch respects selected base and leaves source changes untouched', async () => {
    const base = git(repo.cwd, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.cwd, 'file.txt'), 'next\n'); git(repo.cwd, 'commit', '-am', 'next');
    fs.writeFileSync(path.join(repo.cwd, 'file.txt'), 'uncommitted\n');
    const target = path.join(temporary, 'from-base');
    await repo.service.createWorktree(target, { newBranch: 'from-base', commitish: base });
    assert.equal(git(target, 'rev-parse', 'HEAD'), base);
    assert.equal(fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf8'), 'uncommitted\n');
    git(repo.cwd, 'restore', 'file.txt');
  });
  await test('occupied and invalid branches fail before creating directories or refs', async () => {
    const target = path.join(temporary, 'occupied');
    await assert.rejects(repo.service.createWorktree(target, { branch: 'main' }), /already used/);
    await assert.rejects(repo.service.createWorktree(target, { newBranch: 'bad name' }), /Invalid Git branch/);
    assert.equal(fs.existsSync(target), false);
  });
  await test('occupied branch flow opens the existing checkout and does not ask for a directory', async () => {
    ui.pick = items => items.find(item => item.branch?.name === 'main');
    ui.input = () => { throw new Error('Occupied branch must not ask for a directory'); };
    ui.info = (_, open) => open;
    assert.equal(await workflow.create(repo.service, 'repo', async () => {}), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(ui.calls.some(call => call[0] === 'vscode.openFolder' && call[1].fsPath === repo.cwd));
  });
  await test('interactive creation fixes the base before later prompts and offers workspace follow-up', async () => {
    const base = git(repo.cwd, 'rev-parse', 'HEAD'); const target = path.join(temporary, 'interactive');
    ui.pick = items => items[0];
    ui.input = async options => {
      if (options.title === 'New Worktree — Starting Point') {
        assert.ok(await options.validateInput('does-not-exist')); return 'HEAD';
      }
      if (options.title === 'New Worktree — New Branch Name') {
        git(repo.cwd, 'commit', '--allow-empty', '-m', 'HEAD moved during dialog');
        assert.ok(await options.validateInput('main')); return 'interactive';
      }
      return target;
    };
    ui.info = (_, _open, add) => add;
    let refreshed = false;
    assert.equal(await workflow.create(repo.service, 'repo', async () => { refreshed = true; }), true);
    assert.equal(git(target, 'rev-parse', 'HEAD'), base); assert.equal(refreshed, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, target);
    await workflow.addToWorkspace(target); assert.equal(vscode.workspace.workspaceFolders.length, 1);
  });
  await test('cancelled creation leaves all refs and directories unchanged', async () => {
    const refs = git(repo.cwd, 'show-ref');
    ui.pick = items => items[0]; ui.input = () => undefined;
    assert.equal(await workflow.create(repo.service, 'repo', async () => {}), false);
    assert.equal(git(repo.cwd, 'show-ref'), refs);
  });
  await test('porcelain parser preserves Unicode, spaces and newline paths', async () => {
    const target = path.join(temporary, '任务 空格\n工作树');
    await repo.service.createWorktree(target, { newBranch: 'unicode' });
    const entries = await repo.service.getWorktrees();
    assert.ok(entries.find(entry => entry.path === target && entry.branchShort === 'unicode'));
    assert.equal(entries.filter(entry => entry.isMain).length, 1); assert.equal(entries[0].path, repo.cwd);
  });
  await test('normal removal rejects dirty and ignored content; cancellation preserves all content', async () => {
    const target = await worktree(repo, 'dirty');
    fs.writeFileSync(path.join(target, 'file.txt'), 'dirty\n'); fs.writeFileSync(path.join(target, 'untracked.bin'), Buffer.from([0, 255]));
    fs.writeFileSync(path.join(target, '.gitignore'), 'ignored/\n'); fs.mkdirSync(path.join(target, 'ignored'));
    fs.writeFileSync(path.join(target, 'ignored', 'local.txt'), 'ignored content');
    await assert.rejects(repo.service.deleteWorktree(target), /local files or changes/);
    assert.equal(await workflow.remove(repo.service, target), false);
    assert.equal(fs.readFileSync(path.join(target, 'ignored', 'local.txt'), 'utf8'), 'ignored content');
    const warning = ui.calls.find(call => call[0] === 'warning');
    assert.equal(warning[2].modal, true); assert.match(warning[1], /ignored entries.*branches will be kept/);
  });
  await test('confirmed force removal removes the directory, retains the branch and removes its workspace folder', async () => {
    const target = path.join(temporary, 'dirty');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(repo.cwd) }, { uri: vscode.Uri.file(target) }];
    ui.warning = (_, _options, remove) => remove;
    assert.equal(await workflow.remove(repo.service, target, true), true);
    assert.equal(fs.existsSync(target), false); assert.ok(git(repo.cwd, 'show-ref', '--verify', 'refs/heads/dirty'));
    assert.equal(vscode.workspace.workspaceFolders.length, 1);
  });
  await test('main, current, foreign and locked worktrees are rejected by the writer', async () => {
    await assert.rejects(repo.service.deleteWorktree(repo.cwd, true), /main or currently opened/);
    const foreign = fixture('foreign'); await assert.rejects(repo.service.deleteWorktree(foreign.cwd, true), /Worktree not found/);
    const target = await worktree(repo, 'locked'); await repo.service.lockWorktree(target);
    await assert.rejects(repo.service.deleteWorktree(target, true), /Unlock/); await repo.service.unlockWorktree(target);
    const linked = new GitService('linked', target);
    await assert.rejects(linked.deleteWorktree(target, true), /currently opened/);
    // A standalone linked checkout can create another worktree.
    const sibling = path.join(temporary, 'sibling'); await linked.createWorktree(sibling, { newBranch: 'sibling' });
    assert.equal(git(sibling, 'symbolic-ref', '--short', 'HEAD'), 'sibling');
  });
  await test('unsaved editors prevent force removal before confirmation', async () => {
    const target = await worktree(repo, 'unsaved');
    vscode.workspace.textDocuments = [{ isDirty: true, uri: vscode.Uri.file(path.join(target, 'file.txt')) }];
    await assert.rejects(workflow.remove(repo.service, target, true), /unsaved editors/);
    assert.equal(ui.calls.some(call => call[0] === 'warning'), false); assert.equal(fs.existsSync(target), true);
  });
  await test('changes made during clean-removal confirmation are rechecked by the writer', async () => {
    const target = await worktree(repo, 'changed-after-dialog');
    ui.warning = (_, _options, remove) => { fs.writeFileSync(path.join(target, 'file.txt'), 'changed during confirmation'); return remove; };
    await assert.rejects(workflow.remove(repo.service, target), /local files or changes/);
    assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'changed during confirmation');
  });
  await test('detached commits must be saved to a branch before removal', async () => {
    const target = path.join(temporary, 'detached');
    git(repo.cwd, 'worktree', 'add', '--detach', target, 'HEAD');
    git(target, 'commit', '--allow-empty', '-m', 'detached work');
    await assert.rejects(repo.service.deleteWorktree(target, true), /Create a branch before removing/);
    git(target, 'branch', 'saved-detached');
    await repo.service.deleteWorktree(target);
    assert.ok(git(repo.cwd, 'show-ref', '--verify', 'refs/heads/saved-detached'));
  });
  await test('an unsaved new file through a path alias also prevents removal', async () => {
    if (process.platform === 'win32') return;
    const target = await worktree(repo, 'aliased');
    const alias = path.join(temporary, 'aliased-link'); fs.symlinkSync(target, alias);
    vscode.workspace.textDocuments = [{ isDirty: true, uri: vscode.Uri.file(path.join(alias, 'new-folder', 'new.txt')) }];
    await assert.rejects(workflow.remove(repo.service, target, true), /unsaved editors/);
    assert.equal(fs.existsSync(target), true);
  });
  await test('saved shelves survive normal and forced removal attempts, including missing checkouts', async () => {
    const target = await worktree(repo, 'shelved'); const shelves = new ShelveService(target, path.join(temporary, 'storage'));
    fs.writeFileSync(path.join(target, 'file.txt'), 'recoverable shelf\n'); await shelves.push('worktree recovery');
    await assert.rejects(repo.service.deleteWorktree(target, true), /contains 1 shelves/);
    assert.equal((await shelves.list()).length, 1);
    fs.rmSync(target, { recursive: true });
    await assert.rejects(repo.service.deleteWorktree(target, true), /contains 1 shelves/);
    await assert.rejects(repo.service.pruneWorktrees(), /contains 1 shelves/);
    assert.equal((await repo.service.getWorktrees()).some(entry => entry.path === target), true);
  });
  await test('removal uses the shared shelf lock and releases it without losing concurrent saves', async () => {
    const target = await worktree(repo, 'storage-lock'); const gitDir = git(target, 'rev-parse', '--absolute-git-dir');
    let release;
    const held = withShelfRemovalGuard(gitDir, () => new Promise(resolve => { release = resolve; }));
    await assert.rejects(withShelfRemovalGuard(gitDir, async () => {}), /Shelf storage is busy/);
    fs.writeFileSync(path.join(target, 'file.txt'), 'concurrent shelf');
    const shelves = new ShelveService(target, path.join(temporary, 'storage'));
    const push = shelves.push('concurrent save');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(fs.readFileSync(path.join(target, 'file.txt'), 'utf8'), 'concurrent shelf');
    release(); await held; await push;
    assert.equal((await shelves.list()).length, 1);
    await assert.rejects(repo.service.deleteWorktree(target, true), /contains 1 shelves/);
  });
  await test('duplicate host interactions are rejected and cancellation releases the guard', async () => {
    const provider = Object.create(CommitPanelProvider.prototype); provider.worktreeInteractionActive = false;
    let release; const first = provider.runWorktreeInteraction(() => new Promise(resolve => { release = resolve; }));
    assert.equal(await provider.runWorktreeInteraction(async () => { throw new Error('Duplicate prompt'); }), undefined);
    release(false); assert.equal(await first, false);
    assert.equal(await provider.runWorktreeInteraction(async () => true), true);
  });
  console.log(`Worktree workflow: ${passed} regression cases passed.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
