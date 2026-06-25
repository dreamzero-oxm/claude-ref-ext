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
- **在左侧资源管理器中选中文件**，一键生成整文件引用 `@相对路径`（不含行号）发送到终端
- **选中代码后在选区上方显示「💬 将选中引用添加到终端」CodeLens 气泡**，单击即可发送
- **可把光标放在函数/类上一键生成其完整行范围引用** `@file#Lstart-end`，无需手动拖选（基于 DocumentSymbol API）
- **可把光标所在行的诊断（错误/警告等）连同引用一起发送**，支持诊断灯泡（快速修复）「💬 让 Claude 修复此问题」、右键菜单与命令面板
- **可一条命令把所有 Git 改动文件构造成 `@file` 引用发送**，并支持自定义 prompt 模板、用 `{{refs}}` 注入引用位置（「review 我这些改动」）
- **可在发送前 quick-pick 一个提示词模板**（如「解释」「重构」「写测试」）拼在引用前面，模板列表完全由 `claudeRef.promptTemplates` 自定义
- 可配置相对 / 绝对路径
- 可配置发送后是否自动回车提交
- 可配置发送后是否把焦点切换到终端
- 可指定目标终端名称
- **可配置「仅在 Claude Code 运行时发送」**，并自定义识别命令名（支持 `claude-other` 等）
- **检测到多个 Claude Code 会话时，发送前弹出选择让你挑目标终端**
- **状态栏指示当前 Claude Code 会话数**，让门禁状态一目了然，点击即可聚焦/选择会话
- **可在 Claude Code 每轮对话结束时弹出系统级桌面通知**（基于 Claude Code 的 Stop hook，提供一键安装命令；亦可切换为 IDE 内部提示）
- **可在 IDE 内逐块 Review Claude 的改动**：每轮改完后用内置 diff 呈现「改动前（红）/ 改动后（绿）」，逐块「接受（保留）/ 拒绝（回退原代码）」，配 `Alt+A/D/Z` 快捷键与底部 ↑/↓、「下一个文件」导航（基于一键安装的 Review Hook）
- 提供快捷键、编辑器右键菜单、资源管理器右键菜单、CodeLens 气泡多种触发方式

## 安装

### 方式一：打包成 vsix 安装（推荐）

```bash
cd claude-ref-ext
npx --yes @vscode/vsce package          # 生成 claude-ref-sender-1.5.0.vsix
code --install-extension claude-ref-sender-1.5.0.vsix
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

### 发送整个文件引用

在左侧资源管理器中选中一个（或多个）文件后：

- 按快捷键 `Ctrl/Cmd + Alt/Option + K`（保持焦点在资源管理器），或
- 右键选择 **Claude Ref: 发送文件引用到终端**

终端里会出现整文件引用（不含行号），例如：

```
@src/utils/example.go 
```

> 快捷键触发依赖内置的复制路径命令读取选中项，会短暂占用并随即还原系统剪贴板；右键菜单则直接读取选中项，更可靠。

### 选区 CodeLens 气泡

在编辑器中选中一段代码后，选区起始行**上方**会出现可单击的
**「💬 将选中引用添加到终端」**，单击即把选区引用发送到终端，无需记快捷键。

### 发送光标所在符号引用

不想手动拖选整个函数？把光标放进某个函数/类/方法体内，右键选择 **Claude Ref: 发送光标所在符号引用到终端**（或在命令面板执行同名命令）。它会用 DocumentSymbol API 取该符号的**完整行范围**，生成形如：

```
@src/utils/example.go#L10-42 
```

说明：

- 取的是**包含光标的最内层符号**——光标在类里某个方法上时，引用的是那个方法而非整个类。
- 光标不在任何符号内（或该语言没有符号提供者）时，自动退回为当前选区/光标行引用，并提示。
- 行号规则与选区引用一致（单行符号生成 `@file#L10`）。
- 默认未绑定快捷键；可自行为 `claudeRef.sendSymbol` 绑定。

