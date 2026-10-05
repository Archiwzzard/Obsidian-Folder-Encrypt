// Copied unchanged from Meld Encrypt (https://github.com/meld-cp/obsidian-encrypt),
// MIT License, Copyright (c) 2021 Cleon Pinto – see LICENSE in this folder.
// src/services/ICryptoHelper.ts at commit 8884651 - used only as a reference in tests.
export interface ICryptoHelper{
	encryptToBase64(text: string, password: string): Promise<string>;
	decryptFromBase64(base64Encoded: string, password: string): Promise<string|null>;
}