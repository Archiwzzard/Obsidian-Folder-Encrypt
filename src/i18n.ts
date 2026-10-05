import { EXT, FOLDER_EXT, PLUGIN_NAME } from './constants';

const en = {
	ribbonOpenPanel: 'Open encrypted notes',
	statusUnlocked: '🔓 Unlocked',
	statusTooltip: 'Encrypted notes are unlocked – click to lock',
	statusAutoLock: 'Encrypted notes are unlocked – auto-lock in {min} min – click to lock',

	cmdUnlock: 'Unlock encrypted notes',
	cmdLock: 'Lock all encrypted notes',
	cmdOpenPanel: 'Open panel',
	cmdOpenNote: 'Open encrypted note…',
	cmdNewNote: 'New encrypted note',
	cmdEncryptNote: 'Encrypt current note (incl. file name)',
	cmdEncryptFolder: 'Encrypt folder of current note…',
	cmdDecryptNote: 'Decrypt current note permanently',

	menuRoot: 'Folder Encrypt',
	menuNewNote: 'New encrypted note',
	menuEncryptFolder: 'Encrypt folder (incl. file names)…',
	menuDecryptFolder: 'Decrypt folder permanently…',
	menuEncryptNote: 'Encrypt note (incl. file name)',
	menuEncryptSelected: 'Encrypt {n} {n|note|notes} (incl. {n|file name|file names})',
	menuConvertMeld: 'Encrypt file name too',
	menuDecryptNote: 'Decrypt permanently',
	menuLock: 'Lock all encrypted notes',
	menuUnlock: 'Unlock encrypted notes…',
	menuOpenPanel: 'Open encrypted notes panel',
	menuOpen: 'Open',
	menuOpenNewTab: 'Open in new tab',
	menuReveal: 'Reveal in file explorer',
	menuDelete: 'Delete',

	btnOk: 'OK',
	btnCancel: 'Cancel',
	btnSkip: 'Skip',
	btnUnlock: 'Unlock',
	btnEncrypt: 'Encrypt',
	btnEncryptN: 'Encrypt {n} {n|note|notes}',
	btnDecrypt: 'Decrypt',
	btnCreate: 'Create',
	btnClose: 'Close',
	btnDelete: 'Delete',

	pwTitleUnlock: 'Unlock encrypted notes',
	pwTitleNew: 'Choose a password',
	pwTitleFile: 'Password for “{name}”',
	pwPassword: 'Password',
	pwConfirm: 'Confirm password',
	pwHint: 'Password hint',
	pwHintDesc: 'Optional. Stored unencrypted in the files.',
	pwHintShown: 'Hint: {hint}',
	pwMismatch: 'The passwords do not match.',
	pwEmpty: 'Please enter a password.',
	pwWrong: 'Wrong password.',
	pwShow: 'Show password',
	pwForgetWarning: 'If you forget the password, the notes cannot be recovered – by anyone.',
	pwUseSession: 'Use the password that is already unlocked',
	pwMeldFile: 'The Meld note “{name}” uses a different password.',
	pwChecking: 'Checking…',

	efTitle: 'Encrypt folder “{folder}”',
	efIntro: `Content and file names are encrypted. Every note gets a random file name (like k3x9q2mf7a1b.${EXT}), and its real name is stored encrypted inside. Subfolders stay where they are and get random names too; their real names are stored encrypted inside them (folder.${FOLDER_EXT}). Nothing is moved or deleted. Notes are only decrypted in memory, never on disk.`,
	efNotes: 'Notes to encrypt',
	efMeldTag: 'Meld',
	efAlready: '{n} {n|note in this folder is|notes in this folder are} already encrypted, including {n|its file name|their file names}.',
	efFolders: '{n} {n|subfolder gets a random name|subfolders get random names}.',
	efOthers: 'These files cannot be encrypted and stay visible:',
	efNothing: 'There is nothing left to encrypt in this folder.',
	efSelectAll: 'All',
	efSelectNone: 'None',
	efNoneSelected: 'Select at least one note.',
	efLinkNote: 'Links between these notes keep working.',
	efLinkNoteAll: 'Links to these notes keep working, also from other notes (they are updated without asking).',

	nameTitleNew: 'New encrypted note',
	nameLabel: 'Name',
	nameDesc: 'Use “/” for subfolders, e.g. “Projects/Plan”. The name is stored encrypted.',
	nameErrEmpty: 'Please enter a name.',
	nameErrDot: 'Names must not start with a dot.',
	nameErrChars: 'These characters are not allowed: {chars}',
	nameErrLong: 'The name is too long.',

	decTitle: 'Decrypt permanently?',
	decFolderMsg: '{n} encrypted {n|note|notes} in “{folder}” will be turned back into {n|a normal note with its real name|normal notes with their real names}. Afterwards {n|it is|they are} stored unencrypted – readable by anything that can access your files (sync, backups, other apps and tools).',
	decFolderNames: 'Subfolders get their real names back.',
	decNoteMsg: '“{name}” will be turned back into a normal, unencrypted note.',
	decLockedHint: '{n} of them {n|is|are} locked. Unlock {n|it|them} first or {n|it is|they are} skipped.',

	delTitle: 'Delete encrypted note?',
	delMsg: '“{name}” will be deleted.',

	nEncrypted: '🔐 {n} {n|note|notes} encrypted',
	nDecrypted: '🔓 {n} {n|note|notes} decrypted',
	nEncryptedFolders: '🔐 {n} {n|note|notes} and {f} folder {f|name|names} encrypted',
	nDecryptedFolders: '🔓 {n} {n|note|notes} and {f} folder {f|name|names} decrypted',
	nProgressEncrypt: 'Encrypting {i}/{n}…',
	nProgressDecrypt: 'Decrypting {i}/{n}…',
	nLocked: '🔒 Encrypted notes locked',
	nUnlocked: '🔓 {n} encrypted {n|note|notes} unlocked',
	nNoMatch: 'This password does not fit any encrypted note.',
	nRenameDisabled: 'Encrypted notes cannot be renamed. To rename one, decrypt it permanently, rename it and encrypt it again.',
	nFolderRenameDisabled: 'Encrypted folders cannot be renamed. To rename one, decrypt it permanently, rename it and encrypt it again.',
	nMdRenameBlocked: 'This note is encrypted. Use “Decrypt permanently” instead of changing the file extension.',
	nInvalidFile: 'This file is not a valid encrypted note.',
	nDamaged: 'The note could not be decrypted (wrong key or damaged file).',
	nRecovered: `${PLUGIN_NAME}: completed {n} interrupted {n|operation|operations}.`,
	nInterruptedEncrypt: `${PLUGIN_NAME}: encrypting “{folder}” was interrupted. Notes that were not encrypted yet are still readable – encrypt them again.`,
	nBusy: 'Please wait – encrypting or decrypting is still running.',
	nNothingToDecrypt: 'There are no encrypted notes here.',
	nCreateFailed: 'Could not create the note: {error}',
	nFailed: `${PLUGIN_NAME}: {error}`,

	repTitle: `${PLUGIN_NAME} – result`,
	repDone: 'Done: {n}',
	repSkipped: 'Skipped',
	repFailed: 'Errors',
	repLeftFiles: 'These files were not encrypted and stay visible:',
	repNotePlaintext: 'Tip: Obsidian’s “File recovery” may still hold older unencrypted snapshots (Settings → File recovery → Clear history).',
	errWrongPassword: 'wrong password',
	errVerify: 'verification failed; the note was left unchanged',
	errLocked: 'locked',
	errNotEnvelope: 'not a valid encrypted note',
	errNameTaken: 'could not decrypt – “{folder}” already contains a folder or file named “{name}”. This folder stays encrypted, including everything in it. Rename the other one and decrypt again.',

	panelTitle: 'Encrypted notes',
	panelLocked: 'Locked',
	panelUnlocked: 'Unlocked',
	panelAutoLock: 'auto-lock in {min} min',
	panelEmpty: 'No encrypted notes yet. Right-click a folder → Folder Encrypt → Encrypt folder.',
	panelLockedCount: '{n} encrypted {n|note|notes} – unlock to see {n|its name|their names}',
	panelOtherPassword: 'Other password',

	swPlaceholder: 'Name of an encrypted note…',
	swEmpty: 'No unlocked encrypted notes.',

	setAutoLock: 'Auto-lock after (minutes)',
	setAutoLockDesc: 'Locks everything after this many minutes without activity. 0 = never.',
	setExplorer: 'Show real names in the file explorer',
	setExplorerDesc: 'While unlocked, the file explorer shows the real names instead of the random file names. Only the display changes; nothing is written to disk.',
	setConfirm: 'Confirm new passwords',
	setConfirmDesc: 'Ask twice when choosing a new password.',
	setUpdateLinks: 'Update links in other notes',
	setUpdateLinksDesc: 'When notes are encrypted or decrypted, links pointing to them are updated without asking. This also removes the real names from the linking notes. Off: those links are not changed (and stop working).',
	setInfoHeading: 'Good to know',
	setInfo1: `Encrypted notes are .${EXT} files; the real names of encrypted folders are in folder.${FOLDER_EXT} files. Obsidian Sync only syncs them with “Sync all other types” enabled.`,
	setInfo2: `The content is Meld Encrypt compatible: renaming a .${EXT} file to .mdenc opens it in Meld (without the hidden name).`,
	setInfo3: 'Passwords are kept in memory only and cannot be recovered.',
};

export type I18nKey = keyof typeof en;

/**
 * Text for `key`. `{name}` is replaced by `vars.name`; `{name|one|other}` picks `one` when
 * `vars.name` is 1 and `other` otherwise (English plural rule, so 0 is plural).
 */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
	let text: string = en[key];
	if (vars) {
		text = text.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_, name: string, one: string, other: string) =>
			Number(vars[name]) === 1 ? one : other,
		);
		for (const [name, value] of Object.entries(vars)) {
			text = text.split(`{${name}}`).join(String(value));
		}
	}
	return text;
}
