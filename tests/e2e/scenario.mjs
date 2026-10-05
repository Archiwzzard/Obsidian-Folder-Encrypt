// End-to-end test against a real Obsidian instance (started with --remote-debugging-port and a
// throw-away vault that has the plugin installed). Usage:
//   TEST_VAULT=<vault path> node tests/e2e/scenario.mjs
import { connect } from './cdp.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const VAULT = process.env.TEST_VAULT;
if (!VAULT || !fs.existsSync(path.join(VAULT, '.obsidian'))) {
	throw new Error('set TEST_VAULT to the test vault');
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ID = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).id;
const EXT = 'wzzcrypt';
const client = await connect();

const PRELUDE = `
const sleep = ms => new Promise(r => setTimeout(r, ms));
const plugin = app.plugins.plugins['${PLUGIN_ID}'];
const EXT = '${EXT}';
const waitFor = async (fn, ms = 10000, what = 'condition') => {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > ms) throw new Error('timeout waiting for ' + what);
		await sleep(100);
	}
};
const modals = () => [...document.querySelectorAll('.modal-container .modal')];
const modalTitled = text => modals().find(m => (m.querySelector('.modal-title')?.textContent ?? '').includes(text));
const lastButton = m => { const b = [...m.querySelectorAll('.setting-item-control button')]; return b[b.length - 1]; };
// a note by its path below the folder the encryption was started from, with real folder names
const byName = name => plugin.index.all().find(e => e.name && plugin.index.displayPath(e.file) === name);
const isId = s => /^[a-km-np-z2-9]{12}$/.test(s) && /[0-9]/.test(s) && /[a-z]/.test(s);
const markerFiles = () => app.vault.getFiles().filter(f => f.name === 'folder.wzzfolder').map(f => f.path).sort();
const foldersBelow = root => app.vault.getAllLoadedFiles().filter(f => f.children && f.path.startsWith(root + '/')).map(f => f.path).sort();
// renames like an interrupted run would have left it, without the plugin's rename guard
const renameUnguarded = async (file, target) => { plugin.ops.ownRenames.add(target); try { await app.vault.rename(file, target); await sleep(300); } finally { plugin.ops.ownRenames.delete(target); } };
const decryptEntry = async e => {
	const env = JSON.parse(await app.vault.read(e.file));
	return new TextDecoder().decode(await e.secret.decrypt(env.encodedData));
};
// Obsidian's own "Update links" prompt (any modal with buttons that is not ours; works in every UI language)
const linkPrompt = () => modals().find(m => !m.classList.contains('wzz-modal') && m.querySelector('.modal-button-container button'));
const clearNotices = () => document.querySelectorAll('.notice').forEach(n => n.remove());
const renameNotice = () => [...document.querySelectorAll('.notice')].some(n => n.textContent.includes('cannot be renamed'));
`;
const run = body => client.evaluate(PRELUDE + body);

let failed = 0;
async function step(name, fn) {
	try {
		const info = await fn();
		console.log(`  ok    ${name}${info ? `  ${JSON.stringify(info).slice(0, 220)}` : ''}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL  ${name}\n        ${error.message}`);
	}
}
function check(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

// Sample data. Names are long enough that they cannot show up by chance inside base64 ciphertext.
const OVERVIEW = '# Overview\n\n- Deadline: March 12\n- See [[Roadmap]] and [[Projects/Roadmap#Costs|the costs]]\n- Logbook: [[Logbook]]\n';
const ROADMAP = '# Roadmap\n\n## Costs\n\nOrder no. 5823, $23/month\n\n![[Scan.pdf]]\n';
const DAILY = '# Daily\n\nThought about [[Overview]] today, see also [Roadmap](Notes/Projects/Roadmap.md).\n';
const LOGBOOK = '# Logbook\n\nToday was a good day.\n';
const SECRETS = ['Overview', 'Roadmap', 'Logbook', 'Projects', '5823', 'Deadline', 'good day', 'First Draft', 'Drafts', 'Leak Test'];
const ADDED = '- Added: January 1\n';

async function meldFile(text, password) {
	const enc = new TextEncoder();
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(16));
	const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
	const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 210000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
	const all = new Uint8Array(32 + ct.length);
	all.set(iv, 0);
	all.set(salt, 16);
	all.set(ct, 32);
	return JSON.stringify({ version: '2.0', hint: 'a word', encodedData: Buffer.from(all).toString('base64') }, null, 2);
}

function scanVaultFor(words) {
	const hits = [];
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'plugins') walk(full);
				continue;
			}
			const text = fs.readFileSync(full, 'utf8');
			for (const word of words) {
				if (entry.name.includes(word) || text.includes(word)) hits.push(`${path.relative(VAULT, full)}: ${word}`);
			}
		}
	};
	walk(VAULT);
	return hits;
}

console.log('Folder Encrypt end-to-end test\n');

await step('reload plugin with the current build', async () => {
	const target = path.join(VAULT, '.obsidian/plugins', PLUGIN_ID);
	fs.mkdirSync(target, { recursive: true });
	for (const f of ['main.js', 'manifest.json', 'styles.css']) {
		fs.copyFileSync(path.join(ROOT, f), path.join(target, f));
	}
	return run(`
		// collect errors raised by the plugin (logged, thrown or rejected)
		window.__wzzErrors = [];
		if (!window.__wzzHooked) {
			window.__wzzHooked = true;
			const mine = text => /Folder Encrypt|plugin:${PLUGIN_ID}/.test(text);
			const record = text => { if (mine(text)) window.__wzzErrors.push(text.slice(0, 500)); };
			const original = console.error;
			console.error = function (...args) {
				record(args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' '));
				return original.apply(this, args);
			};
			window.addEventListener('error', e => record(String((e.error && e.error.stack) || e.message)));
			window.addEventListener('unhandledrejection', e => record(String((e.reason && e.reason.stack) || e.reason)));
		}
		await app.plugins.loadManifests();
		await app.plugins.disablePlugin('${PLUGIN_ID}');
		await app.plugins.enablePlugin('${PLUGIN_ID}');
		await sleep(800);
		if (!app.plugins.plugins['${PLUGIN_ID}']) throw new Error('not loaded');
	`);
});

