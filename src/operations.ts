import { FileView, Notice, TAbstractFile, TFile, TFolder, TextFileView, WorkspaceLeaf } from 'obsidian';
import { EXT, FOLDER_MARKER, MELD_EXTENSIONS } from './constants';
import { NameInfo, isOwnEnvelope, parseEnvelope, serializeEnvelope } from './crypto/envelope';
import { meldDecryptText } from './crypto/meld-crypto';
import { openName, openNote, sealFolderName, sealNote } from './crypto/notes';
import { t } from './i18n';
import { DecryptedTarget, LinkSpan, findLinkSpans, rewriteLinksForDecryption, rewriteLinksForEncryption } from './links';
import { isEncryptedNote, isFolderMarker, markerPath } from './name-index';
import { isId, joinVaultPath, leafName, randomId, sanitizeSegment, stripExtension } from './paths';
import { Secret } from './session';
import type { PendingKind } from './settings';
import {
	ConfirmModal,
	EncryptFolderModal,
	NameModal,
	PasswordModal,
	PasswordResult,
	ReportModal,
	ReportSection,
} from './ui/modals';
import { EncryptedNoteView } from './view/note-view';
import type FolderEncryptPlugin from './main';

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Report {
	done: number;
	/** Folders whose names were encrypted or restored. */
	folders: number;
	skipped: string[];
	failed: string[];
	leftFiles: string[];
}

const newReport = (): Report => ({ done: 0, folders: 0, skipped: [], failed: [], leftFiles: [] });
const depth = (path: string) => (path === '/' ? 0 : path.split('/').length);
const isInside = (file: TAbstractFile, folder: TFolder) => folder.isRoot() || file.path.startsWith(folder.path + '/');

/** md = plain note, meld = Meld Encrypt note, finish = `.md` that already holds our envelope (interrupted run). */
type JobKind = 'md' | 'meld' | 'finish';

interface EncryptJob {
	file: TFile;
	kind: JobKind;
	meldPassword?: string;
	/** Random name in the same folder: encrypting never moves notes. */
	targetPath: string;
}

interface FolderScan {
	notes: TFile[];
	meld: TFile[];
	own: TFile[];
	others: TFile[];
}

/**
 * Everything that changes files: encrypting and decrypting notes and folders,
 * creating encrypted notes, and guarding against renames (encrypted notes and folders
 * cannot be renamed).
 *
 * Order of operations is chosen so that an interruption never loses data:
 * encrypting writes the envelope into the note first and renames it afterwards,
 * decrypting renames first and writes the plaintext afterwards. Either way a crash
 * leaves a `.md` file containing an envelope, which `recoverPending()` turns back
 * into an encrypted note. Folders get their marker (the encrypted real name) before
 * they get a random name, and keep it until a decryption is complete; a folder with
 * a marker but a readable name is hidden again by `recoverPending()`.
 *
 * Nothing of the user is ever deleted. The only file removed is a folder's marker,
 * after the folder got its real name back.
 */
export class Operations {
	private running = false;
	/** Target paths of our own renames; the rename guard ignores them. */
	readonly ownRenames = new Set<string>();

