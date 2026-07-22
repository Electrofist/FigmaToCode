# FigmaToCode — Complete Handoff (from v1.0.0 to now)

This is the single source of truth for continuing FigmaToCode with zero context
loss. It covers the whole history, the architecture, how to develop/test safely,
the security posture, the exact current state, and what to do next. Read it fully
before touching anything.

---

## 1. What this is
A **Phoenix Code** extension (plain JS + jQuery, **no build step**) that turns a
Figma frame link into HTML/CSS inside a floating panel. Two tiers:
- **Free seat** — user pastes a Figma **personal access token**; the extension
  uses Figma's REST API to preview frames and generate HTML/CSS locally (real
  icons/images exported). Approximate but instant, offline-ish, no LLM.
- **Paid / Dev seat** — **"Send to Claude"** gathers the design via the same
  token and injects a rich prompt into the Phoenix AI panel; Claude produces
  pixel-perfect, semantic code. (As of the unreleased work below, the paid path
  no longer needs the Figma plugin/OAuth — just the same token paste.)

## 2. Locations
- **Source repo:** `/Users/krisby/Documents/Phoenix Code/FigmaToCode`
- **GitHub:** https://github.com/Electrofist/FigmaToCode (owner **Electrofist**)
- **Installed extension (what Phoenix actually loads):**
  `/Users/krisby/Library/Application Support/io.phcode/assets/extensions/user/FigmaToCode`
- **Test project (generated files land here):** `/Users/krisby/Documents/Phoenix Code/default project`
- **phcode store registry (live):** `https://extensions.phcode.dev/registry.json`
  (key `github-electrofist-figmatocode`)
- **This handoff + CHANGELOG.md** live in the repo root on the working branch.

## 3. Shipped files vs repo files
- **Shipped to the store** (via the publish workflow zip, and listed in
  `package.json` "files"): `main.js`, `style.css`, `package.json`, `logo.png`,
  `hero.jpg`, `LICENSE`. **Nothing else ships** — tests, scripts, docs, CI,
  screenshots, HANDOFF, CHANGELOG are all repo-only.
- Repo also has: `README.md`, `CHANGELOG.md`, `HANDOFF.md`, `.gitignore`,
  `screenshots/`, `test/`, `scripts/`, `.github/workflows/`.

---

## 4. Version history (the whole story)

### v1.0.0 — Initial release (commit 8980cec, tag V.01)
First working extension: paste a Figma frame link → preview → convert to HTML/CSS
with exported icons. Free (token/REST) + paid (Send to Claude) paths. Import UI
had a "Free seat / Paid seat" **segmented toggle** (later removed). Published to
the phcode store as 1.0.0.

### v1.0.1 — Generator overhaul + UI redesign (commits 1df8092, 4dd9fc9, 6501ef0; tag V.03)
- Import UI redesign: removed the seat toggle, seamless Claude-style composer,
  header + hint, squared send button. (This is why an old install showing the
  "Free seat / Paid seat" toggle is running stale v1.0.0.)
- **Real generator** replacing the old flat/absolute trace:
  - Figma **auto-layout** → **flexbox** (`flex-direction`, `gap`=itemSpacing,
    `padding`, `justify-content`, `align-items`, `flex:1` for grow,
    `align-self:stretch` for STRETCH).
  - **Sizing model** driven by `layoutSizingHorizontal/Vertical`: HUG→fit-content
    (+`flex-shrink:0` on main axis), FILL→`flex:1 1 0`/`align-self:stretch`,
    FIXED→px.
  - **Multi-style text**: `characterStyleOverrides`+`styleOverrideTable` → `<span>`
    runs; text height auto, width auto only when `WIDTH_AND_HEIGHT`.
  - **Constraints** (`constraintDecls`): LEFT/RIGHT/CENTER/LEFT_RIGHT/SCALE per
    axis → CSS anchoring for absolutely-positioned children.
  - Root renders at **native design width, centered, no max-width cap**.
- Result: ~92-95% visual fidelity + faithful reflow. Published as 1.0.1.
- Note: V.02 (commit 4dd9fc9) FAILED to publish because it re-used version 1.0.0
  (the store rejects a re-used version). Always bump `package.json` before a
  release. (Deleting the failed V.02 GitHub release is a harmless optional chore.)

