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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-git-log-test-'));

const format = (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
const vscode = {
  l10n: { t: format },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  extensions: { getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
  commands: { executeCommand: async () => undefined },
  Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
  window: {},
};

const bundle = await build({
  stdin: { contents: "export {GitService} from './src/host/git/GitService'; export {WorkspaceGitManager} from './src/host/git/WorkspaceGitManager';", resolveDir: root },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'simple-git'],
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: id => id === 'vscode' ? vscode : require(id),
  process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder,
});
const { GitService, WorkspaceGitManager } = module.exports;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repository(name, commitCount) {
  const cwd = path.join(dir, name);
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Log Test');
  git(cwd, 'config', 'user.email', 'log-test@example.test');
  for (let i = 1; i <= commitCount; i += 1) {
    fs.writeFileSync(path.join(cwd, 'f.txt'), `v${i}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', `c${i}`);
  }
  git(cwd, 'remote', 'add', 'origin', path.join(cwd, '.git'));
  return { cwd, service: new GitService(name, cwd) };
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

function makeManager(services) {
  const manager = Object.create(WorkspaceGitManager.prototype);
  Object.assign(manager, {
    repos: new Map(services.map(service => [service.repoId, service])),
    repoMetas: new Map(services.map(service => [service.repoId, {
      id: service.repoId, name: service.repoId, rootPath: service.rootPath, kind: 'git',
    }])),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
  });
  return manager;
}

try {
  await test('历史少于页大小时 hasMore 为 false', async () => {
    const { service } = repository('small', 3);
    const commits = await service.getLog(10, 0);
    assert.equal(commits.length, 3);
    assert.equal(commits.hasMore, false);
  });

  await test('历史恰好等于页大小时 hasMore 为 false', async () => {
    const { service } = repository('exact', 10);
    const commits = await service.getLog(10, 0);
    assert.equal(commits.length, 10);
    assert.equal(commits.hasMore, false, '恰好取满一页时不应再让调用方继续请求');
  });

  await test('历史超过页大小时逐页翻取且 hasMore 正确', async () => {
    const { service } = repository('paged', 12);
    const firstPage = await service.getLog(10, 0);
    assert.equal(firstPage.length, 10);
    assert.equal(firstPage.hasMore, true);

    const secondPage = await service.getLog(10, 10);
    assert.equal(secondPage.length, 2);
    assert.equal(secondPage.hasMore, false);
  });

  await test('skip 越过末尾时返回空页且 hasMore 为 false', async () => {
    const { service } = repository('overflow', 12);
    const commits = await service.getLog(10, 50);
    assert.equal(commits.length, 0);
    assert.equal(commits.hasMore, false);
  });

  await test('比较视图的分页也使用显式 hasMore', async () => {
    const { cwd, service } = repository('compare', 5);
    git(cwd, 'checkout', '-b', 'feature', 'HEAD~2');
    for (let i = 1; i <= 3; i += 1) {
      fs.writeFileSync(path.join(cwd, 'feature.txt'), `v${i}\n`);
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-m', `f${i}`);
    }
    const opts = { baseRef: 'main', targetRef: 'feature', side: 'targetOnly' };

    const firstPage = await service.getCompareLog(2, 0, opts);
    assert.equal(firstPage.length, 2);
    assert.equal(firstPage.hasMore, true);

    const secondPage = await service.getCompareLog(2, 2, opts);
    assert.equal(secondPage.length, 1);
    assert.equal(secondPage.hasMore, false);
  });

  await test('多仓库翻页只补增量且结果完整无重复', async () => {
    const a = repository('multi-a', 12);
    const b = repository('multi-b', 5);
    const calls = [];
    for (const service of [a.service, b.service]) {
      const original = service.getLog.bind(service);
      service.getLog = async (limit, skip, opts) => {
        calls.push({ repo: service.repoId, limit, skip });
        return original(limit, skip, opts);
      };
    }
    const manager = makeManager([a.service, b.service]);
    const repoIds = ['multi-a', 'multi-b'];
    const pageLengths = [];
    const hashes = [];
    for (const skip of [0, 5, 10, 15]) {
      const page = await manager.getInterleavedLog(repoIds, 5, skip, { consumer: 'test', generation: 1 });
      pageLengths.push(page.length);
      hashes.push(...page.map(commit => commit.hash));
    }

    assert.deepEqual(pageLengths, [5, 5, 5, 2], '每页条数应连续');
    assert.equal(hashes.length, 17, '应覆盖两个仓库的全部 17 条提交');
    assert.equal(new Set(hashes).size, hashes.length, '翻页不应重复输出提交');

    const aCalls = calls.filter(call => call.repo === 'multi-a');
    assert.deepEqual(aCalls.map(call => call.skip), [0, 5, 10], '翻页只应取增量，不再从 0 重取');
    assert.deepEqual(aCalls.map(call => call.limit), [5, 5, 5]);
  });

  await test('重载（generation 变化或 skip=0）会丢弃旧会话', async () => {
    const a = repository('reset-a', 8);
    const b = repository('reset-b', 6);
    const calls = [];
    for (const service of [a.service, b.service]) {
      const original = service.getLog.bind(service);
      service.getLog = async (limit, skip, opts) => {
        calls.push({ repo: service.repoId, skip });
        return original(limit, skip, opts);
      };
    }
    const manager = makeManager([a.service, b.service]);
    const repoIds = ['reset-a', 'reset-b'];
    await manager.getInterleavedLog(repoIds, 5, 0, { consumer: 'test', generation: 1 });
    await manager.getInterleavedLog(repoIds, 5, 5, { consumer: 'test', generation: 1 });

    calls.length = 0;
    await manager.getInterleavedLog(repoIds, 5, 0, { consumer: 'test', generation: 2 });
    assert.equal(calls.filter(call => call.repo === 'reset-a')[0]?.skip, 0, 'generation 变化后应重新从头部取数');

    calls.length = 0;
    await manager.getInterleavedLog(repoIds, 5, 0, { consumer: 'test', generation: 2 });
    assert.equal(calls.filter(call => call.repo === 'reset-a')[0]?.skip, 0, 'generation 相同时 skip=0 也必须重置');
  });

  await test('超过缓存上限后回退为无缓存分页', async () => {
    const a = repository('cap-a', 12);
    const b = repository('cap-b', 5);
    const calls = [];
    for (const service of [a.service, b.service]) {
      const original = service.getLog.bind(service);
      service.getLog = async (limit, skip, opts) => {
        calls.push({ repo: service.repoId, limit, skip });
        return original(limit, skip, opts);
      };
    }
    const manager = makeManager([a.service, b.service]);
    manager.interleavedLogCacheLimit = 6;
    const repoIds = ['cap-a', 'cap-b'];

    const firstPage = await manager.getInterleavedLog(repoIds, 5, 0, { consumer: 'cap', generation: 1 });
    assert.equal(firstPage.length, 5);

    calls.length = 0;
    const secondPage = await manager.getInterleavedLog(repoIds, 5, 5, { consumer: 'cap', generation: 1 });
    assert.equal(secondPage.length, 5);
    const aCalls = calls.filter(call => call.repo === 'cap-a');
    assert.deepEqual(aCalls, [{ repo: 'cap-a', limit: 10, skip: 0 }], '超过上限时应从头部重取全量窗口');
  });

  await test('显式清理会丢弃分页会话', async () => {
    const a = repository('clear-a', 12);
    const b = repository('clear-b', 5);
    const calls = [];
    for (const service of [a.service, b.service]) {
      const original = service.getLog.bind(service);
      service.getLog = async (limit, skip, opts) => {
        calls.push({ repo: service.repoId, limit, skip });
        return original(limit, skip, opts);
      };
    }
    const manager = makeManager([a.service, b.service]);
    const repoIds = ['clear-a', 'clear-b'];
    await manager.getInterleavedLog(repoIds, 5, 0, { consumer: 'clear', generation: 1 });
    await manager.getInterleavedLog(repoIds, 5, 5, { consumer: 'clear', generation: 1 });

    calls.length = 0;
    manager.clearInterleavedLogCache();
    await manager.getInterleavedLog(repoIds, 5, 10, { consumer: 'clear', generation: 1 });
    const aCalls = calls.filter(call => call.repo === 'clear-a');
    assert.deepEqual(aCalls, [{ repo: 'clear-a', limit: 15, skip: 0 }], '清理后应重新从头部取数');
  });

  console.log(`\n${passed} Git log pagination scenarios passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
