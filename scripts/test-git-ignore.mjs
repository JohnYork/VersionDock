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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-gitignore-test-'));

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
  stdin: {
    contents: "export {GitService} from './src/host/git/GitService'; export {buildGitignorePattern, gitignoreAppliesTo} from './src/host/git/gitignorePattern';",
    resolveDir: root,
  },
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
const { GitService, buildGitignorePattern, gitignoreAppliesTo } = module.exports;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const isIgnored = (cwd, target) => {
  try {
    git(cwd, 'check-ignore', '-q', target);
    return true;
  } catch {
    return false;
  }
};

function repository(name) {
  const cwd = path.join(dir, name);
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Ignore Test');
  git(cwd, 'config', 'user.email', 'ignore-test@example.test');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'one\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  git(cwd, 'remote', 'add', 'origin', path.join(cwd, '.git'));
  return { cwd, service: new GitService(name, cwd) };
}

const appendRuleTo = (file, target, isDirectory) => {
  const rule = buildGitignorePattern(target, isDirectory);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, existing.endsWith('\n') || existing === '' ? existing + rule + '\n' : existing + '\n' + rule + '\n');
  return rule;
};

const appendRule = (cwd, target, isDirectory) => appendRuleTo(path.join(cwd, '.gitignore'), target, isDirectory);

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