await step('reset vault', async () => {
	const meld = await meldFile(LOGBOOK, 'meldpass');
	return run(`
		await plugin.lockAll();
		app.workspace.getLeavesOfType('markdown').forEach(l => l.detach());
		if (app.workspace.recentFileTracker) app.workspace.recentFileTracker.lastOpenFiles = []; // leftovers of earlier runs
		// desktop saves the layout in workspace.json, mobile in workspace-mobile.json; the other one is left over
		const staleLayout = app.vault.configDir + (app.isMobile ? '/workspace.json' : '/workspace-mobile.json');
		if (await app.vault.adapter.exists(staleLayout)) await app.vault.adapter.remove(staleLayout);
		for (const f of app.vault.getFiles()) await app.vault.delete(f, true);
		const folders = app.vault.getAllLoadedFiles().filter(f => f.children && f.path !== '/').sort((a, b) => b.path.length - a.path.length);
		for (const f of folders) await app.vault.delete(f, true);
		const bookmarks = app.internalPlugins.plugins.bookmarks;
		if (!bookmarks.enabled) await bookmarks.enable();
		for (const item of [...bookmarks.instance.items]) bookmarks.instance.removeItem(item);
		await app.vault.createFolder('Notes/Projects');
		await app.vault.create('Notes/Overview.md', ${JSON.stringify(OVERVIEW)});
		await app.vault.create('Notes/Projects/Roadmap.md', ${JSON.stringify(ROADMAP)});
		await app.vault.createBinary('Notes/Projects/Scan.pdf', new TextEncoder().encode('%PDF-1.4 fake').buffer);
		await app.vault.create('Notes/Logbook.mdenc', ${JSON.stringify(meld)});
		await app.vault.create('Daily.md', ${JSON.stringify(DAILY)});
		await app.vault.createFolder('Plain');
		await sleep(1500);
		return app.vault.getFiles().map(f => f.path).sort();
	`);
});

let ids = {};
let projectsPath = ''; // random name of Notes/Projects
await step('encrypt folder through the dialog (Meld note has another password)', async () => {
	const result = await run(`
		const task = plugin.ops.encryptFolderInteractive(app.vault.getAbstractFileByPath('Notes'));
		const dialog = await waitFor(() => document.querySelector('.modal.wzz-encrypt-folder-modal'), 5000, 'folder dialog');
		const inputs = dialog.querySelectorAll('.wzz-password-fields input');
		inputs[0].value = 'test123'; inputs[1].value = 'test123'; inputs[2].value = 'numbers';
		dialog.querySelector('button.mod-cta').click();
		const meld = await waitFor(() => modalTitled('Logbook'), 20000, 'Meld password dialog');
		meld.querySelector('input[type=password]').value = 'meldpass';
		meld.querySelector('button.mod-cta').click();
		let prompted = false;
		for (let i = 0; i < 300 && plugin.ops.isRunning; i++) {
			if (linkPrompt()) { prompted = true; break; }
			await sleep(100);
		}
		await Promise.race([task, sleep(5000)]);
		const report = document.querySelector('.modal.wzz-modal');
		const reportText = report ? [...report.querySelectorAll('p, li')].map(p => p.textContent) : [];
		if (report) lastButton(report).click();
		const ids = {};
		for (const e of plugin.index.all()) ids[plugin.index.displayPath(e.file)] = e.file.basename;
		const projects = app.vault.getAbstractFileByPath('Notes').children.find(c => c.children);
		return {
			prompted, running: plugin.ops.isRunning, reportText, files: app.vault.getFiles().map(f => f.path).sort(), ids,
			folders: foldersBelow('Notes'), folderName: projects && plugin.index.folderName(projects),
		};
	`);
	check(!result.prompted, 'Obsidian asked to update links');
	check(!result.running, 'operation still running');
	check(result.folders.length === 1 && new RegExp('^Notes/[a-z0-9]{12}$').test(result.folders[0]), 'subfolder not kept under a random name: ' + result.folders);
	const projects = result.folders[0];
	const encrypted = result.files.filter(f => f.endsWith(`.${EXT}`));
	const inNotes = encrypted.filter(f => new RegExp(`^Notes/[a-z0-9]{12}\\.${EXT}$`).test(f));
	const inProjects = encrypted.filter(f => new RegExp(`^${projects}/[a-z0-9]{12}\\.${EXT}$`).test(f));
	check(encrypted.length === 3 && inNotes.length === 2 && inProjects.length === 1, `expected 2 random .${EXT} files in Notes and 1 in its subfolder: ` + result.files);
	check(result.files.includes(`${projects}/Scan.pdf`) && result.files.includes('Daily.md'), 'attachment / daily note missing: ' + result.files);
	check(result.files.includes(`${projects}/folder.wzzfolder`), 'folder marker missing: ' + result.files);
	check(result.folderName === 'Projects', 'real folder name not unlocked: ' + result.folderName);
	check(result.files.filter(f => f.endsWith('.md') || f.endsWith('.mdenc')).length === 1, 'plain notes left: ' + result.files);
	check(result.reportText.some(t => t.includes('Scan.pdf')), 'report does not mention the attachment');
	ids = result.ids;
	check(ids['Overview'] && ids['Projects/Roadmap'] && ids['Logbook'], 'names not unlocked: ' + JSON.stringify(ids));
	projectsPath = projects;
	return { ...ids, projects };
});

