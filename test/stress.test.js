/* Blind stress + fuzz suite for the MAJOR code paths (generator, image fills,
 * paid-path prompt builder, token/error handling, URL parsing).
 *
 * Exercises the REAL functions (via harness.js) on many generated Figma-like
 * trees across multiple seeds, asserting invariants that should hold for ANY
 * input. Test-only; nothing here ships. Run: `node test/stress.test.js [runLabel]`
 */
"use strict";
const { genApi, parseFigmaUrl, makeFigmaGet } = require("./harness.js");
const G = genApi;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { passed++; }
    else { failed++; failures.push(name + (detail ? "  -- " + detail : "")); }
}
function section(t) { /* grouping only */ }

/* ---------- deterministic PRNG (mulberry32) ---------- */
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const chance = (r, p) => r() < p;
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/* Poison strings to prove escaping (must survive as escaped text, never break out). */
const ZS = "ZQSTART", ZE = "ZQEND";
const POISON = ZS + "<>\"'&</div><script>x" + ZE;
const NAMES = ["Frame", "icon/home", "Logo mark", "Button", "Card", "avatar 3", "Product Image",
    "www.site.com", "Header", "Nav", "  ", "", POISON, "emoji 😀 name", "a".repeat(120)];
const SCALE_MODES = ["FILL", "FIT", "TILE", "STRETCH", "CROP", undefined, "WEIRD_MODE"];
const NODE_TYPES = ["FRAME", "GROUP", "RECTANGLE", "TEXT", "VECTOR", "INSTANCE", "COMPONENT",
    "ELLIPSE", "LINE", "STAR", "BOOLEAN_OPERATION", "REGULAR_POLYGON"];
const CONSTR = ["LEFT", "RIGHT", "CENTER", "LEFT_RIGHT", "SCALE", "TOP", "BOTTOM", "TOP_BOTTOM", undefined];

function randBox(r, w, h) { return { x: int(r, -50, 1500), y: int(r, -50, 3000), width: w, height: h }; }
function solid(r) { return { type: "SOLID", color: { r: r(), g: r(), b: r(), a: r() }, opacity: chance(r, 0.5) ? r() : undefined, visible: chance(r, 0.85) }; }
function gradient(r) {
    return { type: pick(r, ["GRADIENT_LINEAR", "GRADIENT_RADIAL"]),
        gradientStops: [{ color: { r: r(), g: r(), b: r(), a: 1 }, position: 0 }, { color: { r: r(), g: r(), b: r(), a: 1 }, position: 1 }],
        gradientHandlePositions: chance(r, 0.7) ? [{ x: 0, y: 0 }, { x: 1, y: 1 }] : undefined, visible: true };
}
function imageFill(r, refs) {
    const ref = "REF" + int(r, 0, 6);
    if (chance(r, 0.7)) { refs[ref] = "https://s3.example/" + ref + ".png?a=1&b=2"; } // some refs resolvable, some not
    return { type: "IMAGE", scaleMode: pick(r, SCALE_MODES), imageRef: chance(r, 0.9) ? ref : undefined, visible: chance(r, 0.9) };
}
function randFills(r, refs) {
    if (chance(r, 0.15)) { return chance(r, 0.5) ? [] : undefined; }
    const out = [];
    const n = int(r, 1, 3);
    for (let i = 0; i < n; i++) {
        const k = r();
        if (k < 0.5) { out.push(solid(r)); }
        else if (k < 0.7) { out.push(gradient(r)); }
        else { out.push(imageFill(r, refs)); }
    }
    return out;
}
function randStyle(r) {
    return { fontSize: pick(r, [10, 12, 13, 16, 18, 24, 48, undefined]),
        fontFamily: pick(r, ["Inter", "Roboto", "SF Pro", "O'Neil \"Bold\"", POISON, "x\"><script>", undefined]),
        fontWeight: pick(r, [400, 500, 600, 700, POISON, "700\"><b", undefined]),
        lineHeightPx: pick(r, [16, 20, 24, undefined]),
        letterSpacing: pick(r, [0, 0.5, -0.2, undefined]),
        textAlignHorizontal: pick(r, ["LEFT", "CENTER", "RIGHT", POISON, "left\"><script>", undefined]),
        textAutoResize: pick(r, ["NONE", "HEIGHT", "WIDTH_AND_HEIGHT", undefined]) };
}
function textOverrides(r, chars) {
    if (!chance(r, 0.4) || !chars.length) { return {}; }
    const ov = [], table = {};
    const id = 1; table[id] = { fontSize: pick(r, [12, 24]), fontWeight: pick(r, [400, 700]),
        fills: [solid(r)], textCase: pick(r, ["UPPER", "LOWER", undefined]), textDecoration: pick(r, ["UNDERLINE", "STRIKETHROUGH", undefined]) };
    for (let i = 0; i < chars.length; i++) { ov.push(chance(r, 0.5) ? id : 0); }
    return { characterStyleOverrides: ov, styleOverrideTable: table };
}
function randEffects(r) {
    if (!chance(r, 0.3)) { return undefined; }
    return [{ type: pick(r, ["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR"]),
        offset: { x: int(r, -5, 5), y: int(r, -5, 5) }, radius: int(r, 0, 20),
        color: { r: 0, g: 0, b: 0, a: r() }, visible: chance(r, 0.9) }];
}

