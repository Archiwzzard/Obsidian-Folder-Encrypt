import { FORMAT } from '../constants';
import { utf8Decode, utf8Encode } from './meld-crypto';

/**
 * The JSON stored in a `.wzzcrypt` file. It is a superset of Meld Encrypt's `.mdenc` format:
 * Meld reads `version`, `hint` and `encodedData` and ignores the other fields,
 * so the note content of a `.wzzcrypt` file can still be decrypted with Meld's tools.
 */
export interface Envelope {
	version: string;
	hint: string;
	format?: string;
	/** Encrypted {@link NameInfo}. Missing in plain Meld files. */
	encodedName?: string;
	/** Encrypted note content (Meld compatible). */
	encodedData: string;
}

/**
 * What is stored (encrypted) in `encodedName`. A folder marker (`folder.wzzfolder`) stores the
 * folder's real name in `path`; its `encodedData` is empty.
 */
export interface NameInfo {
	/** Name relative to the folder that holds the file, without extension. May contain `/` for subfolders. */
	path: string;
	/** Extension of the original file, e.g. `md`. */
	ext: string;
}

export function parseEnvelope(text: string): Envelope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null;
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.version !== 'string' || typeof obj.encodedData !== 'string') {
		return null;
	}
	return {
		version: obj.version,
		hint: typeof obj.hint === 'string' ? obj.hint : '',
		format: typeof obj.format === 'string' ? obj.format : undefined,
		encodedName: typeof obj.encodedName === 'string' ? obj.encodedName : undefined,
		encodedData: obj.encodedData,
	};
}

/** True for envelopes written by this plugin (as opposed to plain Meld files). */
export function isOwnEnvelope(envelope: Envelope | null): envelope is Envelope & { encodedName: string } {
	return envelope != null && envelope.format === FORMAT && typeof envelope.encodedName === 'string';
}

export function serializeEnvelope(envelope: Envelope): string {
	const out: Record<string, string> = {
		version: envelope.version,
		hint: envelope.hint ?? '',
	};
	if (envelope.format) {
		out.format = envelope.format;
	}
	if (envelope.encodedName !== undefined) {
		out.encodedName = envelope.encodedName;
	}
	out.encodedData = envelope.encodedData;
	return JSON.stringify(out, null, 2);
}

const NAME_BLOCK = 64;

/**
 * Serialises the name as JSON and pads it with spaces to a multiple of 64 bytes,
 * so the ciphertext does not reveal the exact length of the name.
 */
export function encodeNameInfo(info: NameInfo): Uint8Array<ArrayBuffer> {
	const json = utf8Encode(JSON.stringify({ v: 1, path: info.path, ext: info.ext }));
	const size = Math.ceil((json.length + 1) / NAME_BLOCK) * NAME_BLOCK;
	const out = new Uint8Array(size).fill(0x20);
	out.set(json, 0);
	return out;
}

export function decodeNameInfo(bytes: Uint8Array): NameInfo | null {
	try {
		const obj = JSON.parse(utf8Decode(bytes)) as Record<string, unknown>;
		if (typeof obj.path !== 'string' || obj.path.length === 0) {
			return null;
		}
		return { path: obj.path, ext: typeof obj.ext === 'string' && obj.ext ? obj.ext : 'md' };
	} catch {
		return null;
	}
}
