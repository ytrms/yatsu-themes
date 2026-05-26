import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import zlib from "node:zlib";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = path.join(rootDir, "public");
const catalogPath = path.join(publicDir, "catalog.json");
const screenshotsDir = path.join(publicDir, "screenshots");
const sampleBooksDir = path.join(rootDir, "sample-books");
const force = process.argv.includes("--force");
const skipInitialBuild = process.argv.includes("--skip-initial-build");
const onlyThemeIds = process.argv
  .filter((argument) => argument.startsWith("--theme="))
  .map((argument) => argument.slice("--theme=".length).trim())
  .filter(Boolean);

await main();

async function main() {
  const { chromium } = await loadPlaywright();

  if (!skipInitialBuild) {
    await runNodeScript("generate-catalog.mjs");
  }

  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  const themes = onlyThemeIds.length
    ? catalog.themes.filter((theme) => onlyThemeIds.includes(theme.id))
    : catalog.themes;

  if (!themes.length) {
    throw new Error("No matching themes found for screenshot generation.");
  }

  const books = await loadSampleBooks();

  await fs.mkdir(screenshotsDir, { recursive: true });

  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: {
        width: 1200,
        height: 800
      }
    });

    for (const theme of themes) {
      await captureThemeScreenshot(page, theme, books, "library");
      await captureThemeScreenshot(page, theme, books, "reader");
    }
  } finally {
    await browser.close();
  }

  await runNodeScript("generate-catalog.mjs");
  console.log(`Generated ${themes.length * 2} screenshots for ${themes.length} themes.`);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const explicitPath = process.env.PLAYWRIGHT_MODULE_PATH;

    if (explicitPath) {
      return await import(pathToFileURL(explicitPath).href);
    }

    throw new Error(
      `Playwright is required for screenshot generation. Run npm install first. Original error: ${error.message}`
    );
  }
}

async function captureThemeScreenshot(page, theme, books, view) {
  const screenshotPath = path.join(screenshotsDir, `${theme.id}-${view}.png`);

  if (!force && (await fileExists(screenshotPath))) {
    return;
  }

  await page.setContent(createScreenshotHtml(theme, books, view), {
    waitUntil: "load"
  });
  await page.evaluate(() => document.fonts?.ready);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: screenshotPath
  });
}

async function loadSampleBooks() {
  const epubPaths = await findFiles(sampleBooksDir, (filePath) => /\.epub$/i.test(filePath));
  const books = [];

  for (const epubPath of epubPaths.sort((a, b) => a.localeCompare(b, "ja", { numeric: true }))) {
    books.push(await parseEpubBook(epubPath));
  }

  return books.length ? books.slice(0, 6) : fallbackBooks();
}

async function parseEpubBook(epubPath) {
  const buffer = await fs.readFile(epubPath);
  const files = readZipEntries(buffer);
  const fallbackTitle = path.basename(epubPath, path.extname(epubPath)).normalize("NFC").replace(/_/g, " ");
  const fallbackAuthor = path.basename(path.dirname(epubPath)).normalize("NFC");
  const container = files.get("META-INF/container.xml")?.data.toString("utf8") || "";
  const opfPath = decodeXmlEntities(readAttribute(container, "rootfile", "full-path"));
  const opf = opfPath ? files.get(opfPath)?.data.toString("utf8") || "" : "";
  const opfDir = opfPath ? path.posix.dirname(opfPath) : "";
  const title = decodeXmlEntities(readTagText(opf, "dc:title")) || fallbackTitle;
  const author = decodeXmlEntities(readTagText(opf, "dc:creator")) || fallbackAuthor;
  const cover = getEpubCoverDataUrl(files, opf, opfDir);

  return {
    title,
    author,
    cover
  };
}

function getEpubCoverDataUrl(files, opf, opfDir) {
  const coverId =
    readNamedMetaContent(opf, "cover") ||
    readItemAttribute(opf, "properties", "cover-image", "id");
  const coverHref = coverId ? readItemByIdAttribute(opf, coverId, "href") : "";
  const fallbackImageHref = readFirstImageHref(opf);
  const href = coverHref || fallbackImageHref;

  if (!href) {
    return "";
  }

  const imagePath = normalizeZipPath(path.posix.join(opfDir, href));
  const image = files.get(imagePath);

  if (!image) {
    return "";
  }

  return `data:${getImageMediaType(imagePath)};base64,${image.data.toString("base64")}`;
}

