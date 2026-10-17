import { App, ButtonComponent, FuzzyMatch, FuzzySuggestModal, Modal, Setting, TFile, setIcon } from 'obsidian';
import { t } from '../i18n';
import type { Entry, NameIndex } from '../name-index';
import { INVALID_NAME_CHARS, NameError, normalizeVirtualPath } from '../paths';
import type { Secret } from '../session';

export function nameErrorText(error: NameError): string {
	switch (error) {
		case 'empty':
			return t('nameErrEmpty');
		case 'dot':
			return t('nameErrDot');
		case 'chars':
			return t('nameErrChars', { chars: INVALID_NAME_CHARS.split('').join(' ') });
		case 'long':
			return t('nameErrLong');
	}
}


/** Base class: `openAndWait()` resolves with the result when the modal closes. */
abstract class AsyncModal<T> extends Modal {
	private resolver: ((value: T | null) => void) | null = null;
	protected result: T | null = null;

	openAndWait(): Promise<T | null> {
		return new Promise(resolve => {
			this.resolver = resolve;
			this.open();
		});
	}

	protected finish(value: T): void {
		this.result = value;
		this.close();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolver?.(this.result);
		this.resolver = null;
	}
}

/* ------------------------------------------------------------------ password fields */

interface PasswordFieldOptions {
	confirm: boolean;
	askHint: boolean;
	defaultHint?: string;
	onEnter: () => void;
}

interface PasswordFields {
	password(): string;
	confirmValue(): string | null;
	hint(): string;
	focus(): void;
	selectPassword(): void;
	containerEl: HTMLElement;
}

function buildPasswordFields(parent: HTMLElement, options: PasswordFieldOptions): PasswordFields {
	const containerEl = parent.createDiv('wzz-password-fields');
	let passwordInput!: HTMLInputElement;
	let confirmInput: HTMLInputElement | null = null;
	let hintInput: HTMLInputElement | null = null;

	const onKey = (ev: KeyboardEvent) => {
		if (ev.key === 'Enter' && !ev.isComposing) {
			ev.preventDefault();
			options.onEnter();
		}
	};

	const addPasswordInput = (name: string): HTMLInputElement => {
		let input!: HTMLInputElement;
		new Setting(containerEl)
			.setName(name)
			.addText(text => {
				input = text.inputEl;
				input.type = 'password';
				input.autocomplete = 'off';
				input.spellcheck = false;
				input.addEventListener('keydown', onKey);
			})
			.addExtraButton(button =>
				button
					.setIcon('eye')
					.setTooltip(t('pwShow'))
					.onClick(() => {
						input.type = input.type === 'password' ? 'text' : 'password';
					}),
			);
		return input;
	};

	passwordInput = addPasswordInput(t('pwPassword'));
	if (options.confirm) {
		confirmInput = addPasswordInput(t('pwConfirm'));
	}
	if (options.askHint) {
		new Setting(containerEl)
			.setName(t('pwHint'))
			.setDesc(t('pwHintDesc'))
			.addText(text => {
				hintInput = text.inputEl;
				text.setValue(options.defaultHint ?? '');
				hintInput.addEventListener('keydown', onKey);
			});
	}

	return {
		containerEl,
		password: () => passwordInput.value,
		confirmValue: () => (confirmInput ? confirmInput.value : null),
		hint: () => (hintInput ? hintInput.value.trim() : options.defaultHint ?? ''),
		focus: () => window.setTimeout(() => passwordInput.focus(), 0),
		selectPassword: () => {
			passwordInput.focus();
			passwordInput.select();
		},
	};
}

/* ------------------------------------------------------------------ password modal */

export interface PasswordRequest {
	title: string;
	mode: 'unlock' | 'new';
	message?: string;
	hints?: string[];
	/** Ask twice (only for mode 'new'). */
	confirm?: boolean;
	/** Show the hint input (only for mode 'new'). */
	askHint?: boolean;
	defaultHint?: string;
	/** Offer to reuse this already unlocked password (mode 'new'). */
	sessionSecret?: Secret | null;
	allowSkip?: boolean;
	submitText?: string;
	/** Checks the password before the modal closes (mode 'unlock'). */
	validate?: (password: string) => Promise<boolean>;
}

export type PasswordResult =
	| { kind: 'password'; password: string; hint: string }
	| { kind: 'session'; secret: Secret }
	| { kind: 'skip' };

export class PasswordModal extends AsyncModal<PasswordResult> {
	private fields!: PasswordFields;
	private errorEl!: HTMLElement;
	private submitButton!: ButtonComponent;
	private useSession = false;
	private busy = false;