await step('file menu: one "Folder Encrypt" entry, all actions in its submenu', async () => {
	const r = await run(`
		// open the real context menu of a folder once to get hold of Obsidian's Menu class
		// (the explorer may be hidden behind the side panel from an earlier run)
		await app.workspace.revealLeaf(app.workspace.getLeavesOfType('file-explorer')[0]);
		await sleep(300);
		const el = document.querySelector('.nav-folder-title[data-path="Notes"]');
		let captured = null, capturedPath = null;
		const ref = app.workspace.on('file-menu', (m, f) => { captured = m; capturedPath = f.path; });
		const box = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.x + 5, clientY: box.y + 5 }));
		await sleep(200);
		app.workspace.offref(ref);
		if (!captured) throw new Error('no file menu opened');
		const Menu = captured.constructor;
		window.wzzTestMenu = Menu; // for later steps
		const titles = items => items.map(i => (i.titleEl ? i.titleEl.textContent : '---'));
		const ours = menu => menu.items.filter(i => i.titleEl && i.titleEl.textContent === 'Folder Encrypt');
		const describe = menu => ({ count: ours(menu).length, top: titles(menu.items), sub: ours(menu)[0]?.submenu ? titles(ours(menu)[0].submenu.items) : null });
		const out = { folder: { ...describe(captured), path: capturedPath } };
		captured.hide();
		const menuFor = (event, target) => { const m = new Menu(); app.workspace.trigger(event, m, target, 'file-explorer'); return m; };
		const file = p => app.vault.getAbstractFileByPath(p);
		out.note = describe(menuFor('file-menu', file('Notes/${ids['Overview']}.${EXT}')));
		out.daily = describe(menuFor('file-menu', file('Daily.md')));
		out.pdf = describe(menuFor('file-menu', file('${projectsPath}/Scan.pdf')));
		out.many = describe(menuFor('files-menu', [file('Daily.md'), file('${projectsPath}/Scan.pdf')]));
		out.mixed = describe(menuFor('files-menu', [file('Daily.md'), file('Notes/${ids['Overview']}.${EXT}')]));
		out.encryptedFolder = describe(menuFor('file-menu', file('${projectsPath}')));
		// a folder without encrypted notes
		out.plainFolder = describe(menuFor('file-menu', file('Plain')));
		// an entry of the submenu runs its action
		const panel = ours(menuFor('file-menu', file('Daily.md')))[0].submenu.items.find(i => i.titleEl?.textContent === 'Open encrypted notes panel');
		panel.dom.click();
		await waitFor(() => app.workspace.getLeavesOfType('${PLUGIN_ID}-panel').length > 0, 3000, 'panel');
		return out;
	`);
	// lock only where encrypted notes are involved; the panel everywhere
	const withLock = ['---', 'Lock all encrypted notes', 'Open encrypted notes panel'];
	const withoutLock = ['---', 'Open encrypted notes panel'];
	const expect = (what, sub, general) => {
		check(r[what].count === 1, `${what}: expected one Folder Encrypt entry, got ${r[what].count}: ${JSON.stringify(r[what])}`);
		check(JSON.stringify(r[what].sub) === JSON.stringify([...sub, ...general]), `${what} submenu: ${JSON.stringify(r[what].sub)}`);
		// none of our actions directly in the menu ("New encrypted note" is also Meld's own entry)
		const leaked = r[what].sub.filter(t => t !== '---' && t !== 'New encrypted note' && r[what].top.includes(t));
		check(leaked.length === 0, `${what}: actions outside the submenu: ${leaked}`);
	};
	check(r.folder.path === 'Notes', 'context menu opened for ' + r.folder.path);
	expect('folder', ['New encrypted note', 'Encrypt folder (incl. file names)…', 'Decrypt folder permanently…'], withLock);
	expect('note', ['Decrypt permanently'], withLock);
	expect('mixed', ['Encrypt note (incl. file name)'], withLock);
	expect('encryptedFolder', ['New encrypted note', 'Encrypt folder (incl. file names)…', 'Decrypt folder permanently…'], withLock);
	expect('plainFolder', ['New encrypted note', 'Encrypt folder (incl. file names)…'], withoutLock);
	expect('daily', ['Encrypt note (incl. file name)'], withoutLock);
	expect('many', ['Encrypt note (incl. file name)'], withoutLock);
	check(r.pdf.count === 0, 'attachments get a Folder Encrypt entry');
	return { folder: r.folder.sub };
});

await step('side panel lists the notes by their real names and opens them', async () => {
	const r = await run(`
		const view = app.workspace.getLeavesOfType('${PLUGIN_ID}-panel')[0]?.view;
		if (!view) throw new Error('panel not open');
		await app.workspace.revealLeaf(view.leaf);
		await sleep(300);
		const el = view.contentEl;
		const texts = sel => [...el.querySelectorAll(sel)].map(e => e.textContent);
		const out = {
			shown: view.containerEl.isShown(),
			header: texts('.wzz-panel-status').join(''),
			groups: texts('.wzz-group-title'),
			folders: texts('.wzz-tree .tree-item-self.mod-collapsible:not(.wzz-group-title)'),
			notes: texts('.wzz-note-row'),
		};
		// clicking a row opens that note
		[...el.querySelectorAll('.wzz-note-row')].find(e => e.textContent === 'Logbook').click();
		const opened = await waitFor(() => app.workspace.getLeavesOfType('${PLUGIN_ID}-note').find(l => l.view.file === byName('Logbook').file), 5000, 'note opened from the panel');
		out.openedActive = el.querySelector('.wzz-note-row.is-active')?.textContent ?? null;
		await sleep(300);
		out.activeAfter = view.contentEl.querySelector('.wzz-note-row.is-active')?.textContent ?? null;
		opened.detach();
		return out;
	`);
	check(r.shown, 'panel is not visible');
	check(r.header.includes('Unlocked'), 'header: ' + r.header);
	check(r.groups.length === 1 && r.groups[0].startsWith('Notes'), 'groups: ' + r.groups);
	check(JSON.stringify(r.folders) === JSON.stringify(['Projects']), 'virtual folders: ' + r.folders);
	check(JSON.stringify([...r.notes].sort()) === JSON.stringify(['Logbook', 'Overview', 'Roadmap']), 'notes: ' + r.notes);
	check(r.activeAfter === 'Logbook', 'opened note not highlighted: ' + r.activeAfter);
	return { notes: r.notes };
});

await step('encrypted content is intact, links inside point to the new files', async () => {
	const r = await run(`
		const out = {};
		for (const name of ['Overview', 'Projects/Roadmap', 'Logbook']) out[name] = await decryptEntry(byName(name));
		out.daily = await app.vault.read(app.vault.getAbstractFileByPath('Daily.md'));
		return out;
	`);
	check(r['Projects/Roadmap'] === ROADMAP, 'Roadmap content changed');
	check(r['Logbook'] === LOGBOOK, 'Meld note content changed');
	const roadmap = `${ids['Projects/Roadmap']}.${EXT}`;
	const expected = OVERVIEW
		.replace('[[Roadmap]]', `[[${roadmap}|Roadmap]]`)
		.replace('[[Projects/Roadmap#Costs|the costs]]', `[[${roadmap}#Costs|the costs]]`);
	// [[Logbook]] never resolved to Logbook.mdenc (links without extension only find .md), so it stays
	check(r['Overview'] === expected, 'Overview links:\n' + r['Overview']);
	check(!r.daily.includes('Overview') && !r.daily.includes('Roadmap'), 'Daily still names the notes: ' + r.daily);
	check(r.daily.includes(`${ids['Overview']}.${EXT}`) && r.daily.includes(roadmap), 'Daily links not updated: ' + r.daily);
	check(!r.daily.includes('Projects'), 'Daily still names the folder: ' + r.daily);
	return { daily: r.daily.split('\n')[2] };
});