function createScreenshotHtml(theme, books, view) {
  const content = view === "reader" ? readerScene(theme, books[0]) : libraryScene(books);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      ${screenshotCss(theme.theme)}
    </style>
  </head>
  <body>
    <main class="screenshot-root" data-view="${view}">
      ${appHeader()}
      ${content}
    </main>
  </body>
</html>`;
}

function appHeader() {
  return `<header class="app-header">
    <div class="app-logo">ッ</div>
    <div class="app-title">Yatsu</div>
    <nav class="app-actions">
      <span>Library</span>
      <span>Settings</span>
      <span>Account</span>
    </nav>
  </header>`;
}

function libraryScene(books) {
  return `<section class="library-layout">
    <aside class="library-sidebar">
      <div class="sidebar-heading">Library</div>
      <div class="sidebar-row is-active">All books <span>${books.length}</span></div>
      <div class="sidebar-row">Reading <span>2</span></div>
      <div class="sidebar-row">Unread <span>4</span></div>
      <div class="sidebar-row">Completed <span>0</span></div>
      <div class="sidebar-heading">Authors</div>
      <div class="sidebar-row">${escapeHtml(books[0]?.author || "Unknown")}</div>
    </aside>
    <section class="library-main">
      <div class="library-toolbar">
        <div>
          <p class="eyebrow">Library</p>
          <h1>Sample books</h1>
        </div>
        <div class="search-pill">Search library</div>
      </div>
      <div class="book-grid">
        ${books.map((book, index) => bookCard(book, index)).join("")}
      </div>
    </section>
  </section>`;
}

function bookCard(book, index) {
  return `<article class="book-card">
    ${book.cover ? `<img src="${book.cover}" alt="" />` : `<div class="generated-cover">${index + 1}</div>`}
    <h2>${escapeHtml(book.title)}</h2>
    <p>${escapeHtml(book.author)}</p>
    <div class="progress">
      <span style="width: ${Math.min(88, 18 + index * 12)}%"></span>
    </div>
  </article>`;
}

function readerScene(theme, book) {
  const title = book?.title || "Sample Book";
  const author = book?.author || "Yatsu";

  return `<section class="reader-layout">
    <div class="reader-page">
      <header class="reader-toolbar">
        <div>
          <p>${escapeHtml(author)}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <span>Page 12 of 48</span>
      </header>
      <article class="reader-copy" lang="ja">
        <p><ruby>吾輩<rt>わがはい</rt></ruby>は猫である。名前はまだ無い。</p>
        <p>どこで生れたかとんと見当がつかぬ。</p>
        <p>
          何でも
          <span class="highlight yellow">薄暗いじめじめした所</span>
          で泣いていた事だけは記憶している。
        </p>
        <p>
          <span class="selected-text">青い空の下で、物語は静かに続いていく。</span>
        </p>
        <p>
          この小さな読書画面で、文字色、選択色、
          <span class="highlight blue">ハイライト</span>
          と余白の見え方を確かめられる。
        </p>
      </article>
      <footer class="reader-footer">
        <span>Saved</span>
        <span>Chapter 1</span>
      </footer>
    </div>
  </section>`;
}

function screenshotCss(theme) {
  const colors = {
    font: theme.fontColor,
    background: theme.backgroundColor,
    accent: theme.accentColor,
    accentText: theme.accentTextColor,
    muted: theme.mutedTextColor,
    chrome: theme.readerChromeBackgroundColor,
    border: theme.readerChromeBorderColor,
    selection: theme.selectionBackgroundColor,
    selectionText: theme.selectionFontColor,
    footer: theme.tooltipTextFontColor,
    yellow: theme.highlightYellowColor,
    blue: theme.highlightBlueColor
  };

  return `
    :root {
      --font: ${colors.font};
      --background: ${colors.background};
      --accent: ${colors.accent};
      --accent-text: ${colors.accentText};
      --muted: ${colors.muted};
      --chrome: ${colors.chrome};
      --border: ${colors.border};
      --selection: ${colors.selection};
      --selection-text: ${colors.selectionText};
      --footer: ${colors.footer};
      --highlight-yellow: ${colors.yellow};
      --highlight-blue: ${colors.blue};
      color: var(--font);
      background: var(--background);
      font-family: "SN Pro", "Noto Sans JP", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body { background: var(--background); }
    .screenshot-root {
      background:
        radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--font) 7%, transparent) 1px, transparent 0) 0 0 / 22px 22px,
        var(--background);
      color: var(--font);
      height: 800px;
      overflow: hidden;
      padding: 28px;
      width: 1200px;
    }
    .app-header {
      align-items: center;
      background: var(--chrome);
      border: 1px solid var(--border);
      border-radius: 22px;
      display: flex;
      gap: 16px;
      min-height: 64px;
      padding: 10px 14px;
      box-shadow: 0 22px 42px -32px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.12);
    }
    .app-logo {
      align-items: center;
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
      border-radius: 14px;
      color: var(--accent);
      display: flex;
      font-size: 26px;
      font-weight: 850;
      height: 44px;
      justify-content: center;
      width: 44px;
    }
    .app-title { font-size: 24px; font-weight: 780; margin-right: auto; }
    .app-actions { display: flex; gap: 10px; }
    .app-actions span {
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--footer);
      font-size: 15px;
      font-weight: 750;
      padding: 10px 16px;
    }
    .library-layout {
      display: grid;
      gap: 24px;
      grid-template-columns: 240px minmax(0, 1fr);
      height: calc(100% - 88px);
      padding-top: 24px;
    }
    .library-sidebar,
    .library-main,
    .reader-page {
      background: color-mix(in srgb, var(--font) 5%, transparent);
      border: 1px solid color-mix(in srgb, var(--font) 12%, transparent);
      border-radius: 22px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .library-sidebar {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 18px;
    }
    .sidebar-heading,
    .eyebrow {
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0;
      margin: 0;
      text-transform: uppercase;
    }
    .sidebar-row {
      align-items: center;
      border-radius: 14px;
      color: var(--font);
      display: flex;
      font-size: 17px;
      font-weight: 720;
      justify-content: space-between;
      padding: 12px 14px;
    }
    .sidebar-row.is-active {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--accent);
    }
    .library-main { padding: 24px; }
    .library-toolbar {
      align-items: center;
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    h1 { font-size: 34px; line-height: 1.1; margin: 4px 0 0; }
    .search-pill {
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      font-size: 16px;
      font-weight: 720;
      padding: 12px 18px;
      width: 220px;
    }
    .book-grid {
      display: grid;
      gap: 22px;
      grid-template-columns: repeat(6, minmax(0, 1fr));
    }
    .book-card {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .book-card img,
    .generated-cover {
      aspect-ratio: 5 / 7;
      background: linear-gradient(150deg, color-mix(in srgb, var(--accent) 42%, transparent), color-mix(in srgb, var(--font) 8%, var(--background)));
      border: 1px solid color-mix(in srgb, var(--font) 16%, transparent);
      border-radius: 12px;
      box-shadow: 0 14px 24px -20px rgba(0, 0, 0, 0.7);
      display: block;
      object-fit: cover;
      width: 100%;
    }
    .generated-cover {
      align-items: center;
      color: var(--accent);
      display: flex;
      font-size: 40px;
      font-weight: 850;
      justify-content: center;
    }
    .book-card h2 {
      font-size: 15px;
      font-weight: 780;
      line-height: 1.25;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .book-card p {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .progress {
      background: color-mix(in srgb, var(--font) 12%, transparent);
      border-radius: 999px;
      height: 6px;
      overflow: hidden;
    }
    .progress span {
      background: var(--accent);
      border-radius: inherit;
      display: block;
      height: 100%;
    }
    .reader-layout {
      display: grid;
      height: calc(100% - 88px);
      padding-top: 24px;
      place-items: center;
    }
    .reader-page {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      height: 100%;
      max-width: 760px;
      padding: 34px 42px 24px;
      width: 100%;
    }
    .reader-toolbar,
    .reader-footer {
      align-items: center;
      color: var(--footer);
      display: flex;
      font-size: 15px;
      font-weight: 760;
      justify-content: space-between;
    }
    .reader-toolbar p {
      color: var(--muted);
      font-size: 13px;
      margin: 0 0 4px;
      text-transform: uppercase;
    }
    .reader-toolbar h1 {
      font-size: 22px;
      max-width: 520px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .reader-copy {
      align-content: center;
      display: grid;
      font-family: "Noto Serif JP", serif;
      font-size: 29px;
      font-weight: 540;
      gap: 18px;
      line-height: 1.72;
      overflow: hidden;
      padding: 28px 0;
    }
    .reader-copy p { margin: 0; }
    rt { color: color-mix(in srgb, var(--font) 42%, transparent); font-size: 0.46em; }
    .highlight {
      border-radius: 0.2em;
      padding: 0 0.08em;
    }
    .highlight.yellow { background: var(--highlight-yellow); }
    .highlight.blue { background: var(--highlight-blue); }
    .selected-text {
      background: var(--selection);
      border-radius: 8px;
      color: var(--selection-text);
      padding: 0.14em 0.28em;
    }
  `;
}

async function findFiles(root, predicate) {
  const result = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      result.push(...(await findFiles(entryPath, predicate)));
    } else if (entry.isFile() && predicate(entryPath)) {
      result.push(entryPath);
    }
  }

  return result;
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);

  if (eocdOffset < 0) {
    throw new Error("Not a zip file.");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const files = new Map();
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid zip central directory.");
    }

    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileName = buffer
      .subarray(fileNameStart, fileNameStart + fileNameLength)
      .toString("utf8");

    if (!fileName.endsWith("/")) {
      files.set(fileName, {
        data: readZipEntryData(buffer, {
          compression,
          compressedSize,
          localHeaderOffset
        })
      });
    }

    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  return files;
}

function readZipEntryData(buffer, { compression, compressedSize, localHeaderOffset }) {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error("Invalid zip local header.");
  }

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

  if (compression === 0) {
    return Buffer.from(compressed);
  }

  if (compression === 8) {
    return zlib.inflateRawSync(compressed);
  }

  throw new Error(`Unsupported zip compression method ${compression}.`);
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);

  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function readTagText(xml, tagName) {
  return xml.match(new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(tagName)}>`, "i"))?.[1]?.trim() || "";
}

function readAttribute(xml, tagName, attributeName) {
  const tag = xml.match(new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, "i"))?.[0] || "";

  return readAttributeFromTag(tag, attributeName);
}

function readNamedMetaContent(xml, name) {
  for (const tag of xml.match(/<meta\b[^>]*>/gi) || []) {
    if (readAttributeFromTag(tag, "name") === name) {
      return readAttributeFromTag(tag, "content");
    }
  }

  return "";
}

function readItemAttribute(xml, attributeName, attributeValue, targetAttribute) {
  for (const tag of xml.match(/<item\b[^>]*>/gi) || []) {
    const value = readAttributeFromTag(tag, attributeName);

    if (value.split(/\s+/).includes(attributeValue)) {
      return readAttributeFromTag(tag, targetAttribute);
    }
  }

  return "";
}

function readItemByIdAttribute(xml, id, targetAttribute) {
  for (const tag of xml.match(/<item\b[^>]*>/gi) || []) {
    if (readAttributeFromTag(tag, "id") === id) {
      return readAttributeFromTag(tag, targetAttribute);
    }
  }

  return "";
}

function readFirstImageHref(xml) {
  for (const tag of xml.match(/<item\b[^>]*>/gi) || []) {
    if (/^image\//.test(readAttributeFromTag(tag, "media-type"))) {
      return readAttributeFromTag(tag, "href");
    }
  }

  return "";
}

function readAttributeFromTag(tag, attributeName) {
  return (
    tag.match(new RegExp(`${escapeRegExp(attributeName)}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ||
    tag.match(new RegExp(`${escapeRegExp(attributeName)}\\s*=\\s*'([^']*)'`, "i"))?.[1] ||
    ""
  );
}

function normalizeZipPath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function getImageMediaType(filePath) {
  if (/\.png$/i.test(filePath)) {
    return "image/png";
  }

  if (/\.webp$/i.test(filePath)) {
    return "image/webp";
  }

  return "image/jpeg";
}

function fallbackBooks() {
  return [
    { title: "吾輩は猫である", author: "夏目漱石", cover: "" },
    { title: "坊っちゃん", author: "夏目漱石", cover: "" },
    { title: "こころ", author: "夏目漱石", cover: "" },
    { title: "銀河鉄道の夜", author: "宮沢賢治", cover: "" }
  ];
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runNodeScript(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, "scripts", scriptName)], {
      cwd: rootDir,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptName} exited with code ${code}`));
      }
    });
  });
}
