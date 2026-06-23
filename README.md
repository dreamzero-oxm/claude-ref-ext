# Claude Ref Sender

> 在 VSCode 编辑器中选中代码，按一个快捷键，就把形如 `@path/to/file.go#L10-20` 的引用直接「打字」进正在运行 **Claude Code CLI** 的终端。

无需安装官方的 *Claude Code for VSCode* 插件，尤其适合 **VSCode 远程开发 + 远程机器上跑 `claude` 命令行** 的工作流。

---

## 为什么需要它

Claude Code CLI 是一个跑在终端里的交互式程序，你可以用 `@文件#L起始-结束` 的语法把某段代码喂给它。但手动敲文件路径和行号又慢又容易错。

VSCode 原生其实做不到「选中代码 → 一键生成带行号范围的引用 → 发送到正在运行的终端」：

- `keybindings.json` 里的 `workbench.action.terminal.sendSequence` 只能发送**静态字符串**，无法替换文件名、行号等变量；
- `tasks.json` 虽支持变量，但它会**另开一个 shell**，无法注入到已经在跑 `claude` 的交互式终端；而且预定义变量里**没有选区的起止行**。

所以最干净的做法就是这样一个仅几十行的轻量扩展。

## 功能特性

- 选中代码后一键生成 `@相对路径#L起始-结束` 引用并发送到终端
- 支持单行选中（生成 `@file#L10`）与未选中时按光标行生成
- 支持**多光标 / 多选区**，自动拼接并去重
- 可配置相对 / 绝对路径
- 可配置发送后是否自动回车提交
- 可指定目标终端名称
- 提供快捷键与编辑器右键菜单两种触发方式

## 安装

### 方式一：打包成 vsix 安装（推荐）

```bash
cd claude-ref-ext
npx --yes @vscode/vsce package          # 生成 claude-ref-sender-0.1.0.vsix
code --install-extension claude-ref-sender-0.1.0.vsix
```

然后 `Ctrl/Cmd + Shift + P` → **Developer: Reload Window**。

> **远程开发提示**：远程终端里的 `code` 命令由 `vscode-server` 提供，`--install-extension` 会把扩展安装到**远程侧**，从而能访问远程文件与远程终端。

### 方式二：开发 / 调试模式

用 VSCode 单独打开本项目文件夹，按 `F5` 启动「扩展开发宿主」窗口，在新窗口里即可测试。

## 使用

1. 在终端里正常启动 `claude`；
2. 在编辑器中选中一段代码（保持焦点在编辑器内）；
3. 按快捷键，或右键选择 **Claude Ref: 发送选区引用到终端**；
4. 终端里会出现类似：

   ```
   @src/utils/example.go#L10-20 
   ```

5. 继续输入你的问题，回车发送给 Claude。

### 默认快捷键

| 平台          | 快捷键              |
| ------------- | ------------------- |
| macOS         | `Cmd + Option + K`  |
| Windows/Linux | `Ctrl + Alt + K`    |

> 如有冲突，可在 VSCode 的「键盘快捷方式」中为命令 `claudeRef.sendSelection` 重新绑定。

## 配置项

在 `settings.json` 中可配置：

| 配置项                   | 类型      | 默认值       | 说明                                                                 |
| ------------------------ | --------- | ------------ | -------------------------------------------------------------------- |
| `claudeRef.pathStyle`    | string    | `relative`   | 路径风格：`relative` 相对工作区根目录，`absolute` 绝对路径           |
| `claudeRef.submitOnSend` | boolean   | `false`      | 发送后是否自动回车提交。关闭时只打入引用，便于继续补充内容            |
| `claudeRef.terminalName` | string    | `""`         | 目标终端名称。留空用当前活动终端；填写后优先查找同名终端，找不到则新建 |

示例：

```json
{
  "claudeRef.pathStyle": "relative",
  "claudeRef.submitOnSend": false,
  "claudeRef.terminalName": "claude"
}
```

## 工作原理

扩展注册了命令 `claudeRef.sendSelection`，触发时：

1. 读取当前编辑器的所有选区；
2. 计算每个选区的起止行号与（相对/绝对）文件路径，拼成 `@path#Lstart-end`；
3. 通过 `terminal.sendText()` 把文本写入目标终端（默认不追加换行）。

核心实现见 [`extension.js`](./extension.js)。

## 目录结构

```
claude-ref-ext/
├── .vscode/
│   └── launch.json      # F5 调试配置
├── extension.js         # 扩展主逻辑
├── package.json         # 扩展清单（命令 / 快捷键 / 菜单 / 配置）
├── README.md
├── CHANGELOG.md
├── LICENSE
├── .gitignore
└── .vscodeignore
```

## 贡献

欢迎提 Issue 与 PR。本项目刻意保持精简，新增功能请尽量通过配置项实现，避免破坏开箱即用的体验。

## 许可证

[MIT](./LICENSE)
