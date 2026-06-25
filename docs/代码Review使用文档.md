# IDE 内代码 Review 使用文档

> 让 Claude Code 改完代码后，在 VSCode 里像 code review 一样**逐块**查看「改动前（红）/ 改动后（绿）」，
> 一个个决定**接受**（保留 Claude 的改动）还是**拒绝**（回退为原代码）。

适用版本：Claude Ref Sender **≥ 1.6.0**。

---

## 一、它解决什么问题

Claude Code 在终端里直接改文件，改完你往往只能整体接受或用 `git diff` 自己翻。
这个功能把每一处改动拆成独立的「块」，在 IDE 内：

- **红色**那一侧 = Claude 改动**之前**的原代码；
- **绿色**那一侧 = Claude 改动**之后**的代码；
- 你逐块点「接受 / 拒绝」，拒绝的块会被**自动回退**为原代码，接受的块保留。

「红色基准」取自 Claude **真正动手改之前**的文件快照（由一个 hook 在编辑前抓取），
所以它只反映 Claude 本轮的改动，不会混入你自己未提交的修改。

---

## 二、一次性安装（约 1 分钟）

### 1. 安装扩展

```bash
code --install-extension claude-ref-sender-1.6.0.vsix
```

### 2. 安装 Review Hook

命令面板（`Ctrl/Cmd+Shift+P`）运行：

> **Claude Ref: 安装代码 Review Hook**

它会做两件事：

- 把 `review-hook.js` 复制到当前工作区的 `.claude/` 下；
- 把两个 hook 幂等写入 `.claude/settings.json`：
  - `PreToolUse`（匹配 `Edit|Write|MultiEdit`）—— 编辑前抓「红色基准」快照；
  - `Stop` —— 每轮回复结束后发出「可以 review 了」的信号。

> 多工作区时会让你选择装到哪个根目录。

### 3. 重启正在运行的 claude 会话 ⚠️

hook 是 Claude Code **启动时**加载的。如果你已经有一个 `claude` 会话在跑，
**必须退出并重新运行 `claude`**，新装的 hook 才会生效。

### 4. （可选）开启「每轮结束自动进入 review」

在 VSCode 设置里打开：

```
claudeRef.reviewOnTurnEnd = true
```

不开启也可以——那就用命令「Claude Ref: 开始 Review 本轮改动」手动进入。

---

## 三、日常使用流程

1. 正常让 Claude Code 改代码。
2. 本轮回复结束后：
   - 若开了 `reviewOnTurnEnd` → **自动**弹出第一个被改文件的 diff 视图；
   - 否则 → 运行命令 **「Claude Ref: 开始 Review 本轮改动」**。
3. 屏幕上是一个 diff 编辑器：**左红（改动前）/ 右绿（改动后）**。
   所有操作按钮都在**底部状态栏**（VSCode 不支持在 diff 视图内的代码块上方放按钮，故统一收到状态栏）：

   | 状态栏按钮 | 含义 |
   |------|------|
   | `✓ 接受` | 保留 Claude 改后的代码（默认效果） |
   | `✗ 拒绝` | 把当前块**回退为原代码**（红色那版） |
   | `撤销`   | 已接受/已拒绝后反悔，回到未处理状态 |

   这些按钮作用于**「当前块」**——即你最近用 ↑/↓ 跳到、或光标所在的那个改动块。
   状态栏进度项会显示当前是第几个块、它的状态，方便确认作用对象。

4. 用**底部状态栏**导航：

   | 状态栏项 | 作用 |
   |----------|------|
   | `← 上一个文件` | 回到上一个文件的首个改动块 |
   | `↑` / `↓` | 跳到上一个 / 下一个改动块 |
   | `文件 2/5 · 块 1/3(待处理) · 待处理 2` | 当前文件序号、当前块序号与状态、本文件还剩几块没处理 |
   | `下一个文件 →` | **仅当当前文件所有块都处理完后才出现**，点它进入下一个待 review 文件 |

