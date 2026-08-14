#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_BASE = 'https://easymax.ai/v1';
const IMAGE_MODEL = 'gpt-image-2';
const MAX_PAGES = 20;
const DOWNLOAD_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const GATEWAY_TIMEOUT_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const SKILL_VERSION = '1.0.10';

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      if (args[key] === undefined) args[key] = next;
      else args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
      i += 1;
    }
  }
  return { command, args };
}

function values(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function safeName(input) {
  const value = String(input || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '');
  if (!value || value === '.' || value === '..') fail('项目名不能为空或只包含无效字符');
  return value.slice(0, 80);
}

function desktopDir() {
  const home = os.homedir();
  if (process.env.EASYPPT_ROOT) return path.resolve(process.env.EASYPPT_ROOT);
  if (process.platform === 'linux') {
    const configured = process.env.XDG_DESKTOP_DIR;
    if (configured) return path.resolve(configured.replace(/^\$HOME/, home));
    try {
      const text = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
      const match = text.match(/^XDG_DESKTOP_DIR="([^"]+)"/m);
      if (match) return path.resolve(match[1].replace(/^\$HOME/, home));
    } catch {}
  }
  const candidates = process.platform === 'win32'
    ? [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, '桌面')]
    : [path.join(home, 'Desktop')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function projectRoot(projectArg) {
  if (!projectArg) fail('缺少 --project');
  return path.resolve(String(projectArg));
}

function previewMarkdown(label, file) {
  const alt = String(label || 'PPT 页面').replace(/[\[\]\\\r\n]/g, ' ').trim() || 'PPT 页面';
  const target = path.resolve(file).replace(/\\/g, '/');
  return `![${alt}](<${target}>)`;
}

function fileMarkdown(label, file) {
  const text = String(label || '打开文件').replace(/[\[\]\\\r\n]/g, ' ').trim() || '打开文件';
  const target = path.resolve(file).replace(/\\/g, '/');
  return `[${text}](<${target}>)`;
}

function statePath(project) { return path.join(project, 'project.json'); }

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
}

async function loadProject(project) {
  const state = await readJson(statePath(project)).catch(() => fail(`不是有效的 EasyPPT 项目：${project}`));
  if (state.schemaVersion !== 1 || path.resolve(state.projectDir) !== path.resolve(project)) fail('项目状态路径不匹配，已拒绝跨项目读取');
  return state;
}

async function saveProject(project, state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath(project), state);
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function addSourceFile(project, state, inputFile) {
  const source = path.resolve(String(inputFile || ''));
  const stat = await fsp.stat(source).catch(() => fail(`资料不存在：${source}`));
  if (!stat.isFile()) fail(`资料不是文件：${source}`);
  const bytes = await fsp.readFile(source);
  const hash = sha256(bytes);
  state.sources ||= [];
  const existing = state.sources.find((item) => item.sha256 === hash);
  if (existing) return { ...existing, absolutePath: path.join(project, existing.file), reused: true };
  const id = crypto.randomUUID();
  const relative = path.join('sources', `${id}-${safeName(path.basename(source))}`);
  await fsp.writeFile(path.join(project, relative), bytes, { mode: 0o600 });
  const record = { id, originalName: path.basename(source), file: relative, bytes: bytes.length, sha256: hash, addedAt: new Date().toISOString() };
  state.sources.push(record);
  return { ...record, absolutePath: path.join(project, relative), reused: false };
}

async function addSource(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  const files = values(args.file);
  if (!files.length) fail('缺少 --file');
  const added = await Promise.all(files.map((file) => addSourceFile(project, state, file)));
  await saveProject(project, state);
  console.log(JSON.stringify({ ok: true, project, sources: added.map(({ absolutePath, ...item }) => ({ ...item, file: absolutePath })) }));
}

