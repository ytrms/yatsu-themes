import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = path.join(rootDir, "docs");
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
const validScreenshotViews = new Set(["library", "reader"]);
const onlyViews = new Set(
  process.argv
    .filter((argument) => argument.startsWith("--view="))
    .flatMap((argument) => argument.slice("--view=".length).split(","))
    .map((view) => view.trim())
    .filter(Boolean)
);
for (const view of onlyViews) {
  if (!validScreenshotViews.has(view)) {
    throw new Error(`Unsupported screenshot view "${view}". Use "library" or "reader".`);
  }
}
const yatsuAppDir = path.resolve(process.env.YATSU_APP_DIR || path.join(rootDir, "..", "ebook-reader"));
const explicitAppUrl = process.env.YATSU_APP_URL || "";
const preferredAppPort = Number(process.env.YATSU_APP_PORT || 5174);
const screenshotViewport = {
  width: Number(process.env.YATSU_SCREENSHOT_WIDTH || 1280),
  height: Number(process.env.YATSU_SCREENSHOT_HEIGHT || 900)
};
const screenshotImageExtension = "jpg";
const screenshotImageType = "jpeg";
const screenshotJpegQuality = clampInteger(Number(process.env.YATSU_SCREENSHOT_JPEG_QUALITY || 86), {
  fallback: 86,
  max: 100,
  min: 1
});
const screenshotAccountState = {
  auth: {
    isConfigured: true,
    user: {
      id: "yatsu-theme-screenshot-user",
      email: "theme-screenshots@yatsu.local",
      signInProvider: "screenshot",
      username: "trms"
    }
  },
  billing: {
    stripeConfigured: false,
    supporterCheckoutConfigured: false,
    databaseConfigured: true,
    schemaReady: true,
    setupMessage: null,
    supporter: {
      activatedAt: "2026-01-01T00:00:00.000Z",
      isActive: true,
      status: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      entitlements: []
    }
  },
  presentationUser: {
    id: "yatsu-theme-screenshot-user",
    label: "trms",
    username: "trms",
    plan: "supporter"
  },
  sessionLikely: true,
  loaded: true,
  loading: false,
  error: null
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

    await context.route("**/api/account/state", fulfillScreenshotAccountStateRoute);
    await context.route("**/__yatsu-theme-screenshot-assets/**", (route) =>
      fulfillAssetRoute(route, assetMap)
    );
    await context.addInitScript(seedScreenshotAccountStateStorage, screenshotAccountState);

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
          path: getScreenshotPath(theme.id, "library"),
          theme
        });
        screenshotCount += 1;
      }

      if (theme.pendingViews.has("reader")) {
        await captureReaderScreenshot(page, {
          appUrl: appServer.url,
          bookId: bookIds[0],
          path: getScreenshotPath(theme.id, "reader"),
          theme
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

    for (const view of validScreenshotViews) {
      if (onlyViews.size && !onlyViews.has(view)) {
        continue;
      }

      const screenshotPath = getScreenshotPath(theme.id, view);

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
  await enableScreenshotSupporterMode(page);

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
  await enableScreenshotSupporterMode(page);
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

async function paintReaderHighlights(page, { bookId, keepHighlightsRight = true }) {
  await page.evaluate(async ({ currentBookId, shouldKeepHighlightsRight }) => {
    const [highlightManager, highlightColorData, store] = await Promise.all([
      import("/src/lib/components/book-reader/highlight-manager.ts"),
      import("/src/lib/data/highlight-colors.ts"),
      import("/src/lib/data/store.ts")
    ]);
    const content = getVisibleReaderContent();
    const colorIds = highlightColorData.highlightColors.map((color) => color.id);
    const minimumLeft = getReaderVisibleLeftBound(shouldKeepHighlightsRight);
    const snapshots = getReadableHighlightSnapshots(content, {
      colorCount: colorIds.length,
      highlightManager,
      keepHighlightsRight: shouldKeepHighlightsRight,
      minimumLeft,
      minimumReadableLength: 3,
      preferredLength: 7
    });
    const book = await store.database.getData(currentBookId);

    if (snapshots.length !== colorIds.length || !book) {
      throw new Error("Unable to create all reader screenshot highlights.");
    }

    const highlights = snapshots.map((snapshot, index) => ({
      ...snapshot,
      bookTitle: book.title,
      color: colorIds[index],
      dataId: currentBookId,
      dateCreated: Date.now(),
      id: 9001 + index,
      note: `Screenshot fixture ${colorIds[index]} highlight`
    }));
    const result = highlightManager.applyHighlights(content, highlights);

    const renderedHighlightIds = getVisibleRenderedHighlightIds(content, minimumLeft);

    if (
      result.resolvedHighlights.length !== colorIds.length ||
      renderedHighlightIds.size < colorIds.length
    ) {
      throw new Error("Unable to paint all reader screenshot highlights.");
    }

    function getVisibleReaderContent() {
      const content = document.querySelector(".book-content:not(.book-content-page-measure)");

      if (!(content instanceof HTMLElement)) {
        throw new Error("Visible reader content was not found.");
      }

      return content;
    }

    function getReaderVisibleLeftBound(keepRight) {
      if (!keepRight) {
        return Math.max(72, window.innerWidth * 0.18);
      }

      return Math.min(window.innerWidth - 160, Math.max(360, window.innerWidth * 0.48));
    }

    function getReadableHighlightSnapshots(root, options) {
      let selectedCandidates = [];
      const attempts = [options.minimumLeft, 0];

      for (const minimumLeft of attempts) {
        const candidates = collectReadableHighlightCandidates(root, {
          ...options,
          minimumLeft
        });
        selectedCandidates = selectSpreadHighlightCandidates(candidates, {
          colorCount: options.colorCount,
          keepHighlightsRight: options.keepHighlightsRight,
          minimumLeft
        });

        if (selectedCandidates.length >= options.colorCount) {
          return selectedCandidates.map((candidate) => candidate.snapshot);
        }
      }

      return selectedCandidates.map((candidate) => candidate.snapshot);
    }

    function collectReadableHighlightCandidates(
      root,
      { highlightManager, minimumLeft, minimumReadableLength, preferredLength }
    ) {
      const candidates = [];
      const textNodes = getReadableTextNodes(root);

      for (let index = 0; index < textNodes.length; index += 1) {
        const node = textNodes[index];
        const text = node.textContent || "";
        let start = findReadableStart(text, 0);

        while (start !== -1) {
          const range = buildRangeFromTextNodes(textNodes, index, start, preferredLength);
          const rect = range ? getSingleClientRect(range) : undefined;

          if (
            range &&
            getReadableCharacterCount(range.toString()) >= minimumReadableLength &&
            rect &&
            isUsefulReadableRect(rect, minimumLeft)
          ) {
            const snapshot = highlightManager.getHighlightSnapshotForRange(root, range);

            if (snapshot) {
              candidates.push({
                centerX: rect.left + rect.width / 2,
                centerY: rect.top + rect.height / 2,
                rect: snapshotRect(rect),
                snapshot
              });
            }
          }

          start = findReadableStart(text, start + preferredLength + 4);
        }
      }

      return candidates;
    }

    function selectSpreadHighlightCandidates(candidates, { colorCount, keepHighlightsRight, minimumLeft }) {
      const targets = getHighlightTargetCenters({ colorCount, keepHighlightsRight, minimumLeft });
      const selected = [];

      for (const target of targets) {
        const candidate = getBestHighlightCandidate(candidates, {
          selected,
          target
        });

        if (candidate) {
          selected.push(candidate);
        }
      }

      return selected;
    }

    function getHighlightTargetCenters({ colorCount, keepHighlightsRight, minimumLeft }) {
      const maxTarget = window.innerWidth - 72;
      const minTarget = Math.min(
        maxTarget - 40,
        keepHighlightsRight
          ? Math.max(minimumLeft + 84, window.innerWidth * 0.56)
          : Math.max(minimumLeft + 40, window.innerWidth * 0.28)
      );

      if (colorCount <= 1) {
        return [(minTarget + maxTarget) / 2];
      }

      return Array.from(
        { length: colorCount },
        (_, index) => maxTarget - ((maxTarget - minTarget) * index) / (colorCount - 1)
      );
    }

    function getBestHighlightCandidate(candidates, { selected, target }) {
      let bestCandidate;
      let bestScore = Infinity;

      for (const candidate of candidates) {
        if (overlapsSelectedCandidate(candidate, selected)) {
          continue;
        }

        const nearbySelectedPenalty = selected.some(
          (selectedCandidate) => Math.abs(selectedCandidate.centerX - candidate.centerX) < 72
        )
          ? 192
          : 0;
        const score =
          Math.abs(candidate.centerX - target) +
          Math.abs(candidate.centerY - window.innerHeight * 0.5) * 0.08 +
          nearbySelectedPenalty;

        if (score < bestScore) {
          bestCandidate = candidate;
          bestScore = score;
        }
      }

      return bestCandidate;
    }

    function isUsefulReadableRect(rect, minimumLeft) {
      if (!rect.width || !rect.height) {
        return false;
      }

      return rect.right >= minimumLeft && rect.left <= window.innerWidth - 24;
    }

    function overlapsSelectedCandidate(candidate, selectedCandidates) {
      return selectedCandidates.some(
        (selectedCandidate) =>
          snapshotsOverlap(candidate.snapshot, selectedCandidate.snapshot) ||
          rectsOverlap(candidate.rect, selectedCandidate.rect, 12) ||
          Math.abs(selectedCandidate.centerX - candidate.centerX) < 42
      );
    }

    function snapshotsOverlap(firstSnapshot, secondSnapshot) {
      return (
        firstSnapshot.startOffset < secondSnapshot.endOffset &&
        firstSnapshot.endOffset > secondSnapshot.startOffset
      );
    }

    function getVisibleRenderedHighlightIds(root, minimumLeft) {
      const ids = new Set();

      for (const mark of root.querySelectorAll("mark.ttu-highlight[data-highlight-id]")) {
        const id = mark.getAttribute("data-highlight-id");

        if (!id || !renderedMarkIsVisible(mark, minimumLeft)) {
          continue;
        }

        ids.add(id);
      }

      return ids;
    }

    function renderedMarkIsVisible(mark, minimumLeft) {
      const style = getComputedStyle(mark);

      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }

      return Array.from(mark.getClientRects()).some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right >= minimumLeft &&
          rect.left <= window.innerWidth - 24 &&
          rect.bottom >= 0 &&
          rect.top <= window.innerHeight
      );
    }

    function getSingleClientRect(range) {
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0
      );

      if (rects.length !== 1) {
        return undefined;
      }

      return rects[0];
    }

    function snapshotRect(rect) {
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top
      };
    }

    function rectsOverlap(firstRect, secondRect, padding = 0) {
      return (
        firstRect.left - padding < secondRect.right &&
        firstRect.right + padding > secondRect.left &&
        firstRect.top - padding < secondRect.bottom &&
        firstRect.bottom + padding > secondRect.top
      );
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
      const node = textNodes[startIndex];
      const text = node.textContent || "";
      const endOffset = Math.min(text.length, startOffset + preferredLength);

      if (endOffset <= startOffset) {
        return undefined;
      }

      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);
      return range;
    }

    function findReadableStart(text, minimumStart) {
      for (let index = Math.max(0, minimumStart); index < text.length; index += 1) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text[index])) {
          return index;
        }
      }

      return -1;
    }

    function getReadableCharacterCount(text) {
      return Array.from(text).filter((character) =>
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)
      ).length;
    }
  }, { currentBookId: bookId, shouldKeepHighlightsRight: keepHighlightsRight });
}

