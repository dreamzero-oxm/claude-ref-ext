const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

// 记录「当前正在运行 Claude Code」的终端集合，由 shell 集成事件维护。
const claudeTerminals = new Set();
// 终端不支持 shell 集成、无法检测时只提示一次，避免反复打扰。
let degradeWarned = false;
// 状态栏指示项：显示当前有几个 claude 会话在跑，让 requireClaudeRunning 的门禁状态可见。
// 在 activate() 中创建，shell 集成事件触发时刷新。
let statusBarItem = null;

// Stop hook 写入的信号文件（相对工作区根目录）。Claude Code 每轮回复结束会触发
// Stop hook，由 hook 更新此文件；扩展通过 FileSystemWatcher 监听其变化来弹出
// 「本轮回复完成」提示。终端 API 无法感知交互式 claude 会话内部的单轮结束，
// 故借道 Claude Code 自身的 hook 机制桥接。
const STOP_SIGNAL_RELATIVE = '.claude/.claude-ref-stop';
// 去抖：文件的 create + change 可能连续触发，避免一轮结束弹两次。
let lastTurnEndNotify = 0;

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
 * 在 DocumentSymbol 树中递归查找「包含给定位置的最内层符号」。
 * vscode.executeDocumentSymbolProvider 可能返回两种形态：
 *   - DocumentSymbol[]：有 .range（符号完整范围，含函数体）与 .children（嵌套符号）；
 *   - SymbolInformation[]：扁平结构，范围在 .location.range，无 children。
 * 两者都以 .range / .location.range 暴露范围；本函数统一取范围判断包含关系，
 * 命中后继续深入 children 找更内层的符号（如类里的方法），返回最深的那个。
 * @param {Array<vscode.DocumentSymbol|vscode.SymbolInformation>} symbols
 * @param {vscode.Position} position
 * @returns {vscode.DocumentSymbol|vscode.SymbolInformation|null}
 */
function findInnermostSymbol(symbols, position) {
  if (!Array.isArray(symbols)) {
    return null;
  }
  let best = null;
  for (const sym of symbols) {
    const range = sym.range || (sym.location && sym.location.range);
    if (!range || !range.contains(position)) {
      continue;
    }
    // 命中：先认定当前符号，再尝试在其子符号里找更内层的命中
    best = sym;
    const deeper = findInnermostSymbol(sym.children || [], position);
    if (deeper) {
      best = deeper;
    }
  }
  return best;
}

/**
 * 取光标所在的最内层符号（函数/类/方法等），按其完整行范围构造 @file#Lstart-end 引用。
 * 调用 DocumentSymbol 提供者拿到符号树，找到包含光标的最深符号，用其 range 的起止行
 * （沿用 buildReference 的「行号 +1、单行省略区间」规则）生成引用。
 * 没有符号提供者或光标不在任何符号内时返回 null（调用方据此提示）。
 * @param {vscode.TextEditor} editor
 * @param {'relative'|'absolute'} pathStyle
 * @returns {Promise<string|null>}
 */
async function buildSymbolReference(editor, pathStyle) {
  const doc = editor.document;
  const symbols = await vscode.commands.executeCommand(
    'vscode.executeDocumentSymbolProvider',
    doc.uri
  );
  const symbol = findInnermostSymbol(symbols || [], editor.selection.active);
  if (!symbol) {
    return null;
  }
  const range = symbol.range || (symbol.location && symbol.location.range);
  if (!range) {
    return null;
  }

  const filePath = toRefPath(doc.uri, pathStyle);
  const startLine = range.start.line + 1; // VSCode 行号从 0 开始
  let endLine = range.end.line + 1;
  // 范围结尾停在某行行首时不计入该行，与 buildReference 保持一致
  if (range.end.character === 0 && endLine > startLine) {
    endLine -= 1;
  }
  if (startLine === endLine) {
    return `@${filePath}#L${startLine}`;
  }
  return `@${filePath}#L${startLine}-${endLine}`;
}

/**
 * 通过 VSCode 内置 Git 扩展（vscode.git）枚举所有仓库中「有改动」的文件 URI。
 * 用内置 API 而非自己 spawn git：多工作区/多仓库感知、与「源代码管理」视图所见一致、
 * 远程开发下也可用。包含：已暂存(indexChanges) + 未暂存的已跟踪改动(workingTreeChanges)；
 * 未跟踪的新文件(untrackedChanges，含 mergeChanges 里的项)按 includeUntracked 决定是否纳入。
 * 已删除的文件一律排除——引用一个不存在的文件没有意义。
 *
 * @param {boolean} includeUntracked 是否纳入未跟踪的新文件
 * @returns {{uris: vscode.Uri[], available: boolean}} available=false 表示 Git 扩展不可用
 */