async function initProject(args) {
  const name = safeName(args.name);
  const root = path.join(desktopDir(), 'EasyPPT');
  const project = path.join(root, name);
  await fsp.mkdir(root, { recursive: true });
  if (fs.existsSync(statePath(project))) fail(`项目已存在：${project}。使用 status 恢复，不要覆盖。`, 2);
  if (fs.existsSync(project) && (await fsp.readdir(project)).length > 0) fail(`目标目录非空：${project}`);
  for (const dir of ['sources', 'pages', 'prompts', 'exports', 'tmp']) await fsp.mkdir(path.join(project, dir), { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    projectId: crypto.randomUUID(),
    name,
    projectDir: project,
    createdAt: now,
    updatedAt: now,
    api: { baseUrl: API_BASE, model: IMAGE_MODEL },
    outline: { status: 'empty', file: null, lockedAt: null, title: null },
    style: { globalAnchor: null, contentAnchor: null },
    sources: [],
    pages: [],
    exports: []
  };
  await writeJsonAtomic(statePath(project), state);
  await fsp.writeFile(path.join(project, 'PROJECT.txt'), `EasyPPT 项目：${name}\n项目 ID：${state.projectId}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, project, next: 'collect_requirements' }));
}

function normalizeOutline(input) {
  if (!input || !Array.isArray(input.pages) || !input.pages.length) fail('大纲必须包含 pages 数组');
  if (input.pages.length > MAX_PAGES) fail(`第一版最多 ${MAX_PAGES} 页`);
  const pages = input.pages.map((page, index) => {
    const number = Number(page.page ?? index + 1);
    if (number !== index + 1) fail('页码必须从 1 开始连续排列');
    if (!String(page.title || '').trim() || !String(page.brief || '').trim()) fail(`第 ${number} 页缺少 title 或 brief`);
    return {
      page: number,
      title: String(page.title).trim(),
      brief: String(page.brief).trim(),
      goal: String(page.goal || '').trim(),
      audience: String(page.audience || input.audience || '').trim(),
      keyMessage: String(page.keyMessage || '').trim(),
      layoutType: String(page.layoutType || '').trim(),
      mustInclude: values(page.mustInclude).map(String),
      avoidPatterns: values(page.avoidPatterns).map(String)
    };
  });
  return {
    title: String(input.title || 'PPT 大纲').trim(),
    audience: String(input.audience || '').trim(),
    purpose: String(input.purpose || '').trim(),
    styleRequest: String(input.styleRequest || '').trim(),
    pages
  };
}

function outlineMarkdown(outline) {
  const lines = [`# ${outline.title}`, '', `${outline.pages.length} 页`, ''];
  for (const p of outline.pages) lines.push(`## ${p.page}. ${p.title}`, '', p.brief, '');
  return `${lines.join('\n')}\n`;
}

async function setOutline(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  if (state.outline.status === 'locked') fail('大纲已锁定；请先明确创建新版本，不得静默覆盖');
  const outline = normalizeOutline(await readJson(path.resolve(String(args.file || ''))));
  await writeJsonAtomic(path.join(project, 'outline.json'), outline);
  await fsp.writeFile(path.join(project, 'outline.md'), outlineMarkdown(outline), 'utf8');
  state.outline = { status: 'draft', file: 'outline.json', lockedAt: null, title: outline.title };
  state.name = safeName(outline.title);
  state.pages = outline.pages.map((spec) => ({ page: spec.page, title: spec.title, status: 'empty', confirmedVersionId: null, versions: [], attempts: [] }));
  state.style = { globalAnchor: null, contentAnchor: null };
  await saveProject(project, state);
  await fsp.writeFile(path.join(project, 'PROJECT.txt'), `EasyPPT 项目：${state.name}\n项目 ID：${state.projectId}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, project, outline: { title: outline.title, pages: outline.pages.length, status: 'draft' } }));
}

async function lockOutline(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  if (state.outline.status !== 'draft') fail('没有可锁定的大纲草稿');
  state.outline.status = 'locked';
  state.outline.lockedAt = new Date().toISOString();
  await saveProject(project, state);
  console.log(JSON.stringify({ ok: true, project, outlineStatus: 'locked' }));
}

function pageState(state, pageNumber) {
  const page = state.pages.find((item) => item.page === pageNumber);
  if (!page) fail(`大纲中不存在第 ${pageNumber} 页`);
  return page;
}

function activeVersion(page) {
  if (page.confirmedVersionId) return page.versions.find((version) => version.id === page.confirmedVersionId);
  return page.versions.at(-1);
}

async function confirmPage(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  const number = Number(args.page);
  const page = pageState(state, number);
  const version = args.version
    ? page.versions.find((item) => item.id === String(args.version))
    : page.versions.at(-1);
  if (!version || version.status !== 'draft') fail(`第 ${number} 页没有可确认的草稿`);
  version.status = 'confirmed';
  version.confirmedAt = new Date().toISOString();
  page.confirmedVersionId = version.id;
  page.status = 'confirmed';
  if (number === 1) state.style.globalAnchor = { page: number, versionId: version.id, file: version.file };
  else if (!state.style.contentAnchor) state.style.contentAnchor = { page: number, versionId: version.id, file: version.file };
  const deckComplete = state.pages.every((candidate) => candidate.page === number || Boolean(candidate.confirmedVersionId));
  await saveProject(project, state);
  console.log(JSON.stringify({ ok: true, project, page: number, version: version.id, status: 'confirmed', deckComplete }));
}

async function importPage(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  if (state.outline.status !== 'locked') fail('大纲尚未锁定');
  const number = Number(args.page);
  const page = pageState(state, number);
  const source = path.resolve(String(args.file || ''));
  await fsp.access(source);
  if (!['.jpg', '.jpeg', '.png'].includes(path.extname(source).toLowerCase())) fail('只允许导入 JPEG 或 PNG 页面');
  const bytes = await fsp.readFile(source);
  const extension = imageExtension(bytes);
  if (!extension) fail('导入文件不是完整 JPEG 或 PNG');
  const versionId = crypto.randomUUID();
  const relative = path.join('pages', `page-${String(number).padStart(2, '0')}-import-${versionId.slice(0, 8)}${extension}`);
  await fsp.copyFile(source, path.join(project, relative));
  page.versions.push({ id: versionId, file: relative, status: 'draft', mode: 'import', promptFile: null, referenceRoles: [], createdAt: new Date().toISOString(), bytes: bytes.length });
  page.status = 'draft';
  await saveProject(project, state);
  const file = path.join(project, relative);
  console.log(JSON.stringify({ ok: true, project, page: number, version: versionId, status: 'draft', file, previewMarkdown: previewMarkdown(page.title, file) }));
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[ext] || 'application/octet-stream';
}

function requireImageFile(file) {
  const mime = mimeFor(file);
  if (mime === 'application/octet-stream') fail(`EasyMax 图片素材只支持 JPEG、PNG、WebP：${path.basename(file)}`);
  return mime;
}

async function existingFile(project, file) {
  const resolved = path.resolve(project, file);
  const relative = path.relative(project, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('项目资源路径越界');
  await fsp.access(resolved);
  return resolved;
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = path.resolve(ref.file).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildRenderPlan(project, state, outline, number, mode, materials, instruction) {
  const spec = outline.pages[number - 1];
  const page = pageState(state, number);
  const refs = [];
  if (mode === 'edit-current') {
    const current = activeVersion(page);
    if (!current) fail(`第 ${number} 页还没有可编辑版本`);
    refs.push({ role: 'current_page', file: await existingFile(project, current.file), note: '当前页底图；除用户明确要求外保留布局、配色和未提及内容' });
  } else if (number > 1) {
    const previous = pageState(state, number - 1);
    const previousVersion = previous.versions.find((version) => version.id === previous.confirmedVersionId);
    if (!previousVersion) fail(`请先确认第 ${number - 1} 页，再生成第 ${number} 页`);
    refs.push({ role: 'previous_page', file: await existingFile(project, previousVersion.file), note: '相邻已确认页；延续其设计系统但创建新的页面内容' });
  }
  for (const anchorName of ['globalAnchor', 'contentAnchor']) {
    const anchor = state.style[anchorName];
    if (anchor) refs.push({ role: anchorName === 'globalAnchor' ? 'global_style_anchor' : 'content_style_anchor', file: await existingFile(project, anchor.file), note: anchorName === 'globalAnchor' ? '全局品牌与视觉锚点' : '内容页层级、间距与版式锚点' });
  }
  for (const item of materials) {
    requireImageFile(path.resolve(item));
    const source = await addSourceFile(project, state, item);
    refs.push({ role: 'material', file: source.absolutePath, note: '用户补充素材；提取并使用其事实、图片或标识，不要把它误当成设计风格' });
  }
  for (const ref of refs) await fsp.access(ref.file);
  const ordered = uniqueRefs(refs);
  const roleText = ordered.length ? ordered.map((ref, index) => `输入图片 ${index + 1}（${ref.role}）：${ref.note}`).join('\n') : '本次没有输入图片。';
  const copyForDensity = [spec.title, spec.brief, spec.keyMessage, ...(spec.mustInclude || []), instruction].filter(Boolean).join('');
  const denseCopy = copyForDensity.replace(/\s+/g, '').length >= 90;
  const typographyRule = denseCopy
    ? '本页文字信息较多：先保证所有文字清晰、准确、无错别字和乱码，再考虑装饰。使用足够大的字号、舒展行距和明确分组；不得为了塞入内容而缩成难以阅读的小字。最终出图前逐项核对标题、数字、专有名词和必须包含的文案。'
    : '本页文字较少：采用图片或核心视觉主导的设计，大标题简洁有力，保留充足留白；不要为了填满页面而增加无关小字、说明卡片或重复文案。';
  const prompt = [
    `设计一张完整的 16:9 横版 PPT 第 ${number} 页。`,
    `页面标题：${spec.title}`,
    `页面任务：${spec.brief}`,
    spec.goal && `沟通目标：${spec.goal}`,
    spec.audience && `目标受众：${spec.audience}`,
    spec.keyMessage && `核心信息：${spec.keyMessage}`,
    spec.layoutType && `建议版式：${spec.layoutType}`,
    spec.mustInclude.length && `必须准确包含：${spec.mustInclude.join('；')}`,
    spec.avoidPatterns.length && `避免：${spec.avoidPatterns.join('；')}`,
    outline.styleRequest && `整套视觉要求：${outline.styleRequest}`,
    instruction && `用户对本次生成的补充要求：${instruction}`,
    '',
    roleText,
    '',
    mode === 'edit-current'
      ? '这是当前页修订。只执行用户指定的变化；未提及的文字、图片、构图、层级、色彩和装饰保持不变。'
      : '这是新页面。参考输入图的设计语言和相邻节奏，但不要复制上一页的内容或做成同一张图。',
    '素材图是内容来源；只在页面中自然排版其真实内容，不得凭空替换人物、品牌、Logo 或关键事实。',
    typographyRule,
    '所有可见中文必须清晰、准确、自然，不得出现错别字、异体乱码、残缺笔画或无意义字符。整体必须有专业设计感，不能只是把文字平铺到背景上。',
    '可见文字只面向最终观众，不得出现提示词、规划说明、输入图片编号或制作过程。',
    '画面必须铺满整个 16:9 画布，现代、专业、高级，信息层级清楚，避免廉价模板感、密集小卡片和无意义装饰。'
  ].filter(Boolean).join('\n');
  return { mode, page: number, spec, instruction, references: ordered, prompt };
}

function authPath() {
  const root = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(root, 'auth.json');
}

async function apiKey() {
  const auth = await readJson(authPath()).catch(() => fail(`无法读取 Codex API 配置：${authPath()}`));
  const raw = auth.OPENAI_API_KEY;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || !key.startsWith('sk-')) fail('EasyMax API Key 未配置或格式无效：auth.json 的 OPENAI_API_KEY 必须是以 sk- 开头的字符串。已禁止使用其他登录凭据并终止流程。');
  return key;
}

function sanitize(text) {
  return String(text || '').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]').slice(0, 800);
}

function retryableDownload(status) { return status === 408 || status === 409 || status === 429 || status >= 500; }

function transientFetchError(error) {
  if (!error || error.status || error.name === 'AbortError') return false;
  const code = String(error.cause?.code || '').toUpperCase();
  return error instanceof TypeError
    || error.message === 'fetch failed'
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

async function requestOnce(build, label, context = {}) {
  const key = await apiKey();
  const requestStartedAt = Date.now();
  for (let attempt = 1; attempt <= GATEWAY_TIMEOUT_RETRIES; attempt += 1) {
    const elapsedBeforeAttempt = Date.now() - requestStartedAt;
    const remainingMs = REQUEST_TIMEOUT_MS - elapsedBeforeAttempt;
    if (remainingMs <= 0) break;
    const controller = new AbortController();
    const attemptStartedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - requestStartedAt) / 1000);
      const attemptElapsedSeconds = Math.floor((Date.now() - attemptStartedAt) / 1000);
      process.stderr.write(`${JSON.stringify({ type: 'progress', stage: 'rendering', label, ...context, skillVersion: SKILL_VERSION, attempt, elapsedSeconds, attemptElapsedSeconds, maxSeconds: 180 })}\n`);
    }, HEARTBEAT_MS);
    try {
      const request = build(key, controller.signal);
      const response = await fetch(request.url, request.init);
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!response.ok) {
        const responseBody = sanitize(text || json?.error?.message || json?.message || `${label} HTTP ${response.status}`);
        const message = sanitize(json?.error?.message || json?.message || responseBody || `${label} HTTP ${response.status}`);
        const timeLeftMs = REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt);
        const retrying = (response.status === 504 || response.status === 524)
          && attempt < GATEWAY_TIMEOUT_RETRIES
          && timeLeftMs > 2000;
        process.stderr.write(`${JSON.stringify({ type: 'upstream_error', label, ...context, skillVersion: SKILL_VERSION, status: response.status, attempt, maxAttempts: GATEWAY_TIMEOUT_RETRIES, elapsedSeconds: Math.floor((Date.now() - requestStartedAt) / 1000), maxSeconds: 180, message, responseBody, retrying })}\n`);
        if (retrying) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, timeLeftMs - 1000))));
          continue;
        }
        const supportHint = (response.status === 504 || response.status === 524)
          ? ' 如果总是出现这种情况，请联系技术人员。'
          : '';
        const error = new Error(`${label} HTTP ${response.status}：${message}${supportHint}`);
        error.status = response.status;
        throw error;
      }
      if (!json) fail(`${label} 返回的不是 JSON`);
      return json;
    } catch (error) {
      if (error.name === 'AbortError') fail(`${label} 总等待时间已达到 3 分钟，已停止本次请求。如果总是出现这种情况，请联系技术人员。`);
      const timeLeftMs = REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt);
      const retrying = transientFetchError(error) && attempt < GATEWAY_TIMEOUT_RETRIES && timeLeftMs > 2000;
      if (transientFetchError(error)) {
        const message = sanitize(error.cause?.message || error.message || 'fetch failed');
        process.stderr.write(`${JSON.stringify({ type: 'upstream_error', label, ...context, skillVersion: SKILL_VERSION, status: 'NETWORK', code: sanitize(error.cause?.code || ''), attempt, maxAttempts: GATEWAY_TIMEOUT_RETRIES, elapsedSeconds: Math.floor((Date.now() - requestStartedAt) / 1000), maxSeconds: 180, message, retrying })}\n`);
        if (retrying) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, timeLeftMs - 1000))));
          continue;
        }
        fail(`${label} 网络连接失败：${message}。如果总是出现这种情况，请联系技术人员。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }
  fail(`${label} 在 3 分钟内多次请求仍未成功。如果总是出现这种情况，请联系技术人员。`);
}

async function callEasyMax(plan, options) {
  const size = String(options.size || '1536x864');
  const quality = String(options.quality || 'high');
  const context = { page: plan.page, taskId: String(options.taskId || '') || undefined };
  if (!plan.references.length) {
    return requestOnce((key, signal) => ({
      url: `${API_BASE}/images/generations`,
      init: {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt: plan.prompt, size, quality, output_format: 'jpeg', n: 1 })
      }
    }), 'EasyMax generations', context);
  }
  return requestOnce((key, signal) => {
    const form = new FormData();
    form.append('model', IMAGE_MODEL);
    form.append('prompt', plan.prompt);
    form.append('size', size);
    form.append('quality', quality);
    form.append('output_format', 'jpeg');
    for (const ref of plan.references) {
      const bytes = fs.readFileSync(ref.file);
      form.append('image[]', new Blob([bytes], { type: requireImageFile(ref.file) }), path.basename(ref.file));
    }
    return { url: `${API_BASE}/images/edits`, init: { method: 'POST', signal, headers: { Authorization: `Bearer ${key}` }, body: form } };
  }, 'EasyMax edits', context);
}

