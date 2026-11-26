// Build script. esbuild bundles the TypeScript plugin (and the SDK) into one
// file that Stream Deck runs with its built-in Node.js.
//
//   node build.mjs           -> one-off production build
//   node build.mjs --watch   -> rebuild on save (pair with `streamdeck restart`)
//   node build.mjs --tests   -> also bundle the test runner
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const sdPlugin = "com.jere.proxmox-deck.sdPlugin";
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

/** @type {import("esbuild").BuildOptions} */
const common = {
	bundle: true,
	platform: "node",
	target: "node24", // Stream Deck 7.1+ ships Node.js 24
	format: "esm",
	sourcemap: watch ? "inline" : false,
	logLevel: "info",
	// Some bundled CommonJS deps call require(); give ESM output a require().
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
};

const builds = [
	{ ...common, entryPoints: ["src/plugin.ts"], outfile: `${sdPlugin}/bin/plugin.js`, minify: !watch },
];
if (tests) {
	builds.push({ ...common, entryPoints: ["test/run-tests.ts"], outfile: "test/dist/run-tests.js" });
	builds.push({ ...common, entryPoints: ["test/render-samples.ts"], outfile: "test/dist/render-samples.js" });
	builds.push({ ...common, entryPoints: ["test/e2e.ts"], outfile: "test/dist/e2e.js", external: ["bufferutil", "utf-8-validate"] });
}

// Stream Deck treats bin/plugin.js as an ES module only if a package.json says so.
mkdirSync(`${sdPlugin}/bin`, { recursive: true });
writeFileSync(`${sdPlugin}/bin/package.json`, JSON.stringify({ type: "module" }));
if (tests) {
	mkdirSync("test/dist", { recursive: true });
	writeFileSync("test/dist/package.json", JSON.stringify({ type: "module" }));
}

if (watch) {
	for (const options of builds) await (await esbuild.context(options)).watch();
} else {
	await Promise.all(builds.map((options) => esbuild.build(options)));
}
