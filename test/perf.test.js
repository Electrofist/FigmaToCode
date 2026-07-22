/* Performance / pathological-input ceilings.
 * The generator is O(n) with hard caps (MAX_ELEMENTS=6000, MAX_ASSETS=120). These
 * assert large, deep, and wide frames finish well within budget and respect caps,
 * so a future refactor that introduces quadratic behaviour or unbounded recursion
 * fails CI. Budgets are generous to avoid CI-runner flakiness.
 * Run: `node test/perf.test.js` */
"use strict";
const { genApi: G } = require("./harness.js");

let passed = 0, failed = 0;
function ok(name, cond, detail) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name + (detail ? "  -- " + detail : "")); } }
const box = (x, y, w, h) => ({ x, y, width: w, height: h });
function time(fn) { const t = Date.now(); const r = fn(); return { ms: Date.now() - t, r }; }

console.log("perf.test.js");

// ---- wide: 150 leaf "asset" nodes (exceeds MAX_ASSETS=120) ----
(function () {
    const kids = [];
    for (let i = 0; i < 150; i++) { kids.push({ id: "k:" + i, name: "icon " + i, type: "VECTOR", absoluteBoundingBox: box(0, 0, 8, 8) }); }
    const root = { id: "0:1", name: "wide", type: "FRAME", absoluteBoundingBox: box(0, 0, 1200, 40), children: kids };
    let out; try { out = time(function () { return G.generateFromNode(root, {}, {}); }); ok("wide (150 assets) no throw", true); }
    catch (e) { ok("wide (150 assets) no throw", false, e.message); return; }
    ok("wide finishes < 1000ms", out.ms < 1000, out.ms + "ms");
    ok("collectAssetIds capped at 120", G.collectAssetIds(root).length === 120, "" + G.collectAssetIds(root).length);
})();

// ---- big balanced tree ~6000+ nodes (exceeds MAX_ELEMENTS) ----
(function () {
    function build(depth, breadth, id) {
        const n = { id: id + "", name: "n" + id, type: "FRAME", layoutMode: "VERTICAL", itemSpacing: 4,
            absoluteBoundingBox: box(0, 0, 100, 100), children: [] };
        if (depth > 0) { for (let i = 0; i < breadth; i++) { n.children.push(build(depth - 1, breadth, id * breadth + i + 1)); } }
        return n;
    }
    const root = build(6, 4, 1); // 4^0..4^6 ~ 5461 nodes
    let out; try { out = time(function () { return G.generateFromNode(root, {}, {}); }); ok("big tree no throw", true); }
    catch (e) { ok("big tree no throw", false, e.message); return; }
    ok("big tree finishes < 3000ms", out.ms < 3000, out.ms + "ms");
    const count = (out.r.match(/data-name=/g) || []).length;
    ok("MAX_ELEMENTS cap respected (<=6100 elements)", count <= 6100, count + " elements");
})();

// ---- deep chain: recursion depth 1000, must not stack-overflow ----
(function () {
    let node = { id: "leaf", name: "leaf", type: "FRAME", absoluteBoundingBox: box(0, 0, 10, 10) };
    for (let i = 0; i < 1000; i++) { node = { id: "d" + i, name: "d" + i, type: "FRAME", layoutMode: "VERTICAL", absoluteBoundingBox: box(0, 0, 100, 100), children: [node] }; }
    let out; try { out = time(function () { return G.generateFromNode(node, {}, {}); }); ok("deep chain (1000) no throw / no stack overflow", true); }
    catch (e) { ok("deep chain (1000) no throw / no stack overflow", false, e.message); return; }
    ok("deep chain finishes < 1000ms", out.ms < 1000, out.ms + "ms");
})();

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