### v1.0.2 — Image fills (commits b08b382, fa899f0; tag V.04)
Raster IMAGE fills (screenshots/photos) used to render as **blank boxes**.
- Root cause: fill detection used `firstVisible(fills)` (first paint only), so an
  IMAGE layered over a base color (`fills=[SOLID,IMAGE]`) or not at index 0 was
  never detected; and image nodes competed with icons for the `MAX_ASSETS=120`
  flat-export slots.
- Fix: detect an IMAGE fill anywhere (`topImageFill`), fetch raw source images
  once via the **Get-Image-Fills endpoint** (`GET /files/:key/images`, keyed by
  `imageRef` — one request, uncapped, deduped, no overlaid children baked in),
  and embed as `background-image` with `background-size` from `scaleMode`
  (FILL/CROP→cover, FIT→contain, TILE→repeat, STRETCH→100% 100%). Overlaid
  children survive; base color/gradient stays under the image. Vectors/icons keep
  the flat `<img>` path.
- Verified on the Phoenix landing frame (25 image-fill nodes → 24 backgrounds, 16
  sources). Published as 1.0.2.

### v1.0.3 — Store-packaging fix (commit 98e1c4b; tag V.05) — CURRENT PUBLISHED
- The publish workflow's `zip` line never included `logo.png` / `hero.jpg`, so
  **every store release 1.0.0–1.0.2 shipped without the toolbar icon and tutorial
  banner** (desktop was unaffected only because it kept local copies). Fixed the
  zip to include them. Published as 1.0.3 — this is the current live store version.

### v1.0.4 — UNRELEASED (on branch `paid-path-automation`, 6 commits ahead of main)
Everything below is committed locally but **NOT pushed / NOT released**. When
shipping, bump `package.json` 1.0.3 → 1.0.4, merge to `main`, push, cut a release.

1. **Paid path without the Figma plugin/OAuth** (7fc3240). `sendToClaude` is now
   async + token-based (like the free path): fetches node JSON, renders a
   high-res preview, exports icons + image fills, and packs a rich prompt
   (rendered-image URL + exact asset URLs + bounded 220-line layer structure)
   into the AI panel via `fillClaudeInput` + `.ai-send-btn`. Falls back to
   clipboard if no panel. **Both tiers now require a token**: the paid tutorial +
   settings use the token field (plugin-install/authorize steps and `PLUGIN_CMD`
   removed); the settings red dot shows whenever a token is missing. Keeps the
   Figma MCP as an optional "prefer it if available" hint.
   - IMPORTANT finding: the Phoenix AI composer is **text-only** (no image
     attach). So the prompt can't hand Claude a real image directly; it grounds
     on structure + exact asset URLs + the rendered-image URL (with a "download
     it and Read it" instruction that works when the panel's Claude has those
     tools). Adjust here if you want stronger visual grounding.
2. **Generator tests + CI** (0f42ccd) — see §7.
3. **Token trust/UX, errors, robustness, CHANGELOG** (ff7dc49): validate token on
   save (`/me` → "Connected as <you>" or clear error), friendlier `figmaGet`
   errors (401/403/404/429/5xx/offline), `openPanel` re-mounts if detached,
   warn on the 120-icon cap, add `CHANGELOG.md`.
4. **UI fixes + asset guard rail** (0f11265): **embed logo.png + hero.jpg as
   base64 data URIs in `style.css`** (relative `url()` only resolved next to the
   served stylesheet — broke in hot-swap and dropped from the store zip; data
   URIs render everywhere). Fixed token-field↔Save-button height mismatch and the
   Preview-resolution `<select>` clipping.
5. **Security: font-family injection fix + fuzzer** (1eeafa8) and **style-attr
   hardening** (f22f772) — see §8.

---

## 5. Architecture (main.js — one file, ~1160 lines)
- **Panel/UI:** `renderPanel` → `renderImport` / `renderTutorial` / `renderSettings`;
  `renderNav` (red dot on the settings gear when no token). Panel `#f2c-panel`,
  toolbar button `#f2c-toolbar-btn`. `openPanel`/`closePanel`/`togglePanel`
  (openPanel re-mounts `$panel` if detached).
