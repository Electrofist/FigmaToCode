/* Panel input checks: the link box and the token box must refuse empty / wrong
 * input with a clear message (empty input used to be "submitted" silently and
 * people only found out later that no token was saved). Also covers branch links
 * and figmaGet's explicit-token override used to check a token BEFORE saving it.
 * Run: `node test/inputs.test.js` */
"use strict";
const { inputs: I, parseFigmaUrl, makeFigmaGet } = require("./harness.js");

let passed = 0, failed = 0;
function ok(name, cond, detail) { if (cond) { passed++; console.log("  PASS  " + name); } else { failed++; console.log("  FAIL  " + name + (detail ? "  -- " + detail : "")); } }

console.log("inputs.test.js");

/* ---------- link box ---------- */
ok("url: empty -> paste first", /Paste a Figma frame link first/.test(I.checkUrlInput("")));
ok("url: whitespace -> paste first", /Paste a Figma frame link first/.test(I.checkUrlInput("   \n\t ")));
ok("url: null/undefined -> paste first", /Paste/.test(I.checkUrlInput(null)) && /Paste/.test(I.checkUrlInput(undefined)));
ok("url: random text -> not a Figma link", /isn't a Figma link/.test(I.checkUrlInput("hello world")));
ok("url: token pasted in link box -> not a Figma link", /isn't a Figma link/.test(I.checkUrlInput("figd_abcdefghijklmnopqrstuvwxyz")));
ok("url: figma.com without file -> missing file", /missing the file/.test(I.checkUrlInput("https://www.figma.com/files/recents")));
ok("url: valid design link -> ok", I.checkUrlInput("https://www.figma.com/design/AbC123/My-File?node-id=1-2") === "");
ok("url: valid file link with spaces around -> ok", I.checkUrlInput("  https://www.figma.com/file/AbC123/x  ") === "");

/* ---------- token box ---------- */
ok("token: empty -> paste first", /Paste your Figma token first/.test(I.checkTokenInput("")));
ok("token: whitespace -> paste first", /Paste your Figma token first/.test(I.checkTokenInput("    ")));
ok("token: null -> paste first", /Paste your Figma token first/.test(I.checkTokenInput(null)));
ok("token: inner space -> no spaces", /don't contain spaces/.test(I.checkTokenInput("figd_abc defghijklmnopqrstuvwxyz")));
ok("token: link pasted -> that's a link", /Figma link, not a token/.test(I.checkTokenInput("https://www.figma.com/design/AbC123/x")));
ok("token: too short", /too short/.test(I.checkTokenInput("figd_abc")));
ok("token: plausible figd_ token -> ok", I.checkTokenInput("figd_" + "a".repeat(40)) === "");
ok("token: legacy (no figd_) long token -> ok", I.checkTokenInput("12345-" + "b".repeat(36)) === "");
ok("token: surrounding whitespace trimmed -> ok", I.checkTokenInput("  figd_" + "c".repeat(40) + "\n") === "");

/* ---------- branch links ---------- */
const br = parseFigmaUrl("https://www.figma.com/design/MAINKEY1/branch/BRANCHKEY2/My-File?node-id=3-4");
ok("branch link -> branch key", br.key === "BRANCHKEY2", br.key);
ok("branch link -> node id kept", br.nodeId === "3:4", br.nodeId);
ok("non-branch link -> main key", parseFigmaUrl("https://www.figma.com/design/MAINKEY1/My-File").key === "MAINKEY1");

/* ---------- figmaGet token override (check before save) ---------- */
(async function () {
    let seen = null;
    const fget = makeFigmaGet(function (url, opts) { seen = opts.headers["X-Figma-Token"]; return Promise.resolve({ status: 200, ok: true, json: function () { return Promise.resolve({}); } }); }, "");
    try { await fget("/me", "figd_candidate"); ok("override token used when none saved", seen === "figd_candidate", String(seen)); }
    catch (e) { ok("override token used when none saved", false, e.message); }

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
})();