function collectGitChangedUris(includeUntracked) {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext || !ext.isActive) {
    // 未激活时无法同步取 API；返回不可用，由调用方提示。
    return { uris: [], available: !!ext };
  }
  const api = ext.exports && ext.exports.getAPI && ext.exports.getAPI(1);
  if (!api) {
    return { uris: [], available: false };
  }

  // Git 状态码：6=DELETED，7=UNTRACKED，3=INDEX_DELETED（见 git 扩展 Status 枚举）。
  const DELETED = 6;
  const INDEX_DELETED = 3;

  const seen = new Set();
  const uris = [];
  const push = (uri) => {
    const key = uri.toString();
    if (!seen.has(key)) {
      seen.add(key);
      uris.push(uri);
    }
  };

  for (const repo of api.repositories) {
    const state = repo.state;
    // 已暂存 + 未暂存（已跟踪）改动；排除删除项
    for (const change of state.indexChanges || []) {
      if (change.status === INDEX_DELETED) continue;
      push(change.uri);
    }
    for (const change of state.workingTreeChanges || []) {
      if (change.status === DELETED) continue;
      push(change.uri);
    }
    if (includeUntracked) {
      // 新版 git 扩展把未跟踪文件单列在 untrackedChanges；老版本则混在 workingTreeChanges
      // 里以 status===UNTRACKED 体现，已被上面的循环纳入。两者都覆盖。
      for (const change of state.untrackedChanges || []) {
        if (change.status === DELETED) continue;
        push(change.uri);
      }
    }
  }

  return { uris, available: true };
}

/**
 * 把文件引用按模板注入：模板含占位符 {{refs}} 时替换之，否则把引用追加到模板末尾
 * （模板为空时即只发送引用本身）。引用之间空格拼接，复用与 sendRefs 一致的去重。
 * Git 变更引用与「选模板发送」两条路径共用。
 * @param {string} template 用户配置的 prompt 模板（可为空）
 * @param {string[]} refs 已构造的 @file 引用数组
 * @returns {string}
 */
function applyPromptTemplate(template, refs) {
  const joined = uniqueRefs(refs).join(' ');
  const tpl = (template || '').trim();
  if (!tpl) {
    // 无模板：行为等同普通引用发送，末尾补一个空格方便继续输入。
    return joined + ' ';
  }
  if (tpl.includes('{{refs}}')) {
    return tpl.split('{{refs}}').join(joined);
  }
  // 模板里没有占位符：把引用追加到末尾（中间留一个空格）。
  return tpl + ' ' + joined;
}

/**
 * 读取 claudeRef.promptTemplates 配置，规范化为 {label, prompt} 数组。
 * 容错：跳过缺 label 或 prompt 的项；prompt 缺失而仅有 label 时按空模板处理。
 * @returns {{label: string, prompt: string}[]}
 */