- **Figma REST:** `figmaGet(path)` (adds `X-Figma-Token`, maps HTTP errors to
  friendly messages), `fetchImages(key, ids, scale)` (node-render → PNG URLs),
  `fetchImageFills(key)` (Get-Image-Fills → imageRef→URL), `collectFrames`,
  `parseFigmaUrl` (file key + node id; `1-2`→`1:2`), `frameUrl`.
- **Generator (free path):** `chan`/`colorToCss`/`gradientCss`/`backgroundFromFills`,
  `radiusCss`, `shadowCss`, `isAsset` + `collectAssetIds` (vectors/icons → flat
  img), `topImageFill`/`collectImageRefs`/`scaleModeDecls`/`imageFillDecls`
  (raster fills → CSS background), `px`, **`styleAttr`** (assembles every inline
  `style=""`, strips `"`/`<`/`>` — injection chokepoint), `visualDecls`,
  `safeFontFamily`/`fontFamilyDecl`, `textDecls`, `runStyleCss`, `textInner`,
  `flexDecls`, `axisDecls`, `constraintDecls`, `layoutDecls`, `renderNode`,
  `generateFromNode`.
- **Paid path:** `nodeSummary`/`structureOutline`/`assetLines`/`buildClaudePrompt`
  (compose the prompt), `fillClaudeInput` (native textarea value setter + input
  event), `sendToClaude`.
- **Actions:** `loadUrl`, `getCodeForSelected` (free), `sendToClaude` (paid),
  `writeAndOpen` (open Document setText+save, else `FileUtils.writeText(file,
  text, true)` blind write to beat CONTENTS_MODIFIED), `saveTokenAndValidate`.
- **Storage:** `PreferencesManager.getExtensionPrefs("figmaToCode")` — keys:
  `token`, `seat` ("free"|"paid"|""), `onboarded`, `scale`, `lastUrl`.
- **CSS:** `style.css` — fixed dark zinc theme; logo/hero are inline data URIs;
  Phoenix's global input/select styling is reset inside `#f2c-panel`.
- **AI panel selectors (host):** input `.ai-chat-textarea`, send `.ai-send-btn`.

---

## 6. Dev/test workflow — HOT-SWAP (never reload the editor)
**NEVER `window.location.reload()` the editor — it signs the user out of Phoenix.**
Run edited code live via `execJsInEditor` (read from the repo dir; VFS paths are
prefixed with `/tauri`):
```js
const FileSystem = brackets.getModule("filesystem/FileSystem");
const dir = "/tauri/Users/krisby/Documents/Phoenix Code/FigmaToCode";
const read = p => new Promise((res,rej)=>FileSystem.getFileForPath(p).read({},(e,d)=>e?rej(e):res(d)));
const js = await read(dir+"/main.js");
const css = await read(dir+"/style.css");            // logo/hero are data URIs now — no url rewriting needed
$("#f2c-css-hotswap").remove(); $('<style id="f2c-css-hotswap">').text(css).appendTo("head");
$("#f2c-panel").remove(); $("#f2c-toolbar-btn").remove();
$(document).off("mousedown.f2c keydown.f2c"); $(window).off("resize.f2c");
let body = js.replace('define(function (require, exports, module) {','(function (require, exports, module) {')
             .replace('ExtensionUtils.loadStyleSheet(module, "style.css");','')
             .replace(/\}\);\s*$/,'})(function(){}, {}, {});');
eval(body);
```
Then drive via DOM: `#f2c-toolbar-btn` click, set prefs, `.f2c-nav-btn[data-view=...]`,
`.f2c-url`, `.f2c-load-btn`, `.f2c-frame`, `.f2c-getcode-btn`, poll `.f2c-status`.
- **Gotcha:** don't leave a `.ai-send-btn` click-blocker installed when testing
  the paid path, and don't let `sendToClaude` auto-submit during tests — it fires
  a real Claude run in the panel. Prefer testing prompt CONTENT offline via
  `test/harness.js` (extracts the real functions) rather than driving the panel.
- **Screenshots:** capture the full editor window (the panel is a fixed overlay);
  `takeScreenshot` can't composite the floating panel over the live-preview iframe.
- **Apply for real (after approval):** `cp main.js style.css <installed dir>/` —
  loads on next Phoenix restart. Or update from the store after a release.
- **Registry cache is sticky:** the extension manager caches
  `registry.json`; a page hard-refresh does NOT refresh it. Force it with
  `ExtensionManager.downloadRegistry()` (desktop) or unregister the service
  worker (web PWA: DevTools → Application → Service Workers → Unregister).

