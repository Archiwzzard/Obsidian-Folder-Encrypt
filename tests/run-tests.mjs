// Bundles tests/unit.test.ts (with the Obsidian API stubbed) and runs it with Node.
import esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '.build');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'unit.test.mjs');

await esbuild.build({
	entryPoints: [path.join(here, 'unit.test.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	outfile,
	alias: { obsidian: path.join(here, 'stub-obsidian.mjs') },
	logLevel: 'warning',
});

const { run } = await import(pathToFileURL(outfile).href);
const failures = await run();
process.exit(failures > 0 ? 1 : 0);
