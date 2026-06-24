const vscode = require('vscode');
const path = require('path');

// 记录「当前正在运行 Claude Code」的终端集合，由 shell 集成事件维护。
const claudeTerminals = new Set();
// 终端不支持 shell 集成、无法检测时只提示一次，避免反复打扰。
let degradeWarned = false;

/**
 * 判断给定命令行是否在启动 Claude Code（按配置的正则匹配，默认匹配 "claude"）。
 * 用户的命令可能不叫 claude（如 claude-other），故通过配置项自定义。
 * @param {string} commandLine
 * @returns {boolean}
 */
function matchesClaudeCommand(commandLine) {
  const pattern = vscode.workspace
    .getConfiguration('claudeRef')
    .get('claudeCommandPattern', 'claude');
  if (!pattern || !commandLine) {
    return false;
  }
  try {
    return new RegExp(pattern, 'i').test(commandLine);
  } catch (e) {
    // 配置的不是合法正则时，退化为不区分大小写的子串匹配
    return commandLine.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * 把一个文件 URI 转成引用里使用的路径（统一正斜杠，按配置决定相对 / 绝对）。
 * @param {vscode.Uri} uri
 * @param {'relative'|'absolute'} pathStyle
 * @returns {string}
 */
function toRefPath(uri, pathStyle) {
  let filePath = uri.fsPath;
  if (pathStyle !== 'absolute') {
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (wsFolder) {
      filePath = path.relative(wsFolder.uri.fsPath, filePath);
    }
  }
  // 统一使用正斜杠，跨平台保持一致
  return filePath.split(path.sep).join('/');
}

/**
 * 根据单个选区构造形如 @relative/path/to/file.go#L10-20 的引用。
 * @param {vscode.TextEditor} editor
 * @param {vscode.Selection} selection
 * @param {'relative'|'absolute'} pathStyle
 * @returns {string}
 */
function buildReference(editor, selection, pathStyle) {
  const doc = editor.document;
  const filePath = toRefPath(doc.uri, pathStyle);

  const startLine = selection.start.line + 1; // VSCode 行号从 0 开始
  let endLine = selection.end.line + 1;

  // 选区结尾停在某行行首（未真正选中该行任何字符）时，不把那一行算进去
  if (selection.end.character === 0 && endLine > startLine) {
    endLine -= 1;
  }

  if (selection.isEmpty || startLine === endLine) {
    return `@${filePath}#L${startLine}`;
  }
  return `@${filePath}#L${startLine}-${endLine}`;
}

/**
 * 根据文件 URI 构造形如 @relative/path/to/file.go 的整文件引用（不含行号）。
 * @param {vscode.Uri} uri
 * @param {'relative'|'absolute'} pathStyle
 * @returns {string}
 */
function buildFileReference(uri, pathStyle) {
  return `@${toRefPath(uri, pathStyle)}`;
}

/**
 * 把若干引用去重后拼接成 payload，并发送到目标终端。
 * @param {string[]} refs
 */
function sendRefs(refs) {
  const unique = refs.filter((value, index, arr) => arr.indexOf(value) === index);
  if (unique.length === 0) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('claudeRef');
  const submitOnSend = cfg.get('submitOnSend', false);
  const terminalName = cfg.get('terminalName', '');
  const focusTerminalOnSend = cfg.get('focusTerminalOnSend', false);
  const requireClaudeRunning = cfg.get('requireClaudeRunning', false);

  const payload = unique.join(' ') + ' ';

  // 优先按名称查找指定终端，否则使用当前活动终端，再否则新建一个
  let terminal;
  if (terminalName) {
    terminal = vscode.window.terminals.find((t) => t.name === terminalName);
  }
  terminal = terminal || vscode.window.activeTerminal;

  // 开启「仅在 Claude Code 运行时发送」时，发送前确认目标终端确实在跑 claude，
  // 避免把 @path 引用漏打进一个普通 shell（在那里没有意义）。
  if (requireClaudeRunning) {
    // 没有任何现成终端就意味着 claude 肯定没在跑，直接拦截
    if (!terminal) {
      vscode.window.showWarningMessage(
        'Claude Ref: 未检测到正在运行 Claude Code 的终端，已取消发送。'
      );
      return;
    }
    // shell 集成不可用时无法可靠判断，降级为照常发送，仅首次提示
    if (typeof vscode.window.onDidStartTerminalShellExecution !== 'function') {
      if (!degradeWarned) {
        degradeWarned = true;
        vscode.window.showInformationMessage(
          'Claude Ref: 当前 VSCode 不支持终端 Shell 集成，无法检测 Claude Code 是否运行，已照常发送。'
        );
      }
    } else if (!claudeTerminals.has(terminal)) {
      vscode.window.showWarningMessage(
        'Claude Ref: 目标终端未在运行 Claude Code，已取消发送。'
      );
      return;
    }
  }

  if (!terminal) {
    terminal = vscode.window.createTerminal(terminalName || 'claude');
  }

  // show 的参数为 preserveFocus：true 表示保留当前焦点（停留在编辑器），
  // false 则把焦点切到终端。按配置决定发送后是否抢占焦点。
  terminal.show(!focusTerminalOnSend);
  // 第二个参数为是否追加换行：true 表示发送后直接回车提交
  terminal.sendText(payload, submitOnSend);
}

/**
 * 通过快捷键在资源管理器中触发时，命令拿不到 URI 参数，
 * 这里借助内置命令把选中文件路径复制到剪贴板再读回来（事后还原剪贴板）。
 * @param {'relative'|'absolute'} pathStyle
 * @returns {Promise<string[]>}
 */
async function refsFromClipboard(pathStyle) {
  const original = await vscode.env.clipboard.readText();
  const copyCmd = pathStyle === 'absolute' ? 'copyFilePath' : 'copyRelativeFilePath';
  try {
    await vscode.commands.executeCommand(copyCmd);
    const text = await vscode.env.clipboard.readText();
    // 没有任何选中项时内置命令不会改动剪贴板
    if (!text || text === original) {
      return [];
    }
    // 多选时为换行分隔的多行路径
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((p) => `@${p.split(path.sep).join('/')}`);
  } finally {
    await vscode.env.clipboard.writeText(original);
  }
}

/**
 * 在有非空选区时，于选区起始行上方渲染一个可单击的 CodeLens：
 * 「💬 将选中引用添加到终端」，点击后执行 claudeRef.sendSelection 命令。
 *
 * CodeLens 默认只在文档变化时刷新，而选区变化不算文档变化，
 * 因此需要在选区变化时主动 fire onDidChangeCodeLenses 触发重算。
 * @implements {vscode.CodeLensProvider}
 */
class SendSelectionLensProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire();
  }

  provideCodeLenses(document) {
    const editor = vscode.window.activeTextEditor;
    // 仅为当前活动编辑器、且其选区非空时提供
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
      return [];
    }
    const sel = editor.selection;
    if (sel.isEmpty) {
      return [];
    }
    // 把 lens 挂在选区起始行（CodeLens 会渲染在该行上方）
    const line = document.lineAt(sel.start.line);
    return [
      new vscode.CodeLens(line.range, {
        title: '💬 将选中引用添加到终端',
        command: 'claudeRef.sendSelection',
      }),
    ];
  }
}

