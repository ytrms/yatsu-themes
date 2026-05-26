import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = path.join(rootDir, "public");
const catalogPath = path.join(publicDir, "catalog.json");
const screenshotsDir = path.join(publicDir, "screenshots");
const sampleBooksDir = path.join(rootDir, "sample-books");
const themesDir = path.join(rootDir, "themes");
const force = process.argv.includes("--force");
const skipInitialBuild = process.argv.includes("--skip-initial-build");
const onlyThemeIds = process.argv
  .filter((argument) => argument.startsWith("--theme="))
  .map((argument) => argument.slice("--theme=".length).trim())
  .filter(Boolean);
const yatsuAppDir = path.resolve(process.env.YATSU_APP_DIR || path.join(rootDir, "..", "ebook-reader"));
const explicitAppUrl = process.env.YATSU_APP_URL || "";
const preferredAppPort = Number(process.env.YATSU_APP_PORT || 5174);
const screenshotViewport = {
  width: Number(process.env.YATSU_SCREENSHOT_WIDTH || 1280),
  height: Number(process.env.YATSU_SCREENSHOT_HEIGHT || 900)
};

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

  const pendingThemes = await getThemesWithPendingScreenshots(themes);

  if (!pendingThemes.length) {
    console.log("Screenshots are already up to date.");
    return;
  }

  const bookPaths = await getSampleBookPaths();

  await fs.mkdir(screenshotsDir, { recursive: true });

  const appServer = explicitAppUrl
    ? { url: explicitAppUrl.replace(/\/$/, ""), close: async () => undefined }
    : await startYatsuAppServer();
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      colorScheme: "light",
      deviceScaleFactor: 1,
      viewport: screenshotViewport
    });
    const assetMap = createAssetMap({ themes, bookPaths, appUrl: appServer.url });

    await context.route("**/__yatsu-theme-screenshot-assets/**", (route) =>
      fulfillAssetRoute(route, assetMap)
    );

    const page = await context.newPage();
    const pageErrors = [];

    page.on("pageerror", (error) => pageErrors.push(error));

    const { bookIds } = await seedYatsuFixture(page, {
      appUrl: appServer.url,
      bookAssets: assetMap.bookAssets
    });
    let screenshotCount = 0;

    for (const theme of pendingThemes) {
      await applyTheme(page, {
        appUrl: appServer.url,
        themeAsset: assetMap.themeAssets.get(theme.fileName),
        themeId: theme.id
      });

      if (theme.pendingViews.has("library")) {
        await captureLibraryScreenshot(page, {
          appUrl: appServer.url,
          bookCount: bookIds.length,
          path: path.join(screenshotsDir, `${theme.id}-library.png`)
        });
        screenshotCount += 1;
      }

      if (theme.pendingViews.has("reader")) {
        await captureReaderScreenshot(page, {
          appUrl: appServer.url,
          bookId: bookIds[0],
          path: path.join(screenshotsDir, `${theme.id}-reader.png`)
        });
        screenshotCount += 1;
      }
    }

    if (pageErrors.length) {
      throw new Error(`Yatsu app reported a page error: ${pageErrors[0].message}`);
    }

    await context.close();
    await runNodeScript("generate-catalog.mjs");
    console.log(`Generated ${screenshotCount} real Yatsu app screenshots.`);
  } finally {
    await browser.close().catch(() => undefined);
    await appServer.close();
  }
}

async function loadPlaywright() {
  const candidates = [
    "playwright",
    process.env.PLAYWRIGHT_MODULE_PATH,
    path.join(yatsuAppDir, "apps/web/node_modules/playwright/index.mjs"),
    path.join(yatsuAppDir, "node_modules/playwright/index.mjs")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return candidate === "playwright"
        ? await import(candidate)
        : await import(pathToFileURL(candidate).href);
    } catch {
      // Try the next local Playwright install before failing with a useful error.
    }
  }

  throw new Error(
    "Playwright is required for screenshot generation. Run npm install, set PLAYWRIGHT_MODULE_PATH, or point YATSU_APP_DIR at a Yatsu checkout with Playwright installed."
  );
}