try {
  await test('目录规则锚定在仓库根并带尾部斜杠', async () => {
    const repo = repository('anchored');
    fs.mkdirSync(path.join(repo.cwd, 'xsim.dir', 'work'), { recursive: true });
    fs.writeFileSync(path.join(repo.cwd, 'xsim.dir', 'work', 'work.rlx'), 'x\n');
    assert.equal(appendRule(repo.cwd, 'xsim.dir', true), '/xsim.dir/');
    assert.equal(isIgnored(repo.cwd, 'xsim.dir/work/work.rlx'), true);
  });

  await test('锚定规则不会波及子目录中的同名路径', async () => {
    const repo = repository('depth');
    fs.mkdirSync(path.join(repo.cwd, 'u'), { recursive: true });
    fs.mkdirSync(path.join(repo.cwd, 'sub', 'u'), { recursive: true });
    fs.writeFileSync(path.join(repo.cwd, 'u', 'f.txt'), 'x\n');
    fs.writeFileSync(path.join(repo.cwd, 'sub', 'u', 'f.txt'), 'x\n');
    appendRule(repo.cwd, 'u', true);
    assert.equal(isIgnored(repo.cwd, 'u/f.txt'), true);
    assert.equal(isIgnored(repo.cwd, 'sub/u/f.txt'), false);
  });

  await test('特殊字符文件名被转义后仍能精确匹配', async () => {
    const repo = repository('escaping');
    for (const name of ['a#b.txt', '!important.txt', 'star*name.txt', 'bracket[x].txt', ' lead.txt', 'trail.txt ']) {
      fs.writeFileSync(path.join(repo.cwd, name), 'x\n');
    }
    for (const name of ['a#b.txt', '!important.txt', 'star*name.txt', 'bracket[x].txt', ' lead.txt', 'trail.txt ']) {
      appendRule(repo.cwd, name, false);
    }
    for (const name of ['a#b.txt', '!important.txt', 'star*name.txt', 'bracket[x].txt', ' lead.txt', 'trail.txt ']) {
      assert.equal(isIgnored(repo.cwd, name), true, `${name} 应被忽略`);
    }
    assert.equal(isIgnored(repo.cwd, 'other.txt'), false);
  });

  await test('已跟踪路径被识别，未跟踪路径不被识别', async () => {
    const repo = repository('tracked-check');
    fs.mkdirSync(path.join(repo.cwd, 'untracked-dir'), { recursive: true });
    fs.writeFileSync(path.join(repo.cwd, 'untracked-dir', 'f.txt'), 'x\n');
    fs.mkdirSync(path.join(repo.cwd, 'tracked-dir'), { recursive: true });
    fs.writeFileSync(path.join(repo.cwd, 'tracked-dir', 'f.txt'), 'x\n');
    git(repo.cwd, 'add', 'tracked-dir');
    git(repo.cwd, 'commit', '-m', 'add dir');

    assert.equal(await repo.service.hasTrackedFiles('tracked.txt'), true);
    assert.equal(await repo.service.hasTrackedFiles('tracked-dir'), true);
    assert.equal(await repo.service.hasTrackedFiles('tracked-dir/f.txt'), true);
    assert.equal(await repo.service.hasTrackedFiles('untracked-dir'), false);
    assert.equal(await repo.service.hasTrackedFiles('untracked-dir/f.txt'), false);
  });

  await test('只接受目录能覆盖目标路径的 .gitignore 候选', async () => {
    const cwd = path.join(dir, 'candidates');
    fs.mkdirSync(cwd);
    const rootIgnore = path.join(cwd, '.gitignore');
    const vendorIgnore = path.join(cwd, 'vendor', '.gitignore');
    assert.equal(gitignoreAppliesTo(rootIgnore, path.join(cwd, 'root.log')), true);
    assert.equal(gitignoreAppliesTo(rootIgnore, path.join(cwd, 'vendor', 'nested.log')), true);
    assert.equal(gitignoreAppliesTo(vendorIgnore, path.join(cwd, 'root.log')), false);
    assert.equal(gitignoreAppliesTo(vendorIgnore, path.join(cwd, 'vendor', 'nested.log')), true);
  });

  await test('仅存在子目录 .gitignore 时，根目录目标改写到仓库根并生效', async () => {
    const repo = repository('p3-root-target');
    fs.mkdirSync(path.join(repo.cwd, 'vendor'));
    const vendorIgnore = path.join(repo.cwd, 'vendor', '.gitignore');
    fs.writeFileSync(vendorIgnore, '# vendor rules\n');
    fs.writeFileSync(path.join(repo.cwd, 'root.log'), 'x\n');

    const candidates = [vendorIgnore].filter(file => gitignoreAppliesTo(file, path.join(repo.cwd, 'root.log')));
    assert.deepEqual(candidates, []);
    const rule = appendRule(repo.cwd, 'root.log', false);
    assert.equal(rule, '/root.log');
    assert.equal(fs.readFileSync(vendorIgnore, 'utf8'), '# vendor rules\n');
    assert.equal(isIgnored(repo.cwd, 'root.log'), true);
  });

  await test('目标位于子目录时保留并使用该子目录的 .gitignore', async () => {
    const repo = repository('p3-nested-target');
    fs.mkdirSync(path.join(repo.cwd, 'vendor'));
    const vendorIgnore = path.join(repo.cwd, 'vendor', '.gitignore');
    fs.writeFileSync(vendorIgnore, '# vendor rules\n');
    fs.writeFileSync(path.join(repo.cwd, 'vendor', 'nested.log'), 'x\n');

    const candidates = [vendorIgnore].filter(file => gitignoreAppliesTo(file, path.join(repo.cwd, 'vendor', 'nested.log')));
    assert.deepEqual(candidates, [vendorIgnore]);
    assert.equal(appendRuleTo(vendorIgnore, 'nested.log', false), '/nested.log');
    assert.equal(fs.existsSync(path.join(repo.cwd, '.gitignore')), false);
    assert.equal(isIgnored(repo.cwd, 'vendor/nested.log'), true);
  });

  await test('已由现有规则覆盖的路径被识别，含通配模式', async () => {
    const repo = repository('existing-rule');
    fs.writeFileSync(path.join(repo.cwd, '.gitignore'), '/logs/\n*.tmp\n');
    fs.mkdirSync(path.join(repo.cwd, 'logs'));
    fs.writeFileSync(path.join(repo.cwd, 'logs', 'a.log'), 'x\n');
    fs.writeFileSync(path.join(repo.cwd, 'temp.tmp'), 'x\n');
    fs.writeFileSync(path.join(repo.cwd, 'other.txt'), 'x\n');

    const dirRule = await repo.service.findIgnoringRule('logs/a.log');
    assert.equal(dirRule.pattern, '/logs/');
    assert.equal(dirRule.source, path.join(repo.cwd, '.gitignore'));
    assert.equal(dirRule.line, 1);

    const globRule = await repo.service.findIgnoringRule('temp.tmp');
    assert.equal(globRule.pattern, '*.tmp');

    assert.equal(await repo.service.findIgnoringRule('other.txt'), undefined);
  });

  console.log(`\n${passed} tests passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
