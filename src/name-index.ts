import { App, Events, TAbstractFile, TFile, TFolder } from 'obsidian';
import { EXT, FOLDER_MARKER } from './constants';
import { NameInfo, isOwnEnvelope, parseEnvelope } from './crypto/envelope';
import { openName } from './crypto/notes';
import { joinVaultPath, leafName } from './paths';
import type { Secret, Session } from './session';

export type EntryState = 'unlocked' | 'locked' | 'invalid';

export interface Entry {
	file: TFile;
	state: EntryState;
	hint: string;
	/** Only while unlocked. */
	name?: NameInfo;
	/** Only while unlocked: the secret that opens this note. */
	secret?: Secret;
}

/** An encrypted folder, represented by its marker file. */
export interface FolderEntry {
	/** The marker file inside the folder. */
	file: TFile;
	state: EntryState;
	hint: string;
	/** Only while unlocked: the real name of the folder. */
	name?: string;
	/** Only while unlocked. */
	secret?: Secret;
}

export function isEncryptedNote(file: TAbstractFile | null | undefined): file is TFile {
	return file instanceof TFile && file.extension === EXT;
}

export function isFolderMarker(file: TAbstractFile | null | undefined): file is TFile {
	return file instanceof TFile && file.name === FOLDER_MARKER;
}

export function markerPath(folder: TFolder): string {
	return joinVaultPath(folder.path, FOLDER_MARKER);
}

/**
 * In-memory map of all `.wzzcrypt` notes and encrypted folders and – while unlocked – their
 * real names. Events: 'changed'.
 */
export class NameIndex extends Events {
	private entries = new Map<string, Entry>();
	/** By path of the marker file. */
	private folders = new Map<string, FolderEntry>();
	private generation = 0;

	constructor(private readonly app: App, private readonly session: Session) {
		super();
	}

	files(): TFile[] {
		return this.app.vault.getFiles().filter(f => f.extension === EXT);
	}

	markers(): TFile[] {
		return this.app.vault.getFiles().filter(isFolderMarker);
	}

	get(file: TFile): Entry | undefined {
		return this.entries.get(file.path);
	}

	all(): Entry[] {
		return [...this.entries.values()];
	}

	/** Entry of a note or of a folder marker. */
	entryOf(file: TFile): Entry | FolderEntry | undefined {
		return this.entries.get(file.path) ?? this.folders.get(file.path);
	}

	folderEntry(folder: TFolder): FolderEntry | undefined {
		const marker = folder.children.find(isFolderMarker);
		return marker && this.folders.get(marker.path);
	}

	/**
	 * True if the folder holds a marker, i.e. its name is encrypted (asks the vault, not the index).
	 * Looks at the children: while Obsidian reports a folder rename, the paths inside are still the old ones.
	 */
	isEncryptedFolder(folder: TFolder): boolean {
		return !folder.isRoot() && folder.children.some(isFolderMarker);
	}

	/** Real name of an encrypted folder while unlocked. */
	folderName(folder: TFolder): string | null {
		const entry = this.folderEntry(folder);
		return entry?.state === 'unlocked' && entry.name ? entry.name : null;
	}

	/** The folder the encryption was started from: the nearest ancestor whose name is not encrypted. */
	rootOf(file: TAbstractFile): TFolder {
		let folder = file.parent;
		while (folder && this.isEncryptedFolder(folder)) {
			folder = folder.parent;
		}
		return folder ?? this.app.vault.getRoot();
	}

	/** Path of `folder` with the real names of encrypted folders (random names where locked). */
	displayFolderPath(folder: TFolder): string {
		const segments: string[] = [];
		let current: TFolder | null = folder;
		while (current && !current.isRoot()) {
			if (!this.isEncryptedFolder(current)) {
				segments.unshift(current.path);
				break;
			}
			segments.unshift(this.folderName(current) ?? current.name);
			current = current.parent;
		}
		return segments.join('/');
	}

	/** Real name of an unlocked note as stored in the note (may contain virtual subfolders). */
	namePath(file: TFile): string | null {
		const entry = this.entries.get(file.path);
		return entry?.state === 'unlocked' && entry.name ? entry.name.path : null;
	}

