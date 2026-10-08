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
    const PANEL_WIDTH  = 440;   // keep in sync with .f2c-panel width in style.css
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
    def("seat",      "string",  "");   // legacy (seat choice was removed in 1.0.7)
    def("outDir",    "string",  "figma");
    def("lastAction","string",  "convert");

    function getToken()   { return (prefs.get("token") || "").trim(); }
    function setToken(v)  { prefs.set("token", (v || "").trim()); prefs.save(); }
    // The token is only stored AFTER Figma accepts it, so a typo or a pasted link
    // can't silently become the saved token.
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
            ui.tokenDraft = ""; ui.tokenBad = false;
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
    function isOnboarded(){ return !!prefs.get("onboarded"); }
    function setOnboarded(v){ prefs.set("onboarded", !!v); prefs.save(); }
    function getScale()   { const s = Number(prefs.get("scale")); return (s >= 1 && s <= 4) ? s : 2; }
    function setScale(v)  { prefs.set("scale", Number(v) || 2); prefs.save(); }

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
        tokenBad: false,    // Figma rejected the SAVED token (expired / revoked)
        tutError: "",       // tutorial: tried to continue without a token
        busy: "",           // "convert" | "ai" while that job runs, else ""
        loadSeq: 0,         // bumps on every Load; stale responses are dropped
        notice: "",         // neutral note about what the link points at
        frameTotal: 0,      // frames in the file (we show at most MAX_FRAMES)
        filter: "",         // frame-name filter text
        confirm: null,      // pending "file exists: Replace / Keep both"
        result: null,       // last successful job (persistent card with next steps)
        drawer: false,      // settings drawer open
        inputModeShown: null, // "token" | "link" currently shown in the top input
        loadedUrl: "",
        pages: 1
    };

    // ============================================================
    //  Helpers
    // ============================================================
    function esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    // File-name slug. Keeps letters/digits from ANY script (a frame named "ホーム"
    // used to become "figma" and collide with every other non-Latin frame).
    function safeName(s) {
        let out = String(s == null ? "" : s).toLowerCase();
        try { out = out.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-"); }
        catch (e) { out = out.replace(/[^a-z0-9]+/g, "-"); }
        out = out.replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
        return out || "figma";
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
        const kind = (v.match(/figma\.com\/(board|slides|deck|site|make|community)\b/i) || [])[1];
        if (kind) {
            const k = kind.toLowerCase();
            if (k === "board") { return "FigJam boards can't be converted. Use a link to a frame in a Figma Design file."; }
            if (k === "slides" || k === "deck") { return "Figma Slides can't be converted. Use a link to a frame in a Figma Design file."; }
            if (k === "site") { return "Figma Sites can't be converted. Use a link to a frame in a Figma Design file."; }
            if (k === "make") { return "Figma Make files can't be converted. Use a link to a frame in a Figma Design file."; }
            return "That's a Community page. Duplicate the file to your drafts, then copy a frame link from your copy.";
        }
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
    // Frames we can convert. Modern files keep screens inside SECTIONs (and
    // sometimes GROUPs), so look inside those too. Returns at most MAX_FRAMES, with
    // .total = how many exist, so the UI can say "Showing 40 of 120".
    function collectFrames(doc) {
        const FRAME_TYPES = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"];
        const out = [];
        let total = 0;
        const pages = (doc && Array.isArray(doc.children)) ? doc.children : [];
        function take(n, page, depth) {
            if (!n || typeof n !== "object" || n.visible === false) { return; }
            if (FRAME_TYPES.indexOf(n.type) !== -1) {
                total++;
                if (out.length < MAX_FRAMES) {
                    const box = (n.absoluteBoundingBox && typeof n.absoluteBoundingBox === "object") ? n.absoluteBoundingBox : {};
                    out.push({ id: n.id, name: n.name || n.type, w: +box.width || 0, h: +box.height || 0, page: page, imgUrl: null });
                }
            } else if ((n.type === "SECTION" || n.type === "GROUP") && depth < 3 && Array.isArray(n.children)) {
                n.children.forEach(function (c) { take(c, page, depth + 1); });
            }
        }
        pages.forEach(function (p) {
            if (p && typeof p === "object" && Array.isArray(p.children)) {
                const pageName = typeof p.name === "string" ? p.name : "";
                p.children.forEach(function (c) { take(c, pageName, 0); });
            }
        });
        out.total = total;
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

    // ============================================================
    //  Files: output folder, safe writes, local asset downloads
    // ============================================================
    function getOutDir() {
        const d = String(prefs.get("outDir") || "figma").trim().replace(/^\/+|\/+$/g, "");
        return d || "figma";
    }
    function setOutDir(v) { prefs.set("outDir", String(v || "").trim().replace(/^\/+|\/+$/g, "") || "figma"); prefs.save(); }
    function getLastAction() { return prefs.get("lastAction") === "ai" ? "ai" : "convert"; }
    function setLastAction(v) { prefs.set("lastAction", v === "ai" ? "ai" : "convert"); prefs.save(); }
    function projectRootPath() {
        const root = ProjectManager.getProjectRoot();
        return root ? root.fullPath : null;
    }
    function fileExists(path) {
        return new Promise(function (resolve) {
            try { FileSystem.getFileForPath(path).exists(function (err, yes) { resolve(!err && !!yes); }); }
            catch (e) { resolve(false); }
        });
    }
    // "home.html" taken -> "home-2.html", "home-3.html", ...
    async function freePath(dir, base, ext) {
        let path = dir + base + ext, i = 2;
        while (await fileExists(path)) { path = dir + base + "-" + i + ext; i++; }
        return path;
    }
    function ensureDir(path) {
        return new Promise(function (resolve, reject) {
            FileSystem.getDirectoryForPath(path).create(function (err) {
                if (err && err !== "AlreadyExists") { reject(new Error("Could not create folder " + path + " (" + err + ")")); }
                else { resolve(); }
            });
        });
    }
    function writeBytes(path, buf) {
        return new Promise(function (resolve, reject) {
            const enc = (window.fs && window.fs.BYTE_ARRAY_ENCODING) || "byte_array";
            FileSystem.getFileForPath(path).write(buf, { encoding: enc, blind: true }, function (err) {
                if (err) { reject(new Error("Could not write " + path + " (" + err + ")")); } else { resolve(); }
            });
        });
    }

    function writeAndOpen(path, contents) {
        // Write text and open it. If the file is open in the editor, go through its
        // Document so the editor sees the new contents (a raw write would trip
        // ContentsModified). Callers decide overwrite policy BEFORE calling this.
        return new Promise(function (resolve, reject) {
            function openIt() { CommandManager.execute(Commands.FILE_OPEN, { fullPath: path }).always(function () { resolve(path); }); }
            let openDoc = null;
            try { openDoc = DocumentManager.getOpenDocumentForPath(path); } catch (e) { openDoc = null; }
            if (openDoc) {
                try {
                    openDoc.setText(contents);
                    CommandManager.execute(Commands.FILE_SAVE, { doc: openDoc }).always(openIt);
                    return;
                } catch (e) { /* fall through to blind write */ }
            }
            const file = FileSystem.getFileForPath(path);
            FileUtils.writeText(file, contents, true)
                .done(openIt)
                .fail(function (err) { reject(new Error("Could not write file: " + err)); });
        });
    }
    function extFromType(ct, fallback) {
        ct = String(ct || "").toLowerCase();
        if (ct.indexOf("svg") >= 0) { return "svg"; }
        if (ct.indexOf("jpeg") >= 0 || ct.indexOf("jpg") >= 0) { return "jpg"; }
        if (ct.indexOf("webp") >= 0) { return "webp"; }
        if (ct.indexOf("gif") >= 0) { return "gif"; }
        if (ct.indexOf("png") >= 0) { return "png"; }
        return fallback || "png";
    }
    // Download a set of {key, url, base} into dirPath. Returns {map: key->fileName,
    // failed: n}. Figma export URLs expire in about a week, so the generated code
    // must point at local copies, never at the URLs. 6 at a time; a failed
    // download leaves that key out of the map (caller falls back to the URL).
    async function downloadAssets(items, dirPath, onProgress) {
        const map = {}; let failed = 0, done = 0;
        if (!items.length) { return { map: map, failed: 0 }; }
        await ensureDir(dirPath);
        const used = {};
        const queue = items.slice();
        async function worker() {
            while (queue.length) {
                const it = queue.shift();
                try {
                    const res = await fetch(it.url);
                    if (!res.ok) { throw new Error("HTTP " + res.status); }
                    const buf = await res.arrayBuffer();
                    const ext = extFromType(res.headers.get("content-type"), it.ext);
                    let name = it.base, i = 2;
                    while (used[name + "." + ext]) { name = it.base + "-" + i; i++; }
                    used[name + "." + ext] = true;
                    await writeBytes(dirPath + name + "." + ext, buf);
                    map[it.key] = name + "." + ext;
                } catch (e) { failed++; }
                done++;
                if (onProgress) { onProgress(done, items.length); }
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(6, items.length); i++) { workers.push(worker()); }
        await Promise.all(workers);
        return { map: map, failed: failed };
    }

    // ============================================================
    //  Panel DOM - one screen. Input on top asks for whatever is
    //  needed next (token, then link); frames in the middle; one
    //  action at the bottom. Settings live in a drawer under the gear.
    // ============================================================
    const ICONS = {
        link:  '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        key:   '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.5 12.5 20 3"/><path d="M16 7l3 3"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
        gear:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        ext:   '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/>'
    };
    function svg(key) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[key] || "") + '</svg>'; }

    const $panel = $(
        '<div id="f2c-panel" class="f2c-panel" role="dialog" aria-label="Figma to Code" style="display:none;">' +
            '<div class="f2c-progress" aria-hidden="true"></div>' +
            '<div class="f2c-top">' +
                '<span class="f2c-top-icon">' + svg("link") + '</span>' +
                '<input type="text" class="f2c-input" spellcheck="false" autocomplete="off" aria-label="Figma frame link" />' +
                '<button type="button" class="f2c-icon-btn f2c-gear" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="f2c-drawer">' + svg("gear") + '</button>' +
            '</div>' +
            '<div class="f2c-under"></div>' +
            '<div class="f2c-drawer" id="f2c-drawer" hidden></div>' +
            '<div class="f2c-body"></div>' +
            '<div class="f2c-foot"></div>' +
            '<div class="f2c-live" aria-live="polite"></div>' +
        '</div>'
    ).appendTo("body");
    const $body = $panel.find(".f2c-body");
    const $input = $panel.find(".f2c-input");
    const $under = $panel.find(".f2c-under");
    const $drawer = $panel.find(".f2c-drawer");
    const $foot = $panel.find(".f2c-foot");
    const $live = $panel.find(".f2c-live");
    function announce(text) { $live.text(""); setTimeout(function () { $live.text(text || ""); }, 30); }
    function flash(kind, msg) {
        ui.error = kind === "err" ? msg : "";
        ui.info  = kind === "ok"  ? msg : "";
        if (msg) { announce(msg); }
    }
    function aiAvailable() { return !!document.querySelector(".ai-chat-textarea"); }
    function inputMode() { return (!getToken() || ui.tokenBad) ? "token" : "link"; }
    function getMode() { return getLastAction(); }

    // ---- top input: attributes only, never the value (keeps caret while typing) ----
    function renderTop() {
        const mode = inputMode();
        const checking = ui.tokenCheck && ui.tokenCheck.status === "checking";
        const lock = ui.loading || !!ui.busy || !!ui.confirm || checking;
        if (ui.inputModeShown !== mode) {
            // Mode changed (token saved, or token died): swap the field over.
            ui.inputModeShown = mode;
            $input.val(mode === "link" ? (ui.urlDraft != null ? ui.urlDraft : (prefs.get("lastUrl") || "")) : (ui.tokenDraft || ""));
        }
        $input.attr({
            type: mode === "token" ? "password" : "text",
            placeholder: mode === "token" ? "Paste your Figma token to begin" : "Paste a Figma frame link",
            "aria-label": mode === "token" ? "Figma personal access token" : "Figma frame link"
        }).prop("disabled", lock);
        $panel.find(".f2c-top-icon").html(mode === "token" ? svg("key") : svg("link")).toggleClass("f2c-top-icon-key", mode === "token");
        $panel.toggleClass("f2c-is-busy", !!(ui.loading || ui.busy || checking));
        $panel.find(".f2c-gear").attr("aria-expanded", ui.drawer ? "true" : "false").toggleClass("f2c-gear-on", !!ui.drawer);
    }
    // ---- line under the input: error > token message > notice > hint ----
    function renderUnder() {
        const mode = inputMode();
        let cls = "", text = "", html = "";
        if (ui.urlError) { cls = "f2c-under-err"; text = ui.urlError; }
        else if (ui.tokenCheck && ui.tokenCheck.status === "err") { cls = "f2c-under-err"; text = ui.tokenCheck.msg; }
        else if (ui.tokenCheck && ui.tokenCheck.status === "checking") { text = "Checking the token with Figma…"; }
        else if (ui.tokenCheck && ui.tokenCheck.status === "ok" && mode === "link" && !ui.frames.length) { cls = "f2c-under-ok"; text = "Connected as " + ui.tokenCheck.who + ". Now paste a frame link."; }
        else if (mode === "token") {
            html = (ui.tokenBad ? "Your saved token stopped working. " : "") +
                'In Figma: Settings → Security → Personal access tokens, scope <b>File content: read</b>. ' +
                '<button type="button" class="f2c-link" data-open-url="' + TOKEN_HELP_URL + '">Show me</button>';
        }
        else if (ui.error && !ui.frames.length) { cls = "f2c-under-err"; text = ui.error; }   // with frames, the footer shows it
        else if (ui.notice && !ui.loading) { text = ui.notice; }
        else if (ui.loading) { text = ui.info || "Loading…"; }
        else if (!ui.frames.length) { text = "In Figma, right-click a frame → Copy link to selection."; }
        $under.attr("class", "f2c-under " + cls).attr("role", cls === "f2c-under-err" ? "alert" : null);
        if (html) { $under.html(html); } else { $under.text(text); }
        $under.toggle(!!(text || html));
    }
    // ---- settings drawer ----
    function renderDrawer() {
        if (!ui.drawer) { $drawer.attr("hidden", true).empty(); return; }
        const token = getToken();
        const masked = token ? (token.slice(0, 6) + "…" + token.slice(-4)) : "";
        const scale = getScale();
        let opts = "";
        [1, 2, 3, 4].forEach(function (s) { opts += '<option value="' + s + '"' + (s === scale ? " selected" : "") + '>' + s + '×</option>'; });
        const tc = ui.tokenCheck || {};
        let tokenLine;
        if (tc.status === "checking") { tokenLine = '<span class="f2c-dim">Checking…</span>'; }
        else if (tc.status === "ok") { tokenLine = '<span class="f2c-okc">Connected as ' + esc(tc.who) + '</span>'; }
        else if (token && ui.tokenBad) { tokenLine = '<span class="f2c-errc">' + esc(masked) + ' no longer works</span>'; }
        else if (token) { tokenLine = '<span class="f2c-mono">' + esc(masked) + '</span>'; }
        else { tokenLine = '<span class="f2c-dim">None saved</span>'; }
        $drawer.removeAttr("hidden").html(
            '<div class="f2c-set">' +
                '<div class="f2c-set-k">Figma token</div>' +
                '<div class="f2c-set-v">' + tokenLine + '</div>' +
                '<div class="f2c-set-a">' +
                    (token ? '<button type="button" class="f2c-link" data-action="test-token"' + (tc.status === "checking" ? " disabled" : "") + '>Test</button>' +
                             '<button type="button" class="f2c-link" data-action="replace-token">Replace</button>' +
                             '<button type="button" class="f2c-link" data-action="clear-token">Remove</button>' : "") +
                '</div>' +
            '</div>' +
            '<div class="f2c-set">' +
                '<div class="f2c-set-k"><label for="f2c-outdir">Output folder</label></div>' +
                '<div class="f2c-set-v"><input id="f2c-outdir" type="text" class="f2c-outdir f2c-mini" spellcheck="false" value="' + esc(getOutDir()) + '" /><span class="f2c-dim">/ in your project</span></div>' +
            '</div>' +
            '<div class="f2c-set">' +
                '<div class="f2c-set-k"><label for="f2c-scale">AI design image</label></div>' +
                '<div class="f2c-set-v"><select id="f2c-scale" class="f2c-scale f2c-mini">' + opts + '</select><span class="f2c-dim">2× is plenty</span></div>' +
            '</div>' +
            '<div class="f2c-set f2c-set-note">Token is stored only in Phoenix preferences on this machine. Icons and images are copied into <b>' + esc(getOutDir()) + '/assets/</b> so pages keep working after Figma links expire.</div>'
        );
    }
    // ---- middle: frames ----
    function visibleFrames() {
        const q = ui.filter.trim().toLowerCase();
        if (!q) { return ui.frames; }
        return ui.frames.filter(function (f) { return (f.name + " " + (f.page || "")).toLowerCase().indexOf(q) >= 0; });
    }
    function thumbHtml(f, cls) {
        if (f.imgUrl) { return '<span class="' + cls + '"><img src="' + esc(f.imgUrl) + '" alt="" loading="lazy" /></span>'; }
        return '<span class="' + cls + (f.imgFailed ? " f2c-thumb-none" : " f2c-thumb-wait") + '"></span>';
    }
    function sizeOf(f) { return (f.w && f.h) ? Math.round(f.w) + "×" + Math.round(f.h) : ""; }
    function listHtml() {
        const list = visibleFrames();
        if (!list.length) { return '<div class="f2c-empty">Nothing matches "' + esc(ui.filter.trim()) + '". <button type="button" class="f2c-link" data-action="clear-filter">Clear</button></div>'; }
        let html = '<div class="f2c-list" role="listbox" aria-label="Frames">';
        list.forEach(function (f) {
            const sel = f.id === ui.selectedId;
            html += '<button type="button" class="f2c-row' + (sel ? " f2c-row-on" : "") + '" data-id="' + esc(f.id) + '" role="option" aria-selected="' + (sel ? "true" : "false") + '"' + (ui.busy ? " disabled" : "") + '>' +
                thumbHtml(f, "f2c-thumb") +
                '<span class="f2c-row-main"><span class="f2c-row-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
                (ui.pages > 1 && f.page ? '<span class="f2c-row-sub">' + esc(f.page) + '</span>' : "") + '</span>' +
                '<span class="f2c-row-size f2c-mono">' + esc(sizeOf(f)) + '</span>' +
                '<span class="f2c-row-check">' + svg("check") + '</span>' +
            '</button>';
        });
        return html + '</div>';
    }
    function renderBody() {
        let html = "";
        if (ui.loading && !ui.frames.length) {
            html = '<div class="f2c-skel"><div></div><div></div><div></div></div>';
        } else if (ui.frames.length === 1) {
            const f = ui.frames[0];
            html = '<div class="f2c-one">' + thumbHtml(f, "f2c-one-img") +
                '<div class="f2c-one-meta"><span class="f2c-one-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
                '<span class="f2c-mono f2c-dim">' + esc(sizeOf(f)) + '</span>' +
                (f.imgFailed ? '<button type="button" class="f2c-link" data-action="retry-thumbs">Load preview</button>' : "") + '</div></div>';
        } else if (ui.frames.length > 1) {
            const shown = ui.frames.length, total = ui.frameTotal || shown;
            const anyFailed = ui.frames.some(function (f) { return f.imgFailed; });
            html = '<div class="f2c-listhead">' +
                '<span class="f2c-listhead-name" title="' + esc(ui.fileName || "") + '">' + esc(ui.fileName || "Figma file") + '</span>' +
                '<span class="f2c-dim f2c-nowrap">' + (total > shown ? shown + " of " + total : shown + " frames") + '</span>' +
                (anyFailed && !ui.loading ? '<button type="button" class="f2c-link" data-action="retry-thumbs">Previews</button>' : "") +
                '<button type="button" class="f2c-link" data-action="reload"' + (ui.loading || ui.busy ? " disabled" : "") + '>Reload</button>' +
            '</div>';
            if (shown > 8) {
                html += '<div class="f2c-filterrow">' + svg("search") + '<input type="text" class="f2c-filter f2c-mini" placeholder="Filter" aria-label="Filter frames" value="' + esc(ui.filter) + '" /></div>';
            }
            if (total > shown) { html += '<div class="f2c-dim f2c-small f2c-pad-x">First ' + MAX_FRAMES + ' only. Link to a specific frame to reach the rest.</div>'; }
            html += listHtml();
        }
        $body.html(html).toggle(!!html);
    }
    // ---- bottom: result / confirm / mode + one button ----
    function renderFoot() {
        if (!ui.frames.length && !ui.confirm && !ui.result) { $foot.empty().hide(); return; }
        let html = "";
        if (ui.confirm) {
            const c = ui.confirm;
            html = '<div class="f2c-ask" role="alertdialog" aria-label="File already exists">' +
                '<span class="f2c-ask-text"><b>' + esc(c.rel) + '</b> exists' + (c.dirty ? " with unsaved edits" : "") + '.</span>' +
                '<span class="f2c-ask-btns">' +
                    '<button type="button" class="f2c-btn f2c-btn-primary f2c-btn-sm" data-action="keep-both">Keep both</button>' +
                    '<button type="button" class="f2c-btn f2c-btn-sm" data-action="replace">Replace</button>' +
                    '<button type="button" class="f2c-link" data-action="cancel-confirm">Cancel</button>' +
                '</span></div>';
            $foot.html(html).show(); return;
        }
        if (ui.result) {
            const r = ui.result;
            html += '<div class="f2c-done" role="status">' + svg("check") +
                (r.kind === "convert"
                    ? '<span class="f2c-done-text" title="' + esc(r.detail) + '">Wrote <b>' + esc(r.rel) + '</b></span>' +
                      '<button type="button" class="f2c-link" data-action="open-preview">Preview</button>' +
                      '<button type="button" class="f2c-link" data-action="show-tree">Files</button>'
                    : '<span class="f2c-done-text">Prompt ready in the AI panel. Review it, then send.</span>' +
                      '<button type="button" class="f2c-link" data-action="go-ai">Go to AI</button>') +
            '</div>';
        } else if (ui.error && ui.frames.length) {
            html += '<div class="f2c-done f2c-done-err" role="alert">' + esc(ui.error) + '</div>';
        }
        if (ui.frames.length) {
            const mode = getMode(), ai = mode === "ai", canAi = aiAvailable();
            const sel = !!ui.selectedId;
            const lock = ui.loading || !!ui.busy;
            const dis = !sel || lock || (ai && !canAi);
            html += '<div class="f2c-bar">' +
                '<div class="f2c-seg" role="radiogroup" aria-label="Output">' +
                    '<button type="button" class="f2c-seg-btn' + (!ai ? " f2c-seg-on" : "") + '" role="radio" aria-checked="' + (!ai) + '" data-mode="convert" title="Instant local HTML/CSS, approximate"' + (lock ? " disabled" : "") + '>Local</button>' +
                    '<button type="button" class="f2c-seg-btn' + (ai ? " f2c-seg-on" : "") + '" role="radio" aria-checked="' + ai + '" data-mode="ai" title="' + (canAi ? "Phoenix AI rebuilds it closely (slower)" : "Open the AI tab in the sidebar first") + '"' + (lock ? " disabled" : "") + '>AI</button>' +
                '</div>' +
                '<span class="f2c-bar-status">' + (ui.busy ? esc(ui.info || "Working…") : (!sel ? "Pick a frame" : (ai && !canAi ? "Open the AI tab first" : ""))) + '</span>' +
                '<button type="button" class="f2c-btn f2c-btn-primary f2c-go" data-action="' + mode + '"' + (dis ? " disabled" : "") + ' title="' + (ai ? "Send to the AI panel" : "Write HTML/CSS into " + esc(getOutDir()) + "/") + ' (⌘⏎)">' +
                    (ui.busy ? '<span class="f2c-spin"></span>' : (ai ? "Send to AI" : "Convert")) + '</button>' +
            '</div>';
        }
        $foot.html(html).show();
    }
    // Re-render everything but the input's text, keeping keyboard focus in place.
    function renderPanel() {
        const act = document.activeElement;
        let restore = null;
        if (act && act !== $input[0] && $panel[0].contains(act)) {
            const $a = $(act);
            const id = $a.attr("data-id"), action = $a.attr("data-action"), mode = $a.attr("data-mode");
            const cls = (act.className || "").split(/\s+/).filter(function (c) { return c && c.indexOf("f2c-") === 0 && !/-on$|-err$/.test(c); })[0];
            restore = { sel: id ? '[data-id="' + id.replace(/"/g, '\\"') + '"]' : action ? '[data-action="' + action + '"]' : mode ? '[data-mode="' + mode + '"]' : cls ? "." + cls : null,
                        start: act.selectionStart, end: act.selectionEnd, isInput: /^(INPUT|TEXTAREA|SELECT)$/.test(act.tagName) };
        }
        renderTop(); renderUnder(); renderDrawer(); renderBody(); renderFoot();
        if (restore && restore.sel) {
            const el = $panel.find(restore.sel).filter(":not([disabled])").get(0);
            if (el) { try { el.focus(); if (restore.isInput && typeof restore.start === "number") { el.setSelectionRange(restore.start, restore.end); } } catch (e) { /* ignore */ } }
        }
        if ($panel.is(":visible")) { positionPanel(); }
    }
    function focusInput() { setTimeout(function () { $input.trigger("focus"); }, 0); }
    function focusTokenField() { focusInput(); }
    function focusUrl() { focusInput(); }
    function focusFirstFrame() { setTimeout(function () { if (!$panel.find(":focus").length) { const $f = $body.find(".f2c-row-on, .f2c-row").first(); if ($f.length) { $f.trigger("focus"); } } }, 0); }

    // ============================================================
    //  Actions
    // ============================================================
    async function loadUrl(url, force) {
        if (ui.loading || ui.busy || ui.confirm) { return; }
        url = String(url == null ? "" : url).trim();
        ui.urlDraft = url;
        ui.error = ""; ui.info = "";
        const problem = checkUrlInput(url);
        ui.urlError = problem;
        if (problem) { renderPanel(); focusUrl(); return; }
        if (!getToken()) { renderPanel(); focusInput(); return; }
        // Same link again (Enter in the box, re-paste) keeps the loaded frames and
        // the selection instead of wiping them. "Reload" passes force.
        if (!force && url === ui.loadedUrl && ui.frames.length) { renderPanel(); return; }

        const parsed = parseFigmaUrl(url);
        const seq = ++ui.loadSeq;
        prefs.set("lastUrl", url); prefs.save();
        ui.loading = true; ui.info = "Loading frames…"; ui.frames = []; ui.selectedId = null;
        ui.notice = ""; ui.filter = ""; ui.result = null; ui.frameTotal = 0; ui.pages = 1;
        ui.fileKey = parsed.key; ui.loadedUrl = url;
        renderPanel();
        let frames, notice = "";
        try {
            if (parsed.nodeId) {
                const data = await figmaGet("/files/" + parsed.key + "/nodes?ids=" + encodeURIComponent(parsed.nodeId) + "&depth=3");
                const wrap = data.nodes && data.nodes[parsed.nodeId];
                const doc = wrap && wrap.document;
                if (!doc) { throw new Error("Couldn't find that layer in the file. It may have been deleted, or the link is from another file."); }
                if (seq !== ui.loadSeq) { return; }
                ui.fileName = data.name || "";
                const t = doc.type;
                if (t === "CANVAS" || t === "SECTION") {
                    // A page or section link: list the frames inside it.
                    frames = collectFrames({ children: t === "CANVAS" ? [doc] : [{ name: doc.name, children: [doc] }] });
                    if (!frames.length) { throw new Error("That " + (t === "CANVAS" ? "page" : "section") + " has no frames in it."); }
                    notice = "That link points at a " + (t === "CANVAS" ? "page" : "section") + ", so here are the frames inside it.";
                } else if (["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"].indexOf(t) !== -1) {
                    const box = doc.absoluteBoundingBox || {};
                    frames = [{ id: doc.id, name: doc.name || t, w: box.width || 0, h: box.height || 0, imgUrl: null }];
                    if (t === "GROUP") { notice = "That's a group, not a frame. It will still convert, but a frame gives better layout."; }
                } else {
                    // A text layer, icon, shape… converting it alone makes little
                    // sense, so offer the file's frames instead.
                    const all = await figmaGet("/files/" + parsed.key + "?depth=3");
                    if (seq !== ui.loadSeq) { return; }
                    frames = collectFrames(all.document);
                    if (!frames.length) { throw new Error("That link points at a " + t.toLowerCase() + " layer, not a frame, and the file has no frames to pick from."); }
                    notice = "That link points at a " + t.toLowerCase() + " layer (\"" + (doc.name || "") + "\"), not a frame. Pick the frame it belongs to.";
                }
            } else {
                const data = await figmaGet("/files/" + parsed.key + "?depth=3");
                if (seq !== ui.loadSeq) { return; }
                ui.fileName = data.name || "";
                frames = collectFrames(data.document);
                if (!frames.length) { throw new Error("No frames found in this file. Link to a specific frame instead."); }
            }
        } catch (e) {
            const why = await explainError(e);
            if (seq !== ui.loadSeq) { return; }
            ui.loading = false; flash("err", why); renderPanel();
            return;
        }
        ui.frames = frames;
        ui.frameTotal = frames.total || frames.length;
        ui.pages = Object.keys(frames.reduce(function (m, f) { if (f.page) { m[f.page] = 1; } return m; }, {})).length || 1;
        ui.notice = notice;
        if (frames.length === 1) { ui.selectedId = frames[0].id; }
        ui.loading = false;
        flash("ok", "");
        announce(frames.length === 1 ? "Frame loaded" : frames.length + " frames loaded");
        renderPanel();
        focusFirstFrame();
        await loadThumbs(seq);
    }
    // Thumbnails are a nice-to-have: if they fail, the frames still work. 1× is
    // plenty for 170px tiles and keeps big files fast.
    async function loadThumbs(seq) {
        const frames = ui.frames, key = ui.fileKey;
        frames.forEach(function (f) { f.imgFailed = false; });
        try {
            const images = await fetchImages(key, frames.map(function (f) { return f.id; }), 1);
            if (seq !== ui.loadSeq) { return; }
            frames.forEach(function (f) { f.imgUrl = images[f.id] || null; f.imgFailed = !f.imgUrl; });
        } catch (e) {
            if (seq !== ui.loadSeq) { return; }
            frames.forEach(function (f) { f.imgFailed = true; });
        }
        if (!ui.busy) { renderPanel(); }
    }
    // A 401/403 can mean "token is dead" OR "token is fine but can't open this
    // file". Ask /me once to tell them apart, so the message points at the real fix.
    async function explainError(e) {
        const msg = (e && e.message) || String(e);
        if (!/rejected your token/.test(msg)) { return msg; }
        try {
            await figmaGet("/me");
            return "Your token works, but it can't open this file. Check the file is shared with your Figma account.";
        } catch (e2) {
            if (/rejected your token/.test((e2 && e2.message) || "")) { ui.tokenBad = true; return ""; }
            return msg;
        }
    }
    function testSavedToken() {
        if (!getToken() || (ui.tokenCheck && ui.tokenCheck.status === "checking")) { return; }
        ui.tokenCheck = { status: "checking" }; renderPanel();
        figmaGet("/me").then(function (me) {
            ui.tokenBad = false;
            ui.tokenCheck = { status: "ok", who: me.email || me.handle || "you" };
        }).catch(function (err) {
            const m = (err && err.message) || "Token check failed.";
            if (/rejected your token/.test(m)) { ui.tokenBad = true; }
            ui.tokenCheck = { status: "err", msg: ui.tokenBad ? "Figma no longer accepts this token (expired or revoked). Paste a new one above." : m };
        }).then(renderPanel);
    }

    // ---- Prompt for Build with AI ----
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
    // Asset paths (icons/vectors + raster image fills) with layer names.
    function assetLines(root, assetMap, fillMap) {
        const lines = [];
        (function walk(n) {
            if (!n || n.visible === false) { return; }
            if (n !== root && isFlatAsset(n)) { if (assetMap[n.id]) { lines.push('- "' + (n.name || n.type) + '" (' + n.type + '): ' + assetMap[n.id]); } return; }
            const imgf = topImageFill(n);
            if (imgf && imgf.imageRef && fillMap[imgf.imageRef]) { lines.push('- "' + (n.name || n.type) + '" (image fill, ' + (imgf.scaleMode || "FILL") + '): ' + fillMap[imgf.imageRef]); }
            (n.children || []).forEach(walk);
        })(root);
        return lines;
    }
    // assetMap/fillMap hold LOCAL project-relative paths when the download worked,
    // otherwise the Figma URL (which expires in about a week).
    function buildClaudePrompt(doc, previewPath, assetMap, fillMap, link, outRel) {
        const url = link || frameUrl(ui.fileKey, ui.selectedId);
        const name = doc.name || "frame";
        const box = doc.absoluteBoundingBox || {};
        const assets = assetLines(doc, assetMap, fillMap);
        const target = outRel || "figma/" + safeName(name) + ".html";
        const p = [];
        p.push("Build this Figma frame as clean, semantic, responsive HTML & CSS in my current Phoenix Code project, matching the design exactly. Write it to " + target + " (replace it if it exists) and open Live Preview when done.");
        p.push("");
        p.push('Frame: "' + name + '"  ' + Math.round(box.width) + "x" + Math.round(box.height) + "px");
        p.push("Figma link: " + url);
        if (previewPath) {
            p.push("");
            p.push("Rendered design (visual source of truth): " + previewPath);
            p.push(/^https?:/.test(previewPath)
                ? "If you can view or download images, fetch that PNG and match it pixel for pixel."
                : "Read that PNG with your image tools first and match it pixel for pixel.");
        }
        p.push("");
        p.push("If the Figma design-to-code tool (get_design_context / Figma MCP) is available, prefer it for this frame. Otherwise use the exact assets + structure below.");
        if (assets.length) {
            p.push("");
            p.push("Assets (paths are relative to the project root; reference them from the HTML with paths relative to " + target + "). Use these EXACT files, never invent or omit icons/images:");
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
        try {
            const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
            const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
            if (desc && desc.set) { desc.set.call(ta, text); } else { ta.value = text; }
        } catch (e) { ta.value = text; }
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    }
    function showAiPanel() {
        try { const tab = document.querySelector('.sidebar-tab[data-tab-id="ai"]'); if (tab && !tab.classList.contains("active")) { tab.click(); } } catch (e) { /* ignore */ }
        const ta = document.querySelector(".ai-chat-textarea");
        if (ta) { try { ta.focus(); ta.scrollTop = 0; } catch (e) { /* ignore */ } }
    }

    // ---- Jobs: one at a time; the target frame is fixed when the job starts ----
    function beginJob(kind, msg) {
        if (ui.busy || ui.loading || ui.confirm || !ui.selectedId || !ui.fileKey) { return null; }
        if (!getToken()) { renderPanel(); focusInput(); return null; }
        if (!projectRootPath()) { flash("err", "Open a project folder first (File → Open Folder)."); renderPanel(); return null; }
        ui.busy = kind; ui.error = ""; ui.info = msg; ui.needToken = false; ui.result = null; renderPanel();
        const frame = ui.frames.filter(function (f) { return f.id === ui.selectedId; })[0];
        return { key: ui.fileKey, id: ui.selectedId, name: frame ? frame.name : "", root: projectRootPath() };
    }
    function step(msg) { ui.info = msg; announce(msg); renderFoot(); renderUnder(); }
    function endJob(kind, msg) { ui.busy = ""; flash(kind, msg); renderPanel(); }

    // Fetch the frame + export icons/images and copy them into the project.
    // Returns everything both actions need. Throws on fatal errors.
    async function gatherFrame(job, opts) {
        const data = await figmaGet("/files/" + job.key + "/nodes?ids=" + encodeURIComponent(job.id) + "&geometry=paths");
        const wrap = data.nodes && data.nodes[job.id];
        const doc  = wrap && wrap.document;
        if (!doc) { throw new Error("Couldn't fetch that frame's details."); }
        const slug = safeName(job.name || doc.name);
        const outDir = getOutDir();
        const assetsRel = outDir + "/assets/" + slug + "/";
        const assetsAbs = job.root + assetsRel;
        const assetIds = collectAssetIds(doc);
        const imageRefs = collectImageRefs(doc);
        step("Exporting " + assetIds.length + " icons, " + imageRefs.length + " images…");
        let assetUrls = {}, fillUrls = {};
        if (assetIds.length) { try { assetUrls = await fetchImages(job.key, assetIds, 2); } catch (e) { assetUrls = {}; } }
        if (imageRefs.length) { try { fillUrls = await fetchImageFills(job.key); } catch (e) { fillUrls = {}; } }
        let previewUrl = null;
        if (opts.preview) {
            step("Rendering the design…");
            try { const pm = await fetchImages(job.key, [job.id], getScale()); previewUrl = pm[job.id] || null; } catch (e) { previewUrl = null; }
        }
        // Download everything into <out>/assets/<slug>/ so the code keeps working
        // after Figma's URLs expire.
        const items = [];
        const nameOf = {};
        (function walk(n) {
            if (!n || n.visible === false) { return; }
            if (assetUrls[n.id] && !nameOf[n.id]) { nameOf[n.id] = n.name || n.type; }
            (n.children || []).forEach(walk);
        })(doc);
        assetIds.forEach(function (id) { if (assetUrls[id]) { items.push({ key: "a:" + id, url: assetUrls[id], base: safeName(nameOf[id] || "icon"), ext: "png" }); } });
        imageRefs.forEach(function (ref) { if (fillUrls[ref]) { items.push({ key: "f:" + ref, url: fillUrls[ref], base: "image-" + ref.slice(0, 8), ext: "png" }); } });
        if (previewUrl) { items.push({ key: "preview", url: previewUrl, base: "design", ext: "png" }); }
        let dl = { map: {}, failed: 0 };
        if (items.length) {
            step("Saving " + items.length + " files…");
            dl = await downloadAssets(items, assetsAbs, function (d, t) { if (d % 5 === 0 || d === t) { ui.info = "Saving files… " + d + "/" + t; renderPanel(); } });
        }
        // Maps the generator/prompt use: local path if saved, else the URL.
        const assetMap = {}, fillMap = {}, promptAssets = {}, promptFills = {};
        const relFromHtml = "assets/" + slug + "/";   // html lives in <out>/, assets in <out>/assets/<slug>/
        assetIds.forEach(function (id) {
            if (!assetUrls[id]) { return; }
            const f = dl.map["a:" + id];
            assetMap[id] = f ? relFromHtml + f : assetUrls[id];
            promptAssets[id] = f ? assetsRel + f : assetUrls[id];
        });
        imageRefs.forEach(function (ref) {
            if (!fillUrls[ref]) { return; }
            const f = dl.map["f:" + ref];
            fillMap[ref] = f ? relFromHtml + f : fillUrls[ref];
            promptFills[ref] = f ? assetsRel + f : fillUrls[ref];
        });
        const previewLocal = dl.map.preview ? assetsRel + dl.map.preview : previewUrl;
        return {
            doc: doc, wrap: wrap, slug: slug, outDir: outDir,
            assetMap: assetMap, fillMap: fillMap, promptAssets: promptAssets, promptFills: promptFills,
            preview: previewLocal, savedCount: Object.keys(dl.map).length, failed: dl.failed,
            iconCount: assetIds.length, imageCount: imageRefs.length, capped: assetIds.length >= MAX_ASSETS
        };
    }

    async function quickConvert() {
        const job = beginJob("convert", "Reading frame…");
        if (!job) { return; }
        setLastAction("convert");
        try {
            const g = await gatherFrame(job, { preview: false });
            step("Generating…");
            const tokens = collectTokens(g.doc, (g.wrap && g.wrap.styles) || {});
            const html = generateFromNode(g.doc, g.assetMap, g.fillMap, tokens);
            const dir = job.root + g.outDir + "/";
            await ensureDir(dir);
            const path = dir + g.slug + ".html";
            const detail = g.savedCount + " files saved to " + g.outDir + "/assets/" + g.slug + "/" +
                (tokens.defs.length ? ", " + tokens.defs.length + " color tokens" : "") +
                (g.failed ? ". " + g.failed + " downloads failed and still point at Figma" : "") +
                (g.capped ? ". Hit the " + MAX_ASSETS + "-icon cap, some may be missing" : "") + ".";
            if (await fileExists(path)) {
                let dirty = false;
                try { const d = DocumentManager.getOpenDocumentForPath(path); dirty = !!(d && d.isDirty); } catch (e) { dirty = false; }
                ui.busy = ""; ui.info = "";
                ui.confirm = { path: path, rel: g.outDir + "/" + g.slug + ".html", dir: dir, slug: g.slug, html: html, detail: detail, dirty: dirty };
                renderPanel();
                setTimeout(function () { $foot.find('[data-action="keep-both"]').trigger("focus"); }, 0);
                return;
            }
            await finishConvert(path, html, detail);
        } catch (e) {
            endJob("err", await explainError(e));
        }
    }
    async function finishConvert(path, html, detail) {
        const root = projectRootPath() || "";
        await writeAndOpen(path, html);
        ui.result = { kind: "convert", path: path, rel: path.indexOf(root) === 0 ? path.slice(root.length) : path, detail: detail };
        endJob("ok", "");
        announce("Wrote " + ui.result.rel);
    }
    async function resolveConfirm(choice) {
        const c = ui.confirm;
        if (!c) { return; }
        ui.confirm = null;
        if (choice === "cancel") { renderPanel(); return; }
        ui.busy = "convert"; ui.info = "Writing…"; renderPanel();
        try {
            const path = choice === "keep-both" ? await freePath(c.dir, c.slug, ".html") : c.path;
            await finishConvert(path, c.html, c.detail);
        } catch (e) { endJob("err", e.message || String(e)); }
    }

    async function buildWithAi() {
        const job = beginJob("ai", "Reading frame…");
        if (!job) { return; }
        setLastAction("ai");
        try {
            const g = await gatherFrame(job, { preview: true });
            const outRel = g.outDir + "/" + g.slug + ".html";
            const prompt = buildClaudePrompt(g.doc, g.preview, g.promptAssets, g.promptFills, frameUrl(job.key, job.id), outRel);
            const filled = fillClaudeInput(prompt);
            if (filled) {
                showAiPanel();
                ui.result = { kind: "ai", detail: g.savedCount + " files saved to " + g.outDir + "/assets/" + g.slug + "/." };
                endJob("ok", "");
                announce("Prompt is ready in the AI panel");
            } else {
                const copied = await copyToClipboard(prompt);
                endJob(copied ? "ok" : "err", copied
                    ? "AI panel not found, so the prompt was copied. Open the AI tab and paste it."
                    : "AI panel not found and the clipboard is blocked. Open the AI tab in the sidebar and try again.");
            }
        } catch (e) {
            endJob("err", await explainError(e));
        }
    }

    // ---- Events ----
    let loadTimer = null;
    function openExternal(url) {
        try {
            const NativeApp = brackets.getModule("utils/NativeApp");
            if (NativeApp && NativeApp.openURLInDefaultBrowser) { NativeApp.openURLInDefaultBrowser(url); return; }
        } catch (e) { /* fall through */ }
        window.open(url, "_blank", "noopener");
    }
    function openLivePreview(path) {
        CommandManager.execute(Commands.FILE_OPEN, { fullPath: path }).always(function () {
            if (!$("#panel-live-preview-frame").is(":visible")) { try { CommandManager.execute(Commands.FILE_LIVE_FILE_PREVIEW); } catch (e) { /* ignore */ } }
        });
    }
    function runPrimary() {
        if (getMode() === "ai") { buildWithAi(); } else { quickConvert(); }
    }
    // The top input: a token until one is saved, then a link. Paste = load.
    function submitInput(fromEnter) {
        const v = String($input.val() || "").trim();
        if (inputMode() === "token") {
            ui.tokenDraft = v;
            if (/figma\.com\//i.test(v)) { ui.tokenCheck = { status: "err", msg: "That's a Figma link. Paste your token first; the link comes next.", field: true }; renderPanel(); return; }
            saveTokenAndValidate(v, function () { ui.tokenDraft = ""; ui.urlDraft = ""; renderPanel(); focusInput(); });
            return;
        }
        // A token pasted into the link box: save it instead of complaining.
        if (/^figd_[A-Za-z0-9_-]{20,}$/.test(v)) { ui.tokenDraft = v; saveTokenAndValidate(v, function () { $input.val(""); ui.urlDraft = ""; renderPanel(); focusInput(); }); return; }
        if (!v && !fromEnter) { ui.urlDraft = ""; ui.urlError = ""; renderUnder(); return; }
        loadUrl(v);
    }
    $input.on("input", function () {
        const v = String($(this).val() || "");
        clearTimeout(loadTimer);
        if (inputMode() === "token") {
            ui.tokenDraft = v;
            if (ui.tokenCheck && ui.tokenCheck.status === "err") { ui.tokenCheck = null; renderUnder(); }
            // Tokens are pasted, not typed: a plausible one checks itself.
            if (/^figd_[A-Za-z0-9_-]{20,}$/.test(v.trim())) { loadTimer = setTimeout(function () { submitInput(false); }, 120); }
            return;
        }
        ui.urlDraft = v;
        if (ui.urlError || ui.error) { ui.urlError = ""; ui.error = ""; renderUnder(); }
        if (ui.result) { ui.result = null; renderFoot(); }
        const t = v.trim();
        if (!t) { if (ui.frames.length) { ui.frames = []; ui.selectedId = null; ui.loadedUrl = ""; ui.notice = ""; ui.loadSeq++; ui.loading = false; renderPanel(); } return; }
        if (checkUrlInput(t) === "" || /^figd_/.test(t)) { loadTimer = setTimeout(function () { submitInput(false); }, 160); }
    });
    $input.on("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); clearTimeout(loadTimer); submitInput(true); }
    });
    $input.on("paste", function () { setTimeout(function () { $input.trigger("input"); }, 0); });

    $panel.on("click", ".f2c-gear", function () { ui.drawer = !ui.drawer; renderPanel(); if (ui.drawer) { setTimeout(function () { $drawer.find("button, input, select").first().trigger("focus"); }, 0); } });

    $panel.on("click", function (e) {
        const $t = $(e.target);
        if ($t.closest("button[disabled]").length) { return; }
        const openUrl = $t.closest("[data-open-url]").attr("data-open-url");
        if (openUrl) { openExternal(openUrl); return; }
        const mode = $t.closest("[data-mode]").attr("data-mode");
        if (mode) { setLastAction(mode); renderFoot(); return; }
        const action = $t.closest("[data-action]").attr("data-action");
        if (action) {
            if (action === "convert") { quickConvert(); }
            else if (action === "ai") { buildWithAi(); }
            else if (action === "replace" || action === "keep-both" || action === "cancel-confirm") { resolveConfirm(action === "cancel-confirm" ? "cancel" : action); }
            else if (action === "open-preview" && ui.result) { openLivePreview(ui.result.path); }
            else if (action === "show-tree" && ui.result) { try { ProjectManager.showInTree(FileSystem.getFileForPath(ui.result.path)); } catch (err) { /* ignore */ } }
            else if (action === "go-ai") { showAiPanel(); }
            else if (action === "reload") { loadUrl(ui.loadedUrl || $input.val(), true); }
            else if (action === "retry-thumbs") { if (!ui.loading && ui.frames.length) { ui.frames.forEach(function (f) { f.imgFailed = false; }); renderPanel(); loadThumbs(ui.loadSeq); } }
            else if (action === "clear-filter") { ui.filter = ""; renderBody(); $body.find(".f2c-filter").trigger("focus"); }
            else if (action === "test-token") { testSavedToken(); }
            else if (action === "replace-token") { ui.tokenBad = true; ui.tokenCheck = null; ui.drawer = false; ui.tokenDraft = ""; renderPanel(); focusInput(); }
            else if (action === "clear-token") { setToken(""); ui.tokenCheck = null; ui.tokenDraft = ""; ui.tokenBad = false; ui.frames = []; ui.selectedId = null; ui.result = null; ui.drawer = false; renderPanel(); focusInput(); }
            return;
        }
        const $row = $t.closest(".f2c-row");
        if ($row.length) {
            if (ui.busy) { return; }
            ui.selectedId = $row.attr("data-id"); ui.error = ""; ui.result = null;
            renderPanel(); return;
        }
    });
    $panel.on("keydown", ".f2c-row", function (e) {
        const keys = { ArrowDown: 1, ArrowUp: -1 };
        if (!(e.key in keys)) { return; }
        e.preventDefault();
        const $all = $body.find(".f2c-row"), j = $all.index(this) + keys[e.key];
        if (j >= 0 && j < $all.length) { $all.eq(j).trigger("focus"); }
    });
    // Cmd/Ctrl+Enter anywhere in the panel runs the primary action.
    $panel.on("keydown", function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            const $go = $foot.find(".f2c-go");
            if ($go.length && !$go.prop("disabled")) { e.preventDefault(); runPrimary(); }
        }
    });
    $panel.on("input", ".f2c-filter", function () { ui.filter = String($(this).val() || ""); const $l = $body.find(".f2c-list, .f2c-empty"); if ($l.length) { $l.replaceWith(listHtml()); } });
    $panel.on("change", ".f2c-scale", function () { setScale($(this).val()); });
    $panel.on("change blur", ".f2c-outdir", function () {
        const v = String($(this).val() || "").trim().replace(/^\/+|\/+$/g, "").replace(/\.\.+/g, "");
        setOutDir(v); if (!v) { $(this).val(getOutDir()); }
    });

    // ============================================================
    //  Toolbar button + open/close
    // ============================================================
    const $toolbarBtn = $('<a href="#" id="f2c-toolbar-btn" title="FigmaToCode" aria-label="FigmaToCode" aria-haspopup="dialog" aria-expanded="false"></a>');
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
        if (!$panel[0] || !document.body.contains($panel[0])) { $panel.appendTo("body"); }
        $panel.css("width", PANEL_WIDTH + "px").show();
        $toolbarBtn.attr("aria-expanded", "true");
        renderPanel();          // render first, THEN measure and position
        positionPanel();
        if (ui.frames.length && ui.selectedId) { focusFirstFrame(); } else { focusInput(); }
    }
    function closePanel() {
        if (!$panel.is(":visible")) { return; }
        const hadFocus = $panel[0].contains(document.activeElement);
        $panel.hide();
        $toolbarBtn.attr("aria-expanded", "false");
        if (hadFocus) { try { $toolbarBtn.trigger("focus"); } catch (e) { /* ignore */ } }
    }
    function togglePanel() { if ($panel.is(":visible")) { closePanel(); } else { openPanel(); } }

    $toolbarBtn.on("click", function (e) { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    $(document).off("mousedown.f2c keydown.f2c");
    $(document).on("mousedown.f2c", function (e) {
        if (!$panel.is(":visible")) { return; }
        if ($(e.target).closest("#f2c-panel, #f2c-toolbar-btn").length) { return; }
        // Keep the panel while something is running or waiting for an answer, so
        // the result/error isn't lost when the user clicks into the editor.
        if (ui.busy || ui.loading || ui.confirm) { return; }
        closePanel();
    });
    // Escape closes only when the panel itself has focus (not from the editor or a modal).
    $(document).on("keydown.f2c", function (e) {
        if (e.key === "Escape" && $panel.is(":visible") && $panel[0].contains(document.activeElement)) {
            if (ui.confirm) { resolveConfirm("cancel"); return; }
            closePanel();
        }
    });
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