async function captureLibraryScreenshot(page, { appUrl, bookCount, path: screenshotPath, theme }) {
  await page.goto(`${appUrl}/library`, { waitUntil: "domcontentloaded" });
  await enableScreenshotSupporterMode(page);
  await waitForLibrary(page, bookCount);
  await waitForSupporterThemeRendering(page, { theme, view: "library" });
  await settlePageAssets(page);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    quality: screenshotJpegQuality,
    path: screenshotPath,
    type: screenshotImageType
  });
}

async function captureReaderScreenshot(page, { appUrl, bookId, path: screenshotPath, theme }) {
  const showTableOfContents = !themeHasReaderBackgroundImage(theme);

  await page.goto(`${appUrl}/b?id=${bookId}`, { waitUntil: "domcontentloaded" });
  await enableScreenshotSupporterMode(page);
  await waitForReaderContent(page);
  await advanceReaderToReadablePage(page);
  await setReaderTableOfContents(page, showTableOfContents);
  await paintReaderHighlights(page, { bookId, keepHighlightsRight: showTableOfContents });
  await selectReaderText(page, { keepSelectionRight: showTableOfContents });
  await waitForSupporterThemeRendering(page, { theme, view: "reader" });
  await settlePageAssets(page);
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    quality: screenshotJpegQuality,
    path: screenshotPath,
    type: screenshotImageType
  });
}