let nodeBudget;
function makeNode(r, refs, depth) {
    if (nodeBudget-- <= 0) { return null; }
    const type = pick(r, NODE_TYPES);
    const hasBox = chance(r, 0.9); // vectors sometimes lack geometry
    const w = int(r, 0, 1200), h = int(r, 0, 800);
    const n = {
        id: int(r, 1, 9999) + ":" + int(r, 1, 9999),
        name: pick(r, NAMES),
        type: type,
        visible: chance(r, 0.92)
    };
    if (hasBox) { n.absoluteBoundingBox = randBox(r, w, h); }
    n.fills = randFills(r, refs);
    if (chance(r, 0.5)) { n.strokes = [solid(r)]; n.strokeWeight = chance(r, 0.1) ? POISON : int(r, 1, 4); }
    if (chance(r, 0.3)) { n.cornerRadius = int(r, 0, 24); }
    if (chance(r, 0.1)) { n.rectangleCornerRadii = chance(r, 0.3) ? [POISON, 4, 4, 4] : [int(r, 0, 20), int(r, 0, 20), int(r, 0, 20), int(r, 0, 20)]; }
    // poison numeric layout fields too (crafted-file defense-in-depth)
    if (chance(r, 0.06)) { n.paddingTop = POISON; }
    if (chance(r, 0.06)) { n.itemSpacing = POISON; }
    if (chance(r, 0.4)) { n.opacity = r(); }
    n.effects = randEffects(r);
    n.constraints = { horizontal: pick(r, CONSTR), vertical: pick(r, CONSTR) };
    n.layoutSizingHorizontal = pick(r, ["HUG", "FILL", "FIXED", undefined]);
    n.layoutSizingVertical = pick(r, ["HUG", "FILL", "FIXED", undefined]);
    if (chance(r, 0.2)) { n.layoutPositioning = "ABSOLUTE"; }
    if (type === "TEXT") {
        n.characters = pick(r, ["Hello", "Build faster", POISON, "Multi\nline\ntext", "", "12", "😀", "a".repeat(200)]);
        n.style = randStyle(r);
        Object.assign(n, textOverrides(r, n.characters));
    } else if (depth < 5 && chance(r, 0.6)) {
        n.layoutMode = pick(r, ["NONE", "HORIZONTAL", "VERTICAL"]);
        if (n.layoutMode !== "NONE") {
            n.itemSpacing = int(r, 0, 24);
            n.primaryAxisAlignItems = pick(r, ["MIN", "CENTER", "MAX", "SPACE_BETWEEN", undefined]);
            n.counterAxisAlignItems = pick(r, ["MIN", "CENTER", "MAX", "BASELINE", undefined]);
            n.paddingTop = int(r, 0, 20); n.paddingLeft = int(r, 0, 20);
        }
        n.clipsContent = chance(r, 0.5);
        const kids = int(r, 0, 4);
        n.children = [];
        for (let i = 0; i < kids; i++) { const c = makeNode(r, refs, depth + 1); if (c) { n.children.push(c); } }
    }
    return n;
}
function makeTree(seed, budget) {
    const r = rng(seed);
    nodeBudget = budget;
    const refs = {};
    const root = {
        id: "0:1", name: pick(r, NAMES), type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: int(r, 200, 1512), height: int(r, 200, 3000) },
        clipsContent: chance(r, 0.5),
        fills: randFills(r, refs),
        layoutMode: pick(r, ["NONE", "HORIZONTAL", "VERTICAL"]),
        itemSpacing: int(r, 0, 20), paddingTop: int(r, 0, 20),
        children: []
    };
    const kids = int(r, 1, 6);
    for (let i = 0; i < kids; i++) { const c = makeNode(r, refs, 1); if (c) { root.children.push(c); } }
    return { root, refs };
}

