# Changelog

All notable changes to FigmaToCode. Versions map to phcode store releases.

## [Unreleased]
### Fixed
- **Icons and logos no longer fragment or go missing (token path).** The generator
  exported every individual vector path as its own image, so multi-path icons
  shredded into pieces and a single 156-path icon blew the whole export budget,
  leaving other icons as empty bordered boxes. Now a small all-vector group (an
  icon/logo) exports as ONE image, degenerate/thin nodes (lines) are not
  rasterized, and 0-weight strokes no longer draw spurious borders. Whole-page
  fidelity is substantially improved. (One unusual "logos row" structure can still
  garble; targeted fix is future work.)

## [1.0.5]
### Added
- **Design tokens as CSS custom properties.** Colors backed by a reused Figma
  color style are now emitted once in `:root` (e.g. `--orange-1: rgba(...)`) and
  referenced with `var(--orange-1)` at each usage, instead of inlining the hex
  everywhere. Change one line, the whole page updates. Files without color styles
  are unchanged. (Figma Variables and spacing tokens need the Enterprise-only
  Variables REST API, so they are out of scope for now.)
### Added (tests)
- Error-path, perf/pathological, and golden-snapshot test suites; CI on all branches.

## [1.0.4]
### Added
- **Paid path without the Figma plugin/OAuth.** "Send to Claude" now gathers the
  design with just the personal token (rendered preview + exported icons + raster
  image fills + a bounded layer structure) and packs it into the AI-panel prompt.
  Both tiers now use a single token paste; the paid tutorial/settings drop the
  plugin-install and authorize steps.
- **Token validation on save** - saving a token verifies it against Figma and
  shows "Connected as <you>" or a clear error.
- **Generator tests** (`test/generator.test.js`) and **CI** (`.github/workflows/ci.yml`):
  syntax, generator behaviour, and a release-manifest guard that fails if any
  `package.json` "files" entry is missing from the publish zip.

### Changed
- Friendlier, actionable Figma error messages (invalid/expired token, 404, 429,
  offline, server errors).
- Warn when the 120-icon export cap is hit.

### Security
- **Style-attribute injection hardened (found by fuzzing).** A Figma font name
  containing `"`/`<` could break out of the generated inline `style` and inject
  markup into the output opened in Live Preview (XSS). Fixed at two levels:
  font names are sanitized to a safe charset, AND every assembled `style=""`
  value now passes through `styleAttr()` which strips `"`/`<`/`>` - so no
  untrusted Figma field (font-weight, text-align, padding, stroke, radii, etc.)
  can break out of the attribute, regardless of a crafted file. The fuzzer
  injects poison into all of these and asserts no HTML injection.
- Security audit (Phoenix extension): no `eval`/`innerHTML`-with-untrusted/
  `postMessage`/prototype-merge sinks; all UI HTML is `esc()`-escaped; zero npm
  dependencies; token stored locally in Phoenix prefs only, never uploaded.

### Fixed
- Panel re-mounts if it was ever detached from the DOM (toolbar button could
  otherwise silently no-op).

### Testing
- `test/stress.test.js` + `test/harness.js`: seeded fuzzer (thousands of
  synthetic Figma trees) + edge cases asserting the generator and paid-path
  prompt builder never throw / emit `undefined`/`NaN` / break HTML escaping,
  plus `figmaGet` error-mapping and `parseFigmaUrl` cases. Wired into CI.

## [1.0.3]
### Fixed
- Store build shipped without `logo.png` (toolbar icon) and `hero.jpg` (tutorial
  banner); both are now included in `extension.zip`.

## [1.0.2]
### Added
- **Raster image fills** - screenshots/photos that rendered as blank boxes now
  embed as CSS `background-image` with `background-size` from `scaleMode`
  (FILL/CROP→cover, FIT→contain, TILE→repeat), fetched via the Get-Image-Fills
  endpoint. Overlaid children survive; base color/gradient stays under the image.

## [1.0.1]
### Added
- Auto-layout→flexbox, real sizing model (`layoutSizing*`), multi-style text runs,
  constraints mapping, native-width root. Import UI redesign (removed seat toggle).

## [1.0.0]
- Initial release: paste a Figma frame link, preview, and convert to HTML/CSS
  with exported icons. Free (token/REST) and paid (Send to Claude) paths.