function themeHasReaderBackgroundImage(theme) {
  return Boolean(theme.backgroundImages?.reader?.url || theme.backgroundImages?.reader?.fileName);
}

async function fulfillScreenshotAccountStateRoute(route) {
  await route.fulfill({
    body: JSON.stringify({
      auth: screenshotAccountState.auth,
      billing: screenshotAccountState.billing
    }),
    contentType: "application/json",
    status: 200
  });
}

function seedScreenshotAccountStateStorage(accountState) {
  window.localStorage.setItem("yatsuAccountSessionLikely", "true");
  window.localStorage.setItem(
    "yatsuAccountPresentationUser",
    JSON.stringify({
      version: 2,
      user: accountState.presentationUser
    })
  );
}

async function enableScreenshotSupporterMode(page) {
  await page.evaluate(async ({ accountState }) => {
    const { accountState$ } = await import("/src/lib/data/account-state.ts");

    accountState$.next(accountState);
  }, { accountState: screenshotAccountState });
}

async function waitForSupporterThemeRendering(page, { theme, view }) {
  if (!theme.hasSupporterOnlySettings) {
    return;
  }

  await page.waitForFunction(
    ({ theme: currentTheme, view: currentView }) => {
      const rootStyle = getComputedStyle(document.documentElement);
      const supporterSettings = new Set(currentTheme.supporterOnlySettings || []);

      if (
        supporterSettings.has("extended theme colors") &&
        !customHighlightColorsAreApplied(currentTheme, rootStyle)
      ) {
        return false;
      }

      if (currentTheme.backgroundImages?.[currentView] && !themeBackgroundImageIsApplied(rootStyle)) {
        return false;
      }

      return true;

      function customHighlightColorsAreApplied(themeOption, computedStyle) {
        const highlightVariables = {
          highlightYellowColor: "--highlight-yellow-fill",
          highlightGreenColor: "--highlight-green-fill",
          highlightBlueColor: "--highlight-blue-fill",
          highlightPinkColor: "--highlight-pink-fill",
          highlightPurpleColor: "--highlight-purple-fill"
        };

        return Object.entries(highlightVariables).every(([themeKey, variableName]) => {
          const expectedColor = themeOption.theme?.[themeKey];

          if (!expectedColor) {
            return true;
          }

          return (
            normalizeCssColor(computedStyle.getPropertyValue(variableName)) ===
            normalizeCssColor(expectedColor)
          );
        });
      }

      function themeBackgroundImageIsApplied(computedStyle) {
        const imageValue = computedStyle.getPropertyValue("--theme-background-image").trim();
        const opacity = Number(computedStyle.getPropertyValue("--theme-background-image-opacity"));

        return imageValue.startsWith("url(") && opacity > 0;
      }

      function normalizeCssColor(value) {
        const probe = document.createElement("span");

        probe.style.backgroundColor = value.trim();
        document.body.append(probe);

        const color = getComputedStyle(probe).backgroundColor.replace(/\s+/g, "").toLowerCase();

        probe.remove();
        return color;
      }
    },
    { theme, view },
    { timeout: 10_000 }
  );
}