function getPromptTemplates() {
  const raw = vscode.workspace.getConfiguration('claudeRef').get('promptTemplates', []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((t) => t && typeof t === 'object' && typeof t.label === 'string' && t.label.trim())
    .map((t) => ({
      label: t.label,
      prompt: typeof t.prompt === 'string' ? t.prompt : '',
      detail: typeof t.detail === 'string' ? t.detail : undefined,
    }));
}

/**
 * 弹出 quick-pick 让用户从配置的模板里选一个，返回其 prompt 字符串。
 * 未配置任何模板时提示并返回 null；用户取消（Esc）也返回 null。
 * @returns {Promise<string|null>}
 */
async function pickPromptTemplate() {
  const templates = getPromptTemplates();
  if (templates.length === 0) {
    vscode.window.showInformationMessage(
      'Claude Ref: 尚未配置任何提示词模板，请在设置 claudeRef.promptTemplates 中添加。'
    );
    return null;
  }
  // 模板的 prompt 作为 quick-pick 的 detail 预览（截断过长内容），便于辨认
  const items = templates.map((t) => ({
    label: t.label,
    detail: t.detail || (t.prompt ? t.prompt.replace(/\s*\r?\n\s*/g, ' ').slice(0, 80) : '(空模板，仅发送引用)'),
    _prompt: t.prompt,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择一个提示词模板（将拼在引用前面）',
    matchOnDetail: true,
  });
  return picked ? picked._prompt : null;
}

/**
 * 把诊断（错误/警告等）的严重级别映射为简短标签。
 * @param {vscode.DiagnosticSeverity} severity
 * @returns {string}
 */
function severityLabel(severity) {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warn';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'diag';
  }
}

/**
 * 把诊断的 source 与 code 拼成形如 "(ts2304)" / "(eslint no-undef)" 的后缀。
 * code 兼容 string / number / {value} 三种形态；都缺失时返回空串。
 * @param {vscode.Diagnostic} diag
 * @returns {string}
 */
function diagnosticSourceCode(diag) {
  const source = diag.source || '';
  let code = diag.code;
  if (code && typeof code === 'object') {
    code = code.value;
  }
  const codeStr = code === undefined || code === null ? '' : String(code);
  const inner = [source, codeStr].filter(Boolean).join(' ');
  return inner ? ` (${inner})` : '';
}

/**
 * 收集光标/选区所在行范围内的诊断，构造成「引用 + 报错信息」多行 payload：
 *   第一行：@path#Lx-y 引用（复用与 buildReference 一致的行号规则）
 *   其后每行：[severity] message (source code)；目标跨多行时各诊断前标注 Lxx:
 * 该文件在目标行范围内没有任何诊断时返回 null（调用方据此提示）。
 * @param {vscode.TextEditor} editor
 * @param {'relative'|'absolute'} pathStyle
 * @returns {string|null}
 */
function buildDiagnosticPayload(editor, pathStyle) {
  const doc = editor.document;
  const sel = editor.selection;

  // 目标行范围：沿用 buildReference 的规则（行号 +1；结尾停在行首不计入该行）
  const startLine = sel.start.line + 1;
  let endLine = sel.end.line + 1;
  if (sel.end.character === 0 && endLine > startLine) {
    endLine -= 1;
  }

  // 取该文件全部诊断，过滤出与目标行范围相交的（VSCode range 行号从 0 开始）
  const all = vscode.languages.getDiagnostics(doc.uri) || [];
  const hits = all.filter((d) => {
    const ds = d.range.start.line + 1;
    const de = d.range.end.line + 1;
    return ds <= endLine && de >= startLine;
  });
  if (hits.length === 0) {
    return null;
  }

  const filePath = toRefPath(doc.uri, pathStyle);
  const ref = startLine === endLine ? `@${filePath}#L${startLine}` : `@${filePath}#L${startLine}-${endLine}`;

  // 目标跨多行时，逐条标注其所在行，便于 Claude 对应；单行则省略。
  const multiLine = startLine !== endLine;
  const lines = hits.map((d) => {
    const loc = multiLine ? `L${d.range.start.line + 1}: ` : '';
    // 诊断消息本身可能含换行，压平为单行以保持「一条诊断一行」
    const msg = String(d.message).replace(/\s*\r?\n\s*/g, ' ').trim();
    return `[${severityLabel(d.severity)}] ${loc}${msg}${diagnosticSourceCode(d)}`;
  });

  return ref + '\n' + lines.join('\n');
}

/**
 * 引用去重：保留首次出现的顺序，剔除重复项。引用与 Git 变更两条路径共用。
 * @param {string[]} refs
 * @returns {string[]}
 */
function uniqueRefs(refs) {
  return refs.filter((value, index, arr) => arr.indexOf(value) === index);
}

/**
 * 把若干引用去重后拼接成 payload，并发送到目标终端。
 * @param {string[]} refs
 * @returns {Promise<void>}
 */
function sendRefs(refs) {
  const unique = uniqueRefs(refs);
  if (unique.length === 0) {
    return Promise.resolve();
  }
  // 引用始终单行、空格拼接，末尾再补一个空格，行为与历史一致。
  return sendPayload(unique.join(' ') + ' ', { bracketedPaste: false });
}

/**
 * 返回当前仍打开着、且正在运行 Claude Code 的终端列表
 * （claudeTerminals 与现存终端取交集，剔除已关闭的悬挂项）。
 * @returns {vscode.Terminal[]}
 */
function openClaudeTerminals() {
  const open = new Set(vscode.window.terminals);
  return [...claudeTerminals].filter((t) => open.has(t));
}

/**
 * 当前 VSCode 是否支持终端 Shell 集成（据此才能检测哪些终端在跑 claude）。
 * @returns {boolean}
 */
function shellIntegrationAvailable() {
  return typeof vscode.window.onDidStartTerminalShellExecution === 'function';
}

/**
 * 在多个「正在运行 Claude Code」的终端之间弹 quick-pick 让用户选发送目标。
 * 用户取消（Esc）返回 null。
 * @param {vscode.Terminal[]} terminals
 * @returns {Promise<vscode.Terminal|null>}
 */
async function pickClaudeTerminal(terminals) {
  const active = vscode.window.activeTerminal;
  const items = terminals.map((t) => ({
    label: `$(terminal) ${t.name}`,
    description: t === active ? '当前活动终端' : '',
    _terminal: t,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '检测到多个正在运行 Claude Code 的终端，选择发送目标',
  });
  return picked ? picked._terminal : null;
}

/**
 * 解析本次发送的目标终端。优先级：
 *   1. 配置了 terminalName 且找到同名终端 → 用它；
 *   2. 有「正在跑 claude」的终端时以它们为候选——多个且开启 promptWhenMultiple 时
 *      弹 quick-pick 让用户选（取消则返回 null 表示中止）；多个但不弹则优先当前活动终端、
 *      否则取第一个；恰好一个则直接用它（即便它不是当前活动终端，也优先打到 claude 会话里）；
 *   3. 没有任何已知 claude 终端 → 沿用历史行为，用当前活动终端（可能为空，由调用方决定是否新建）。
 * @param {string} terminalName 配置的目标终端名（可为空）
 * @param {boolean} promptWhenMultiple 多个 claude 终端时是否弹选择
 * @returns {Promise<vscode.Terminal|null|undefined>} null=用户取消选择；undefined/Terminal 见上
 */
async function resolveTargetTerminal(terminalName, promptWhenMultiple) {
  if (terminalName) {
    const named = vscode.window.terminals.find((t) => t.name === terminalName);
    if (named) {
      return named;
    }
  }

  const claudeOpen = openClaudeTerminals();
  if (claudeOpen.length > 1) {
    if (promptWhenMultiple) {
      // 用户取消时返回 null，sendPayload 据此中止发送（不擅自挑一个）
      return await pickClaudeTerminal(claudeOpen);
    }
    const active = vscode.window.activeTerminal;
    return active && claudeTerminals.has(active) ? active : claudeOpen[0];
  }
  if (claudeOpen.length === 1) {
    return claudeOpen[0];
  }
  return vscode.window.activeTerminal || undefined;
}

/**
 * 把一段 payload 发送到目标终端：解析目标终端、执行 requireClaudeRunning 门禁、
 * 按配置决定焦点与是否回车提交。引用与诊断两条路径共用此函数。
 *
 * 交互式 claude 会话中「换行＝提交」，因此含内部换行的多行 payload 必须用
 * 括号粘贴（bracketed paste）序列包裹：终端会把 ESC[200~ … ESC[201~ 之间的内容
 * 当作一次「粘贴」，其中的换行不会逐行触发提交。submitOnSend 仍只在最末尾追加回车。
 * @param {string} payload 已构造好的待发送文本（不含末尾提交换行）
 * @param {{bracketedPaste?: boolean}} [opts]
 */
async function sendPayload(payload, opts) {
  const bracketedPaste = !!(opts && opts.bracketedPaste);
  const cfg = vscode.workspace.getConfiguration('claudeRef');
  const submitOnSend = cfg.get('submitOnSend', false);
  const terminalName = cfg.get('terminalName', '');
  const focusTerminalOnSend = cfg.get('focusTerminalOnSend', false);
  const requireClaudeRunning = cfg.get('requireClaudeRunning', false);
  const promptForTerminalWhenMultiple = cfg.get('promptForTerminalWhenMultiple', true);

  // 解析目标终端：按名称 / 多 claude 会话选择 / 当前活动终端（见 resolveTargetTerminal）。
  // 返回 null 表示用户在「多会话选择」里取消了，直接中止本次发送。
  let terminal = await resolveTargetTerminal(terminalName, promptForTerminalWhenMultiple);
  if (terminal === null) {
    return;
  }

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
    if (!shellIntegrationAvailable()) {
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

  // 含内部换行的多行 payload 用括号粘贴序列包裹，避免每个换行被当成一次提交。
  // 末尾提交换行（submitOnSend）放在包裹之外，确保整体作为一次输入再回车。
  if (bracketedPaste && payload.includes('\n')) {
    terminal.sendText('\x1b[200~' + payload + '\x1b[201~', false);
    if (submitOnSend) {
      terminal.sendText('', true);
    }
  } else {
    // 第二个参数为是否追加换行：true 表示发送后直接回车提交
    terminal.sendText(payload, submitOnSend);
  }
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

/**
 * 在有诊断（错误/警告等）的行提供一个快速修复「💬 让 Claude 修复此问题」，
 * 点击后执行 claudeRef.sendDiagnostics，把该行诊断连同 @path#L 引用发到终端。
 *
 * provideCodeActions 的 context.diagnostics 仅含触发处相交的诊断；为空时不提供。
 * 命令本身不带参数，运行时按「当前活动编辑器 + 当前选区」重新取诊断，与右键菜单、
 * 命令面板复用同一套逻辑（buildDiagnosticPayload）。
 * @implements {vscode.CodeActionProvider}
 */
class DiagnosticRefActionProvider {
  provideCodeActions(document, range, context) {
    if (!context || !context.diagnostics || context.diagnostics.length === 0) {
      return [];
    }
    const action = new vscode.CodeAction(
      '💬 让 Claude 修复此问题',
      vscode.CodeActionKind.QuickFix
    );
    action.command = {
      title: '让 Claude 修复此问题',
      command: 'claudeRef.sendDiagnostics',
    };
    return [action];
  }
}
DiagnosticRefActionProvider.providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

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

  // 编辑器中：把光标/选区所在行的诊断（错误、警告等）连同 @path#L 引用发送
  const sendDiagnostics = vscode.commands.registerCommand('claudeRef.sendDiagnostics', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Claude Ref: 没有激活的编辑器');
      return;
    }
    const pathStyle = vscode.workspace.getConfiguration('claudeRef').get('pathStyle', 'relative');
    const payload = buildDiagnosticPayload(editor, pathStyle);
    if (!payload) {
      vscode.window.showInformationMessage('Claude Ref: 光标所在行没有可发送的诊断（错误/警告）。');
      return;
    }
    // 多行 payload 需括号粘贴，避免内部换行被 claude 当成多次提交
    sendPayload(payload, { bracketedPaste: true });
  });

  // 编辑器中：把光标所在的函数/类等符号的完整行范围构造成 @path#Lstart-end 引用，
  // 省去手动拖选。用 DocumentSymbol API 取符号范围，找不到符号时退回普通选区引用。
  const sendSymbol = vscode.commands.registerCommand('claudeRef.sendSymbol', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Claude Ref: 没有激活的编辑器');
      return;
    }
    const pathStyle = vscode.workspace.getConfiguration('claudeRef').get('pathStyle', 'relative');
    const ref = await buildSymbolReference(editor, pathStyle);
    if (!ref) {
      // 光标不在任何符号内（或语言无符号提供者）：退回当前选区/光标行引用
      vscode.window.showInformationMessage(
        'Claude Ref: 光标处未识别到函数/类等符号，已退回为当前选区引用。'
      );
      sendRefs([buildReference(editor, editor.selection, pathStyle)]);
      return;
    }
    sendRefs([ref]);
  });

  // 一条命令把所有 Git 改动文件构造成 @file 引用，按可配置的 prompt 模板注入后发送
  const sendGitChanges = vscode.commands.registerCommand('claudeRef.sendGitChanges', async () => {
    const cfg = vscode.workspace.getConfiguration('claudeRef');
    const pathStyle = cfg.get('pathStyle', 'relative');
    const includeUntracked = cfg.get('gitIncludeUntracked', true);
    const template = cfg.get('gitChangesPrompt', '');

    // Git 扩展可能尚未激活，先尝试激活再取其 API。
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt && !gitExt.isActive) {
      try {
        await gitExt.activate();
      } catch (e) {
        // 激活失败按不可用处理，下面统一提示
      }
    }

    const { uris, available } = collectGitChangedUris(includeUntracked);
    if (!available) {
      vscode.window.showWarningMessage(
        'Claude Ref: 无法访问 VSCode 内置 Git 扩展，请确认当前为 Git 仓库且 Git 扩展已启用。'
      );
      return;
    }
    if (uris.length === 0) {
      vscode.window.showInformationMessage('Claude Ref: 未检测到 Git 改动文件。');
      return;
    }

    const refs = uris.map((u) => buildFileReference(u, pathStyle));
    const payload = applyPromptTemplate(template, refs);
    // 模板可能含换行（用户自定义的多行 prompt），用括号粘贴避免被逐行提交
    sendPayload(payload, { bracketedPaste: true });
  });

  // 选模板发送：先用当前上下文（编辑器选区 / 资源管理器选中文件）构造引用，
  // 再 quick-pick 一个模板拼在引用前面发送。选区与文件两个入口共用此命令。
  const sendWithTemplate = vscode.commands.registerCommand(
    'claudeRef.sendWithTemplate',
    async (clickedUri, selectedUris) => {
      const pathStyle = vscode.workspace.getConfiguration('claudeRef').get('pathStyle', 'relative');

      // 优先取资源管理器右键传入的文件 URI；否则回退到编辑器选区。
      let refs = [];
      if (Array.isArray(selectedUris) && selectedUris.length > 0) {
        refs = selectedUris.map((u) => buildFileReference(u, pathStyle));
      } else if (clickedUri && clickedUri.fsPath) {
        refs = [buildFileReference(clickedUri, pathStyle)];
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Claude Ref: 没有激活的编辑器或选中的文件');
          return;
        }
        refs = editor.selections.map((sel) => buildReference(editor, sel, pathStyle));
      }

      refs = uniqueRefs(refs);
      if (refs.length === 0) {
        return;
      }

      // quick-pick 选模板（用户取消或未配置则中止）
      const template = await pickPromptTemplate();
      if (template === null) {
        return;
      }

      const payload = applyPromptTemplate(template, refs);
      // 模板可能含换行，用括号粘贴避免被逐行提交
      sendPayload(payload, { bracketedPaste: true });
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

  // 诊断灯泡：在有诊断的行提供「💬 让 Claude 修复此问题」快速修复，指向 sendDiagnostics
  const diagActionRegistration = vscode.languages.registerCodeActionsProvider(
    { scheme: '*' },
    new DiagnosticRefActionProvider(),
    { providedCodeActionKinds: DiagnosticRefActionProvider.providedCodeActionKinds }
  );

  // 通过 shell 集成事件追踪每个终端是否正在运行 Claude Code：
  // 命令开始执行且命令行匹配（默认 claude，可配置）时标记该终端，结束时清除。
  // 供「仅在 Claude Code 运行时发送」(requireClaudeRunning) 的门禁判断使用。
  context.subscriptions.push(...registerShellExecutionTracking());

  // 状态栏指示：显示当前有几个 claude 会话在跑，让门禁状态可见、并作为多会话选择入口。
  context.subscriptions.push(...registerStatusBar());

  // 状态栏点击 / 命令面板：聚焦（多个时先选择）正在运行 Claude Code 的终端。
  const focusClaude = vscode.commands.registerCommand(
    'claudeRef.focusClaudeTerminal',
    focusClaudeTerminal
  );

  // 监听 Stop hook 信号文件，在 Claude Code 每轮回复结束时弹提示（按配置开关）。
  context.subscriptions.push(...registerTurnEndNotifier());

  // 一键把 Stop hook 写入 .claude/settings.json，省去手动配置。
  const installHook = vscode.commands.registerCommand(
    'claudeRef.installStopHook',
    installStopHook
  );

  // 移除本扩展写入的 Stop hook。
  const uninstallHook = vscode.commands.registerCommand(
    'claudeRef.uninstallStopHook',
    uninstallStopHook
  );

  context.subscriptions.push(sendSelection, sendFile, sendDiagnostics, sendSymbol, sendGitChanges, sendWithTemplate, lensRegistration, selectionWatcher, diagActionRegistration, installHook, uninstallHook, focusClaude);
}

