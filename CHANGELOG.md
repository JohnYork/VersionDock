# 更改日志 / Changelog

## 1.0.4

### 修复

- 无损优化扩展图标，使其满足 VS Code Marketplace 的 1024 KB 文件大小限制；图标尺寸和像素保持不变。
- 发布前校验图标体积，避免检查与打包完成后才因图标过大被市场拒绝。
- 包含 1.0.3 的功能与修复；1.0.3 已发布到 GitHub，其 Marketplace 上传因图标大小限制失败。

### Fixes

- Losslessly optimize the extension icon to meet the VS Code Marketplace limit of 1024 KB, preserving its dimensions and pixels.
- Validate icon size before publishing, preventing oversized icons from being rejected after checks and packaging have completed.
- Include the features and fixes from 1.0.3. Version 1.0.3 was released on GitHub, but its Marketplace upload failed because of the icon size limit.

## 1.0.3

### 新增与改进

- Git 分支创建输入框支持 AI 命名：可根据任务描述或当前改动生成名称，编辑确认后再创建，并校验名称合法性与冲突。
- 工作树创建支持选择新分支的起点；选择远程分支时创建或复用本地分支，已占用分支可直接打开现有工作树。创建完成后可打开新窗口或加入工作区。
- 工作树列表增加父目录路径标签，帮助区分同名目录；操作期间禁用重复点击，列表读取失败时显示错误与重试入口。单独打开工作树时保留新建入口。
- 工作树移除增加确认和本地文件检查，保护未保存编辑器、搁置记录与游离状态下的独有提交；清理失效登记时同样保护搁置记录。

### 修复

- 修复提交、合并、推送、抓取和切换分支后，分支列表及上游同步数量未及时刷新的问题，避免较早的异步查询覆盖新状态。

### Features and improvements

- Add AI naming to Git branch creation inputs. Generate names from a task description or current changes, review and edit them before creation, and validate names and conflicts.
- Allow choosing a starting point for a new worktree branch. Create or reuse local branches when selecting remote branches, open existing worktrees for occupied branches, and offer opening a new window or adding the created worktree to the workspace.
- Add parent-directory labels to distinguish worktrees with the same directory name. Disable repeated operations while busy, show list errors with a retry action, and retain worktree creation when a linked worktree is opened on its own.
- Add removal confirmation and local-file checks to protect unsaved editors, shelves and detached commits without a branch or tag. Preserve shelves when pruning stale worktree registrations as well.

### Fixes

- Refresh branch lists and upstream synchronization counts after commits, merges, pushes, fetches and branch switches, and prevent older asynchronous queries from overwriting newer state.

## 1.0.2

### 发布支持

- 接入 GitHub Actions OIDC 与 Microsoft Entra 应用身份，可自动发布到 VS Code Marketplace，无需保存 PAT。
- 提供独立的 OIDC 认证与发布者访问校验，保留未配置 OIDC 时的 PAT 发布方式。
- 本次更新不改变插件的 Git / SVN 运行功能。

### Publishing support

- Support automated VS Code Marketplace publishing with GitHub Actions OIDC and a Microsoft Entra application identity, without storing a PAT.
- Add a separate OIDC authentication and publisher-access check, while retaining PAT publishing when OIDC is not configured.
- This update does not change the extension's Git/SVN runtime functionality.

## 1.0.1

### 改进

- 补充扩展内可查看的中英文更改日志，并在 README 中提供入口。
- 更新中英文 README 的功能说明、安装指引及 VersionDock Desktop 推荐。
- 简化贡献与安全反馈文案，集中保留来源与许可说明。

### Improvements

- Add a bilingual changelog available in the extension details, with links from both READMEs.
- Update feature descriptions, installation instructions and the VersionDock Desktop recommendation in both READMEs.
- Simplify contribution and security-reporting text while retaining attribution and license notices in their dedicated sections.

## 1.0.0

### 首次版本

- 提供 Git / SVN 更改管理、差异预览、按文件提交，以及 Git 暂存、Amend 和提交并推送。
- 支持混合多仓库工作区、Git 分支图谱、SVN 修订历史、历史筛选与提交比较。
- 提供 Git 分支与标签管理、同步、命名变更列表、Stash 和补丁搁置；在同一本地 Git 工作目录中与 VersionDock Desktop 共享搁置记录。
- 提供 Git / SVN 冲突列表、三栏文本合并编辑器、行注释和文件 / 选区历史。
- 提供可选 AI 提交信息生成、提交解释、代码审查、冲突解决建议和提交编排；需要配置模型服务或本地 Agent CLI。

### Initial version

- Git/SVN change management, diff previews and selected-file commits, plus Git staging, amend, and commit and push.
- Mixed multi-repository workspaces, Git branch graphs, SVN revision history, history filters and commit comparison.
- Git branch and tag management, synchronization, named changelists, Stash and patch shelves; shared shelves with VersionDock Desktop in the same local Git working directory.
- Git/SVN conflict lists, a three-pane text merge editor, line annotations and file / selection history.
- Optional AI commit messages, commit explanations, code reviews, conflict-resolution suggestions and commit composition; a configured model service or local Agent CLI is required.
