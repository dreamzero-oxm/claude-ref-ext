#!/usr/bin/env node
/*
 * Claude Ref —— Review hook（由扩展命令「安装代码 Review Hook」写入 .claude/ 下）。
 *
 * 单脚本按 stdin JSON 的 hook_event_name 分派两种职责：
 *
 *  - PreToolUse（matcher: Edit|Write|MultiEdit）：在 Claude 真正改动文件「之前」运行，
 *    此刻磁盘仍是原文。把该文件当前内容快照到 <REVIEW_DIR>/baseline/<hash>.snap，
 *    作为 review 时「红色（改动前）」的基准；并把该文件追加进 manifest.json 的清单。
 *    每一「轮」对话以 .active 标志区分：首个 PreToolUse 发现 .active 不存在时，
 *    视为新一轮，清空上一轮的 baseline/ 与 manifest，再重新开始抓取。
 *
 *  - Stop（每轮回复结束）：删除 .active（使下一轮首个 PreToolUse 重置基线），
 *    并向 ready 文件写入时间戳，触发扩展端 FileSystemWatcher 进入 review。
 *
 * 本脚本只读取被改文件的「原内容」并写入工作区内的 .claude/.claude-ref-review/，
 * 不读取对话内容、不联网、不外发任何数据。出错时静默退出（exit 0），绝不阻塞 Claude。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 与 extension.js 的 REVIEW_DIR_RELATIVE 保持一致。
const REVIEW_DIR_RELATIVE = '.claude/.claude-ref-review';

/** 读取 stdin 全部内容（hook 输入是一段 JSON）。 */
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

/** 文件相对路径 → 稳定的快照文件名（md5，避免路径分隔符/特殊字符问题）。 */
function snapName(relPath) {
  return crypto.createHash('md5').update(relPath).digest('hex') + '.snap';
}

function main() {
  const raw = readStdin();
  if (!raw) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    return;
  }

  // cwd 即工作区根（Claude Code 在工作区根启动）；review 数据目录挂其下。
  const cwd = input.cwd || process.cwd();
  const reviewDir = path.join(cwd, REVIEW_DIR_RELATIVE);
  const baselineDir = path.join(reviewDir, 'baseline');
  const manifestPath = path.join(reviewDir, 'manifest.json');
  const activePath = path.join(reviewDir, '.active');
  const readyPath = path.join(reviewDir, 'ready');

  const event = input.hook_event_name;

  if (event === 'Stop') {
    // 一轮结束：撤下 .active（下一轮首个 PreToolUse 据此重置基线），写 ready 触发扩展。
    try { fs.rmSync(activePath, { force: true }); } catch (e) { /* ignore */ }
    try {
      fs.mkdirSync(reviewDir, { recursive: true });
      fs.writeFileSync(readyPath, String(Date.now()));
    } catch (e) { /* ignore */ }
    return;
  }

  if (event !== 'PreToolUse') {
    return;
  }

  // —— PreToolUse：抓基线快照 ——
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath || typeof filePath !== 'string') {
    return;
  }

  try {
    fs.mkdirSync(baselineDir, { recursive: true });

    // 新一轮的首个编辑：.active 不存在 → 清空上一轮残留，重新开始。
    if (!fs.existsSync(activePath)) {
      try { fs.rmSync(baselineDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      fs.mkdirSync(baselineDir, { recursive: true });
      try { fs.rmSync(manifestPath, { force: true }); } catch (e) { /* ignore */ }
      fs.writeFileSync(activePath, String(Date.now()));
    }

    // 相对工作区根的路径，作为 manifest 的稳定标识与快照名来源。
    let relPath = path.relative(cwd, filePath);
    // 统一正斜杠，跨平台一致（与扩展端 toRefPath 同风格）。
    relPath = relPath.split(path.sep).join('/');

    // 读已有 manifest（首次/损坏时按空清单处理）。
    let manifest = { files: [] };
    try {
      const txt = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(txt);
      if (parsed && Array.isArray(parsed.files)) manifest = parsed;
    } catch (e) { /* 视为空清单 */ }

    // 已快照过的文件不重复抓取（同一轮内只记「改动前」的最初版本）。
    if (manifest.files.some((f) => f && f.path === relPath)) {
      return;
    }

    // 读原文件内容；不存在则是 Claude 新建文件，基线为空、标记 isNew。
    let baseline = '';
    let isNew = false;
    try {
      baseline = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      isNew = true;
    }

    const snap = snapName(relPath);
    fs.writeFileSync(path.join(baselineDir, snap), baseline);

    manifest.files.push({ path: relPath, baseline: snap, isNew: isNew });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    // 任何异常都静默吞掉——绝不能因 review 抓取失败而阻塞 Claude 的编辑。
  }
}

main();
