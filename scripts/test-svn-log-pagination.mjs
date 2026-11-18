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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-svn-log-test-'));
const format = (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));

const vscode = {
  l10n: { t: format },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  extensions: { getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback, inspect: () => undefined, update: async () => undefined }) },
  commands: { executeCommand: async () => undefined },
  Uri: { file: fsPath => ({ fsPath }) },
  env: { appName: 'Visual Studio Code', language: 'en' },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_, fn) => fn({ report() {} }),
  },
};

const hasSvn = (() => {
  try { execFileSync('svn', ['--version', '--quiet'], { stdio: 'ignore' }); execFileSync('svnadmin', ['--version', '--quiet'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
if (!hasSvn) {
  console.log('SKIPPED SVN log pagination scenarios: svn/svnadmin are not installed.');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const bundle = await build({
  stdin: { contents: "export {SvnService} from './src/host/svn/SvnService';", resolveDir: root },
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
const { SvnService } = module.exports;

const svn = (cwd, ...args) => execFileSync('svn', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function createLogger() {
  const events = { trace: [], debug: [], info: [], warn: [], error: [] };
  const record = level => (scope, message, details) => { events[level].push({ scope, message, details }); };
  return {
    events,
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    dispose() {},
  };
}

const countLogPageErrors = logger => logger.events.error.filter(event => event.message === 'Failed to fetch linear log page').length;
const countBoundaryHits = logger => logger.events.debug.filter(event => event.message === 'Reached the beginning of SVN path history').length;

/**
 * 建一个路径诞生于 r2 的仓库，并产生 total 条线性历史。
 * total = 1（r2 创建）+ 1（r3 首次提交）+ 其余提交数。
 */
function seedRepository(name, total) {
  const repoPath = path.join(dir, name);
  execFileSync('svnadmin', ['create', repoPath], { stdio: 'ignore' });
  const url = `file://${repoPath}`;
  svn(dir, 'mkdir', `${url}/A`, '-m', 'r1');
  svn(dir, 'mkdir', `${url}/A/trunk`, '-m', 'r2');
  const wc = path.join(dir, `${name}-wc`);
  svn(dir, 'checkout', `${url}/A/trunk`, wc);
  fs.writeFileSync(path.join(wc, 'f.txt'), 'v3\n');
  svn(wc, 'add', 'f.txt');
  svn(wc, 'commit', '-m', 'c3');
  for (let i = 1; i <= total - 2; i += 1) {
    fs.writeFileSync(path.join(wc, 'f.txt'), `v${i + 3}\n`);
    svn(wc, 'commit', '-m', `c${i + 3}`);
  }
  const actual = svn(wc, 'log', '-r', 'HEAD:1', '--xml').split('<logentry').length - 1;
  assert.equal(actual, total, 'seed: 历史条数应与预期一致');
  return { wc };
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

try {
  await test('历史少于页大小时，图日志预取后不再发起注定失败的分页请求', async () => {
    const { wc } = seedRepository('small', 16);
    const logger = createLogger();
    const service = new SvnService('small', wc, undefined, undefined, undefined, logger);

    await service.getGraphLog(100);
    const nodes = await service.getLog(100, 0);

    assert.equal(nodes.length, 16, '应返回全部历史');
    assert.equal(countLogPageErrors(logger), 0, '不应记录分页错误');
  });

  await test('历史超过页大小且非整数倍时，翻页仍能取到更早的日志', async () => {
    const { wc } = seedRepository('paged', 15);
    const logger = createLogger();
    const service = new SvnService('paged', wc, undefined, undefined, undefined, logger);

    const firstPage = await service.getLog(10, 0);
    assert.equal(firstPage.length, 10);

    const all = await service.getLog(20, 0);
    assert.equal(all.length, 15, '第二页应补足剩余 5 条');
    assert.equal(countLogPageErrors(logger), 0);
    assert.equal(countBoundaryHits(logger), 0, '未到最后不应触发边界判定');
  });

  await test('历史恰好是页大小整数倍时，探测确认到头且不再报错', async () => {
    const { wc } = seedRepository('exact', 20);
    const logger = createLogger();
    const service = new SvnService('exact', wc, undefined, undefined, undefined, logger);

    assert.equal((await service.getLog(10, 0)).length, 10);
    assert.equal((await service.getLog(20, 0)).length, 20);

    // 第三页会请求 -r 1:1 并收到 E195012，此时用 info 复核确认节点不存在
    assert.equal((await service.getLog(30, 0)).length, 20);
    assert.equal(countLogPageErrors(logger), 0, '确认到头后不应再记录错误');
    assert.equal(countBoundaryHits(logger), 1, '应只探测一次');

    // 后续请求直接使用缓存，不再重复探测
    assert.equal((await service.getLog(100, 0)).length, 20);
    assert.equal(countBoundaryHits(logger), 1);
    assert.equal(countLogPageErrors(logger), 0);
  });

  await test('探测只在节点确实不存在于该修订时判定为到头', async () => {
    const { wc } = seedRepository('probe', 5);
    const service = new SvnService('probe', wc);

    assert.equal(await service.pathMissingAtRevision(1), true, 'r1 尚无此路径');
    assert.equal(await service.pathMissingAtRevision(2), false, 'r2 已创建此路径');
    assert.equal(await service.pathMissingAtRevision(5), false);
  });

  console.log(`\n${passed} SVN log pagination scenarios passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
