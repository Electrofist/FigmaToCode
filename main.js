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
    function saveTokenAndValidate(v) {
        if (!v || !v.trim()) { return; }
        setToken(v);
        ui.tokenCheck = { status: "checking" };
        renderPanel();
        figmaGet("/me").then(function (me) {
            ui.tokenCheck = { status: "ok", who: me.email || me.handle || "you" };
        }).catch(function (err) {
            ui.tokenCheck = { status: "err", msg: (err && err.message) || "Token check failed." };
        }).then(function () { renderPanel(); });
    }
    function tokenStatusHtml() {
        const c = ui.tokenCheck;
        if (!c) { return ""; }
        if (c.status === "checking") { return '<div class="f2c-status f2c-loading">Checking token…</div>'; }
        if (c.status === "ok") { return '<div class="f2c-status f2c-ok">✓ Connected as ' + esc(c.who) + '</div>'; }
        return '<div class="f2c-status f2c-err">' + esc(c.msg) + '</div>';
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
        selectedId: null
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
    function copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text);
            }
        } catch (e) { /* fall through */ }
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
        return Promise.resolve();
    }

    // Figma URLs: figma.com/(file|design|proto)/<KEY>/<title>?node-id=1-2
    function parseFigmaUrl(url) {
        url = (url || "").trim();
        const keyM = url.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
        const key  = keyM ? keyM[1] : null;
        let nodeId = null;
        const nm = url.match(/[?&]node-id=([^&]+)/);
        if (nm) { nodeId = decodeURIComponent(nm[1]).replace(/-/g, ":"); }
        return { key: key, nodeId: nodeId };
    }
    function frameUrl(key, nodeId) {
        return "https://www.figma.com/design/" + key + "/frame?node-id=" +
            encodeURIComponent(String(nodeId).replace(/:/g, "-"));
    }

    // ---- Figma REST ----
    function figmaGet(path) {
        const token = getToken();
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
    function fetchImages(key, ids, scale) {
        if (!ids.length) { return Promise.resolve({}); }
        const q = "?ids=" + encodeURIComponent(ids.join(",")) + "&format=png&scale=" + (scale || getScale());
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
    function isAsset(n) {
        if (!n) { return false; }
        if (/(^|[^a-z])(icon|logo|glyph)([^a-z]|$)/i.test(n.name || "")) { return true; }
        const vt = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "REGULAR_POLYGON"];
        if (vt.indexOf(n.type) !== -1) { return true; }
        return false;
    }
    function collectAssetIds(root) {
        const ids = [];
        (function walk(n) {
            if (!n || n.visible === false || ids.length >= MAX_ASSETS) { return; }
            if (n !== root && isAsset(n)) { ids.push(n.id); return; } // don't recurse into an asset
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

    // Visual-only declarations (fills, radius, stroke, shadow, opacity). No layout.
    function visualDecls(n, imageFillMap) {
        const d = [];
        const bg = backgroundFromFills(n.fills, 1);
        if (bg) { d.push((bg.indexOf("gradient") >= 0 ? "background:" : "background-color:") + bg); }
        d.push.apply(d, imageFillDecls(n, imageFillMap));
        const rad = radiusCss(n);
        if (rad) { d.push("border-radius:" + rad); }
        const stroke = firstVisible(n.strokes);
        if (stroke && stroke.type === "SOLID") { d.push("border:" + (n.strokeWeight || 1) + "px solid " + colorToCss(stroke.color)); }
        const sh = shadowCss(n.effects);
        if (sh) { d.push("box-shadow:" + sh); }
        if (typeof n.opacity === "number" && n.opacity < 1) { d.push("opacity:" + +n.opacity.toFixed(3)); }
        return d;
    }
    function textDecls(n, fonts) {
        const st = n.style || {};
        const d = [];
        const col = backgroundFromFills(n.fills, 1);
        if (col) { d.push("color:" + col); }
        if (st.fontSize)      { d.push("font-size:" + Math.round(st.fontSize) + "px"); }
        if (st.fontFamily)    { fonts[st.fontFamily] = true; d.push("font-family:'" + st.fontFamily.replace(/'/g, "") + "',sans-serif"); }
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
        if (ov.fontFamily) { fonts[ov.fontFamily] = true; d.push("font-family:'" + ov.fontFamily.replace(/'/g, "") + "',sans-serif"); }
        if (ov.fontWeight) { d.push("font-weight:" + ov.fontWeight); }
        if (ov.letterSpacing) { d.push("letter-spacing:" + (+ov.letterSpacing).toFixed(2) + "px"); }
        if (ov.lineHeightPx)  { d.push("line-height:" + Math.round(ov.lineHeightPx) + "px"); }
        if (ov.fills) { const c = backgroundFromFills(ov.fills, 1); if (c) { d.push("color:" + c); } }
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
            const style = id && table[id] ? runStyleCss(table[id], fonts).join(";") : "";
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

        // Assets: export as a flat image, never recurse.
        if (isAsset(n)) {
            const url = assetMap[n.id];
            const d = layoutDecls(n, parent).concat("object-fit:contain");
            if (url) { return '<img alt="' + esc(n.name) + '" src="' + esc(url) + '" style="' + d.join(";") + '" />'; }
            return '<div data-name="' + esc(n.name) + '" style="' + d.concat(visualDecls(n, imageFillMap)).join(";") + '"></div>';
        }

        // Text.
        if (n.type === "TEXT") {
            const ar = (n.style && n.style.textAutoResize) || "NONE";
            // Width auto only when Figma hugs both axes; height always auto so text can wrap freely.
            const hug = ar === "WIDTH_AND_HEIGHT";
            const d = layoutDecls(n, parent, { autoW: hug, autoH: true }).concat(textDecls(n, fonts));
            return '<div data-name="' + esc(n.name) + '" style="' + d.join(";") + '">' + textInner(n, fonts) + '</div>';
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
        return '<div data-name="' + esc(n.name) + '" style="' + d.join(";") + '">' + inner + '</div>';
    }

    function generateFromNode(root, assetMap, imageFillMap) {
        const rootBox = root.absoluteBoundingBox;
        if (!rootBox) { throw new Error("This node has no geometry to convert."); }
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
            "    * { margin: 0; padding: 0; box-sizing: border-box; }",
            "    body { display: flex; justify-content: center; background: #f4f4f5; padding: 24px; }",
            "    .figma-root img { display: block; max-width: 100%; }",
            "  </style>",
            "</head>",
            "<body>",
            '  <!-- Generated from Figma by FigmaToCode (free/REST path). Frame: ' + esc(root.name || "") + '.',
            "       Auto-layout frames become flexbox; icons/images are Figma export URLs that expire ~7 days. -->",
            '  <div class="figma-root" style="' + rootDecls.join(";") + '">',
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
        if (ui.loading) { return '<div class="f2c-status f2c-loading">' + esc(ui.info || "Working…") + '</div>'; }
        if (ui.error)   { return '<div class="f2c-status f2c-err">' + esc(ui.error) + '</div>'; }
        if (ui.info)    { return '<div class="f2c-status f2c-ok">' + esc(ui.info) + '</div>'; }
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

        const warn = !!ui.needTokenMsg;
        const urlVal = warn ? "" : esc(prefs.get("lastUrl") || "");
        const urlPh  = warn ? "please add a figma token" : "https://figma.com/design/…";
        html += '<div class="f2c-title" style="font-size:16px;">Paste a Figma frame link</div>';
        html += '<div class="f2c-sub">In Figma: right-click a frame, then <b>Copy link to selection</b>.</div>';
        html +=
            '<div class="f2c-composer">' +
                '<input type="text" class="f2c-url' + (warn ? " f2c-url-warn" : "") + '" placeholder="' + esc(urlPh) + '" value="' + urlVal + '" />' +
                '<div class="f2c-composer-bar">' +
                    '<div class="f2c-composer-spacer"></div>' +
                    '<button type="button" class="f2c-round-btn f2c-load-btn" title="Load" aria-label="Load">' + svg("arrowup") + '</button>' +
                '</div>' +
            '</div>';
        html += statusHtml();

        if (ui.frames.length) {
            html += '<div class="f2c-hint">' + esc(ui.fileName || "") + ' - click a frame, then ' + (paid ? "Send to Claude." : "Get code.") + '</div>';
            html += '<div class="f2c-grid">';
            ui.frames.forEach(function (f) {
                const sel = (f.id === ui.selectedId) ? " f2c-selected" : "";
                html += '<button type="button" class="f2c-frame' + sel + '" data-id="' + esc(f.id) + '">' +
                    (f.imgUrl ? '<img src="' + esc(f.imgUrl) + '" alt="' + esc(f.name) + '" loading="lazy" />'
                              : '<div class="f2c-frame-ph">…</div>') +
                    '<span class="f2c-frame-name">' + esc(f.name) + '</span>' +
                '</button>';
            });
            html += '</div>';
            const label = paid ? "Send to Claude" : "Get code";
            html += '<button type="button" class="f2c-btn-white f2c-btn-full f2c-getcode-btn" style="margin-top:14px;"' + (ui.selectedId ? "" : " disabled") + '>' + label + '</button>';
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
        if (getSeat() === "paid") {
            const ptk = getToken();
            return {
                paid: true,
                title: "Design to code, exactly",
                steps: [
                    { icon: "key",   text: "Create a Figma token in <b>Settings → Security</b>" },
                    { icon: "link",  text: "Paste a frame link into <b>Import</b>" },
                    { icon: "image", text: "Pick the frame you want" },
                    { icon: "send",  text: "Hit <b>Send to Claude</b> - it builds pixel-perfect code in the AI panel" }
                ],
                rowLabel: "Your Figma token:",
                row: '<div class="f2c-field">' + svg("key") +
                     '<input type="password" class="f2c-tut-token" placeholder="' + (ptk ? "figd_ saved, paste to replace" : "figd_") + '" />' +
                     '</div>' +
                     '<button type="button" class="f2c-btn-white f2c-tut-save-token">Save</button>'
            };
        }
        const tk = getToken();
        return {
            paid: false,
            title: "Design to code, fast",
            steps: [
                { icon: "key",   text: "Create a Figma token in <b>Settings → Security</b>" },
                { icon: "link",  text: "Paste a frame link into <b>Import</b>" },
                { icon: "image", text: "Pick the frame you want" },
                { icon: "code",  text: "Hit <b>Get code</b>, real icons exported and file opened" }
            ],
            rowLabel: "Your Figma token:",
            row: '<div class="f2c-field">' + svg("key") +
                 '<input type="password" class="f2c-tut-token" placeholder="' + (tk ? "figd_ saved, paste to replace" : "figd_") + '" />' +
                 '</div>' +
                 '<button type="button" class="f2c-btn-white f2c-tut-save-token">Save</button>'
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
        let html = heroHtml(d.paid) + '<div class="f2c-pad">' +
            '<div class="f2c-title">' + d.title + '</div>' +
            '<div class="f2c-sub">How it works:</div>' +
            listHtml(d.steps) +
            '<div class="f2c-label">' + d.rowLabel + '</div>' +
            '<div class="f2c-row">' + d.row + '</div>';
        if (ui.tokenCheck) {
            html += '<div style="margin-bottom:14px;">' + tokenStatusHtml() + '</div>';
        } else if (getToken()) {
            html += '<div class="f2c-status f2c-ok" style="margin-bottom:14px;">Token saved. You are ready to import.</div>';
        }
        html += '<button type="button" class="f2c-btn-white f2c-btn-full f2c-tut-next">Start importing</button>' +
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
            '<div class="f2c-title" style="font-size:18px;">Settings</div>' +
            '<div class="f2c-label">Your Figma plan</div>' +
            '<div class="f2c-row"><div class="f2c-field"><span class="f2c-field-text">' + seatLabel + '</span></div>' +
                '<button type="button" class="f2c-btn-ghost" data-reseat="1">Change</button></div>';

        // Both tiers use the personal token now (paid packs the design into the
        // Claude prompt via the token - no plugin/OAuth).
        html += '<div class="f2c-label">Figma personal access token</div>' +
            (!token ? '<div class="f2c-warn">⚠ No figma token yet.</div>' : '') +
            '<div class="f2c-row">' +
                '<div class="f2c-field">' + svg("key") + '<input type="password" class="f2c-token" placeholder="' + (token ? esc(masked) : "figd_") + '" /></div>' +
                '<button type="button" class="f2c-btn-white f2c-save-token">Save</button>' +
            '</div>' +
            '<div class="f2c-note">Stored only on this machine (Phoenix preferences). Never uploaded.</div>' +
            (token ? '<div class="f2c-status f2c-ok">Token saved. <button type="button" class="f2c-link" data-test="1">Test connection</button> · <button type="button" class="f2c-link" data-clear="1">Remove</button></div>' : "") +
            tokenStatusHtml() +
            '<div class="f2c-test-out"></div>' +
            '<div class="f2c-label" style="margin-top:16px;">Preview resolution</div>' +
            '<select class="f2c-scale">' + opts + '</select>' +
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
        // No token -> show "please add a figma token" right in the composer.
        if (!getToken()) {
            ui.needTokenMsg = true; ui.error = ""; ui.info = ""; ui.frames = []; ui.selectedId = null;
            prefs.set("lastUrl", ""); prefs.save();
            renderPanel();
            return;
        }
        ui.needTokenMsg = false;
        const parsed = parseFigmaUrl(url);
        if (!parsed.key) { flash("err", "That doesn't look like a Figma link."); renderPanel(); return; }

        prefs.set("lastUrl", url); prefs.save();
        ui.loading = true; ui.error = ""; ui.info = "Loading…"; ui.frames = []; ui.selectedId = null;
        ui.fileKey = parsed.key;
        renderPanel();
        try {
            if (parsed.nodeId) {
                const data = await figmaGet("/files/" + parsed.key + "/nodes?ids=" + encodeURIComponent(parsed.nodeId));
                const wrap = data.nodes && data.nodes[parsed.nodeId];
                const doc = wrap && wrap.document;
                if (!doc) { throw new Error("Couldn't find that frame in the file."); }
                ui.fileName = data.name || "";
                const box = doc.absoluteBoundingBox || {};
                ui.frames = [{ id: doc.id, name: doc.name || doc.type, w: box.width || 0, h: box.height || 0, imgUrl: null }];
                ui.selectedId = doc.id;
            } else {
                const data = await figmaGet("/files/" + parsed.key + "?depth=2");
                ui.fileName = data.name || "";
                ui.frames = collectFrames(data.document);
                if (!ui.frames.length) { throw new Error("No top-level frames found in this file."); }
            }
            ui.loading = false; ui.info = ""; renderPanel();
            const ids = ui.frames.map(function (f) { return f.id; });
            const images = await fetchImages(parsed.key, ids, getScale());
            ui.frames.forEach(function (f) { f.imgUrl = images[f.id] || null; });
            flash("ok", ui.frames.length === 1 ? "Frame loaded." : (ui.frames.length + " frames loaded."));
            renderPanel();
        } catch (e) {
            ui.loading = false; flash("err", e.message || String(e)); renderPanel();
        }
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
    function buildClaudePrompt(doc, previewUrl, assetMap, fillMap) {
        const url = frameUrl(ui.fileKey, ui.selectedId);
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
    async function sendToClaude() {
        if (!ui.selectedId || !ui.fileKey) { return; }
        // Both tiers need a token now. No token -> same inline nudge as the free path.
        if (!getToken()) {
            ui.needTokenMsg = true; ui.error = ""; ui.info = ""; ui.view = "import"; renderPanel();
            return;
        }
        ui.loading = true; ui.error = ""; ui.info = "Reading frame…"; renderPanel();
        try {
            const data = await figmaGet("/files/" + ui.fileKey + "/nodes?ids=" + encodeURIComponent(ui.selectedId) + "&geometry=paths");
            const doc = data.nodes && data.nodes[ui.selectedId] && data.nodes[ui.selectedId].document;
            if (!doc) { throw new Error("Couldn't fetch that frame's details."); }
            ui.info = "Rendering preview…"; renderPanel();
            let previewUrl = null;
            try { const pm = await fetchImages(ui.fileKey, [ui.selectedId], 2); previewUrl = pm[ui.selectedId] || null; } catch (e) { previewUrl = null; }
            ui.info = "Exporting assets…"; renderPanel();
            const assetIds = collectAssetIds(doc);
            let assetMap = {};
            if (assetIds.length) { try { assetMap = await fetchImages(ui.fileKey, assetIds, 2); } catch (e) { assetMap = {}; } }
            const imageRefs = collectImageRefs(doc);
            let fillMap = {};
            if (imageRefs.length) { try { fillMap = await fetchImageFills(ui.fileKey); } catch (e) { fillMap = {}; } }

            const prompt = buildClaudePrompt(doc, previewUrl, assetMap, fillMap);
            const filled = fillClaudeInput(prompt);
            const sendBtn = document.querySelector(".ai-send-btn");
            ui.loading = false;
            if (filled && sendBtn) {
                setTimeout(function () { try { sendBtn.click(); } catch (e) { /* ignore */ } }, 120);
                flash("ok", "Sent to Claude ✓ - building accurate code in the AI panel.");
                renderPanel();
                setTimeout(closePanel, 900);
            } else {
                // No AI panel -> copy the full prompt so the user can paste it.
                copyToClipboard(prompt).then(function () {
                    flash("ok", "AI panel not found - full prompt copied. Open the AI panel and paste it.");
                    renderPanel();
                });
            }
        } catch (e) {
            ui.loading = false; flash("err", e.message || String(e)); renderPanel();
        }
    }

    // Free path - export icons + generate + write.
    async function getCodeForSelected() {
        if (!ui.selectedId || !ui.fileKey) { return; }
        const frame = ui.frames.filter(function (f) { return f.id === ui.selectedId; })[0];
        ui.loading = true; ui.error = ""; ui.info = "Reading frame…"; renderPanel();
        try {
            const data = await figmaGet("/files/" + ui.fileKey + "/nodes?ids=" + encodeURIComponent(ui.selectedId) + "&geometry=paths");
            const wrap = data.nodes && data.nodes[ui.selectedId];
            const doc  = wrap && wrap.document;
            if (!doc) { throw new Error("Couldn't fetch that frame's details."); }

            const assetIds = collectAssetIds(doc);
            const imageRefs = collectImageRefs(doc);
            ui.info = "Exporting " + assetIds.length + " icons, " + imageRefs.length + " images…"; renderPanel();
            let assetMap = {};
            if (assetIds.length) {
                try { assetMap = await fetchImages(ui.fileKey, assetIds, 2); } catch (e) { assetMap = {}; }
            }
            let imageFillMap = {};
            if (imageRefs.length) {
                try { imageFillMap = await fetchImageFills(ui.fileKey); } catch (e) { imageFillMap = {}; }
            }
            ui.info = "Generating…"; renderPanel();
            const htmlDoc = generateFromNode(doc, assetMap, imageFillMap);
            const fileName = "figma-" + safeName(frame ? frame.name : doc.name) + ".html";
            await writeAndOpen(fileName, htmlDoc);
            ui.loading = false;
            const gotIcons = Object.keys(assetMap).length;
            const gotImages = imageRefs.filter(function (r) { return imageFillMap[r]; }).length;
            const capNote = assetIds.length >= MAX_ASSETS ? " (hit the " + MAX_ASSETS + "-icon cap, some may be missing)" : "";
            flash("ok", "Wrote " + fileName + " (" + gotIcons + " icons, " + gotImages + " images)" + capNote + " - turn on Live Preview.");
            renderPanel();
        } catch (e) {
            ui.loading = false; flash("err", e.message || String(e)); renderPanel();
        }
    }

    // ---- Event delegation ----
    $panel.on("click", ".f2c-nav-btn", function () {
        const v = $(this).attr("data-view");
        if (v === "tutorial") { ui.step = 0; }
        setView(v);
    });

    $body.on("click", function (e) {
        const $t = $(e.target);

        const go = $t.closest("[data-go]").attr("data-go");
        if (go) { if (go === "tutorial") { ui.step = 0; } setView(go); return; }

        // generic copy buttons (install cmd, etc.)
        const $copy = $t.closest("[data-copy]");
        if ($copy.length) {
            copyToClipboard($copy.attr("data-copy"));
            $copy.text("Copied ✓");
            return;
        }

        // seat toggle (Import view + inline suggestion link)
        const $ss = $t.closest("[data-setseat]");
        if ($ss.length) { setSeat($ss.attr("data-setseat")); ui.view = "import"; renderPanel(); return; }

        // seat choice (tutorial)
        const $seat = $t.closest("[data-seat]");
        if ($seat.length) { setSeat($seat.attr("data-seat")); ui.step = 0; renderPanel(); return; }
        if ($t.closest("[data-reseat], .f2c-tut-reseat").length) { setSeat(""); ui.view = "tutorial"; ui.step = 0; renderPanel(); return; }

        // import: URL chip focuses the input
        if ($t.closest(".f2c-focus-url").length) { $body.find(".f2c-url").trigger("focus"); return; }
        // import: Quick = paste from clipboard and load in one go
        if ($t.closest(".f2c-quick-btn").length) {
            if (navigator.clipboard && navigator.clipboard.readText) {
                navigator.clipboard.readText().then(function (txt) {
                    txt = (txt || "").trim();
                    if (txt) { $body.find(".f2c-url").val(txt); loadUrl(txt); }
                }).catch(function () {});
            }
            return;
        }
        // import: send (arrow) loads the current input
        if ($t.closest(".f2c-load-btn").length) { loadUrl($body.find(".f2c-url").val()); return; }
        const $frame = $t.closest(".f2c-frame");
        if ($frame.length) { ui.selectedId = $frame.attr("data-id"); renderPanel(); return; }
        if ($t.closest(".f2c-getcode-btn").length) {
            if (getSeat() === "paid") { sendToClaude(); } else { getCodeForSelected(); }
            return;
        }

        // tutorial: inline token save
        if ($t.closest(".f2c-tut-save-token").length) {
            saveTokenAndValidate($body.find(".f2c-tut-token").val());
            return;
        }

        // tutorial: finish -> go to Import
        if ($t.closest(".f2c-tut-next").length) {
            setOnboarded(true); setView("import"); return;
        }

        // settings
        if ($t.closest(".f2c-save-token").length) {
            saveTokenAndValidate($body.find(".f2c-token").val());
            return;
        }
        if ($t.closest("[data-clear]").length) { setToken(""); ui.tokenCheck = null; renderPanel(); return; }
        if ($t.closest("[data-test]").length) {
            const $out = $body.find(".f2c-test-out");
            $out.html('<div class="f2c-status f2c-loading">Testing…</div>');
            figmaGet("/me").then(function (me) {
                $out.html('<div class="f2c-status f2c-ok">Connected as ' + esc(me.handle || me.email || "you") + '.</div>');
            }).catch(function (err) { $out.html('<div class="f2c-status f2c-err">' + esc(err.message) + '</div>'); });
            return;
        }
    });

    $body.on("keydown", ".f2c-url", function (e) { if (e.key === "Enter") { e.preventDefault(); loadUrl($(this).val()); } });
    $body.on("input", ".f2c-url", function () {
        if (ui.needTokenMsg) {
            ui.needTokenMsg = false;
            $(this).removeClass("f2c-url-warn").attr("placeholder", "https://figma.com/design/…");
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
