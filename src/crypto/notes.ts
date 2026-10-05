import { FORMAT } from '../constants';
import type { Secret } from '../session';
import { Envelope, NameInfo, decodeNameInfo, encodeNameInfo } from './envelope';
import { MELD_VERSION, utf8Decode, utf8Encode } from './meld-crypto';

export async function sealName(secret: Secret, name: NameInfo): Promise<string> {
	return secret.encrypt(encodeNameInfo(name));
}

export async function sealContent(secret: Secret, content: string): Promise<string> {
	return secret.encrypt(utf8Encode(content));
}

export async function sealNote(secret: Secret, content: string, name: NameInfo, hint: string): Promise<Envelope> {
	return {
		version: MELD_VERSION,
		hint,
		format: FORMAT,
		encodedName: await sealName(secret, name),
		encodedData: await sealContent(secret, content),
	};
}

/** Envelope of a folder marker: only the folder's real name, no content. */
export async function sealFolderName(secret: Secret, name: string, hint: string): Promise<Envelope> {
	return {
		version: MELD_VERSION,
		hint,
		format: FORMAT,
		encodedName: await sealName(secret, { path: name, ext: '' }),
		encodedData: '',
	};
}

export async function openName(secret: Secret, envelope: Envelope): Promise<NameInfo | null> {
	if (envelope.version !== MELD_VERSION || !envelope.encodedName) {
		return null;
	}
	const plain = await secret.decrypt(envelope.encodedName);
	return plain == null ? null : decodeNameInfo(plain);
}

export async function openContent(secret: Secret, envelope: Envelope): Promise<string | null> {
	if (envelope.version !== MELD_VERSION) {
		return null;
	}
	if (envelope.encodedData === '') {
		return '';
	}
	const plain = await secret.decrypt(envelope.encodedData);
	return plain == null ? null : utf8Decode(plain);
}

export interface OpenedNote {
	secret: Secret;
	name: NameInfo;
	content: string;
}

/** Tries all given secrets. Returns null if none of them fits. */
export async function openNote(secrets: readonly Secret[], envelope: Envelope): Promise<OpenedNote | null> {
	for (const secret of secrets) {
		const name = await openName(secret, envelope);
		if (name == null) {
			continue;
		}
		const content = await openContent(secret, envelope);
		if (content == null) {
			continue;
		}
		return { secret, name, content };
	}
	return null;
}