	constructor(app: App, private readonly request: PasswordRequest) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, request } = this;
		this.modalEl.addClass('wzz-modal');
		this.setTitle(request.title);

		if (request.message) {
			contentEl.createEl('p', { text: request.message });
		}
		const hints = [...new Set((request.hints ?? []).map(h => h.trim()).filter(h => h.length > 0))];
		for (const hint of hints) {
			contentEl.createEl('p', { cls: 'wzz-hint', text: t('pwHintShown', { hint }) });
		}

		if (request.mode === 'new' && request.sessionSecret) {
			this.useSession = true;
			new Setting(contentEl).setName(t('pwUseSession')).addToggle(toggle =>
				toggle.setValue(true).onChange(value => {
					this.useSession = value;
					this.fields.containerEl.toggle(!value);
					if (!value) {
						this.fields.focus();
					}
				}),
			);
		}

		this.fields = buildPasswordFields(contentEl, {
			confirm: request.mode === 'new' && !!request.confirm,
			askHint: request.mode === 'new' && !!request.askHint,
			defaultHint: request.defaultHint,
			onEnter: () => void this.submit(),
		});
		this.fields.containerEl.toggle(!this.useSession);

		if (request.mode === 'new') {
			contentEl.createEl('p', { cls: 'wzz-warning', text: t('pwForgetWarning') });
		}
		this.errorEl = contentEl.createDiv('wzz-error');

		const buttons = new Setting(contentEl);
		if (request.allowSkip) {
			buttons.addButton(b => b.setButtonText(t('btnSkip')).onClick(() => this.finish({ kind: 'skip' })));
		}
		buttons.addButton(b => b.setButtonText(t('btnCancel')).onClick(() => this.close()));
		buttons.addButton(b => {
			this.submitButton = b;
			b.setButtonText(request.submitText ?? (request.mode === 'unlock' ? t('btnUnlock') : t('btnOk')))
				.setCta()
				.onClick(() => void this.submit());
		});

		if (!this.useSession) {
			this.fields.focus();
		}
	}

	private showError(text: string): void {
		this.errorEl.setText(text);
	}

	private async submit(): Promise<void> {
		if (this.busy) {
			return;
		}
		const { request } = this;
		if (this.useSession && request.sessionSecret) {
			this.finish({ kind: 'session', secret: request.sessionSecret });
			return;
		}
		const password = this.fields.password();
		if (password.length === 0) {
			this.showError(t('pwEmpty'));
			return;
		}
		const confirmValue = this.fields.confirmValue();
		if (confirmValue != null && confirmValue !== password) {
			this.showError(t('pwMismatch'));
			return;
		}
		if (request.validate) {
			this.busy = true;
			this.submitButton.setDisabled(true);
			this.showError(t('pwChecking'));
			let ok = false;
			try {
				ok = await request.validate(password);
			} finally {
				this.busy = false;
				this.submitButton.setDisabled(false);
			}
			if (!ok) {
				this.showError(t('pwWrong'));
				this.fields.selectPassword();
				return;
			}
		}
		this.finish({ kind: 'password', password, hint: this.fields.hint() });
	}
}

/* ------------------------------------------------------------------ encrypt folder */

export interface EncryptFolderRequest {
	/** Shown in the title; real names of encrypted folders while unlocked. */
	folderPath: string;
	/** Path of a file relative to the folder, as shown in the lists. */
	label: (file: TFile) => string;
	notes: TFile[];
	meld: TFile[];
	ownCount: number;
	/** Subfolders whose names get encrypted. */
	folderCount: number;
	others: TFile[];
	sessionSecret: Secret | null;
	confirm: boolean;
	updateLinks: boolean;
}

export type EncryptFolderResult = { files: TFile[]; password: PasswordResult };

export class EncryptFolderModal extends AsyncModal<EncryptFolderResult> {
	private selected = new Set<TFile>();
	private fields!: PasswordFields;
	private errorEl!: HTMLElement;
	private submitButton!: ButtonComponent;
	private useSession = false;

