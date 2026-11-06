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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-svn-ignore-test-'));
const format = (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));

// 由用例控制：返回按钮文案代表用户确认，返回 undefined 代表取消。
let confirmAnswer;
let confirmCalls = 0;
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
    showWarningMessage: async (_message, _options, ...items) => {
      confirmCalls += 1;
      return confirmAnswer ? confirmAnswer(items) : undefined;
    },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_, fn) => fn({ report() {} }),
  },
};

const hasSvn = (() => {
  try { execFileSync('svn', ['--version', '--quiet'], { stdio: 'ignore' }); execFileSync('svnadmin', ['--version', '--quiet'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
if (!hasSvn) {
  console.log('SKIPPED SVN ignore scenarios: svn/svnadmin are not installed.');
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
const ignoreLines = (cwd, target = '.') => {
  try {
    return svn(cwd, 'propget', 'svn:ignore', target).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

function seedWorkingCopy(name) {
  const repoPath = path.join(dir, name);
  execFileSync('svnadmin', ['create', repoPath], { stdio: 'ignore' });
  const url = `file://${repoPath}`;
  svn(dir, 'mkdir', `${url}/trunk`, '-m', 'init');
  const wc = path.join(dir, `${name}-wc`);
  svn(dir, 'checkout', `${url}/trunk`, wc);
  fs.writeFileSync(path.join(wc, 'seed.txt'), 'seed\n');
  svn(wc, 'add', 'seed.txt');
  fs.mkdirSync(path.join(wc, 'src'));
  svn(wc, 'add', 'src');
  svn(wc, 'commit', '-m', 'seed');
  return { wc, service: new SvnService(name, wc) };
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

try {
  const { wc, service } = seedWorkingCopy('repo');

  await test('ignore on a versioned parent keeps working without any confirmation', async () => {
    confirmCalls = 0;
    confirmAnswer = items => items[0];
    const result = await service.addIgnoreEntry('src/ignored.tmp');
    assert.deepEqual({ ...result }, { directoryPath: 'src', entry: 'ignored.tmp', fullPath: 'src/ignored.tmp', alreadyExists: false });
    assert.equal(confirmCalls, 0, 'versioned parent must not ask for confirmation');
    assert.deepEqual(ignoreLines(wc, 'src'), ['ignored.tmp']);
  });

  await test('repeated ignore on a versioned parent reports alreadyExists', async () => {
    confirmCalls = 0;
    const result = await service.addIgnoreEntry('src/ignored.tmp');
    assert.equal(result?.alreadyExists, true);
    assert.equal(confirmCalls, 0);
  });

  await test('unversioned parent chain falls back to the nearest versioned ancestor', async () => {
    fs.mkdirSync(path.join(wc, 'xsim.dir', 'work'), { recursive: true });
    fs.writeFileSync(path.join(wc, 'xsim.dir', 'work', 'work.rlx'), 'simulation\n');
    confirmCalls = 0;
    confirmAnswer = items => items[0];

    const result = await service.addIgnoreEntry('xsim.dir/work/work.rlx');

    assert.deepEqual({ ...result }, { directoryPath: '', entry: 'xsim.dir', fullPath: 'xsim.dir', alreadyExists: false });
    assert.equal(confirmCalls, 1, 'scope widening must be confirmed');
    assert.deepEqual(ignoreLines(wc), ['xsim.dir']);
    assert.doesNotMatch(svn(wc, 'status'), /xsim\.dir/, 'ignored subtree must disappear from status');
  });

  await test('cancelling the widened ignore leaves the working copy untouched', async () => {
    fs.mkdirSync(path.join(wc, 'build', 'out'), { recursive: true });
    fs.writeFileSync(path.join(wc, 'build', 'out', 'image.bin'), 'binary\n');
    confirmCalls = 0;
    confirmAnswer = () => undefined;

    const result = await service.addIgnoreEntry('build/out/image.bin');

    assert.equal(result, undefined);
    assert.equal(confirmCalls, 1);
    assert.deepEqual(ignoreLines(wc), ['xsim.dir'], 'cancelled ignore must not change svn:ignore');
    assert.match(svn(wc, 'status'), /\?\s+build/, 'cancelled subtree must stay unignored');
  });

  await test('fallback stops at an intermediate versioned directory', async () => {
    fs.mkdirSync(path.join(wc, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(wc, 'src', 'gen', 'out.txt'), 'generated\n');
    confirmCalls = 0;
    confirmAnswer = items => items[0];

    const result = await service.addIgnoreEntry('src/gen/out.txt');

    assert.deepEqual({ ...result }, { directoryPath: 'src', entry: 'gen', fullPath: 'src/gen', alreadyExists: false });
    assert.equal(confirmCalls, 1);
    assert.deepEqual(ignoreLines(wc, 'src'), ['ignored.tmp', 'gen']);
    assert.doesNotMatch(svn(wc, 'status'), /src\/gen/, 'ignored subtree must disappear from status');
  });

  await test('a working copy without versioned parents reports an actionable error', async () => {
    const plainRoot = path.join(dir, 'plain');
    fs.mkdirSync(path.join(plainRoot, 'a'), { recursive: true });
    fs.writeFileSync(path.join(plainRoot, 'a', 'b.txt'), 'detached\n');
    confirmCalls = 0;
    confirmAnswer = items => items[0];

    const plainService = new SvnService('plain', plainRoot);
    await assert.rejects(
      plainService.addIgnoreEntry('a/b.txt'),
      /No versioned parent directory was found for "a\/b\.txt"/,
    );
    assert.equal(confirmCalls, 0);
  });

  await test('a .gitignore in the working copy does not interfere with SVN ignore', async () => {
    fs.writeFileSync(path.join(wc, '.gitignore'), 'xsim.dir/\n*.tmp\n');
    fs.mkdirSync(path.join(wc, 'logs', 'run1'), { recursive: true });
    fs.writeFileSync(path.join(wc, 'logs', 'run1', 'run.log'), 'log\n');
    confirmCalls = 0;
    confirmAnswer = items => items[0];

    const result = await service.addIgnoreEntry('logs');

    assert.deepEqual({ ...result }, { directoryPath: '', entry: 'logs', fullPath: 'logs', alreadyExists: false });
    assert.equal(confirmCalls, 0);
    assert.deepEqual(ignoreLines(wc).sort(), ['logs', 'xsim.dir'].sort());
  });

  await test('special characters stay raw in svn:ignore without git-style escaping', async () => {
    const names = ['a#b.tmp', '!important.tmp', 'star*name.tmp', ' lead.tmp'];
    for (const name of names) fs.writeFileSync(path.join(wc, 'src', name), 'x\n');
    confirmCalls = 0;
    confirmAnswer = items => items[0];

    for (const name of names) {
      const result = await service.addIgnoreEntry(`src/${name}`);
      assert.equal(result?.entry, name, 'svn:ignore 必须原样保存名称');
      assert.equal(result?.directoryPath, 'src');
      assert.equal(confirmCalls, 0, 'versioned parent must not ask for confirmation');
    }

    const lines = ignoreLines(wc, 'src');
    for (const name of names) assert.ok(lines.includes(name), `${JSON.stringify(name)} 应以原文出现`);
    for (const line of lines) {
      assert.doesNotMatch(line, /^\/|^\//, 'svn:ignore 不应带前导斜杠');
      assert.doesNotMatch(line, /\/$/, 'svn:ignore 不应带尾部斜杠');
      assert.doesNotMatch(line, /\\/, 'svn:ignore 不应包含转义反斜杠');
    }
  });

  console.log(`${passed} real SVN ignore scenarios passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