/**
 * 创建状态栏指示项并首次刷新。仅在配置 claudeRef.showStatusBar 开启时创建。
 * 点击指示项执行 claudeRef.focusClaudeTerminal（聚焦/选择 claude 终端）。
 * @returns {vscode.Disposable[]} 需要 dispose 的资源（含状态栏项与配置变更监听）
 */
function registerStatusBar() {
  const disposables = [];

  const create = () => {
    if (statusBarItem) {
      return;
    }
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claudeRef.focusClaudeTerminal';
    disposables.push(statusBarItem);
    updateStatusBar();
  };
  const destroy = () => {
    if (statusBarItem) {
      statusBarItem.dispose();
      statusBarItem = null;
    }
  };

  if (vscode.workspace.getConfiguration('claudeRef').get('showStatusBar', true)) {
    create();
  }

  // 配置变更时按需创建/销毁或刷新（showStatusBar、requireClaudeRunning 都影响显示）
  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeRef')) {
        return;
      }
      if (vscode.workspace.getConfiguration('claudeRef').get('showStatusBar', true)) {
        create();
        updateStatusBar();
      } else {
        destroy();
      }
    })
  );

  return disposables;
}

/**
 * 按当前 claude 会话数刷新状态栏文案、提示与配色。
 *   - 无会话：暗色图标；开启 requireClaudeRunning 时标为警告色（发送会被拦截）。
 *   - 有会话：显示数量；多个时提示「点击选择目标终端」。
 *   - shell 集成不可用：显示「未知」状态，说明无法检测。
 * 没有创建状态栏项（showStatusBar 关闭）时直接返回。
 */
