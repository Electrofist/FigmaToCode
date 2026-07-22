/* Generator snapshot/behaviour tests for FigmaToCode (free/REST path).
 *
 * Runs against the REAL generator in ../main.js by extracting its pure region
 * (no editor, no network) and exercising it on synthetic Figma nodes. Keeps the
 * generator honest as it grows. Run: `node test/generator.test.js`
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

// Extract the pure generator region: from `function chan(` to `function writeAndOpen(`.
const START = "    function chan(";
const END = "\n    function writeAndOpen(";
const i = SRC.indexOf(START), j = SRC.indexOf(END);
if (i < 0 || j < 0) {
    console.error("FATAL: could not locate generator region markers in main.js");
    process.exit(2);
}
const REGION = SRC.slice(i, j);

function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const api = new Function(
    "esc", "MAX_ELEMENTS", "MAX_ASSETS",
    REGION + "\nreturn { generateFromNode, collectAssetIds, collectImageRefs, isAsset };"
)(esc, 6000, 120);

// ---- tiny assert harness ----
let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log("  PASS  " + name); }
    else { failed++; console.log("  FAIL  " + name); }
}
const box = (x, y, w, h) => ({ x, y, width: w, height: h });

// ---- fixtures ----
const leafShot = {
    id: "1:1", name: "Product Screenshot", type: "RECTANGLE",
    absoluteBoundingBox: box(100, 100, 600, 400),
    constraints: { horizontal: "LEFT", vertical: "TOP" },
    fills: [{ type: "IMAGE", scaleMode: "FILL", imageRef: "REF_SHOT" }]
};
const hero = {
    id: "2:1", name: "Hero", type: "FRAME",
    absoluteBoundingBox: box(0, 520, 1200, 380), clipsContent: true,
    constraints: { horizontal: "LEFT_RIGHT", vertical: "TOP" },
    // base SOLID under an IMAGE on top (the layered case that used to render blank)
    fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
            { type: "IMAGE", scaleMode: "FILL", imageRef: "REF_HERO" }],
    children: [
        { id: "3:1", name: "Headline", type: "TEXT", characters: "Build faster",
          absoluteBoundingBox: box(40, 560, 300, 60),
          constraints: { horizontal: "LEFT", vertical: "TOP" },
          style: { fontSize: 48, textAutoResize: "WIDTH_AND_HEIGHT" },
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] }
    ]
};
const logoFit = {
    id: "4:1", name: "Tile FIT", type: "RECTANGLE",
    absoluteBoundingBox: box(760, 100, 200, 200),
    constraints: { horizontal: "LEFT", vertical: "TOP" },
    fills: [{ type: "IMAGE", scaleMode: "FIT", imageRef: "REF_LOGO" }]
};
// Auto-layout row with a HUG child and a FILL child.
const navRow = {
    id: "5:1", name: "Nav", type: "FRAME", layoutMode: "HORIZONTAL",
    itemSpacing: 12, primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "CENTER",
    absoluteBoundingBox: box(0, 0, 1200, 64),
    constraints: { horizontal: "LEFT_RIGHT", vertical: "TOP" },
    children: [
        { id: "5:2", name: "Brand", type: "TEXT", characters: "Phoenix Code",
          layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG",
          absoluteBoundingBox: box(0, 20, 140, 24), style: { fontSize: 18 },
          fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] },
        { id: "5:3", name: "Spacer", type: "FRAME",
          layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED",
          absoluteBoundingBox: box(150, 0, 900, 64) }
    ]
};

const root = {
    id: "0:1", name: "Landing", type: "FRAME",
    absoluteBoundingBox: box(0, 0, 1200, 900), clipsContent: true,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [leafShot, hero, logoFit, navRow]
};
const imageFillMap = { REF_SHOT: "https://s3.example/shot.png?a=1&b=2", REF_HERO: "https://s3.example/hero.png", REF_LOGO: "https://s3.example/logo.png" };

const html = api.generateFromNode(root, {}, imageFillMap);

console.log("generator.test.js");
// image fills
check("collectImageRefs finds all 3 refs", api.collectImageRefs(root).length === 3);
check("image-fill leaf is NOT flattened to a flat asset", api.isAsset(leafShot) === false);
check("leaf screenshot -> background-image + cover", /background-image:url\('https:\/\/s3\.example\/shot\.png\?a=1&amp;b=2'\)[^"]*background-size:cover/.test(html));
check("layered [SOLID,IMAGE] keeps base color", html.includes("background-color:rgba(26,26,26,1)"));
check("layered [SOLID,IMAGE] puts image on top", html.includes("background-image:url('https://s3.example/hero.png');background-size:cover"));
check("image-fill container's child survives (not baked into a flat img)", html.includes("Build faster"));
check("FIT scaleMode -> contain", html.includes("background-image:url('https://s3.example/logo.png');background-size:contain"));
// auto-layout -> flexbox
check("auto-layout row -> display:flex row", /display:flex[^"]*flex-direction:row/.test(html));
check("SPACE_BETWEEN -> justify-content:space-between", html.includes("justify-content:space-between"));
check("HUG main-axis child -> flex-shrink:0", html.includes("flex-shrink:0"));
check("FILL main-axis child -> flex:1 1 0", html.includes("flex:1 1 0"));
// text
check("text node renders characters", html.includes(">Build faster<") || html.includes("Build faster"));
// root
check("root renders at native width", html.includes("width:1200px"));
check("no raw unresolved url(\"logo.png\") leaked", !/url\("logo\.png"\)/.test(html));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
