/*global define, brackets, $ */

// Phoenix Code - FigmaToCode
// Paste a Figma link -> preview the frame -> pull it into your project.
//
// Two tiers, chosen during onboarding:
//   • Paid / Dev-Mode seat  -> "Send to Claude": copies a ready prompt that drives
//                              the Figma MCP (get_design_context) for accurate output.
//   • Free seat             -> personal access token -> REST preview + a converter
//                              that ALSO exports real icons/images and loads fonts.
//
// Same skeleton as the "todu" extension: define() shell, toolbar button, floating
// panel, PreferencesManager storage, theme-aware styling.

define(function (require, exports, module) {
    "use strict";

    // -------- Modules --------
    const AppInit            = brackets.getModule("utils/AppInit"),
          ExtensionUtils     = brackets.getModule("utils/ExtensionUtils"),
          PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
          ProjectManager     = brackets.getModule("project/ProjectManager"),
          CommandManager     = brackets.getModule("command/CommandManager"),
          Commands           = brackets.getModule("command/Commands"),
          FileSystem         = brackets.getModule("filesystem/FileSystem"),
          FileUtils          = brackets.getModule("file/FileUtils"),
          DocumentManager    = brackets.getModule("document/DocumentManager"),
          Menus              = brackets.getModule("command/Menus");

    ExtensionUtils.loadStyleSheet(module, "style.css");

    // -------- Constants --------
    const PANEL_WIDTH  = 380;
    const PANEL_GAP    = 8;
    const FIGMA_API    = "https://api.figma.com/v1";
    const MAX_FRAMES   = 40;
    const MAX_ELEMENTS = 6000;
    const MAX_ASSETS   = 120;
    const TOKEN_HELP_URL = "https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens";

    // -------- Storage --------
    const prefs = PreferencesManager.getExtensionPrefs("figmaToCode");
    function def(id, type, val) { try { prefs.definePreference(id, type, val); } catch (e) { /* already */ } }
    def("token",     "string",  "");
    def("onboarded", "boolean", false);
    def("scale",     "number",  2);
    def("lastUrl",   "string",  "");
    def("seat",      "string",  "");   // "paid" | "free" | ""

    function getToken()   { return (prefs.get("token") || "").trim(); }
    function setToken(v)  { prefs.set("token", (v || "").trim()); prefs.save(); }
    // Save a token then verify it against Figma (/me) so the user gets instant
    // confirmation ("Connected as …") or a clear error, instead of finding out later.
    // The token is only stored AFTER Figma accepts it, so a typo or a pasted link
    // can't silently become the saved token (that used to clear the red dot and
    // let people continue, then fail later on Load).
    function saveTokenAndValidate(v, after) {
        if (ui.tokenCheck && ui.tokenCheck.status === "checking") { return; }
        v = String(v == null ? "" : v).trim();
        ui.tokenDraft = v;
        const problem = checkTokenInput(v);
        if (problem) {
            ui.tokenCheck = { status: "err", msg: problem, field: true };
            renderPanel(); focusTokenField();
            return;
        }
        ui.tokenCheck = { status: "checking" };
        renderPanel();
        figmaGet("/me", v).then(function (me) {
            setToken(v);
            ui.tokenDraft = "";
            ui.tokenCheck = { status: "ok", who: me.email || me.handle || "you" };
            renderPanel();
            if (typeof after === "function") { after(); }
        }).catch(function (err) {
            const msg = (err && err.message) || "Token check failed.";
            ui.tokenCheck = { status: "err", msg: /rejected your token/.test(msg)
                ? "Figma didn't accept that token. Check you copied all of it, or create a new one."
                : msg, field: true };
            renderPanel(); focusTokenField();
        });
    }
    function focusTokenField() {
        setTimeout(function () { $body.find(".f2c-token-input").trigger("focus"); }, 0);
    }
    function tokenStatusHtml() {
        const c = ui.tokenCheck;
        if (!c) { return ""; }
        if (c.status === "checking") { return '<div class="f2c-status f2c-loading" role="status"><span class="f2c-spin"></span>Checking token with Figma…</div>'; }
        if (c.status === "ok") { return '<div class="f2c-status f2c-ok" role="status">✓ Connected as ' + esc(c.who) + '</div>'; }
        return '<div class="f2c-status f2c-err" role="alert">' + esc(c.msg) + '</div>';
    }
    // Token input row shared by the tutorial and Settings, so both behave the same
    // (Enter submits, error state, busy Save button, link to create a token).
    function tokenRowHtml(placeholder) {
        const c = ui.tokenCheck || {};
        const busy = c.status === "checking";
        const bad = c.status === "err" && c.field;
        return '<div class="f2c-row">' +
                '<div class="f2c-field' + (bad ? " f2c-field-err" : "") + '">' + svg("key") +
                    '<input type="password" class="f2c-token-input" autocomplete="off" spellcheck="false"' +
                    ' aria-label="Figma personal access token" placeholder="' + esc(placeholder) + '"' +
                    ' value="' + esc(ui.tokenDraft || "") + '"' + (busy ? " disabled" : "") + ' />' +
                '</div>' +
                '<button type="button" class="f2c-btn-white f2c-save-token"' + (busy ? " disabled" : "") + '>' +
                    (busy ? '<span class="f2c-spin f2c-spin-dark"></span>Checking' : "Save") + '</button>' +
            '</div>' +
            '<div class="f2c-note">No token? <button type="button" class="f2c-link" data-open-url="' + TOKEN_HELP_URL + '">Create one in Figma</button> (Settings, Security, Personal access tokens).</div>';
    }
    function isOnboarded(){ return !!prefs.get("onboarded"); }
    function setOnboarded(v){ prefs.set("onboarded", !!v); prefs.save(); }
    function getScale()   { const s = Number(prefs.get("scale")); return (s >= 1 && s <= 4) ? s : 2; }
    function setScale(v)  { prefs.set("scale", Number(v) || 2); prefs.save(); }
    function getSeat()    { return prefs.get("seat") || ""; }
    function setSeat(v)   { prefs.set("seat", v || ""); prefs.save(); }

    // -------- In-memory UI state --------
    const ui = {
        view: "import",
        step: 0,
        loading: false,
        error: "",
        info: "",
        fileKey: null,
        fileName: "",
        frames: [],
        selectedId: null,
        urlDraft: null,     // what the user typed in the link box (survives re-renders)
        tokenDraft: "",     // what the user typed in a token box (survives a failed check)
        urlError: "",       // inline problem with the link box
        needToken: false,   // Load was pressed without a saved token
        tutError: "",       // tutorial: tried to continue without a token
        busy: false,        // a Get code / Send to Claude run is in flight
        loadSeq: 0          // bumps on every Load; stale responses are dropped
    };

    // ============================================================
    //  Helpers
    // ============================================================
    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function safeName(s) {
        return (String(s || "figma").toLowerCase()
            .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "figma").slice(0, 40);
    }
    // Resolves true if the text really reached the clipboard, false otherwise,
    // so callers never claim "copied" when it wasn't.
    function copyToClipboard(text) {
        function legacy() {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            let ok = false;
            try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
            document.body.removeChild(ta);
            return ok;
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
            }
        } catch (e) { /* fall through */ }
        return Promise.resolve(legacy());
    }

    // Figma URLs: figma.com/(file|design|proto)/<KEY>/<title>?node-id=1-2
    function parseFigmaUrl(url) {
        url = (url || "").trim();
        const keyM = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
        // Branch links (/design/KEY/branch/BRANCHKEY/...) must use the branch key,
        // otherwise we silently load the main file instead of the branch.
        const branchM = url.match(/figma\.com\/(?:file|design|proto|board)\/[A-Za-z0-9]+\/branch\/([A-Za-z0-9]+)/);
        const key  = branchM ? branchM[1] : (keyM ? keyM[1] : null);
        let nodeId = null;
        const nm = url.match(/[?&]node-id=([^&]+)/);
        if (nm) { nodeId = decodeURIComponent(nm[1]).replace(/-/g, ":"); }
        return { key: key, nodeId: nodeId };
    }
    // Input checks for the panel. Return "" when OK, otherwise the message to show.
    // Kept pure so tests can cover them (test/inputs.test.js).
    function checkUrlInput(v) {
        v = String(v == null ? "" : v).trim();
        if (!v) { return "Paste a Figma frame link first."; }
        if (!/figma\.com\//i.test(v)) { return "That isn't a Figma link. It should start with https://www.figma.com/"; }
        if (!parseFigmaUrl(v).key) { return "That Figma link is missing the file. Use Copy link to selection on a frame."; }
        return "";
    }
    function checkTokenInput(v) {
        v = String(v == null ? "" : v).trim();
        if (!v) { return "Paste your Figma token first, then press Save."; }
        if (/\s/.test(v)) { return "Tokens don't contain spaces. Copy it again from Figma."; }
        if (/figma\.com\//i.test(v)) { return "That's a Figma link, not a token. Tokens start with figd_"; }
        if (v.length < 20) { return "That token looks too short. Copy the whole token from Figma."; }
        return "";
    }
    function frameUrl(key, nodeId) {
        return "https://www.figma.com/design/" + key + "/frame?node-id=" +
            encodeURIComponent(String(nodeId).replace(/:/g, "-"));
    }

    // ---- Figma REST ----
    function figmaGet(path, tokenOverride) {
        const token = tokenOverride || getToken();
        if (!token) { return Promise.reject(new Error("No Figma token set. Open the Settings gear and paste one.")); }
        return fetch(FIGMA_API + path, { headers: { "X-Figma-Token": token } })
            .catch(function () { throw new Error("Couldn't reach Figma - check your internet connection and try again."); })
            .then(function (res) {
                if (res.status === 401 || res.status === 403) {
                    throw new Error("Figma rejected your token (" + res.status + "). It may be invalid, expired, or lack access to this file - re-add it in the Settings gear.");
                }
                if (res.status === 404) { throw new Error("Frame or file not found (404). Check the link and that your token can open it."); }
                if (res.status === 429) { throw new Error("Figma is rate-limiting requests (429). Wait a few seconds and try again."); }
                if (res.status >= 500) { throw new Error("Figma had a server error (" + res.status + "). Try again shortly."); }
                if (!res.ok) { throw new Error("Figma API error " + res.status + "."); }
                return res.json();
            });
    }
    function fetchImages(key, ids, scale, format) {
        if (!ids.length) { return Promise.resolve({}); }
        format = format || "png";
        // SVG for vector/icon assets = crisp, resolution-independent, exact. PNG for
        // rendered previews. SVG ignores scale.
        const q = "?ids=" + encodeURIComponent(ids.join(",")) + "&format=" + format +
            (format === "png" ? "&scale=" + (scale || getScale()) : "");
        return figmaGet("/images/" + key + q).then(function (data) { return (data && data.images) || {}; });
    }
    // Raw source images behind every IMAGE fill in the file, keyed by imageRef. One
    // request, deduped, uncapped, and WITHOUT overlaid children baked in - the right
    // source for a CSS background-image (unlike the node-render /images endpoint).
    function fetchImageFills(key) {
        return figmaGet("/files/" + key + "/images").then(function (data) {
            return (data && data.meta && data.meta.images) || {};
        });
    }
    function collectFrames(doc) {
        const out = [];
        const pages = (doc && doc.children) || [];
        for (let p = 0; p < pages.length && out.length < MAX_FRAMES; p++) {
            const kids = pages[p].children || [];
            for (let i = 0; i < kids.length && out.length < MAX_FRAMES; i++) {
                const n = kids[i];
                if (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET" || n.type === "INSTANCE") {
                    const box = n.absoluteBoundingBox || {};
                    out.push({ id: n.id, name: n.name || n.type, w: box.width || 0, h: box.height || 0, imgUrl: null });
                }
            }
        }
        return out;
    }

    // ============================================================
    //  Figma node -> HTML/CSS generator (free path)
    // ============================================================
    function chan(v) { return Math.round(Math.max(0, Math.min(1, v == null ? 0 : v)) * 255); }
    function colorToCss(c, mul) {
        if (!c) { return null; }
        const a = (c.a == null ? 1 : c.a) * (mul == null ? 1 : mul);
        return "rgba(" + chan(c.r) + "," + chan(c.g) + "," + chan(c.b) + "," + +a.toFixed(3) + ")";
    }
    function firstVisible(arr) {
        if (!Array.isArray(arr)) { return null; }
        for (let i = 0; i < arr.length; i++) { if (arr[i] && arr[i].visible !== false) { return arr[i]; } }
        return null;
    }
    function gradientCss(fill) {
        const stops = (fill.gradientStops || []).map(function (s) {
            return colorToCss(s.color) + " " + Math.round((s.position || 0) * 100) + "%";
        });
        if (!stops.length) { return null; }
        let angle = 180;
        const h = fill.gradientHandlePositions;
        if (h && h.length >= 2) {
            const dx = h[1].x - h[0].x, dy = h[1].y - h[0].y;
            angle = Math.round((Math.atan2(dy, dx) * 180 / Math.PI) + 90);
        }
        if (fill.type === "GRADIENT_RADIAL") { return "radial-gradient(" + stops.join(",") + ")"; }
        return "linear-gradient(" + angle + "deg," + stops.join(",") + ")";
    }
    function backgroundFromFills(fills, opacity) {
        const f = firstVisible(fills);
        if (!f) { return null; }
        if (f.type === "SOLID") { return colorToCss(f.color, (f.opacity == null ? 1 : f.opacity) * (opacity == null ? 1 : opacity)); }
        if (f.type && f.type.indexOf("GRADIENT") === 0) { return gradientCss(f); }
        return null;
    }
    function radiusCss(n) {
        if (Array.isArray(n.rectangleCornerRadii)) { return n.rectangleCornerRadii.map(function (r) { return r + "px"; }).join(" "); }
        if (typeof n.cornerRadius === "number" && n.cornerRadius > 0) { return n.cornerRadius + "px"; }
        return null;
    }
    function shadowCss(effects) {
        if (!Array.isArray(effects)) { return null; }
        const parts = [];
        effects.forEach(function (e) {
            if (e.visible === false) { return; }
            if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
                const o = e.offset || { x: 0, y: 0 };
                parts.push((e.type === "INNER_SHADOW" ? "inset " : "") +
                    Math.round(o.x) + "px " + Math.round(o.y) + "px " +
                    Math.round(e.radius || 0) + "px " + colorToCss(e.color));
            }
        });
        return parts.length ? parts.join(",") : null;
    }
    // A node we should export as a flat image instead of trying to rebuild it.
    // NOTE: raster IMAGE fills are NOT flattened here - they are embedded as a CSS
    // background on the node itself (see imageFillDecls) so overlaid children survive
    // and scaleMode maps to background-size. Only true vectors/icons flatten to <img>.
    const VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "REGULAR_POLYGON"];
    function isAsset(n) {
        if (!n) { return false; }
        if (/(^|[^a-z])(icon|logo|glyph)([^a-z]|$)/i.test(n.name || "")) { return true; }
        if (VECTOR_TYPES.indexOf(n.type) !== -1) { return true; }
        return false;
    }
    // A small container whose whole subtree is pure vector art (no text, no raster
    // image) is an ICON/LOGO - export it as ONE image, not fragmented into its
    // individual paths. This is the big accuracy fix: a single icon can be dozens
    // or hundreds of VECTOR children (one was 156 paths); exporting each separately
    // shreds the icon AND blows the MAX_ASSETS budget, leaving empty bordered boxes.
    function isPureGraphic(n) {
        if (!n || !n.children || !n.children.length) { return false; }
        const box = n.absoluteBoundingBox;
        if (box && (box.width > 512 || box.height > 512)) { return false; } // too big to be an icon; likely a real section
        let ok = true, hasVector = false, count = 0;
        (function scan(m) {
            if (!ok || !m || m.visible === false) { return; }
            if (++count > 400) { ok = false; return; }             // too complex to be an icon (bounds perf too)
            if (m.type === "TEXT") { ok = false; return; }
            const fills = m.fills;
            if (Array.isArray(fills) && fills.some(function (f) { return f && f.visible !== false && f.type === "IMAGE"; })) { ok = false; return; }
            if (VECTOR_TYPES.indexOf(m.type) !== -1) { hasVector = true; }
            (m.children || []).forEach(scan);
        })(n);
        return ok && hasVector;
    }
    // A node the generator exports as a flat image (and never recurses into).
    // Degenerate/thin nodes (LINE, hairlines) rasterize to broken 0-height images,
    // so exclude them - they render fine as normal thin divs / stroke borders.
    function isFlatAsset(n) {
        if (!n) { return false; }
        if (n.type === "LINE") { return false; }
        const box = n.absoluteBoundingBox;
        if (box && (box.width < 3 || box.height < 3)) { return false; }
        return isPureGraphic(n) || isAsset(n);
    }
    function collectAssetIds(root) {
        const ids = [];
        (function walk(n) {
            if (!n || n.visible === false || ids.length >= MAX_ASSETS) { return; }
            if (n !== root && isFlatAsset(n)) { ids.push(n.id); return; } // export whole, don't recurse
            (n.children || []).forEach(walk);
        })(root);
        return ids;
    }
    // Topmost visible IMAGE paint on a node (last paint in the array draws on top).
    function topImageFill(n) {
        const fills = Array.isArray(n && n.fills) ? n.fills : [];
        for (let i = fills.length - 1; i >= 0; i--) {
            const f = fills[i];
            if (f && f.visible !== false && f.type === "IMAGE") { return f; }
        }
        return null;
    }
    // Every distinct imageRef used by a visible IMAGE fill in the subtree.
    function collectImageRefs(root) {
        const refs = {};
        (function walk(n) {
            if (!n || n.visible === false) { return; }
            const fills = Array.isArray(n.fills) ? n.fills : [];
            fills.forEach(function (f) {
                if (f && f.visible !== false && f.type === "IMAGE" && f.imageRef) { refs[f.imageRef] = true; }
            });
            (n.children || []).forEach(walk);
        })(root);
        return Object.keys(refs);
    }
    // scaleMode -> background sizing. FILL->cover, FIT->contain, TILE->repeat, STRETCH->100% 100%.
    function scaleModeDecls(scaleMode) {
        if (scaleMode === "FIT") { return ["background-size:contain", "background-position:center", "background-repeat:no-repeat"]; }
        if (scaleMode === "TILE") { return ["background-repeat:repeat"]; }
        if (scaleMode === "STRETCH") { return ["background-size:100% 100%", "background-repeat:no-repeat"]; }
        // FILL / CROP / default -> cover, centered, no repeat.
        return ["background-size:cover", "background-position:center", "background-repeat:no-repeat"];
    }
    // CSS for a node's raster image fill, embedded as a background so children survive.
    function imageFillDecls(n, imageFillMap) {
        if (!imageFillMap) { return []; }
        const imgFill = topImageFill(n);
        if (!imgFill) { return []; }
        const url = imgFill.imageRef && imageFillMap[imgFill.imageRef];
        if (!url) { return []; }
        return ["background-image:url('" + esc(url) + "')"].concat(scaleModeDecls(imgFill.scaleMode));
    }
    function px(v) { return Math.round(v) + "px"; }
    // Assemble an inline style="" value. Untrusted Figma values (font names, and
    // in theory any numeric/enum field on a crafted file) flow into these decls;
    // no legitimate CSS value here contains " < or >, and those are the only chars
    // that can break out of the quoted attribute - strip them as a hard backstop
    // against style-attribute injection (defense in depth beyond per-field checks).
    function styleAttr(decls) { return decls.join(";").replace(/["<>]/g, ""); }

    // Visual-only declarations (fills, radius, stroke, shadow, opacity). No layout.
    // ---- Design tokens: Figma color styles -> CSS custom properties ----
    // If a color is backed by a reused Figma color style, emit it once in :root
    // and reference var(--name) at each usage, instead of inlining the hex
    // everywhere. activeTokens is set for the duration of one generateFromNode.
    let activeTokens = null;
    function tok(v) { return (activeTokens && v != null && activeTokens.byValue[v]) ? "var(" + activeTokens.byValue[v] + ")" : v; }
    function cssVarName(styleName) {
        const s = String(styleName == null ? "" : styleName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return "--" + (s || "token");
    }
    // Walk the tree, map each style-backed solid color to a named custom property.
    // stylesMap = the /nodes response wrapper's `styles` (styleId -> {name, styleType}).
    function collectTokens(root, stylesMap) {
        stylesMap = stylesMap || {};
        const byValue = {}, defs = [], used = {};
        function add(value, styleName) {
            if (!value || value.indexOf("gradient") >= 0 || byValue[value]) { return; }
            let name = cssVarName(styleName); const base = name; let i = 2;
            while (used[name]) { name = base + "-" + i; i++; }
            used[name] = true; byValue[value] = name; defs.push({ name: name, value: value });
        }
        (function walk(n) {
            if (!n) { return; }
            const st = n.styles;
            if (st) {
                const fillSid = st.fill || st.fills;
                if (fillSid && stylesMap[fillSid] && stylesMap[fillSid].styleType === "FILL") {
                    add(backgroundFromFills(n.fills, 1), stylesMap[fillSid].name);
                }
                const strokeSid = st.stroke || st.strokes;
                if (strokeSid && stylesMap[strokeSid] && stylesMap[strokeSid].styleType === "FILL") {
                    const s = firstVisible(n.strokes);
                    if (s && s.type === "SOLID") { add(colorToCss(s.color), stylesMap[strokeSid].name); }
                }
            }
            (n.children || []).forEach(walk);
        })(root);
        return { byValue: byValue, defs: defs };
    }
    function visualDecls(n, imageFillMap) {
        const d = [];
        const bg = backgroundFromFills(n.fills, 1);
        if (bg) { d.push((bg.indexOf("gradient") >= 0 ? "background:" : "background-color:") + tok(bg)); }
        d.push.apply(d, imageFillDecls(n, imageFillMap));
        const rad = radiusCss(n);
        if (rad) { d.push("border-radius:" + rad); }
        const stroke = firstVisible(n.strokes);
        if (stroke && stroke.type === "SOLID" && n.strokeWeight > 0) { d.push("border:" + n.strokeWeight + "px solid " + tok(colorToCss(stroke.color))); }
        const sh = shadowCss(n.effects);
        if (sh) { d.push("box-shadow:" + sh); }
        if (typeof n.opacity === "number" && n.opacity < 1) { d.push("opacity:" + +n.opacity.toFixed(3)); }
        return d;
    }
    // Font family names go straight into an inline style="" attribute, so strip
    // anything that could break out of the attribute or the CSS string (a name
    // like x"><script> would otherwise inject markup into the generated file).
    // Real font names are letters/digits/spaces/hyphens.
    function safeFontFamily(f) { return String(f == null ? "" : f).replace(/[^A-Za-z0-9 _-]/g, "").trim(); }
    function fontFamilyDecl(name, fonts) {
        const ff = safeFontFamily(name);
        if (!ff) { return null; }
        fonts[ff] = true;
        return "font-family:'" + ff + "',sans-serif";
    }
    function textDecls(n, fonts) {
        const st = n.style || {};
        const d = [];
        const col = backgroundFromFills(n.fills, 1);
        if (col) { d.push("color:" + tok(col)); }
        if (st.fontSize)      { d.push("font-size:" + Math.round(st.fontSize) + "px"); }
        if (st.fontFamily)    { const ff = fontFamilyDecl(st.fontFamily, fonts); if (ff) { d.push(ff); } }
        if (st.fontWeight)    { d.push("font-weight:" + st.fontWeight); }
        if (st.lineHeightPx)  { d.push("line-height:" + Math.round(st.lineHeightPx) + "px"); }
        if (st.letterSpacing) { d.push("letter-spacing:" + (+st.letterSpacing).toFixed(2) + "px"); }
        if (st.textAlignHorizontal) { d.push("text-align:" + st.textAlignHorizontal.toLowerCase()); }
        d.push("white-space:pre-wrap");
        return d;
    }
    // CSS for one style-override run (only the keys Figma actually overrode).
    function runStyleCss(ov, fonts) {
        const d = [];
        if (ov.fontSize)   { d.push("font-size:" + Math.round(ov.fontSize) + "px"); }
        if (ov.fontFamily) { const ff = fontFamilyDecl(ov.fontFamily, fonts); if (ff) { d.push(ff); } }
        if (ov.fontWeight) { d.push("font-weight:" + ov.fontWeight); }
        if (ov.letterSpacing) { d.push("letter-spacing:" + (+ov.letterSpacing).toFixed(2) + "px"); }
        if (ov.lineHeightPx)  { d.push("line-height:" + Math.round(ov.lineHeightPx) + "px"); }
        if (ov.fills) { const c = backgroundFromFills(ov.fills, 1); if (c) { d.push("color:" + tok(c)); } }
        if (ov.textCase === "UPPER") { d.push("text-transform:uppercase"); }
        else if (ov.textCase === "LOWER") { d.push("text-transform:lowercase"); }
        if (ov.textDecoration === "UNDERLINE") { d.push("text-decoration:underline"); }
        else if (ov.textDecoration === "STRIKETHROUGH") { d.push("text-decoration:line-through"); }
        return d;
    }
    // Inner HTML for a text node: split into <span> runs when it has mixed styles.
    function textInner(n, fonts) {
        const chars = n.characters || "";
        const ov = n.characterStyleOverrides;
        const table = n.styleOverrideTable;
        if (!ov || !ov.length || !table || !Object.keys(table).length) { return esc(chars); }
        const arr = Array.from(chars); // codepoint-safe
        let html = "", i = 0;
        while (i < arr.length) {
            const id = ov[i] || 0;
            let s = "";
            while (i < arr.length && (ov[i] || 0) === id) { s += arr[i]; i++; }
            const style = id && table[id] ? styleAttr(runStyleCss(table[id], fonts)) : "";
            html += style ? '<span style="' + style + '">' + esc(s) + '</span>' : esc(s);
        }
        return html;
    }
    const ALIGN_PRIMARY = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
    const ALIGN_COUNTER = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };
    function isFlex(n) { return n && n.layoutMode && n.layoutMode !== "NONE"; }
    // Auto-layout -> flexbox declarations.
    function flexDecls(n) {
        const d = ["display:flex", "position:relative"];
        d.push("flex-direction:" + (n.layoutMode === "HORIZONTAL" ? "row" : "column"));
        const spaceBetween = n.primaryAxisAlignItems === "SPACE_BETWEEN";
        if (spaceBetween) { d.push("justify-content:space-between"); }
        else if (n.primaryAxisAlignItems) { d.push("justify-content:" + (ALIGN_PRIMARY[n.primaryAxisAlignItems] || "flex-start")); }
        if (n.counterAxisAlignItems) { d.push("align-items:" + (ALIGN_COUNTER[n.counterAxisAlignItems] || "flex-start")); }
        if (n.itemSpacing && !spaceBetween) { d.push("gap:" + Math.round(n.itemSpacing) + "px"); }
        const pt = n.paddingTop || 0, pr = n.paddingRight || 0, pb = n.paddingBottom || 0, pl = n.paddingLeft || 0;
        if (pt || pr || pb || pl) { d.push("padding:" + pt + "px " + pr + "px " + pb + "px " + pl + "px"); }
        return d;
    }
    // One axis (width or height) of a flex child, driven by Figma's real sizing:
    //   HUG   -> auto (fit content)   FILL -> grow on main axis / stretch on cross   FIXED -> px
    // `size` may be undefined on older/vector nodes; treat that as FIXED (snapshot px).
    function axisDecls(prop, size, val, isMain, forceAuto) {
        const d = [];
        if (forceAuto) { return d; }               // caller wants this axis to stay auto (e.g. text height)
        if (size === "FILL") {
            if (isMain) { d.push("flex:1 1 0"); }
            else { d.push("align-self:stretch"); }
        } else if (size === "HUG") {
            // fit-content. Figma never shrinks a HUG item below its content, so on the
            // parent's main axis pin flex-shrink:0 (otherwise flex squeezes it and text wraps).
            if (isMain) { d.push("flex-shrink:0"); }
        } else if (val != null) {                   // FIXED or unknown -> explicit px
            d.push(prop + ":" + px(val));
            if (isMain) { d.push("flex-shrink:0"); } // don't let a fixed main size collapse
        }
        return d;
    }

    // Figma constraints -> CSS anchoring, so absolute children reflow with the
    // parent exactly as they do in Figma (LEFT stays, RIGHT sticks right,
    // LEFT_RIGHT stretches, CENTER stays centered, SCALE scales by %).
    function constraintDecls(n, pbox, opts) {
        opts = opts || {};
        const box = n.absoluteBoundingBox;
        const c = n.constraints || {};
        const pw = pbox.width || 1, ph = pbox.height || 1;
        const left = Math.round(box.x - pbox.x), top = Math.round(box.y - pbox.y);
        const right = Math.round(pw - (box.x - pbox.x) - box.width);
        const bottom = Math.round(ph - (box.y - pbox.y) - box.height);
        const noW = opts.autoW || n.layoutSizingHorizontal === "HUG";
        const noH = opts.autoH || n.layoutSizingVertical === "HUG";
        const d = [], tf = [];
        // Horizontal.
        if (c.horizontal === "RIGHT") { d.push("right:" + right + "px"); if (!noW) { d.push("width:" + Math.round(box.width) + "px"); } }
        else if (c.horizontal === "LEFT_RIGHT") { d.push("left:" + left + "px", "right:" + right + "px"); }
        else if (c.horizontal === "CENTER") { d.push("left:calc(50% + " + Math.round(left + box.width / 2 - pw / 2) + "px)"); tf.push("translateX(-50%)"); if (!noW) { d.push("width:" + Math.round(box.width) + "px"); } }
        else if (c.horizontal === "SCALE") { d.push("left:" + (left / pw * 100).toFixed(3) + "%"); if (!noW) { d.push("width:" + (box.width / pw * 100).toFixed(3) + "%"); } }
        else { d.push("left:" + left + "px"); if (!noW) { d.push("width:" + Math.round(box.width) + "px"); } }
        // Vertical.
        if (c.vertical === "BOTTOM") { d.push("bottom:" + bottom + "px"); if (!noH) { d.push("height:" + Math.round(box.height) + "px"); } }
        else if (c.vertical === "TOP_BOTTOM") { d.push("top:" + top + "px", "bottom:" + bottom + "px"); }
        else if (c.vertical === "CENTER") { d.push("top:calc(50% + " + Math.round(top + box.height / 2 - ph / 2) + "px)"); tf.push("translateY(-50%)"); if (!noH) { d.push("height:" + Math.round(box.height) + "px"); } }
        else if (c.vertical === "SCALE") { d.push("top:" + (top / ph * 100).toFixed(3) + "%"); if (!noH) { d.push("height:" + (box.height / ph * 100).toFixed(3) + "%"); } }
        else { d.push("top:" + top + "px"); if (!noH) { d.push("height:" + Math.round(box.height) + "px"); } }
        if (tf.length) { d.push("transform:" + tf.join(" ")); }
        return d;
    }

    // Size + position for a node given its parent context.
    function layoutDecls(n, parent, opts) {
        opts = opts || {};
        const d = [];
        const box = n.absoluteBoundingBox;
        const parentFlex = isFlex(parent);
        const abs = n.layoutPositioning === "ABSOLUTE";
        if (parentFlex && !abs) {
            const mainIsWidth = parent.layoutMode === "HORIZONTAL";
            d.push.apply(d, axisDecls("width",  n.layoutSizingHorizontal, box && box.width,  mainIsWidth,  opts.autoW));
            d.push.apply(d, axisDecls("height", n.layoutSizingVertical,   box && box.height, !mainIsWidth, opts.autoH));
        } else if (box) {
            // Absolute within the parent (non-auto-layout parent, or an absolutely-positioned child).
            const pbox = (parent && parent.absoluteBoundingBox) || box;
            d.push("position:absolute");
            d.push.apply(d, constraintDecls(n, pbox, opts));
        }
        return d;
    }

    // Recursive: build nested HTML for a node.
    function renderNode(n, parent, assetMap, fonts, ctr, imageFillMap) {
        if (!n || n.visible === false || ctr.c >= MAX_ELEMENTS) { return ""; }
        ctr.c++;

        // Assets (icons/logos/vector art): export as ONE flat image, never recurse.
        if (isFlatAsset(n)) {
            const url = assetMap[n.id];
            const d = layoutDecls(n, parent).concat("object-fit:contain");
            if (url) { return '<img alt="' + esc(n.name) + '" src="' + esc(url) + '" style="' + styleAttr(d) + '" />'; }
            return '<div data-name="' + esc(n.name) + '" style="' + styleAttr(d.concat(visualDecls(n, imageFillMap))) + '"></div>';
        }

        // Text.
        if (n.type === "TEXT") {
            const ar = (n.style && n.style.textAutoResize) || "NONE";
            // Width auto only when Figma hugs both axes; height always auto so text can wrap freely.
            const hug = ar === "WIDTH_AND_HEIGHT";
            const d = layoutDecls(n, parent, { autoW: hug, autoH: true }).concat(textDecls(n, fonts));
            return '<div data-name="' + esc(n.name) + '" style="' + styleAttr(d) + '">' + textInner(n, fonts) + '</div>';
        }

        // Container. Height/width now come from the sizing model (layoutSizing*), so no px heuristic.
        // A raster IMAGE fill (screenshot/photo) becomes a background here (imageFillDecls
        // via visualDecls), so any overlaid children still render on top.
        const flex = isFlex(n);
        let d = layoutDecls(n, parent, {});
        if (flex) { d = d.concat(flexDecls(n)); }
        else { d.push("position:" + (n.layoutPositioning === "ABSOLUTE" || (parent && !isFlex(parent)) ? "absolute" : "relative")); }
        d.push(n.clipsContent ? "overflow:hidden" : "overflow:visible");
        d = d.concat(visualDecls(n, imageFillMap));
        let inner = "";
        (n.children || []).forEach(function (c) { inner += renderNode(c, n, assetMap, fonts, ctr, imageFillMap); });
        return '<div data-name="' + esc(n.name) + '" style="' + styleAttr(d) + '">' + inner + '</div>';
    }

    function generateFromNode(root, assetMap, imageFillMap, tokens) {
        const rootBox = root.absoluteBoundingBox;
        if (!rootBox) { throw new Error("This node has no geometry to convert."); }
        activeTokens = (tokens && tokens.defs && tokens.defs.length) ? tokens : null;
        const fonts = {};
        const ctr = { c: 0 };
        const flex = isFlex(root);

        // Root declarations.
        // Native design width, centered. No max-width cap: capping a fixed-width
        // desktop artboard clips LEFT-anchored content. Constraints (constraintDecls)
        // still make it reflow correctly if the page is later made responsive.
        const rootDecls = flex ? flexDecls(root) : ["position:relative"];
        rootDecls.push("width:" + px(rootBox.width), "margin:0 auto");
        if (!flex) { rootDecls.push("height:" + px(rootBox.height)); }
        rootDecls.push(root.clipsContent === false ? "overflow:visible" : "overflow:hidden");
        rootDecls.push.apply(rootDecls, visualDecls(root, imageFillMap));
        const rootBg = backgroundFromFills(root.fills, 1);
        // Only fall back to white when the root has neither a color/gradient nor an image fill
        // (a bare "background:#fff" shorthand would wipe out any background-image set above).
        if (!rootBg && !topImageFill(root)) { rootDecls.push("background:#ffffff"); }

        let inner = "";
        (root.children || []).forEach(function (c) { inner += renderNode(c, root, assetMap, fonts, ctr, imageFillMap); });

        // :root design tokens (color styles), emitted once and referenced via var().
        let rootVars = "";
        if (activeTokens) {
            rootVars = "    :root {\n" +
                activeTokens.defs.map(function (t) { return "      " + t.name + ": " + t.value + ";"; }).join("\n") +
                "\n    }\n";
        }
        activeTokens = null;

        const fams = Object.keys(fonts);
        let fontLink = "";
        if (fams.length) {
            const q = fams.map(function (f) { return "family=" + encodeURIComponent(f).replace(/%20/g, "+") + ":wght@400;500;600;700"; }).join("&");
            fontLink = '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
                       '  <link href="https://fonts.googleapis.com/css2?' + q + '&display=swap" rel="stylesheet" />\n';
        }
        return [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '  <meta charset="utf-8" />',
            '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
            "  <title>" + esc(root.name || "Figma export") + "</title>",
            fontLink +
            "  <style>",
            rootVars +
            "    * { margin: 0; padding: 0; box-sizing: border-box; }",
            "    body { display: flex; justify-content: center; background: #f4f4f5; padding: 24px; }",
            "    .figma-root img { display: block; max-width: 100%; }",
            "  </style>",
            "</head>",
            "<body>",
            '  <!-- Generated from Figma by FigmaToCode (free/REST path). Frame: ' + esc(root.name || "") + '.',
            "       Auto-layout frames become flexbox; icons/images are Figma export URLs that expire ~7 days. -->",
            '  <div class="figma-root" style="' + styleAttr(rootDecls) + '">',
            "    " + inner,
            "  </div>",
            "</body>",
            "</html>",
            ""
        ].join("\n");
    }

    function writeAndOpen(fileName, contents) {
        const root = ProjectManager.getProjectRoot();
        if (!root) { return Promise.reject(new Error("Open a project folder first (File → Open Folder).")); }
        const path = root.fullPath + fileName;
        return new Promise(function (resolve, reject) {
            function openIt() { CommandManager.execute(Commands.FILE_OPEN, { fullPath: path }).always(function () { resolve(path); }); }

            // If the file is already open in the editor (e.g. it's the live-preview
            // file), a raw filesystem write trips "ContentsModified". Update it
            // THROUGH its Document instead, then save.
            let openDoc = null;
            try { openDoc = DocumentManager.getOpenDocumentForPath(path); } catch (e) { openDoc = null; }
            if (openDoc) {
                try {
                    openDoc.setText(contents);
                    CommandManager.execute(Commands.FILE_SAVE, { doc: openDoc }).always(openIt);
                    return;
                } catch (e) { /* fall through to blind write */ }
            }

            // FileUtils.writeText(file, text, allowBlindWrite=true) is the documented
            // way to ignore CONTENTS_MODIFIED and overwrite a stale/changed file.
            const file = FileSystem.getFileForPath(path);
            FileUtils.writeText(file, contents, true)
                .done(openIt)
                .fail(function (err) { reject(new Error("Could not write file: " + err)); });
        });
    }

    // ============================================================
    //  Panel DOM
    // ============================================================
    const $panel = $(
        '<div id="f2c-panel" class="f2c-panel" style="display:none;">' +
            '<div class="f2c-header">' +
                '<div class="f2c-brand">' +
                    '<span class="f2c-logo"></span>' +
                    '<span>Figma → Code</span>' +
                '</div>' +
                '<div class="f2c-nav">' +
                    '<button type="button" class="f2c-nav-btn" data-view="import" title="Import">Import</button>' +
                    '<button type="button" class="f2c-nav-btn f2c-nav-icon" data-view="tutorial" title="How it works" aria-label="How it works">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>' +
                    '</button>' +
                    '<button type="button" class="f2c-nav-btn f2c-nav-icon" data-view="settings" title="Settings" aria-label="Settings">' +
                        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="f2c-body"></div>' +
        '</div>'
    ).appendTo("body");

    const $body = $panel.find(".f2c-body");

    function setView(v) { ui.view = v; renderPanel(); }
    function renderNav() {
        $panel.find(".f2c-nav-btn").each(function () {
            $(this).toggleClass("f2c-nav-active", $(this).attr("data-view") === ui.view);
        });
        // Red dot on the settings gear when a token is missing (both tiers need one now).
        const needsToken = !getToken();
        $panel.find('.f2c-nav-btn[data-view="settings"]').toggleClass("f2c-nav-alert", needsToken);
    }
    function statusHtml() {
        if (ui.loading || ui.busy) { return '<div class="f2c-status f2c-loading" role="status"><span class="f2c-spin"></span>' + esc(ui.info || "Working…") + '</div>'; }
        if (ui.error)   { return '<div class="f2c-status f2c-err" role="alert">' + esc(ui.error) + '</div>'; }
        if (ui.info)    { return '<div class="f2c-status f2c-ok" role="status">' + esc(ui.info) + '</div>'; }
        return "";
    }
    function flash(kind, msg) {
        ui.error = kind === "err" ? msg : "";
        ui.info  = kind === "ok"  ? msg : "";
    }

    // ---- Shared UI bits (icons, hero, rows) ----
    const FIGMA_LOGO =
        '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
            '<circle cx="8" cy="4"  r="3.4" fill="#f24e1e"/>' +
            '<circle cx="8" cy="12" r="3.4" fill="#a259ff"/>' +
            '<circle cx="16" cy="12" r="3.4" fill="#1abcfe"/>' +
            '<circle cx="8" cy="20" r="3.4" fill="#0acf83"/>' +
        '</svg>';
    const ICONS = {
        link:  '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        key:   '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.5 12.5 20 3"/><path d="M16 7l3 3"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
        code:  '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
        plug:  '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/>',
        shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        send:  '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
        plus:  '<path d="M12 5v14"/><path d="M5 12h14"/>',
        arrowup:'<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
        bolt:  '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>'
    };
    function svg(key) { return '<svg viewBox="0 0 24 24">' + (ICONS[key] || "") + '</svg>'; }
    function heroHtml() {
        return '<div class="f2c-hero"></div>';
    }
    function listHtml(items) {
        return '<ul class="f2c-list">' + items.map(function (it) {
            return '<li><span class="f2c-chip">' + svg(it.icon) + '</span>' +
                   '<span class="f2c-list-text">' + it.text + '</span></li>';
        }).join("") + '</ul>';
    }

    // ---- Import ----
    function renderImport() {
        const seat = getSeat();
        const paid = seat === "paid";
        let html = "";

        html += '<div class="f2c-pad">';

        const urlVal = ui.urlDraft != null ? ui.urlDraft : (prefs.get("lastUrl") || "");
        const locked = ui.loading || ui.busy;
        html += '<div class="f2c-title f2c-title-sm">Paste a Figma frame link</div>';
        html += '<div class="f2c-sub">In Figma: right-click a frame, then <b>Copy link to selection</b>.</div>';
        html +=
            '<div class="f2c-composer' + (ui.urlError ? " f2c-composer-err" : "") + '">' +
                '<input type="text" class="f2c-url" spellcheck="false" autocomplete="off" aria-label="Figma frame link"' +
                ' placeholder="https://www.figma.com/design/…" value="' + esc(urlVal) + '"' + (locked ? " disabled" : "") + ' />' +
                '<div class="f2c-composer-bar">' +
                    '<span class="f2c-composer-hint">' + (urlVal.trim() ? "Press Enter to load" : "") + '</span>' +
                    '<div class="f2c-composer-spacer"></div>' +
                    '<button type="button" class="f2c-round-btn f2c-load-btn' + (urlVal.trim() ? " f2c-round-ready" : "") + '" title="Load frames" aria-label="Load frames"' +
                    (locked || !urlVal.trim() ? " disabled" : "") + '>' +
                    (ui.loading ? '<span class="f2c-spin"></span>' : svg("arrowup")) + '</button>' +
                '</div>' +
            '</div>';
        if (ui.urlError) { html += '<div class="f2c-field-msg" role="alert">' + esc(ui.urlError) + '</div>'; }
        if (!getToken()) {
            // Say it up front (not only after a failed Load) that a token is needed.
            html += '<div class="f2c-status ' + (ui.needToken ? "f2c-err" : "f2c-loading") + ' f2c-status-action"' + (ui.needToken ? ' role="alert"' : "") + '>' +
                '<span>' + (ui.needToken ? "Add your Figma token before loading frames." : "You need a Figma token to load frames.") + '</span>' +
                '<button type="button" class="f2c-btn-white f2c-btn-sm" data-go="settings">Add token</button></div>';
        }
        html += statusHtml();

        if (ui.frames.length) {
            html += '<div class="f2c-hint">' + esc(ui.fileName || "") + ' - pick a frame, then ' + (paid ? "Send to Claude." : "Get code.") + '</div>';
            html += '<div class="f2c-grid' + (ui.busy ? " f2c-grid-locked" : "") + '">';
            ui.frames.forEach(function (f) {
                const sel = (f.id === ui.selectedId) ? " f2c-selected" : "";
                html += '<button type="button" class="f2c-frame' + sel + '" data-id="' + esc(f.id) + '" aria-pressed="' + (sel ? "true" : "false") + '"' + (ui.busy ? " disabled" : "") + '>' +
                    (f.imgUrl ? '<img src="' + esc(f.imgUrl) + '" alt="' + esc(f.name) + '" loading="lazy" />'
                              : '<div class="f2c-frame-ph">' + (f.imgFailed ? "No preview" : '<span class="f2c-spin"></span>') + '</div>') +
                    '<span class="f2c-frame-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
                '</button>';
            });
            html += '</div>';
            const label = paid ? "Send to Claude" : "Get code";
            html += '<button type="button" class="f2c-btn-white f2c-btn-full f2c-getcode-btn"' + (ui.selectedId && !locked ? "" : " disabled") + '>' +
                (ui.busy ? '<span class="f2c-spin f2c-spin-dark"></span>Working…' : (ui.selectedId ? label : "Pick a frame first")) + '</button>';
        }

        // Tip pinned to the bottom
        if (paid) {
            html += '<div class="f2c-suggest f2c-suggest-good">Best accuracy. Claude rebuilds the design pixel for pixel.</div>';
        } else {
            html += '<div class="f2c-suggest">Tip: the personal token path is approximate. For a pixel-perfect result, switch to <button type="button" class="f2c-link" data-setseat="paid">Paid seat</button>.</div>';
        }

        html += '</div>';
        $body.html(html);
    }

    // ---- Tutorial: single "How it works" card (clone of the reference) ----
    function tutorialData() {
        const paid = getSeat() === "paid";
        return {
            paid: paid,
            title: paid ? "Design to code, exactly" : "Design to code, fast",
            steps: [
                { icon: "key",   text: "Create a Figma token in <b>Settings → Security</b> and save it below" },
                { icon: "link",  text: "Paste a frame link into <b>Import</b>" },
                { icon: "image", text: "Pick the frame you want" },
                paid ? { icon: "send", text: "Hit <b>Send to Claude</b>, it builds pixel-perfect code in the AI panel" }
                     : { icon: "code", text: "Hit <b>Get code</b>, real icons exported and file opened" }
            ]
        };
    }
    function renderTutorial() {
        const seat = getSeat();
        if (!seat) {
            $body.html(
                heroHtml(false) +
                '<div class="f2c-pad">' +
                    '<div class="f2c-title">How do you use Figma?</div>' +
                    '<div class="f2c-sub">This sets how FigmaToCode generates code. Change it anytime in Settings.</div>' +
                    '<div class="f2c-seat-choices">' +
                        '<button type="button" class="f2c-seat-card" data-seat="paid">' +
                            '<span class="f2c-seat-emoji">🟢</span><b>Paid / Dev seat</b>' +
                            '<span>Pixel-perfect output through Claude</span></button>' +
                        '<button type="button" class="f2c-seat-card" data-seat="free">' +
                            '<span class="f2c-seat-emoji">🟡</span><b>Free seat</b>' +
                            '<span>Personal token, local converter with icons</span></button>' +
                    '</div>' +
                '</div>'
            );
            return;
        }
        const d = tutorialData();
        const has = !!getToken();
        let html = heroHtml(d.paid) + '<div class="f2c-pad">' +
            '<div class="f2c-title">' + d.title + '</div>' +
            '<div class="f2c-sub">How it works:</div>' +
            listHtml(d.steps) +
            '<div class="f2c-label">Your Figma token' + (has ? "" : ' <span class="f2c-required">required</span>') + '</div>' +
            tokenRowHtml(has ? "Saved. Paste a new one to replace it" : "figd_…");
        if (ui.tokenCheck) {
            html += tokenStatusHtml();
        } else if (has) {
            html += '<div class="f2c-status f2c-ok" role="status">✓ Token saved. You are ready to import.</div>';
        }
        if (ui.tutError && !has) { html += '<div class="f2c-field-msg" role="alert">' + esc(ui.tutError) + '</div>'; }
        html += '<button type="button" class="f2c-btn-white f2c-btn-full f2c-tut-next f2c-mt">' +
            (has ? "Start importing" : "Save token and start") + '</button>' +
        '</div>';
        $body.html(html);
    }

    // ---- Settings ----
    function renderSettings() {
        const token = getToken();
        const masked = token ? (token.slice(0, 6) + "…" + token.slice(-4)) : "";
        const scale = getScale();
        const seat = getSeat();
        let opts = "";
        [1, 2, 3, 4].forEach(function (s) { opts += '<option value="' + s + '"' + (s === scale ? " selected" : "") + '>' + s + '×</option>'; });
        const seatLabel = seat === "paid" ? "🟢 Paid / Dev seat" : (seat === "free" ? "🟡 Free seat" : "Not set");
        let html = '<div class="f2c-pad">' +
            '<div class="f2c-title f2c-title-md">Settings</div>' +
            '<div class="f2c-label">Your Figma plan</div>' +
            '<div class="f2c-row"><div class="f2c-field"><span class="f2c-field-text">' + seatLabel + '</span></div>' +
                '<button type="button" class="f2c-btn-ghost" data-reseat="1">Change</button></div>';

        // Both tiers use the personal token now (paid packs the design into the
        // Claude prompt via the token - no plugin/OAuth).
        html += '<div class="f2c-label f2c-mt">Figma personal access token' + (token ? "" : ' <span class="f2c-required">required</span>') + '</div>' +
            tokenRowHtml(token ? masked + " (paste to replace)" : "figd_…");
        if (ui.tokenCheck) {
            html += tokenStatusHtml();
        } else if (token) {
            html += '<div class="f2c-status f2c-ok f2c-status-action" role="status"><span>✓ Token saved (' + esc(masked) + ')</span>' +
                '<span class="f2c-status-links"><button type="button" class="f2c-link" data-test="1">Test</button>' +
                '<button type="button" class="f2c-link" data-clear="1">Remove</button></span></div>';
        }
        html += '<div class="f2c-note">Stored only on this machine (Phoenix preferences). Never uploaded.</div>' +
            '<div class="f2c-label f2c-mt">Preview resolution</div>' +
            '<select class="f2c-scale" aria-label="Preview resolution">' + opts + '</select>' +
            '<div class="f2c-note">Higher is sharper but slower to load' + (seat === "paid" ? " (paid also sends this render to Claude)" : "") + '.</div>';
        html += '<div class="f2c-settings-footer"><button type="button" class="f2c-link" data-go="tutorial">Replay tutorial</button></div></div>';
        $body.html(html);
    }

    function renderPanel() {
        renderNav();
        if (ui.view === "tutorial")      { renderTutorial(); }
        else if (ui.view === "settings") { renderSettings(); }
        else                             { renderImport(); }
    }

    // ============================================================
    //  Actions
    // ============================================================
    async function loadUrl(url) {
        if (ui.loading || ui.busy) { return; }
        url = String(url == null ? "" : url).trim();
        ui.urlDraft = url;
        ui.error = ""; ui.info = "";
        // Bad or empty link -> say so right under the box and keep what they typed.
        const problem = checkUrlInput(url);
        ui.urlError = problem;
        if (problem) { ui.needToken = false; renderPanel(); focusUrl(); return; }
        // No token -> keep the link, explain, and offer a one-click way to fix it.
        if (!getToken()) { ui.needToken = true; renderPanel(); return; }
        ui.needToken = false;

        const parsed = parseFigmaUrl(url);
        const seq = ++ui.loadSeq;
        prefs.set("lastUrl", url); prefs.save();
        ui.loading = true; ui.info = "Loading frames…"; ui.frames = []; ui.selectedId = null;
        ui.fileKey = parsed.key;
        renderPanel();
        let frames;
        try {
            if (parsed.nodeId) {
                const data = await figmaGet("/files/" + parsed.key + "/nodes?ids=" + encodeURIComponent(parsed.nodeId));
                const wrap = data.nodes && data.nodes[parsed.nodeId];
                const doc = wrap && wrap.document;
                if (!doc) { throw new Error("Couldn't find that frame in the file. It may have been deleted, or the link is from another file."); }
                if (seq !== ui.loadSeq) { return; }
                ui.fileName = data.name || "";
                const box = doc.absoluteBoundingBox || {};
                frames = [{ id: doc.id, name: doc.name || doc.type, w: box.width || 0, h: box.height || 0, imgUrl: null }];
            } else {
                const data = await figmaGet("/files/" + parsed.key + "?depth=2");
                if (seq !== ui.loadSeq) { return; }
                ui.fileName = data.name || "";
                frames = collectFrames(data.document);
                if (!frames.length) { throw new Error("No top-level frames found in this file. Link to a specific frame instead."); }
            }
        } catch (e) {
            if (seq !== ui.loadSeq) { return; }
            ui.loading = false; flash("err", e.message || String(e)); renderPanel();
            return;
        }
        ui.frames = frames;
        if (frames.length === 1) { ui.selectedId = frames[0].id; }
        ui.loading = false;
        flash("ok", frames.length === 1 ? "Frame loaded." : (frames.length + " frames loaded. Pick one."));
        renderPanel();
        // Thumbnails are a nice-to-have: if they fail, the frames still work.
        try {
            const images = await fetchImages(parsed.key, frames.map(function (f) { return f.id; }), getScale());
            if (seq !== ui.loadSeq) { return; }
            frames.forEach(function (f) { f.imgUrl = images[f.id] || null; f.imgFailed = !f.imgUrl; });
        } catch (e) {
            if (seq !== ui.loadSeq) { return; }
            frames.forEach(function (f) { f.imgFailed = true; });
        }
        if (!ui.busy) { renderPanel(); }
    }
    function focusUrl() { setTimeout(function () { $body.find(".f2c-url").trigger("focus"); }, 0); }
    // Settings "Test": re-check the saved token and show the result in place.
    function testSavedToken() {
        if (!getToken() || (ui.tokenCheck && ui.tokenCheck.status === "checking")) { return; }
        ui.tokenCheck = { status: "checking" }; renderPanel();
        figmaGet("/me").then(function (me) {
            ui.tokenCheck = { status: "ok", who: me.email || me.handle || "you" };
        }).catch(function (err) {
            ui.tokenCheck = { status: "err", msg: (err && err.message) || "Token check failed." };
        }).then(renderPanel);
    }

    // Paid path - gather the design via the personal token (no plugin/OAuth) and
    // pack it INTO the Claude prompt, then inject + submit in the AI panel.
    // One-line summary of a node for the structure outline.
    function nodeSummary(n) {
        const parts = [n.type];
        if (n.name) { parts.push('"' + String(n.name).slice(0, 40) + '"'); }
        const b = n.absoluteBoundingBox;
        if (b) { parts.push(Math.round(b.width) + "x" + Math.round(b.height)); }
        if (isFlex(n)) { parts.push("auto-layout:" + n.layoutMode.toLowerCase() + (n.itemSpacing ? " gap:" + Math.round(n.itemSpacing) : "")); }
        if (n.type === "TEXT" && n.characters) {
            parts.push("text=" + JSON.stringify(n.characters.slice(0, 80)));
            const st = n.style || {};
            if (st.fontSize) { parts.push(Math.round(st.fontSize) + "px" + (st.fontWeight ? "/" + st.fontWeight : "")); }
            const col = backgroundFromFills(n.fills, 1); if (col) { parts.push(col); }
        } else {
            const bg = backgroundFromFills(n.fills, 1); if (bg) { parts.push("bg=" + bg); }
        }
        return parts.join(" ");
    }
    // Indented layer tree (bounded) so the prompt stays reasonable.
    function structureOutline(root, maxLines) {
        const lines = [];
        (function walk(n, depth) {
            if (!n || n.visible === false || lines.length >= maxLines) { return; }
            lines.push(new Array(depth + 1).join("  ") + "- " + nodeSummary(n));
            (n.children || []).forEach(function (c) { walk(c, depth + 1); });
        })(root, 0);
        if (lines.length >= maxLines) { lines.push("  ... (truncated)"); }
        return lines.join("\n");
    }
    // Exported asset URLs (icons/vectors + raster image fills) with layer names.
    function assetLines(root, assetMap, fillMap) {
        const lines = [];
        (function walk(n) {
            if (!n || n.visible === false) { return; }
            if (n !== root && isAsset(n)) { if (assetMap[n.id]) { lines.push('- "' + (n.name || n.type) + '" (' + n.type + '): ' + assetMap[n.id]); } return; }
            const imgf = topImageFill(n);
            if (imgf && imgf.imageRef && fillMap[imgf.imageRef]) { lines.push('- "' + (n.name || n.type) + '" (image fill, ' + (imgf.scaleMode || "FILL") + '): ' + fillMap[imgf.imageRef]); }
            (n.children || []).forEach(walk);
        })(root);
        return lines;
    }
    function buildClaudePrompt(doc, previewUrl, assetMap, fillMap, link) {
        const url = link || frameUrl(ui.fileKey, ui.selectedId);
        const name = doc.name || "frame";
        const box = doc.absoluteBoundingBox || {};
        const assets = assetLines(doc, assetMap, fillMap);
        const p = [];
        p.push("Build this Figma frame as clean, semantic, responsive HTML & CSS in my current Phoenix Code project, matching the design exactly. Write it to a new .html file and open Live Preview when done.");
        p.push("");
        p.push('Frame: "' + name + '"  ' + Math.round(box.width) + "x" + Math.round(box.height) + "px");
        p.push("Figma link: " + url);
        if (previewUrl) {
            p.push("");
            p.push("Rendered design (visual source of truth): " + previewUrl);
            p.push("If you can view or download images, fetch that PNG and match it pixel for pixel. In Claude Code: download it (curl) and use Read to view it, then implement.");
        }
        p.push("");
        p.push("If the Figma design-to-code tool (get_design_context / Figma MCP) is available, prefer it for this frame. Otherwise use the exact assets + structure below.");
        if (assets.length) {
            p.push("");
            p.push("Exported assets - use these EXACT URLs, never invent or omit icons/images (URLs expire in ~7 days):");
            assets.slice(0, 120).forEach(function (a) { p.push(a); });
        }
        p.push("");
        p.push("Layer structure (indent = nesting; sizes in px):");
        p.push(structureOutline(doc, 220));
        return p.join("\n");
    }
    function fillClaudeInput(text) {
        const ta = document.querySelector(".ai-chat-textarea");
        if (!ta) { return false; }
        // Use the native setter so the panel's framework registers the change.
        try {
            const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
            const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
            if (desc && desc.set) { desc.set.call(ta, text); } else { ta.value = text; }
        } catch (e) { ta.value = text; }
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.focus();
        return true;
    }
    // Shared start/finish for the two long actions. Only one may run at a time,
    // so a double click can't fire two Claude runs or two file writes.
    function beginJob(msg) {
        if (ui.busy || ui.loading || !ui.selectedId || !ui.fileKey) { return null; }
        if (!getToken()) { ui.needToken = true; ui.view = "import"; renderPanel(); return null; }
        ui.busy = true; ui.error = ""; ui.info = msg; ui.needToken = false; renderPanel();
        // Snapshot the target: clicking another frame mid-run must not change it.
        return { key: ui.fileKey, id: ui.selectedId };
    }
    function step(msg) { ui.info = msg; renderPanel(); }
    function endJob(kind, msg) { ui.busy = false; flash(kind, msg); renderPanel(); }

    async function sendToClaude() {
        const job = beginJob("Reading frame…");
        if (!job) { return; }
        try {
            const data = await figmaGet("/files/" + job.key + "/nodes?ids=" + encodeURIComponent(job.id) + "&geometry=paths");
            const doc = data.nodes && data.nodes[job.id] && data.nodes[job.id].document;
            if (!doc) { throw new Error("Couldn't fetch that frame's details."); }
            step("Rendering preview…");
            let previewUrl = null;
            try { const pm = await fetchImages(job.key, [job.id], 2); previewUrl = pm[job.id] || null; } catch (e) { previewUrl = null; }
            step("Exporting assets…");
            const assetIds = collectAssetIds(doc);
            let assetMap = {};
            if (assetIds.length) { try { assetMap = await fetchImages(job.key, assetIds, 2); } catch (e) { assetMap = {}; } }
            const imageRefs = collectImageRefs(doc);
            let fillMap = {};
            if (imageRefs.length) { try { fillMap = await fetchImageFills(job.key); } catch (e) { fillMap = {}; } }

            const prompt = buildClaudePrompt(doc, previewUrl, assetMap, fillMap, frameUrl(job.key, job.id));
            const filled = fillClaudeInput(prompt);
            const sendBtn = document.querySelector(".ai-send-btn");
            if (filled && sendBtn) {
                setTimeout(function () { try { sendBtn.click(); } catch (e) { /* ignore */ } }, 120);
                endJob("ok", "Sent to Claude ✓ Building the code in the AI panel.");
                setTimeout(closePanel, 900);
            } else {
                // No AI panel -> copy the full prompt so the user can paste it.
                const copied = await copyToClipboard(prompt);
                if (copied) { endJob("ok", "AI panel not found, so the full prompt was copied. Open the AI panel and paste it."); }
                else { endJob("err", "AI panel not found and the clipboard is blocked. Open the AI panel and try again."); }
            }
        } catch (e) {
            endJob("err", e.message || String(e));
        }
    }

    // Free path - export icons + generate + write.
    async function getCodeForSelected() {
        const job = beginJob("Reading frame…");
        if (!job) { return; }
        const frame = ui.frames.filter(function (f) { return f.id === job.id; })[0];
        try {
            const data = await figmaGet("/files/" + job.key + "/nodes?ids=" + encodeURIComponent(job.id) + "&geometry=paths");
            const wrap = data.nodes && data.nodes[job.id];
            const doc  = wrap && wrap.document;
            if (!doc) { throw new Error("Couldn't fetch that frame's details."); }

            const assetIds = collectAssetIds(doc);
            const imageRefs = collectImageRefs(doc);
            step("Exporting " + assetIds.length + " icons, " + imageRefs.length + " images…");
            let assetMap = {};
            if (assetIds.length) {
                try { assetMap = await fetchImages(job.key, assetIds, 2); } catch (e) { assetMap = {}; }
            }
            let imageFillMap = {};
            if (imageRefs.length) {
                try { imageFillMap = await fetchImageFills(job.key); } catch (e) { imageFillMap = {}; }
            }
            step("Generating…");
            const tokens = collectTokens(doc, (wrap && wrap.styles) || {});
            const htmlDoc = generateFromNode(doc, assetMap, imageFillMap, tokens);
            const fileName = "figma-" + safeName(frame ? frame.name : doc.name) + ".html";
            await writeAndOpen(fileName, htmlDoc);
            const gotIcons = Object.keys(assetMap).length;
            const gotImages = imageRefs.filter(function (r) { return imageFillMap[r]; }).length;
            const gotTokens = tokens.defs.length;
            const capNote = assetIds.length >= MAX_ASSETS ? " (hit the " + MAX_ASSETS + "-icon cap, some may be missing)" : "";
            endJob("ok", "Wrote " + fileName + " (" + gotIcons + " icons, " + gotImages + " images" + (gotTokens ? ", " + gotTokens + " color tokens" : "") + ")" + capNote + ". Turn on Live Preview to see it.");
        } catch (e) {
            endJob("err", e.message || String(e));
        }
    }

    // ---- Event delegation ----
    $panel.on("click", ".f2c-nav-btn", function () {
        const v = $(this).attr("data-view");
        if (v === "tutorial") { ui.step = 0; }
        leaveView();
        setView(v);
    });
    // Switching views drops stale token messages / drafts from the previous view.
    function leaveView() {
        if (!(ui.tokenCheck && ui.tokenCheck.status === "checking")) { ui.tokenCheck = null; ui.tokenDraft = ""; }
        ui.tutError = "";
    }

    $body.on("click", function (e) {
        const $t = $(e.target);
        if ($t.closest("button[disabled]").length) { return; }

        const go = $t.closest("[data-go]").attr("data-go");
        if (go) { if (go === "tutorial") { ui.step = 0; } leaveView(); setView(go); if (go === "settings") { focusTokenField(); } return; }

        // external help links open in the system browser
        const openUrl = $t.closest("[data-open-url]").attr("data-open-url");
        if (openUrl) { openExternal(openUrl); return; }

        // seat toggle (Import view + inline suggestion link)
        const $ss = $t.closest("[data-setseat]");
        if ($ss.length) { setSeat($ss.attr("data-setseat")); ui.view = "import"; renderPanel(); return; }

        // seat choice (tutorial)
        const $seat = $t.closest("[data-seat]");
        if ($seat.length) { setSeat($seat.attr("data-seat")); ui.step = 0; renderPanel(); return; }
        if ($t.closest("[data-reseat]").length) { setSeat(""); ui.view = "tutorial"; ui.step = 0; leaveView(); renderPanel(); return; }

        // import: send (arrow) loads the current input
        if ($t.closest(".f2c-load-btn").length) { loadUrl($body.find(".f2c-url").val()); return; }
        const $frame = $t.closest(".f2c-frame");
        if ($frame.length) {
            if (ui.busy) { return; }
            ui.selectedId = $frame.attr("data-id"); if (!ui.loading) { ui.error = ""; ui.info = ""; }
            renderPanel(); return;
        }
        if ($t.closest(".f2c-getcode-btn").length) {
            if (getSeat() === "paid") { sendToClaude(); } else { getCodeForSelected(); }
            return;
        }

        // token Save (tutorial + settings share the same row)
        if ($t.closest(".f2c-save-token").length) {
            saveTokenAndValidate($body.find(".f2c-token-input").val());
            return;
        }

        // tutorial: finish -> go to Import. Requires a saved token; if one is
        // typed but not saved yet, save+check it first and continue on success.
        if ($t.closest(".f2c-tut-next").length) {
            if (getToken()) { finishTutorial(); return; }
            const typed = String($body.find(".f2c-token-input").val() || "").trim();
            if (typed) { ui.tutError = ""; saveTokenAndValidate(typed, finishTutorial); return; }
            ui.tutError = "Save your Figma token to continue. Every import needs it.";
            ui.tokenCheck = null;
            renderPanel(); focusTokenField();
            return;
        }

        // settings
        if ($t.closest("[data-clear]").length) {
            setToken(""); ui.tokenCheck = null; ui.tokenDraft = ""; ui.frames = []; ui.selectedId = null;
            renderPanel(); focusTokenField(); return;
        }
        if ($t.closest("[data-test]").length) { testSavedToken(); return; }
    });
    function finishTutorial() { setOnboarded(true); ui.tutError = ""; ui.tokenCheck = null; setView("import"); }
    function openExternal(url) {
        try {
            const NativeApp = brackets.getModule("utils/NativeApp");
            if (NativeApp && NativeApp.openURLInDefaultBrowser) { NativeApp.openURLInDefaultBrowser(url); return; }
        } catch (e) { /* fall through */ }
        window.open(url, "_blank", "noopener");
    }

    $body.on("keydown", ".f2c-url", function (e) { if (e.key === "Enter") { e.preventDefault(); loadUrl($(this).val()); } });
    $body.on("keydown", ".f2c-token-input", function (e) {
        if (e.key !== "Enter") { return; }
        e.preventDefault();
        // In the tutorial, Enter behaves like "Save token and start".
        if (ui.view === "tutorial" && !getToken()) { saveTokenAndValidate($(this).val(), finishTutorial); }
        else { saveTokenAndValidate($(this).val()); }
    });
    // Live feedback while typing, without a full re-render (keeps focus/caret).
    $body.on("input", ".f2c-url", function () {
        const v = String($(this).val() || "");
        ui.urlDraft = v;
        const has = !!v.trim();
        $body.find(".f2c-load-btn").prop("disabled", !has || ui.loading || ui.busy).toggleClass("f2c-round-ready", has);
        $body.find(".f2c-composer-hint").text(has ? "Press Enter to load" : "");
        if (ui.urlError || ui.needToken) {
            ui.urlError = ""; ui.needToken = false;
            $body.find(".f2c-composer").removeClass("f2c-composer-err");
            $body.find(".f2c-field-msg").remove();
            $body.find(".f2c-status-action").removeClass("f2c-err").addClass("f2c-loading").removeAttr("role")
                .find("span").first().text("You need a Figma token to load frames.");
        }
    });
    $body.on("input", ".f2c-token-input", function () {
        ui.tokenDraft = String($(this).val() || "");
        if (ui.tokenCheck && ui.tokenCheck.status === "err") {
            ui.tokenCheck = null;
            $(this).closest(".f2c-field").removeClass("f2c-field-err");
            $body.find(".f2c-status.f2c-err").remove();
        }
    });
    $body.on("change", ".f2c-scale", function () { setScale($(this).val()); });

    // ============================================================
    //  Toolbar button + open/close
    // ============================================================
    const $toolbarBtn = $('<a href="#" id="f2c-toolbar-btn" title="FigmaToCode" aria-label="FigmaToCode"></a>');
    function detectTheme() {
        try {
            const el = document.querySelector("#editor-holder") || document.body;
            const bg = getComputedStyle(el).backgroundColor || "rgb(31,31,31)";
            const m = bg.match(/\d+(\.\d+)?/g);
            if (!m) { return "dark"; }
            return (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) < 128 ? "dark" : "light";
        } catch (e) { return "dark"; }
    }
    function applyTheme() {
        const t = detectTheme();
        $panel.attr("data-f2c-theme", t);
        $toolbarBtn.attr("data-f2c-theme", t);
    }
    function positionPanel() {
        const btn = $toolbarBtn.get(0);
        if (!btn) { return; }
        const rect = btn.getBoundingClientRect();
        let left = rect.left - PANEL_WIDTH - PANEL_GAP;
        let top  = rect.top;
        if (left < 8) { left = Math.max(8, rect.left); top = rect.bottom + PANEL_GAP; }
        const ph = $panel.outerHeight() || 420;
        if (top + ph > window.innerHeight - 8) { top = Math.max(8, window.innerHeight - ph - 8); }
        $panel.css({ left: left + "px", top: top + "px" });
    }
    function openPanel() {
        applyTheme();
        // Defensive: if anything detached the panel from the DOM, re-mount it so
        // .show() actually makes it visible (openPanel only shows an attached node).
        if (!$panel[0] || !document.body.contains($panel[0])) { $panel.appendTo("body"); }
        if (!isOnboarded()) { ui.view = "tutorial"; ui.step = 0; }
        $panel.show();
        positionPanel();
        renderPanel();
    }
    function closePanel() { $panel.hide(); }
    function togglePanel() { if ($panel.is(":visible")) { closePanel(); } else { openPanel(); } }

    $toolbarBtn.on("click", function (e) { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    $(document).off("mousedown.f2c keydown.f2c");
    $(document).on("mousedown.f2c", function (e) {
        if (!$panel.is(":visible")) { return; }
        if ($(e.target).closest("#f2c-panel, #f2c-toolbar-btn").length) { return; }
        closePanel();
    });
    $(document).on("keydown.f2c", function (e) { if (e.key === "Escape" && $panel.is(":visible")) { closePanel(); } });
    $(window).on("resize.f2c", function () { if ($panel.is(":visible")) { positionPanel(); } });

    // ============================================================
    //  Mount
    // ============================================================
    AppInit.appReady(function () {
        const $mainToolbar = $("#main-toolbar");
        if ($mainToolbar.length) {
            const $iconGroup = $mainToolbar.find(".buttons").first();
            if ($iconGroup.length) { $iconGroup.append($toolbarBtn); }
            else { $mainToolbar.append($toolbarBtn); }
        }
        const TOGGLE_CMD_ID = "figmaToCode.toggle";
        CommandManager.register("Toggle FigmaToCode", TOGGLE_CMD_ID, togglePanel);
        try {
            const viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
            if (viewMenu) { viewMenu.addMenuItem(TOGGLE_CMD_ID); }
        } catch (e) { /* non-fatal */ }
        applyTheme();
        console.log("FigmaToCode ready.");
    });
});
