# Yatsu Themes

Static curated theme catalog for `themes.yatsu.moe`.

## Add a Theme

1. Put the `.yatsutheme` file in `themes/`.
2. Optionally add a sidecar file named the same way with `.meta.json`.
3. Run `npm run build`.
4. Preview locally with `npm run preview`.

Example sidecar:

```json
{
  "name": "Quiet Ink",
  "description": "A low-glare reader theme with restrained chrome.",
  "author": "Lorenzo",
  "updatedAt": "2026-05-25T00:00:00.000Z",
  "tags": ["dark", "low-glare"]
}
```

The build script accepts both legacy JSON `.yatsutheme` files and packaged
`.yatsutheme` zip files with a `manifest.json`. Packaged reader/library
background images are extracted into the static artifact for previews.
Custom themes that include Yatsu Supporter-only import settings are marked in
the catalog and details dialog. Built-in Yatsu themes are treated as built-in
availability, even if their bootstrap files contain extended theme colors.

## Generate Screenshots

Install dependencies once, then generate the standard screenshot set with the
real Yatsu app:

```bash
npm install
npm run screenshots -- --force
```

The screenshot harness starts the sibling Yatsu app from `../ebook-reader`,
imports local EPUBs in `sample-books/` through Yatsu's own import code, applies
each theme through Yatsu's theme importer, and captures the real `/library` and
`/b` reader routes. The reader screenshot includes Yatsu-rendered highlights for
all highlighter colors, an active text selection, and the table of contents panel.

`sample-books/` is intentionally ignored by git. Keep local EPUB fixtures there
when regenerating screenshots; the published site uses the checked-in images in
`docs/screenshots/`.

```text
docs/screenshots/<theme-id>-library.png
docs/screenshots/<theme-id>-reader.png
```

It runs the catalog build before and after capture so `docs/catalog.json`
points at the generated screenshots. Use `npm run build` after deleting
screenshots if you want the website to fall back to live HTML previews.

Useful overrides:

```bash
YATSU_APP_DIR=/path/to/ebook-reader npm run screenshots -- --force
YATSU_APP_URL=http://127.0.0.1:5174 npm run screenshots -- --force
YATSU_SCREENSHOT_BOOK_LIMIT=4 npm run screenshots -- --force
```

The older deterministic static renderer is still available as a fallback:

```bash
npm run screenshots:static -- --force
```

## Bootstrap Defaults

The six built-in Yatsu themes are generated from the local default theme table:

```bash
npm run bootstrap
npm run build
```

## GitHub Pages

GitHub Pages is configured to publish the checked-in `/docs` folder from
`main`, so every push to `main` deploys the current static site. Configure the
Pages custom domain as `themes.yatsu.moe`, then point the DNS `CNAME` for
`themes` at the relevant `github.io` Pages host.
