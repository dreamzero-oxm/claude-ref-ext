# Changelog

本项目所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.7.0] - 2026-06-25

### 变更（Review 呈现方式重做）

- **从 diff 双栏改为单栏 + 自定义红/绿高亮**：每个待处理改动块在同一编辑器内同时呈现「原代码（红，在上）+ 改后代码（绿，在下）」，块上方有「接受 / 拒绝」CodeLens 按钮（普通编辑器内可靠渲染，不再受 diff 编辑器不显示 CodeLens 的限制）。
  - **接受** → 只保留绿（改后），该块高亮消除；**拒绝** → 只保留红（原代码），高亮消除；**撤销** → 恢复红+绿并重新出现按钮。
  - 解决了旧 diff 方案「接受后为消除颜色而把左侧也改成改后代码」违背 review 直觉的问题。
- **缓冲安全**：含未决策块的文件在全部块处理完成前不写盘（缓冲里临时含红行），完成后才落盘为只含最终代码的干净内容。
- 逐块状态持久化与「完成后删除记录」「完成后自动收尾保存」沿用 1.6.4/1.6.5 行为。

## [1.6.5] - 2026-06-25

### 改进

- **完成 Review 后自动关闭对应的 diff 窗口**：点击「完成 Review」（或处理完最后一个文件）后，本轮 review 打开的所有 diff 标签页会自动关闭，无需手动逐个关。

## [1.6.4] - 2026-06-25

### 修复 / 改进

- **决策后红/绿背景消失**：diff 左侧改为按逐块状态动态重建——接受时左侧用「改后」、拒绝时左侧用「原代码」，与右侧一致，从而该块不再显示红/绿；撤销则恢复。
- **逐块按钮同时挂到 diff 两侧**：CodeLens（接受/拒绝/撤销）同时注册到右侧真实文件与左侧基线虚拟文档，哪一侧能渲染就显示在哪一侧（状态栏按钮仍作兜底）。
- **审查记录持久化与清理**：每次接受/拒绝/撤销都把逐块状态写入 `.claude/.claude-ref-review/state.json`，重开 review 会从上次进度继续；点击「完成 Review」后**删除整个 review 记录目录**，下次「开始 Review 本轮改动」不会再打开已审完的界面。

## [1.6.3] - 2026-06-25

### 修复

- **修复改完代码后不自动弹出 review 界面**：`ready` 信号文件位于隐藏目录 `.claude/` 下，旧的裸字符串 glob watcher（`**/.claude/.../ready`）对隐藏目录的监听时灵时不灵。改为按每个工作区根用 `RelativePattern` 建 watcher（并保留一个全局 glob 作兜底），确保信号可靠送达。
- 配合 1.6.2 的容错 hook：此前 Stop hook 因脚本缺失报错而中断、根本没写出 `ready`，也会表现为「不弹 review」。两者叠加修复后恢复正常。

> 仍未弹出时，可手动执行命令「Claude Ref: 开始 Review 本轮改动」立即进入。

## [1.6.2] - 2026-06-25

### 修复

- **Review Hook 在脚本缺失时不再报错阻断**：旧命令是裸的 `node .claude/claude-ref-review-hook.js`，当某个项目的 `.claude/settings.json` 带有 hook 条目但缺少脚本文件（如复制/克隆来的项目）时，会抛 `MODULE_NOT_FOUND` 报错。现改为带存在性判断的容错命令——脚本不存在则静默 no-op，绝不阻断 claude。
- **重复安装改为「升级」**：再次执行「安装代码 Review Hook」会先剔除本扩展写入的旧条目再写入新条目，使旧命令能升级为新的容错版本（无需手动删 settings）。

> 已经遇到该报错的项目：在该项目里重新执行一次「Claude Ref: 安装代码 Review Hook」（会自动升级命令并补回脚本），或执行「移除代码 Review Hook」彻底清除，然后重启 claude 会话即可。

## [1.6.1] - 2026-06-25

### 修复 / 改进

- **逐块「接受/拒绝/撤销」按钮改到状态栏**：VSCode 不会在 diff 编辑器内渲染 CodeLens，导致改动块上方看不到按钮。现把「✓ 接受 / ✗ 拒绝 / 撤销」连同导航统一放到底部状态栏，确保可见可点。
- **决策作用对象改为「当前块」**：不再依赖光标行反查（光标落在 diff 左侧红色基线栏时会落空，导致接受后撤销无效、`待处理` 计数失真、误显示「下一个文件」）。现以导航/光标跟踪的「当前块」为准，并在状态栏进度里显示 `块 x/n(状态)`。
- **新增「上一个文件」按钮 / 命令 `claudeRef.prevFile`**，与「下一个文件」对称。
- 接受或拒绝一个块后自动跳到下一个待处理块，连续 review 更顺手。

## [1.6.0] - 2026-06-25

### 新增

