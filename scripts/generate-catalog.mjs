import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIGHT_THEME, THEME_COLOR_KEYS } from "./default-yatsu-themes.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const themesDir = path.join(rootDir, "themes");
const publicDir = path.join(rootDir, "docs");
const publicThemesDir = path.join(publicDir, "themes");
const publicAssetsDir = path.join(publicDir, "theme-assets");
const publicScreenshotsDir = path.join(publicDir, "screenshots");
const publicThemePagesDir = path.join(publicDir, "theme");
const catalogPath = path.join(publicDir, "catalog.json");
const checkMode = process.argv.includes("--check");
const packageSlots = ["reader", "library"];
const themeExtensionPattern = /\.(?:yatsutheme|json)$/i;
const metadataExtensionPattern = /\.meta\.json$/i;
const supporterThemeColorKeys = [
  "accentColor",
  "accentTextColor",
  "linkColor",
  "mutedTextColor",
  "readerChromeBackgroundColor",
  "readerChromeBorderColor",
  "highlightYellowColor",
  "highlightGreenColor",
  "highlightBlueColor",
  "highlightPinkColor",
  "highlightPurpleColor"
];

const builtInOrder = new Map(
  ["light-theme", "ecru-theme", "water-theme", "gray-theme", "dark-theme", "black-theme"].map(
    (id, index) => [id, index]
  )
);

await main();

async function main() {
  const catalog = await createCatalog({ writeFiles: !checkMode });
  const nextJson = `${JSON.stringify(catalog, null, 2)}\n`;

  if (checkMode) {
    const currentJson = await fs.readFile(catalogPath, "utf8").catch(() => "");

    if (currentJson !== nextJson) {
      throw new Error("docs/catalog.json is out of date. Run npm run build.");
    }

    await checkThemePages(catalog.themes);
    console.log(`Catalog is up to date with ${catalog.themes.length} themes.`);
    return;
  }

  await fs.writeFile(catalogPath, nextJson);
  console.log(`Generated ${path.relative(rootDir, catalogPath)} with ${catalog.themes.length} themes.`);
}

async function createCatalog({ writeFiles }) {
  await fs.mkdir(themesDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });

  if (writeFiles) {
    await fs.rm(publicThemesDir, { recursive: true, force: true });
    await fs.rm(publicAssetsDir, { recursive: true, force: true });
    await fs.rm(publicThemePagesDir, { recursive: true, force: true });
    await fs.mkdir(publicThemesDir, { recursive: true });
    await fs.mkdir(publicAssetsDir, { recursive: true });
    await fs.mkdir(publicThemePagesDir, { recursive: true });
  }

  const themeFiles = await getThemeFiles();
  const usedIds = new Set();
  const themes = [];

  for (const fileName of themeFiles) {
    const sourcePath = path.join(themesDir, fileName);
    const buffer = await fs.readFile(sourcePath);
    const parsed = parseThemeBuffer(buffer, fileName);
    const payload = coerceThemePayload(parsed.payload, fallbackThemeName(fileName));

    if (!payload) {
      throw new Error(`${fileName} is not a valid Yatsu theme file.`);
    }

    const metadata = await readThemeMetadata(fileName);
    const displayName = sanitizeName(metadata.name || payload.name || fallbackThemeName(fileName));
    const id = getUniqueId(slugify(metadata.slug || displayName || fileName), usedIds);
    const theme = getCompleteThemeOption(payload.theme || {});
    const metadataTags = normalizeTags(metadata.tags || []);
    const modeData = getThemeModeData(theme.backgroundColor, metadataTags);
    const mode = modeData.mode;
    const screenshots = await getThemeScreenshots(id);
    const isBuiltInTheme = metadataTags.includes("built-in");
    const supporterOnlySettings = isBuiltInTheme ? [] : getSupporterOnlySettings(payload);
    const backgroundImages = await extractBackgroundImages({
      id,
      parsed,
      payload,
      writeFiles
    });
    const tags = normalizeTags([
      ...metadataTags,
      ...modeData.tags,
      Object.keys(backgroundImages).length ? "background-image" : "",
      payload.typography ? "typography" : "",
      supporterOnlySettings.length ? "supporter-settings" : ""
    ]);

    if (writeFiles) {
      await fs.copyFile(sourcePath, path.join(publicThemesDir, fileName));
    }

    themes.push({
      id,
      name: displayName,
      author: sanitizeName(metadata.author || ""),
      description: sanitizeDescription(metadata.description || ""),
      fileName,
      downloadUrl: `/themes/${encodeURIComponent(fileName)}`,
      sizeBytes: buffer.byteLength,
      contentHash: crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16),
      updatedAt: metadata.updatedAt,
      mode,
      modes: modeData.tags,
      tags,
      theme,
      backgroundImages,
      screenshots,
      hasBackgroundImages: Object.keys(backgroundImages).length > 0,
      hasScreenshots: Boolean(screenshots.library && screenshots.reader),
      hasBackgroundImageSettings: hasBackgroundImageSettings(payload),
      hasSupporterOnlySettings: supporterOnlySettings.length > 0,
      supporterOnlySettings,
      hasTypography: Boolean(payload.typography),
      swatches: getSwatches(theme)
    });
  }

  themes.sort(compareThemes);

  if (writeFiles) {
    await writeThemePages(themes);
  }

  const generatedAt =
    themes
      .map((theme) => theme.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || "";

  return {
    version: 1,
    generatedAt,
    themeCount: themes.length,
    themes
  };
}