### 发送诊断/报错

当某行有报错或警告时，把它连同引用一起丢给 Claude 修是最高频的场景。把光标放到出问题的那一行，通过任一方式触发：

- **诊断灯泡**：点行首的灯泡（快速修复），选择 **「💬 让 Claude 修复此问题」**；
- **右键菜单**：选择 **Claude Ref: 发送诊断/报错到终端**；
- **命令面板**：`Ctrl/Cmd + Shift + P` → **Claude Ref: 发送诊断/报错到终端**。

终端里会出现引用 + 该行的报错信息，例如：

```
@src/foo.ts#L42
[error] Cannot find name 'fooo'. (ts 2304)
```

随后补一句「帮我修一下」回车即可。说明：

- 只发送**光标/选区所在行**的诊断；选中多行则覆盖范围内的诊断都会带上（各条前标注所在行号）。
- 报错文本含严重级别（`error`/`warn`/`info`/`hint`）、消息以及来源与错误码（如 `ts2304`、`eslint no-undef`）。
- 多行内容通过终端「括号粘贴」一次性送入，内部换行不会被 claude 当成多次回车提交（`submitOnSend` 仍只在最后追加一次回车）。
- 默认未绑定快捷键；需要的话可在键盘快捷方式中为 `claudeRef.sendDiagnostics` 自行绑定（例如 `Ctrl/Cmd + Alt/Option + J`）。

### 发送 Git 变更引用

想让 Claude 一次性 review 你当前的所有改动？`Ctrl/Cmd + Shift + P` → **Claude Ref: 发送 Git 变更引用到终端**。它会通过 VSCode 内置 Git 扩展枚举所有仓库的改动文件，构造成多个 `@file` 引用一并发送。

默认只发送引用本身：

```
@src/foo.ts @src/bar.ts @README.md 
```

**自定义 prompt 模板**：在设置里写 `claudeRef.gitChangesPrompt`，用 `{{refs}}` 标记引用注入位置。例如：

```jsonc
"claudeRef.gitChangesPrompt": "请 review 以下改动，重点关注错误处理与边界条件：\n{{refs}}\n如有问题请直接给出修改建议。"
```

发送后终端里就会是完整的 prompt，`{{refs}}` 处替换为全部文件引用。说明：

- 模板里**没有** `{{refs}}` 时，文件引用会追加到模板末尾。
- 默认包含未跟踪的新文件；可用 `claudeRef.gitIncludeUntracked: false` 只发已跟踪文件的改动。**已删除的文件始终排除**（引用不存在的文件没有意义）。
- 多工作区/多仓库都会被纳入，去重后空格拼接，与「源代码管理」视图所见一致。
- 模板可含换行，通过终端「括号粘贴」一次性送入，内部换行不会被当成多次提交。

### 选模板发送（提示词前缀）

常用的提问方式（解释这段代码、帮我重构、写测试……）可以存成模板，发送时选一个、拼在引用前面，省得每次手敲。

**开箱即带**「解释」「重构」「写测试」「审查改动」四个默认模板，直接用即可；也可在设置 `claudeRef.promptTemplates` 里增删改，例如：

```jsonc
"claudeRef.promptTemplates": [
  { "label": "解释",   "prompt": "请解释以下代码的作用：" },
  { "label": "重构",   "prompt": "请重构以下代码，提升可读性，保持行为不变：" },
  { "label": "写测试", "prompt": "请为以下代码写单元测试：" },
  { "label": "审查",   "prompt": "请审查以下改动，重点看错误处理：\n{{refs}}\n并给出修改建议。" }
]
```

然后：

- 在编辑器中**选中代码**（或在资源管理器中**选中文件**）；
- 右键选择 **Claude Ref: 选模板发送引用到终端**，或在命令面板执行同名命令；
- 在弹出的列表里选一个模板，引用就会拼在该模板后面发送。

说明：