function updateStatusBar() {
  if (!statusBarItem) {
    return;
  }
  const requireClaudeRunning = vscode.workspace
    .getConfiguration('claudeRef')
    .get('requireClaudeRunning', false);

  if (!shellIntegrationAvailable()) {
    statusBarItem.text = '$(question) Claude';
    statusBarItem.tooltip =
      '无法检测 Claude Code 会话（当前 VSCode 不支持终端 Shell 集成）';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const count = openClaudeTerminals().length;
  if (count === 0) {
    statusBarItem.text = '$(circle-slash) Claude';
    statusBarItem.tooltip = requireClaudeRunning
      ? '未检测到 Claude Code 会话；已开启「仅在 Claude Code 运行时发送」，发送将被拦截'
      : '未检测到 Claude Code 会话';
    // 门禁开启且无会话时用警告色，让「发送会被拦截」一目了然
    statusBarItem.backgroundColor = requireClaudeRunning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  } else {
    statusBarItem.text = `$(comment-discussion) Claude ${count}`;
    statusBarItem.tooltip =
      count > 1
        ? `检测到 ${count} 个 Claude Code 会话，点击选择发送目标终端`
        : '检测到 1 个 Claude Code 会话，点击聚焦';
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

/**
 * 状态栏点击 / 命令面板触发：聚焦正在运行 Claude Code 的终端。
 * 多个时弹 quick-pick 选一个，恰好一个则直接聚焦，没有则提示。
 */
async function focusClaudeTerminal() {
  if (!shellIntegrationAvailable()) {
    vscode.window.showInformationMessage(
      'Claude Ref: 当前 VSCode 不支持终端 Shell 集成，无法检测 Claude Code 会话。'
    );
    return;
  }
  const claudeOpen = openClaudeTerminals();
  if (claudeOpen.length === 0) {
    vscode.window.showInformationMessage('Claude Ref: 未检测到正在运行 Claude Code 的终端。');
    return;
  }
  let terminal = claudeOpen[0];
  if (claudeOpen.length > 1) {
    const picked = await pickClaudeTerminal(claudeOpen);
    if (!picked) {
      return;
    }
    terminal = picked;
  }
  terminal.show(false); // 抢占焦点，把光标落到终端
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
          updateStatusBar();
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
          updateStatusBar();
        }
      })
    );
  }

  // 终端关闭时清理，避免悬挂引用
  disposables.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      claudeTerminals.delete(terminal);
      updateStatusBar();
    })
  );

  return disposables;
}