async function getThemeScreenshots(id) {
  const screenshots = {};
  const screenshotEntries = ["library", "reader"];

  for (const key of screenshotEntries) {
    const fileName = await getThemeScreenshotFileName(id, key);

    if (fileName) {
      screenshots[key] = `/screenshots/${fileName}`;
    }
  }

  return screenshots;
}

async function getThemeScreenshotFileName(id, view) {
  for (const extension of ["jpg", "jpeg", "png"]) {
    const fileName = `${id}-${view}.${extension}`;

    try {
      await fs.access(path.join(publicScreenshotsDir, fileName));
      return fileName;
    } catch {
      // Screenshots are optional generated assets.
    }
  }

  return "";
}

async function writeThemePages(themes) {
  const pageHtml = await getThemePageHtml();

  await Promise.all(
    themes.map(async (theme) => {
      const themePageDir = path.join(publicThemePagesDir, theme.id);

      await fs.mkdir(themePageDir, { recursive: true });
      await fs.writeFile(path.join(themePageDir, "index.html"), pageHtml);
    })
  );
}

async function checkThemePages(themes) {
  const pageHtml = await getThemePageHtml();
  const expectedThemeIds = new Set(themes.map((theme) => theme.id));
  const entries = await fs.readdir(publicThemePagesDir, { withFileTypes: true }).catch(() => []);

  for (const theme of themes) {
    const themePagePath = path.join(publicThemePagesDir, theme.id, "index.html");
    const currentHtml = await fs.readFile(themePagePath, "utf8").catch(() => "");

    if (currentHtml !== pageHtml) {
      throw new Error("Theme pages are out of date. Run npm run build.");
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !expectedThemeIds.has(entry.name)) {
      throw new Error("Theme pages contain stale entries. Run npm run build.");
    }
  }
}

async function getThemePageHtml() {
  return fs.readFile(path.join(publicDir, "index.html"), "utf8");
}

