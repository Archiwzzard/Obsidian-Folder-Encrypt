import { CryptoHelper2304 } from './meld-reference/CryptoHelper2304';
import { CryptoHelper } from './meld-reference/CryptoHelper';
import { EXT, FORMAT } from '../src/constants';
import { t } from '../src/i18n';
import { decodeNameInfo, encodeNameInfo, isOwnEnvelope, parseEnvelope, serializeEnvelope } from '../src/crypto/envelope';
import { base64ToBytes, bytesToBase64, meldDecryptText, payloadSaltKey } from '../src/crypto/meld-crypto';
import { openContent, openName, openNote, sealFolderName, sealName, sealNote } from '../src/crypto/notes';
import { DecryptedTarget, findLinkSpans, rewriteLinksForDecryption, rewriteLinksForEncryption } from '../src/links';
import {
	ID_ALPHABET,
	ID_CHAR_CLASS,
	ID_LENGTH,
	isId,
	joinVaultPath,
	leafName,
	normalizeVirtualPath,
	randomId,
	relativePath,
	sanitizeSegment,
	stripExtension,
	virtualParent,
} from '../src/paths';
import { Secret } from '../src/session';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function eq<T>(actual: T, expected: T, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label} expected ${e} but got ${a}`);
	}
}

function ok(condition: unknown, label: string): void {
	if (!condition) {
		throw new Error(label);
	}
}

const meld = new CryptoHelper2304(16, 16, 210000);
const TEXT = 'Meeting notes 🗒️ at the café\nDeadline: March 12\n\n- [[Plan]]\n';

/* ---------------------------------------------------------------- Meld compatibility */

test('Meld 2.0 payload can be decrypted by this plugin', async () => {
	const payload = await meld.encryptToBase64(TEXT, 'secret');
	eq(await meldDecryptText('2.0', payload, 'secret'), TEXT);
	eq(await meldDecryptText('2.0', payload, 'wrong'), null, 'wrong password');
	const secret = new Secret('secret', '');
	const plain = await secret.decrypt(payload);
	eq(plain == null ? null : new TextDecoder().decode(plain), TEXT, 'Secret.decrypt');
});

test('content encrypted by this plugin can be decrypted by Meld', async () => {
	const secret = new Secret('secret', '');
	const envelope = await sealNote(secret, TEXT, { path: 'Projects/Plan', ext: 'md' }, 'hint');
	// Meld reads the JSON, looks at version + encodedData and ignores the other fields
	const meldView = JSON.parse(serializeEnvelope(envelope)) as { version: string; hint: string; encodedData: string };
	eq(meldView.version, '2.0');
	eq(meldView.hint, 'hint');
	eq(await meld.decryptFromBase64(meldView.encodedData, 'secret'), TEXT);
	eq(await meld.decryptFromBase64(meldView.encodedData, 'wrong'), null, 'wrong password');
});

test('Meld legacy 1.0 payload can be decrypted', async () => {
	const payload = await new CryptoHelper().encryptToBase64(TEXT, 'old');
	eq(await meldDecryptText('1.0', payload, 'old'), TEXT);
	eq(await meldDecryptText('1.0', payload, 'wrong'), null);
	eq(await meldDecryptText('9.9', payload, 'old'), null, 'unknown version');
});

test('empty Meld payload means empty text', async () => {
	eq(await meldDecryptText('2.0', '', 'x'), '');
});

/* ---------------------------------------------------------------- secrets & salts */

test('one salt per session, readable by a fresh secret', async () => {
	const a = new Secret('pw', '');
	const one = await a.encrypt(new TextEncoder().encode('one') as Uint8Array<ArrayBuffer>);
	const two = await a.encrypt(new TextEncoder().encode('two') as Uint8Array<ArrayBuffer>);
	ok(one !== two, 'random IVs');
	eq(payloadSaltKey(one), payloadSaltKey(two), 'same salt');
	const fresh = new Secret('pw', '');
	eq(new TextDecoder().decode((await fresh.decrypt(two))!), 'two');
	eq(await new Secret('nope', '').decrypt(two), null, 'wrong password');
});

test('a secret adopts the salt of existing files', async () => {
	const payload = await meld.encryptToBase64('x', 'pw');
	const secret = new Secret('pw', '');
	ok(await secret.decrypt(payload), 'decrypts');
	const next = await secret.encrypt(new Uint8Array([1, 2, 3]));
	eq(payloadSaltKey(next), payloadSaltKey(payload));
});

test('damaged payloads are rejected, not thrown', async () => {
	const secret = new Secret('pw', '');
	eq(await secret.decrypt('not base64 !!!'), null);
	eq(await secret.decrypt(bytesToBase64(new Uint8Array(10))), null);
	const good = await secret.encrypt(new Uint8Array([1, 2, 3]));
	const bytes = base64ToBytes(good)!;
	bytes[bytes.length - 1] ^= 1;
	eq(await secret.decrypt(bytesToBase64(bytes)), null, 'tampered tag');
});

test('large notes survive the round trip', async () => {
	const big = Array.from({ length: 60000 }, (_, i) => `Line ${i} café naïve 🌍`).join('\n');
	const secret = new Secret('pw', '');
	const envelope = await sealNote(secret, big, { path: 'Big', ext: 'md' }, '');
	eq((await openContent(secret, envelope)) === big, true);
	eq((await meld.decryptFromBase64(envelope.encodedData, 'pw')) === big, true, 'Meld reads it too');
});

/* ---------------------------------------------------------------- envelope & names */

test('envelope serialises in Meld field order and parses back', async () => {
	const secret = new Secret('pw', '');
	const envelope = await sealNote(secret, '', { path: 'Empty', ext: 'md' }, '');
	const text = serializeEnvelope(envelope);
	eq(Object.keys(JSON.parse(text)), ['version', 'hint', 'format', 'encodedName', 'encodedData']);
	const parsed = parseEnvelope(text);
	eq(parsed, envelope);
	ok(isOwnEnvelope(parsed), 'own envelope');
	eq(await openContent(secret, parsed!), '');
	eq(parsed!.format, FORMAT);
});

test('parseEnvelope rejects everything that is not an envelope', () => {
	eq(parseEnvelope('# just markdown'), null);
	eq(parseEnvelope('{"a": 1}'), null);
	eq(parseEnvelope('[]'), null);
	eq(parseEnvelope('123'), null);
	eq(parseEnvelope('null'), null);
	const meldFile = parseEnvelope('{"version":"2.0","hint":"h","encodedData":"abc"}');
	ok(meldFile != null && !isOwnEnvelope(meldFile), 'Meld file is an envelope but not ours');
});

test('names are padded so their length does not leak', async () => {
	for (const name of ['a', 'Plan', 'x'.repeat(40), 'é'.repeat(100)]) {
		const bytes = encodeNameInfo({ path: name, ext: 'md' });
		eq(bytes.length % 64, 0, `padding of ${name.length}`);
		eq(decodeNameInfo(bytes), { path: name, ext: 'md' });
	}
	const secret = new Secret('pw', '');
	const short = await sealName(secret, { path: 'a', ext: 'md' });
	const longer = await sealName(secret, { path: 'Projects/Plan', ext: 'md' });
	eq(short.length, longer.length, 'same ciphertext length');
	eq(decodeNameInfo(new TextEncoder().encode('garbage')), null);
	eq(decodeNameInfo(new TextEncoder().encode('{"path":""}')), null);
});

test('openNote picks the right secret and fails with wrong ones', async () => {
	const right = new Secret('right', '');
	const wrong = new Secret('wrong', '');
	const envelope = await sealNote(right, TEXT, { path: 'Log/2026', ext: 'md' }, '');
	eq(await openNote([wrong], envelope), null);
	const opened = await openNote([wrong, right], envelope);
	ok(opened?.secret === right, 'right secret chosen');
	eq(opened?.name, { path: 'Log/2026', ext: 'md' });
	eq(opened?.content, TEXT);
	eq(await openName(wrong, envelope), null);
});

test('a folder marker holds only the encrypted folder name', async () => {
	const secret = new Secret('pw', '');
	const envelope = await sealFolderName(secret, 'Projects', 'hint');
	const parsed = parseEnvelope(serializeEnvelope(envelope));
	ok(isOwnEnvelope(parsed), 'own envelope');
	eq(parsed!.encodedData, '');
	eq(parsed!.hint, 'hint');
	eq((await openName(secret, parsed!))?.path, 'Projects');
	eq(await openName(new Secret('wrong', ''), parsed!), null);
	eq((await sealName(secret, { path: 'A', ext: '' })).length, envelope.encodedName.length, 'padded like note names');
});

/* ---------------------------------------------------------------- ids & paths */

test('random ids are valid, lower case and distinguishable from words', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 3000; i++) {
		const id = randomId();
		ok(isId(id), `invalid id ${id}`);
		ok(id.length === ID_LENGTH && [...id].every(c => ID_ALPHABET.includes(c)), `alphabet ${id}`);
		seen.add(id);
	}
	eq(seen.size, 3000, 'no collisions');
	for (const word of ['masterpieces', '123456789012', 'ABCDEFGH2345', 'abc', 'notebook2026']) {
		eq(isId(word), false, word);
	}
});

test('id character class matches the alphabet', () => {
	const re = new RegExp(`^${ID_CHAR_CLASS}$`);
	for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') {
		eq(re.test(c), ID_ALPHABET.includes(c), `char ${c}`);
	}
});

test('virtual paths are validated like file names', () => {
	eq(normalizeVirtualPath(' Projects / Plan '), { path: 'Projects/Plan' });
	eq(normalizeVirtualPath('Café & Crème 🍐'), { path: 'Café & Crème 🍐' });
	eq(normalizeVirtualPath(''), { error: 'empty' });
	eq(normalizeVirtualPath(' / '), { error: 'empty' });
	eq(normalizeVirtualPath('.hidden'), { error: 'dot' });
	eq(normalizeVirtualPath('a:b'), { error: 'chars' });
	eq(normalizeVirtualPath('Chapter #1'), { error: 'chars' });
	eq(normalizeVirtualPath('x'.repeat(201)), { error: 'long' });
});

test('texts use the singular for exactly one', () => {
	eq(t('nEncrypted', { n: 1 }), '🔐 1 note encrypted');
	eq(t('nEncrypted', { n: 0 }), '🔐 0 notes encrypted');
	eq(t('nEncryptedFolders', { n: 2, f: 1 }), '🔐 2 notes and 1 folder name encrypted');
	eq(t('efFolders', { n: 1 }), '1 subfolder gets a random name.');
	eq(t('decLockedHint', { n: 3 }), '3 of them are locked. Unlock them first or they are skipped.');
	eq(t('pwTitleFile', { name: 'a|b' }), 'Password for “a|b”');
});

test('path helpers', () => {
	eq(stripExtension('a/b.md'), 'a/b');
	eq(stripExtension('b.mdenc'), 'b');
	eq(stripExtension('a/.hidden'), 'a/.hidden');
	eq(stripExtension('a.b/c'), 'a.b/c');
	eq(stripExtension('x.tar.gz'), 'x.tar');
	eq(relativePath('F', 'F/sub/a.md'), 'sub/a.md');
	eq(relativePath('F', 'FX/a.md'), null);
	eq(relativePath('/', 'x.md'), 'x.md');
	eq(joinVaultPath('/', 'a', 'b.md'), 'a/b.md');
	eq(joinVaultPath('F/', '/x'), 'F/x');
	eq(leafName('a/b/c'), 'c');
	eq(virtualParent('a/b/c'), 'a/b');
	eq(virtualParent('c'), '');
	eq(sanitizeSegment('CON'), 'CON_');
	eq(sanitizeSegment('End.'), 'End');
	eq(sanitizeSegment('a:b'), 'a-b');
	eq(sanitizeSegment(''), '_');
});

/* ---------------------------------------------------------------- links */

const ID = 'abc234defg56';
const FILE = `${ID}.${EXT}`;
const SOURCE = [
	'See [[Plan]] and [[Projects/Plan#Costs|the costs]].',
	'Image: ![[Photo.png]] · external [Web](https://example.com/Plan.md)',
	'Markdown: [Budget](Projects/Plan.md#Total%20costs)',
	'| Column | Link |',
	'| --- | --- |',
	'| x | [[Plan]] |',
	'```',
	'[[Plan]] in code stays',
	'```',
	'Inline `[[Plan]]` stays.',
].join('\n');

