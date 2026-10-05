/**
 * Pure helpers for random file ids, virtual note paths and vault paths.
 * No Obsidian imports so they can be unit tested in Node.
 */

/** Lower case only (case-insensitive file systems), without the easily confused 0, 1, l, o. */
export const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const ID_LENGTH = 12;
export const ID_CHAR_CLASS = '[a-km-np-z2-9]';

const ID_RE = new RegExp(`^${ID_CHAR_CLASS}{${ID_LENGTH}}$`);

/** Our ids always contain a digit and a letter, so ordinary words are never mistaken for ids. */
export function isId(name: string): boolean {
	return ID_RE.test(name) && /[0-9]/.test(name) && /[a-z]/.test(name);
}

export function randomId(): string {
	for (;;) {
		const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
		let id = '';
		for (const b of bytes) {
			id += ID_ALPHABET[b & 31];
		}
		if (isId(id)) {
			return id;
		}
	}
}

/** Characters Obsidian does not allow in file names or links, plus the Windows invalid ones. */
export const INVALID_NAME_CHARS = '*"\\<>:|?#^[]';
const INVALID_NAME_RE = /[*"\\<>:|?#^[\]]/;
const MAX_SEGMENT_LENGTH = 200;

export type NameError = 'empty' | 'dot' | 'chars' | 'long';

/**
 * Validates a user-supplied note name. `/` separates virtual subfolders, e.g. `Projects/Plan`.
 */
export function normalizeVirtualPath(input: string): { path: string } | { error: NameError } {
	const segments = input.split('/').map(s => s.trim()).filter(s => s.length > 0);
	if (segments.length === 0) {
		return { error: 'empty' };
	}
	for (const segment of segments) {
		if (segment.startsWith('.')) {
			return { error: 'dot' };
		}
		if (INVALID_NAME_RE.test(segment)) {
			return { error: 'chars' };
		}
		if (segment.length > MAX_SEGMENT_LENGTH) {
			return { error: 'long' };
		}
	}
	return { path: segments.join('/') };
}

export function leafName(virtualPath: string): string {
	const idx = virtualPath.lastIndexOf('/');
	return idx < 0 ? virtualPath : virtualPath.slice(idx + 1);
}

export function virtualParent(virtualPath: string): string {
	const idx = virtualPath.lastIndexOf('/');
	return idx < 0 ? '' : virtualPath.slice(0, idx);
}

/** Joins vault path parts; the vault root is '' or '/'. */
export function joinVaultPath(...parts: string[]): string {
	return parts
		.flatMap(p => p.split('/'))
		.filter(p => p.length > 0)
		.join('/');
}

/** Path of `filePath` relative to `folderPath` (vault paths), or null if it is not inside. */
export function relativePath(folderPath: string, filePath: string): string | null {
	const folder = joinVaultPath(folderPath);
	if (folder === '') {
		return filePath;
	}
	return filePath.startsWith(folder + '/') ? filePath.slice(folder.length + 1) : null;
}

export function stripExtension(path: string): string {
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	return dot > slash + 1 ? path.slice(0, dot) : path;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Makes a single path segment safe to create on disk (used when decrypting). */
export function sanitizeSegment(segment: string): string {
	let out = segment.replace(/[*"\\<>:|?#^[\]/]/g, '-').replace(/[. ]+$/, '').trim();
	if (out.length === 0 || out.startsWith('.')) {
		out = '_' + out;
	}
	if (WINDOWS_RESERVED.test(out)) {
		out += '_';
	}
	return out;
}
