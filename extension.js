const vscode = require('vscode');
const path = require('path');

/**
 * 根据单个选区构造形如 @relative/path/to/file.go#L10-20 的引用。
 * @param {vscode.TextEditor} editor
 * @param {vscode.Selection} selection
 * @param {'relative'|'absolute'} pathStyle
 * @returns {string}
 */
function buildReference(editor, selection, pathStyle) {
  const doc = editor.document;

  let filePath = doc.uri.fsPath;
  if (pathStyle !== 'absolute') {
    const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (wsFolder) {
      filePath = path.relative(wsFolder.uri.fsPath, filePath);
    }
  }
  // 统一使用正斜杠，跨平台保持一致
  filePath = filePath.split(path.sep).join('/');

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

function activate(context) {
  const disposable = vscode.commands.registerCommand('claudeRef.sendSelection', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Claude Ref: 没有激活的编辑器');
      return;
    }

    const cfg = vscode.workspace.getConfiguration('claudeRef');
    const pathStyle = cfg.get('pathStyle', 'relative');
    const submitOnSend = cfg.get('submitOnSend', false);
    const terminalName = cfg.get('terminalName', '');

    // 支持多重选区（多光标），多个引用之间用空格分隔并去重
    const refs = editor.selections
      .map((sel) => buildReference(editor, sel, pathStyle))
      .filter((value, index, arr) => arr.indexOf(value) === index);

    const payload = refs.join(' ') + ' ';

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
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
