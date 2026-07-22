# Changelog

All notable changes to FigmaToCode. Versions map to phcode store releases.

## [Unreleased]
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

### Fixed
- **Security: font-family injection.** A Figma font name containing a `"`/`<`
  could break out of the generated inline `style` attribute (`x"><script>...`),
  injecting markup into the output opened in Live Preview. Font names are now
  sanitized to a safe character set. Found by the fuzz suite.
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