async function getThemeFiles() {
  const entries = await fs.readdir(themesDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        themeExtensionPattern.test(entry.name) &&
        !metadataExtensionPattern.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function readThemeMetadata(fileName) {
  const metadataPath = path.join(
    themesDir,
    fileName.replace(/\.(?:yatsutheme|json)$/i, ".meta.json")
  );
  const text = await fs.readFile(metadataPath, "utf8").catch(() => "");

  if (!text) {
    return {};
  }

  const value = JSON.parse(text);

  if (!isRecord(value)) {
    return {};
  }

  return {
    name: sanitizeName(value.name),
    slug: sanitizeName(value.slug),
    author: sanitizeName(value.author),
    description: sanitizeDescription(value.description),
    tags: Array.isArray(value.tags) ? value.tags.map(sanitizeName).filter(Boolean) : [],
    updatedAt: normalizeIsoDate(value.updatedAt)
  };
}

function parseThemeBuffer(buffer, fileName) {
  if (/\.yatsutheme$/i.test(fileName)) {
    try {
      const files = readZipEntries(buffer);
      const manifest = files.get("manifest.json");

      if (!manifest) {
        throw new Error("Packaged theme is missing manifest.json.");
      }

      return {
        payload: JSON.parse(manifest.data.toString("utf8")),
        packageFiles: files
      };
    } catch (error) {
      if (looksLikeZip(buffer)) {
        throw new Error(`${fileName} could not be parsed as a theme package: ${error.message}`);
      }
    }
  }

  return {
    payload: JSON.parse(buffer.toString("utf8")),
    packageFiles: new Map()
  };
}

function coerceThemePayload(value, fallbackName) {
  if (!isRecord(value)) {
    return undefined;
  }

  if (isRecord(value.theme)) {
    return {
      version: 1,
      name: sanitizeName(value.name) || fallbackName,
      theme: value.theme,
      backgroundImage: isRecord(value.backgroundImage) ? value.backgroundImage : undefined,
      backgroundImageFit: sanitizeName(value.backgroundImageFit),
      backgroundImageSet: isRecord(value.backgroundImageSet) ? value.backgroundImageSet : undefined,
      backgroundImageSetFits: isRecord(value.backgroundImageSetFits)
        ? value.backgroundImageSetFits
        : undefined,
      typography: isRecord(value.typography) ? value.typography : undefined
    };
  }

  if (THEME_COLOR_KEYS.some((key) => typeof value[key] === "string" && value[key].trim())) {
    return {
      version: 1,
      name: fallbackName,
      theme: value
    };
  }

  return undefined;
}

async function extractBackgroundImages({ id, parsed, payload, writeFiles }) {
  const result = {};

  if (!parsed.packageFiles?.size) {
    return result;
  }

  for (const slot of packageSlots) {
    const candidate = getBackgroundImageCandidate(payload, slot);

    if (!candidate?.path) {
      continue;
    }

    const zipEntry = parsed.packageFiles.get(candidate.path);

    if (!zipEntry) {
      continue;
    }

    const mediaType = candidate.option.mediaType === "image/png" ? "image/png" : "image/jpeg";
    const extension = mediaType === "image/png" ? "png" : "jpg";
    const assetPath = `theme-assets/${id}/${slot}-background.${extension}`;

    if (writeFiles) {
      const outputPath = path.join(publicDir, assetPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, zipEntry.data);
    }

    result[slot] = {
      url: assetPath,
      fileName: sanitizeName(candidate.option.fileName),
      mediaType,
      fit: normalizeBackgroundFit(candidate.fit),
      opacity: normalizeOpacity(candidate.option.opacity, 0.3),
      blur: normalizeBlur(candidate.option.blur),
      overlayColor: normalizeColorExpression(candidate.option.overlayColor) || "rgba(0, 0, 0, 1)",
      overlayOpacity: normalizeOpacity(candidate.option.overlayOpacity, 0)
    };
  }

  return result;
}

function getBackgroundImageCandidate(payload, slot) {
  const setOption = isRecord(payload.backgroundImageSet)
    ? payload.backgroundImageSet[slot]
    : undefined;

  if (isRecord(setOption)) {
    const path = normalizePackageAssetPath(setOption.path);

    if (path) {
      return {
        option: setOption,
        path,
        fit: isRecord(payload.backgroundImageSetFits)
          ? payload.backgroundImageSetFits[slot]
          : setOption.fit
      };
    }
  }

  if (!isRecord(payload.backgroundImage)) {
    return undefined;
  }

  const scope = sanitizeName(payload.backgroundImage.scope) || "reader";

  if (scope !== "both" && scope !== slot) {
    return undefined;
  }

  const path = normalizePackageAssetPath(payload.backgroundImage.path);

  return path
    ? {
        option: payload.backgroundImage,
        path,
        fit: payload.backgroundImageFit || payload.backgroundImage.fit
      }
    : undefined;
}

function normalizePackageAssetPath(value) {
  if (typeof value !== "string") {
    return "";
  }

  const assetPath = value.trim();

  if (
    !assetPath ||
    assetPath.startsWith("/") ||
    assetPath.includes("\\") ||
    assetPath.split("/").includes("..")
  ) {
    return "";
  }

  return assetPath;
}

function hasBackgroundImageSettings(payload) {
  return Boolean(
    payload.backgroundImage ||
      payload.backgroundImageFit ||
      payload.backgroundImageSet ||
      payload.backgroundImageSetFits
  );
}

function getSupporterOnlySettings(payload) {
  return [
    hasSupporterThemeColors(payload) ? "extended theme colors" : "",
    hasBackgroundImageSettings(payload) ? "background image settings" : ""
  ].filter(Boolean);
}

function hasSupporterThemeColors(payload) {
  return supporterThemeColorKeys.some((key) => {
    const value = payload.theme?.[key];

    return typeof value === "string" && Boolean(value.trim());
  });
}

function getCompleteThemeOption(reference) {
  return Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => [key, getThemeColorValue(reference, key)])
  );
}

