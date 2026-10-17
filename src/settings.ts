import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
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

/** Settings the user can change in the settings tab. */
type SettingKey = 'autoLockMinutes' | 'explorerNames' | 'confirmPassword' | 'updateLinks';

export class FolderEncryptSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FolderEncryptPlugin) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				name: t('setAutoLock'),
				desc: t('setAutoLockDesc'),
				control: { type: 'number', key: 'autoLockMinutes', min: 0, step: 1 },
			},
			{ name: t('setExplorer'), desc: t('setExplorerDesc'), control: { type: 'toggle', key: 'explorerNames' } },
			{ name: t('setConfirm'), desc: t('setConfirmDesc'), control: { type: 'toggle', key: 'confirmPassword' } },
			{ name: t('setUpdateLinks'), desc: t('setUpdateLinksDesc'), control: { type: 'toggle', key: 'updateLinks' } },
			{
				type: 'group',
				heading: t('setInfoHeading'),
				items: [
					{
						name: t('setInfoHeading'),
						searchable: false,
						render: setting => {
							setting.settingEl.empty();
							const list = setting.settingEl.createEl('ul', { cls: 'wzz-settings-info' });
							for (const text of [t('setInfo1'), t('setInfo2'), t('setInfo3')]) {
								list.createEl('li', { text });
							}
						},
					},
				],
			},
		];
	}

	override getControlValue(key: string): unknown {
		return this.plugin.settings[key as SettingKey];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key as SettingKey) {
			case 'autoLockMinutes': {
				const minutes = Math.floor(Number(value));
				settings.autoLockMinutes = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
				break;
			}
			case 'explorerNames':
			case 'confirmPassword':
			case 'updateLinks':
				settings[key as Exclude<SettingKey, 'autoLockMinutes'>] = value === true;
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		if (key === 'explorerNames') {
			this.plugin.applyExplorerSetting();
		}
	}
}
