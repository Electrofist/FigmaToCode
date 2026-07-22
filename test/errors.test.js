/* Error-path + crafted-response coverage.
 *  - figmaGet maps every HTTP status + network failure to an exact friendly message.
 *  - collectFrames survives malformed / hostile Figma file responses (the data that
 *    feeds the panel UI) without throwing, and respects MAX_FRAMES.
 * Run: `node test/errors.test.js` */
"use strict";
const { genApi: G, makeFigmaGet } = require("./harness.js");

let passed = 0, failed = 0;
function ok(name, cond, detail) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name + (detail ? "  -- " + detail : "")); } }

console.log("errors.test.js");

/* ---------- figmaGet: exact message per status ---------- */
function res(status, ok_, body) { return Promise.resolve({ status: status, ok: ok_, json: function () { return Promise.resolve(body || {}); } }); }
async function expectMsg(label, status, ok_, token, re) {
    const fget = makeFigmaGet(function () { return res(status, ok_); }, token);
    try { await fget("/x"); ok(label, false, "did not reject"); }
    catch (e) { ok(label, re.test(e.message), e.message); }
}
(async function () {
    // no token: rejects before any fetch
    try { await makeFigmaGet(function () { return res(200, true); }, "")("/x"); ok("no token -> settings nudge", false, "did not reject"); }
    catch (e) { ok("no token -> settings nudge", /No Figma token set.*Settings/i.test(e.message), e.message); }

    await expectMsg("401 -> invalid/expired, re-add", 401, false, "figd_x", /rejected your token \(401\).*re-add it in the Settings/i);
    await expectMsg("403 -> invalid/expired/no-access", 403, false, "figd_x", /rejected your token \(403\)/i);
    await expectMsg("404 -> frame/file not found", 404, false, "figd_x", /Frame or file not found \(404\)/i);
    await expectMsg("429 -> rate-limiting", 429, false, "figd_x", /rate-limiting requests \(429\)/i);
    await expectMsg("500 -> server error", 500, false, "figd_x", /server error \(500\)/i);
    await expectMsg("503 -> server error", 503, false, "figd_x", /server error \(503\)/i);
    // network failure (fetch rejects)
    try { await makeFigmaGet(function () { return Promise.reject(new TypeError("Failed to fetch")); }, "figd_x")("/x"); ok("network fail -> connection msg", false, "did not reject"); }
    catch (e) { ok("network fail -> connection msg", /Couldn't reach Figma/i.test(e.message), e.message); }
    // happy path returns parsed json
    try { const j = await makeFigmaGet(function () { return res(200, true, { email: "me@x.com" }); }, "figd_x")("/me"); ok("200 -> parsed json", j && j.email === "me@x.com"); }
    catch (e) { ok("200 -> parsed json", false, e.message); }

    /* ---------- collectFrames: crafted/hostile responses ---------- */
    const cf = G.collectFrames;
    ok("null doc -> []", Array.isArray(cf(null)) && cf(null).length === 0);
    ok("doc without children -> []", cf({}).length === 0);
    ok("page without children -> []", cf({ children: [{}] }).length === 0);
    // only frame-like node types are collected
    const mixed = { children: [{ children: [
        { id: "1", type: "FRAME", name: "F", absoluteBoundingBox: { width: 10, height: 20 } },
        { id: "2", type: "TEXT", name: "t" },
        { id: "3", type: "COMPONENT", name: "C" },
        { id: "4", type: "RECTANGLE", name: "r" },
        { id: "5", type: "INSTANCE", name: "I" }
    ] }] };
    ok("only FRAME/COMPONENT/INSTANCE collected", cf(mixed).length === 3, "got " + cf(mixed).length);
    // missing box / missing name do not throw
    const nobox = cf({ children: [{ children: [{ id: "1", type: "FRAME" }] }] });
    ok("missing box -> w/h default 0, no throw", nobox.length === 1 && nobox[0].w === 0 && nobox[0].h === 0);
    ok("missing name -> falls back to type", nobox[0].name === "FRAME");
    // MAX_FRAMES cap (harness sets it to 40)
    const many = { children: [{ children: [] }] };
    for (let i = 0; i < 100; i++) { many.children[0].children.push({ id: "" + i, type: "FRAME", name: "F" + i, absoluteBoundingBox: { width: 1, height: 1 } }); }
    ok("MAX_FRAMES cap respected (<=40)", cf(many).length === 40, "got " + cf(many).length);
    // hostile frame name is stored raw (escaping happens at render time, tested elsewhere) - must not throw
    let hostile;
    try { hostile = cf({ children: [{ children: [{ id: "x", type: "FRAME", name: '"><script>alert(1)</script>', absoluteBoundingBox: { width: 1, height: 1 } }] }] }); ok("hostile frame name -> no throw", hostile.length === 1); }
    catch (e) { ok("hostile frame name -> no throw", false, e.message); }

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
})();
