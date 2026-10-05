import { Events } from 'obsidian';
import {
	base64ToBytes,
	bytesToBase64,
	decryptWithKey,
	deriveKey,
	encryptWithKey,
	newSalt,
	splitPayload,
} from './crypto/meld-crypto';

/**
 * A password the user has entered in this session, plus the keys derived from it.
 *
 * Deriving a key (PBKDF2, 210000 rounds) is slow, so keys are cached per salt and
 * everything encrypted in a session reuses one salt ("primary salt"). Opening and
 * saving notes is then instant. Every payload still carries its salt, so the result
 * stays readable by Meld Encrypt.
 */
export class Secret {
	private readonly keys = new Map<string, Promise<CryptoKey>>();
	private primarySalt: Uint8Array<ArrayBuffer> | null = null;

	constructor(readonly password: string, public hint: string) {}

	private keyFor(salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
		const id = bytesToBase64(salt);
		let key = this.keys.get(id);
		if (key == null) {
			key = deriveKey(this.password, salt);
			this.keys.set(id, key);
			key.catch(() => this.keys.delete(id));
		}
		return key;
	}

	async encrypt(plain: Uint8Array<ArrayBuffer>): Promise<string> {
		if (this.primarySalt == null) {
			this.primarySalt = newSalt();
		}
		const salt = this.primarySalt;
		return bytesToBase64(await encryptWithKey(await this.keyFor(salt), salt, plain));
	}

	/** Returns null if this secret cannot decrypt the payload. */
	async decrypt(base64: string): Promise<Uint8Array<ArrayBuffer> | null> {
		const payload = base64ToBytes(base64);
		const parts = payload == null ? null : splitPayload(payload);
		if (parts == null) {
			return null;
		}
		const plain = await decryptWithKey(await this.keyFor(parts.salt), parts);
		if (plain != null && this.primarySalt == null) {
			// adopt the salt of existing files so a later unlock needs only one key derivation
			this.primarySalt = parts.salt;
		}
		return plain;
	}
}

/**
 * Holds the passwords of the current session in memory only.
 * Events: 'change' (unlocked/locked/secret added).
 */
export class Session extends Events {
	private secrets: Secret[] = [];
	private lastActivity = Date.now();

	constructor(private readonly autoLockMinutes: () => number) {
		super();
	}

	get isUnlocked(): boolean {
		return this.secrets.length > 0;
	}

	/** Most recently added first. */
	get secretsList(): readonly Secret[] {
		return this.secrets;
	}

	find(password: string): Secret | undefined {
		return this.secrets.find(s => s.password === password);
	}

	/** Adds a verified secret. Returns the already known one if the password was entered before. */
	add(secret: Secret): Secret {
		const known = this.find(secret.password);
		if (known) {
			if (secret.hint && !known.hint) {
				known.hint = secret.hint;
			}
		} else {
			this.secrets.unshift(secret);
		}
		this.touch();
		this.trigger('change');
		return known ?? secret;
	}

	/**
	 * Forgets all passwords. Open views keep a reference to their secret until they are
	 * closed, so a save that is still running can finish.
	 */
	clear(): void {
		if (this.secrets.length === 0) {
			return;
		}
		this.secrets = [];
		this.trigger('change');
	}

	touch(): void {
		this.lastActivity = Date.now();
	}

	isAutoLockDue(): boolean {
		const minutes = this.autoLockMinutes();
		return this.isUnlocked && minutes > 0 && Date.now() - this.lastActivity >= minutes * 60_000;
	}

	minutesUntilAutoLock(): number | null {
		const minutes = this.autoLockMinutes();
		if (!this.isUnlocked || minutes <= 0) {
			return null;
		}
		const left = minutes * 60_000 - (Date.now() - this.lastActivity);
		return Math.max(0, Math.ceil(left / 60_000));
	}
}
