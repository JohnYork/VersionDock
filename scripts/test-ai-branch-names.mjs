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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-ai-branch-'));
class Emitter {
  listeners = new Set();
  event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
}
class CancellationTokenSource {
  emitter = new Emitter();
  token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  cancel() { this.token.isCancellationRequested = true; this.emitter.fire(); }
  dispose() { this.emitter.listeners.clear(); }
}
class Input {
  changed = new Emitter(); accepted = new Emitter(); hidden = new Emitter(); button = new Emitter();
  onDidChangeValue = this.changed.event; onDidAccept = this.accepted.event;
  onDidHide = this.hidden.event; onDidTriggerButton = this.button.event;
  _value = ''; disposed = false;
  set value(value) { this._value = value; this.changed.fire(value); }
  get value() { return this._value; }
  show() { this.visible = true; }
  hide() { this.visible = false; this.hidden.fire(); }
  dispose() { this.disposed = true; this.hide(); }
  accept() { this.accepted.fire(); }
  press(button = this.buttons[0]) { this.button.fire(button); }
}
const inputs = [];
let fallbackCalls = 0;
const vscode = {
  CancellationTokenSource,
  CancellationError: class extends Error {},
  ThemeIcon: class { constructor(id) { this.id = id; } },
  QuickInputButtons: { Back: {} },
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
  l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => args[index]) },
  extensions: { getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
  Uri: { file: fsPath => ({ fsPath }) },
  window: {
    createInputBox: () => { const input = new Input(); inputs.push(input); return input; },
    showInputBox: async () => { fallbackCalls++; return 'manual-svn'; },
  },
};
const bundle = await build({
  stdin: { contents: "export { AiBranchNameService } from './src/host/aiBranchName/AiBranchNameService'; export {promptBranchName} from './src/host/ui/promptBranchName'; export {GitService} from './src/host/git/GitService'; export {GitWorktreeWorkflow} from './src/host/git/GitWorktreeWorkflow'; export {BranchStatusBar} from './src/host/ui/BranchStatusBar'; export {CommitPanelProvider} from './src/host/panels/CommitPanelProvider'; export {GitLogPanelProvider} from './src/host/panels/GitLogPanelProvider';", resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode', 'simple-git'],
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id),
  process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder,
});
const { AiBranchNameService, promptBranchName, GitService, GitWorktreeWorkflow, BranchStatusBar, CommitPanelProvider, GitLogPanelProvider } = module.exports;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(name) {
  const cwd = path.join(temp, name); fs.mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'AI Name Test'); git(cwd, 'config', 'user.email', 'ai-name@example.test');
  fs.writeFileSync(path.join(cwd, 'login.ts'), 'export const timeout = 10;\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  return new GitService(name, cwd);
}
const requests = [];
let answer = 'fix/login-timeout';
let providerError;
const provider = {
  getMaxInputTokens: async () => 16_384,
  generate: async options => { requests.push(options); if (providerError) throw providerError; return { text: answer }; },
};
const repos = new Map();
const manager = { getRepo: id => repos.get(id) };
const service = new AiBranchNameService(manager, provider);
const token = () => new CancellationTokenSource().token;
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await delay();
  assert.ok(predicate(), 'Timed out waiting for input state');
}
function prompt(value = '') {
  const promise = promptBranchName(service, ['a'], { title: 'New Branch', value });
  return { promise, input: inputs.at(-1) };
}
function snapshot(repo) {
  return {
    head: git(repo.rootPath, 'rev-parse', 'HEAD'),
    refs: git(repo.rootPath, 'for-each-ref', '--format=%(refname):%(objectname)'),
    status: git(repo.rootPath, 'status', '--porcelain'),
    index: fs.readFileSync(path.join(repo.rootPath, '.git/index')).toString('base64'),
    content: fs.readFileSync(path.join(repo.rootPath, 'login.ts'), 'utf8'),
  };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  const a = repo('a'), b = repo('b'); repos.set('a', a); repos.set('b', b);
  await test('description mode ignores repository changes and generation never writes', async () => {
    const before = snapshot(a);
    assert.equal(await service.generate(['a'], '修复登录超时', token()), 'fix/login-timeout');
    const request = requests.at(-1);
    assert.equal(request.taskKind, 'branch-name');
    assert.match(request.userMessage, /修复登录超时/);
    assert.doesNotMatch(request.userMessage, /login\.ts|main|initial/);
    assert.deepEqual([...request.repoRootPaths], [a.rootPath]);
    assert.deepEqual(snapshot(a), before);
  });
  await test('empty changes require a task before calling the provider', async () => {
    const count = requests.length;
    await assert.rejects(service.generate(['a'], '', token()), /Describe your task/);
    assert.equal(requests.length, count);
  });
  await test('empty repositories require intent even when no AI model is configured', async () => {
    const noModel = new AiBranchNameService(manager, {
      getMaxInputTokens: async () => { throw new Error('No AI model'); },
      generate: async () => { throw new Error('Must not call AI'); },
    });
    await assert.rejects(noModel.generate(['a'], '', token()), /Describe your task/);
  });
  await test('selected repositories include both staged and working changes without duplicate summaries or secrets', async () => {
    fs.writeFileSync(path.join(a.rootPath, 'login.ts'), 'export const timeout = 20;\n'); git(a.rootPath, 'add', 'login.ts');
    fs.appendFileSync(path.join(a.rootPath, 'login.ts'), 'export const retry = true;\n');
    fs.writeFileSync(path.join(a.rootPath, '.env'), 'TOKEN=NEVER_SEND_THIS_SECRET\n');
    fs.writeFileSync(path.join(a.rootPath, '图片.png'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(b.rootPath, 'unselected.ts'), 'NEVER_SEND_UNSELECTED\n');
    const before = snapshot(a);
    await service.generate(['a', 'a'], '', token());
    const request = requests.at(-1);
    assert.match(request.userMessage, /timeout = 20/); assert.match(request.userMessage, /retry = true/);
    assert.equal(request.userMessage.split('modified: login.ts').length - 1, 1);
    assert.match(request.userMessage, /binary file/);
    assert.doesNotMatch(request.userMessage, /NEVER_SEND_THIS_SECRET|NEVER_SEND_UNSELECTED|initial|Branch: main/);
    assert.ok(!request.selectedPaths.some(file => file.endsWith('.env')));
    assert.deepEqual(snapshot(a), before);
    await service.generate(['a', 'b'], '', token());
    assert.match(requests.at(-1).userMessage, /NEVER_SEND_UNSELECTED/);
    assert.deepEqual([...requests.at(-1).repoRootPaths], [a.rootPath, b.rootPath]);
  });
  await test('malformed and insufficient AI output cannot become branch names', async () => {
    for (const invalid of ['fix/a\nfix/b', '```fix/a```', 'feature/a', 'fix/中文', 'fix/a..b']) {
      answer = invalid; await assert.rejects(service.generate(['a'], 'task', token()), /invalid branch name/);
    }
    answer = 'NEEDS_DESCRIPTION'; await assert.rejects(service.generate(['a'], '', token()), /Describe your task/);
    answer = 'fix/login-timeout';
  });
  await test('real Git preflight handles exact names, parent and child ref conflicts, and every target repo', async () => {
    git(b.rootPath, 'branch', 'fix/login-timeout');
    await assert.rejects(service.generate(['a', 'b'], 'task', token()), /already exists/);
    assert.equal(await service.validate('fix/login-timeout', ['a']), undefined);
    git(a.rootPath, 'branch', 'fix/existing');
    assert.match(await service.validate('fix', ['a']), /conflicts/);
    assert.match(await service.validate('fix/existing/child', ['a']), /conflicts/);
    assert.match(await service.validate('-option', ['a']), /Invalid Git/);
    assert.match(await service.validate('HEAD', ['a']), /Invalid Git/);
  });
  await test('manual input never calls AI and SVN keeps the original prompt', async () => {
    const count = requests.length;
    const { input, promise } = prompt(); input.value = 'my-manual-branch'; input.accept();
    assert.equal(await promise, 'my-manual-branch'); assert.equal(requests.length, count); assert.ok(input.disposed);
    repos.set('svn', { kind: 'svn' });
    assert.equal(await promptBranchName(service, ['svn'], {}), 'manual-svn'); assert.equal(fallbackCalls, 1);
  });
  await test('AI result is filled for review; cancellation of task preserves the edited name', async () => {
    const { input, promise } = prompt('original');
    input.press(); input.value = 'task'; input.accept();
    await until(() => input.value === 'fix/login-timeout' && !input.busy);
    assert.ok(!input.disposed);
    input.value = 'fix/edited'; input.press(); input.value = 'different task'; input.hide();
    assert.equal(input.value, 'fix/edited'); assert.ok(input.visible); assert.ok(!input.disposed);
    input.press(); input.press(vscode.QuickInputButtons.Back); assert.equal(input.value, 'fix/edited');
    input.accept(); assert.equal(await promise, 'fix/edited');
  });
  await test('AI errors and ref conflicts preserve input and allow manual fallback', async () => {
    providerError = new Error('timeout');
    const { input, promise } = prompt('original'); input.press(); input.value = 'task'; input.accept();
    await until(() => !input.busy);
    assert.equal(input.value, 'original'); assert.match(input.validationMessage.message, /timeout/);
    providerError = undefined;
    answer = 'fix/existing'; input.press(); input.accept(); await until(() => !input.busy);
    assert.equal(input.value, 'original'); assert.match(input.validationMessage.message, /already exists/);
    input.value = 'manual-after-error'; input.accept(); assert.equal(await promise, 'manual-after-error');
    answer = 'fix/login-timeout';
  });
  await test('validation errors stay open and return only a legal, free name', async () => {
    const { input, promise } = prompt('fix/existing'); input.accept();
    await until(() => !input.busy); assert.equal(input.validationMessage.severity, 3); assert.ok(!input.disposed);
    input.value = 'fix/existing/child'; input.accept(); await until(() => !input.busy);
    assert.match(input.validationMessage.message, /conflicts/);
    input.value = 'HEAD'; input.accept(); await until(() => !input.busy); assert.match(input.validationMessage.message, /Invalid/);
    input.value = 'safe name'; input.accept(); assert.equal(await promise, 'safe-name');
  });
  await test('closing during generation cancels the request and late results cannot touch a new input', async () => {
    let complete;
    const delayedRequests = [];
    const lateService = new AiBranchNameService(manager, {
      ...provider,
      generate: options => { delayedRequests.push(options); return new Promise(resolve => { complete = resolve; }); },
    });
    const promise = promptBranchName(lateService, ['a'], { value: 'original' }); const old = inputs.at(-1);
    old.press(); old.value = 'task'; old.accept(); await until(() => delayedRequests.length > 0);
    old.press(); old.accept(); assert.equal(delayedRequests.length, 1);
    old.hide(); assert.equal(await promise, undefined); assert.ok(delayedRequests[0].cancellationToken.isCancellationRequested);
    const next = prompt('new-input'); complete({ text: 'fix/late-result' }); await delay();
    assert.equal(next.input.value, 'new-input'); assert.equal(old.value, 'task');
    assert.equal(old.changed.listeners.size + old.accepted.listeners.size + old.hidden.listeners.size + old.button.listeners.size, 0);
    next.input.hide(); await next.promise;
  });
  await test('confirmed names create real branches and worktrees, existing directories are never reused', async () => {
    await a.createBranch('fix/confirmed');
    assert.equal(git(a.rootPath, 'rev-parse', 'fix/confirmed'), git(a.rootPath, 'rev-parse', 'HEAD'));
    const worktree = path.join(temp, 'a--feat-worktree');
    await a.createWorktree(worktree, { newBranch: 'feat/worktree' });
    assert.equal(git(worktree, 'branch', '--show-current'), 'feat/worktree');
    const existing = path.join(temp, 'existing'); fs.mkdirSync(existing);
    await assert.rejects(a.createWorktree(existing, { newBranch: 'feat/blocked' }), /already exists/);
    assert.equal(git(a.rootPath, 'branch', '--list', 'feat/blocked'), ''); assert.deepEqual(fs.readdirSync(existing), []);
    const existingRelative = path.join(a.rootPath, 'existing-relative'); fs.mkdirSync(existingRelative);
    await assert.rejects(a.createWorktree('existing-relative', { newBranch: 'feat/blocked-relative' }), /already exists/);
    await a.createWorktree('../a--relative', { newBranch: 'feat/relative' });
    assert.equal(git(path.join(temp, 'a--relative'), 'branch', '--show-current'), 'feat/relative');
    const dangling = path.join(temp, 'dangling'); fs.symlinkSync(path.join(temp, 'missing'), dangling);
    await assert.rejects(a.createWorktree(dangling, { newBranch: 'feat/dangling' }), /already exists/);
  });
  await test('every Git creation entrypoint invokes the shared prompt (including detached HEAD and history)', async () => {
    // Exercise production entrypoints, then cancel at their native name input before any write.
    const statusBar = Object.create(BranchStatusBar.prototype);
    Object.assign(statusBar, { manager, aiBranchNameService: service });
    vscode.window.showQuickPick = async items => items;
    const first = statusBar.newBranch([{ id: 'a', name: 'a', rootPath: a.rootPath }]);
    await until(() => inputs.at(-1)?.title === 'New Branch — Name'); inputs.at(-1).hide(); await first;
    for (const [method, args] of [
      ['newBranchSingleRepo', [{ id: 'a', name: 'a' }]],
      ['newBranchFromSingleRepo', ['main', { id: 'a', name: 'a' }]],
      ['newBranchFrom', ['main', [{ id: 'a', name: 'a' }]]],
    ]) {
      const count = inputs.length; const action = statusBar[method](...args);
      await until(() => inputs.length > count); assert.equal(inputs.at(-1).buttons[0].iconPath.id, 'sparkle'); inputs.at(-1).hide(); await action;
    }
    manager.getRepoMeta = id => ({ name: id });
    const log = Object.create(GitLogPanelProvider.prototype); Object.assign(log, { manager, aiBranchNameService: service, post() {} });
    const commit = Object.create(CommitPanelProvider.prototype);
    Object.assign(commit, { manager, aiBranchNameService: service, worktreeWorkflow: new GitWorktreeWorkflow(service), post() {} });
    // Worktree creation now resolves its starting point before asking for the AI-capable name.
    const originalInput = vscode.window.showInputBox;
    vscode.window.showInputBox = async options => options.title === 'New Worktree — Starting Point' ? 'HEAD' : originalInput(options);
    for (const [provider, message] of [[log, { type: 'LOG_NEW_BRANCH_FROM_COMMIT', repoId: 'a', hash: 'HEAD', requestId: 'test' }], [commit, { type: 'SYNC_CREATE_BRANCH_FROM_COMMIT', repoId: 'a', hash: 'HEAD' }], [commit, { type: 'WORKTREE_CREATE_PROMPT', repoId: 'a' }]]) {
      vscode.window.showQuickPick = async items => items[0];
      const count = inputs.length; const action = provider.handleMessage(message);
      await until(() => inputs.length > count); assert.equal(inputs.at(-1).buttons[0].iconPath.id, 'sparkle'); inputs.at(-1).hide(); await action;
    }
    vscode.window.showInputBox = originalInput;
  });
  await test('detached HEAD prompts before and after commit both use AI-capable inputs', async () => {
    git(a.rootPath, 'checkout', '--detach', 'HEAD');
    const commit = Object.create(CommitPanelProvider.prototype);
    Object.assign(commit, { manager, aiBranchNameService: service });
    vscode.window.showWarningMessage = async (_message, ...items) => items.find(item => typeof item === 'string');
    const count = inputs.length;
    const safety = commit.validateCommitSafety(a);
    await until(() => inputs.length > count);
    assert.equal(inputs.at(-1).title, 'Create Branch & Commit'); inputs.at(-1).hide();
    assert.equal(await safety, false);
    const afterCount = inputs.length;
    await commit.notifyDetachedHeadCommitIfApplicable(a);
    await until(() => inputs.length > afterCount);
    assert.equal(inputs.at(-1).title, 'Create Branch from Current Commit');
    assert.equal(inputs.at(-1).buttons[0].iconPath.id, 'sparkle'); inputs.at(-1).hide();
    await delay(); git(a.rootPath, 'checkout', 'main');
  });
  await test('explicit tasks override dirty diffs and removed repositories cannot broaden context', async () => {
    const count = requests.length;
    await service.generate(['a'], 'Add report export', token());
    assert.doesNotMatch(requests.at(-1).userMessage, /login\.ts|timeout = 20|retry = true/);
    await assert.rejects(service.generate(['removed'], 'task', token()), /no longer available/);
    const cancelled = new CancellationTokenSource(); cancelled.cancel();
    await assert.rejects(service.generate(['a'], 'task', cancelled.token));
    assert.equal(requests.length, count + 1);
  });
  console.log(`\n${passed} AI branch-name regressions passed.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