function getThemeColorValue(reference, key) {
  const normalized = normalizeColorExpression(reference[key]);

  if (normalized) {
    return normalized;
  }

  switch (key) {
    case "accentColor":
      return (
        normalizeColorExpression(reference.selectionBackgroundColor) ||
        DEFAULT_LIGHT_THEME.accentColor
      );
    case "accentTextColor":
      return normalizeColorExpression(reference.selectionFontColor) || DEFAULT_LIGHT_THEME.accentTextColor;
    case "linkColor":
      return normalizeColorExpression(reference.fontColor) || DEFAULT_LIGHT_THEME.linkColor;
    case "mutedTextColor":
      return DEFAULT_LIGHT_THEME.mutedTextColor;
    case "readerChromeBackgroundColor":
      return getLegacyReaderChromeColor(reference, "background");
    case "readerChromeBorderColor":
      return getLegacyReaderChromeColor(reference, "border");
    default:
      return DEFAULT_LIGHT_THEME[key] || "rgba(255, 255, 255, 1)";
  }
}

function getLegacyReaderChromeColor(reference, target) {
  const backgroundColor =
    normalizeColorExpression(reference.backgroundColor) || DEFAULT_LIGHT_THEME.backgroundColor;
  const fontColor = normalizeColorExpression(reference.fontColor) || DEFAULT_LIGHT_THEME.fontColor;
  const isDarkTheme = getThemeColorLuminance(backgroundColor) < 0.5;

  if (target === "background") {
    return mixColorExpressions(
      backgroundColor,
      fontColor,
      isDarkTheme ? 0.18 : 0.08,
      isDarkTheme ? 0.86 : 0.78
    );
  }

  return mixColorExpressions(backgroundColor, fontColor, isDarkTheme ? 0.24 : 0.12, 0.2);
}

function normalizeColorExpression(value) {
  if (typeof value !== "string") {
    return "";
  }

  const parsed = parseColorExpression(value);

  if (!parsed) {
    return "";
  }

  const [r, g, b, a] = parsed;

  return `rgba(${clampColor(r)}, ${clampColor(g)}, ${clampColor(b)}, ${clampAlpha(a)})`;
}

