# Changelog

All notable changes to FigmaToCode. Versions map to phcode store releases.

## [Unreleased] - 1.0.7 UX pass
### Changed
- **Paste = load.** A valid link loads on its own; Enter and the arrow still
  work. A token pasted into the link box is saved instead of rejected. A thin
  progress line runs along the top while anything is working. A link to one
  frame shows one large preview. Cmd/Ctrl+Enter runs the main button.
- **One flow, two actions.** The "Free seat / Paid seat" question is gone (both
  paths always used the same personal token). Import now offers **Quick convert**
  (local, instant, approximate) and **Build with AI** (Phoenix AI panel, slower,
  close match) side by side; the last one used becomes the primary button.
- **Build with AI fills the chat box but does not press Send.** You review the
  prompt first. The panel stays open with a "Go to AI panel" card. It no longer
  claims "Sent" when nothing was sent.
- **Icons and images are downloaded into the project** (`figma/assets/<frame>/`)
  for both actions, so generated pages keep working after Figma's export URLs
  expire (about 7 days). Downloads that fail fall back to the URL and are counted
  in the result message. Build with AI also saves a `design.png` for the AI to read.
- **Output goes to a folder** (`figma/` by default, changeable in Settings)
  instead of the project root.
- Settings "Preview resolution" became "Design image for Build with AI" and now
  actually controls that render. Thumbnails always load at 1x (faster, fewer
  failures).
### Fixed
- Empty or invalid token/link input was accepted silently; now refused inline
  with a message. The token is checked with Figma BEFORE it is saved. The
  welcome guide cannot finish without a working token.
- A saved token that Figma has revoked no longer shows as "saved, ready"; the
  panel says so and offers "Replace token". A token that works but cannot open a
  file gets its own message.
- Existing output files were overwritten silently (even with unsaved edits open);
  now asks Replace / Keep both / Cancel.
- Non-Latin frame names all became `figma-figma.html`; file names now keep any
  script and avoid collisions (`home-2.html`).
- Frames inside Sections/Groups were missing from whole-file loads; page,
  section and single-layer links were treated as one "frame"; FigJam/Slides/
  Sites/Make links gave a misleading error. All handled with clear messages.
- Files with more than 40 frames said nothing about the cut; now "Showing 40 of
  N", with a filter box, frame sizes and page names on tiles.
- Double clicks fired jobs twice; a stale load could overwrite a newer one; the
  job target could change mid-run when another frame was clicked.
- Clicking outside the panel closed it while a job was running (result lost).
  The panel now stays while busy or waiting for an answer.
- Light editor theme was detected but never styled; the panel is now readable
  in light themes.
- Keyboard: focus survives re-renders, opens into the panel and returns to the
  toolbar button on close, Escape only acts when the panel has focus, arrow keys
  move between frames, status changes are announced to screen readers.
- Clipboard fallback reported "copied" even when copying failed.
- Branch links loaded the main file instead of the branch.
### Added (tests)
- `test/inputs.test.js`: link/token input checks, link kinds, Unicode slugs,
  sections/cap in `collectFrames`, token override in `figmaGet` (38 checks).

## [1.0.6 - unreleased notes]
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