5. 当前文件所有块都确认完 → 点「下一个文件 →」继续；
   最后一个文件处理完，按钮变成「完成 Review」，点击结束，提示 `代码 Review 完成 ✅`。

---

## 四、快捷键

进入 review 后（焦点在编辑器中时）：

| 快捷键 | 作用 |
|--------|------|
| `Alt + A` | 接受光标所在块（**A**ccept） |
| `Alt + D` | 拒绝光标所在块（**D**eny） |
| `Alt + Z` | 撤销光标所在块的决策 |
| `Alt + ↓` | 跳到下一个改动块 |
| `Alt + ↑` | 跳到上一个改动块 |

> 这些键只在 review 进行中生效，不影响平时的编辑器操作。
> 用快捷键时，作用对象是**光标当前所在的那个块**；用 CodeLens 按钮时则是按钮对应的那个块。

---

## 五、配置项

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `claudeRef.reviewOnTurnEnd` | `false` | 每轮回复结束后自动对本轮改动文件进入 review |
| `claudeRef.reviewAutoSave` | `false` | 每次「接受/拒绝/撤销」后是否立刻保存文件。关闭时文件保持未保存（dirty）状态，方便你用编辑器自带的撤销（`Ctrl/Cmd+Z`）反悔；review 结束时会统一保存 |

---

## 六、工作原理（简要）

```
Claude 要改 foo.js
      │
      ▼
PreToolUse hook ──► 编辑前把 foo.js 原文快照到
                    .claude/.claude-ref-review/baseline/<hash>.snap
                    并登记到 manifest.json
      │
      ▼
Claude 完成本轮回复
      │
      ▼
Stop hook ──► 写 .claude/.claude-ref-review/ready（信号文件）
      │
      ▼
扩展监听到 ready ──► 读 manifest + 各文件基线，逐文件算出改动块，
                    打开 diff（左=基线快照 / 右=当前文件）进入 review
      │
      ▼
你点 接受/拒绝 ──► 扩展按各块状态「重建」整个文件内容并写回磁盘
                  （拒绝的块用原代码，其余用 Claude 改后代码）
```

- **每一轮都是全新的基线**：下一轮 Claude 的首次编辑会自动清空上一轮的快照与清单。
- **重建而非打补丁**：文件内容由各块状态纯函数重建，因此无论你以什么顺序接受/拒绝，行号都不会错乱。

---

## 七、卸载

命令面板运行：

> **Claude Ref: 移除代码 Review Hook**

它会从 `.claude/settings.json` 移除本扩展写入的 `PreToolUse` / `Stop` hook，
并删除 `.claude/claude-ref-review-hook.js`（不动你的其他配置）。同样需要**重启 claude 会话**后生效。

`.claude/.claude-ref-review/` 这个数据目录可以手动删除；建议把它加进 `.gitignore`。

---

## 八、常见问题

**Q：改完代码没有自动进入 review？**
- 确认已开启 `claudeRef.reviewOnTurnEnd`；
- 确认安装 hook 后**重启过 claude 会话**（最常见原因）；
- 本轮如果 Claude 没有用 Edit/Write/MultiEdit 改文件（例如只跑了命令），则没有可 review 的内容；
- 也可以直接用命令「Claude Ref: 开始 Review 本轮改动」手动触发。

**Q：左侧红色显示的内容不对 / 包含了我自己的改动？**
- 基线是「Claude 本轮首次改该文件之前」的磁盘内容。如果你在 Claude 改之前自己也改了同一文件但没保存/没让 Claude 感知，红色会以磁盘上的版本为准。

**Q：拒绝了一个块又想恢复？**
- 点该块的「撤销」或按 `Alt+Z`，回到未处理（默认保留 Claude 改动）状态。

**Q：review 期间 Claude 又开始改代码了？**
- 当前 review 不会被打断；新一轮的基线会在 Claude 下次首个编辑时重置。建议先处理完当前 review。

**Q：能 review 文件的删除/重命名吗？**
- 目前只覆盖 `Edit/Write/MultiEdit` 的内容改动；纯删除/重命名不在范围内。新建文件会作为「整文件新增」呈现（基线为空）。