	/**
	 * Path of an unlocked note relative to {@link rootOf}, with the real names of the encrypted
	 * folders in between.
	 */
	displayPath(file: TFile): string | null {
		const name = this.namePath(file);
		if (name == null) {
			return null;
		}
		const segments = [name];
		for (let folder = file.parent; folder && this.isEncryptedFolder(folder); folder = folder.parent) {
			segments.unshift(this.folderName(folder) ?? folder.name);
		}
		return segments.join('/');
	}

	displayName(file: TFile): string | null {
		const path = this.namePath(file);
		return path == null ? null : leafName(path);
	}

	async refreshAll(): Promise<void> {
		const generation = ++this.generation;
		const seen = new Set<string>();
		for (const file of this.files()) {
			const entry = await this.load(file);
			if (generation !== this.generation) {
				return; // a newer refresh is running
			}
			this.entries.set(file.path, entry);
			seen.add(file.path);
		}
		for (const file of this.markers()) {
			const entry = await this.loadFolder(file);
			if (generation !== this.generation) {
				return;
			}
			this.folders.set(file.path, entry);
			seen.add(file.path);
		}
		for (const map of [this.entries, this.folders]) {
			for (const path of [...map.keys()]) {
				if (!seen.has(path)) {
					map.delete(path);
				}
			}
		}
		this.trigger('changed');
	}

	/** Re-reads one note or folder marker. */
	async refreshFile(file: TFile): Promise<Entry | FolderEntry> {
		const generation = this.generation;
		const marker = isFolderMarker(file);
		const entry = marker ? await this.loadFolder(file) : await this.load(file);
		const map: Map<string, Entry | FolderEntry> = marker ? this.folders : this.entries;
		if (generation !== this.generation) {
			// a full refresh or a lock happened meanwhile; this result may be outdated
			return map.get(file.path) ?? entry;
		}
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
			map.delete(file.path);
		} else {
			map.set(file.path, entry);
		}
		this.trigger('changed');
		return entry;
	}

	/** Sets the name after we changed it ourselves (avoids re-reading the file). */
	setName(file: TFile, name: NameInfo, secret: Secret, hint: string): void {
		this.entries.set(file.path, { file, state: 'unlocked', name, secret, hint });
		this.trigger('changed');
	}

	remove(path: string): void {
		if (this.entries.delete(path) || this.folders.delete(path)) {
			this.trigger('changed');
		}
	}

	/** Moves the entry to the new path. Returns false if there was no entry to move. */
	rename(file: TFile, oldPath: string): boolean {
		const map: Map<string, Entry | FolderEntry> = this.folders.has(oldPath) ? this.folders : this.entries;
		const entry = map.get(oldPath);
		map.delete(oldPath);
		const moved = entry != null && (map === this.folders ? isFolderMarker(file) : file.extension === EXT);
		if (entry && moved) {
			entry.file = file;
			map.set(file.path, entry);
		}
		this.trigger('changed');
		return moved;
	}

	/** Forgets all names (on lock). */
	forgetNames(): void {
		this.generation++;
		for (const entry of [...this.entries.values(), ...this.folders.values()]) {
			if (entry.state === 'unlocked') {
				entry.state = 'locked';
				entry.name = undefined;
				entry.secret = undefined;
			}
		}
		this.trigger('changed');
	}

	private async load(file: TFile): Promise<Entry> {
		let text: string;
		try {
			text = await this.app.vault.cachedRead(file);
		} catch {
			return { file, state: 'invalid', hint: '' };
		}
		const envelope = parseEnvelope(text);
		if (!isOwnEnvelope(envelope)) {
			return { file, state: 'invalid', hint: '' };
		}
		for (const secret of this.session.secretsList) {
			const name = await openName(secret, envelope);
			if (name) {
				return { file, state: 'unlocked', hint: envelope.hint, name, secret };
			}
		}
		return { file, state: 'locked', hint: envelope.hint };
	}

	private async loadFolder(file: TFile): Promise<FolderEntry> {
		const note = await this.load(file);
		return { file, state: note.state, hint: note.hint, name: note.name?.path, secret: note.secret };
	}
}
