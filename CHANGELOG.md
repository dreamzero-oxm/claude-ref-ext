# Changelog

本项目所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
