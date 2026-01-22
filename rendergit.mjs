#!/usr/bin/env node

import fs from "node:fs/promises";
import {existsSync, statSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

import {createStarryNight, all} from "@wooorm/starry-night";
import {toHtml} from "hast-util-to-html";
import {marked} from "marked";

const execFileAsync = promisify(execFile);

const MAX_DEFAULT_BYTES = 50 * 1024;
const BINARY_BITS_VIEW_ENABLED = true;
const BINARY_BIT_LINE_WIDTH = 8;

const THEME_URL = await import.meta.resolve("@wooorm/starry-night/style/both");
const STARLIGHT_THEME_CSS = await fs.readFile(
  THEME_URL.startsWith("file:")
    ? fileURLToPath(new URL(THEME_URL))
    : THEME_URL,
  "utf8"
);

const FORCE_TEXT_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".shtml"
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".heic", ".heif",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".ogg", ".flac",
  ".ttf", ".otf", ".eot", ".woff", ".woff2",
  ".so", ".dll", ".dylib", ".class", ".jar", ".exe", ".bin"
]);

const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".avif", "image/avif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"]
]);

const MARKDOWN_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".mkdn"
]);

const LARGE_DATA_EXTENSIONS = new Set([
  ".csv", ".json", ".pem"
]);

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function run(cmd, args, options = {}) {
  return execFileAsync(cmd, args, {...options, encoding: "utf8"});
}

async function looksBinary(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (FORCE_TEXT_EXTENSIONS.has(ext)) return false;
  if (BINARY_EXTENSIONS.has(ext)) return true;
  try {
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(8192);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] === 0) return true;
    }
    const decoder = new TextDecoder("utf-8", {fatal: true});
    decoder.decode(buffer.subarray(0, bytesRead));
    return false;
  } catch {
    return true;
  }
}

async function decideFile(filePath, repoRoot, maxBytes) {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  const ext = path.extname(filePath).toLowerCase();
  let size = 0;
  try {
    const stat = await fs.stat(filePath);
    size = stat.size;
  } catch {
    // ignore
  }

  if (rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/")) {
    return {path: filePath, rel, size, decision: {include: false, reason: "ignored"}};
  }
  if (size > maxBytes && LARGE_DATA_EXTENSIONS.has(ext)) {
    return {path: filePath, rel, size, decision: {include: false, reason: "too_large"}};
  }
  if (await looksBinary(filePath)) {
    return {path: filePath, rel, size, decision: {include: true, reason: "binary"}};
  }
  return {path: filePath, rel, size, decision: {include: true, reason: "ok"}};
}

async function collectFiles(repoRoot, maxBytes, filePaths = null) {
  const candidates = [];
  if (filePaths == null) {
    await gatherFilesRecursively(repoRoot, candidates);
  } else {
    for (const rel of filePaths) {
      const full = path.join(repoRoot, rel);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) candidates.push(full);
      } catch {
        // ignore missing files
      }
    }
  }
  candidates.sort((a, b) => a.localeCompare(b, "en", {sensitivity: "base"}));
  const infos = [];
  for (const file of candidates) {
    infos.push(await decideFile(file, repoRoot, maxBytes));
  }
  return infos;
}

async function gatherFilesRecursively(current, out) {
  let entries;
  try {
    entries = await fs.readdir(current, {withFileTypes: true});
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "en", {sensitivity: "base"}));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      await gatherFilesRecursively(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

async function gitLsFiles(repoDir) {
  const {stdout} = await run("git", ["ls-files"], {cwd: repoDir});
  return stdout.split("\n").filter(Boolean);
}

function pathFromFileUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") {
    throw new Error("Not a file URL");
  }
  if (parsed.host && parsed.host.toLowerCase() !== "localhost") {
    throw new Error("Unsupported file URL host");
  }
  return path.resolve(fileURLToPath(parsed));
}

