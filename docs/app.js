const grid = document.querySelector("#theme-grid");
const template = document.querySelector("#theme-card-template");
const searchInput = document.querySelector("#search");
const countEl = document.querySelector("#catalog-count");
const modeButtons = Array.from(document.querySelectorAll("[data-mode]"));
const detailsDialog = document.querySelector("#theme-details-dialog");
const detailsDialogPreview = document.querySelector("#theme-details-preview");
const detailsDialogTitle = document.querySelector("#theme-details-title");
const detailsDialogDescription = document.querySelector("#theme-details-description");
const detailsDialogSwatches = document.querySelector("#theme-details-swatches");
const detailsDialogList = document.querySelector("#theme-details-list");
const detailsDialogDownload = document.querySelector("#theme-details-download");
const detailsDialogClose = document.querySelector(".dialog-close");
const installToast = document.querySelector("#install-toast");

const sampleBooks = [
  "吾輩は猫である",
  "坊っちゃん",
  "こころ",
  "銀河鉄道の夜"
];

const swatchKeys = [
  "backgroundColor",
  "fontColor",
  "accentColor",
  "linkColor",
  "selectionBackgroundColor",
  "highlightYellowColor",
  "highlightBlueColor",
  "highlightPinkColor"
];

let catalog = { themes: [], generatedAt: "" };
let activeMode = "all";
let installToastTimer;
let installToastHiddenTimer;

init();