await step('open note: decrypted in the editor, real name only in the DOM', async () => {
	const r = await run(`
		const leaf = app.workspace.getLeaf(true);
		await leaf.openFile(byName('Overview').file);
		await sleep(700);
		const v = leaf.view;
		return {
			type: v.getViewType(), text: v.editor.getValue(), tab: leaf.tabHeaderInnerTitleEl?.textContent,
			header: v.titleEl?.textContent, inline: v.inlineTitleEl?.textContent, display: v.getDisplayText(),
			state: JSON.stringify(leaf.getViewState()),
		};
	`);
	check(r.type === `${PLUGIN_ID}-note`, 'wrong view ' + r.type);
	check(r.text.startsWith('# Overview'), 'editor text: ' + r.text.slice(0, 40));
	check(r.tab === 'Overview' && r.header === 'Overview' && r.inline === 'Overview', `titles ${r.tab}/${r.header}/${r.inline}`);
	check(r.display === ids['Overview'], 'getDisplayText must stay the random name');
	check(!r.state.includes('Overview'), 'view state contains the name: ' + r.state);
	return { tab: r.tab, display: r.display };
});

await step('note header shows the real folder names', async () => {
	const r = await run(`
		const leaf = app.workspace.getLeaf(true);
		await leaf.openFile(byName('Projects/Roadmap').file);
		await sleep(700);
		const crumbs = [...leaf.view.titleParentEl.querySelectorAll('.view-header-breadcrumb')].map(el => el.textContent);
		const state = JSON.stringify(leaf.getViewState());
		leaf.detach();
		return { crumbs, state };
	`);
	check(JSON.stringify(r.crumbs) === JSON.stringify(['Notes', 'Projects']), 'breadcrumbs: ' + r.crumbs);
	check(!r.state.includes('Projects'), 'view state contains the folder name: ' + r.state);
	return { crumbs: r.crumbs };
});

await step('edit, save and switch reading/editing mode', async () => {
	const r = await run(`
		const leaf = app.workspace.getLeavesOfType('${PLUGIN_ID}-note')[0];
		const v = leaf.view;
		const last = v.editor.lastLine();
		v.editor.replaceRange(${JSON.stringify(ADDED)}, { line: last, ch: v.editor.getLine(last).length });
		await v.save();
		const disk = await app.vault.read(v.file);
		const decrypted = await decryptEntry(plugin.index.get(v.file));
		const state = leaf.getViewState();
		await leaf.setViewState({ ...state, state: { ...state.state, mode: 'preview' } });
		await sleep(1200);
		const preview = v.contentEl.innerText;
		await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
		await sleep(400);
		return { diskIsEnvelope: disk.trim().startsWith('{') && disk.includes('encodedData'), diskHasPlain: disk.includes('Added: January 1'), decrypted, preview: preview.includes('Added: January 1'), after: v.editor.getValue() };
	`);
	check(r.diskIsEnvelope && !r.diskHasPlain, 'plaintext on disk');
	check(r.decrypted.endsWith(ADDED), 'edit not saved: ' + JSON.stringify(r.decrypted.slice(-30)));
	check(r.preview, 'reading view does not show the note');
	check(r.after === r.decrypted, 'editor text changed after mode switch: ' + r.after.slice(0, 60));
	return { savedTail: r.decrypted.slice(-16) };
});

await step('titles are read-only; a title edit renames nothing', async () => {
	const r = await run(`
		const v = app.workspace.getLeavesOfType('${PLUGIN_ID}-note')[0].view;
		const before = v.file.path;
		const editable = [v.inlineTitleEl, v.titleEl].map(el => el.isContentEditable);
		// force what Obsidian does after a title edit, in case a title became editable again
		const results = [];
		for (const el of [v.inlineTitleEl, v.titleEl]) {
			clearNotices();
			v.fileBeingRenamed = v.file;
			el.textContent = 'Leak Test';
			await v.saveTitle(el);
			await sleep(300);
			results.push({ text: el.textContent, notice: renameNotice() });
		}
		return { before, after: v.file.path, editable, results, name: plugin.index.get(v.file)?.name?.path, tab: v.leaf.tabHeaderInnerTitleEl?.textContent, files: app.vault.getFiles().map(f => f.path) };
	`);
	check(r.editable.every(e => !e), 'title is editable: ' + r.editable);
	check(r.before === r.after, 'file was renamed on disk');
	check(r.name === 'Overview', 'encrypted name changed: ' + r.name);
	check(r.results.every(x => x.text === 'Overview' && x.notice), 'title edit not undone: ' + JSON.stringify(r.results));
	check(!r.files.some(f => f.includes('Overview') || f.includes('Leak')), 'readable name on disk');
	check(r.tab === 'Overview', 'tab title ' + r.tab);
	return { path: r.after };
});

await step('renaming the file itself is undone, the name stays', async () => {
	const r = await run(`
		const e = byName('Overview');
		const id = e.file.basename;
		clearNotices();
		// like a user renaming through some other plugin; Obsidian asks about links (answer: just once)
		const renaming = app.fileManager.renameFile(e.file, 'Notes/Leak Test.' + EXT);
		const prompt = await waitFor(linkPrompt, 3000, 'link prompt').catch(() => null);
		prompt?.querySelectorAll('.modal-button-container button')[1]?.click();
		await renaming;
		await waitFor(() => isId(e.file.basename), 8000, 'guard');
		await sleep(1200);
		return { id, now: e.file.basename, name: plugin.index.get(e.file)?.name?.path, notice: renameNotice(), files: app.vault.getFiles().map(f => f.path) };
	`);
	check(r.now === r.id, 'did not return to the previous random name');
	check(r.name === 'Overview', 'encrypted name changed: ' + r.name);
	check(r.notice, 'no notice shown');
	check(!r.files.some(f => f.includes('Leak')), 'readable name left on disk');
	return { name: r.name };
});

