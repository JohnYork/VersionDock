import * as vscode from 'vscode';
import { t } from '../utils/l10n';

interface SvnIgnoreCandidatePickItem extends vscode.QuickPickItem {
  filePath?: string;
}

interface SvnIgnoreStatusSource {
  getStatus(): Promise<{ unstagedFiles: Array<{ status: string; path: string }> }>;
}

/**
 * 选择要加入 SVN 忽略的目标路径。
 *
 * QuickPick 的过滤框只用于筛选候选项，回车返回的是当前高亮项而不是输入的文本；
 * 且过滤时会按 label 做字符串重排（排序开关未暴露给扩展），带中文前缀的自定义项
 * 会被 ASCII 路径项挤到末尾。因此自定义项直接以用户键入的路径作为 label，
 * 这样它按字典序排在自己所有子孙路径之前，稳定停在列表顶端。
 */
export async function pickSvnIgnorePath(repo: SvnIgnoreStatusSource): Promise<string | undefined> {
  const status = await repo.getStatus().catch(() => undefined);
  const untrackedPaths = Array.from(new Set(
    (status?.unstagedFiles ?? [])
      .filter(file => file.status === 'untracked')
      .map(file => file.path),
  )).sort((left, right) => left.localeCompare(right));
  const candidates: SvnIgnoreCandidatePickItem[] = untrackedPaths.map(filePath => ({ label: filePath, filePath }));

  const quickPick = vscode.window.createQuickPick<SvnIgnoreCandidatePickItem>();
  quickPick.title = t('Add SVN Ignore...');
  quickPick.placeholder = untrackedPaths.length > 0
    ? t('Select an unversioned file or folder to ignore, or type a path')
    : t('Enter a path relative to the repository root');
  quickPick.matchOnDescription = true;
  quickPick.items = candidates;

  let accepted: string | undefined;
  return new Promise<string | undefined>(resolve => {
    const disposables: vscode.Disposable[] = [];
    disposables.push(quickPick.onDidChangeValue(value => {
      const entered = value.trim();
      if (!entered) {
        quickPick.items = candidates;
        return;
      }
      quickPick.items = [
        { label: entered, description: t('Use this path'), filePath: entered, alwaysShow: true },
        ...candidates.filter(candidate => candidate.filePath !== entered),
      ];
    }));
    disposables.push(quickPick.onDidAccept(() => {
      accepted = quickPick.selectedItems[0]?.filePath ?? quickPick.value.trim();
      quickPick.hide();
    }));
    disposables.push(quickPick.onDidHide(() => {
      for (const disposable of disposables) disposable.dispose();
      quickPick.dispose();
      resolve(accepted || undefined);
    }));
    quickPick.show();
  });
}