/* ---------- invariants that must hold for ANY tree ---------- */
function checkInvariants(label, root, refs) {
    let html;
    try { html = G.generateFromNode(root, {}, refs); }
    catch (e) { ok(label + " generate no-throw", false, e.message); return; }
    ok(label + " generate no-throw", true);
    ok(label + " no 'undefined' in output", html.indexOf("undefined") === -1);
    ok(label + " no 'NaN' in output", html.indexOf("NaN") === -1);
    ok(label + " no ':null' css value", html.indexOf(":null") === -1 && html.indexOf("(null") === -1);
    ok(label + " no unescaped <script", html.indexOf("<script") === -1);
    ok(label + " no relative raster url()", !/url\((['"]?)(?!data:|https?:)[^)]*\.(?:png|jpe?g|gif|webp)\1\)/.test(html));
    // style-attribute injection backstop: no < or > may appear inside any style="" value
    var sm, sreg = / style="([^"]*)"/g, styleClean = true;
    while ((sm = sreg.exec(html))) { if (/[<>]/.test(sm[1])) { styleClean = false; break; } }
    ok(label + " no < or > inside any style attr (no CSS-injection breakout)", styleClean);
    // Escaping/injection: after removing every legitimate tag the generator can
    // emit, NO stray "<" may remain. Any injected markup (e.g. <script>, <img
    // onerror>) leaves a raw "<"; escaped content only has "&lt;". This is robust
    // to multi-style text runs (which legitimately insert <span> wrappers).
    const stripped = html
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<!doctype[^>]*>/gi, "")
        .replace(/<\/?(?:div|img|span|link|meta|title|style|body|html|head)\b[^>]*>/gi, "");
    ok(label + " no stray '<' after removing known tags (no HTML injection)", stripped.indexOf("<") === -1,
        process.env.DEBUG_LEAK ? JSON.stringify(stripped.slice(stripped.indexOf("<") - 40, stripped.indexOf("<") + 40)) : undefined);
    ok(label + " no javascript: URI", !/javascript:/i.test(html));

    // paid-path prompt on the same tree
    let prompt;
    try { prompt = G.buildClaudePrompt(root, "https://s3.example/preview.png", {}, refs); }
    catch (e) { ok(label + " buildClaudePrompt no-throw", false, e.message); return; }
    ok(label + " buildClaudePrompt no-throw", true);
    ok(label + " prompt no 'undefined'", prompt.indexOf("undefined") === -1);
    ok(label + " prompt no 'NaN'", prompt.indexOf("NaN") === -1);
    ok(label + " prompt bounded (<400KB)", prompt.length < 400000, prompt.length + " chars");
}

/* ================= structured edge cases ================= */
section("edge cases");
// empty / minimal
checkInvariants("empty-root", { id: "0:1", name: "E", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, children: [] }, {});
// root missing box -> should throw a clear error (expected), not a weird crash
(function () {
    try { G.generateFromNode({ id: "0:1", type: "FRAME", children: [] }, {}, {}); ok("root-without-box throws clear error", false, "did not throw"); }
    catch (e) { ok("root-without-box throws clear error", /geometry/i.test(e.message), e.message); }
})();
// null children / undefined fields
checkInvariants("null-children", { id: "0:1", name: "N", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: null }, {});
// deeply layered fills incl invisible + image without resolvable url
checkInvariants("layered-fills", {
    id: "0:1", name: "L", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: false }, { type: "IMAGE", scaleMode: "FILL", imageRef: "MISSING" }],
    children: [{ id: "1:1", name: "t", type: "TEXT", characters: POISON, absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 20 }, style: {} }]
}, {});
// name/text XSS
checkInvariants("xss-name-text", {
    id: "0:1", name: POISON, type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [{ id: "1:1", name: POISON, type: "TEXT", characters: POISON, absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 20 }, style: { fontFamily: "x\"><script>" } }]
}, {});
// MAX_ELEMENTS: 7000-node flat tree must not crash and must cap
(function () {
    const kids = [];
    for (let i = 0; i < 7000; i++) { kids.push({ id: "k:" + i, name: "n" + i, type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 5, height: 5 } }); }
    const root = { id: "0:1", name: "big", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, children: kids };
    let html; try { html = G.generateFromNode(root, {}, {}); ok("7000-node no-throw", true); }
    catch (e) { ok("7000-node no-throw", false, e.message); return; }
    const count = (html.match(/data-name=/g) || []).length;
    ok("MAX_ELEMENTS cap respected (<=6100)", count <= 6100, count + " elements");
})();