- 模板的 `prompt` 默认拼在引用**前面**；若 `prompt` 中含占位符 `{{refs}}`，引用则注入到该位置（与「发送 Git 变更引用」一致）。
- 把 `claudeRef.promptTemplates` 设为空数组 `[]` 即可关闭所有模板（届时会提示去设置里添加）。
- 模板可含换行，通过终端「括号粘贴」一次性送入，内部换行不会被当成多次提交。
- 默认未绑定快捷键；可自行为 `claudeRef.sendWithTemplate` 绑定。

### 多 Claude 会话与状态栏

如果你同时开了多个终端各跑一个 `claude`（例如一个跑测试、一个写代码），扩展会基于 VSCode 终端 Shell 集成自动追踪「哪些终端在跑 claude」，并提供两个便利：

- **多会话选择**：发送引用时若检测到**多个** claude 会话，会先弹出 quick-pick 让你挑目标终端，避免打错窗口。不想每次询问？把 `claudeRef.promptForTerminalWhenMultiple` 设为 `false`，扩展会自动选当前活动的 claude 终端（没有则取第一个）。已用 `claudeRef.terminalName` 固定了目标终端时不会询问。
- **状态栏指示**：状态栏右侧显示当前的 claude 会话数（如 `$(comment-discussion) Claude 2`）。它让 `requireClaudeRunning` 门禁状态一目了然——开启门禁且**无**会话时指示项变为**警告色**，提示此刻发送会被拦截。**点击**指示项即可聚焦对应终端（多个时弹选择），等同命令 **Claude Ref: 聚焦正在运行的 Claude Code 终端**。

> 两者都依赖 VSCode 终端 Shell 集成来检测 claude 是否在跑。环境不支持时，多会话选择自动跳过、状态栏显示为「未知」（`$(question) Claude`）。不需要状态栏可用 `claudeRef.showStatusBar: false` 关闭。

### 对话结束提示

希望 Claude Code 答完一轮就在 IDE 弹个提示？由于 VSCode 无法读取交互式终端内部的单轮结束信号，本功能借道 Claude Code 自身的 **Stop hook**：

1. `Ctrl/Cmd + Shift + P` → 执行 **Claude Ref: 安装对话结束提示 Hook**。它会把一条 Stop hook 幂等地写入工作区的 `.claude/settings.json`（已存在则不重复）；
2. 在 `settings.json` 中开启 `"claudeRef.notifyOnTurnEnd": true`；
3. 重新启动（或重载）正在运行的 `claude` 会话，使新 hook 生效。

此后 Claude 每答完一轮，就会弹出**系统级桌面通知**（默认；即便 IDE 窗口最小化或失焦也能看到）。文案可用 `claudeRef.turnEndMessage` 自定义；若想改回 IDE 右下角的内部提示，把 `claudeRef.notifyStyle` 设为 `"ide"`。

> 系统通知按平台调用系统自带工具实现，无第三方依赖：macOS 用 `osascript`、Linux 用 `notify-send`（libnotify）、Windows 用 PowerShell Toast。对应命令缺失或出错时会自动降级为 IDE 内提示。
>
> **远程开发例外**：在 Remote-SSH / Dev Container / WSL 下，扩展宿主跑在「远端」机器上，系统命令只会在远端执行，本地（如你的 Mac）看不到。因此远程环境会自动改用 **IDE 内提示**——这是唯一能送达本地窗口的通道。受 VSCode 架构限制，远程扩展无法在你的本地机器弹出真正的系统通知。

不想要了？执行 **Claude Ref: 移除对话结束提示 Hook** 即可从 `.claude/settings.json` 移除该 hook（按信号文件名识别，旧版本写入的命令变体也会一并清除）。

