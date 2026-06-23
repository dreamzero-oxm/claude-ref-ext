const vscode = require('vscode');
const path = require('path');

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

  const payload = unique.join(' ') + ' ';

  // 优先按名称查找指定终端，否则使用当前活动终端，再否则新建一个
  let terminal;
  if (terminalName) {
    terminal = vscode.window.terminals.find((t) => t.name === terminalName);
  }
  terminal = terminal || vscode.window.activeTerminal;
  if (!terminal) {
    terminal = vscode.window.createTerminal(terminalName || 'claude');
  }

  terminal.show(true);
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

  context.subscriptions.push(sendSelection, sendFile);
}

function deactivate() {}

module.exports = { activate, deactivate };