function activate(context) {
  // 编辑器中：选中代码 → @path#Lstart-end
  const sendSelection = vscode.commands.registerCommand('claudeRef.sendSelection', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Claude Ref: 没有激活的编辑器');
      return;
    }

    const pathStyle = vscode.workspace.getConfiguration('claudeRef').get('pathStyle', 'relative');

    // 支持多重选区（多光标），多个引用之间用空格分隔并去重
    const refs = editor.selections.map((sel) => buildReference(editor, sel, pathStyle));
    sendRefs(refs);
  });

  // 资源管理器中：选中文件 → @path（整文件引用，不含行号）
  const sendFile = vscode.commands.registerCommand(
    'claudeRef.sendFile',
    async (clickedUri, selectedUris) => {
      const pathStyle = vscode.workspace.getConfiguration('claudeRef').get('pathStyle', 'relative');

      // 从右键菜单触发时，VSCode 会传入 (当前项 URI, 选中项 URI 数组)
      let uris = [];
      if (Array.isArray(selectedUris) && selectedUris.length > 0) {
        uris = selectedUris;
      } else if (clickedUri && clickedUri.fsPath) {
        uris = [clickedUri];
      }

      if (uris.length > 0) {
        sendRefs(uris.map((u) => buildFileReference(u, pathStyle)));
        return;
      }

      // 从快捷键触发时拿不到参数，退回剪贴板方案
      const refs = await refsFromClipboard(pathStyle);
      if (refs.length === 0) {
        vscode.window.showWarningMessage('Claude Ref: 资源管理器中没有选中的文件');
        return;
      }
      sendRefs(refs);
    }
  );

  // 选中代码后在选区上方显示「将选中引用添加到终端」的 CodeLens
  const lensProvider = new SendSelectionLensProvider();
  const lensRegistration = vscode.languages.registerCodeLensProvider(
    { scheme: '*' },
    lensProvider
  );
  // 选区变化时主动刷新 CodeLens（选区变化不触发文档变化）
  const selectionWatcher = vscode.window.onDidChangeTextEditorSelection(() => {
    lensProvider.refresh();
  });

  // 通过 shell 集成事件追踪每个终端是否正在运行 Claude Code：
  // 命令开始执行且命令行匹配（默认 claude，可配置）时标记该终端，结束时清除。
  // 供「仅在 Claude Code 运行时发送」(requireClaudeRunning) 的门禁判断使用。
  context.subscriptions.push(...registerShellExecutionTracking());

  context.subscriptions.push(sendSelection, sendFile, lensRegistration, selectionWatcher);
}

/**
 * 注册 shell 集成事件监听，维护 claudeTerminals 集合。
 * 旧版本 VSCode 没有这些 API 时返回空数组（功能自动降级）。
 * @returns {vscode.Disposable[]}
 */
function registerShellExecutionTracking() {
  const disposables = [];

  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    disposables.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        const commandLine = e.execution && e.execution.commandLine && e.execution.commandLine.value;
        if (matchesClaudeCommand(commandLine || '')) {
          claudeTerminals.add(e.terminal);
        }
      })
    );
  }

  if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
    disposables.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const commandLine = e.execution && e.execution.commandLine && e.execution.commandLine.value;
        // claude 进程退出（其启动命令执行结束）时，取消该终端的标记
        if (matchesClaudeCommand(commandLine || '')) {
          claudeTerminals.delete(e.terminal);
        }
      })
    );
  }

  // 终端关闭时清理，避免悬挂引用
  disposables.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      claudeTerminals.delete(terminal);
    })
  );

  return disposables;
}

function deactivate() {}

module.exports = { activate, deactivate };
