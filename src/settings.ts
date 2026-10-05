import { App, PluginSettingTab, Setting } from 'obsidian';
import { t } from './i18n';
import type FolderEncryptPlugin from './main';

export type PendingKind = 'encrypt-folder' | 'encrypt-notes' | 'decrypt';

export interface PendingOperation {
	/**
	 * Folder whose `.md` files may contain envelopes, and whose encrypted folders may have readable
	 * names, after an interruption. Its own path does not change during the operation.
	 */
	folder: string;
	started: number;
	/** Missing in older entries. */
	kind?: PendingKind;
}

export interface FolderEncryptSettings {
	autoLockMinutes: number;
	explorerNames: boolean;
	confirmPassword: boolean;
	/** Update links in other notes when encrypted notes get a new file name. */
	updateLinks: boolean;
	/** Journal for crash recovery. Contains folder paths only, never note names. */
	pending: PendingOperation[];
}

export const DEFAULT_SETTINGS: FolderEncryptSettings = {
	autoLockMinutes: 15,
	explorerNames: true,
	confirmPassword: true,
	updateLinks: true,
	pending: [],
};

export class FolderEncryptSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FolderEncryptPlugin) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t('setAutoLock'))
			.setDesc(t('setAutoLockDesc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.setValue(String(this.plugin.settings.autoLockMinutes)).onChange(async value => {
					const minutes = Math.max(0, Math.floor(Number(value)));
					this.plugin.settings.autoLockMinutes = Number.isFinite(minutes) ? minutes : 0;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('setExplorer'))
			.setDesc(t('setExplorerDesc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.explorerNames).onChange(async value => {
					this.plugin.settings.explorerNames = value;
					await this.plugin.saveSettings();
					this.plugin.applyExplorerSetting();
				}),
			);

		new Setting(containerEl)
			.setName(t('setConfirm'))
			.setDesc(t('setConfirmDesc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.confirmPassword).onChange(async value => {
					this.plugin.settings.confirmPassword = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t('setUpdateLinks'))
			.setDesc(t('setUpdateLinksDesc'))
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.updateLinks).onChange(async value => {
					this.plugin.settings.updateLinks = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName(t('setInfoHeading')).setHeading();
		const list = containerEl.createEl('ul', { cls: 'wzz-settings-info' });
		list.createEl('li', { text: t('setInfo1') });
		list.createEl('li', { text: t('setInfo2') });
		list.createEl('li', { text: t('setInfo3') });
	}
}