async function init() {
  try {
    const response = await fetch("catalog.json", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Catalog request failed: ${response.status}`);
    }

    catalog = await response.json();
    wireControls();
    render();
  } catch (error) {
    countEl.textContent = "Theme catalog could not be loaded.";
    grid.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function wireControls() {
  searchInput.addEventListener("input", render);
  document.addEventListener("click", (event) => {
    if (isThemeDownloadClick(event.target)) {
      showInstallToast();
    }
  });
  detailsDialogClose.addEventListener("click", () => detailsDialog.close());
  detailsDialog.addEventListener("click", (event) => {
    if (event.target === detailsDialog) {
      detailsDialog.close();
    }
  });

  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      activeMode = button.dataset.mode || "all";

      for (const modeButton of modeButtons) {
        modeButton.classList.toggle("is-active", modeButton === button);
      }

      render();
    });
  }
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const themes = catalog.themes.filter((theme) => themeMatches(theme, query, activeMode));

  grid.replaceChildren();
  countEl.textContent = `${themes.length} of ${catalog.themes.length} themes`;

  if (!themes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No themes match the current filters.";
    grid.append(empty);
    return;
  }

  for (const theme of themes) {
    grid.append(renderThemeCard(theme));
  }
}

function themeMatches(theme, query, mode) {
  const matchesMode =
    mode === "all" ||
    theme.mode === mode ||
    (mode === "dark" && theme.mode === "dim");

  if (!matchesMode) {
    return false;
  }

  if (!query) {
    return true;
  }

  return [
    theme.name,
    theme.author,
    theme.description,
    theme.fileName,
    ...(theme.tags || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function renderThemeCard(theme) {
  const node = template.content.firstElementChild.cloneNode(true);
  const preview = node.querySelector(".theme-preview");

  populateThemePreview(preview, theme);

  node.querySelector("h2").textContent = theme.name;
  node.querySelector(".theme-description").textContent =
    theme.description || "A curated Yatsu Reader theme.";
  node.querySelector(".theme-mode-pill").textContent = theme.mode;

  const swatches = node.querySelector(".theme-swatches");
  renderSwatches(swatches, theme);

  const meta = node.querySelector(".theme-meta");
  for (const itemData of getMetaItems(theme)) {
    const item = document.createElement("span");
    item.textContent = itemData.label;

    if (itemData.className) {
      item.classList.add(itemData.className);
    }

    if (itemData.title) {
      item.title = itemData.title;
    }

    meta.append(item);
  }

  const download = node.querySelector("a[download]");
  download.href = theme.downloadUrl;
  download.download = theme.fileName;
  download.setAttribute("aria-label", `Download ${theme.name}`);

  node.addEventListener("click", (event) => {
    if (isCardClickIgnored(event.target)) {
      return;
    }

    openThemeDetailsDialog(theme);
  });

  return node;
}

function isCardClickIgnored(target) {
  return Boolean(target.closest("a[download], .preview-arrow"));
}

function isThemeDownloadClick(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  const link = target.closest("a[download]");
  return Boolean(link?.download?.endsWith(".yatsutheme"));
}

function showInstallToast() {
  if (!installToast) {
    return;
  }

  window.clearTimeout(installToastTimer);
  window.clearTimeout(installToastHiddenTimer);
  installToast.hidden = false;
  window.setTimeout(() => {
    installToast.classList.add("is-visible");
  }, 0);
  installToastTimer = window.setTimeout(() => {
    installToast.classList.remove("is-visible");
    installToastHiddenTimer = window.setTimeout(() => {
      installToast.hidden = true;
    }, 180);
  }, 5200);
}

function createThemePreview(theme, className = "") {
  const preview = template.content.querySelector(".theme-preview").cloneNode(true);

  if (className) {
    preview.classList.add(className);
  }

  populateThemePreview(preview, theme);
  return preview;
}

function populateThemePreview(preview, theme) {
  const books = preview.querySelector(".mock-books");
  const slides = Array.from(preview.querySelectorAll(".preview-slide"));
  const previousPreview = preview.querySelector(".preview-arrow-previous");
  const nextPreview = preview.querySelector(".preview-arrow-next");

  preview.classList.remove("has-screenshots");
  preview.setAttribute("style", getPreviewStyle(theme.theme));
  setPreviewIndex(preview, 0);

  if (theme.screenshots?.library && theme.screenshots?.reader) {
    preview.classList.add("has-screenshots");
    slides[0].replaceChildren(createScreenshotImage(theme.screenshots.reader, `${theme.name} reader screenshot`));
    slides[1].replaceChildren(createScreenshotImage(theme.screenshots.library, `${theme.name} library screenshot`));
  } else if (books) {
    books.replaceChildren();

    for (const title of sampleBooks) {
      const book = document.createElement("div");
      book.className = "mock-book";
      book.innerHTML = `<span class="mock-cover"></span><span>${escapeHtml(title)}</span>`;
      books.append(book);
    }
  }

  previousPreview.addEventListener("click", () => {
    setPreviewIndex(preview, getPreviousPreviewIndex(preview));
  });
  nextPreview.addEventListener("click", () => {
    setPreviewIndex(preview, getNextPreviewIndex(preview));
  });
}

function createScreenshotImage(src, alt) {
  const image = document.createElement("img");
  image.className = "preview-screenshot";
  image.src = src;
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function getPreviousPreviewIndex(preview) {
  return preview.dataset.previewIndex === "1" ? 0 : 1;
}

function getNextPreviewIndex(preview) {
  return preview.dataset.previewIndex === "1" ? 0 : 1;
}

function setPreviewIndex(preview, index) {
  const normalizedIndex = index === 1 ? 1 : 0;
  const track = preview.querySelector(".preview-track");
  const indicators = Array.from(preview.querySelectorAll(".preview-indicators span"));
  const previous = preview.querySelector(".preview-arrow-previous");
  const next = preview.querySelector(".preview-arrow-next");
  const targetLabel = normalizedIndex === 0 ? "library" : "reader";

  preview.dataset.previewIndex = String(normalizedIndex);
  track.style.transform = `translateX(-${normalizedIndex * 100}%)`;
  previous.setAttribute("aria-label", `Show ${targetLabel} preview`);
  next.setAttribute("aria-label", `Show ${targetLabel} preview`);

  indicators.forEach((indicator, indicatorIndex) => {
    indicator.classList.toggle("is-active", indicatorIndex === normalizedIndex);
  });
}

function getPreviewStyle(theme) {
  return [
    ["--preview-bg", theme.backgroundColor],
    ["--preview-font", theme.fontColor],
    ["--preview-accent", theme.accentColor],
    ["--preview-accent-fg", theme.accentTextColor],
    ["--preview-link", theme.linkColor],
    ["--preview-muted", theme.mutedTextColor],
    ["--preview-chrome-bg", theme.readerChromeBackgroundColor],
    ["--preview-chrome-border", theme.readerChromeBorderColor],
    ["--preview-selection-bg", theme.selectionBackgroundColor],
    ["--preview-selection-fg", theme.selectionFontColor],
    ["--preview-footer", theme.tooltipTextFontColor]
  ]
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

function getMetaItems(theme) {
  return [
    theme.tags.includes("built-in") ? { label: "Built-in" } : undefined,
    theme.hasSupporterOnlySettings
      ? {
          label: "Supporter settings",
          className: "is-supporter",
          title: "Full import uses settings available to Yatsu Supporters."
        }
      : undefined,
    theme.hasBackgroundImages ? { label: "Background image" } : undefined,
    theme.hasTypography ? { label: "Typography" } : undefined
  ].filter(Boolean);
}

function openThemeDetailsDialog(theme) {
  detailsDialogPreview.replaceChildren(createThemePreview(theme, "theme-dialog-carousel"));
  detailsDialogTitle.textContent = theme.name;
  detailsDialogDescription.textContent = theme.description || "A curated Yatsu Reader theme.";
  renderSwatches(detailsDialogSwatches, theme);
  detailsDialogList.replaceChildren(
    detailItem("Author", theme.author || "Unknown"),
    detailItem("Mode", theme.mode),
    detailItem("File", theme.fileName),
    detailItem("Background", theme.hasBackgroundImages ? "Included" : "None"),
    detailItem("Typography", theme.hasTypography ? "Included" : "None"),
    detailItem("Supporter settings", getSupporterSettingsDescription(theme)),
    detailItem("Tags", theme.tags.length ? theme.tags.join(", ") : "None")
  );
  detailsDialogDownload.href = theme.downloadUrl;
  detailsDialogDownload.download = theme.fileName;
  detailsDialogDownload.setAttribute("aria-label", `Download ${theme.name}`);
  detailsDialog.showModal();
}

function renderSwatches(container, theme) {
  container.replaceChildren();

  for (const key of swatchKeys) {
    const color = theme.theme[key];

    if (!color) {
      continue;
    }

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    swatch.title = `${key}: ${color}`;
    container.append(swatch);
  }
}

function getSupporterSettingsDescription(theme) {
  const settings = Array.isArray(theme.supporterOnlySettings)
    ? theme.supporterOnlySettings.filter(Boolean)
    : [];

  if (!settings.length) {
    return "None";
  }

  return `${capitalize(settings.join(", "))}. Full import requires Yatsu Supporter.`;
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
}

function detailItem(term, description) {
  const fragment = document.createDocumentFragment();
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = description;
  fragment.append(dt, dd);
  return fragment;
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