## 7. Testing & CI (repo-only, never ships)
- `test/harness.js` — extracts the REAL pure functions from `main.js` (generator,
  paid prompt, `parseFigmaUrl`, `figmaGet`) so tests exercise shipping code, no
  editor/network.
- `test/generator.test.js` — 14 behaviour tests (image fills, flexbox, sizing,
  text, root).
- `test/tokens.test.js` — 19 tests for Figma color-style -> CSS custom property
  emission (naming, reuse, stroke styles, collisions, no-styles no-regression,
  no-dangling-var invariant).
- `test/errors.test.js` — 17 tests: `figmaGet` exact friendly message per status
  (401/403/404/429/5xx/offline/no-token/ok) + `collectFrames` crafted/hostile
  responses (null/empty/wrong-types/MAX_FRAMES cap/hostile names, no throw).
- `test/perf.test.js` — large/pathological ceilings (150 assets, ~5.5k-node tree,
  depth-1000 chain) with timing budgets + cap assertions.
- `test/snapshot.test.js` — golden-snapshot regression: a fixed reference frame's
  generated HTML is diffed against `test/__snapshots__/reference.html`. Update
  intentionally with `UPDATE_SNAPSHOT=1 node test/snapshot.test.js`.
- `test/stress.test.js` — **seeded fuzzer** (12 seeds × 60 trees = 720/run,
  ~9,400 assertions) generating random Figma trees + poison-injection into names/
  text/font/numeric/enum fields; asserts: never throws, no `undefined`/`NaN`/
  `:null`, no HTML injection (strip known tags → no stray `<`), no `javascript:`,
  no `<`/`>` inside any style attr, MAX_ELEMENTS cap. Plus `figmaGet` error-map
  and `parseFigmaUrl` cases.
- `test/assets.test.js` — fails if `style.css` uses a relative raster `url()`
  (must be data: URIs).
- `scripts/check-release-manifest.js` — fails if any `package.json` "files" entry
  is missing from the publish zip or disk, or version isn't semver. **This guard
  would have caught the missing-logo bug.**
- Run all: `npm run check` (syntax + generator + tokens + errors + perf + snapshot
  + assets + stress + manifest; ~9,495 assertions). `.github/workflows/ci.yml`
  runs them on **every push (any branch) and PR**, so feature branches get CI
  signal before merge.
- **Known test gaps (deliberate, low-ROI for a no-deps extension):** no full DOM
  panel-integration suite (needs jsdom/deps; panel strings are already `esc()`'d
  and the render code is simple) and no pixel-diff visual regression (the golden
  snapshot covers silent output changes instead). Add these only if the project
  gains a build pipeline.

## 8. Security posture
Audited against the standard injection checklist. This is a Phoenix (Brackets)
extension, so Chrome-MV3 items (manifest CSP, host_permissions,
web_accessible_resources, chrome.runtime/sender.id, remote code) are N/A.
- **Bug found + fixed (XSS):** `font-family` inserted the raw Figma font name into
  the inline `style=""` (stripping only `'`), so a name like `x"><script>` broke
  out and injected markup into the generated file opened in Live Preview. Fixed
  with `safeFontFamily` + the `styleAttr()` chokepoint that strips `"`/`<`/`>`
  from EVERY assembled style value — so no untrusted Figma field can break out,
  even from a crafted file. Fuzzer proves it.
