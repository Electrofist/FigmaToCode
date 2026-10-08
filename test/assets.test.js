/* Asset-embedding guard rail.
 *
 * style.css must reference images ONLY as inline data: URIs, never as relative
 * files like url("logo.png"). A relative path only resolves when the file sits
 * next to the served stylesheet - which broke in hot-swap and dropped the logo
 * from the store zip. Embedding removes the failure mode; this test keeps it that
 * way. Run: `node test/assets.test.js`
 */
"use strict";
const fs = require("fs");
const path = require("path");

const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8");

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log("  PASS  " + name); }
    else { failed++; console.log("  FAIL  " + name); }
}

console.log("assets.test.js");

// Collect every url(...) target.
const urls = (css.match(/url\((['"]?)[^)]*\1\)/g) || []).map(u =>
    u.replace(/^url\((['"]?)/, "").replace(/(['"]?)\)$/, "").trim());

const relativeImages = urls.filter(u =>
    !/^data:/i.test(u) && /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(u));

check("no relative raster image url() in style.css (must be data: URIs)", relativeImages.length === 0);
if (relativeImages.length) { console.error("    offending: " + relativeImages.join(", ")); }

// The two brand images must actually be embedded.
check("toolbar/brand logo is embedded (data:image/png)", /url\(["']?data:image\/png;base64,/.test(css));
check("tutorial hero is embedded (data:image/jpeg)", /url\(["']?data:image\/jpe?g;base64,/.test(css));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
