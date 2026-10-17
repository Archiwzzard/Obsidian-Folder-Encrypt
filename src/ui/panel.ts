import { ItemView, Keymap, Menu, TFile, TFolder, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import { ICON_NOTE, ICON_PANEL, VIEW_TYPE_PANEL } from '../constants';
import { t } from '../i18n';
import type { Entry } from '../name-index';
import type FolderEncryptPlugin from '../main';

interface TreeNode {
	folders: Map<string, TreeNode>;
	notes: Array<{ name: string; entry: Entry }>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Side panel that lists all encrypted notes with their real names (while unlocked),
 * grouped by the folder the encryption was started from and by the real names of the
 * encrypted folders in between.
 * Nothing shown here is persisted.
 */
export class PanelView extends ItemView {
	private collapsed = new Set<string>();
	private renderQueued = false;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: FolderEncryptPlugin) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE_PANEL;
	}

	override getDisplayText(): string {
		return t('panelTitle');
	}

	override getIcon(): string {
		return ICON_PANEL;
	}

	protected override async onOpen(): Promise<void> {
		this.contentEl.addClass('wzz-panel');
		this.registerEvent(this.plugin.index.on('changed', () => this.requestRender()));
		this.registerEvent(this.plugin.session.on('change', () => {
			if (!this.plugin.session.isUnlocked) {
				this.collapsed.clear();
			}
			this.requestRender();
		}));
		this.registerEvent(this.app.workspace.on('file-open', () => this.requestRender()));
		this.registerInterval(window.setInterval(() => this.requestRender(), 30_000));
		this.render();
	}

	protected override async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	requestRender(): void {
		if (this.renderQueued) {
			return;
		}
		this.renderQueued = true;
		window.requestAnimationFrame(() => {
			this.renderQueued = false;
			this.render();
		});
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		this.renderHeader(root.createDiv('wzz-panel-header'));

		const entries = this.plugin.index.all().filter(e => e.state !== 'invalid');
		if (entries.length === 0) {
			root.createDiv({ cls: 'wzz-panel-empty', text: t('panelEmpty') });
			return;
		}

		const byFolder = new Map<string, Entry[]>();
		for (const entry of entries) {
			const folder = this.plugin.index.rootOf(entry.file).path;
			byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
		}
		const tree = root.createDiv('wzz-tree');
		for (const folderPath of [...byFolder.keys()].sort((a, b) => collator.compare(a, b))) {
			this.renderFolderGroup(tree, folderPath, byFolder.get(folderPath) ?? []);
		}
	}

	private renderHeader(header: HTMLElement): void {
		const session = this.plugin.session;
		const status = header.createDiv('wzz-panel-status');
		const icon = status.createSpan('wzz-panel-status-icon');
		setIcon(icon, session.isUnlocked ? 'lock-open' : 'lock');
		let text = session.isUnlocked ? t('panelUnlocked') : t('panelLocked');
		const minutes = session.minutesUntilAutoLock();
		if (minutes != null) {
			text += ` · ${t('panelAutoLock', { min: minutes })}`;
		}
		status.createSpan({ text });

		const actions = header.createDiv('wzz-panel-actions');
		const button = (iconId: string, tooltip: string, onClick: () => void) => {
			const el = actions.createDiv('clickable-icon');
			setIcon(el, iconId);
			setTooltip(el, tooltip);
			el.addEventListener('click', onClick);
		};
		if (session.isUnlocked) {
			button('lock', t('menuLock'), () => void this.plugin.lockAll());
		} else {
			button('key-round', t('menuUnlock'), () => void this.plugin.promptUnlock());
		}
		button('file-plus-2', t('menuNewNote'), () => void this.plugin.ops.newNoteInteractive());
	}

	private renderFolderGroup(parent: HTMLElement, folderPath: string, entries: Entry[]): void {
		const key = `folder:${folderPath}`;
		const group = parent.createDiv('tree-item wzz-group');
		const self = group.createDiv('tree-item-self is-clickable mod-collapsible wzz-group-title');
		const collapseIcon = self.createDiv('tree-item-icon collapse-icon');
		setIcon(collapseIcon, 'right-triangle');
		const titleIcon = self.createDiv('wzz-row-icon');
		setIcon(titleIcon, 'folder-lock');
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		const label = folder instanceof TFolder && !folder.isRoot() ? this.plugin.index.displayFolderPath(folder) : this.app.vault.getName();
		self.createDiv({ cls: 'tree-item-inner', text: label });
		self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(entries.length) });

		const children = group.createDiv('tree-item-children');
		const isCollapsed = this.collapsed.has(key);
		group.toggleClass('is-collapsed', isCollapsed);
		children.toggle(!isCollapsed);
		self.addEventListener('click', () => this.toggle(key));
		self.addEventListener('contextmenu', evt => this.folderMenu(evt, folderPath));

		const unlocked = entries.filter(e => e.state === 'unlocked' && e.name);
		const locked = entries.filter(e => e.state !== 'unlocked');

		const tree: TreeNode = { folders: new Map(), notes: [] };
		for (const entry of unlocked) {
			const segments = (this.plugin.index.displayPath(entry.file) ?? entry.file.basename).split('/');
			const name = segments.pop() ?? entry.file.basename;
			let node = tree;
			for (const segment of segments) {
				let next = node.folders.get(segment);
				if (next == null) {
					next = { folders: new Map(), notes: [] };
					node.folders.set(segment, next);
				}
				node = next;
			}
			node.notes.push({ name, entry });
		}
		this.renderNode(children, tree, key);

		if (locked.length > 0) {
			const row = children.createDiv('tree-item-self is-clickable wzz-locked-row');
			setIcon(row.createDiv('wzz-row-icon'), 'lock');
			const text = this.plugin.session.isUnlocked && unlocked.length > 0
				? `${t('panelOtherPassword')} (${locked.length})`
				: t('panelLockedCount', { n: locked.length });
			row.createDiv({ cls: 'tree-item-inner', text });
			row.addEventListener('click', () => void this.plugin.promptUnlock(locked.map(e => e.file)));
		}
	}

	private renderNode(parent: HTMLElement, node: TreeNode, keyPrefix: string): void {
		for (const name of [...node.folders.keys()].sort((a, b) => collator.compare(a, b))) {
			const child = node.folders.get(name);
			if (child == null) {
				continue;
			}
			const key = `${keyPrefix}/${name}`;
			const item = parent.createDiv('tree-item');
			const self = item.createDiv('tree-item-self is-clickable mod-collapsible');
			setIcon(self.createDiv('tree-item-icon collapse-icon'), 'right-triangle');
			self.createDiv({ cls: 'tree-item-inner', text: name });
			const children = item.createDiv('tree-item-children');
			const isCollapsed = this.collapsed.has(key);
			item.toggleClass('is-collapsed', isCollapsed);
			children.toggle(!isCollapsed);
			self.addEventListener('click', () => this.toggle(key));
			this.renderNode(children, child, key);
		}

		const active = this.app.workspace.getActiveFile();
		for (const { name, entry } of [...node.notes].sort((a, b) => collator.compare(a.name, b.name))) {
			const row = parent.createDiv('tree-item-self is-clickable wzz-note-row');
			row.toggleClass('is-active', entry.file === active);
			setIcon(row.createDiv('wzz-row-icon'), ICON_NOTE);
			row.createDiv({ cls: 'tree-item-inner', text: name });
			row.addEventListener('click', evt => void this.openNote(entry.file, Keymap.isModEvent(evt)));
			row.addEventListener('auxclick', evt => {
				if (evt.button === 1) {
					void this.openNote(entry.file, 'tab');
				}
			});
			row.addEventListener('contextmenu', evt => this.noteMenu(evt, entry.file));
		}
	}

	private toggle(key: string): void {
		if (this.collapsed.has(key)) {
			this.collapsed.delete(key);
		} else {
			this.collapsed.add(key);
		}
		this.requestRender();
	}

	/** Not named `open`: that is the internal method Obsidian calls to show a view. */
	private async openNote(file: TFile, newLeaf: boolean | 'tab' | 'split' | 'window'): Promise<void> {
		this.plugin.session.touch();
		await this.app.workspace.getLeaf(newLeaf).openFile(file);
	}

	private noteMenu(evt: MouseEvent, file: TFile): void {
		const ops = this.plugin.ops;
		const menu = new Menu();
		menu.addItem(i => i.setTitle(t('menuOpenNewTab')).setIcon('file-plus').onClick(() => void this.openNote(file, 'tab')));
		menu.addItem(i => i.setTitle(t('menuReveal')).setIcon('folder-search').onClick(() => this.plugin.revealInExplorer(file)));
		menu.addSeparator();
		menu.addItem(i => i.setTitle(t('menuDecryptNote')).setIcon('lock-open').onClick(() => void ops.decryptNoteInteractive(file)));
		menu.addItem(i => i.setTitle(t('menuDelete')).setIcon('trash-2').setWarning(true).onClick(() => void ops.deleteInteractive(file)));
		menu.showAtMouseEvent(evt);
	}

	private folderMenu(evt: MouseEvent, folderPath: string): void {
		const folder = folderPath === '/' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			return;
		}
		const ops = this.plugin.ops;
		const menu = new Menu();
		menu.addItem(i => i.setTitle(t('menuNewNote')).setIcon(ICON_NOTE).onClick(() => void ops.newNoteInteractive(folder)));
		if (this.plugin.session.isUnlocked) {
			menu.addItem(i => i.setTitle(t('menuLock')).setIcon('lock').onClick(() => void this.plugin.lockAll()));
		}
		menu.addSeparator();
		menu.addItem(i => i.setTitle(t('menuDecryptFolder')).setIcon('lock-open').onClick(() => void ops.decryptFolderInteractive(folder)));
		menu.showAtMouseEvent(evt);
	}
}