await step('explorer shows real names; F2 and "Rename…" are blocked', async () => {
	const r = await run(`
		const explorer = app.workspace.getLeavesOfType('file-explorer')[0].view;
		plugin.revealInExplorer(byName('Projects/Roadmap').file);
		plugin.revealInExplorer(byName('Logbook').file);
		await sleep(400);
		const titles = [...document.querySelectorAll('.nav-file-title')].map(el => ({ path: el.dataset.path, text: el.querySelector('.nav-file-title-content')?.textContent }));
		const folderTitles = [...document.querySelectorAll('.nav-folder-title')].map(el => ({ path: el.dataset.path, text: el.querySelector('.nav-folder-title-content')?.textContent }));
		const path = byName('Logbook').file.path;
		const blocked = async file => {
			clearNotices();
			explorer.startRenameFile(file);
			await sleep(300);
			const inlineRename = !!document.querySelector('.is-being-renamed');
			const f2 = { notice: renameNotice(), modals: modals().length, inlineRename };
			clearNotices();
			app.fileManager.promptForFileRename(file);
			await sleep(300);
			const prompt = { notice: renameNotice(), modals: modals().length };
			modals().forEach(m => m.querySelector('.modal-close-button')?.click());
			return { f2, prompt };
		};
		const note = await blocked(byName('Logbook').file);
		const folder = await blocked(app.vault.getAbstractFileByPath('${projectsPath}'));
		return { titles, folderTitles, note, folder, after: byName('Logbook').file.path, path, folderAfter: !!app.vault.getAbstractFileByPath('${projectsPath}') };
	`);
	const texts = r.titles.map(t => t.text);
	check(texts.includes('Overview') && texts.includes('Roadmap') && texts.includes('Logbook'), 'explorer titles: ' + texts);
	check(r.folderTitles.some(t => t.path === projectsPath && t.text === 'Projects'), 'explorer folder titles: ' + JSON.stringify(r.folderTitles));
	check(r.titles.filter(t => t.path.endsWith(`.${EXT}`)).every(t => new RegExp(`[a-z0-9]{12}\\.${EXT}$`).test(t.path)), 'paths are not random');
	for (const what of ['note', 'folder']) {
		const x = r[what];
		check(!x.f2.inlineRename && x.f2.modals === 0 && x.f2.notice, `${what}: F2 not blocked: ` + JSON.stringify(x.f2));
		check(x.prompt.modals === 0 && x.prompt.notice, `${what}: promptForFileRename not blocked: ` + JSON.stringify(x.prompt));
	}
	check(r.after === r.path && r.folderAfter, 'file or folder was renamed');
	return { texts: texts.filter(t => !t.includes('.')), folders: r.folderTitles.map(t => t.text) };
});

await step('no plaintext anywhere in the vault while unlocked (incl. workspace.json)', async () => {
	await run(`app.workspace.requestSaveLayout(); await app.workspace.requestSaveLayout.run(); await sleep(800);`);
	const hits = scanVaultFor(SECRETS);
	check(hits.length === 0, 'found: ' + hits.join(', '));
});

await step('lock: views close, names disappear', async () => {
	const r = await run(`
		await plugin.lockAll();
		await sleep(300);
		const titles = [...document.querySelectorAll('.nav-file-title, .nav-folder-title')].map(el => el.textContent);
		const panel = app.workspace.getLeavesOfType('${PLUGIN_ID}-panel')[0]?.view.contentEl.innerText ?? '';
		const folderState = plugin.index.folderEntry(app.vault.getAbstractFileByPath('${projectsPath}'))?.state;
		const submenu = path => {
			const m = new window.wzzTestMenu();
			app.workspace.trigger('file-menu', m, app.vault.getAbstractFileByPath(path), 'file-explorer');
			const ours = m.items.find(i => i.titleEl?.textContent === 'Folder Encrypt');
			return ours?.submenu?.items.map(i => i.titleEl?.textContent ?? '---') ?? null;
		};
		const menus = { folder: submenu('Notes'), plainFolder: submenu('Plain'), daily: submenu('Daily.md') };
		return { views: app.workspace.getLeavesOfType('${PLUGIN_ID}-note').length, states: plugin.index.all().map(e => e.state), folderState, unlocked: plugin.session.isUnlocked, titles, panel, menus };
	`);
	check(r.folderState === 'locked', 'folder name still unlocked: ' + r.folderState);
	check(!r.titles.includes('Projects'), 'explorer still shows the folder name');
	const has = (what, title) => (r.menus[what] ?? []).includes(title);
	check(has('folder', 'Unlock encrypted notes…') && !has('folder', 'Lock all encrypted notes'), 'locked folder menu: ' + r.menus.folder);
	check(!has('plainFolder', 'Unlock encrypted notes…') && !has('daily', 'Unlock encrypted notes…'), 'unlock offered without encrypted notes: ' + JSON.stringify(r.menus));
	check(r.views === 0, 'views still open');
	check(r.states.every(s => s === 'locked') && !r.unlocked, 'still unlocked');
	check(!r.titles.some(t => ['Overview', 'Logbook'].includes(t)), 'explorer still shows names');
	check(/\d+ encrypted notes? – unlock to see (its name|their names)/.test(r.panel), 'panel while locked: ' + r.panel);
	check(!['Overview', 'Logbook', 'Roadmap', 'Projects'].some(n => r.panel.includes(n)), 'panel still shows names: ' + r.panel);
	return { states: r.states };
});

await step('opening a locked note asks for the password (wrong, then right)', async () => {
	const r = await run(`
		const file = app.vault.getFiles().find(f => f.basename === ${JSON.stringify(ids['Logbook'])});
		const leaf = app.workspace.getLeaf(true);
		const opening = leaf.openFile(file);
		const dialog = await waitFor(() => modalTitled('Unlock'), 5000, 'unlock dialog');
		const hint = dialog.querySelector('.wzz-hint')?.textContent;
		dialog.querySelector('input[type=password]').value = 'nope';
		dialog.querySelector('button.mod-cta').click();
		await waitFor(() => dialog.querySelector('.wzz-error')?.textContent === 'Wrong password.', 8000, 'wrong password message');
		dialog.querySelector('input[type=password]').value = 'test123';
		dialog.querySelector('button.mod-cta').click();
		await opening;
		await sleep(500);
		return { hint, text: leaf.view.editor?.getValue(), tab: leaf.tabHeaderInnerTitleEl?.textContent, unlockedNames: plugin.index.all().filter(e => e.state === 'unlocked').length };
	`);
	check(r.hint === 'Hint: numbers', 'hint: ' + r.hint);
	check(r.text === LOGBOOK && r.tab === 'Logbook', 'note not opened');
	check(r.unlockedNames === 3, 'other notes not unlocked');
	return { hint: r.hint };
});

await step('new note in the folder reuses the folder password', async () => {
	const r = await run(`
		const task = plugin.ops.newNoteInteractive(app.vault.getAbstractFileByPath('Notes'));
		const dialog = await waitFor(() => modalTitled('New encrypted note'), 5000, 'name dialog');
		dialog.querySelector('input').value = 'Drafts/First Draft';
		dialog.querySelector('button.mod-cta').click();
		await task;
		await sleep(600);
		const passwordDialog = modals().some(m => /password/i.test(m.querySelector('.modal-title')?.textContent ?? ''));
		const leaf = app.workspace.getLeavesOfType('${PLUGIN_ID}-note').find(l => l.view.realName === 'First Draft');
		leaf.view.editor.setValue('Just an idea');
		await leaf.view.save();
		const e = byName('Drafts/First Draft');
		return { passwordDialog, path: e?.file.path, content: e ? await decryptEntry(e) : null };
	`);
	check(!r.passwordDialog, 'asked for a password again');
	check(new RegExp(`^Notes/[a-z0-9]{12}\\.${EXT}$`).test(r.path), 'path ' + r.path);
	check(r.content === 'Just an idea', 'content ' + r.content);
	return { path: r.path };
});