/* ================= fuzz: many seeds x trees ================= */
section("fuzz");
const SEEDS = [1, 2, 3, 7, 11, 42, 99, 123, 777, 2024, 31337, 65535];
let fuzzTrees = 0;
SEEDS.forEach(function (seed) {
    for (let t = 0; t < 60; t++) {
        const { root, refs } = makeTree(seed * 1000 + t, 400);
        checkInvariants("fuzz s" + seed + "#" + t, root, refs);
        fuzzTrees++;
    }
});

/* ================= figmaGet error mapping ================= */
section("figmaGet");
function stubRes(status, ok_, body) { return Promise.resolve({ status: status, ok: ok_, json: function () { return Promise.resolve(body || {}); } }); }
async function expectErr(label, fetchStub, token, re) {
    const fget = makeFigmaGet(fetchStub, token);
    try { await fget("/x"); ok(label, false, "did not reject"); }
    catch (e) { ok(label, re.test(e.message), e.message); }
}
async function runFigmaGet() {
    await expectErr("no token -> clear msg", function () { return stubRes(200, true, {}); }, "", /No Figma token/i);
    await expectErr("401 -> re-add token", function () { return stubRes(401, false); }, "figd_x", /rejected your token \(401\)/i);
    await expectErr("403 -> re-add token", function () { return stubRes(403, false); }, "figd_x", /rejected your token \(403\)/i);
    await expectErr("404 -> not found", function () { return stubRes(404, false); }, "figd_x", /not found \(404\)/i);
    await expectErr("429 -> rate limit", function () { return stubRes(429, false); }, "figd_x", /rate-limit/i);
    await expectErr("500 -> server error", function () { return stubRes(500, false); }, "figd_x", /server error \(500\)/i);
    await expectErr("network reject -> connection msg", function () { return Promise.reject(new TypeError("Failed to fetch")); }, "figd_x", /Couldn't reach Figma/i);
    // happy path
    const fget = makeFigmaGet(function () { return stubRes(200, true, { email: "me@x.com" }); }, "figd_x");
    try { const j = await fget("/me"); ok("200 -> returns json", j && j.email === "me@x.com"); }
    catch (e) { ok("200 -> returns json", false, e.message); }
}

/* ================= parseFigmaUrl ================= */
section("parseFigmaUrl");
function pf(label, url, key, node) {
    const p = parseFigmaUrl(url);
    ok(label, p.key === key && p.nodeId === node, JSON.stringify(p));
}
pf("design + node-id dash", "https://www.figma.com/design/ABC123def/Name?node-id=15-455", "ABC123def", "15:455");
pf("file url", "https://www.figma.com/file/XYZ789/Proj", "XYZ789", null);
pf("proto url + node", "https://www.figma.com/proto/KKK/App?node-id=1-2&scaling=x", "KKK", "1:2");
pf("board url", "https://www.figma.com/board/BBB/Jam", "BBB", null);
pf("node-id already colon encoded", "https://www.figma.com/design/AAA/x?node-id=3%3A4", "AAA", "3:4");
pf("node-id with extra params", "https://www.figma.com/design/AAA/x?t=1&node-id=9-9&mode=dev", "AAA", "9:9");
pf("whitespace + trailing", "   https://www.figma.com/design/AAA/x?node-id=5-6   ", "AAA", "5:6");
pf("non-figma url", "https://example.com/design/NOPE", null, null);
pf("empty", "", null, null);
pf("garbage", "not a url at all", null, null);

/* ================= run + summary ================= */
(async function () {
    await runFigmaGet();
    console.log("stress.test.js" + (process.argv[2] ? " [" + process.argv[2] + "]" : ""));
    console.log("  fuzz trees exercised: " + fuzzTrees + " (+ edge cases + figmaGet + parseFigmaUrl)");
    if (failures.length) {
        console.log("\n  FAILURES (" + failures.length + "):");
        // de-dupe similar fuzz failures for readability, keep first 40
        const seen = {}, shown = [];
        failures.forEach(function (f) { const key = f.replace(/s\d+#\d+/, "s*#*"); if (!seen[key]) { seen[key] = 1; shown.push(f); } });
        shown.slice(0, 40).forEach(function (f) { console.log("    FAIL  " + f); });
        if (shown.length > 40) { console.log("    ...(" + (shown.length - 40) + " more unique)"); }
    }
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
})();
