import * as vscode from 'vscode';
import type { AiBranchNameService } from '../aiBranchName/AiBranchNameService';
import { getBranchCleanCharacter, sanitizeBranchName, validateBranchNameInput } from '../utils/branchNameSanitizer';
import { t } from '../utils/l10n';

/** One native input owns the name, task, generation and validation lifecycle. */
export async function promptBranchName(
  service: AiBranchNameService | undefined,
  repoIds: readonly string[],
  options: vscode.InputBoxOptions,
): Promise<string | undefined> {
  if (!service?.supports(repoIds)) return vscode.window.showInputBox(options);
  const namingService = service;
  return new Promise(resolve => {
    const input = vscode.window.createInputBox();
    const aiButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('sparkle'), tooltip: t('Generate branch name with AI') };
    const cancellation = new vscode.CancellationTokenSource();
    const subscriptions: vscode.Disposable[] = [];
    let mode: 'name' | 'task' | 'busy' = 'name';
    let savedName = options.value ?? '';
    let task = '';
    let finished = false;
    let version = 0;
    let changingMode = false;

    const finish = (value?: string): void => {
      if (finished) return;
      finished = true;
      cancellation.cancel();
      subscriptions.forEach(subscription => subscription.dispose());
      input.dispose();
      cancellation.dispose();
      resolve(value);
    };
    const showName = (name: string, error?: string): void => {
      if (finished) return;
      changingMode = true;
      mode = 'name';
      version++;
      input.busy = false;
      input.enabled = true;
      input.title = options.title ?? t('New Branch — Name');
      input.prompt = options.prompt;
      input.placeholder = options.placeHolder;
      input.buttons = [aiButton];
      input.value = name;
      input.valueSelection = [0, name.length];
      input.validationMessage = error ? { message: error, severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
      changingMode = false;
    };
    const localValidation = async (value: string): Promise<string | vscode.InputBoxValidationMessage | undefined | null> => {
      return options.validateInput ? options.validateInput(value) : validateBranchNameInput(value);
    };
    const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
    const accept = async (): Promise<void> => {
      if (finished || mode === 'busy') return;
      if (mode === 'task') {
        task = input.value;
        mode = 'busy';
        input.busy = true;
        input.enabled = false;
        input.buttons = [];
        input.prompt = t('Generating branch name…');
        input.validationMessage = undefined;
        try {
          const name = await namingService.generate(repoIds, task, cancellation.token);
          showName(name);
        } catch (error) {
          showName(savedName, t('Could not generate branch name: {0}', errorText(error)));
        }
        return;
      }
      const value = input.value;
      mode = 'busy';
      input.busy = true;
      input.enabled = false;
      try {
        const validation = await localValidation(value);
        if (finished) return;
        if (typeof validation === 'string' || validation?.severity === vscode.InputBoxValidationSeverity.Error) {
          showName(value);
          input.validationMessage = validation;
          return;
        }
        const name = sanitizeBranchName(value.trim(), getBranchCleanCharacter());
        const error = await namingService.validate(name, repoIds);
        if (finished) return;
        if (error) {
          showName(value);
          input.validationMessage = { message: error, severity: vscode.InputBoxValidationSeverity.Error };
        } else {
          finish(name);
        }
      } catch (error) {
        showName(value, errorText(error));
      }
    };

    subscriptions.push(input.onDidHide(() => {
      if (mode === 'task') showName(savedName);
      else finish();
      if (!finished) input.show();
    }));
    subscriptions.push(input.onDidAccept(() => { void accept(); }));
    subscriptions.push(input.onDidTriggerButton(button => {
      if (mode === 'busy' || finished) return;
      if (button === vscode.QuickInputButtons.Back) {
        task = input.value;
        showName(savedName);
      } else if (button === aiButton) {
        savedName = input.value;
        changingMode = true;
        mode = 'task';
        version++;
        input.title = t('AI Branch Name — Task');
        input.prompt = t('Describe your task, or leave empty to generate from current changes.');
        input.placeholder = t('e.g. Fix login timeout');
        input.buttons = [vscode.QuickInputButtons.Back];
        input.value = task;
        input.validationMessage = undefined;
        changingMode = false;
      }
    }));
    subscriptions.push(input.onDidChangeValue(value => {
      if (changingMode || mode === 'busy' || finished) return;
      input.validationMessage = undefined;
      if (mode !== 'name') return;
      const currentVersion = ++version;
      void localValidation(value).then(validation => {
        if (!finished && mode === 'name' && version === currentVersion) input.validationMessage = validation ?? undefined;
      }).catch(() => {});
    }));
    input.ignoreFocusOut = options.ignoreFocusOut ?? true;
    showName(savedName);
    input.show();
  });
}