- **IDE 内代码 Review（逐块接受/拒绝 Claude 改动）**：Claude Code 改完代码后，在 IDE 中以内置 diff 编辑器呈现「左=改动前原代码（红）/ 右=改动后（绿）」，可逐块 review 并决定保留或回退。
  - 命令 `claudeRef.installReviewHooks` / `claudeRef.uninstallReviewHooks`（「Claude Ref: 安装/移除代码 Review Hook」）：一键把 `PreToolUse`（`Edit|Write|MultiEdit`）与 `Stop` 两个 hook 幂等写入 `.claude/settings.json`，并复制 `review-hook.js` 到工作区 `.claude/`。`PreToolUse` 在每次编辑前把文件原文快照为「红色基准」，`Stop` 在每轮结束写 `ready` 信号触发 review。
  - 配置项 `claudeRef.reviewOnTurnEnd`（默认 `false`）：开启后每轮回复结束自动对本轮改动文件进入 review。
  - 逐块「✓ 接受 / ✗ 拒绝 / 撤销」CodeLens 按钮：**接受**保留 Claude 改后代码，**拒绝**把该块回退为原代码（基于各块状态全量重建文件内容，规避行号漂移）。
  - 快捷键：`Alt+A` 接受、`Alt+D` 拒绝、`Alt+Z` 撤销（均作用于光标所在块）；`Alt+Down` / `Alt+Up` 跳到下一个/上一个改动块。
  - 底部状态栏导航：↑/↓ 跳改动块、进度指示，以及「下一个文件」按钮——仅当当前文件所有改动块都已确认（无待处理块）时才出现，点击跳到下一个待 review 文件的首个改动块；全部完成则结束 review。
  - 配置项 `claudeRef.reviewAutoSave`（默认 `false`）：每次决策后是否自动保存；关闭时保持未保存（dirty）便于撤销，review 结束时统一保存。
  - 命令 `claudeRef.startReview`（「Claude Ref: 开始 Review 本轮改动」）：手动进入 review。

## [1.5.0] - 2026-06-25

### 新增

- 命令 `claudeRef.sendDiagnostics`（「Claude Ref: 发送诊断/报错到终端」）：把光标/选区所在行的诊断（错误、警告等）连同 `@path#L` 引用发送到终端。报错文本含严重级别、消息及来源与错误码（如 `ts2304`、`eslint no-undef`）；选中多行时覆盖范围内的诊断都会带上并标注各自行号。配套诊断灯泡（快速修复）「💬 让 Claude 修复此问题」，亦提供编辑器右键菜单项
- 命令 `claudeRef.sendSymbol`（「Claude Ref: 发送光标所在符号引用到终端」）：把光标所在的函数/类/方法等符号的**完整行范围**构造成 `@path#Lstart-end` 引用发送，省去手动拖选。通过 `vscode.executeDocumentSymbolProvider` 取符号树，递归找到包含光标的最内层符号；光标不在任何符号内（或语言无符号提供者）时自动退回为当前选区/光标行引用
- 命令 `claudeRef.sendGitChanges`（「Claude Ref: 发送 Git 变更引用到终端」）：通过 VSCode 内置 Git 扩展枚举所有仓库的改动文件，构造成多个 `@file` 引用一并发送。配套配置项 `claudeRef.gitChangesPrompt`（prompt 模板，用占位符 `{{refs}}` 标记文件引用注入位置）与 `claudeRef.gitIncludeUntracked`（默认 `true`，是否包含未跟踪的新文件；已删除文件始终排除）
- 命令 `claudeRef.sendWithTemplate`（「Claude Ref: 选模板发送引用到终端」）：发送前 quick-pick 一个提示词模板拼在引用前面，编辑器选区与资源管理器选中文件两个入口共用。配套配置项 `claudeRef.promptTemplates`，默认预置「解释」「重构」「写测试」「审查改动」四个，可自行增删改
- 多 Claude 会话选择：检测到多个正在运行 Claude Code 的终端时，发送前弹出 quick-pick 让你挑目标终端。可用配置项 `claudeRef.promptForTerminalWhenMultiple`（默认 `true`）开关；关闭则自动选当前活动的 claude 终端（没有则取第一个）。已通过 `claudeRef.terminalName` 指定固定终端时不询问
- 状态栏指示：在状态栏显示当前检测到的 Claude Code 会话数量，让 `requireClaudeRunning` 的门禁状态可见。无会话且开启门禁时变为警告色；点击可聚焦对应终端，多个时弹选择。可用 `claudeRef.showStatusBar`（默认 `true`）关闭。配套命令 `claudeRef.focusClaudeTerminal`（「Claude Ref: 聚焦正在运行的 Claude Code 终端」）
- 配置项 `claudeRef.notifyStyle`：对话结束提示的弹出方式，`system`（默认）为系统级桌面通知，`ide` 为 IDE 内部右下角提示
- 多行内容（诊断、prompt 模板等）通过终端「括号粘贴」序列一次性送入正在运行的 claude 会话，内部换行不会被当成多次回车提交