async function responseImage(json) {
  const item = json?.data?.[0];
  if (item?.b64_json) {
    const encoded = String(item.b64_json);
    const dataUrl = encoded.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
    return Buffer.from(dataUrl ? dataUrl[1] : encoded, 'base64');
  }
  if (item?.url) {
    let lastError;
    let slowWarningSent = false;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      const slowTimer = setTimeout(() => {
        if (slowWarningSent) return;
        slowWarningSent = true;
        process.stderr.write(`${JSON.stringify({ type: 'download_slow', attempt, message: '图片下载速度较慢；如果长时间没有完成，可以尝试开启代理后重试。' })}\n`);
      }, 10 * 1000);
      try {
        const response = await fetch(item.url, { signal: controller.signal });
        if (!response.ok) {
          const error = new Error(`EasyMax 图片下载失败：HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
        const status = Number(error.status || 0);
        const retryable = error.name === 'AbortError' || transientFetchError(error) || retryableDownload(status);
        process.stderr.write(`${JSON.stringify({ type: 'image_download_error', status: status || 'NETWORK', code: sanitize(error.cause?.code || ''), attempt, maxAttempts: DOWNLOAD_RETRIES, message: sanitize(error.cause?.message || error.message || 'fetch failed'), retrying: retryable && attempt < DOWNLOAD_RETRIES })}\n`);
        if (!retryable) break;
        if (attempt === DOWNLOAD_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      } finally {
        clearTimeout(timer);
        clearTimeout(slowTimer);
      }
    }
    const error = new Error(`EasyMax 图片下载失败（已尝试 ${DOWNLOAD_RETRIES} 次）：${sanitize(lastError?.cause?.message || lastError?.message || lastError)}`);
    error.resultDownloadFailed = true;
    throw error;
  }
  fail('EasyMax 标准响应缺少 data[0].b64_json 或 data[0].url');
}

async function renderBytes(plan, options) {
  const response = await callEasyMax(plan, options);
  try {
    return await responseImage(response);
  } catch (error) {
    if (!error?.resultDownloadFailed) throw error;
    process.stderr.write(`${JSON.stringify({ type: 'image_regenerating', page: plan.page, taskId: String(options.taskId || '') || undefined, message: '图片效果不达标，正在尝试重新生成，请稍等。' })}\n`);
    const regenerated = await callEasyMax(plan, { ...options, regeneratedAfterDownloadFailure: true });
    try {
      return await responseImage(regenerated);
    } catch (downloadError) {
      if (!downloadError?.resultDownloadFailed) throw downloadError;
      const finalError = new Error(`${downloadError.message}。图片结果连续下载失败，通常是当前网络无法稳定访问图片地址；请尝试开启代理后重试。如果仍然失败，请联系技术人员。`);
      finalError.resultDownloadFailed = true;
      throw finalError;
    }
  }
}

function isJpeg(bytes) { return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9; }

function isPng(bytes) {
  return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function imageExtension(bytes) {
  if (isJpeg(bytes)) return '.jpg';
  if (isPng(bytes)) return '.png';
  return null;
}

function imageSignature(bytes) {
  return Buffer.from(bytes.subarray(0, Math.min(12, bytes.length))).toString('hex');
}

async function persistDraft(project, state, page, plan, promptFile, bytes, extra = {}) {
  const extension = imageExtension(bytes);
  if (!extension) fail(`EasyMax 图片响应格式未知（signature=${imageSignature(bytes)}，bytes=${bytes.length}）`);
  const versionId = crypto.randomUUID();
  const relative = path.join('pages', `page-${String(page.page).padStart(2, '0')}-v${page.versions.length + 1}-${versionId.slice(0, 8)}${extension}`);
  await fsp.writeFile(path.join(project, relative), bytes);
  page.versions.push({ id: versionId, file: relative, status: 'draft', mode: plan.mode, promptFile, referenceRoles: plan.references.map((ref) => ref.role), createdAt: new Date().toISOString(), bytes: bytes.length, ...extra });
  page.status = 'draft';
  return { versionId, relative };
}

async function renderPage(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  if (state.api.baseUrl !== API_BASE || state.api.model !== IMAGE_MODEL) fail('项目 API 配置不是唯一允许的 EasyMax gpt-image-2');
  if (state.outline.status !== 'locked') fail('大纲尚未锁定');
  const outline = await readJson(path.join(project, 'outline.json'));
  const number = Number(args.page);
  const mode = String(args.mode || 'create');
  if (!['create', 'edit-current'].includes(mode)) fail('--mode 只能是 create 或 edit-current');
  const page = pageState(state, number);
  const plan = await buildRenderPlan(project, state, outline, number, mode, values(args.material), String(args.instruction || ''));
  const attemptId = crypto.randomUUID();
  const promptFile = path.join('prompts', `page-${String(number).padStart(2, '0')}-${attemptId}.json`);
  const portablePlan = { ...plan, references: plan.references.map((ref) => ({ ...ref, file: path.relative(project, ref.file) })), endpoint: plan.references.length ? `${API_BASE}/images/edits` : `${API_BASE}/images/generations`, model: IMAGE_MODEL, createdAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(project, promptFile), portablePlan);
  const previousStatus = page.status;
  page.status = 'generating';
  page.attempts.push({ id: attemptId, status: 'running', promptFile, createdAt: new Date().toISOString() });
  await saveProject(project, state);
  try {
    if (args['dry-run']) {
      page.status = previousStatus;
      page.attempts.at(-1).status = 'dry-run';
      await saveProject(project, state);
      console.log(JSON.stringify({ ok: true, dryRun: true, endpoint: portablePlan.endpoint, referenceRoles: portablePlan.references.map((ref) => ref.role), promptFile: path.join(project, promptFile) }));
      return;
    }
    const bytes = await renderBytes(plan, { ...args, taskId: attemptId });
    const { versionId, relative } = await persistDraft(project, state, page, plan, promptFile, bytes);
    page.attempts.at(-1).status = 'success';
    page.attempts.at(-1).versionId = versionId;
    await saveProject(project, state);
    const file = path.join(project, relative);
    console.log(JSON.stringify({ ok: true, project, page: number, version: versionId, status: 'draft', file, previewMarkdown: previewMarkdown(page.title, file), endpoint: portablePlan.endpoint, bytes: bytes.length }));
  } catch (error) {
    page.status = previousStatus;
    page.attempts.at(-1).status = 'failed';
    page.attempts.at(-1).error = sanitize(error.message);
    await saveProject(project, state);
    throw error;
  }
}

async function retryAttempt(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  const attemptId = String(args.attempt || '');
  let page;
  let attempt;
  for (const candidate of state.pages) {
    const found = candidate.attempts.find((item) => item.id === attemptId);
    if (found) { page = candidate; attempt = found; break; }
  }
  if (!attempt || !page) fail(`找不到 attempt：${attemptId}`);
  if (!['failed', 'dry-run'].includes(attempt.status)) fail(`attempt 当前状态不可重试：${attempt.status}`);
  const saved = await readJson(path.join(project, attempt.promptFile));
  if (saved.model !== IMAGE_MODEL || !String(saved.endpoint || '').startsWith(API_BASE)) fail('保存的任务不是允许的 EasyMax gpt-image-2 请求');
  const references = [];
  for (const ref of saved.references || []) references.push({ ...ref, file: await existingFile(project, ref.file) });
  const plan = { mode: saved.mode, page: saved.page, spec: saved.spec, instruction: saved.instruction, references, prompt: saved.prompt };
  const retryId = crypto.randomUUID();
  const retryRecord = { id: retryId, retryOf: attemptId, status: 'running', promptFile: attempt.promptFile, createdAt: new Date().toISOString() };
  const previousStatus = page.status;
  page.status = 'generating';
  page.attempts.push(retryRecord);
  await saveProject(project, state);
  try {
    if (args['dry-run']) {
      retryRecord.status = 'dry-run';
      page.status = previousStatus;
      await saveProject(project, state);
      console.log(JSON.stringify({ ok: true, dryRun: true, retryOf: attemptId, attempt: retryId, endpoint: saved.endpoint, referenceRoles: references.map((ref) => ref.role) }));
      return;
    }
    const bytes = await renderBytes(plan, { ...args, taskId: retryId });
    const { versionId, relative } = await persistDraft(project, state, page, plan, attempt.promptFile, bytes, { retryOf: attemptId });
    retryRecord.status = 'success';
    retryRecord.versionId = versionId;
    await saveProject(project, state);
    const file = path.join(project, relative);
    console.log(JSON.stringify({ ok: true, project, page: page.page, retryOf: attemptId, attempt: retryId, version: versionId, status: 'draft', file, previewMarkdown: previewMarkdown(page.title, file), endpoint: saved.endpoint }));
  } catch (error) {
    page.status = previousStatus;
    retryRecord.status = 'failed';
    retryRecord.error = sanitize(error.message);
    await saveProject(project, state);
    throw error;
  }
}

async function renderVariants(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  if (state.api.baseUrl !== API_BASE || state.api.model !== IMAGE_MODEL) fail('项目 API 配置不是唯一允许的 EasyMax gpt-image-2');
  if (state.outline.status !== 'locked') fail('大纲尚未锁定');
  const outline = await readJson(path.join(project, 'outline.json'));
  const number = Number(args.page || 1);
  const styles = values(args.style).map((item) => String(item).trim()).filter(Boolean);
  if (styles.length < 2 || styles.length > 8) fail('并发视觉方案数量必须为 2-8 个');
  if (number !== 1) fail('第一版的并发视觉方案只用于封面；内容页应跟随已确认风格');
  const page = pageState(state, number);
  const previousStatus = page.status;
  page.status = 'generating';
  const jobs = [];
  const diversityDirectives = [
    '以理性数据叙事为主：深色或高对比色系，几何网格、数据轨迹或信息可视化作为核心视觉；构图克制、有科技感。',
    '以真实影像和编辑式排版为主：明亮自然色系，大幅纪实照片、明显留白和杂志式字体层级；避免科技蓝数据面板。',
    '以大胆品牌图形和非对称构图为主：使用与前两套不同的主色，强调大字、色块、路径或抽象符号；避免照片拼贴和数据仪表盘。',
    '以温暖人文叙事为主：柔和暖色、人物互动或教育现场为核心，排版亲和可信；避免冷峻科技视觉。',
    '以高端极简商务为主：低饱和中性色、大面积留白、精确网格和单一焦点；避免复杂装饰与多图拼贴。',
    '以未来实验视觉为主：强烈但高级的色彩、沉浸式空间或抽象材质，构图具有冲击力；不得沿用其他方案的版式骨架。',
    '以学术报告与出版物为主：纸张感、严谨网格、图表或档案元素，强调可信度；避免营销海报感。',
    '以现代教育插画为主：定制插画、清晰故事场景、活泼但不过度幼稚的色彩；避免真实照片和企业数据大屏。'
  ];
  for (let styleIndex = 0; styleIndex < styles.length; styleIndex += 1) {
    const style = styles[styleIndex];
    const diversity = diversityDirectives[styleIndex % diversityDirectives.length];
    const plan = await buildRenderPlan(project, state, outline, number, 'create', [], `${String(args.instruction || '')}\n本方案名称：${style}\n本方案必须采用的独占设计方向：${diversity}\n这是多方案评审中的一套，必须在主色、构图骨架、字体气质和图像语言上与其他方案明显不同。`.trim());
    const attemptId = crypto.randomUUID();
    const promptFile = path.join('prompts', `page-${String(number).padStart(2, '0')}-${attemptId}.json`);
    const portablePlan = { ...plan, styleName: style, references: [], endpoint: `${API_BASE}/images/generations`, model: IMAGE_MODEL, createdAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(project, promptFile), portablePlan);
    const attempt = { id: attemptId, status: args['dry-run'] ? 'dry-run' : 'running', promptFile, styleName: style, createdAt: new Date().toISOString() };
    page.attempts.push(attempt);
    jobs.push({ style, plan, attempt, promptFile });
  }
  await saveProject(project, state);
  if (args['dry-run']) {
    page.status = previousStatus;
    await saveProject(project, state);
    console.log(JSON.stringify({ ok: true, dryRun: true, endpoint: `${API_BASE}/images/generations`, styles, promptFiles: jobs.map((job) => path.join(project, job.promptFile)) }));
    return;
  }
  const created = [];
  const errors = [];
  let commitQueue = Promise.resolve();
  const commit = (work) => {
    const result = commitQueue.then(work, work);
    commitQueue = result.catch(() => {});
    return result;
  };
  process.stderr.write(`${JSON.stringify({ type: 'progress', stage: 'variants_started', total: jobs.length })}\n`);
  await Promise.allSettled(jobs.map(async (job) => {
    try {
      const bytes = await renderBytes(job.plan, { ...args, taskId: job.attempt.id });
      const extension = imageExtension(bytes);
      if (!extension) fail(`EasyMax 图片响应格式未知（signature=${imageSignature(bytes)}，bytes=${bytes.length}）`);
      await commit(async () => {
        const versionId = crypto.randomUUID();
        const relative = path.join('pages', `page-01-variant-${versionId.slice(0, 8)}${extension}`);
        await fsp.writeFile(path.join(project, relative), bytes);
        page.versions.push({ id: versionId, file: relative, status: 'draft', mode: 'create', styleName: job.style, promptFile: job.promptFile, referenceRoles: [], createdAt: new Date().toISOString(), bytes: bytes.length });
        job.attempt.status = 'success';
        job.attempt.versionId = versionId;
        const file = path.join(project, relative);
        const item = { style: job.style, version: versionId, file, previewMarkdown: previewMarkdown(job.style, file) };
        created.push(item);
        page.status = 'draft';
        await saveProject(project, state);
        process.stdout.write(`${JSON.stringify({ type: 'variant_ready', ...item, completed: created.length, total: jobs.length })}\n`);
      });
    } catch (error) {
      await commit(async () => {
        job.attempt.status = 'failed';
        job.attempt.error = sanitize(error?.message || error);
        const item = { style: job.style, error: job.attempt.error };
        errors.push(item);
        await saveProject(project, state);
        process.stderr.write(`${JSON.stringify({ type: 'variant_failed', ...item, failed: errors.length, total: jobs.length })}\n`);
      });
    }
  }));
  await commitQueue;
  page.status = created.length ? 'draft' : previousStatus;
  await saveProject(project, state);
  if (!created.length) fail(`所有 EasyMax 视觉方案均失败：${errors.map((item) => `${item.style}: ${item.error}`).join('；')}`);
  console.log(JSON.stringify({ ok: true, project, page: number, created, errors }));
}

async function mergePdf(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  const images = state.pages.map((page) => {
    const version = page.versions.find((item) => item.id === page.confirmedVersionId);
    if (!version) fail(`第 ${page.page} 页尚未确认，不能导出`);
    return path.join(project, version.file);
  });
  const output = path.join(project, 'exports', `${safeName(state.name)}.pdf`);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-jpeg-pdf.mjs');
  const module = await import(pathToFileURL(decodeURIComponent(script)).href);
  await module.mergeJpegs(images, output);
  state.exports.push({ type: 'pdf', file: path.relative(project, output), createdAt: new Date().toISOString(), pages: images.length });
  state.lifecycle = { status: 'completed', completedAt: new Date().toISOString(), output: path.relative(project, output) };
  await saveProject(project, state);
  console.log(JSON.stringify({ ok: true, project, output, fileMarkdown: fileMarkdown('打开 PDF', output), pages: images.length, completed: true }));
}

async function status(args) {
  const project = projectRoot(args.project);
  const state = await loadProject(project);
  console.log(JSON.stringify({ ok: true, project, name: state.name, outline: state.outline, style: state.style, sources: (state.sources || []).map((source) => ({ id: source.id, originalName: source.originalName, file: source.file, bytes: source.bytes, sha256: source.sha256 })), pages: state.pages.map((page) => ({ page: page.page, title: page.title, status: page.status, versions: page.versions.length, confirmedVersionId: page.confirmedVersionId })) }, null, 2));
}

async function doctor() {
  const auth = await readJson(authPath()).catch(() => null);
  const keyReady = typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim().startsWith('sk-');
  console.log(JSON.stringify({ ok: keyReady, apiBase: API_BASE, model: IMAGE_MODEL, authFile: authPath(), keyReady, credentialPolicy: 'OPENAI_API_KEY must start with sk-; ChatGPT login tokens are forbidden', node: process.version, platform: process.platform, desktop: desktopDir() }));
  if (!keyReady) process.exitCode = 2;
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'init') return initProject(args);
  if (command === 'add-source') return addSource(args);
  if (command === 'set-outline') return setOutline(args);
  if (command === 'lock-outline') return lockOutline(args);
  if (command === 'confirm') return confirmPage(args);
  if (command === 'render') return renderPage(args);
  if (command === 'render-variants') return renderVariants(args);
  if (command === 'retry') return retryAttempt(args);
  if (command === 'import-page') return importPage(args);
  if (command === 'merge-pdf') return mergePdf(args);
  if (command === 'status') return status(args);
  if (command === 'doctor') return doctor();
  fail('用法：easy-ppt.mjs <init|add-source|set-outline|lock-outline|render|render-variants|retry|import-page|confirm|merge-pdf|status|doctor> [参数]');
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: sanitize(error.message) }));
  process.exitCode = error.exitCode || 1;
});
