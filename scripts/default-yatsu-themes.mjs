import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const THEME_COLOR_KEYS = [
  "fontColor",
  "backgroundColor",
  "accentColor",
  "accentTextColor",
  "linkColor",
  "mutedTextColor",
  "readerChromeBackgroundColor",
  "readerChromeBorderColor",
  "selectionFontColor",
  "selectionBackgroundColor",
  "hintFuriganaShadowColor",
  "hintFuriganaFontColor",
  "tooltipTextFontColor",
  "highlightYellowColor",
  "highlightGreenColor",
  "highlightBlueColor",
  "highlightPinkColor",
  "highlightPurpleColor"
];

export const DEFAULT_THEME_ENTRIES = [
  {
    id: "light-theme",
    name: "Light",
    description: "Yatsu's default high-contrast light reader theme.",
    tags: ["built-in", "light", "default"],
    theme: {
      fontColor: "rgba(0, 0, 0, 0.87)",
      backgroundColor: "rgba(255, 255, 255, 1)",
      accentColor: "rgba(71, 85, 105, 1)",
      accentTextColor: "rgba(248, 250, 252, 1)",
      linkColor: "rgba(0, 0, 0, 0.87)",
      mutedTextColor: "rgba(0, 0, 0, 0.56)",
      readerChromeBackgroundColor: "rgba(235, 235, 235, 0.78)",
      readerChromeBorderColor: "rgba(224, 224, 224, 0.2)",
      selectionFontColor: "rgba(248, 250, 252, 1)",
      selectionBackgroundColor: "rgba(71, 85, 105, 1)",
      hintFuriganaFontColor: "rgba(0, 0, 0, 0.3306)",
      hintFuriganaShadowColor: "rgba(34, 34, 49, 0.3)",
      tooltipTextFontColor: "rgba(0, 0, 0, 0.6)",
      highlightYellowColor: "rgba(250, 204, 21, 0.34)",
      highlightGreenColor: "rgba(34, 197, 94, 0.34)",
      highlightBlueColor: "rgba(59, 130, 246, 0.3)",
      highlightPinkColor: "rgba(236, 72, 153, 0.28)",
      highlightPurpleColor: "rgba(139, 92, 246, 0.28)"
    }
  },
  {
    id: "ecru-theme",
    name: "Ecru",
    description: "A warm off-white theme for softer daytime reading.",
    tags: ["built-in", "light", "warm"],
    theme: {
      fontColor: "rgba(0, 0, 0, 0.87)",
      backgroundColor: "rgba(247, 246, 235, 1)",
      accentColor: "rgba(113, 80, 48, 1)",
      accentTextColor: "rgba(255, 252, 242, 1)",
      linkColor: "rgba(0, 0, 0, 0.87)",
      mutedTextColor: "rgba(0, 0, 0, 0.56)",
      readerChromeBackgroundColor: "rgba(227, 226, 216, 0.78)",
      readerChromeBorderColor: "rgba(217, 216, 207, 0.2)",
      selectionFontColor: "rgba(255, 252, 242, 1)",
      selectionBackgroundColor: "rgba(113, 80, 48, 1)",
      hintFuriganaFontColor: "rgba(0, 0, 0, 0.3306)",
      hintFuriganaShadowColor: "rgba(34, 34, 49, 0.3)",
      tooltipTextFontColor: "rgba(0, 0, 0, 0.6)",
      highlightYellowColor: "rgba(250, 204, 21, 0.34)",
      highlightGreenColor: "rgba(34, 197, 94, 0.34)",
      highlightBlueColor: "rgba(59, 130, 246, 0.3)",
      highlightPinkColor: "rgba(236, 72, 153, 0.28)",
      highlightPurpleColor: "rgba(139, 92, 246, 0.28)"
    }
  },
  {
    id: "water-theme",
    name: "Water",
    description: "A cool light theme with Yatsu's blue-toned page background.",
    tags: ["built-in", "light", "cool"],
    theme: {
      fontColor: "rgba(0, 0, 0, 0.87)",
      backgroundColor: "rgba(223, 236, 244, 1)",
      accentColor: "rgba(43, 92, 110, 1)",
      accentTextColor: "rgba(248, 250, 252, 1)",
      linkColor: "rgba(0, 0, 0, 0.87)",
      mutedTextColor: "rgba(0, 0, 0, 0.56)",
      readerChromeBackgroundColor: "rgba(205, 217, 224, 0.78)",
      readerChromeBorderColor: "rgba(196, 208, 215, 0.2)",
      selectionFontColor: "rgba(248, 250, 252, 1)",
      selectionBackgroundColor: "rgba(43, 92, 110, 1)",
      hintFuriganaFontColor: "rgba(0, 0, 0, 0.3306)",
      hintFuriganaShadowColor: "rgba(34, 34, 49, 0.3)",
      tooltipTextFontColor: "rgba(0, 0, 0, 0.6)",
      highlightYellowColor: "rgba(250, 204, 21, 0.34)",
      highlightGreenColor: "rgba(34, 197, 94, 0.34)",
      highlightBlueColor: "rgba(59, 130, 246, 0.3)",
      highlightPinkColor: "rgba(236, 72, 153, 0.28)",
      highlightPurpleColor: "rgba(139, 92, 246, 0.28)"
    }
  },
  {
    id: "gray-theme",
    name: "Gray",
    description: "Yatsu's default dark theme with readable contrast and soft chrome.",
    tags: ["built-in", "dark", "default"],
    theme: {
      fontColor: "rgba(255, 255, 255, 0.87)",
      backgroundColor: "rgba(35, 39, 42, 1)",
      accentColor: "rgba(212, 217, 220, 0.9)",
      accentTextColor: "rgba(15, 23, 42, 0.98)",
      linkColor: "rgba(255, 255, 255, 0.87)",
      mutedTextColor: "rgba(255, 255, 255, 0.58)",
      readerChromeBackgroundColor: "rgba(75, 78, 80, 0.86)",
      readerChromeBorderColor: "rgba(88, 91, 93, 0.2)",
      selectionFontColor: "rgba(15, 23, 42, 0.98)",
      selectionBackgroundColor: "rgba(212, 217, 220, 0.9)",
      hintFuriganaFontColor: "rgba(255, 255, 255, 0.3306)",
      hintFuriganaShadowColor: "rgba(240, 240, 241, 0.3)",
      tooltipTextFontColor: "rgba(255, 255, 255, 0.6)",
      highlightYellowColor: "rgba(250, 204, 21, 0.34)",
      highlightGreenColor: "rgba(34, 197, 94, 0.34)",
      highlightBlueColor: "rgba(59, 130, 246, 0.3)",
      highlightPinkColor: "rgba(236, 72, 153, 0.28)",
      highlightPurpleColor: "rgba(139, 92, 246, 0.28)"
    }
  },
  {
    id: "dark-theme",
    name: "Dark",
    description: "A deeper low-brightness theme for dim reading environments.",
    tags: ["built-in", "dark", "low-glare"],
    theme: {
      fontColor: "rgba(255, 255, 255, 0.6)",
      backgroundColor: "rgba(18, 18, 18, 1)",
      accentColor: "rgba(212, 217, 220, 0.9)",
      accentTextColor: "rgba(15, 23, 42, 0.98)",
      linkColor: "rgba(255, 255, 255, 0.6)",
      mutedTextColor: "rgba(255, 255, 255, 0.58)",
      readerChromeBackgroundColor: "rgba(61, 61, 61, 0.86)",
      readerChromeBorderColor: "rgba(75, 75, 75, 0.2)",
      selectionFontColor: "rgba(15, 23, 42, 0.98)",
      selectionBackgroundColor: "rgba(212, 217, 220, 0.9)",
      hintFuriganaFontColor: "rgba(255, 255, 255, 0.3306)",
      hintFuriganaShadowColor: "rgba(240, 240, 241, 0.3)",
      tooltipTextFontColor: "rgba(255, 255, 255, 0.6)",
      highlightYellowColor: "rgba(250, 204, 21, 0.34)",
      highlightGreenColor: "rgba(34, 197, 94, 0.34)",
      highlightBlueColor: "rgba(59, 130, 246, 0.3)",
      highlightPinkColor: "rgba(236, 72, 153, 0.28)",
      highlightPurpleColor: "rgba(139, 92, 246, 0.28)"
    }
  },
  {
    id: "black-theme",
    name: "Black",
    description: "A black-page theme for OLED displays and night reading.",
    tags: ["built-in", "dark", "oled"],
    theme: {
      fontColor: "rgba(255, 255, 255, 0.87)",
      backgroundColor: "rgba(0, 0, 0, 1)",
      accentColor: "rgba(226, 232, 240, 0.9)",
      accentTextColor: "rgba(15, 23, 42, 0.98)",
      linkColor: "rgba(255, 255, 255, 0.87)",
      mutedTextColor: "rgba(255, 255, 255, 0.58)",
      readerChromeBackgroundColor: "rgba(46, 46, 46, 0.86)",
      readerChromeBorderColor: "rgba(61, 61, 61, 0.2)",
      selectionFontColor: "rgba(15, 23, 42, 0.98)",
      selectionBackgroundColor: "rgba(226, 232, 240, 0.9)",
      hintFuriganaFontColor: "rgba(255, 255, 255, 0.3306)",
      hintFuriganaShadowColor: "rgba(240, 240, 241, 0.3)",
      tooltipTextFontColor: "rgba(255, 255, 255, 0.6)",
      highlightYellowColor: "rgba(250, 204, 21, 0.34)",
      highlightGreenColor: "rgba(34, 197, 94, 0.34)",
      highlightBlueColor: "rgba(59, 130, 246, 0.3)",
      highlightPinkColor: "rgba(236, 72, 153, 0.28)",
      highlightPurpleColor: "rgba(139, 92, 246, 0.28)"
    }
  }
];

export const DEFAULT_LIGHT_THEME = DEFAULT_THEME_ENTRIES[0].theme;

export async function writeDefaultThemeFiles(rootDir = getRootDir()) {
  const themesDir = path.join(rootDir, "themes");

  await fs.mkdir(themesDir, { recursive: true });

  for (const entry of DEFAULT_THEME_ENTRIES) {
    const themePath = path.join(themesDir, `${entry.id}.yatsutheme`);
    const metadataPath = path.join(themesDir, `${entry.id}.meta.json`);

    await fs.writeFile(
      themePath,
      `${JSON.stringify(
        {
          version: 1,
          name: entry.name,
          theme: entry.theme
        },
        null,
        2
      )}\n`
    );
    await fs.writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          name: entry.name,
          slug: entry.id,
          description: entry.description,
          author: "Yatsu",
          updatedAt: "2026-05-25T00:00:00.000Z",
          tags: entry.tags
        },
        null,
        2
      )}\n`
    );
  }
}

function getRootDir() {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}