### 变更

- 对话结束提示默认改为**系统级桌面通知**（IDE 失焦或最小化时也能看到）。按平台调用系统自带工具实现，无第三方依赖：macOS 用 `osascript`、Linux 用 `notify-send`、Windows 用 PowerShell Toast；命令缺失或出错时自动降级为 IDE 内提示。如需保留旧行为，将 `claudeRef.notifyStyle` 设为 `"ide"`

### 修复

- 远程开发（Remote-SSH / Dev Container / WSL）下对话结束「什么都不弹」的问题：此前系统通知命令在远端机器执行、本地看不到，且常「成功退出」而不报错导致连降级都不触发。现检测到远程环境时自动改用 IDE 内提示（受 VSCode 架构限制，远程扩展无法在本地机器弹真正的系统通知）
- Linux 无图形会话（无 `DISPLAY`/`WAYLAND_DISPLAY`）时不再尝试 `notify-send`，直接降级为 IDE 内提示

## [1.4.0] - 2026-06-24

### 新增

- 命令 `claudeRef.uninstallStopHook`（「Claude Ref: 移除对话结束提示 Hook」）：从 `.claude/settings.json` 移除本扩展写入的 Stop hook，按信号文件名 `.claude-ref-stop` 识别，可一并清除旧的 `printf` 命令变体；移除后若 `hooks.Stop`/`hooks` 变空则一并清理，不影响其他配置

### 变更

- 安装 Stop hook 的重复检测改为按信号文件名识别，因此已存在旧的 `printf` 变体时也会被视为已安装，不再与 `node` 变体并存

## [1.3.0] - 2026-06-24

### 新增

- 对话结束提示：在 Claude Code 每轮回复结束时于 IDE 弹出提示。由于 VSCode 无法读取交互式终端内部的单轮结束信号，改为借道 Claude Code 自身的 **Stop hook**——hook 触发时用 `node` 跨平台地向工作区内的信号文件 `.claude/.claude-ref-stop` 写入时间戳，扩展通过 `FileSystemWatcher` 监听其变化并弹出 `showInformationMessage`
- 命令 `claudeRef.installStopHook`（「Claude Ref: 安装对话结束提示 Hook」）：一键把 Stop hook 幂等地合并写入 `.claude/settings.json`，无需手动配置；已存在等价 hook 时不重复添加
- 配置项 `claudeRef.notifyOnTurnEnd`（默认关闭）：是否启用对话结束提示
- 配置项 `claudeRef.turnEndMessage`：自定义对话结束提示文案（默认「✅ Claude Code 本轮回复已完成」）

## [1.2.0] - 2026-06-24

### 新增

- 配置项 `claudeRef.requireClaudeRunning`：仅在目标终端正在运行 Claude Code 时才发送引用（默认关闭）。开启后若检测到目标终端没有在跑 claude，则取消发送并提示，避免把 `@path` 引用误打进普通 shell。基于 VSCode 终端 Shell 集成的命令执行事件追踪实现；旧版本不支持该 API 时自动降级为照常发送（仅首次提示）
- 配置项 `claudeRef.claudeCommandPattern`：用于识别 Claude Code 的命令名（正则，不区分大小写，默认 `claude`）。命令不叫 claude（如 claude-other）时可自定义，例如填写 `claude|claude-other` 同时匹配两者；仅在开启 `claudeRef.requireClaudeRunning` 时生效

## [1.1.0] - 2026-06-24

### 新增

- 配置项 `claudeRef.focusTerminalOnSend`：发送引用后是否把焦点切换到终端（默认关闭）。开启后点击 CodeLens 气泡或使用快捷键发送引用时，焦点会直接落到终端；与是否自动回车（`claudeRef.submitOnSend`）相互独立，仅聚焦不会触发提交

## [1.0.0] - 2026-06-23

### 新增

- 首个正式公开发布
- 资源管理器文件引用：选中文件后通过快捷键或右键菜单（命令 `claudeRef.sendFile`）生成整文件引用 `@path`（不含行号）发送到终端；支持多选；快捷键路径经由内置复制路径命令读取选中项并还原剪贴板
- 选区 CodeLens 气泡：选中代码后在选区上方显示可单击的「💬 将选中引用添加到终端」
- `activationEvents` 设为 `onStartupFinished`，确保 CodeLens provider 提前注册
- 扩展图标

## [0.1.0] - 2026-06-23

### 新增

- 多光标 / 多选区支持，多个引用自动拼接并去重
- 配置项 `claudeRef.pathStyle`：相对 / 绝对路径
- 配置项 `claudeRef.submitOnSend`：发送后是否自动回车
- 配置项 `claudeRef.terminalName`：指定目标终端名称
- 编辑器右键菜单入口
- 完整的中文 README、LICENSE、打包与调试配置

## [0.0.1]

### 新增

- 首个版本：选中代码后一键生成 `@path#Lstart-end` 引用并发送到活动终端