	constructor(app: App, private readonly request: EncryptFolderRequest) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, request } = this;
		this.modalEl.addClass('wzz-modal', 'wzz-encrypt-folder-modal');
		this.setTitle(t('efTitle', { folder: request.folderPath }));
		contentEl.createEl('p', { cls: 'wzz-intro', text: t('efIntro') });

		const candidates = [...request.notes, ...request.meld];
		for (const file of candidates) {
			this.selected.add(file);
		}

		if (candidates.length > 0) {
			this.renderList(candidates);
		}

		if (request.notes.length > 0) {
			contentEl.createEl('p', { cls: 'wzz-muted', text: request.updateLinks ? t('efLinkNoteAll') : t('efLinkNote') });
		}
		if (request.folderCount > 0) {
			contentEl.createEl('p', { cls: 'wzz-muted', text: t('efFolders', { n: request.folderCount }) });
		}
		if (request.ownCount > 0) {
			contentEl.createEl('p', { cls: 'wzz-muted', text: t('efAlready', { n: request.ownCount }) });
		}
		if (request.others.length > 0) {
			const box = contentEl.createDiv('wzz-others');
			box.createEl('p', { cls: 'wzz-warning', text: t('efOthers') });
			const ul = box.createEl('ul');
			for (const file of request.others.slice(0, 50)) {
				ul.createEl('li', { text: request.label(file) });
			}
			if (request.others.length > 50) {
				ul.createEl('li', { text: `… +${request.others.length - 50}` });
			}
		}

		if (request.sessionSecret) {
			this.useSession = true;
			new Setting(contentEl).setName(t('pwUseSession')).addToggle(toggle =>
				toggle.setValue(true).onChange(value => {
					this.useSession = value;
					this.fields.containerEl.toggle(!value);
					if (!value) {
						this.fields.focus();
					}
				}),
			);
		}
		this.fields = buildPasswordFields(contentEl, {
			confirm: request.confirm,
			askHint: true,
			onEnter: () => this.submit(),
		});
		this.fields.containerEl.toggle(!this.useSession);
		contentEl.createEl('p', { cls: 'wzz-warning', text: t('pwForgetWarning') });
		this.errorEl = contentEl.createDiv('wzz-error');

		new Setting(contentEl)
			.addButton(b => b.setButtonText(t('btnCancel')).onClick(() => this.close()))
			.addButton(b => {
				this.submitButton = b;
				b.setCta().onClick(() => this.submit());
			});
		this.updateButton();
		if (!this.useSession) {
			this.fields.focus();
		}
	}

	private renderList(candidates: TFile[]): void {
		const { contentEl, request } = this;
		const listHeader = contentEl.createDiv('wzz-list-header');
		listHeader.createSpan({ cls: 'wzz-list-title', text: t('efNotes') });
		const listActions = listHeader.createSpan('wzz-list-actions');
		const list = contentEl.createDiv('wzz-file-list');
		const checkboxes = new Map<TFile, HTMLInputElement>();

		const setAll = (on: boolean) => {
			for (const [file, box] of checkboxes) {
				box.checked = on;
				if (on) {
					this.selected.add(file);
				} else {
					this.selected.delete(file);
				}
			}
			this.updateButton();
		};
		listActions.createEl('a', { text: t('efSelectAll'), href: '#' }).addEventListener('click', ev => {
			ev.preventDefault();
			setAll(true);
		});
		listActions.createSpan({ text: ' · ' });
		listActions.createEl('a', { text: t('efSelectNone'), href: '#' }).addEventListener('click', ev => {
			ev.preventDefault();
			setAll(false);
		});

		for (const file of candidates) {
			const row = list.createEl('label', { cls: 'wzz-file-row' });
			const box = row.createEl('input', { type: 'checkbox' });
			box.checked = true;
			box.addEventListener('change', () => {
				if (box.checked) {
					this.selected.add(file);
				} else {
					this.selected.delete(file);
				}
				this.updateButton();
			});
			checkboxes.set(file, box);
			row.createSpan({ text: request.label(file) });
			if (request.meld.includes(file)) {
				row.createSpan({ cls: 'wzz-tag', text: t('efMeldTag') });
			}
		}
	}

	private updateButton(): void {
		// with no note selected, only the folder names are encrypted
		const onlyFolders = this.selected.size === 0 && this.request.folderCount > 0;
		this.submitButton?.setButtonText(onlyFolders ? t('btnEncrypt') : t('btnEncryptN', { n: this.selected.size }));
	}

	private submit(): void {
		if (this.selected.size === 0 && this.request.folderCount === 0) {
			this.errorEl.setText(t('efNoneSelected'));
			return;
		}
		const files = [...this.request.notes, ...this.request.meld].filter(f => this.selected.has(f));
		if (this.useSession && this.request.sessionSecret) {
			this.finish({ files, password: { kind: 'session', secret: this.request.sessionSecret } });
			return;
		}
		const password = this.fields.password();
		if (password.length === 0) {
			this.errorEl.setText(t('pwEmpty'));
			return;
		}
		const confirmValue = this.fields.confirmValue();
		if (confirmValue != null && confirmValue !== password) {
			this.errorEl.setText(t('pwMismatch'));
			return;
		}
		this.finish({ files, password: { kind: 'password', password, hint: this.fields.hint() } });
	}
}