async function getThemesWithPendingScreenshots(themes) {
  const pending = [];

  for (const theme of themes) {
    const pendingViews = new Set();

    for (const view of ["library", "reader"]) {
      const screenshotPath = path.join(screenshotsDir, `${theme.id}-${view}.png`);

      if (force || !(await fileExists(screenshotPath))) {
        pendingViews.add(view);
      }
    }

    if (pendingViews.size) {
      pending.push({
        ...theme,
        pendingViews
      });
    }
  }

  return pending;
}

async function getSampleBookPaths() {
  const epubPaths = await findFiles(sampleBooksDir, (filePath) => /\.epub$/i.test(filePath));

  if (!epubPaths.length) {
    throw new Error(`No sample EPUB files were found in ${sampleBooksDir}.`);
  }

  return epubPaths
    .sort((a, b) => a.localeCompare(b, "ja", { numeric: true }))
    .slice(0, Number(process.env.YATSU_SCREENSHOT_BOOK_LIMIT || 6));
}

function createAssetMap({ themes, bookPaths, appUrl }) {
  const files = new Map();
  const bookAssets = bookPaths.map((filePath, index) => {
    const name = path.basename(filePath).normalize("NFC");
    const key = `books/${index + 1}-${name}`;

    files.set(key, {
      contentType: "application/epub+zip",
      path: filePath
    });

    return {
      name,
      type: "application/epub+zip",
      url: assetUrl(appUrl, key)
    };
  });
  const themeAssets = new Map();

  for (const theme of themes) {
    const key = `themes/${theme.fileName}`;

    files.set(key, {
      contentType: "application/x-yatsu-theme",
      path: path.join(themesDir, theme.fileName)
    });

    themeAssets.set(theme.fileName, {
      name: theme.fileName,
      type: "application/x-yatsu-theme",
      url: assetUrl(appUrl, key)
    });
  }

  return {
    bookAssets,
    files,
    themeAssets
  };
}