await step('auto-lock after inactivity', async () => {
	const r = await run(`
		const minutes = plugin.settings.autoLockMinutes;
		plugin.settings.autoLockMinutes = 1;
		plugin.session.lastActivity = Date.now() - 61000;
		await waitFor(() => !plugin.session.isUnlocked, 20000, 'auto-lock');
		await sleep(500);
		plugin.settings.autoLockMinutes = minutes;
		return { views: app.workspace.getLeavesOfType('${PLUGIN_ID}-note').length };
	`);
	check(r.views === 0, 'views still open after auto-lock');
});

await step('decrypt folder permanently restores names, folders and links', async () => {
	const r = await run(`
		const unlock = plugin.promptUnlock();
		const dialog = await waitFor(() => modalTitled('Unlock'), 5000, 'unlock dialog');
		dialog.querySelector('input[type=password]').value = 'test123';
		dialog.querySelector('button.mod-cta').click();
		await unlock;
		const task = plugin.ops.decryptFolderInteractive(app.vault.getAbstractFileByPath('Notes'));
		const confirm = await waitFor(() => modalTitled('Decrypt permanently'), 5000, 'confirm dialog');
		const message = confirm.querySelector('p')?.textContent;
		lastButton(confirm).click();
		let prompted = false;
		for (let i = 0; i < 200 && (plugin.ops.isRunning || !document.querySelector('.modal.wzz-modal')); i++) {
			if (linkPrompt()) { prompted = true; break; }
			await sleep(100);
		}
		await Promise.race([task, sleep(5000)]);
		document.querySelectorAll('.modal.wzz-modal').forEach(m => lastButton(m)?.click());
		await sleep(300);
		const read = async p => { const f = app.vault.getAbstractFileByPath(p); return f ? app.vault.read(f) : null; };
		return {
			message, prompted,
			marked: [...document.querySelectorAll('.wzz-explorer-unlocked')].map(el => el.dataset.path),
			files: app.vault.getFiles().map(f => f.path).sort(),
			folders: foldersBelow('Notes'),
			overview: await read('Notes/Overview.md'),
			roadmap: await read('Notes/Projects/Roadmap.md'),
			logbook: await read('Notes/Logbook.md'),
			draft: await read('Notes/Drafts/First Draft.md'),
			daily: await read('Daily.md'),
		};
	`);
	check(!r.prompted, 'Obsidian asked to update links');
	check(!r.files.some(f => f.endsWith(`.${EXT}`) || f.endsWith('.wzzfolder')), 'encrypted files or folder markers left: ' + r.files);
	check(r.files.includes('Notes/Projects/Scan.pdf'), 'attachment not back in its folder: ' + r.files);
	check(JSON.stringify(r.folders) === JSON.stringify(['Notes/Drafts', 'Notes/Projects']), 'folders: ' + r.folders);
	check(r.marked.length === 0, 'explorer still marks decrypted notes or folders as encrypted: ' + r.marked);
	check(r.roadmap === ROADMAP && r.logbook === LOGBOOK && r.draft === 'Just an idea', 'contents differ');
	check(r.overview === OVERVIEW.replace('[[Projects/Roadmap#Costs|the costs]]', '[[Roadmap#Costs|the costs]]') + ADDED, 'Overview:\n' + r.overview);
	check(r.daily.includes('[[Overview]]') && r.daily.includes('Roadmap.md)'), 'Daily links: ' + r.daily);
	return { files: r.files, daily: r.daily.split('\n')[2] };
});

await step('interrupted run is recovered on the next start', async () => {
	const r = await run(`
		// build an envelope with the plugin's own code path: encrypt a note, then rename it back by hand
		const file = await app.vault.create('Notes/Leftover.md', 'Leftover');
		const task = plugin.ops.encryptNotesInteractive([file]);
		const dialog = await waitFor(() => modalTitled('Encrypt note'), 5000, 'password dialog');
		const toggle = dialog.querySelector('.checkbox-container');
		if (toggle && toggle.classList.contains('is-enabled')) toggle.click();
		const inputs = dialog.querySelectorAll('.wzz-password-fields input');
		inputs[0].value = 'x1'; inputs[1].value = 'x1';
		dialog.querySelector('button.mod-cta').click();
		await task;
		await sleep(300);
		document.querySelectorAll('.modal.wzz-modal').forEach(m => lastButton(m)?.click());
		const encrypted = app.vault.getFiles().find(f => f.extension === EXT);
		const envelope = await app.vault.read(encrypted);
		await app.vault.delete(encrypted, true);
		await app.vault.create('Notes/Half done.md', envelope);
		plugin.settings.pending = [{ folder: 'Notes', started: Date.now() }];
		await plugin.ops.recoverPending();
		await sleep(500);
		return { files: app.vault.getFiles().map(f => f.path).sort(), pending: plugin.settings.pending };
	`);
	check(!r.files.includes('Notes/Half done.md'), 'not recovered');
	check(r.files.some(f => new RegExp(`^Notes/[a-z0-9]{12}\\.${EXT}$`).test(f)), `no .${EXT} after recovery`);
	check(r.pending.length === 0, 'journal not cleared');
});

const savedBookmarks = `JSON.parse(await app.vault.adapter.read(app.vault.configDir + '/bookmarks.json')).items`;

// bookmarks as the user set them; the plugin leaves them alone (Obsidian lets them follow renames)
const BOOKMARKS = [
	'folder Marked',
	'folder Marked/Inner Folder',
	'file Marked/Top Note.md',
	'file Marked/Top Note.md#Secret Heading',
	'file Marked/Inner Folder/Deep Note.md [Deep Title]',
];
const bookmarkText = i => `${i.type} ${i.path}${i.subpath ?? ''}${i.title ? ` [${i.title}]` : ''}`;
const ID = '[a-z0-9]{12}';
let inner = ''; // random path of Marked/Inner Folder