function parseColorExpression(value) {
  const trimmed = value.trim();

  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return [
      parseInt(`${trimmed[1]}${trimmed[1]}`, 16),
      parseInt(`${trimmed[2]}${trimmed[2]}`, 16),
      parseInt(`${trimmed[3]}${trimmed[3]}`, 16),
      1
    ];
  }

  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return [
      parseInt(trimmed.slice(1, 3), 16),
      parseInt(trimmed.slice(3, 5), 16),
      parseInt(trimmed.slice(5, 7), 16),
      1
    ];
  }

  const parsed = trimmed
    .match(/rgba?\((.+)\)/)?.[1]
    ?.split(",")
    .slice(0, 4)
    .map((part) => Number.parseFloat(part.trim()));

  if (!parsed || parsed.length < 3 || parsed.some((channel) => Number.isNaN(channel))) {
    return undefined;
  }

  return [parsed[0], parsed[1], parsed[2], parsed[3] ?? 1];
}

function getThemeColorLuminance(value) {
  const [r = 255, g = 255, b = 255] = parseColorExpression(value) || [];

  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function mixColorExpressions(fromColor, toColor, weight, alpha) {
  const [fromR = 255, fromG = 255, fromB = 255] = parseColorExpression(fromColor) || [];
  const [toR = 255, toG = 255, toB = 255] = parseColorExpression(toColor) || [];
  const inverseWeight = 1 - weight;

  return `rgba(${Math.round(fromR * inverseWeight + toR * weight)}, ${Math.round(
    fromG * inverseWeight + toG * weight
  )}, ${Math.round(fromB * inverseWeight + toB * weight)}, ${alpha})`;
}

function getThemeModeData(backgroundColor, tags = []) {
  const taggedModes = tags.filter((tag) => tag === "dark" || tag === "light");

  if (taggedModes.length) {
    return {
      mode: taggedModes.includes("dark") ? "dark" : "light",
      tags: taggedModes
    };
  }

  const luminance = getThemeColorLuminance(backgroundColor);

  if (!Number.isFinite(luminance)) {
    return {
      mode: "light",
      tags: ["dark", "light"]
    };
  }

  if (luminance < 0.18) {
    return {
      mode: "dark",
      tags: ["dark"]
    };
  }

  if (luminance < 0.5) {
    return {
      mode: "dark",
      tags: ["dark", "light"]
    };
  }

  return {
    mode: "light",
    tags: ["light"]
  };
}

function getSwatches(theme) {
  return [
    "backgroundColor",
    "fontColor",
    "accentColor",
    "linkColor",
    "selectionBackgroundColor",
    "highlightYellowColor",
    "highlightBlueColor",
    "highlightPinkColor"
  ].map((key) => ({ key, color: theme[key] }));
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

function looksLikeZip(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function compareThemes(a, b) {
  const builtInA = builtInOrder.get(a.id);
  const builtInB = builtInOrder.get(b.id);

  if (builtInA !== undefined || builtInB !== undefined) {
    return (builtInA ?? 999) - (builtInB ?? 999);
  }

  return a.name.localeCompare(b.name);
}

function getUniqueId(baseId, usedIds) {
  const fallback = baseId || "theme";
  let id = fallback;
  let index = 2;

  while (usedIds.has(id)) {
    id = `${fallback}-${index}`;
    index += 1;
  }

  usedIds.add(id);
  return id;
}

function slugify(value) {
  return sanitizeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function fallbackThemeName(fileName) {
  return fileName
    .replace(/\.(?:yatsutheme|json)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function normalizeTags(tags) {
  return Array.from(
    new Set(
      tags
        .flatMap((tag) => {
          const normalizedTag = sanitizeName(tag).toLowerCase();

          return normalizedTag === "dim" ? ["dark", "light"] : [normalizedTag];
        })
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function normalizeBackgroundFit(value) {
  const fit = sanitizeName(value);

  return ["fit", "fill", "stretch"].includes(fit) ? fit : "fill";
}

function normalizeOpacity(value, fallback) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function normalizeBlur(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(24, Math.round(value)))
    : 0;
}

function clampColor(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampAlpha(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(0, Math.min(1, value));
}

function sanitizeName(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function sanitizeDescription(value) {
  return typeof value === "string" ? value.trim().slice(0, 280) : "";
}

function normalizeIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
