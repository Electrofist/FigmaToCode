/* Design-token tests: Figma color styles -> CSS custom properties.
 * Exercises the real collectTokens + generateFromNode via harness.js.
 * Run: `node test/tokens.test.js` */
"use strict";
const { genApi: G } = require("./harness.js");

let passed = 0, failed = 0;
function ok(name, cond, detail) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name + (detail ? "  -- " + detail : "")); } }
const box = (x, y, w, h) => ({ x, y, width: w, height: h });
const solid = (r, g, b, a) => ({ type: "SOLID", color: { r, g, b, a: a == null ? 1 : a } });
const rectStyled = (id, styleId, w) => ({ id, name: "n" + id, type: "RECTANGLE", absoluteBoundingBox: box(0, 0, w || 10, 10), styles: { fill: styleId }, fills: [solid(0.1, 0.45, 1)] });

console.log("tokens.test.js");

// ---- cssVarName sanitization ----
ok("Orange/1 -> --orange-1", G.cssVarName("Orange/1") === "--orange-1", G.cssVarName("Orange/1"));
ok("Secondary/500 -> --secondary-500", G.cssVarName("Secondary/500") === "--secondary-500");
ok("Grey/01 -> --grey-01", G.cssVarName("Grey/01") === "--grey-01");
ok("empty -> --token", G.cssVarName("   ") === "--token");
ok("A B C -> --a-b-c", G.cssVarName("A B C") === "--a-b-c");

// ---- reuse: one style across 3 nodes -> 1 token, 3 var() usages ----
const stylesMap = { S1: { name: "Primary/Blue", styleType: "FILL" } };
const root = {
    id: "0:1", name: "R", type: "FRAME", absoluteBoundingBox: box(0, 0, 200, 200),
    children: [rectStyled("1:1", "S1"), rectStyled("1:2", "S1"), rectStyled("1:3", "S1")]
};
const tokens = G.collectTokens(root, stylesMap);
ok("1 token collected for the reused style", tokens.defs.length === 1, JSON.stringify(tokens.defs));
ok("token named from style (--primary-blue)", tokens.defs[0] && tokens.defs[0].name === "--primary-blue");
const html = G.generateFromNode(root, {}, {}, tokens);
ok(":root block emitted", html.indexOf(":root {") !== -1);
ok(":root defines --primary-blue", /:root \{[\s\S]*--primary-blue:/.test(html));
ok("var(--primary-blue) used at all 3 usage sites", (html.match(/var\(--primary-blue\)/g) || []).length === 3, "count=" + (html.match(/var\(--primary-blue\)/g) || []).length);
const rawVal = tokens.defs[0].value;
ok("raw color value appears once (only in :root, not inlined)", html.split(rawVal).length - 1 === 1, "count=" + (html.split(rawVal).length - 1));
// invariant: every var(--x) used must be defined in :root (no dangling references)
(function () {
    const used = Array.from(new Set((html.match(/var\((--[a-z0-9-]+)\)/g) || []).map(s => s.replace(/^var\(|\)$/g, ""))));
    const rootBlock = (html.match(/:root \{[\s\S]*?\}/) || [""])[0];
    const undefinedVars = used.filter(n => rootBlock.indexOf(n + ":") === -1);
    ok("every var(--x) used is defined in :root", undefinedVars.length === 0, "dangling=" + undefinedVars.join(","));
})();

// ---- stroke style ----
const strokeRoot = {
    id: "0:2", name: "R2", type: "FRAME", absoluteBoundingBox: box(0, 0, 100, 100),
    children: [{ id: "2:1", name: "s", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 50, 50),
        styles: { stroke: "S2" }, strokes: [solid(1, 0, 0)], strokeWeight: 2 }]
};
const strokeTokens = G.collectTokens(strokeRoot, { S2: { name: "Border/Red", styleType: "FILL" } });
ok("stroke style -> token", strokeTokens.defs.length === 1 && strokeTokens.defs[0].name === "--border-red");
ok("stroke usage references var()", G.generateFromNode(strokeRoot, {}, {}, strokeTokens).indexOf("var(--border-red)") !== -1);

// ---- name collision (same sanitized name, different values) -> -2 suffix ----
const cRoot = {
    id: "0:3", name: "R3", type: "FRAME", absoluteBoundingBox: box(0, 0, 100, 100),
    children: [
        { id: "3:1", name: "a", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 10, 10), styles: { fill: "A" }, fills: [solid(0, 0, 0)] },
        { id: "3:2", name: "b", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 10, 10), styles: { fill: "B" }, fills: [solid(1, 1, 1)] }
    ]
};
const cTokens = G.collectTokens(cRoot, { A: { name: "Blue", styleType: "FILL" }, B: { name: "blue", styleType: "FILL" } });
ok("collision produces --blue and --blue-2", cTokens.defs.map(d => d.name).join(",") === "--blue,--blue-2", cTokens.defs.map(d => d.name).join(","));

// ---- no styles -> no tokens, output unchanged (no :root, value inlined) ----
const plain = {
    id: "0:4", name: "R4", type: "FRAME", absoluteBoundingBox: box(0, 0, 100, 100),
    children: [{ id: "4:1", name: "p", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 50, 50), fills: [solid(0.2, 0.2, 0.2)] }]
};
const plainTokens = G.collectTokens(plain, {});
ok("no styles -> 0 tokens", plainTokens.defs.length === 0);
const plainHtml = G.generateFromNode(plain, {}, {}, plainTokens);
ok("no :root when no tokens", plainHtml.indexOf(":root") === -1);
ok("color inlined when no tokens", /background-color:rgba\(51,51,51/.test(plainHtml));
// and generating WITHOUT the tokens arg at all is identical (back-compat)
ok("3-arg call === 4-arg empty-tokens call (back-compat)", G.generateFromNode(plain, {}, {}) === plainHtml);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