/**
 * 监听 Stop hook 写入的信号文件，在 Claude Code 每轮回复结束时弹出提示。
 * 信号文件位于每个工作区根的 .claude/.claude-ref-stop；Stop hook 触发时更新它，
 * FileSystemWatcher 捕获 create/change 事件后弹通知（系统级或 IDE 内，按 notifyStyle 配置）。
 *
 * 仅在配置项 claudeRef.notifyOnTurnEnd 开启时生效。返回需要 dispose 的资源。
 * @returns {vscode.Disposable[]}
 */
function registerTurnEndNotifier() {
  const onTurnEnd = () => {
    if (!vscode.workspace.getConfiguration('claudeRef').get('notifyOnTurnEnd', false)) {
      return;
    }
    // 去抖：同一轮的 create+change 在很短时间内连续到达时只提示一次
    // （注意：扩展宿主环境无 Date.now 限制，这里可正常使用）
    const now = Date.now();
    if (now - lastTurnEndNotify < 800) {
      return;
    }
    lastTurnEndNotify = now;
    const message = vscode.workspace
      .getConfiguration('claudeRef')
      .get('turnEndMessage', '✅ Claude Code 本轮回复已完成');
    const style = vscode.workspace
      .getConfiguration('claudeRef')
      .get('notifyStyle', 'system');
    if (style === 'ide') {
      vscode.window.showInformationMessage(message);
    } else {
      notifyOS(message);
    }
  };

  // 为信号文件创建 watcher（glob 覆盖所有工作区根）。文件可能尚不存在，
  // create 与 change 都要监听。
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${STOP_SIGNAL_RELATIVE}`);
  watcher.onDidCreate(onTurnEnd);
  watcher.onDidChange(onTurnEnd);

  return [watcher];
}

/**
 * 弹出「系统级」桌面通知（独立于 IDE 窗口，最小化或失焦时也能看到）。
 * 无第三方依赖，按平台调用系统自带工具：
 *   - macOS：osascript 的 `display notification`
 *   - Linux：notify-send（来自 libnotify，多数桌面环境自带）
 *   - Windows：PowerShell 弹 Toast 通知
 * 任一平台的命令缺失/出错时静默降级为 IDE 内提示，绝不阻塞或抛出。
 *
 * 远程开发（Remote-SSH / Dev Container / WSL）下扩展宿主跑在「远端」机器上：
 * 此时 osascript/notify-send 只会在远端执行，本地（如你的 Mac）根本看不到，
 * 且命令往往「成功退出」而不报错，导致连降级都不触发、最终什么都不弹。
 * 因此远程环境直接走 IDE 提示——这是唯一能送达本地窗口的通道。
 * @param {string} message 通知正文
 */
function notifyOS(message) {
  const title = 'Claude Code';
  const fallback = () => vscode.window.showInformationMessage(message);
  // 远程场景：系统命令只会在远端机器执行，本地看不到，直接降级为 IDE 提示。
  if (vscode.env.remoteName) {
    fallback();
    return;
  }
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${asAppleScriptString(message)} with title ${asAppleScriptString(title)}`;
      cp.execFile('osascript', ['-e', script], (err) => {
        if (err) fallback();
      });
    } else if (process.platform === 'win32') {
      // 借 Windows.UI.Notifications 弹原生 Toast；失败则降级。
      const ps = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
        '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
        `$texts = $t.GetElementsByTagName('text');`,
        `$texts.Item(0).AppendChild($t.CreateTextNode(${asPowerShellString(title)})) | Out-Null;`,
        `$texts.Item(1).AppendChild($t.CreateTextNode(${asPowerShellString(message)})) | Out-Null;`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show([Windows.UI.Notifications.ToastNotification]::new($t));`,
      ].join(' ');
      cp.execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        (err) => {
          if (err) fallback();
        }
      );
    } else {
      // Linux 及其他类 Unix：notify-send。无图形会话（无 DISPLAY/WAYLAND）时
      // notify-send 可能「成功退出」却不显示，故先确认存在图形会话再调用。
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        fallback();
        return;
      }
      cp.execFile('notify-send', [title, message], (err) => {
        if (err) fallback();
      });
    }
  } catch (e) {
    fallback();
  }
}

/**
 * 把字符串转义为 AppleScript 字面量（含首尾双引号）。
 * @param {string} s
 * @returns {string}
 */
function asAppleScriptString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * 把字符串转义为 PowerShell 单引号字面量（含首尾单引号）。
 * @param {string} s
 * @returns {string}
 */
function asPowerShellString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 判断一个 Stop hook 条目是否由本扩展写入：按信号文件名 .claude-ref-stop 识别，
 * 以便同时匹配新（node）与旧（printf）等各种命令变体，install/uninstall 共用。
 * @param {any} entry .claude/settings.json 中 hooks.Stop 的一个元素
 * @returns {boolean}
 */
function isOurStopHookEntry(entry) {
  return !!(
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) => h && typeof h.command === 'string' && h.command.includes('.claude-ref-stop')
    )
  );
}

/**
 * 把 Stop hook 幂等地合并写入工作区的 .claude/settings.json。
 * hook 命令仅向信号文件追加一个时间戳以触发文件变化（不读取、不外发任何内容）。
 * 已存在等价 hook 时不重复添加。
 */
async function installStopHook() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Claude Ref: 没有打开的工作区，无法安装 Stop hook。');
    return;
  }
  // 多工作区时让用户选一个根目录
  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: '选择要安装 Stop hook 的工作区',
    });
    if (!picked) {
      return;
    }
    folder = picked;
  }

  const claudeDir = vscode.Uri.joinPath(folder.uri, '.claude');
  const settingsUri = vscode.Uri.joinPath(claudeDir, 'settings.json');

  // hook 命令：向信号文件写入当前时间戳，触发 FileSystemWatcher 的 change 事件。
  // 用 node -e 实现跨平台一致（Windows/macOS/Linux 行为相同）——运行 claude 的
  // 环境必然装有 node，故不依赖 date/printf 或 shell 重定向。命令简单、覆盖写、
  // 不读取也不外发任何对话内容。
  const hookCommand =
    "node -e \"require('fs').writeFileSync('.claude/.claude-ref-stop', String(Date.now()))\"";

  // 读取已有 settings.json（可能不存在或为空）
  let settings = {};
  try {
    const raw = await vscode.workspace.fs.readFile(settingsUri);
    const text = Buffer.from(raw).toString('utf8').trim();
    if (text) {
      settings = JSON.parse(text);
    }
  } catch (e) {
    // 文件不存在等情况，按空配置处理
    settings = {};
  }

  // 合并 hooks.Stop 数组（Claude Code hooks 结构）。已存在等价命令则不重复添加。
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = [];
  }
  const already = settings.hooks.Stop.some(isOurStopHookEntry);
  if (already) {
    vscode.window.showInformationMessage('Claude Ref: Stop hook 已安装，无需重复。');
    return;
  }
  settings.hooks.Stop.push({
    hooks: [{ type: 'command', command: hookCommand }],
  });

  // 确保 .claude 目录存在并写回（2 空格缩进，保持与常见 JSON 风格一致）
  try {
    await vscode.workspace.fs.createDirectory(claudeDir);
    const out = Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf8');
    await vscode.workspace.fs.writeFile(settingsUri, out);
    vscode.window.showInformationMessage(
      'Claude Ref: 已写入 Stop hook 到 .claude/settings.json。请重启或重新加载正在运行的 claude 会话后生效。'
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Ref: 写入 Stop hook 失败：${e.message}`);
  }
}

