import { Menu, MenuItem, Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, setTooltip } from 'obsidian';
import { around } from 'monkey-around';
import { EXT, FOLDER_MARKER, ICON_NOTE, ICON_PANEL, MELD_EXTENSIONS, VIEW_TYPE_NOTE, VIEW_TYPE_PANEL } from './constants';
import { Envelope, isOwnEnvelope, parseEnvelope } from './crypto/envelope';
import { payloadSaltKey } from './crypto/meld-crypto';
import { openName } from './crypto/notes';
import { ExplorerOverlay } from './explorer';
import { t } from './i18n';
import { NameIndex, isEncryptedNote, isFolderMarker } from './name-index';
import { Operations } from './operations';
import { leafName } from './paths';
import { Secret, Session } from './session';
import { DEFAULT_SETTINGS, FolderEncryptSettingTab, FolderEncryptSettings } from './settings';
import { NoteSuggestModal, PasswordModal } from './ui/modals';
import { PanelView } from './ui/panel';
import { EncryptedNoteView } from './view/note-view';

interface MenuAction {
	title: string;
	icon: string;
	run: () => void;
}

/** Obsidian's menu items can open a submenu (internal API). */
type SubmenuItem = MenuItem & { setSubmenu: () => Menu };

export default class FolderEncryptPlugin extends Plugin {
	override settings!: FolderEncryptSettings;
	session!: Session;
	index!: NameIndex;
	ops!: Operations;
	explorer!: ExplorerOverlay;
	private statusEl!: HTMLElement;

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.session = new Session(() => this.settings.autoLockMinutes);
		this.index = new NameIndex(this.app, this.session);
		this.ops = new Operations(this);
		this.explorer = new ExplorerOverlay(this);

		this.registerView(VIEW_TYPE_NOTE, leaf => new EncryptedNoteView(leaf, this));
		this.registerExtensions([EXT], VIEW_TYPE_NOTE);
		this.registerView(VIEW_TYPE_PANEL, leaf => new PanelView(leaf, this));

		this.addRibbonIcon(ICON_PANEL, t('ribbonOpenPanel'), () => void this.activatePanel());

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('wzz-status', 'mod-clickable');
		this.statusEl.addEventListener('click', () => void this.lockAll());
		this.updateStatus();

		this.addCommands();
		this.registerMenus();
		this.patchRenamePrompt();
		this.patchLinkUpdateConfig();
		this.addSettingTab(new FolderEncryptSettingTab(this.app, this));

		this.registerEvent(this.session.on('change', () => this.updateStatus()));
		this.registerEvent(this.index.on('changed', () => this.explorer.refresh()));
		this.registerEvent(
			this.app.workspace.on('editor-change', (_editor, info) => {
				if (info instanceof EncryptedNoteView) {
					this.session.touch();
				}
			}),
		);
		this.registerInterval(
			window.setInterval(() => {
				if (this.session.isAutoLockDue()) {
					void this.lockAll();
				}
				this.updateStatus();
			}, 15_000),
		);