	constructor(private readonly plugin: FolderEncryptPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/* ================================================================ encrypt */

	scanFolder(folder: TFolder): FolderScan {
		const scan: FolderScan = { notes: [], meld: [], own: [], others: [] };
		const walk = (current: TFolder) => {
			for (const child of current.children) {
				if (child instanceof TFolder) {
					walk(child);
				} else if (child instanceof TFile) {
					if (child.name === FOLDER_MARKER) {
						continue;
					}
					if (child.extension === 'md') {
						scan.notes.push(child);
					} else if (MELD_EXTENSIONS.includes(child.extension)) {
						scan.meld.push(child);
					} else if (child.extension === EXT) {
						scan.own.push(child);
					} else {
						scan.others.push(child);
					}
				}
			}
		};
		walk(folder);
		const byPath = (a: TFile, b: TFile) => a.path.localeCompare(b.path);
		scan.notes.sort(byPath);
		scan.meld.sort(byPath);
		scan.others.sort(byPath);
		return scan;
	}

	/** Subfolders of `root` whose names are not encrypted yet, inner ones first. */
	plainSubFolders(root: TFolder): TFolder[] {
		const found: TFolder[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					walk(child);
					if (!this.plugin.index.isEncryptedFolder(child)) {
						found.push(child);
					}
				}
			}
		};
		walk(root);
		return found;
	}

	async encryptFolderInteractive(folder: TFolder): Promise<void> {
		if (this.busyNotice() || folder.isRoot()) {
			return;
		}
		const scan = this.scanFolder(folder);
		const folderCount = this.plainSubFolders(folder).length;
		if (scan.notes.length + scan.meld.length + folderCount === 0) {
			new Notice(t('efNothing'));
			return;
		}
		const index = this.plugin.index;
		const folderPath = index.displayFolderPath(folder);
		const choice = await new EncryptFolderModal(this.app, {
			folderPath,
			label: file => {
				const path = joinVaultPath(file.parent ? index.displayFolderPath(file.parent) : '', file.name);
				return path.startsWith(`${folderPath}/`) ? path.slice(folderPath.length + 1) : path;
			},
			notes: scan.notes,
			meld: scan.meld,
			ownCount: scan.own.length,
			folderCount,
			others: scan.others,
			sessionSecret: this.plugin.session.secretsList[0] ?? null,
			confirm: this.plugin.settings.confirmPassword,
			updateLinks: this.plugin.settings.updateLinks,
		}).openAndWait();
		if (choice == null) {
			return;
		}
		const secret = this.secretFrom(choice.password);
		if (secret == null) {
			return;
		}
		await this.runExclusive(async () => {
			const prepared = await this.prepareJobs(choice.files, secret);
			if (prepared == null) {
				return;
			}
			const report = await this.encryptJobs(folder, prepared.jobs, secret, 'encrypt-folder', this.plainSubFolders(folder));
			report.skipped.push(...prepared.skipped);
			report.failed.push(...prepared.failed);
			report.leftFiles.push(...scan.others.map(f => f.path));
			await this.finishEncryption(secret, report);
		});
	}

	/** Encrypts single notes in place; folder names stay as they are. */
	async encryptNotesInteractive(files: TFile[]): Promise<void> {
		if (this.busyNotice()) {
			return;
		}
		const eligible = files.filter(f => f.extension === 'md' || MELD_EXTENSIONS.includes(f.extension));
		if (eligible.length === 0) {
			return;
		}
		const result = await new PasswordModal(this.app, {
			title: eligible.length === 1 ? t('menuEncryptNote') : t('menuEncryptSelected', { n: eligible.length }),
			mode: 'new',
			confirm: this.plugin.settings.confirmPassword,
			askHint: true,
			sessionSecret: this.plugin.session.secretsList[0] ?? null,
			submitText: t('btnEncrypt'),
		}).openAndWait();
		const secret = result == null ? null : this.secretFrom(result);
		if (secret == null) {
			return;
		}
		await this.runExclusive(async () => {
			const total = newReport();
			const byFolder = new Map<TFolder, TFile[]>();
			for (const file of eligible) {
				const parent = file.parent ?? this.app.vault.getRoot();
				byFolder.set(parent, [...(byFolder.get(parent) ?? []), file]);
			}
			for (const [folder, group] of byFolder) {
				const prepared = await this.prepareJobs(group, secret);
				if (prepared == null) {
					break; // cancelled; keep what is done
				}
				const report = await this.encryptJobs(folder, prepared.jobs, secret, 'encrypt-notes');
				total.done += report.done;
				total.skipped.push(...prepared.skipped, ...report.skipped);
				total.failed.push(...prepared.failed, ...report.failed);
			}
			await this.finishEncryption(secret, total);
		});
	}

	private secretFrom(result: PasswordResult): Secret | null {
		if (result.kind === 'session') {
			return result.secret;
		}
		if (result.kind === 'password') {
			const known = this.plugin.session.find(result.password);
			if (known) {
				if (result.hint) {
					known.hint = result.hint;
				}
				return known;
			}
			return new Secret(result.password, result.hint);
		}
		return null;
	}

	private async finishEncryption(secret: Secret, report: Report): Promise<void> {
		if (report.done + report.folders > 0) {
			this.plugin.session.add(secret);
		}
		await this.plugin.index.refreshAll();
		const summary = report.folders > 0 ? t('nEncryptedFolders', { n: report.done, f: report.folders }) : t('nEncrypted', { n: report.done });
		this.showReport(summary, report, true);
	}

	/** Reads the files, asks for Meld passwords where needed and assigns random target names. */
	private async prepareJobs(files: TFile[], secret: Secret): Promise<{ jobs: EncryptJob[]; skipped: string[]; failed: string[] } | null> {
		const jobs: EncryptJob[] = [];
		const skipped: string[] = [];
		const failed: string[] = [];
		const reserved = new Set<string>();
		const meldPasswords: string[] = [secret.password];

		for (const file of files) {
			let kind: JobKind = 'md';
			let meldPassword: string | undefined;
			try {
				const text = await this.app.vault.read(file);
				const envelope = parseEnvelope(text);
				if (file.extension === 'md') {
					kind = isOwnEnvelope(envelope) ? 'finish' : 'md';
				} else {
					kind = 'meld';
					if (envelope == null) {
						failed.push(`${file.path}: ${t('errNotEnvelope')}`);
						continue;
					}
					for (const candidate of meldPasswords) {
						if ((await meldDecryptText(envelope.version, envelope.encodedData, candidate)) != null) {
							meldPassword = candidate;
							break;
						}
					}
					if (meldPassword == null) {
						const answer = await new PasswordModal(this.app, {
							title: t('pwTitleFile', { name: file.basename }),
							mode: 'unlock',
							message: t('pwMeldFile', { name: file.basename }),
							hints: [envelope.hint],
							allowSkip: true,
							validate: async pw => (await meldDecryptText(envelope.version, envelope.encodedData, pw)) != null,
						}).openAndWait();
						if (answer == null) {
							return null; // cancelled everything
						}
						if (answer.kind !== 'password') {
							skipped.push(file.path);
							continue;
						}
						meldPassword = answer.password;
						meldPasswords.push(answer.password);
					}
				}
			} catch (error) {
				failed.push(`${file.path}: ${errorText(error)}`);
				continue;
			}
			const targetPath = await this.uniqueIdPath(file.parent ?? this.app.vault.getRoot(), reserved);
			reserved.add(targetPath);
			jobs.push({ file, kind, meldPassword, targetPath });
		}
		return { jobs, skipped, failed };
	}

	/**
	 * Encrypts the notes in place, then hides the names of `folders` (subfolders of `root`, inner
	 * ones first). `root` keeps its path during the run, so the journal can name it.
	 */
	private async encryptJobs(
		root: TFolder,
		jobs: EncryptJob[],
		secret: Secret,
		kind: 'encrypt-folder' | 'encrypt-notes',
		folders: TFolder[] = [],
	): Promise<Report> {
		const report = newReport();
		if (jobs.length + folders.length === 0) {
			return report;
		}
		await this.addPending(root.path, kind);
		const progress = new Notice(t('nProgressEncrypt', { i: 0, n: jobs.length }), 0);
		let halfDone = false;
		try {
			await this.closeViewsOf(jobs.map(j => j.file));

			// 1. build and verify all envelopes in memory
			const newNameByPath = new Map(jobs.map(j => [j.file.path, leafName(j.targetPath)]));
			const prepared: Array<{ job: EncryptJob; envelopeText: string; original: string }> = [];
			for (const job of jobs) {
				try {
					const original = await this.app.vault.read(job.file);
					if (job.kind === 'finish') {
						prepared.push({ job, envelopeText: original, original });
						continue;
					}
					let content: string;
					if (job.kind === 'meld') {
						const meld = parseEnvelope(original);
						const text = meld && job.meldPassword != null ? await meldDecryptText(meld.version, meld.encodedData, job.meldPassword) : null;
						if (text == null) {
							throw new Error(t('errWrongPassword'));
						}
						content = text;
					} else {
						content = this.rewriteLinksOut(job.file, original, newNameByPath) ?? original;
					}
					const name: NameInfo = { path: job.file.basename, ext: 'md' };
					const envelope = await sealNote(secret, content, name, secret.hint);
					const check = await openNote([secret], envelope);
					if (check == null || check.content !== content || check.name.path !== name.path) {
						throw new Error(t('errVerify'));
					}
					prepared.push({ job, envelopeText: serializeEnvelope(envelope), original });
				} catch (error) {
					report.failed.push(`${job.file.path}: ${errorText(error)}`);
				}
			}

			// 2. overwrite the notes with their envelopes (no renames yet, so Obsidian's
			//    link updater cannot touch notes of this batch in between)
			const written: typeof prepared = [];
			for (const item of prepared) {
				if (item.envelopeText === item.original) {
					written.push(item);
					continue;
				}
				try {
					await this.app.vault.modify(item.job.file, item.envelopeText);
					if ((await this.app.vault.read(item.job.file)) !== item.envelopeText) {
						throw new Error(t('errVerify'));
					}
					written.push(item);
				} catch (error) {
					try {
						await this.app.vault.modify(item.job.file, item.original);
					} catch {
						// keep the error below
					}
					report.failed.push(`${item.job.file.path}: ${errorText(error)}`);
				}
			}

			// 3. give them their random names (Obsidian updates links in other notes)
			let i = 0;
			for (const item of written) {
				progress.setMessage(t('nProgressEncrypt', { i: ++i, n: written.length }));
				const originalPath = item.job.file.path;
				try {
					await this.renameVerified(item.job.file, item.job.targetPath);
					report.done++;
				} catch (error) {
					// the note is encrypted but still has its readable name; recoverPending() fixes it
					halfDone = true;
					report.failed.push(`${originalPath}: ${errorText(error)}`);
				}
			}

			// 4. hide the folder names: marker first, random name afterwards
			for (const folder of folders) {
				const originalPath = folder.path;
				try {
					await this.hideFolderName(folder, secret);
					report.folders++;
				} catch (error) {
					// a marker in place while the name is still readable is fixed by recoverPending()
					halfDone ||= this.plugin.index.isEncryptedFolder(folder);
					report.failed.push(`${originalPath}: ${errorText(error)}`);
				}
			}
		} finally {
			progress.hide();
			if (!halfDone) {
				await this.removePending(root.path);
			}
		}
		return report;
	}

	/** Points links to notes of this batch to their new random file names. */
	private rewriteLinksOut(file: TFile, content: string, newNameByPath: Map<string, string>): string | null {
		const resolve = (linkpath: string) => {
			const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			return dest ? newNameByPath.get(dest.path) ?? null : null;
		};
		const cache = this.app.metadataCache.getFileCache(file);
		const spans: LinkSpan[] = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map(ref => ({
			start: ref.position.start.offset,
			end: ref.position.end.offset,
			original: ref.original,
			link: ref.link,
		}));
		// the metadata cache may lag behind a note that was saved a moment ago
		const result = rewriteLinksForEncryption(content, spans, resolve) ?? rewriteLinksForEncryption(content, findLinkSpans(content), resolve);
		return result && result.changed > 0 ? result.text : null;
	}

	/** Stores the folder's real name encrypted in a marker inside it, then gives the folder a random name. */
	private async hideFolderName(folder: TFolder, secret: Secret): Promise<void> {
		const name = folder.name;
		const envelope = await sealFolderName(secret, name, secret.hint);
		if ((await openName(secret, envelope))?.path !== name) {
			throw new Error(t('errVerify'));
		}
		const text = serializeEnvelope(envelope);
		const marker = await this.app.vault.create(markerPath(folder), text);
		if ((await this.app.vault.read(marker)) !== text) {
			// our own file from a moment ago, holding nothing but a broken copy of the name
			await this.app.fileManager.trashFile(marker);
			throw new Error(t('errVerify'));
		}
		await this.renameVerified(folder, await this.uniqueFolderPath(folder.parent ?? this.app.vault.getRoot()));
	}

	/* ================================================================ decrypt */

	ownFilesIn(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		const walk = (current: TFolder) => {
			for (const child of current.children) {
				if (child instanceof TFolder) {
					walk(child);
				} else if (isEncryptedNote(child)) {
					files.push(child);
				}
			}
		};
		walk(folder);
		return files;
	}

	/** Markers of the encrypted folders inside `folder`, including its own. */
	markersIn(folder: TFolder): TFile[] {
		const markers: TFile[] = [];
		const walk = (current: TFolder) => {
			for (const child of current.children) {
				if (child instanceof TFolder) {
					walk(child);
				} else if (isFolderMarker(child)) {
					markers.push(child);
				}
			}
		};
		walk(folder);
		return markers;
	}

	async decryptFolderInteractive(folder: TFolder): Promise<void> {
		const files = this.ownFilesIn(folder);
		const markers = this.markersIn(folder);
		if (files.length + markers.length === 0) {
			new Notice(t('nNothingToDecrypt'));
			return;
		}
		await this.decryptInteractive(files, markers, folder);
	}

	async decryptNoteInteractive(file: TFile): Promise<void> {
		await this.decryptInteractive([file], [], null);
	}

	private async decryptInteractive(files: TFile[], markers: TFile[], folder: TFolder | null): Promise<void> {
		if (this.busyNotice()) {
			return;
		}
		const index = this.plugin.index;
		const all = [...files, ...markers];
		for (const file of all) {
			await index.refreshFile(file);
		}
		const isLocked = (f: TFile) => index.entryOf(f)?.state !== 'unlocked';
		if (all.some(isLocked)) {
			await this.plugin.promptUnlock(all.filter(isLocked));
		}
		const stillLocked = all.filter(isLocked).length;
		if (folder == null && stillLocked > 0) {
			return;
		}
		const messages =
			folder == null
				? [t('decNoteMsg', { name: index.displayName(files[0]) ?? files[0].basename })]
				: [t('decFolderMsg', { n: files.length, folder: index.displayFolderPath(folder) || this.app.vault.getName() })];
		if (markers.length > 0) {
			messages.push(t('decFolderNames'));
		}
		if (stillLocked > 0) {
			messages.push(t('decLockedHint', { n: stillLocked }));
		}
		const ok = await new ConfirmModal(this.app, t('decTitle'), messages, t('btnDecrypt'), true).openAndWait();
		if (!ok) {
			return;
		}
		await this.runExclusive(async () => {
			const report = await this.decryptFiles(files, markers);
			await index.refreshAll();
			const summary = report.folders > 0 ? t('nDecryptedFolders', { n: report.done, f: report.folders }) : t('nDecrypted', { n: report.done });
			this.showReport(summary, report, false);
		});
	}

	private async decryptFiles(files: TFile[], markers: TFile[]): Promise<Report> {
		const report = newReport();
		const index = this.plugin.index;
		const root = this.app.vault.getRoot();
		// the journal names folders that keep their path during the run
		const opFolders = [...new Set([...files, ...markers].map(f => index.rootOf(f).path))];
		for (const folder of opFolders) {
			await this.addPending(folder, 'decrypt');
		}
		const progress = new Notice(t('nProgressDecrypt', { i: 0, n: files.length }), 0);
		let halfDone = false;
		try {
			await this.closeViewsOf(files);

			// 1. decrypt the notes into memory
			const opened: Array<{ file: TFile; id: string; content: string; name: NameInfo }> = [];
			for (const file of files) {
				const entry = index.get(file);
				if (entry?.state !== 'unlocked' || entry.secret == null) {
					report.skipped.push(`${file.path} (${t('errLocked')})`);
					continue;
				}
				try {
					const envelope = parseEnvelope(await this.app.vault.read(file));
					if (!isOwnEnvelope(envelope)) {
						throw new Error(t('errNotEnvelope'));
					}
					const note = await openNote([entry.secret, ...this.plugin.session.secretsList], envelope);
					if (note == null) {
						throw new Error(t('errWrongPassword'));
					}
					opened.push({ file, id: file.basename, content: note.content, name: note.name });
				} catch (error) {
					report.failed.push(`${file.path}: ${errorText(error)}`);
				}
			}

			// 2. give the folders their real names back, outer ones first. A folder that cannot get
			//    its name stays encrypted with everything in it. The markers stay until the end.
			const blocked: TFolder[] = [];
			const restored: TFile[] = [];
			const folders = markers
				.flatMap(marker => (marker.parent instanceof TFolder ? [{ marker, folder: marker.parent }] : []))
				.sort((a, b) => depth(a.folder.path) - depth(b.folder.path));
			for (const { marker, folder } of folders) {
				if (blocked.some(b => isInside(folder, b))) {
					continue;
				}
				const label = index.displayFolderPath(folder);
				const entry = index.entryOf(marker);
				if (entry?.state !== 'unlocked' || typeof entry.name !== 'string') {
					report.skipped.push(`${label} (${t('errLocked')})`);
					blocked.push(folder);
					continue;
				}
				let renaming = false;
				try {
					const parent = folder.parent ?? root;
					const name = sanitizeSegment(entry.name);
					if (folder.name !== name) {
						const target = joinVaultPath(parent.path, name);
						const taken =
							parent.children.some(c => c !== folder && c.name.toLowerCase() === name.toLowerCase()) ||
							(await this.app.vault.adapter.exists(target));
						if (taken) {
							throw new Error(t('errNameTaken', { name, folder: index.displayFolderPath(parent) || this.app.vault.getName() }));
						}
						renaming = true;
						await this.renameVerified(folder, target);
					}
					restored.push(marker);
					report.folders++;
				} catch (error) {
					// a rename that may have happened after all is undone by recoverPending()
					halfDone ||= renaming;
					report.failed.push(`${label}: ${errorText(error)}`);
					blocked.push(folder);
				}
			}

			// 3. restore the real names of the notes (content is still encrypted at this point)
			const moved: typeof opened = [];
			const reserved = new Set<string>();
			for (const item of opened) {
				if (blocked.some(b => isInside(item.file, b))) {
					continue;
				}
				try {
					const target = await this.targetPathFor(item.file.parent ?? root, item.name, reserved);
					reserved.add(target.toLowerCase());
					await this.ensureFolder(target.slice(0, Math.max(0, target.lastIndexOf('/'))));
					await this.renameVerified(item.file, target);
					moved.push(item);
				} catch (error) {
					report.failed.push(`${item.file.path}: ${errorText(error)}`);
				}
			}

			// 4. write the plaintext; links between the decrypted notes become normal links again
			const fileById = new Map(moved.map(m => [m.id, m.file]));
			let i = 0;
			for (const item of moved) {
				progress.setMessage(t('nProgressDecrypt', { i: ++i, n: moved.length }));
				try {
					const { text } = rewriteLinksForDecryption(item.content, id => {
						const target = fileById.get(id);
						return target ? this.decryptedTarget(target, item.file.path) : null;
					});
					await this.app.vault.modify(item.file, text);
					if ((await this.app.vault.read(item.file)) !== text) {
						throw new Error(t('errVerify'));
					}
					report.done++;
				} catch (error) {
					// still encrypted, but with its readable name; recoverPending() re-encrypts the name
					halfDone = true;
					report.failed.push(`${item.file.path}: ${errorText(error)}`);
				}
			}

			// 5. the restored folders do not need their markers any more. After a failure they stay,
			//    so recoverPending() knows which folders the notes belong to.
			if (!halfDone) {
				for (const marker of restored) {
					try {
						await this.app.fileManager.trashFile(marker);
					} catch (error) {
						report.failed.push(`${marker.path}: ${errorText(error)}`);
					}
				}
			}
		} finally {
			progress.hide();
			if (!halfDone) {
				for (const folder of opFolders) {
					await this.removePending(folder);
				}
			}
		}
		return report;
	}

	private decryptedTarget(file: TFile, sourcePath: string): DecryptedTarget {
		const cache = this.app.metadataCache;
		return {
			linktext: cache.fileToLinktext(file, sourcePath, true),
			mdPath: cache.fileToLinktext(file, sourcePath, false),
			plainNames: [file.basename, stripExtension(file.path)],
		};
	}

	private async targetPathFor(folder: TFolder, name: NameInfo, reserved: Set<string>): Promise<string> {
		const segments = name.path.split('/').filter(s => s.length > 0).map(sanitizeSegment);
		const base = segments.pop() ?? 'Untitled';
		const dir = joinVaultPath(folder.path, ...segments);
		const ext = name.ext || 'md';
		let candidate = joinVaultPath(dir, `${base}.${ext}`);
		for (let n = 1; (await this.app.vault.adapter.exists(candidate)) || reserved.has(candidate.toLowerCase()); n++) {
			candidate = joinVaultPath(dir, `${base} ${n}.${ext}`);
		}
		return candidate;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (path === '' || path === '/') {
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			return;
		}
		if (existing) {
			throw new Error(`${path} is a file`);
		}
		const slash = path.lastIndexOf('/');
		await this.ensureFolder(slash < 0 ? '' : path.slice(0, slash));
		await this.app.vault.createFolder(path);
	}

	/* ================================================================ create, delete */

	async newNoteInteractive(folder?: TFolder): Promise<void> {
		const target = folder ?? this.defaultFolder();
		const path = await new NameModal(this.app, t('nameTitleNew'), '', t('btnCreate')).openAndWait();
		if (path == null) {
			return;
		}
		const secret = await this.plugin.secretForNewNote(target);
		if (secret == null) {
			return;
		}
		try {
			const name: NameInfo = { path, ext: 'md' };
			const envelope = await sealNote(secret, '', name, secret.hint);
			const file = await this.app.vault.create(await this.uniqueIdPath(target), serializeEnvelope(envelope));
			this.plugin.index.setName(file, name, secret, secret.hint);
			await this.app.workspace.getLeaf('tab').openFile(file);
		} catch (error) {
			new Notice(t('nCreateFailed', { error: errorText(error) }));
		}
	}

	private defaultFolder(): TFolder {
		const active = this.app.workspace.getActiveFile();
		return this.app.fileManager.getNewFileParent(active?.path ?? '');
	}

	async deleteInteractive(file: TFile): Promise<void> {
		const name = this.plugin.index.displayName(file) ?? file.basename;
		const ok = await new ConfirmModal(this.app, t('delTitle'), [t('delMsg', { name })], t('btnDelete'), true).openAndWait();
		if (ok) {
			await this.closeViewsOf([file]);
			await this.app.fileManager.trashFile(file);
		}
	}

	/* ================================================================ guards */

	/**
	 * Called for every rename in the vault. Makes sure encrypted notes and folders keep a
	 * random name and encrypted notes do not silently become `.md` files.
	 */
	async guardRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (this.ownRenames.has(file.path)) {
			return;
		}
		if (file instanceof TFolder) {
			await this.guardFolderRename(file, oldPath);
			return;
		}
		if (!(file instanceof TFile)) {
			return;
		}
		const oldName = oldPath.slice(oldPath.lastIndexOf('/') + 1);
		const oldBase = stripExtension(oldName);
		const folder = file.parent ?? this.app.vault.getRoot();
		// back to the previous random name if it is free, otherwise a new one
		const idTarget = async () => {
			const previous = joinVaultPath(folder.path, `${oldBase}.${EXT}`);
			return isId(oldBase) && !(await this.app.vault.adapter.exists(previous)) ? previous : this.uniqueIdPath(folder);
		};

		if (file.extension === EXT && !isId(file.basename)) {
			new Notice(t('nRenameDisabled'));
			await this.renameVerified(file, await idTarget());
			return;
		}

		if (file.extension === 'md' && oldName.endsWith(`.${EXT}`)) {
			const text = await this.app.vault.read(file);
			if (isOwnEnvelope(parseEnvelope(text))) {
				new Notice(t('nMdRenameBlocked'));
				await this.renameVerified(file, await idTarget());
			}
		}
	}

	private async guardFolderRename(folder: TFolder, oldPath: string): Promise<void> {
		if (!this.plugin.index.isEncryptedFolder(folder) || isId(folder.name)) {
			return;
		}
		new Notice(t('nFolderRenameDisabled'));
		const parent = folder.parent ?? this.app.vault.getRoot();
		const oldName = leafName(oldPath);
		const previous = joinVaultPath(parent.path, oldName);
		const target = isId(oldName) && !(await this.app.vault.adapter.exists(previous)) ? previous : await this.uniqueFolderPath(parent);
		await this.renameVerified(folder, target);
	}

	/** A `.wzzcrypt` file with a readable name appeared (copied in, synced, ...): give it a random name. */
	async guardCreate(file: TAbstractFile): Promise<void> {
		if (!isEncryptedNote(file) || isId(file.basename) || this.ownRenames.has(file.path)) {
			return;
		}
		const text = await this.app.vault.read(file);
		if (isOwnEnvelope(parseEnvelope(text))) {
			await this.renameVerified(file, await this.uniqueIdPath(file.parent ?? this.app.vault.getRoot()));
		}
	}

	/** Finishes operations that were interrupted (e.g. Obsidian was closed mid-way). */
	async recoverPending(): Promise<void> {
		// deepest folders first, so an outer folder never picks up the notes of an inner operation
		const pending = [...this.plugin.settings.pending].sort((a, b) => depth(b.folder) - depth(a.folder));
		if (pending.length === 0) {
			return;
		}
		let fixed = 0;
		const interrupted: string[] = [];
		for (const op of pending) {
			const folder = op.folder === '/' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(op.folder);
			if (!(folder instanceof TFolder)) {
				continue;
			}
			// notes that hold an envelope but have a readable name
			for (const file of this.scanFolder(folder).notes) {
				try {
					if (isOwnEnvelope(parseEnvelope(await this.app.vault.read(file)))) {
						await this.renameVerified(file, await this.uniqueIdPath(this.recoveryFolder(file, folder, op.kind)));
						fixed++;
					}
				} catch (error) {
					console.error('Folder Encrypt: recovery failed for a file', error);
				}
			}
			// folders that hold a marker but have a readable name
			for (const sub of this.subFolders(folder)) {
				if (!this.plugin.index.isEncryptedFolder(sub) || isId(sub.name)) {
					continue;
				}
				try {
					await this.renameVerified(sub, await this.uniqueFolderPath(sub.parent ?? this.app.vault.getRoot()));
					fixed++;
				} catch (error) {
					console.error('Folder Encrypt: recovery failed for a folder', error);
				}
			}
			if (op.kind === 'encrypt-folder' || op.kind === 'encrypt-notes') {
				// notes that were not written yet are still plain
				interrupted.push(folder.isRoot() ? this.app.vault.getName() : folder.path);
			}
		}
		this.plugin.settings.pending = [];
		await this.plugin.saveSettings();
		if (interrupted.length > 0) {
			new Notice(t('nInterruptedEncrypt', { folder: interrupted.join(', ') }), 0);
		} else if (fixed > 0) {
			new Notice(t('nRecovered', { n: fixed }));
		}
		if (fixed > 0 || interrupted.length > 0) {
			await this.plugin.index.refreshAll();
		}
	}

	/**
	 * The folder an interrupted note belongs to, i.e. the folder its encrypted name is relative to.
	 * Encrypting never moves notes. Decrypting moves notes of older versions (whose names contain
	 * subfolders) out of their folder, but never out of an encrypted folder. Journal entries of
	 * older versions have no kind; those versions kept the notes in the folder of the operation.
	 */
	private recoveryFolder(file: TFile, opFolder: TFolder, kind: PendingKind | undefined): TFolder {
		if (kind === 'encrypt-folder' || kind === 'encrypt-notes') {
			return file.parent ?? opFolder;
		}
		if (kind === 'decrypt') {
			let folder = file.parent;
			while (folder && folder !== opFolder && !this.plugin.index.isEncryptedFolder(folder)) {
				folder = folder.parent;
			}
			return folder ?? opFolder;
		}
		return opFolder;
	}

	/** All folders below `root`, inner ones first. */
	private subFolders(root: TFolder): TFolder[] {
		const found: TFolder[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					walk(child);
					found.push(child);
				}
			}
		};
		walk(root);
		return found;
	}

	/* ================================================================ helpers */

	private busyNotice(): boolean {
		if (this.running) {
			new Notice(t('nBusy'));
		}
		return this.running;
	}

	private async runExclusive(task: () => Promise<void>): Promise<void> {
		if (this.busyNotice()) {
			return;
		}
		this.running = true;
		try {
			await task();
		} catch (error) {
			console.error('Folder Encrypt:', error);
			new Notice(t('nFailed', { error: errorText(error) }));
		} finally {
			this.running = false;
		}
	}

	/** Saves and closes every view that shows one of the files. */
	async closeViewsOf(files: TFile[]): Promise<void> {
		const wanted = new Set(files);
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view;
			if (view instanceof FileView && view.file && wanted.has(view.file)) {
				leaves.push(leaf);
			}
		});
		for (const leaf of leaves) {
			const view = leaf.view;
			try {
				if (view instanceof EncryptedNoteView) {
					await view.closeSafely();
					continue;
				}
				if (view instanceof TextFileView) {
					await view.save();
				}
			} catch (error) {
				console.error('Folder Encrypt: could not save before closing', error);
			}
			leaf.detach();
		}
		if (leaves.length > 0) {
			await sleep(100);
		}
	}

	/**
	 * Renames and waits until the rename really happened. With "update links" on, Obsidian
	 * rewrites links in other notes without asking once per file (see `forcesLinkUpdates`).
	 */
	private async renameVerified(file: TAbstractFile, target: string): Promise<void> {
		this.ownRenames.add(target);
		const updateLinks = this.plugin.settings.updateLinks;
		if (updateLinks) {
			this.linkUpdateRequests++;
		}
		try {
			if (updateLinks) {
				await this.app.fileManager.renameFile(file, target);
			} else {
				await this.app.vault.rename(file, target);
			}
			// renameFile may return before the rename happened when other link updates are queued
			for (let i = 0; i < 60 && file.path !== target; i++) {
				await sleep(50);
			}
			if (file.path !== target) {
				throw new Error(`rename to ${target} did not complete`);
			}
		} finally {
			window.setTimeout(() => {
				this.ownRenames.delete(target);
				if (updateLinks) {
					this.linkUpdateRequests--;
				}
			}, 1000);
		}
	}

	private linkUpdateRequests = 0;

	/** True while one of our renames runs; the plugin then answers Obsidian's "update links?" with yes. */
	get forcesLinkUpdates(): boolean {
		return this.linkUpdateRequests > 0;
	}

	async uniqueIdPath(folder: TFolder, reserved?: Set<string>): Promise<string> {
		for (;;) {
			const candidate = joinVaultPath(folder.path, `${randomId()}.${EXT}`);
			if (!reserved?.has(candidate) && !(await this.app.vault.adapter.exists(candidate))) {
				return candidate;
			}
		}
	}

	/** A free random folder name in `parent`. */
	private async uniqueFolderPath(parent: TFolder): Promise<string> {
		for (;;) {
			const candidate = joinVaultPath(parent.path, randomId());
			if (!(await this.app.vault.adapter.exists(candidate))) {
				return candidate;
			}
		}
	}

	private async addPending(folder: string, kind: PendingKind): Promise<void> {
		this.plugin.settings.pending.push({ folder, started: Date.now(), kind });
		await this.plugin.saveSettings();
	}

	private async removePending(folder: string): Promise<void> {
		const list = this.plugin.settings.pending;
		const idx = list.findIndex(p => p.folder === folder);
		if (idx >= 0) {
			list.splice(idx, 1);
			await this.plugin.saveSettings();
		}
	}

	private showReport(summary: string, report: Report, encrypting: boolean): void {
		const extra: string[] = [];
		if (report.skipped.length > 0) {
			extra.push(`${t('repSkipped')}: ${report.skipped.length}`);
		}
		if (report.failed.length > 0) {
			extra.push(`${t('repFailed')}: ${report.failed.length}`);
		}
		new Notice([summary, ...extra].join(' · '), 6000);

		const sections: ReportSection[] = [
			{ title: t('repFailed'), items: report.failed, warning: true },
			{ title: t('repSkipped'), items: report.skipped },
			{ title: t('repLeftFiles'), items: report.leftFiles, warning: true },
		];
		const needsDetails = sections.some(s => s.items.length > 0);
		if (needsDetails || (encrypting && report.done > 0)) {
			new ReportModal(this.app, summary, sections, encrypting && report.done > 0 ? t('repNotePlaintext') : undefined).open();
		}
	}
}