> 原理：Stop hook 在每轮回复结束时用 `node` 向 `.claude/.claude-ref-stop` 写入一个时间戳（跨平台一致，不依赖 `date`/`printf`），扩展用文件监听器捕获该变化后弹出提示。hook 命令不读取、不外发任何对话内容。

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
| `claudeRef.focusTerminalOnSend` | boolean | `false`  | 发送后是否把焦点切换到终端。开启后焦点直接落到终端；与是否自动回车相互独立，仅聚焦不会触发提交 |
| `claudeRef.terminalName` | string    | `""`         | 目标终端名称。留空用当前活动终端；填写后优先查找同名终端，找不到则新建 |
| `claudeRef.requireClaudeRunning` | boolean | `false` | 仅在目标终端正在运行 Claude Code 时才发送引用。开启后若目标终端没在跑 claude，则取消发送并提示，避免把 `@path` 误打进普通 shell。依赖 VSCode 终端 Shell 集成，不支持时降级为照常发送 |
| `claudeRef.claudeCommandPattern` | string | `claude` | 识别 Claude Code 的命令名（正则，不区分大小写）。命令不叫 claude（如 claude-other）时按需修改，例如 `claude\|claude-other`。仅在开启 `requireClaudeRunning` 时生效 |
| `claudeRef.promptForTerminalWhenMultiple` | boolean | `true` | 检测到多个正在运行 Claude Code 的终端时，发送前弹出选择目标终端。关闭则自动选当前活动的 claude 终端（没有则取第一个）。已用 `terminalName` 固定终端时不询问；依赖 Shell 集成 |
| `claudeRef.showStatusBar` | boolean | `true` | 在状态栏显示当前 Claude Code 会话数；点击可聚焦（多个时选择）对应终端。开启 `requireClaudeRunning` 且无会话时变为警告色。依赖 Shell 集成，不支持时显示「未知」 |
| `claudeRef.notifyOnTurnEnd` | boolean | `false` | 在 Claude Code 每轮对话结束时弹出提示。依赖 Stop hook，需先执行命令「Claude Ref: 安装对话结束提示 Hook」（详见下文） |
| `claudeRef.turnEndMessage` | string | `✅ Claude Code 本轮回复已完成` | 对话结束提示的文案。仅在开启 `notifyOnTurnEnd` 时生效 |
| `claudeRef.notifyStyle` | string | `system` | 对话结束提示的弹出方式：`system`＝系统级桌面通知（默认，IDE 失焦/最小化也能看到），`ide`＝IDE 内部右下角提示。仅在开启 `notifyOnTurnEnd` 时生效 |
| `claudeRef.gitChangesPrompt` | string | `""` | 「发送 Git 变更引用」的 prompt 模板。默认空＝只发引用本身；可写提示词并用 `{{refs}}` 标记文件引用注入位置（无 `{{refs}}` 时引用追加到末尾） |
| `claudeRef.gitIncludeUntracked` | boolean | `true` | 「发送 Git 变更引用」是否包含未跟踪的新文件。关闭则只发已跟踪文件的改动。已删除文件始终排除 |
| `claudeRef.promptTemplates` | array | 预置 4 个 | 提示词模板列表，供「选模板发送」选择，默认带「解释/重构/写测试/审查改动」。每项 `{ "label", "prompt", "detail?" }`；`prompt` 拼在引用前面，含 `{{refs}}` 时注入到该位置 |

示例：

```json
{
  "claudeRef.pathStyle": "relative",
  "claudeRef.submitOnSend": false,
  "claudeRef.focusTerminalOnSend": false,
  "claudeRef.terminalName": "claude",
  "claudeRef.requireClaudeRunning": false,
  "claudeRef.claudeCommandPattern": "claude",
  "claudeRef.promptForTerminalWhenMultiple": true,
  "claudeRef.showStatusBar": true,
  "claudeRef.notifyOnTurnEnd": false,
  "claudeRef.turnEndMessage": "✅ Claude Code 本轮回复已完成",
  "claudeRef.notifyStyle": "system",
  "claudeRef.gitChangesPrompt": "",
  "claudeRef.gitIncludeUntracked": true
  // claudeRef.promptTemplates 默认已预置「解释/重构/写测试/审查改动」，需要时再覆盖
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
