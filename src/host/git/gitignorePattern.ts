import * as path from 'path';

/**
 * 判断某个 .gitignore 文件所在的目录能否覆盖目标路径。
 * 只有目标位于该 .gitignore 目录内（含子目录）时才成立，避免写出以 `../` 开头的无效规则。
 */
export function gitignoreAppliesTo(gitignoreFile: string, targetAbsolutePath: string): boolean {
  const relative = path.relative(path.dirname(gitignoreFile), targetAbsolutePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * 生成写入 .gitignore 的规则文本。
 *
 * - 前导 `/` 把规则锚定到 .gitignore 所在目录，避免同名文件在子目录被连带忽略
 * - 目录补尾部 `/`，只匹配目录本身
 * - 转义 glob、注释、否定和首尾空白字符，保证用户选中的名字就是被忽略的名字
 */
export function buildGitignorePattern(relativePath: string, isDirectory: boolean): string {
  const segments = relativePath.split('/').filter(segment => segment.length > 0);
  if (segments.length === 0) return '';
  const pattern = '/' + segments.map(escapeGitignoreSegment).join('/');
  return isDirectory ? `${pattern}/` : pattern;
}

function escapeGitignoreSegment(segment: string): string {
  const escaped = segment.replace(/([\\*?[\]!#])/g, '\\$1');
  const leadingSpaces = escaped.match(/^ */)?.[0].length ?? 0;
  const trailingSpaces = escaped.match(/ *$/)?.[0].length ?? 0;
  const core = escaped.slice(leadingSpaces, escaped.length - trailingSpaces);
  return `${'\\ '.repeat(leadingSpaces)}${core}${'\\ '.repeat(trailingSpaces)}`;
}
