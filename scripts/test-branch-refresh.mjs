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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-branch-refresh-'));
const vscodeRepositories = new Map();
const fsWatchers = [];
const vscode = {
  l10n: { t: message => message },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ getRepository: uri => vscodeRepositories.get(uri.fsPath) }) } }) },
  Uri: { file: fsPath => ({ fsPath }) },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  workspace: {
    workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }),
    createFileSystemWatcher: pattern => {
      const watcher = { pattern, onDidChange(fn) { this.change = fn; }, onDidCreate(fn) { this.create = fn; }, onDidDelete(fn) { this.delete = fn; }, dispose() {} };
      fsWatchers.push(watcher);
      return watcher;
    },
  },
  window: { showInformationMessage: async () => undefined },
};
const bundle = await build({
  stdin: {
    contents: "export {GitService} from './src/host/git/GitService'; export {WorkspaceGitManager} from './src/host/git/WorkspaceGitManager'; export {GitLogPanelProvider} from './src/host/panels/GitLogPanelProvider';",
    resolveDir: root,
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode', 'simple-git'],
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id),
  process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder,
});
const { GitService, WorkspaceGitManager, GitLogPanelProvider } = module.exports;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), message);
}
const errors = [];
const logger = { warn() {}, error: (...args) => errors.push(args) };
const managers = [], providers = [];
function makeManager(service) {
  // Exercise the production status publisher, debounce and branch aggregation,
  // without installing workspace/file watchers outside the temporary repository.
  const manager = Object.create(WorkspaceGitManager.prototype);
  Object.assign(manager, {
    repos: new Map([[service.repoId, service]]),
    repoMetas: new Map([[service.repoId, { id: service.repoId, name: service.repoId, rootPath: service.rootPath, kind: 'git', color: '#888' }]]),
    logger, statusListeners: [], branchListeners: [], reposListeners: [], prevUntracked: new Map(),
    promptedResolvedOps: new Set(), lastPublishedStatus: null, cachedAllBranches: [],
    statusUpdateSuppressionDepth: 0, repositoryGeneration: 0, refreshInFlight: false,
    refreshPending: false, disposed: false, branchQueryGeneration: 0,
    watchers: [], prevHeads: new Map(), prevCommits: new Map(),
  });
  managers.push(manager);
  return manager;
}
function makeProvider(manager) {
  const provider = new GitLogPanelProvider({}, manager, { setContentResolver() {} }, {}, {}, logger, {});
  const messages = [];
  provider.view = { webview: { postMessage: message => messages.push(message) } };
  providers.push(provider);
  return { provider, messages };
}
function repo(name) {
  const cwd = path.join(dir, name); fs.mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Branch Refresh Test');
  git(cwd, 'config', 'user.email', 'branch-refresh@example.test');
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'initial\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  const remote = path.join(dir, `${name}.git`); fs.mkdirSync(remote); git(remote, 'init', '--bare');
  git(cwd, 'remote', 'add', 'origin', remote); git(cwd, 'push', '-u', 'origin', 'main');
  return { cwd, remote, service: new GitService(name, cwd) };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  const a = repo('a');
  const manager = makeManager(a.service);
  const { messages } = makeProvider(manager);
  manager.lastPublishedStatus = await manager.getAllStatusesFresh();
  const latestHead = () => messages.filter(m => m.type === 'LOG_INIT_DATA').at(-1)?.branches.find(b => b.isHead);
  await test('merge status alone updates branch push counts and the log', async () => {
    git(a.cwd, 'checkout', '-b', 'topic');
    fs.writeFileSync(path.join(a.cwd, 'topic.txt'), 'topic\n');
    git(a.cwd, 'add', '.'); git(a.cwd, 'commit', '-m', 'topic');
    git(a.cwd, 'checkout', 'main');
    await a.service.merge('topic');
    await manager.refreshStatusNow();
    await until(() => latestHead()?.aheadBehind?.ahead === 1, 'Merge published fresh status but never refreshed branch push counts');
    await until(() => messages.some(m => m.type === 'LOG_REFRESH'), 'Moved HEAD must refresh the log');
    assert.equal(latestHead().lastCommitHash, git(a.cwd, 'rev-parse', 'HEAD'));
  });
  await test('push and fetch update counts even when HEAD does not move', async () => {
    const head = git(a.cwd, 'rev-parse', 'HEAD');
    messages.length = 0;
    git(a.cwd, 'push', 'origin', 'main');
    await manager.refreshStatusNow();
    await until(() => latestHead()?.aheadBehind?.ahead === 0, 'Push must clear the ahead badge');
    assert.equal(git(a.cwd, 'rev-parse', 'HEAD'), head);
    const other = path.join(dir, 'other');
    git(dir, 'clone', '-b', 'main', a.remote, other);
    git(other, 'config', 'user.name', 'Remote'); git(other, 'config', 'user.email', 'remote@example.test');
    fs.writeFileSync(path.join(other, 'remote.txt'), 'remote\n');
    git(other, 'add', '.'); git(other, 'commit', '-m', 'remote'); git(other, 'push', 'origin', 'main');
    messages.length = 0;
    await a.service.fetchAll();
    await manager.refreshStatusNow();
    await until(() => latestHead()?.aheadBehind?.behind === 1, 'Fetch must update the behind badge');
    assert.equal(git(a.cwd, 'rev-parse', 'HEAD'), head);
  });
  await test('unchanged status and working-file edits do not reload branches', async () => {
    await delay(750); messages.length = 0;
    await manager.refreshStatusNow();
    fs.appendFileSync(path.join(a.cwd, 'file.txt'), 'working edit\n');
    await manager.refreshStatusNow();
    await delay(500);
    assert.equal(messages.length, 0);
    git(a.cwd, 'restore', 'file.txt');
  });
  await test('upstream removal and branch switch refresh the sidebar', async () => {
    await delay(750);
    messages.length = 0;
    git(a.cwd, 'branch', '--unset-upstream');
    await manager.refreshStatusNow();
    await until(() => latestHead() && latestHead().upstream === undefined, 'Upstream removal must refresh branch metadata');
    await delay(350);
    assert.equal(messages.some(m => m.type === 'LOG_REFRESH'), false, 'Tracking-only changes must not reset log pagination');
    messages.length = 0;
    await a.service.checkout('topic');
    await manager.refreshStatusNow();
    await until(() => latestHead()?.name === 'topic', 'Checkout must refresh HEAD');
  });
  await test('commit, rebase, reset, cherry-pick and revert publish fresh counts', async () => {
    const c = repo('operations');
    const base = git(c.cwd, 'rev-parse', 'HEAD');
    git(c.cwd, 'checkout', '-b', 'topic');
    fs.writeFileSync(path.join(c.cwd, 'topic.txt'), 'topic\n');
    git(c.cwd, 'add', '.'); git(c.cwd, 'commit', '-m', 'topic');
    const topic = git(c.cwd, 'rev-parse', 'HEAD');
    git(c.cwd, 'checkout', 'main');
    const cManager = makeManager(c.service); const { messages: cMessages } = makeProvider(cManager);
    cManager.lastPublishedStatus = await cManager.getAllStatusesFresh();
    async function check(operation, ahead) {
      cMessages.length = 0; await operation(); await cManager.refreshStatusNow();
      const hash = git(c.cwd, 'rev-parse', 'HEAD');
      await until(() => cMessages.some(m => m.type === 'LOG_INIT_DATA' && m.branches.some(b => b.isHead && b.lastCommitHash === hash && b.aheadBehind?.ahead === ahead)), `Expected ahead=${ahead} at ${hash}`);
    }
    await check(() => git(c.cwd, 'commit', '--allow-empty', '-m', 'local'), 1);
    await check(() => c.service.rebase('topic'), 2);
    await check(() => c.service.resetTo(base, 'hard'), 0);
    await check(() => c.service.cherryPick(topic), 1);
    await check(() => c.service.revertCommit(git(c.cwd, 'rev-parse', 'HEAD')), 2);
  });
  await test('merge conflicts preserve HEAD and counts; resolved merge refreshes them', async () => {
    const c = repo('conflicts');
    git(c.cwd, 'checkout', '-b', 'topic');
    fs.writeFileSync(path.join(c.cwd, 'file.txt'), 'topic\n'); git(c.cwd, 'commit', '-am', 'topic');
    git(c.cwd, 'checkout', 'main');
    fs.writeFileSync(path.join(c.cwd, 'file.txt'), 'local\n'); git(c.cwd, 'commit', '-am', 'local');
    const cManager = makeManager(c.service); const { messages: cMessages } = makeProvider(cManager);
    cManager.lastPublishedStatus = await cManager.getAllStatusesFresh();
    const before = git(c.cwd, 'rev-parse', 'HEAD');
    await assert.rejects(c.service.merge('topic'), /CONFLICT/);
    const conflictStatus = await cManager.refreshStatusNow();
    assert.equal(conflictStatus.repos[0].conflictCount, 1);
    assert.equal(conflictStatus.repos[0].branch.aheadBehind.ahead, 1);
    assert.equal(git(c.cwd, 'rev-parse', 'HEAD'), before);
    await delay(500); assert.equal(cMessages.length, 0);
    fs.writeFileSync(path.join(c.cwd, 'file.txt'), 'local and topic\n');
    await c.service.stageFiles(['file.txt']);
    assert.ok(await c.service.commitMergeIfResolved());
    await cManager.refreshStatusNow();
    await until(() => cMessages.some(m => m.type === 'LOG_INIT_DATA' && m.branches.some(b => b.isHead && b.aheadBehind?.ahead === 3)), 'Resolved merge must publish its new commit/count');
  });
  await test('a pre-operation branch query cannot overwrite the new snapshot', async () => {
    const b = repo('b');
    const bManager = makeManager(b.service);
    let releaseOld;
    const oldBranches = await b.service.getBranches();
    const getAllBranches = bManager.getAllBranches.bind(bManager);
    let reads = 0;
    bManager.getAllBranches = (...args) => ++reads === 1
      ? new Promise(resolve => { releaseOld = () => resolve(oldBranches); })
      : getAllBranches(...args);
    const { provider, messages: bMessages } = makeProvider(bManager);
    const oldRead = provider.getFilteredBranches();
    fs.appendFileSync(path.join(b.cwd, 'file.txt'), 'new\n'); git(b.cwd, 'commit', '-am', 'new');
    bManager.notifyBranchesChanged({ refreshStatus: false });
    await until(() => reads >= 2, 'Branch-change synchronization reused a query started before the write');
    await until(() => bMessages.some(m => m.type === 'LOG_INIT_DATA' && m.branches.some(branch => branch.aheadBehind?.ahead === 1)), 'New branch state must arrive');
    releaseOld(); await oldRead; await delay(50);
    assert.equal(bMessages.filter(m => m.type === 'LOG_INIT_DATA').at(-1).branches.find(b => b.isHead).aheadBehind.ahead, 1);
  });
  await test('slow branch reads cannot roll back the manager cache', async () => {
    const c = repo('cache'); const cManager = makeManager(c.service);
    const getBranches = c.service.getBranches.bind(c.service);
    let releaseOld, reads = 0;
    c.service.getBranches = async () => {
      const branches = await getBranches();
      if (++reads === 1) await new Promise(resolve => { releaseOld = resolve; });
      return branches;
    };
    const oldRead = cManager.getAllBranches();
    await until(() => Boolean(releaseOld), 'Old branch snapshot must be captured');
    git(c.cwd, 'commit', '--allow-empty', '-m', 'new');
    await cManager.getAllBranches(); releaseOld(); await oldRead;
    assert.equal(cManager.getCachedBranches().find(b => b.isHead).aheadBehind.ahead, 1);
  });
  await test('current-branch consumers override stale nonzero VS Code tracking counts', async () => {
    const c = repo('cached-api');
    vscodeRepositories.set(c.cwd, { rootUri: { fsPath: c.cwd }, state: { HEAD: {
      type: 0, name: 'main', commit: git(c.cwd, 'rev-parse', 'HEAD'),
      upstream: { remote: 'origin', name: 'main' }, ahead: 99, behind: 99,
    } } });
    assert.equal((await c.service.getCurrentBranch()).aheadBehind.ahead, 0);
    git(c.cwd, 'commit', '--allow-empty', '-m', 'new');
    assert.equal((await c.service.getCurrentBranch()).aheadBehind.ahead, 1);
    git(c.cwd, 'push', 'origin', 'main');
    assert.equal((await c.service.getCurrentBranch()).aheadBehind.ahead, 0);
    git(c.cwd, 'branch', '--unset-upstream');
    assert.equal((await c.service.getCurrentBranch()).upstream, undefined);
    assert.equal((await c.service.getCurrentBranch()).aheadBehind, undefined);
    vscodeRepositories.delete(c.cwd);
  });
  await test('metadata watchers handle refs, packed refs and linked-worktree Git directories', async () => {
    const c = repo('watchers'); const cManager = makeManager(c.service);
    let branchChanges = 0, statusChanges = 0;
    cManager.scheduleBranchRefresh = () => branchChanges++;
    cManager.scheduleRefresh = () => statusChanges++;
    fsWatchers.length = 0;
    cManager.setupWatcher(c.cwd, c.service.repoId);
    const refs = fsWatchers.find(w => w.pattern.pattern.includes('packed-refs'));
    assert.ok(refs); assert.equal(refs.pattern.base, path.join(c.cwd, '.git'));
    for (const event of ['change', 'create', 'delete']) refs[event]({ fsPath: path.join(c.cwd, '.git', 'refs', 'heads', 'main') });
    assert.equal(branchChanges, 3); assert.equal(statusChanges, 3);
    const linked = path.join(dir, 'linked'); git(c.cwd, 'worktree', 'add', '-b', 'linked', linked);
    const metadata = git(linked, 'rev-parse', '--absolute-git-dir');
    fsWatchers.length = 0;
    cManager.setupWatcher(linked, 'linked');
    assert.ok(fsWatchers.some(w => w.pattern.base === metadata && w.pattern.pattern.includes('HEAD')));
    assert.ok(fsWatchers.some(w => fs.realpathSync(w.pattern.base) === fs.realpathSync(path.join(c.cwd, '.git')) && w.pattern.pattern.includes('refs/**')));
    assert.ok(fsWatchers.some(w => w.pattern.base === metadata && w.pattern.pattern === 'index'));
    let stateListener;
    vscodeRepositories.set(c.cwd, { rootUri: { fsPath: c.cwd }, state: { HEAD: { name: 'main', commit: 'cached' }, onDidChange: fn => { stateListener = fn; return { dispose() {} }; } } });
    fsWatchers.length = 0; cManager.setupWatcher(c.cwd, c.service.repoId);
    assert.ok(stateListener);
    assert.ok(fsWatchers.some(w => w.pattern.pattern.includes('packed-refs')), 'Metadata watchers must remain active alongside vscode.git');
    vscodeRepositories.delete(c.cwd);
  });
  assert.deepEqual(errors, []);
  console.log(`${passed} branch refresh scenarios passed with real temporary Git repositories.`);
} finally {
  providers.forEach(provider => provider.dispose());
  managers.forEach(manager => { manager.disposed = true; for (const key of ['branchDebounce', 'refreshDebounce']) if (manager[key]) clearTimeout(manager[key]); });
  fs.rmSync(dir, { recursive: true, force: true });
}