/* ------------------------------------------------------------------ name */

export class NameModal extends AsyncModal<string> {
	private input!: HTMLInputElement;
	private errorEl!: HTMLElement;

	constructor(app: App, private readonly title: string, private readonly initial: string, private readonly submitText: string) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('wzz-modal');
		this.setTitle(this.title);
		new Setting(contentEl)
			.setName(t('nameLabel'))
			.setDesc(t('nameDesc'))
			.addText(text => {
				this.input = text.inputEl;
				text.setValue(this.initial);
				this.input.addClass('wzz-name-input');
				this.input.addEventListener('keydown', ev => {
					if (ev.key === 'Enter' && !ev.isComposing) {
						ev.preventDefault();
						this.submit();
					}
				});
			});
		this.errorEl = contentEl.createDiv('wzz-error');
		new Setting(contentEl)
			.addButton(b => b.setButtonText(t('btnCancel')).onClick(() => this.close()))
			.addButton(b => b.setButtonText(this.submitText).setCta().onClick(() => this.submit()));
		window.setTimeout(() => {
			this.input.focus();
			this.input.select();
		}, 0);
	}

	private submit(): void {
		const result = normalizeVirtualPath(this.input.value);
		if ('error' in result) {
			this.errorEl.setText(nameErrorText(result.error));
			return;
		}
		this.finish(result.path);
	}
}

/* ------------------------------------------------------------------ confirm */

export class ConfirmModal extends AsyncModal<boolean> {
	constructor(
		app: App,
		private readonly title: string,
		private readonly messages: string[],
		private readonly confirmText: string,
		private readonly dangerous: boolean,
	) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('wzz-modal');
		this.setTitle(this.title);
		for (const message of this.messages) {
			contentEl.createEl('p', { text: message });
		}
		new Setting(contentEl)
			.addButton(b => b.setButtonText(t('btnCancel')).onClick(() => this.close()))
			.addButton(b => {
				b.setButtonText(this.confirmText).onClick(() => this.finish(true));
				if (this.dangerous) {
					b.setDestructive();
				} else {
					b.setCta();
				}
			});
	}
}

/* ------------------------------------------------------------------ report */

export interface ReportSection {
	title: string;
	items: string[];
	warning?: boolean;
}

export class ReportModal extends Modal {
	constructor(app: App, private readonly summary: string, private readonly sections: ReportSection[], private readonly footer?: string) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('wzz-modal');
		this.setTitle(t('repTitle'));
		contentEl.createEl('p', { cls: 'wzz-summary', text: this.summary });
		for (const section of this.sections) {
			if (section.items.length === 0) {
				continue;
			}
			contentEl.createEl('p', { cls: section.warning ? 'wzz-warning' : 'wzz-list-title', text: section.title });
			const ul = contentEl.createEl('ul', { cls: 'wzz-report-list' });
			for (const item of section.items) {
				ul.createEl('li', { text: item });
			}
		}
		if (this.footer) {
			contentEl.createEl('p', { cls: 'wzz-muted', text: this.footer });
		}
		new Setting(contentEl).addButton(b => b.setButtonText(t('btnClose')).setCta().onClick(() => this.close()));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ switcher */

export class NoteSuggestModal extends FuzzySuggestModal<Entry> {
	constructor(
		app: App,
		private readonly index: NameIndex,
		private readonly entries: Entry[],
		private readonly onChoose: (entry: Entry) => void,
	) {
		super(app);
		this.setPlaceholder(t('swPlaceholder'));
		this.emptyStateText = t('swEmpty');
	}

	getItems(): Entry[] {
		return this.entries;
	}

	getItemText(entry: Entry): string {
		return this.index.displayPath(entry.file) ?? entry.file.basename;
	}

	override renderSuggestion(match: FuzzyMatch<Entry>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		const root = this.index.rootOf(match.item.file);
		if (!root.isRoot()) {
			el.createDiv({ cls: 'wzz-suggest-folder', text: this.index.displayFolderPath(root) });
		}
		const icon = el.createSpan({ cls: 'wzz-suggest-icon' });
		setIcon(icon, 'file-lock-2');
		el.prepend(icon);
	}

	onChooseItem(entry: Entry): void {
		this.onChoose(entry);
	}
}