await step('encrypting a folder moves and deletes nothing; subfolders get random names', async () => {
	const r = await run(`
		const NL = String.fromCharCode(10);
		await app.vault.createFolder('Marked/Inner Folder/Deeper');
		await app.vault.createFolder('Marked/Empty Folder');
		await app.vault.create('Marked/Top Note.md', '# Secret Heading' + NL + 'text');
		await app.vault.create('Marked/Inner Folder/Deep Note.md', 'deep');
		await app.vault.create('Marked/Inner Folder/Crash Note.md', 'crash');
		await app.vault.createBinary('Marked/Inner Folder/Deeper/Paper.pdf', new TextEncoder().encode('%PDF-1.4 fake').buffer);
		const bookmarks = app.internalPlugins.plugins.bookmarks.instance;
		bookmarks.addItem({ type: 'folder', path: 'Marked' });
		bookmarks.addItem({ type: 'folder', path: 'Marked/Inner Folder' });
		bookmarks.addItem({ type: 'file', path: 'Marked/Top Note.md' });
		bookmarks.addItem({ type: 'file', path: 'Marked/Top Note.md', subpath: '#Secret Heading' });
		bookmarks.addItem({ type: 'file', path: 'Marked/Inner Folder/Deep Note.md', title: 'Deep Title' });
		await sleep(500);
		const task = plugin.ops.encryptFolderInteractive(app.vault.getAbstractFileByPath('Marked'));
		const dialog = await waitFor(() => document.querySelector('.modal.wzz-encrypt-folder-modal'), 5000, 'folder dialog');
		const dialogText = dialog.innerText;
		const toggle = dialog.querySelector('.checkbox-container.is-enabled');
		if (toggle) { toggle.click(); await sleep(200); }
		const inputs = dialog.querySelectorAll('.wzz-password-fields input');
		inputs[0].value = 'bm1'; inputs[1].value = 'bm1';
		dialog.querySelector('button.mod-cta').click();
		await Promise.race([task, sleep(20000)]);
		document.querySelectorAll('.modal.wzz-modal').forEach(m => lastButton(m)?.click());
		await sleep(2000); // Obsidian saves bookmarks with a delay
		const deep = byName('Inner Folder/Deep Note');
		return {
			dialogText,
			files: app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('Marked/')).sort(),
			folders: foldersBelow('Marked'),
			markers: markerFiles(),
			inner: deep?.file.parent.path ?? null,
			display: deep ? plugin.index.displayFolderPath(deep.file.parent) : null,
			saved: ${savedBookmarks},
		};
	`);
	check(r.dialogText.includes('3 subfolders get random names'), 'dialog does not mention the folders: ' + r.dialogText);
	check(r.folders.length === 3 && r.folders.every(f => new RegExp(`^Marked/${ID}(/${ID})?$`).test(f)), 'folders: ' + r.folders);
	check(r.markers.length === 3 && r.folders.every(f => r.markers.includes(`${f}/folder.wzzfolder`)), 'markers: ' + r.markers);
	check(r.files.some(f => new RegExp(`^Marked/${ID}/${ID}/Paper\\.pdf$`).test(f)), 'attachment not kept in its folder: ' + r.files);
	check(!r.files.some(f => /Note|Folder|Deeper/.test(f)), 'readable names left: ' + r.files);
	check(r.inner && new RegExp(`^Marked/${ID}$`).test(r.inner) && r.display === 'Marked/Inner Folder', `inner folder: ${r.inner} shown as ${r.display}`);
	inner = r.inner;
	const notesIn = folder => r.files.filter(f => new RegExp(`^${folder}/${ID}\\.${EXT}$`).test(f)).length;
	check(notesIn('Marked') === 1 && notesIn(inner) === 2, 'notes did not stay in their folders: ' + r.files);
	// Obsidian lets the bookmarks follow the random names; titles and headings stay as they were
	const saved = r.saved.map(bookmarkText);
	const normal = s => s.replace(new RegExp(`Marked/${ID}/${ID}\\.${EXT}|Marked/${ID}\\.${EXT}`), 'NOTE').replace(new RegExp(`^folder Marked/${ID}$`), 'folder FOLDER');
	const expected = BOOKMARKS.map(b => b.replace(/Marked\/(Inner Folder\/)?\w+ Note\.md/, 'NOTE').replace('folder Marked/Inner Folder', 'folder FOLDER'));
	check(JSON.stringify(saved.map(normal)) === JSON.stringify(expected), 'bookmarks: ' + saved);
	check(saved.includes(`folder ${inner}`), 'folder bookmark does not follow: ' + saved);
	return { folders: r.folders, saved };
});

await step('renaming an encrypted folder is undone', async () => {
	const r = await run(`
		const folder = app.vault.getAbstractFileByPath('${inner}');
		clearNotices();
		const renaming = app.fileManager.renameFile(folder, 'Marked/Leak Folder');
		const prompt = await waitFor(linkPrompt, 2000, 'link prompt').catch(() => null);
		prompt?.querySelectorAll('.modal-button-container button')[1]?.click();
		await renaming;
		await waitFor(() => folder.path === '${inner}', 8000, 'guard');
		await sleep(1200);
		return { path: folder.path, notice: renameNotice(), name: plugin.index.folderName(folder), leak: !!app.vault.getAbstractFileByPath('Marked/Leak Folder') };
	`);
	check(r.path === inner && !r.leak, 'folder not back under its random name: ' + r.path);
	check(r.notice, 'no notice shown');
	check(r.name === 'Inner Folder', 'folder name changed: ' + r.name);
});

await step('interrupted folder encryption: notes stay in their folder, readable folder names are hidden again', async () => {
	const r = await run(`
		// crash between writing and renaming a note: the envelope sits in the folder under the real name
		const crashed = byName('Inner Folder/Crash Note');
		const envelope = await app.vault.read(crashed.file);
		await app.vault.delete(crashed.file, true);
		await app.vault.create('${inner}/Crash Note.md', envelope);
		// crash between writing a folder's marker and renaming the folder
		const deeper = app.vault.getAbstractFileByPath('${inner}').children.find(c => c.children);
		await renameUnguarded(deeper, '${inner}/Deeper');
		await app.vault.create('Marked/Not Yet.md', 'not encrypted yet');
		await sleep(500);
		clearNotices();
		plugin.settings.pending = [{ folder: 'Marked', started: Date.now(), kind: 'encrypt-folder' }];
		await plugin.ops.recoverPending();
		await sleep(2000);
		const notices = [...document.querySelectorAll('.notice')].map(n => n.textContent);
		clearNotices();
		const recovered = byName('Inner Folder/Crash Note');
		return {
			files: app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('Marked/')),
			folders: foldersBelow('Marked'),
			deeper: deeper.path,
			deeperName: plugin.index.folderName(deeper),
			recovered: recovered ? recovered.file.path : null,
			pending: plugin.settings.pending,
			notices,
		};
	`);
	check(r.recovered && new RegExp(`^${inner}/${ID}\\.${EXT}$`).test(r.recovered), 'recovered note not in its folder: ' + r.recovered);
	check(new RegExp(`^${inner}/${ID}$`).test(r.deeper) && r.deeperName === 'Deeper', `folder not hidden again: ${r.deeper} (${r.deeperName})`);
	check(r.folders.length === 3, 'folders: ' + r.folders);
	check(r.files.includes('Marked/Not Yet.md'), 'plain note missing: ' + r.files);
	check(r.notices.some(n => n.includes('“Marked” was interrupted')), 'no warning about unencrypted notes: ' + r.notices);
	check(r.pending.length === 0, 'journal not cleared');
	return r.notices;
});

