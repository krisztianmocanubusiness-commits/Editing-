import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Regression guard for the root cause found when loading this extension in
// Premiere Pro 26.3: a <script type="module"> entrypoint produced a blank
// panel with zero console output, because UXP's panel webview did not
// execute it. See src/main.js's header comment for the full story. index.html
// must always load the esbuild-bundled dist/main.js as a plain classic
// script instead.

test('index.html never uses <script type="module"> (outside of comments explaining not to)', () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(withoutComments, /type\s*=\s*["']module["']/i);
});

test("index.html's script tag loads the built bundle (dist/main.js), not src/main.js directly", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const scriptTagMatch = html.match(/<script\s+[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i);
  assert.ok(scriptTagMatch, "expected a <script src=...> tag in index.html");
  assert.equal(scriptTagMatch[1], "dist/main.js");
});

test("package.json's build script bundles src/main.js into dist/main.js with esbuild", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.build, /esbuild/);
  assert.match(pkg.scripts.build, /src\/main\.js/);
  assert.match(pkg.scripts.build, /dist\/main\.js/);
  // premierepro/uxp are real UXP host modules the bundle can't inline —
  // they must stay external so their require() calls pass through as-is.
  assert.match(pkg.scripts.build, /--external:premierepro/);
  assert.match(pkg.scripts.build, /--external:uxp\b/);
});