/**
 * 从工作区的 .claude/settings.json 移除本扩展写入的 Stop hook（含旧的 printf 变体）。
 * 移除后若 hooks.Stop / hooks 变空则一并清掉，保持配置整洁；不动其他配置。
 */
async function uninstallStopHook() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('Claude Ref: 没有打开的工作区，无法移除 Stop hook。');
    return;
  }
  // 多工作区时让用户选一个根目录
  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: '选择要移除 Stop hook 的工作区',
    });
    if (!picked) {
      return;
    }
    folder = picked;
  }

  const settingsUri = vscode.Uri.joinPath(folder.uri, '.claude', 'settings.json');

  // 读取已有 settings.json
  let settings = {};
  try {
    const raw = await vscode.workspace.fs.readFile(settingsUri);
    const text = Buffer.from(raw).toString('utf8').trim();
    if (text) {
      settings = JSON.parse(text);
    }
  } catch (e) {
    vscode.window.showInformationMessage('Claude Ref: 未找到 .claude/settings.json，无需移除。');
    return;
  }

  const stop = settings.hooks && settings.hooks.Stop;
  if (!Array.isArray(stop) || stop.length === 0) {
    vscode.window.showInformationMessage('Claude Ref: 未发现已安装的 Stop hook。');
    return;
  }

  const kept = stop.filter((entry) => !isOurStopHookEntry(entry));
  if (kept.length === stop.length) {
    vscode.window.showInformationMessage('Claude Ref: 未发现本扩展写入的 Stop hook。');
    return;
  }

  // 写回过滤后的数组；若变空则连同空的 Stop / hooks 一并清理
  if (kept.length > 0) {
    settings.hooks.Stop = kept;
  } else {
    delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  try {
    const out = Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf8');
    await vscode.workspace.fs.writeFile(settingsUri, out);
    vscode.window.showInformationMessage(
      'Claude Ref: 已从 .claude/settings.json 移除 Stop hook。请重启或重新加载正在运行的 claude 会话后生效。'
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Ref: 移除 Stop hook 失败：${e.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