function encryptSample(): string {
	const result = rewriteLinksForEncryption(SOURCE, findLinkSpans(SOURCE), linkpath =>
		['Plan', 'Projects/Plan', 'Projects/Plan.md'].includes(linkpath) ? FILE : null,
	);
	ok(result != null, 'spans match');
	return result!.text;
}

test('links to encrypted notes point to their random names', () => {
	const out = encryptSample();
	ok(out.includes(`See [[${FILE}|Plan]] and [[${FILE}#Costs|the costs]].`), out);
	ok(out.includes('![[Photo.png]]'), 'other embeds untouched');
	ok(out.includes('[Web](https://example.com/Plan.md)'), 'external untouched');
	ok(out.includes(`[Budget](${FILE}#Total%20costs)`), 'markdown link');
	ok(out.includes(`| x | [[${FILE}\\|Plan]] |`), 'escaped pipe in tables');
	ok(out.includes('```\n[[Plan]] in code stays\n```'), 'code block untouched');
	ok(out.includes('`[[Plan]]`'), 'inline code untouched');
});

test('stale link positions are detected', () => {
	const spans = findLinkSpans(SOURCE);
	eq(rewriteLinksForEncryption(SOURCE + ' ', spans, () => null) != null, true, 'same text ok');
	eq(rewriteLinksForEncryption('X' + SOURCE, spans, () => FILE), null);
});

