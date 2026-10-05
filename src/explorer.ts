import { TAbstractFile, TFile, TFolder } from 'obsidian';
import { around } from 'monkey-around';
import { EXT } from './constants';
import type FolderEncryptPlugin from './main';

/** Internal shapes of Obsidian's file explorer (not part of the public API). */
interface ExplorerItem {
	file: TAbstractFile;
	selfEl?: HTMLElement;
	getTitle?: () => string;
	updateTitle?: () => void;
}

interface ExplorerView {
	fileItems?: Record<string, ExplorerItem>;
	startRenameFile?: (file: TAbstractFile) => Promise<void>;
}

/**
 * Shows the real names of unlocked notes and folders in the file explorer. Only the displayed
 * text changes (via the explorer item's `getTitle`); files and folders on disk keep their random
 * names. Renaming such an item (F2) is blocked: encrypted notes and folders cannot be renamed.
 *
 * Everything here relies on Obsidian internals and degrades to "no overlay" if they change.
 */
export class ExplorerOverlay {
	private uninstallers: Array<() => void> = [];
	/** Note items and folder items have different prototypes. */
	private filePatched = false;
	private folderPatched = false;
	private viewPatched = false;
	private enabled = false;

	constructor(private readonly plugin: FolderEncryptPlugin) {}

	enable(): void {
		if (this.enabled) {
			return;
		}
		this.enabled = true;
		this.patch();
		this.refresh();
	}

	disable(): void {
		if (!this.enabled) {
			return;
		}
		this.enabled = false;
		for (const uninstall of this.uninstallers) {
			uninstall();
		}
		this.uninstallers = [];
		this.filePatched = false;
		this.folderPatched = false;
		this.viewPatched = false;
		this.refresh();
	}

	/** Installs the patches once explorer items exist (called on layout and vault changes). */
	patch(): void {
		if (!this.enabled || (this.filePatched && this.folderPatched && this.viewPatched)) {
			return;
		}
		const plugin = this.plugin;
		for (const view of this.views()) {
			if (!this.viewPatched && typeof view.startRenameFile === 'function') {
				this.uninstallers.push(
					around(Object.getPrototypeOf(view) as { startRenameFile: (...args: unknown[]) => Promise<void> }, {
						startRenameFile(next) {
							return function (this: unknown, ...args: unknown[]) {
								const file = args[0];
								if (file instanceof TAbstractFile && plugin.interceptRename(file)) {
									return Promise.resolve();
								}
								return next.apply(this, args);
							};
						},
					}),
				);
				this.viewPatched = true;
			}
			const items = Object.values(view.fileItems ?? {});
			const patchTitle = (item: ExplorerItem) =>
				this.uninstallers.push(
					around(Object.getPrototypeOf(item) as { getTitle: (this: ExplorerItem) => string }, {
						getTitle(next) {
							return function (this: ExplorerItem) {
								return plugin.explorerTitle(this.file) ?? next.call(this);
							};
						},
					}),
				);
			if (!this.filePatched) {
				const item = items.find(i => i?.file instanceof TFile && hasTitle(i));
				if (item) {
					patchTitle(item);
					this.filePatched = true;
				}
			}
			if (!this.folderPatched) {
				const item = items.find(i => i?.file instanceof TFolder && !i.file.isRoot() && hasTitle(i));
				if (item) {
					patchTitle(item);
					this.folderPatched = true;
				}
			}
		}
	}

	/** Re-renders the titles of all encrypted notes and folders. */
	refresh(): void {
		this.patch();
		const index = this.plugin.index;
		for (const view of this.views()) {
			for (const item of Object.values(view.fileItems ?? {})) {
				const file = item?.file;
				let encrypted: boolean;
				if (file instanceof TFile) {
					encrypted = file.extension === EXT;
				} else if (file instanceof TFolder) {
					encrypted = index.isEncryptedFolder(file);
				} else {
					continue;
				}
				// checked for every item: the explorer keeps the item when it is decrypted permanently
				const marked = item.selfEl?.hasClass('wzz-explorer-unlocked') ?? false;
				if (encrypted || marked) {
					try {
						item.updateTitle?.();
					} catch {
						// explorer internals changed; the random name stays visible
					}
				}
				item.selfEl?.toggleClass('wzz-explorer-unlocked', this.enabled && encrypted && this.plugin.explorerTitle(file) != null);
			}
		}
	}

	private views(): ExplorerView[] {
		return this.plugin.app.workspace
			.getLeavesOfType('file-explorer')
			.map(leaf => leaf.view as unknown as ExplorerView);
	}
}

function hasTitle(item: ExplorerItem): boolean {
	return typeof item.getTitle === 'function' && typeof item.updateTitle === 'function';
}
