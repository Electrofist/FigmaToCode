/* Golden-snapshot regression for the generator.
 * Generates HTML for a FIXED, representative reference frame (flex, sizing, text,
 * image fill, constraints, gradient, border/shadow, and color-style tokens) and
 * compares it byte-for-byte against a committed golden file. Any silent change to
 * the generator output fails CI so it gets reviewed on purpose.
 *   Update the golden intentionally with:  UPDATE_SNAPSHOT=1 node test/snapshot.test.js
 * Run: `node test/snapshot.test.js` */
"use strict";
const fs = require("fs");
const path = require("path");
const { genApi: G } = require("./harness.js");

const box = (x, y, w, h) => ({ x, y, width: w, height: h });
const solid = (r, g, b, a) => ({ type: "SOLID", color: { r, g, b, a: a == null ? 1 : a } });

// A deterministic frame that exercises the main generator paths.
const REF = {
    id: "0:1", name: "Reference Frame", type: "FRAME", layoutMode: "VERTICAL",
    itemSpacing: 16, paddingTop: 24, paddingLeft: 24, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER",
    absoluteBoundingBox: box(0, 0, 600, 800), clipsContent: true,
    fills: [solid(1, 1, 1)],
    styles: { fill: "S_BG" },
    children: [
        { id: "1:1", name: "Title", type: "TEXT", characters: "Hello World",
          layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG",
          absoluteBoundingBox: box(24, 24, 200, 40),
          style: { fontSize: 32, fontFamily: "Inter", fontWeight: 700, textAlignHorizontal: "CENTER", textAutoResize: "WIDTH_AND_HEIGHT" },
          fills: [solid(0.1, 0.1, 0.1)], styles: { fill: "S_TEXT" } },
        { id: "1:2", name: "Primary Button", type: "FRAME", layoutMode: "HORIZONTAL",
          itemSpacing: 8, paddingTop: 10, paddingLeft: 16, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
          layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG",
          absoluteBoundingBox: box(24, 80, 160, 44), cornerRadius: 8,
          fills: [solid(0.1, 0.45, 1)], styles: { fill: "S_PRIMARY" },
          strokes: [solid(0, 0.2, 0.6)], strokeWeight: 1,
          effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 6, color: { r: 0, g: 0, b: 0, a: 0.2 }, visible: true }],
          children: [
              { id: "1:3", name: "Label", type: "TEXT", characters: "Click me",
                absoluteBoundingBox: box(40, 90, 80, 24), style: { fontSize: 16, fontFamily: "Inter", fontWeight: 600 },
                fills: [solid(1, 1, 1)], styles: { fill: "S_ONPRIMARY" } }
          ] },
        { id: "1:4", name: "Hero Photo", type: "RECTANGLE",
          absoluteBoundingBox: box(24, 140, 552, 300),
          fills: [solid(0.9, 0.9, 0.9), { type: "IMAGE", scaleMode: "FILL", imageRef: "IMG1" }] },
        { id: "1:5", name: "Gradient Bar", type: "RECTANGLE",
          absoluteBoundingBox: box(24, 460, 552, 12),
          fills: [{ type: "GRADIENT_LINEAR", gradientStops: [{ color: solid(1, 0, 0).color, position: 0 }, { color: solid(0, 0, 1).color, position: 1 }], gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }], visible: true }] },
        { id: "1:6", name: "Badge", type: "FRAME", layoutPositioning: "ABSOLUTE",
          absoluteBoundingBox: box(520, 20, 60, 24), constraints: { horizontal: "RIGHT", vertical: "TOP" },
          fills: [solid(1, 0.6, 0.2)], styles: { fill: "S_PRIMARY" }, cornerRadius: 12, children: [] }
    ]
};
const STYLES = {
    S_BG: { name: "Surface/White", styleType: "FILL" },
    S_TEXT: { name: "Text/Primary", styleType: "FILL" },
    S_PRIMARY: { name: "Brand/Primary", styleType: "FILL" },
    S_ONPRIMARY: { name: "Text/On Primary", styleType: "FILL" }
};

const tokens = G.collectTokens(REF, STYLES);
const html = G.generateFromNode(REF, { "IMG1": "" }, { "IMG1": "https://s3.example/img1.png" }, tokens);

const dir = path.join(__dirname, "__snapshots__");
const goldenPath = path.join(dir, "reference.html");

let passed = 0, failed = 0;
console.log("snapshot.test.js");

if (process.env.UPDATE_SNAPSHOT || !fs.existsSync(goldenPath)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(goldenPath, html);
    console.log("  WROTE golden snapshot: test/__snapshots__/reference.html (" + html.length + " bytes)");
    passed++;
} else {
    const golden = fs.readFileSync(goldenPath, "utf8");
    if (golden === html) { console.log("  PASS  generator output matches golden snapshot"); passed++; }
    else {
        failed++;
        // find first differing line for a helpful message
        const a = golden.split("\n"), b = html.split("\n");
        let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) { i++; }
        console.log("  FAIL  generator output changed vs golden snapshot");
        console.log("    first diff at line " + (i + 1) + ":");
        console.log("      golden: " + JSON.stringify((a[i] || "").slice(0, 120)));
        console.log("      now:    " + JSON.stringify((b[i] || "").slice(0, 120)));
        console.log("    If intentional, run:  UPDATE_SNAPSHOT=1 node test/snapshot.test.js  and review the diff.");
    }
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