- Clean: no `eval`/`innerHTML`-with-untrusted/`postMessage`/prototype-merge sinks;
  all UI HTML `esc()`-escaped; **zero npm dependencies**; token stored only in
  local Phoenix prefs (user's own PAT, never uploaded, documented in Settings).
- If you add any new place data is rendered into HTML/CSS, route inline styles
  through `styleAttr()` and text/attributes through `esc()`, and add a fuzz
  invariant.

---

## 9. HARD RULES (do not violate)
- **Author every commit as `Krrish <krrishparmar11@gmail.com>`**
  (`git commit --author="Krrish <krrishparmar11@gmail.com>"`). **NEVER** add
  Claude as author/committer/`Co-Authored-By`.
- **ASK before every `git push`.** Local commits are fine; pushing needs the OK.
- **NEVER reload the editor** (`window.location.reload`) — use hot-swap (§6).
- **Avoid em dashes** in UI text and prose (use hyphens/commas).
- **No `gh` CLI / no GitHub token** on this machine. Creating releases needs the
  user's browser login. SSH push works (`git@github.com:Electrofist/FigmaToCode.git`).
- **Secrets:** never paste tokens in chat or commit them. Set the Figma token via
  the panel Settings gear (writes to prefs); a session reads it from
  `PreferencesManager` without it touching the transcript.

## 10. Current state + pending (read carefully)
- **`main`** = published **v1.0.4** (tag `V.06`), live in the store. Adds the
  token-based paid path, security hardening, UI fixes, and the test suite (§4).
- **`design-tokens`** = CURRENT work branch off `main`. Adds design tokens
  (color styles -> CSS custom properties, §4) + the errors/perf/snapshot tests +
  broadened CI. `npm run check` fully green. This is the **v1.0.5 / tag V.07**
  payload. Bump package.json 1.0.4 -> 1.0.5, merge to `main`, push, cut release.
- **`paid-path-automation`** = merged into `main` (v1.0.4); safe to delete.
- **`token-accuracy`** = historical branch; older HANDOFF. Stale; this supersedes.

### Pending user-only chores (auth-gated)
- **ROTATE THE FIGMA TOKEN — NOT DONE.** Confirmed this session: the token stored
  in prefs (`figd_nHnPZ...`) is the exact one that leaked into a transcript, and
  it still returns `200/active` on `/me`. Create a new token (Figma → Settings →
  Security), **revoke this one**, and re-save via the panel Settings gear.
- Cut the **v1.0.5 / V.07** release once merged/pushed.
- Optional: delete the failed **V.02** GitHub release.

## 11. Gotchas learned
- Store zip must include EVERY runtime asset (the logo/hero omission). The
  manifest guard now enforces this.
- Relative `url()` in CSS is fragile across contexts → images are data URIs now.
- Registry caches are sticky (see §6). Publishing ≠ instantly visible.
- The store rejects a re-used version → always bump before release.
- Asset export URLs expire ~7 days; for committed output, embed bytes.
- The Phoenix AI composer is text-only (no image attach) — affects paid grounding.
- Figma MCP `get_design_context` 403s on files without Dev-Mode access, but the
  REST token reads them fine (that's why the free path proved image fills).

## 12. Test data (real Figma, used this session)
- Phoenix landing file `XBsd8MNkBEkqNs4GTyTgIX`, node `15:455` (tall, ~25 image
  fills) — the image-fills proof.
- Pricing file `itAEtcKQNpHvZeKfeWnyfV`, node `23:20941` — earlier accuracy proof
  (token access may vary).

## 13. Roadmap / next steps (ranked by leverage)
1. **Responsive / breakpoints** — biggest gap for the "pixel-perfect" claim. The
   generator renders at native width with no reflow. If Figma has width variants
   of the same frame, detect them and emit media queries. Highest fidelity win.
2. **Design tokens / variables** — DONE for color styles (v1.0.5). Extend to Figma
   **Variables** (spacing/typography) when there's a way to resolve them (the
   Variables REST API is Enterprise-only; today it 403s).
3. **Framework export target (React component)** — biggest differentiation: turns
   "generates a static file" into "something a dev drops into a codebase." Bigger
   lift; likely a paid-path/LLM feature.
4. **Batch / multi-frame export** — smaller lift, clear utility (convert a whole
   page of frames in one pass).
- **Paid path**: stronger visual grounding (download the rendered PNG locally and
  have the panel's Claude `Read` it) now that the composer is known text-only.
- **§8.5 polish (lower priority):** SVG export for vectors, rotation via
  `relativeTransform`, masks, layer/background blur, multiple shadows, blend modes.
- **§8.6 (cleaner output):** dedupe repeated inline styles into CSS classes;
  sanitized layer names as class names.
  - **HARD RULE when building §8.6:** class names come from untrusted Figma layer
    names, so sanitize AND add a fuzz invariant BEFORE ship (same class as the
    font-family XSS). Never let generated class/selector names land un-fuzzed.
- Ceiling reality: REST output stays mechanical (div soup, no semantics). Semantic
  / framework-aware / human-quality code is the LLM's job (the paid path).

---
*Handoff written 2026-07-23. Supersedes the older HANDOFF.md on `token-accuracy`.*
