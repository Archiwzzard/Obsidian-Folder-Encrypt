/**
 * Crypto primitives compatible with Meld Encrypt (https://github.com/meld-cp/obsidian-encrypt, MIT).
 *
 * File format "2.0" (Meld's CryptoHelper2304):
 *   key     = PBKDF2(password, salt, 210000 iterations, SHA-512) -> AES-256-GCM
 *   payload = iv (16 bytes) | salt (16 bytes) | AES-GCM ciphertext incl. 16 byte tag
 *   stored as base64
 *
 * File format "1.0" (Meld's legacy CryptoHelper) is supported for decryption only.
 */

export const MELD_VERSION = '2.0';

const IV_SIZE = 16;
const SALT_SIZE = 16;
const TAG_SIZE = 16;
const ITERATIONS = 210000;

const LEGACY_ITERATIONS = 1000;
const LEGACY_SALT = 'XHWnDAT6ehMVY2zD';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function utf8Decode(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length));
}

export function newSalt(): Uint8Array<ArrayBuffer> {
	return randomBytes(SALT_SIZE);
}

export async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: ITERATIONS },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function encryptWithKey(
	key: CryptoKey,
	salt: Uint8Array<ArrayBuffer>,
	plain: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const iv = randomBytes(IV_SIZE);
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
	const out = new Uint8Array(IV_SIZE + SALT_SIZE + cipher.length);
	out.set(iv, 0);
	out.set(salt, IV_SIZE);
	out.set(cipher, IV_SIZE + SALT_SIZE);
	return out;
}

export interface PayloadParts {
	iv: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
	cipher: Uint8Array<ArrayBuffer>;
}

export function splitPayload(payload: Uint8Array): PayloadParts | null {
	if (payload.length < IV_SIZE + SALT_SIZE + TAG_SIZE) {
		return null;
	}
	return {
		iv: payload.slice(0, IV_SIZE),
		salt: payload.slice(IV_SIZE, IV_SIZE + SALT_SIZE),
		cipher: payload.slice(IV_SIZE + SALT_SIZE),
	};
}

/** Returns null when the key does not fit (wrong password) or the payload is damaged. */
export async function decryptWithKey(key: CryptoKey, parts: PayloadParts): Promise<Uint8Array<ArrayBuffer> | null> {
	try {
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parts.iv }, key, parts.cipher);
		return new Uint8Array(plain);
	} catch {
		return null;
	}
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> | null {
	try {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
}

/** The salt of a payload as a string key, read from the first 44 base64 characters. */
export function payloadSaltKey(base64: string): string | null {
	const head = base64ToBytes(base64.slice(0, 44));
	return head != null && head.length >= IV_SIZE + SALT_SIZE ? bytesToBase64(head.slice(IV_SIZE, IV_SIZE + SALT_SIZE)) : null;
}

/** Self-contained Meld "2.0" encryption (random salt), as Meld itself does it. */
export async function meldEncryptText(text: string, password: string): Promise<string> {
	const salt = newSalt();
	const key = await deriveKey(password, salt);
	return bytesToBase64(await encryptWithKey(key, salt, utf8Encode(text)));
}

/** Decrypts a Meld "2.0" or "1.0" payload with a password. Returns null on a wrong password. */
export async function meldDecryptText(version: string, base64: string, password: string): Promise<string | null> {
	if (base64 === '') {
		return '';
	}
	const payload = base64ToBytes(base64);
	if (payload == null) {
		return null;
	}
	if (version === MELD_VERSION) {
		const parts = splitPayload(payload);
		if (parts == null) {
			return null;
		}
		const plain = await decryptWithKey(await deriveKey(password, parts.salt), parts);
		return plain == null ? null : utf8Decode(plain);
	}
	if (version === '1.0') {
		return legacyDecrypt(payload, password);
	}
	return null;
}

async function legacyDecrypt(payload: Uint8Array<ArrayBuffer>, password: string): Promise<string | null> {
	if (payload.length < IV_SIZE + TAG_SIZE) {
		return null;
	}
	try {
		const baseKey = await crypto.subtle.importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveKey']);
		const key = await crypto.subtle.deriveKey(
			{ name: 'PBKDF2', hash: 'SHA-256', salt: utf8Encode(LEGACY_SALT), iterations: LEGACY_ITERATIONS },
			baseKey,
			{ name: 'AES-GCM', length: 256 },
			false,
			['decrypt'],
		);
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: payload.slice(0, IV_SIZE) },
			key,
			payload.slice(IV_SIZE),
		);
		return utf8Decode(new Uint8Array(plain));
	} catch {
		return null;
	}
}