test('decrypting restores readable links', () => {
	const target: DecryptedTarget = {
		linktext: 'Plan',
		mdPath: 'Projects/Plan.md',
		plainNames: ['Plan', 'Projects/Plan'],
	};
	const { text, changed } = rewriteLinksForDecryption(encryptSample(), id => (id === ID ? target : null));
	eq(changed, 4);
	ok(text.includes('See [[Plan]] and [[Plan#Costs|the costs]].'), text);
	ok(text.includes('[Budget](Projects/Plan.md#Total%20costs)'), 'markdown link');
	ok(text.includes('| x | [[Plan]] |'), 'table');
	const untouched = rewriteLinksForDecryption(`[[${FILE}|X]]`, () => null);
	eq(untouched, { text: `[[${FILE}|X]]`, changed: 0 });
});

test('decryption link pattern accepts every generated id', () => {
	for (let i = 0; i < 200; i++) {
		const id = randomId();
		const { changed } = rewriteLinksForDecryption(`[[${id}.${EXT}]] [a](${id}.${EXT})`, () => ({ linktext: 'N', mdPath: 'N.md', plainNames: ['N'] }));
		eq(changed, 2, id);
	}
});

export async function run(): Promise<number> {
	let failed = 0;
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`  ok    ${name}`);
		} catch (error) {
			failed++;
			console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
	return failed;
}
