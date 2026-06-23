# Changelog

本项目所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