await step('interrupted decryption: restored names are encrypted again', async () => {
	const r = await run(`
		// crash after the folder got its name back and the note its name, before the plaintext was written
		const folder = app.vault.getAbstractFileByPath('${inner}');
		const deep = byName('Inner Folder/Deep Note');
		await renameUnguarded(folder, 'Marked/Inner Folder');
		await renameUnguarded(deep.file, 'Marked/Inner Folder/Deep Note.md');
		await sleep(500);
		clearNotices();
		plugin.settings.pending = [{ folder: 'Marked', started: Date.now(), kind: 'decrypt' }];
		await plugin.ops.recoverPending();
		await sleep(1500);
		const notices = [...document.querySelectorAll('.notice')].map(n => n.textContent);
		clearNotices();
		const recovered = byName('Inner Folder/Deep Note');
		return {
			folder: folder.path,
			recovered: recovered ? recovered.file.path : null,
			files: app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('Marked/')),
			pending: plugin.settings.pending,
			notices,
		};
	`);
	check(new RegExp(`^Marked/${ID}$`).test(r.folder), 'folder name not hidden again: ' + r.folder);
	check(r.recovered && r.recovered.startsWith(r.folder + '/') && r.recovered.endsWith(`.${EXT}`), 'note not back in its folder: ' + r.recovered);
	check(!r.files.some(f => /Note\.md|Inner Folder/.test(f)), 'readable names left: ' + r.files);
	check(r.pending.length === 0, 'journal not cleared');
	inner = r.folder;
	return r.notices;
});

await step('decrypting with a name conflict: that folder stays encrypted, the result says why', async () => {
	const r = await run(`
		await app.vault.createFolder('Marked/Empty Folder');
		await sleep(300);
		const task = plugin.ops.decryptFolderInteractive(app.vault.getAbstractFileByPath('Marked'));
		const confirm = await waitFor(() => modalTitled('Decrypt permanently'), 5000, 'confirm dialog');
		const message = confirm.innerText;
		lastButton(confirm).click();
		await Promise.race([task, sleep(20000)]);
		const report = document.querySelector('.modal.wzz-modal');
		const reportText = report ? [...report.querySelectorAll('li')].map(li => li.textContent) : [];
		document.querySelectorAll('.modal.wzz-modal').forEach(m => lastButton(m)?.click());
		await sleep(500);
		return {
			message, reportText,
			files: app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('Marked/')).sort(),
			folders: foldersBelow('Marked'),
			markers: markerFiles(),
			pending: plugin.settings.pending,
		};
	`);
	check(r.message.includes('Subfolders get their real names back'), 'confirm dialog: ' + r.message);
	check(r.reportText.some(t => t.includes('already contains a folder or file named “Empty Folder”') && t.includes('stays encrypted')), 'no diagnosis: ' + r.reportText);
	const hidden = r.folders.filter(f => new RegExp(`^Marked/${ID}$`).test(f));
	check(hidden.length === 1 && r.markers.length === 1 && r.markers[0] === `${hidden[0]}/folder.wzzfolder`, `encrypted folder: ${hidden} markers ${r.markers}`);
	check(!r.folders.some(f => / 1$/.test(f)) && r.folders.includes('Marked/Empty Folder'), 'folders: ' + r.folders);
	for (const f of ['Marked/Top Note.md', 'Marked/Inner Folder/Deep Note.md', 'Marked/Inner Folder/Crash Note.md', 'Marked/Inner Folder/Deeper/Paper.pdf']) {
		check(r.files.includes(f), `${f} missing: ` + r.files);
	}
	check(r.pending.length === 0, 'journal not cleared');
	return r.reportText;
});

await step('after the conflict is solved, decrypting again restores everything; bookmarks work again', async () => {
	const r = await run(`
		await app.vault.rename(app.vault.getAbstractFileByPath('Marked/Empty Folder'), 'Marked/Other Folder');
		await sleep(300);
		const task = plugin.ops.decryptFolderInteractive(app.vault.getAbstractFileByPath('Marked'));
		const confirm = await waitFor(() => modalTitled('Decrypt permanently'), 5000, 'confirm dialog');
		lastButton(confirm).click();
		await Promise.race([task, sleep(20000)]);
		document.querySelectorAll('.modal.wzz-modal').forEach(m => lastButton(m)?.click());
		await sleep(2000); // Obsidian saves bookmarks with a delay
		const saved = ${savedBookmarks};
		return {
			saved,
			missing: saved.filter(i => i.path && !app.vault.getAbstractFileByPath(i.path)).map(i => i.path),
			folders: foldersBelow('Marked'),
			markers: markerFiles(),
		};
	`);
	check(JSON.stringify(r.folders) === JSON.stringify(['Marked/Empty Folder', 'Marked/Inner Folder', 'Marked/Inner Folder/Deeper', 'Marked/Other Folder']), 'folders: ' + r.folders);
	check(r.markers.length === 0, 'folder markers left: ' + r.markers);
	const saved = r.saved.map(bookmarkText);
	check(JSON.stringify(saved) === JSON.stringify(BOOKMARKS), 'bookmarks differ: ' + saved);
	check(r.missing.length === 0, 'bookmarks point to missing files or folders: ' + r.missing);
	return saved;
});

await step('no errors logged by the plugin', async () => {
	const errors = await run(`return window.__wzzErrors;`);
	check(errors.length === 0, errors.join('\n'));
});

client.close();
console.log(failed === 0 ? '\nall end-to-end steps passed' : `\n${failed} step(s) failed`);
process.exit(failed === 0 ? 0 : 1);