function assetUrl(appUrl, key) {
  return `${appUrl}/__yatsu-theme-screenshot-assets/${key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

async function fulfillAssetRoute(route, assetMap) {
  const requestUrl = new URL(route.request().url());
  const key = decodeURIComponent(
    requestUrl.pathname.replace(/^\/__yatsu-theme-screenshot-assets\//, "")
  );
  const asset = assetMap.files.get(key);

  if (!asset) {
    await route.fulfill({
      body: "screenshot asset not found",
      contentType: "text/plain",
      status: 404
    });
    return;
  }

  await route.fulfill({
    contentType: asset.contentType,
    path: asset.path
  });
}

async function seedYatsuFixture(page, { appUrl, bookAssets }) {
  await page.goto(`${appUrl}/library`, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async ({ assets }) => {
    const [store, replicator, factory, storageTypes] = await Promise.all([
      import("/src/lib/data/store.ts"),
      import("/src/lib/functions/replication/replicator.ts"),
      import("/src/lib/data/storage/storage-handler-factory.ts"),
      import("/src/lib/data/storage/storage-types.ts")
    ]);

    applyStableScreenshotSettings(store);

    const files = await Promise.all(
      assets.map(async (asset) => {
        const response = await fetch(asset.url);

        if (!response.ok) {
          throw new Error(`Unable to fetch ${asset.name}: ${response.status}`);
        }

        return new File([await response.arrayBuffer()], asset.name, {
          type: asset.type
        });
      })
    );
    const handler = factory.getStorageHandler(window, storageTypes.StorageKey.BROWSER);
    const importResult = await replicator.importData(
      document,
      handler,
      files,
      new AbortController().signal
    );

    if (importResult.errorMessage) {
      throw new Error(importResult.errorMessage);
    }

    const books = await (await store.database.db).getAll("data");

    if (!books.length) {
      throw new Error("Yatsu imported no sample books.");
    }

    store.database.dataListChanged$.next(handler);

    return {
      bookIds: books.map((book) => book.id).filter((id) => Number.isFinite(id))
    };

    function applyStableScreenshotSettings(storeModule) {
      storeModule.followSystemTheme$.next(false);
      storeModule.reduceAnimations$.next(true);
      storeModule.cacheStorageData$.next(false);
      storeModule.showPageCounter$.next(true);
      storeModule.showPercentage$.next(true);
      storeModule.showCharacterCounter$.next(true);
      storeModule.showCurrentTime$.next(false);
      storeModule.showSessionReadingTime$.next(false);
      storeModule.viewMode$.next("paginated");
      storeModule.writingMode$.next("vertical-rl");
      storeModule.fontFamilyGroupOne$.next("Noto Serif JP");
      storeModule.fontFamilyGroupTwo$.next("Noto Sans JP");
      storeModule.fontWeightGroupOne$.next(400);
      storeModule.fontWeightGroupTwo$.next(400);
      storeModule.fontSize$.next(20);
      storeModule.lineHeight$.next(1.65);
      storeModule.textIndentation$.next(0);
      storeModule.textMarginValue$.next(0);
      storeModule.firstDimensionMargin$.next(0);
      storeModule.secondDimensionMaxValue$.next(0);
      storeModule.pageColumns$.next(0);
      storeModule.autoBookmark$.next(false);
      storeModule.manualBookmark$.next(true);
      storeModule.statisticsEnabled$.next(true);
      storeModule.highlightMenuRequiresKey$.next(false);
      storeModule.enableTapEdgeToFlip$.next(false);
      storeModule.readerControllerNavigationEnabled$.next(false);
    }
  }, { assets: bookAssets });

  await waitForLibrary(page, result.bookIds.length);

  return result;
}

async function applyTheme(page, { appUrl, themeAsset, themeId }) {
  if (!themeAsset) {
    throw new Error(`No asset was registered for theme ${themeId}.`);
  }

  await page.goto(`${appUrl}/library`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    async ({ asset, fallbackName }) => {
      const [store, themeImport] = await Promise.all([
        import("/src/lib/data/store.ts"),
        import("/src/lib/data/theme-import.ts")
      ]);

      resetStableThemeTypography(store);

      const response = await fetch(asset.url);

      if (!response.ok) {
        throw new Error(`Unable to fetch ${asset.name}: ${response.status}`);
      }

      const file = new File([await response.blob()], asset.name, {
        type: asset.type
      });
      const preparedImport = await themeImport.prepareThemeShareImportFromFile(file, {
        fallbackName,
        isSupporter: true
      });

      if (!preparedImport) {
        throw new Error(`Unable to import ${asset.name} as a Yatsu theme.`);
      }

      await themeImport.importPreparedThemeShare(preparedImport, {
        applyTheme: true,
        applyTypography: true,
        applyTarget: "manual"
      });
      store.followSystemTheme$.next(false);
      store.reduceAnimations$.next(true);

      function resetStableThemeTypography(storeModule) {
        storeModule.fontFamilyGroupOne$.next("Noto Serif JP");
        storeModule.fontFamilyGroupTwo$.next("Noto Sans JP");
        storeModule.fontWeightGroupOne$.next(400);
        storeModule.fontWeightGroupTwo$.next(400);
        storeModule.fontSize$.next(20);
      }
    },
    { asset: themeAsset, fallbackName: themeId }
  );
}

async function paintReaderHighlight(page, { bookId }) {
  await page.evaluate(async ({ currentBookId }) => {
    const [highlightManager, store] = await Promise.all([
      import("/src/lib/components/book-reader/highlight-manager.ts"),
      import("/src/lib/data/store.ts")
    ]);
    const content = getVisibleReaderContent();
    const range = getReadableRange(content, { minimumOffset: 40, preferredLength: 18 });
    const snapshot = highlightManager.getHighlightSnapshotForRange(content, range);
    const book = await store.database.getData(currentBookId);

    if (!snapshot || !book) {
      throw new Error("Unable to create the reader screenshot highlight.");
    }

    const highlight = {
      ...snapshot,
      bookTitle: book.title,
      color: "yellow",
      dataId: currentBookId,
      dateCreated: Date.now(),
      id: 9001,
      note: "Screenshot fixture highlight"
    };
    const result = highlightManager.applyHighlights(content, [highlight]);

    if (!result.resolvedHighlights.length || !content.querySelector("mark.ttu-highlight")) {
      throw new Error("Unable to paint the reader screenshot highlight.");
    }

    function getVisibleReaderContent() {
      const content = document.querySelector(".book-content:not(.book-content-page-measure)");

      if (!(content instanceof HTMLElement)) {
        throw new Error("Visible reader content was not found.");
      }

      return content;
    }

    function getReadableRange(root, { minimumOffset, preferredLength }) {
      const textNodes = getReadableTextNodes(root);
      let offset = 0;

      for (let index = 0; index < textNodes.length; index += 1) {
        const node = textNodes[index];
        const text = node.textContent || "";
        const start = findReadableStart(text, offset >= minimumOffset ? 0 : minimumOffset - offset);

        offset += text.length;

        if (start === -1) {
          continue;
        }

        const range = buildRangeFromTextNodes(textNodes, index, start, preferredLength);

        if (range && (range.getBoundingClientRect().width || range.getBoundingClientRect().height)) {
          return range;
        }
      }

      throw new Error("Unable to find selectable Japanese reader text.");
    }

    function getReadableTextNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          const text = node.textContent || "";

          if (
            !parent ||
            parent.closest("script, style, rt, mark") ||
            !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];

      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }

      return nodes;
    }

    function buildRangeFromTextNodes(textNodes, startIndex, startOffset, preferredLength) {
      const range = document.createRange();
      let remaining = preferredLength;

      range.setStart(textNodes[startIndex], startOffset);

      for (let index = startIndex; index < textNodes.length; index += 1) {
        const node = textNodes[index];
        const text = node.textContent || "";
        const localStart = index === startIndex ? startOffset : 0;
        const available = Math.max(0, text.length - localStart);

        if (!available) {
          continue;
        }

        if (available >= remaining) {
          range.setEnd(node, localStart + remaining);
          return range;
        }

        remaining -= available;
      }

      return undefined;
    }

    function findReadableStart(text, minimumStart) {
      for (let index = Math.max(0, minimumStart); index < text.length; index += 1) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text[index])) {
          return index;
        }
      }

      return -1;
    }
  }, { currentBookId: bookId });
}

async function captureLibraryScreenshot(page, { appUrl, bookCount, path: screenshotPath }) {
  await page.goto(`${appUrl}/library`, { waitUntil: "domcontentloaded" });
  await waitForLibrary(page, bookCount);
  await settlePageAssets(page);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: screenshotPath
  });
}

async function captureReaderScreenshot(page, { appUrl, bookId, path: screenshotPath }) {
  await page.goto(`${appUrl}/b?id=${bookId}`, { waitUntil: "domcontentloaded" });
  await waitForReaderContent(page);
  await advanceReaderToReadablePage(page);
  await paintReaderHighlight(page, { bookId });
  await selectReaderText(page);
  await settlePageAssets(page);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: screenshotPath
  });
}

async function waitForLibrary(page, bookCount) {
  await page.waitForSelector('[aria-label="Book library"]', { timeout: 60_000 });
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll("[data-library-book-card-id]").length >= expectedCount ||
      document.querySelectorAll("[data-book-card-button]").length >= expectedCount,
    bookCount,
    { timeout: 60_000 }
  );
}

async function waitForReaderContent(page) {
  await page.waitForSelector(".book-content:not(.book-content-page-measure)", {
    timeout: 60_000
  });
  await page.waitForFunction(
    () => {
      const content = document.querySelector(".book-content:not(.book-content-page-measure)");
      const footer = document.querySelector("#ttu-page-footer");

      return Boolean(content && footer && !footer.textContent?.includes("Calculating pages"));
    },
    undefined,
    { timeout: 60_000 }
  );
}

async function advanceReaderToReadablePage(page) {
  for (let index = 0; index < 45; index += 1) {
    const state = await page.evaluate(() => {
      const content = document.querySelector(".book-content:not(.book-content-page-measure)");
      const text = (content?.textContent || "").replace(/\s+/g, "");

      return {
        hasReadableText:
          text.length >= 80 &&
          text.includes("。") &&
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text),
        textLength: text.length
      };
    });

    if (state.hasReadableText) {
      return;
    }

    await page.keyboard.press("PageDown");
    await page.waitForTimeout(250);
  }

  throw new Error("Unable to advance the real reader to a readable text page.");
}

async function selectReaderText(page) {
  await page.evaluate(() => {
    const content = document.querySelector(".book-content:not(.book-content-page-measure)");

    if (!(content instanceof HTMLElement)) {
      throw new Error("Visible reader content was not found.");
    }

    const range = getReadableRange(content, {
      minimumOffset: 0,
      preferredLength: 10
    });
    const selection = window.getSelection();

    selection?.removeAllRanges();
    selection?.addRange(range);

    function getReadableRange(root, { minimumOffset, preferredLength }) {
      const textNodes = getReadableTextNodes(root);
      let offset = 0;

      for (let index = 0; index < textNodes.length; index += 1) {
        const node = textNodes[index];
        const text = node.textContent || "";
        const start = findReadableStart(text, offset >= minimumOffset ? 0 : minimumOffset - offset);

        offset += text.length;

        if (start === -1) {
          continue;
        }

        const range = buildRangeFromTextNodes(textNodes, index, start, preferredLength);

        if (range && (range.getBoundingClientRect().width || range.getBoundingClientRect().height)) {
          return range;
        }
      }

      throw new Error("Unable to find selectable Japanese reader text.");
    }

    function getReadableTextNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          const text = node.textContent || "";

          if (
            !parent ||
            parent.closest("script, style, rt") ||
            !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];

      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }

      return nodes;
    }

    function buildRangeFromTextNodes(textNodes, startIndex, startOffset, preferredLength) {
      const range = document.createRange();
      let remaining = preferredLength;

      range.setStart(textNodes[startIndex], startOffset);

      for (let index = startIndex; index < textNodes.length; index += 1) {
        const node = textNodes[index];
        const text = node.textContent || "";
        const localStart = index === startIndex ? startOffset : 0;
        const available = Math.max(0, text.length - localStart);

        if (!available) {
          continue;
        }

        if (available >= remaining) {
          range.setEnd(node, localStart + remaining);
          return range;
        }

        remaining -= available;
      }

      return undefined;
    }

    function findReadableStart(text, minimumStart) {
      for (let index = Math.max(0, minimumStart); index < text.length; index += 1) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text[index])) {
          return index;
        }
      }

      return -1;
    }
  });
}

async function settlePageAssets(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((image) => !image.complete)
        .map(
          (image) =>
            new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            })
        )
    );
  });
  await page.waitForTimeout(350);
}

async function startYatsuAppServer() {
  const port = await getFreePort(preferredAppPort);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "pnpm",
    ["--filter", "web", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: yatsuAppDir,
      env: {
        ...process.env,
        BROWSER: "none"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let log = "";

  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });

  try {
    await waitForHttp(`${url}/library`, child, () => log);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    url,
    close: async () => {
      if (child.exitCode !== null || child.signalCode) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  };
}

async function waitForHttp(url, child, getLog) {
  const startedAt = Date.now();
  let processExit;

  child.once("exit", (code, signal) => {
    processExit = { code, signal };
  });

  while (Date.now() - startedAt < 60_000) {
    if (processExit) {
      throw new Error(
        `Yatsu dev server exited before it was ready (${processExit.signal || processExit.code}).\n${getLog()}`
      );
    }

    try {
      const response = await fetch(url, { method: "HEAD" });

      if (response.ok) {
        return;
      }
    } catch {
      // Wait for Vite to finish starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for Yatsu dev server at ${url}.\n${getLog()}`);
}

async function getFreePort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    if (await portIsFree(port)) {
      return port;
    }
  }

  throw new Error(`Unable to find a free port starting at ${preferredPort}.`);
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function runNodeScript(scriptName) {
  const child = spawn(process.execPath, [path.join(rootDir, "scripts", scriptName)], {
    cwd: rootDir,
    stdio: "inherit"
  });

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${scriptName} exited with ${signal || code}.`));
    });
  });
}

async function findFiles(dir, predicate) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findFiles(filePath, predicate)));
    } else if (entry.isFile() && predicate(filePath)) {
      files.push(filePath);
    }
  }

  return files;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
