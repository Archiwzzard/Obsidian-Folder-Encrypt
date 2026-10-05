import { MarkdownView, Notice, TFile, TFolder, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { around } from 'monkey-around';
import { EXT, FORMAT, ICON_NOTE, VIEW_TYPE_NOTE } from '../constants';
import { Envelope, isOwnEnvelope, parseEnvelope, serializeEnvelope } from '../crypto/envelope';
import { openNote, sealContent } from '../crypto/notes';
import { t } from '../i18n';
import { leafName } from '../paths';
import type FolderEncryptPlugin from '../main';
import type { Secret } from '../session';

/**
 * Markdown editor for `.wzzcrypt` notes. The note is decrypted into memory when it is opened
 * and encrypted again before every save, so plaintext never reaches the disk.
 *
 * The save handling is adapted from Meld Encrypt's EncryptedMarkdownView
 * (https://github.com/meld-cp/obsidian-encrypt, MIT License).
 *
 * The real name is only written into the DOM (tab, header, inline title), as are the real names
 * of encrypted folders in the header's folder path. `getDisplayText()`
 * keeps returning the random file name, because Obsidian stores that text in workspace.json.
 */
export class EncryptedNoteView extends MarkdownView {
	private secret: Secret | null = null;
	private envelope: Envelope | null = null;
	private namePath: string | null = null;
	private cachedPlain = '';
	private encodedForSave: string | null = null;
	private isSavingEnabled = false;
	private isLoadingFile = false;
	private isSaving = false;
	private saveQueued = false;
	private inFlightSave: Promise<void> | null = null;
	private unpatchHeader: (() => void) | null = null;

	override allowNoFile = false;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: FolderEncryptPlugin) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE_NOTE;
	}

	override canAcceptExtension(extension: string): boolean {
		return extension === EXT;
	}

	override getIcon(): string {
		return ICON_NOTE;
	}

	/** Virtual path (real name incl. virtual folders) of the open note. */
	get realPath(): string | null {
		return this.namePath;
	}

	get realName(): string | null {
		return this.namePath == null ? null : leafName(this.namePath);
	}

	protected override async onOpen(): Promise<void> {
		await super.onOpen();
		this.containerEl.addClass('wzz-note-view');
		this.addAction('lock', t('menuLock'), () => {
			void this.plugin.lockAll();
		});
		this.patchLeafHeader();
		// folder names may be unlocked after the note
		this.registerEvent(this.plugin.index.on('changed', () => this.applyFolderNames()));
	}

	protected override async onClose(): Promise<void> {
		this.unpatchHeader?.();
		this.unpatchHeader = null;
		await super.onClose();
	}

	override async onLoadFile(file: TFile): Promise<void> {
		this.setBusy(true);
		try {
			this.secret = null;
			this.envelope = null;
			this.namePath = null;
			this.isSavingEnabled = false;
			this.setPlainViewData('', true);

			if (!this.app.workspace.layoutReady) {
				// do not ask for passwords while Obsidian restores the workspace
				this.leaf.detach();
				return;
			}

			const envelope = parseEnvelope(await this.app.vault.read(file));
			if (!isOwnEnvelope(envelope)) {
				new Notice(t('nInvalidFile'));
				this.leaf.detach();
				return;
			}

			let opened = await openNote(this.plugin.session.secretsList, envelope);
			if (opened == null) {
				if (this.isInPopover() || !(await this.plugin.promptUnlockFor(envelope))) {
					this.leaf.detach();
					return;
				}
				opened = await openNote(this.plugin.session.secretsList, envelope);
				if (opened == null) {
					new Notice(t('nDamaged'));
					this.leaf.detach();
					return;
				}
			}

			this.secret = opened.secret;
			this.envelope = envelope;
			this.namePath = opened.name.path;
			this.plugin.session.touch();
			this.setPlainViewData(opened.content, false);

			this.isLoadingFile = true;
			try {
				await super.onLoadFile(file);
			} finally {
				this.isLoadingFile = false;
				this.isSavingEnabled = true;
			}
			this.applyTitles();
		} finally {
			this.setBusy(false);
		}
	}

	override async onUnloadFile(file: TFile): Promise<void> {
		if (this.secret == null || this.envelope == null) {
			return; // nothing was decrypted, nothing to save
		}
		if (this.inFlightSave) {
			try {
				await this.inFlightSave;
			} catch {
				// reported by save()
			}
		}
		await super.onUnloadFile(file);
	}

	override async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.applyTitles(true);
	}

	private getPlainViewData(): string {
		return super.getViewData();
	}

	private setPlainViewData(data: string, clear: boolean): void {
		this.cachedPlain = data;
		super.setViewData(data, clear);
	}

	override getViewData(): string {
		if (this.isSaving) {
			if (this.encodedForSave == null) {
				// never hand out plaintext while Obsidian writes the file
				throw new Error('Folder Encrypt: encrypted data missing during save');
			}
			return this.encodedForSave;
		}
		return this.getPlainViewData();
	}

	override setViewData(data: string, clear: boolean): void {
		if (this.file == null || this.isLoadingFile) {
			return;
		}
		const envelope = parseEnvelope(data);
		if (envelope == null) {
			// plain markdown, e.g. set by another plugin; cachedPlain stays so the change gets saved
			super.setViewData(data, clear);
			return;
		}
		// the encrypted file changed on disk (sync, rename of the encrypted name, ...)
		void this.reloadFrom(envelope, clear);
	}

	private async reloadFrom(envelope: Envelope, clear: boolean): Promise<void> {
		const secrets = this.secret ? [this.secret, ...this.plugin.session.secretsList] : this.plugin.session.secretsList;
		const opened = isOwnEnvelope(envelope) ? await openNote(secrets, envelope) : null;
		if (opened == null) {
			this.isSavingEnabled = false; // do not overwrite what we cannot read
			this.leaf.detach();
			return;
		}
		this.secret = opened.secret;
		this.envelope = envelope;
		this.namePath = opened.name.path;
		if (opened.content !== this.getPlainViewData()) {
			this.setPlainViewData(opened.content, clear);
		} else {
			this.cachedPlain = opened.content;
		}
		this.applyTitles();
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		// MarkdownView may reload `this.data` (the encrypted JSON) while switching modes,
		// so save pending edits first and put the plaintext back afterwards.
		if (this.secret != null) {
			await this.save();
		}
		this.isSavingEnabled = false;
		try {
			await super.setState(state, result);
			super.setViewData(this.cachedPlain, false);
		} finally {
			this.isSavingEnabled = this.secret != null;
		}
		this.applyTitles();
	}

	override async save(clear?: boolean): Promise<void> {
		if (this.isSaving) {
			this.saveQueued = true;
			return;
		}
		this.isSaving = true;
		this.setBusy(true);
		const run = this.doSave(clear);
		this.inFlightSave = run;
		try {
			await run;
		} catch (error) {
			console.error('Folder Encrypt: saving failed', error);
			new Notice(t('nFailed', { error: String(error) }));
		} finally {
			this.encodedForSave = null;
			this.inFlightSave = null;
			this.isSaving = false;
			this.setBusy(false);
		}
		if (this.saveQueued) {
			this.saveQueued = false;
			this.requestSave();
		}
	}

	private async doSave(clear?: boolean): Promise<void> {
		const file = this.file;
		if (file == null || file.extension !== EXT || !this.isSavingEnabled || this.secret == null || this.envelope == null) {
			return;
		}
		const plain = this.getPlainViewData();
		if (parseEnvelope(plain) != null) {
			return; // never encrypt an envelope a second time
		}
		if (plain === this.cachedPlain) {
			return;
		}

		// keep the encrypted name and hint that are on disk (sync may have changed the file meanwhile)
		let encodedName = this.envelope.encodedName;
		let hint = this.envelope.hint;
		const onDisk = parseEnvelope(await this.app.vault.read(file));
		if (isOwnEnvelope(onDisk)) {
			encodedName = onDisk.encodedName;
			hint = onDisk.hint;
		}

		const envelope: Envelope = {
			version: this.envelope.version,
			hint,
			format: FORMAT,
			encodedName,
			encodedData: await sealContent(this.secret, plain),
		};
		this.encodedForSave = serializeEnvelope(envelope);
		await super.save(clear);
		this.envelope = envelope;
		this.cachedPlain = plain;
		this.plugin.session.touch();
	}

	/** Saves and closes the view, used when locking. */
	async closeSafely(): Promise<void> {
		try {
			await this.save();
		} finally {
			this.isSavingEnabled = false;
			this.leaf.detach();
		}
	}

	/**
	 * Obsidian calls this (internal API) when the header title or the inline title was edited.
	 * Encrypted notes cannot be renamed: the edit is undone and nothing changes on disk.
	 * (The titles are not editable anyway, see applyTitles.)
	 */
	async saveTitle(el: HTMLElement): Promise<boolean> {
		const self = this as unknown as { fileBeingRenamed: TFile | null };
		const edited = this.file != null && self.fileBeingRenamed === this.file;
		self.fileBeingRenamed = null;
		const typed = (el.textContent ?? '').trim();
		if (edited && this.realName != null && typed !== this.realName) {
			new Notice(t('nRenameDisabled'));
		}
		this.applyTitles(true);
		return true;
	}

	/** Writes the real name into tab, header and inline title (DOM only) and keeps the titles read-only. */
	applyTitles(force = false): void {
		const internals = this as unknown as { titleEl?: HTMLElement; inlineTitleEl?: HTMLElement };
		for (const el of [internals.titleEl, internals.inlineTitleEl]) {
			if (el?.isContentEditable) {
				el.contentEditable = 'false';
			}
		}
		const name = this.realName;
		if (name == null) {
			return;
		}
		for (const el of [internals.titleEl, internals.inlineTitleEl]) {
			if (el && el.textContent !== name && (force || el.ownerDocument.activeElement !== el)) {
				el.setText(name);
			}
		}
		const tab = (this.leaf as unknown as { tabHeaderInnerTitleEl?: HTMLElement }).tabHeaderInnerTitleEl;
		if (tab && tab.textContent !== name) {
			tab.setText(name);
		}
		this.applyFolderNames();
	}

	/** Writes the real names of encrypted folders into the header's folder path (DOM only). */
	private applyFolderNames(): void {
		const parentEl = (this as unknown as { titleParentEl?: HTMLElement }).titleParentEl;
		if (parentEl == null || this.file == null) {
			return;
		}
		const crumbs = Array.from(parentEl.querySelectorAll<HTMLElement>('.view-header-breadcrumb'));
		const folders: TFolder[] = [];
		for (let folder = this.file.parent; folder && !folder.isRoot(); folder = folder.parent) {
			folders.unshift(folder);
		}
		if (crumbs.length !== folders.length) {
			return; // Obsidian changed how the path is shown
		}
		const index = this.plugin.index;
		folders.forEach((folder, i) => {
			if (!index.isEncryptedFolder(folder)) {
				return;
			}
			const name = index.folderName(folder) ?? folder.name;
			if (crumbs[i].textContent !== name) {
				crumbs[i].setText(name);
			}
			if (crumbs[i].hasAttribute('aria-label')) {
				crumbs[i].setAttribute('aria-label', name);
			}
		});
	}

	private patchLeafHeader(): void {
		const leaf = this.leaf as unknown as Record<string, unknown>;
		if (this.unpatchHeader || typeof leaf.updateHeader !== 'function') {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const view = this;
		this.unpatchHeader = around(leaf as { updateHeader: (...args: unknown[]) => unknown }, {
			updateHeader(next) {
				return function (this: unknown, ...args: unknown[]) {
					const result = next.apply(this, args);
					if (view.leaf.view === view) {
						view.applyTitles();
					}
					return result;
				};
			},
		});
	}

	private isInPopover(): boolean {
		return this.containerEl.closest('.popover, .hover-popover') != null;
	}

	private setBusy(busy: boolean): void {
		this.contentEl.style.cursor = busy ? 'wait' : '';
	}
}
