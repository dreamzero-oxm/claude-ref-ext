# Changelog

本项目所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
