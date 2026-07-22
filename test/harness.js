/* Test harness: extracts the real pure functions from main.js so tests exercise
 * the SHIPPING code (not a copy). No editor, no network. Nothing here is bundled
 * into the extension - test-only. */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

function slice(a, b, label) {
    const i = SRC.indexOf(a), j = SRC.indexOf(b);
    if (i < 0 || j < 0) { throw new Error("harness: could not locate region " + (label || a) + " (" + (i < 0 ? "start" : "end") + " marker missing)"); }
    return SRC.slice(i, j);
}

// Faithful esc + safeName from main.js.
const escRegion = slice("    function esc(", "    function copyToClipboard(", "esc/safeName");
// Generator (chan .. writeAndOpen) + paid prompt (nodeSummary .. fillClaudeInput).
const genRegion = slice("    function chan(", "\n    function writeAndOpen(", "generator");
const paidRegion = slice("    function nodeSummary(", "\n    function fillClaudeInput(", "paid");
const parseRegion = slice("    function parseFigmaUrl(", "    function frameUrl(", "parseFigmaUrl");
const frameUrlRegion = slice("    function frameUrl(", "\n\n    // ---- Figma REST", "frameUrl");
const figmaGetRegion = slice("    function figmaGet(", "\n    function fetchImages(", "figmaGet");

// Build a module exposing the generator + paid + helpers.
const genApi = new Function(
    "MAX_ELEMENTS", "MAX_ASSETS", "ui",
    escRegion + frameUrlRegion + genRegion + paidRegion +
    "\nreturn { esc, safeName, generateFromNode, collectAssetIds, collectImageRefs, isAsset, topImageFill," +
    " visualDecls, textDecls, layoutDecls, renderNode, backgroundFromFills, colorToCss, gradientCss," +
    " radiusCss, shadowCss, imageFillDecls, scaleModeDecls, buildClaudePrompt, structureOutline," +
    " assetLines, nodeSummary, frameUrl, px, collectTokens, cssVarName };"
)(6000, 120, { fileKey: "KEY", selectedId: "1:1" });

// parseFigmaUrl is standalone.
const parseApi = new Function(parseRegion + "\nreturn parseFigmaUrl;")();

// figmaGet with injectable fetch + token (for error-mapping tests).
function makeFigmaGet(fetchStub, token) {
    return new Function(
        "getToken", "fetch", "FIGMA_API",
        figmaGetRegion + "\nreturn figmaGet;"
    )(function () { return token; }, fetchStub, "https://api.figma.com/v1");
}

module.exports = { genApi, parseFigmaUrl: parseApi, makeFigmaGet, SRC };