async function setReaderTableOfContents(page, isOpen) {
  await page.evaluate(async ({ shouldOpen }) => {
    const { tocIsOpen$ } = await import("/src/lib/components/book-reader/book-toc/book-toc.ts");
    tocIsOpen$.next(shouldOpen);
  }, { shouldOpen: isOpen });

  if (isOpen) {
    await page.waitForSelector('[aria-label="Table of contents"]', { timeout: 10_000 });
  } else {
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Table of contents"]'),
      undefined,
      { timeout: 10_000 }
    );
  }

  await page.waitForTimeout(180);
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

async function selectReaderText(page, { keepSelectionRight = true } = {}) {
  await page.evaluate(({ shouldKeepSelectionRight }) => {
    const content = document.querySelector(".book-content:not(.book-content-page-measure)");

    if (!(content instanceof HTMLElement)) {
      throw new Error("Visible reader content was not found.");
    }

    const range = getReadableRange(content, {
      minimumLeft: getReaderVisibleLeftBound(shouldKeepSelectionRight),
      minimumOffset: 0,
      preferredLength: 8
    });
    const selection = window.getSelection();

    selection?.removeAllRanges();
    selection?.addRange(range);

    function getReaderVisibleLeftBound(keepRight) {
      if (!keepRight) {
        return Math.max(72, window.innerWidth * 0.18);
      }

      return Math.min(window.innerWidth - 160, Math.max(360, window.innerWidth * 0.48));
    }

    function getReadableRange(root, { minimumLeft, minimumOffset, preferredLength }) {
      const textNodes = getReadableTextNodes(root);
      const highlightRects = getHighlightRects(root);
      const attempts = [minimumLeft, 0];
      let offset = 0;

      for (const avoidHighlights of [true, false]) {
        for (const attemptedMinimumLeft of attempts) {
          offset = 0;

          for (let index = 0; index < textNodes.length; index += 1) {
            const node = textNodes[index];
            const text = node.textContent || "";
            let start = findReadableStart(
              text,
              offset >= minimumOffset ? 0 : minimumOffset - offset
            );

            offset += text.length;

            while (start !== -1) {
              const range = buildRangeFromTextNodes(textNodes, index, start, preferredLength);
              const rect = range ? getSingleClientRect(range) : undefined;

              if (
                range &&
                rect &&
                isUsefulReadableRect(rect, attemptedMinimumLeft) &&
                (!avoidHighlights ||
                  !highlightRects.some((highlightRect) => rectsOverlap(rect, highlightRect, 18)))
              ) {
                return range;
              }

              start = findReadableStart(text, start + preferredLength + 4);
            }
          }
        }
      }

      throw new Error("Unable to find selectable Japanese reader text.");
    }

    function isUsefulReadableRect(rect, minimumLeft) {
      if (!rect.width || !rect.height) {
        return false;
      }

      return rect.right >= minimumLeft && rect.left <= window.innerWidth - 24;
    }

    function getHighlightRects(root) {
      return Array.from(root.querySelectorAll("mark.ttu-highlight")).flatMap((mark) =>
        Array.from(mark.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map(snapshotRect)
      );
    }

    function getSingleClientRect(range) {
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0
      );

      if (rects.length !== 1) {
        return undefined;
      }

      return rects[0];
    }

    function snapshotRect(rect) {
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top
      };
    }

    function rectsOverlap(firstRect, secondRect, padding = 0) {
      return (
        firstRect.left - padding < secondRect.right &&
        firstRect.right + padding > secondRect.left &&
        firstRect.top - padding < secondRect.bottom &&
        firstRect.bottom + padding > secondRect.top
      );
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
      const node = textNodes[startIndex];
      const text = node.textContent || "";
      const endOffset = Math.min(text.length, startOffset + preferredLength);

      if (endOffset <= startOffset) {
        return undefined;
      }

      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);
      return range;
    }

    function findReadableStart(text, minimumStart) {
      for (let index = Math.max(0, minimumStart); index < text.length; index += 1) {
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text[index])) {
          return index;
        }
      }

      return -1;
    }
  }, { shouldKeepSelectionRight: keepSelectionRight });
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
    ["--filter", "web", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
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

function getScreenshotPath(themeId, view) {
  return path.join(screenshotsDir, `${themeId}-${view}.${screenshotImageExtension}`);
}

function clampInteger(value, { fallback, max, min }) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