function resolveRepoSource(repoArg) {
  try {
    const parsed = new URL(repoArg);
    if (parsed.protocol === "file:") {
      return {mode: "local", value: pathFromFileUrl(repoArg)};
    }
    if (["http:", "https:", "git:", "ssh:"].includes(parsed.protocol)) {
      return {mode: "remote", value: repoArg};
    }
  } catch {
    // not a URL
  }
  if (repoArg.startsWith("git@")) {
    return {mode: "remote", value: repoArg};
  }
  const localCandidate = path.resolve(repoArg);
  if (existsSync(localCandidate) && statSync(localCandidate).isDirectory()) {
    return {mode: "local", value: localCandidate};
  }
  return {mode: "remote", value: repoArg};
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

function renderMarkdown(text, highlighter) {
  const renderer = new marked.Renderer();
  renderer.code = (code, infoString) => {
    const lang = (infoString || "").split(/\s+/)[0];
    const scope = lang ? resolveScope(highlighter, lang) : null;
    if (scope) {
      try {
        const tree = highlighter.highlight(code, scope);
        const codeHtml = toHtml(tree);
        return `<div class="highlight"><pre>${codeHtml}</pre></div>`;
      } catch {
        // fall through to plain rendering if highlighting fails
      }
    }
    const classAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${classAttr}>${escapeHtml(code)}</code></pre>`;
  };
  return marked.parse(text, {renderer, mangle: false, headerIds: false});
}

function slugify(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function formatBinaryDump(buffer, width = BINARY_BIT_LINE_WIDTH) {
  const lines = [];
  for (let i = 0; i < buffer.length; i += width) {
    const chunk = buffer.subarray(i, i + width);
    const bitSegments = [];
    for (let j = 0; j < chunk.length; j += 1) {
      bitSegments.push(chunk[j].toString(2).padStart(8, "0"));
    }
    while (bitSegments.length < width) {
      bitSegments.push("        ");
    }
    const ascii = Array.from(chunk, byte =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."
    ).join("").padEnd(width, " ");
    lines.push(`${bitSegments.join(" ")}  |${ascii}|`);
  }
  return lines.join("\n");
}

function renderSkipSection(title, items) {
  if (items.length === 0) return "";
  const list = items
    .map(item => `<li><code>${escapeHtml(item.rel)}</code></li>`)
    .join("\n");
  return `<details><summary>${escapeHtml(title)} (${items.length})</summary><ul class="skip-list">\n${list}\n</ul></details>`;
}

function countLines(value) {
  if (!value) return 0;
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) return 0;
  const segments = normalized.split("\n");
  return normalized.endsWith("\n") ? segments.length - 1 : segments.length;
}

async function gatherOldestCommitTimes(repoDir, relPaths) {
  const uniquePaths = Array.from(new Set(relPaths));
  const pending = new Set(uniquePaths);
  const fileAges = new Map();

  if (pending.size === 0) return fileAges;

  try {
    const {stdout} = await run(
      "git",
      ["log", "--format=%ct", "--name-only", "--reverse", "--", "."],
      {cwd: repoDir}
    );
    const lines = stdout.split("\n");
    let currentTimestamp = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) {
        currentTimestamp = null;
        continue;
      }
      if (currentTimestamp == null) {
        const parsed = Number(line.trim());
        if (Number.isFinite(parsed)) {
          currentTimestamp = parsed;
        }
        continue;
      }
      if (pending.size === 0) break;
      const rel = line;
      if (!pending.has(rel)) continue;
      if (!fileAges.has(rel)) {
        fileAges.set(rel, currentTimestamp);
        pending.delete(rel);
      }
    }
  } catch {
    // ignore bulk history failures; we'll fall back per file below
  }

  if (pending.size > 0) {
    for (const rel of pending) {
      try {
        const {stdout} = await run(
          "git",
          ["log", "--follow", "--format=%ct", "--", rel],
          {cwd: repoDir}
        );
        const parts = stdout.trim().split(/\s+/).filter(Boolean);
        if (parts.length > 0) {
          const timestamp = Number(parts[parts.length - 1]);
          if (Number.isFinite(timestamp)) {
            fileAges.set(rel, timestamp);
          }
        }
      } catch {
        // ignore files without retrievable git history
      }
    }
  }

  return fileAges;
}

function computeDirectoryAge(node) {
  if (node.type === "file") {
    return node.age ?? Number.POSITIVE_INFINITY;
  }
  let minAge = Number.POSITIVE_INFINITY;
  for (const child of node.children.values()) {
    const childAge = computeDirectoryAge(child);
    if (childAge < minAge) minAge = childAge;
  }
  node.age = minAge;
  return minAge;
}

function collectFilesByAge(node, parentPath, out) {
  if (!node.children) return;
  const entries = Array.from(node.children.entries());
  entries.sort((a, b) => {
    const nodeA = a[1];
    const nodeB = b[1];
    const ageA = nodeA.type === "file" ? nodeA.age ?? Number.POSITIVE_INFINITY : nodeA.age ?? Number.POSITIVE_INFINITY;
    const ageB = nodeB.type === "file" ? nodeB.age ?? Number.POSITIVE_INFINITY : nodeB.age ?? Number.POSITIVE_INFINITY;
    if (ageA !== ageB) return ageA - ageB;
    const pathA = parentPath ? `${parentPath}/${a[0]}` : a[0];
    const pathB = parentPath ? `${parentPath}/${b[0]}` : b[0];
    return pathA.localeCompare(pathB, "en", {sensitivity: "base"});
  });
  for (const [segment, childNode] of entries) {
    const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
    if (childNode.type === "file") {
      out.push(childNode.info);
    } else {
      collectFilesByAge(childNode, currentPath, out);
    }
  }
}

function orderInfosByOldest(infos, fileAges) {
  const root = {type: "dir", children: new Map(), age: Number.POSITIVE_INFINITY};
  for (const info of infos) {
    const segments = info.rel.split("/");
    let node = root;
    for (let i = 0; i < segments.length; i += 1) {
      const part = segments[i];
      const isLast = i === segments.length - 1;
      if (isLast) {
        node.children.set(part, {
          type: "file",
          info,
          age: fileAges.get(info.rel) ?? Number.POSITIVE_INFINITY
        });
      } else {
        let child = node.children.get(part);
        if (!child) {
          child = {type: "dir", children: new Map(), age: Number.POSITIVE_INFINITY};
          node.children.set(part, child);
        }
        node = child;
      }
    }
  }

  computeDirectoryAge(root);

  const ordered = [];
  collectFilesByAge(root, "", ordered);
  return ordered;
}

async function gitClone(repo, destination) {
  await run("git", ["clone", "--depth", "1", repo, destination]);
}

async function gitHeadCommit(repoDir) {
  try {
    const {stdout} = await run("git", ["rev-parse", "HEAD"], {cwd: repoDir});
    return stdout.trim();
  } catch {
    return "(unknown)";
  }
}

async function openInBrowser(filePath) {
  const platform = process.platform;
  const absolute = path.resolve(filePath);
  try {
    if (platform === "darwin") {
      await run("open", [absolute]);
    } else if (platform === "win32") {
      await run("cmd", ["/c", "start", "", absolute]);
    } else {
      await run("xdg-open", [absolute]);
    }
  } catch {
    // ignore browser launch failures
  }
}

function deriveOutputPath(repoLabel) {
  const trimmed = repoLabel.replace(/\/+$/, "");
  const base = trimmed.split("/").pop() || "repo";
  const name = base.endsWith(".git") ? base.slice(0, -4) : base;
  return path.join(os.tmpdir(), `${name}.html`);
}

async function buildHtml(repoLabel, repoDir, headCommit, infos, highlighter, sortMode) {
  let rendered = infos.filter(info => info.decision.include);
  const skippedBinary = infos.filter(info => !info.decision.include && info.decision.reason === "binary");
  const skippedLargeData = infos.filter(info => !info.decision.include && info.decision.reason === "too_large");
  const skippedIgnored = infos.filter(info => !info.decision.include && info.decision.reason === "ignored");
  const totalFiles = rendered.length + skippedBinary.length + skippedLargeData.length + skippedIgnored.length;

  if (rendered.length > 0) {
    if (sortMode === "age") {
      const fileAgeMap = await gatherOldestCommitTimes(repoDir, rendered.map(info => info.rel));
      rendered = orderInfosByOldest(rendered, fileAgeMap);
    } else {
      rendered.sort((a, b) => a.rel.localeCompare(b.rel, "en", {sensitivity: "base"}));
    }
  }

  let topLevelReadmeIndex = -1;
  for (let i = 0; i < rendered.length; i += 1) {
    if (rendered[i].rel.includes("/")) continue;
    const lower = rendered[i].rel.toLowerCase();
    if (lower === "readme" || lower.startsWith("readme.")) {
      topLevelReadmeIndex = i;
      break;
    }
  }
  if (topLevelReadmeIndex > 0) {
    const readmeInfo = rendered.splice(topLevelReadmeIndex, 1)[0];
    rendered.unshift(readmeInfo);
  }

  let renderedLineCount = 0;
  const sections = [];
  for (const info of rendered) {
    const anchor = slugify(info.rel);
    let bodyHtml;
    try {
      const ext = path.extname(info.path).toLowerCase();
      if (info.decision.reason === "binary") {
        const imageMime = IMAGE_MIME_TYPES.get(ext);
        if (imageMime) {
          const buffer = await fs.readFile(info.path);
          const dataUrl = `data:${imageMime};base64,${buffer.toString("base64")}`;
          bodyHtml = `<div class="image-view"><img src="${dataUrl}" alt="${escapeHtml(info.rel)}" /></div>`;
        } else if (BINARY_BITS_VIEW_ENABLED) {
          const buffer = await fs.readFile(info.path);
          const binaryDump = formatBinaryDump(buffer);
          bodyHtml = `<div class="binary-view"><pre><code>${escapeHtml(binaryDump)}</code></pre></div>`;
        } else {
          bodyHtml = '<pre class="error">Binary rendering disabled.</pre>';
        }
        info.lineCount = 0;
      } else {
        const text = await readText(info.path);
        const lineCount = countLines(text);
        info.lineCount = lineCount;
        renderedLineCount += lineCount;
        if (MARKDOWN_EXTENSIONS.has(ext)) {
          bodyHtml = renderMarkdown(text, highlighter);
        } else {
          const scope = resolveScope(highlighter, info.rel);
          if (scope) {
            const tree = highlighter.highlight(text, scope);
            const codeHtml = toHtml(tree);
            bodyHtml = `<div class="highlight"><pre>${codeHtml}</pre></div>`;
          } else {
            bodyHtml = `<pre><code>${escapeHtml(text)}</code></pre>`;
          }
        }
      }
    } catch (error) {
      bodyHtml = `<pre class="error">Failed to render: ${escapeHtml(String(error))}</pre>`;
      if (info.lineCount == null) {
        info.lineCount = 0;
      }
    }

    sections.push(`
<section class="file-section" id="file-${anchor}">
  <h2><code>${escapeHtml(info.rel)}</code><span class="file-controls"><button class="auto-scroll-button secondary file-scroll-button" type="button" aria-label="Restart auto-scroll for ${escapeHtml(info.rel)}">&#9654;</button></span></h2>
  <div class="file-body">${bodyHtml}</div>
</section>
`);
  }

  const skippedHtml = renderSkipSection("Skipped binaries", skippedBinary) + renderSkipSection("Skipped large data files", skippedLargeData);
  const skippedSection = skippedHtml
    ? `
    <section>
      <h2>Skipped items</h2>
      ${skippedHtml}
    </section>
`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Flattened repo – ${escapeHtml(repoLabel)}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji','Segoe UI Emoji';
    margin: 0; padding: 0; line-height: 1.45;
  }
  .container { margin: 0 auto; padding: 0 1rem; }
  .meta small { color: #666; }
  .counts { margin-top: 0.25rem; color: #333; }
  .muted { color: #777; font-weight: normal; font-size: 0.9em; }

  main.container { padding-top: 1rem; }

  .meta-bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem; 
  }
  .meta-bar .meta { flex: 1 1 auto; }

  .auto-scroll-button {
    background: #2563eb;
    color: #ffffff;
    border: none;
    border-radius: 999px;
    padding: 0.5rem 1rem;
    font-size: 0.95rem;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);
    transition: background 0.2s ease, transform 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .auto-scroll-button:hover {
    background: #1e4fd1;
    transform: translateY(-1px);
  }
  .auto-scroll-button:focus-visible {
    outline: 2px solid #1e4fd1;
    outline-offset: 2px;
  }
  .auto-scroll-button.active {
    background: #1e4fd1;
  }
  .auto-scroll-button.secondary {
    padding: 0.35rem 0.75rem;
    font-size: 0.85rem;
    box-shadow: none;
  }

  pre { background: #ffffff; padding: 0; overflow: auto; border-radius: 0; margin: 0; }
  code { font-family: "SF Mono", "Source Code Pro", monospace; }
  .highlight { overflow-x: auto; background: #ffffff; padding: 0; margin: 0; }
  .highlight pre { background: #ffffff; border: none; margin: 0; padding: 0; }
  .file-section { margin: 0; padding: 0; }
  .file-section > h2 {
    margin: 0 -1rem;
    font-size: 1.15rem;
    font-weight: 600;
    background: #f2f4f8;
    padding: 0.9rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .file-section h2 code {
    font-family: "SF Mono", "Source Code Pro", monospace;
    font-size: 1em;
    padding: 0;
    border-radius: 0;
    flex: 1 1 auto;
    overflow-wrap: anywhere;
  }
  .file-section h2 .file-controls { margin-left: auto; display: inline-flex; align-items: center; gap: 0.5rem; }
  .file-section h2 .file-controls button { margin: 0; }
  pre {
    font-size: 16px;
  }
  .file-body { background: #ffffff; padding: 1rem 0 1rem 0; }
  .binary-view pre { margin-bottom: 0.75rem; }
  .image-view { padding: 0 1rem 1rem 1rem; }
  .image-view img { max-width: 100%; height: auto; display: block; }
  .skip-list { list-style: none; padding-left: 0; margin: 0.25rem 0 0 0; }
  .skip-list li { margin: 0.15rem 0; }
  .skip-list code { background: transparent; padding: 0; border-radius: 0; }
  .error { color: #b00020; background: #fff3f3; padding: 0.75rem; border-radius: 4px; }

  :target { scroll-margin-top: 8px; }

${STARLIGHT_THEME_CSS}
</style>
</head>
<body>
<a id="top"></a>

<main class="container">

    <section class="meta-bar">
        <div class="meta">
        <div><strong>Repository:</strong> <a href="${escapeHtml(repoLabel)}">${escapeHtml(repoLabel)}</a></div>
        <small><strong>HEAD commit:</strong> ${escapeHtml(headCommit)}</small>
        <div class="counts">
            <strong>Total files:</strong> ${totalFiles} · <strong>Rendered:</strong> ${rendered.length} · <strong>Skipped:</strong> ${skippedBinary.length + skippedLargeData.length + skippedIgnored.length} · <strong>Size:</strong> ${renderedLineCount.toLocaleString()} lines
        </div>
        </div>
        <button id="auto-scroll-toggle" class="auto-scroll-button" type="button" aria-pressed="false">Start Auto Scroll</button>
    </section>

    ${skippedSection}

    ${sections.join("")}
</main>
<script>
(() => {
  const toggleButton = document.getElementById("auto-scroll-toggle");
  if (!toggleButton) return;

  const sectionButtons = Array.from(document.querySelectorAll(".file-scroll-button"));
  let frameId = null;
  const STEP_PX = 1.5;
  let internalScrollGuards = 0;

  const setRunningState = running => {
    toggleButton.textContent = running ? "Stop Auto Scroll" : "Start Auto Scroll";
    toggleButton.classList.toggle("active", running);
    toggleButton.setAttribute("aria-pressed", running ? "true" : "false");
  };

  setRunningState(false);

  const withInternalScroll = fn => {
    internalScrollGuards += 1;
    try {
      fn();
    } finally {
      requestAnimationFrame(() => {
        internalScrollGuards = Math.max(0, internalScrollGuards - 1);
      });
    }
  };

  const stop = () => {
    if (!frameId) return;
    cancelAnimationFrame(frameId);
    frameId = null;
    internalScrollGuards = 0;
    setRunningState(false);
  };

  const performScroll = () => {
    if (!frameId) return;
    const doc = document.documentElement;
    const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
    const current = window.scrollY || doc.scrollTop || 0;
    if (current >= maxScroll - 1) {
      withInternalScroll(() => window.scrollTo(0, 0));
    } else {
      withInternalScroll(() => window.scrollBy(0, STEP_PX));
    }
    frameId = requestAnimationFrame(performScroll);
  };

  const start = ({force = false, randomize = false} = {}) => {
    if (frameId && !force) return;
    if (randomize) {
      const doc = document.documentElement;
      const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
      if (maxScroll > 0) {
        const target = Math.random() * maxScroll;
        withInternalScroll(() => window.scrollTo(0, target));
      }
    }
    if (frameId && force) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    setRunningState(true);
    frameId = requestAnimationFrame(performScroll);
  };

  toggleButton.addEventListener("click", () => {
    if (frameId) {
      stop();
    } else {
      start({randomize: true});
    }
  });

  sectionButtons.forEach(button => {
    button.addEventListener("click", () => {
      start({force: true});
    });
  });

  window.addEventListener("scroll", () => {
    if (!frameId || internalScrollGuards > 0) return;
    stop();
  }, {passive: true});

  const controlTargets = new Set([...sectionButtons, toggleButton]);

  const isControl = target => {
    for (const element of controlTargets) {
      if (element && element.contains(target)) return true;
    }
    return false;
  };

  const stopOnPointer = event => {
    if (!frameId) return;
    if (isControl(event.target)) return;
    stop();
  };

  window.addEventListener("wheel", () => {
    if (!frameId) return;
    stop();
  }, {passive: true});

  window.addEventListener("touchstart", stopOnPointer, {passive: true});
  document.addEventListener("pointerdown", stopOnPointer, {passive: true});

  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "]);
  document.addEventListener("keydown", event => {
    if (!frameId) return;
    if (SCROLL_KEYS.has(event.key)) {
      stop();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    }
  });
})();
</script>
</body>
</html>`;
}

function resolveScope(highlighter, relPath) {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  const basename = path.basename(relPath).toLowerCase();
  const candidates = [];
  if (ext) {
    candidates.push(ext, `.${ext}`, `source.${ext}`, `text.${ext}`);
  }
  candidates.push(relPath.toLowerCase(), basename);
  for (const flag of candidates) {
    const scope = highlighter.flagToScope(flag);
    if (scope) return scope;
  }
  return null;
}

function parseArgs(argv) {
  const args = {repo: null, out: null, maxBytes: MAX_DEFAULT_BYTES, noOpen: false, sort: "age"};
  const queue = [...argv];
  while (queue.length > 0) {
    const token = queue.shift();
    if (token === "-o" || token === "--out") {
      const value = queue.shift();
      if (!value) throw new Error(`${token} requires a value`);
      args.out = value;
    } else if (token === "--max-bytes") {
      const value = queue.shift();
      if (!value) throw new Error("--max-bytes requires a value");
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) throw new Error("--max-bytes must be a positive number");
      args.maxBytes = num;
    } else if (token === "--sort" || token.startsWith("--sort=")) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : queue.shift();
      if (!value) throw new Error("--sort requires a value");
      if (value !== "age" && value !== "filename") throw new Error("--sort must be 'age' or 'filename'");
      args.sort = value;
    } else if (token === "--no-open") {
      args.noOpen = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (!args.repo) {
      args.repo = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  if (!args.repo) throw new Error("Repository path or URL is required");
  return args;
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("Usage: rendergit-js <repo> [-o output.html] [--max-bytes N] [--sort=age|filename] [--no-open]");
    process.exit(1);
    return;
  }

  const {mode, value} = resolveRepoSource(parsedArgs.repo);
  let repoDir;
  let tmpDir = null;
  let trackedFiles = null;
  let displayRepo;

  if (mode === "remote") {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flatten_repo_"));
    repoDir = path.join(tmpDir, "repo");
    console.error(`📁 Cloning ${value} to temporary directory: ${repoDir}`);
    await gitClone(value, repoDir);
    displayRepo = value;
  } else {
    repoDir = value;
    console.error(`📁 Using local repository directory: ${repoDir}`);
    trackedFiles = await gitLsFiles(repoDir);
    console.error(`🧾 git ls-files returned ${trackedFiles.length} entries`);
    displayRepo = path.resolve(repoDir);
  }

  const headCommit = await gitHeadCommit(repoDir);
  if (headCommit !== "(unknown)") {
    console.error(`✓ HEAD commit: ${headCommit.slice(0, 8)}`);
  } else {
    console.error("✓ HEAD commit: (unknown)");
  }

  if (!parsedArgs.out) {
    parsedArgs.out = deriveOutputPath(displayRepo);
  }

  const highlighter = await createStarryNight(all);

  if (trackedFiles) {
    console.error(`📊 Scanning tracked files in ${repoDir}...`);
  } else {
    console.error(`📊 Scanning files in ${repoDir}...`);
  }
  console.error(`↕️  Sorting mode: ${parsedArgs.sort === "age" ? "age (uses git history)" : "filename (lexicographic)"}`);
  const infos = await collectFiles(repoDir, parsedArgs.maxBytes, trackedFiles);
  const renderedCount = infos.filter(info => info.decision.include).length;
  const skippedCount = infos.length - renderedCount;
  console.error(`✓ Found ${infos.length} files total (${renderedCount} rendered, ${skippedCount} skipped)`);

  console.error("🔨 Generating HTML...");
  const html = await buildHtml(displayRepo, repoDir, headCommit, infos, highlighter, parsedArgs.sort);

  await fs.writeFile(parsedArgs.out, html, "utf8");
  const stat = await fs.stat(parsedArgs.out);
  console.error(`✓ Wrote ${stat.size.toLocaleString()} bytes to ${path.resolve(parsedArgs.out)}`);

  if (!parsedArgs.noOpen) {
    console.error(`🌐 Opening ${parsedArgs.out} in browser...`);
    await openInBrowser(parsedArgs.out);
  }

  if (tmpDir) {
    console.error(`🗑️  Cleaning up temporary directory: ${tmpDir}`);
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(`Unexpected error: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
