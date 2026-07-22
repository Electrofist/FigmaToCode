/* Release-integrity guard.
 *
 * Every runtime file listed in package.json "files" MUST be included in the
 * `zip -r extension.zip ...` line of the publish workflow, or the store build
 * ships without it (this is exactly how logo.png/hero.jpg went missing through
 * v1.0.2). Fails CI before a broken package can be released.
 * Run: `node scripts/check-release-manifest.js`
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const wf = fs.readFileSync(path.join(root, ".github/workflows/publishToPhcode.yml"), "utf8");

const files = pkg.files || [];
if (!files.length) { console.error("FAIL: package.json has no \"files\" array"); process.exit(1); }

// Grab the `zip ... extension.zip <files...>` invocation from the workflow.
const zipLine = (wf.split("\n").find(l => /zip\b.*extension\.zip/.test(l)) || "");
if (!zipLine) { console.error("FAIL: no `zip ... extension.zip` line in publishToPhcode.yml"); process.exit(1); }
const zipped = zipLine.replace(/.*extension\.zip/, "").trim().split(/\s+/).filter(Boolean);

console.log("check-release-manifest.js");
console.log("  package.json files : " + files.join(", "));
console.log("  zipped in workflow : " + zipped.join(", "));

let missing = [];
files.forEach(f => { if (!zipped.includes(f)) { missing.push(f); } });

// Each runtime file must also actually exist on disk.
let absent = [];
files.forEach(f => { if (!fs.existsSync(path.join(root, f))) { absent.push(f); } });

let ok = true;
if (missing.length) { ok = false; console.error("\nFAIL: files in package.json \"files\" NOT in the release zip: " + missing.join(", ")); }
if (absent.length) { ok = false; console.error("FAIL: files in package.json \"files\" missing on disk: " + absent.join(", ")); }

// Sanity: version must be valid semver (store rejects re-used/invalid versions).
if (!/^\d+\.\d+\.\d+$/.test(pkg.version || "")) { ok = false; console.error("FAIL: package.json version is not x.y.z semver: " + pkg.version); }

if (ok) { console.log("\nOK: every runtime file is packaged; version " + pkg.version + " is valid."); process.exit(0); }
process.exit(1);