		this.app.workspace.onLayoutReady(async () => {
			this.registerVaultEvents();
			this.registerEvent(this.app.workspace.on('layout-change', () => this.explorer.patch()));
			await this.index.refreshAll();
			this.applyExplorerSetting();
			await this.ops.recoverPending();
		});
	}

	override onunload(): void {
		for (const view of this.noteViews()) {
			void view.closeSafely();
		}
		this.explorer.disable();
		this.session.clear();
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<FolderEncryptSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...data, pending: [...(data.pending ?? [])] };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	applyExplorerSetting(): void {
		if (this.settings.explorerNames) {
			this.explorer.enable();
		} else {
			this.explorer.disable();
		}
	}

	/* ------------------------------------------------------------------ session */

	/**
	 * Asks for a password and unlocks every note and folder it fits. The password is checked
	 * against the given (or all) locked notes and folder markers before the dialog closes.
	 */
	async promptUnlock(files?: TFile[]): Promise<boolean> {
		const entries = [];
		for (const file of files ?? [...this.index.files(), ...this.index.markers()]) {
			entries.push(this.index.entryOf(file) ?? (await this.index.refreshFile(file)));
		}
		const locked = entries.filter(e => e.state === 'locked');
		if (locked.length === 0) {
			return entries.some(e => e.state === 'unlocked');
		}
		// one sample per salt: each distinct salt costs one slow key derivation
		const samples: Envelope[] = [];
		const salts = new Set<string>();
		for (const entry of locked) {
			const envelope = parseEnvelope(await this.app.vault.cachedRead(entry.file));
			if (!isOwnEnvelope(envelope)) {
				continue;
			}
			const salt = payloadSaltKey(envelope.encodedName) ?? entry.file.path;
			if (!salts.has(salt)) {
				salts.add(salt);
				samples.push(envelope);
			}
			if (samples.length >= 8) {
				break;
			}
		}
		const unlocked = await this.askPassword(samples, t('pwTitleUnlock'));
		if (!unlocked) {
			return false;
		}
		await this.index.refreshAll();
		new Notice(t('nUnlocked', { n: this.index.all().filter(e => e.state === 'unlocked').length }));
		return true;
	}

	/** Used by the note view when a locked note is opened. */
	async promptUnlockFor(envelope: Envelope): Promise<boolean> {
		const unlocked = await this.askPassword([envelope], t('pwTitleUnlock'));
		if (unlocked) {
			void this.index.refreshAll();
		}
		return unlocked;
	}

	private async askPassword(samples: Envelope[], title: string): Promise<boolean> {
		const found: { secret: Secret | null } = { secret: null };
		const result = await new PasswordModal(this.app, {
			title,
			mode: 'unlock',
			hints: samples.map(s => s.hint),
			validate: async password => {
				const secret = this.session.find(password) ?? new Secret(password, '');
				for (const envelope of samples) {
					if (await openName(secret, envelope)) {
						if (!secret.hint) {
							secret.hint = envelope.hint;
						}
						found.secret = secret;
						return true;
					}
				}
				return false;
			},
		}).openAndWait();
		if (result?.kind !== 'password' || found.secret == null) {
			return false;
		}
		this.session.add(found.secret);
		return true;
	}

	/**
	 * Password for a new note in `folder`: the one of its siblings or of the encrypted folder,
	 * the current one, or a new one.
	 */
	async secretForNewNote(folder: TFolder): Promise<Secret | null> {
		const sibling = () => {
			const own = this.index.folderEntry(folder);
			const note = this.index.all().find(e => e.state === 'unlocked' && e.secret && e.file.parent === folder);
			return note?.secret ?? (own?.state === 'unlocked' ? own.secret : undefined);
		};
		const known = sibling();
		if (known) {
			return known;
		}
		const lockedSiblings = [...this.index.all(), this.index.folderEntry(folder)].filter(
			e => e != null && e.state === 'locked' && e.file.parent === folder,
		);
		if (lockedSiblings.length > 0 && (await this.promptUnlock(lockedSiblings.map(e => e!.file)))) {
			const unlocked = sibling();
			if (unlocked) {
				return unlocked;
			}
		}
		const result = await new PasswordModal(this.app, {
			title: t('pwTitleNew'),
			mode: 'new',
			confirm: this.settings.confirmPassword,
			askHint: true,
			sessionSecret: this.session.secretsList[0] ?? null,
		}).openAndWait();
		if (result == null || result.kind === 'skip') {
			return null;
		}
		if (result.kind === 'session') {
			return result.secret;
		}
		return this.session.add(this.session.find(result.password) ?? new Secret(result.password, result.hint));
	}

	/** Saves and closes all encrypted notes, then forgets all passwords and names. */
	async lockAll(): Promise<void> {
		for (const view of this.noteViews()) {
			try {
				await view.closeSafely();
			} catch (error) {
				console.error('Folder Encrypt: could not save before locking', error);
			}
		}
		const wasUnlocked = this.session.isUnlocked;
		this.session.clear();
		this.index.forgetNames();
		this.explorer.refresh();
		if (wasUnlocked) {
			new Notice(t('nLocked'));
		}
	}

	private noteViews(): EncryptedNoteView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_NOTE)
			.map(leaf => leaf.view)
			.filter((view): view is EncryptedNoteView => view instanceof EncryptedNoteView);
	}

	private updateStatus(): void {
		const unlocked = this.session.isUnlocked;
		this.statusEl.toggle(unlocked);
		if (unlocked) {
			this.statusEl.setText(t('statusUnlocked'));
			const minutes = this.session.minutesUntilAutoLock();
			setTooltip(this.statusEl, minutes == null ? t('statusTooltip') : t('statusAutoLock', { min: minutes }), { placement: 'top' });
		}
	}

	/* ------------------------------------------------------------------ explorer integration */

	/** Title shown in the file explorer for an unlocked note or folder, or null to keep the file name. */
	explorerTitle(file: TAbstractFile): string | null {
		if (!this.settings.explorerNames) {
			return null;
		}
		if (file instanceof TFolder) {
			return this.index.isEncryptedFolder(file) ? this.index.folderName(file) : null;
		}
		if (!isEncryptedNote(file)) {
			return null;
		}
		// notes of older versions may have subfolders in their name
		const path = this.index.namePath(file);
		return path == null ? null : path.split('/').join(' / ');
	}

	/** Encrypted notes and folders cannot be renamed; Obsidian's rename prompts are blocked for them. */
	interceptRename(file: TAbstractFile): boolean {
		if (isEncryptedNote(file)) {
			new Notice(t('nRenameDisabled'));
			return true;
		}
		if (file instanceof TFolder && this.index.isEncryptedFolder(file)) {
			new Notice(t('nFolderRenameDisabled'));
			return true;
		}
		return false;
	}

	/**
	 * Obsidian asks "Update internal links?" for every renamed file unless "Always update
	 * internal links" is on. During our own bulk renames we answer "yes" in memory instead
	 * of prompting once per note (the setting itself is not changed).
	 */
	private patchLinkUpdateConfig(): void {
		const vault = this.app.vault as unknown as Record<string, unknown>;
		if (typeof vault.getConfig !== 'function') {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;
		this.register(
			around(vault as { getConfig: (key: string) => unknown }, {
				getConfig(next) {
					return function (this: unknown, key: string) {
						if (key === 'alwaysUpdateLinks' && plugin.ops.forcesLinkUpdates) {
							return true;
						}
						return next.call(this, key);
					};
				},
			}),
		);
	}

	private patchRenamePrompt(): void {
		const fileManager = this.app.fileManager as unknown as Record<string, unknown>;
		if (typeof fileManager.promptForFileRename !== 'function') {
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;
		this.register(
			around(fileManager as { promptForFileRename: (...args: unknown[]) => unknown }, {
				promptForFileRename(next) {
					return function (this: unknown, file: unknown, ...rest: unknown[]) {
						if (file instanceof TAbstractFile && plugin.interceptRename(file)) {
							return Promise.resolve();
						}
						return next.call(this, file, ...rest);
					};
				},
			}),
		);
	}

	revealInExplorer(file: TFile): void {
		const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
		const view = leaf?.view as unknown as { revealInFolder?: (file: TFile) => void } | undefined;
		if (leaf && typeof view?.revealInFolder === 'function') {
			void this.app.workspace.revealLeaf(leaf);
			view.revealInFolder(file);
		}
	}

	async activatePanel(): Promise<void> {
		let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_PANEL)[0] ?? null;
		if (leaf == null) {
			leaf = this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_PANEL, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private async openNoteSwitcher(): Promise<void> {
		let entries = this.index.all().filter(e => e.state === 'unlocked');
		if (entries.length === 0 && this.index.all().some(e => e.state === 'locked')) {
			if (!(await this.promptUnlock())) {
				return;
			}
			entries = this.index.all().filter(e => e.state === 'unlocked');
		}
		new NoteSuggestModal(this.app, this.index, entries, entry => {
			this.session.touch();
			void this.app.workspace.getLeaf(false).openFile(entry.file);
		}).open();
	}

	/* ------------------------------------------------------------------ vault events */

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on('create', file => {
				if (isEncryptedNote(file)) {
					void this.index.refreshFile(file);
					void this.ops.guardCreate(file);
				} else if (isFolderMarker(file)) {
					void this.index.refreshFile(file);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('modify', file => {
				if (isEncryptedNote(file) || isFolderMarker(file)) {
					void this.index.refreshFile(file);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', file => {
				if (isEncryptedNote(file) || isFolderMarker(file)) {
					this.index.remove(file.path);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFolder) {
					void this.ops.guardRename(file, oldPath);
					return;
				}
				if (!(file instanceof TFile)) {
					return;
				}
				// a renamed folder also renames the files inside it, its marker included
				const tracked = (path: string, ext: string) => path.endsWith(`.${EXT}`) || leafName(path) === FOLDER_MARKER || ext === EXT;
				if (tracked(file.path, file.extension) || tracked(oldPath, '')) {
					const moved = this.index.rename(file, oldPath);
					if (!moved && (isEncryptedNote(file) || isFolderMarker(file))) {
						void this.index.refreshFile(file);
					}
				}
				void this.ops.guardRename(file, oldPath);
			}),
		);
	}

	/* ------------------------------------------------------------------ commands & menus */

	private addCommands(): void {
		const activeFile = () => this.app.workspace.getActiveFile();

		this.addCommand({ id: 'unlock', name: t('cmdUnlock'), icon: 'key-round', callback: () => void this.promptUnlock() });
		this.addCommand({ id: 'lock', name: t('cmdLock'), icon: 'lock', callback: () => void this.lockAll() });
		this.addCommand({ id: 'open-panel', name: t('cmdOpenPanel'), icon: ICON_PANEL, callback: () => void this.activatePanel() });
		this.addCommand({ id: 'open-note', name: t('cmdOpenNote'), icon: 'search', callback: () => void this.openNoteSwitcher() });
		this.addCommand({ id: 'new-note', name: t('cmdNewNote'), icon: ICON_NOTE, callback: () => void this.ops.newNoteInteractive() });

		this.addCommand({
			id: 'encrypt-note',
			name: t('cmdEncryptNote'),
			icon: ICON_NOTE,
			checkCallback: checking => {
				const file = activeFile();
				const ok = file != null && (file.extension === 'md' || MELD_EXTENSIONS.includes(file.extension));
				if (ok && !checking && file) {
					void this.ops.encryptNotesInteractive([file]);
				}
				return ok;
			},
		});
		this.addCommand({
			id: 'encrypt-folder',
			name: t('cmdEncryptFolder'),
			icon: 'folder-lock',
			checkCallback: checking => {
				const folder = activeFile()?.parent;
				const ok = folder != null && !folder.isRoot();
				if (ok && !checking && folder) {
					void this.ops.encryptFolderInteractive(folder);
				}
				return ok;
			},
		});
		this.addCommand({
			id: 'decrypt-note',
			name: t('cmdDecryptNote'),
			icon: 'lock-open',
			checkCallback: checking => {
				const file = activeFile();
				const ok = isEncryptedNote(file);
				if (ok && !checking && file) {
					void this.ops.decryptNoteInteractive(file);
				}
				return ok;
			},
		});
	}

	private registerMenus(): void {
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const actions = this.fileActions(file);
				if (actions.length > 0) {
					this.addPluginMenu(menu, [...actions, null, ...this.generalActions([file])]);
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files) => {
				const notes = files.filter((f): f is TFile => f instanceof TFile && (f.extension === 'md' || MELD_EXTENSIONS.includes(f.extension)));
				if (notes.length > 0) {
					const title = notes.length === 1 ? t('menuEncryptNote') : t('menuEncryptSelected', { n: notes.length });
					const encrypt = { title, icon: ICON_NOTE, run: () => void this.ops.encryptNotesInteractive(notes) };
					this.addPluginMenu(menu, [encrypt, null, ...this.generalActions(files)]);
				}
			}),
		);
	}

	/** What can be done with this file or folder; empty for files the plugin does not handle. */
	private fileActions(file: TAbstractFile): MenuAction[] {
		if (file instanceof TFolder) {
			const actions: MenuAction[] = [{ title: t('menuNewNote'), icon: ICON_NOTE, run: () => void this.ops.newNoteInteractive(file) }];
			if (!file.isRoot()) {
				actions.push({ title: t('menuEncryptFolder'), icon: 'folder-lock', run: () => void this.ops.encryptFolderInteractive(file) });
			}
			if (this.ops.ownFilesIn(file).length + this.ops.markersIn(file).length > 0) {
				actions.push({ title: t('menuDecryptFolder'), icon: 'lock-open', run: () => void this.ops.decryptFolderInteractive(file) });
			}
			return actions;
		}
		if (!(file instanceof TFile)) {
			return [];
		}
		if (file.extension === 'md') {
			return [{ title: t('menuEncryptNote'), icon: ICON_NOTE, run: () => void this.ops.encryptNotesInteractive([file]) }];
		}
		if (MELD_EXTENSIONS.includes(file.extension)) {
			return [{ title: t('menuConvertMeld'), icon: ICON_NOTE, run: () => void this.ops.encryptNotesInteractive([file]) }];
		}
		if (file.extension === EXT) {
			return [{ title: t('menuDecryptNote'), icon: 'lock-open', run: () => void this.ops.decryptNoteInteractive(file) }];
		}
		return [];
	}

	/**
	 * Unlock and lock – only for encrypted notes and folders that contain some – and the panel,
	 * which is offered in every menu of the plugin.
	 */
	private generalActions(targets: TAbstractFile[]): MenuAction[] {
		const actions: MenuAction[] = [];
		const encrypted = targets.flatMap(f =>
			f instanceof TFolder ? [...this.ops.ownFilesIn(f), ...this.ops.markersIn(f)] : isEncryptedNote(f) ? [f] : [],
		);
		if (encrypted.length > 0) {
			if (encrypted.some(f => this.index.entryOf(f)?.state === 'locked')) {
				actions.push({ title: t('menuUnlock'), icon: 'key-round', run: () => void this.promptUnlock() });
			}
			if (this.session.isUnlocked) {
				actions.push({ title: t('menuLock'), icon: 'lock', run: () => void this.lockAll() });
			}
		}
		actions.push({ title: t('menuOpenPanel'), icon: ICON_PANEL, run: () => void this.activatePanel() });
		return actions;
	}

	/**
	 * Adds a single entry to the file menu whose submenu lists all actions (null = separator).
	 * Submenus are not part of Obsidian's public API; without them the actions are listed directly.
	 */
	private addPluginMenu(menu: Menu, actions: Array<MenuAction | null>): void {
		const submenu = this.createSubmenu(menu);
		for (const action of actions) {
			if (action == null) {
				submenu?.addSeparator();
				continue;
			}
			(submenu ?? menu).addItem(item => {
				item.setTitle(action.title).setIcon(action.icon).onClick(action.run);
				if (submenu == null) {
					item.setSection('action');
				}
			});
		}
	}

	private createSubmenu(menu: Menu): Menu | null {
		if (typeof (MenuItem.prototype as Partial<SubmenuItem>).setSubmenu !== 'function') {
			return null;
		}
		let submenu: Menu | null = null;
		menu.addItem(item => {
			item.setTitle(t('menuRoot')).setIcon(ICON_PANEL).setSection('action');
			submenu = (item as SubmenuItem).setSubmenu();
		});
		return submenu;
	}
}
