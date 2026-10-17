import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "fs";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

// License notices that must travel with main.js (it is distributed on its own, without the repository).
// monkey-around is bundled into main.js; the ISC license asks for its notice in all copies.
const banner = `/*!
 * ${manifest.name} ${manifest.version} – a companion to Meld Encrypt for Obsidian.
 * Copyright (c) 2026 archiwzzard. MIT License, see LICENSE and THIRD-PARTY-NOTICES.md in the source repository.
 *
 * Encryption format and parameters follow Meld Encrypt (https://github.com/meld-cp/obsidian-encrypt),
 * Copyright (c) 2021 Cleon Pinto, MIT License.
 *
 * Includes monkey-around (https://github.com/pjeby/monkey-around):
 *
 * Copyright (c) PJ Eby
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */`;

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
