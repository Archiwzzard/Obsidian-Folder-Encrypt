# Folder Encrypt

A companion to [Meld Encrypt](https://github.com/meld-cp/obsidian-encrypt) for Obsidian. Meld Encrypt
encrypts the content of notes; Folder Encrypt also encrypts their **file names**, and it encrypts
**whole folders** at once. Both plugins use the same file format, so the content of every note stays
readable with Meld Encrypt. Meld Encrypt does not need to be installed.

Encrypted notes are only decrypted in memory; nothing readable is written to disk.

Folder Encrypt is an independent project and is not affiliated with Meld Encrypt or its author.

## Features

- **One menu entry**: right-click a note or folder → *Folder Encrypt* lists everything the plugin can
  do with it, plus the side panel. Encrypted notes and folders that contain some also offer unlock and
  lock.
- **Encrypt a folder** (*Folder Encrypt → Encrypt folder (incl. file names)…*): pick the notes,
  choose a password and an optional hint. Subfolders stay where they are and get random names too; the
  real name of each is stored encrypted inside it. Nothing is moved or deleted.
- **Encrypt single notes** or a multi-selection from the file menu or the command palette.
- Every encrypted note gets a random file name such as `k3x9q2mf7a1b.wzzcrypt`. The real name is stored
  encrypted inside the file.
- **Work normally while unlocked**: notes open in the regular Markdown editor, and saving encrypts
  right away. Real names of notes and folders appear in the tab and header titles, in the file explorer
  (display only) and in a sorted side panel.
- **No renaming** of encrypted notes and folders: renaming them (title, F2, file explorer or other
  plugins) is blocked and undone, so a readable name never ends up on disk. To rename one, decrypt it
  permanently, rename it and encrypt it again.
- **Links keep working** between encrypted notes and from other notes. Optionally, links in other notes
  are updated without asking.
- **Lock** manually, from the status bar or automatically after a period of inactivity (15 minutes by
  default).
- **Decrypt permanently** (a note or a folder) restores the real names of notes and subfolders, and the
  links. If a subfolder's real name is already taken by another folder or file next to it, that sub
  folder stays encrypted with everything in it, and the result tells you which name is in the way.
- **Crash safe**: the next time the plugin starts, it repairs an interrupted run and tells you if notes
  were left unencrypted.
- **Meld Encrypt compatible**: `.mdenc` notes can be encrypted in place, including their file name.
  Meld Encrypt does not need to be installed.

## Installation

Until the plugin is listed in Obsidian's community plugins: download `main.js`, `manifest.json` and
`styles.css` from the [latest release](https://github.com/Archiwzzard/Obsidian-Folder-Encrypt/releases/latest),
copy them into `<vault>/.obsidian/plugins/folder-encrypt/` and enable *Folder Encrypt* under
*Settings → Community plugins*.

## Privacy

- The plugin makes no network requests and collects no telemetry.
- It only reads and writes files inside your vault. Its settings (`data.json`) contain options and, after
  an interrupted run, the path of the affected folder – never passwords or note names.
- Passwords are kept in memory only and are forgotten when you lock or close Obsidian.

## File format

A `.wzzcrypt` file is JSON: `version` `"2.0"`, `hint` (plain text), `format` `"wzzcrypt/1"`,
`encodedName`, `encodedData`.

An encrypted folder contains a `folder.wzzfolder` file in the same format. Its `encodedName` holds the
folder's real name; `encodedData` is empty. The file explorer hides it. Decrypting the folder permanently
removes it once the folder has its real name back.

The cryptography is the same as Meld Encrypt 2.0: PBKDF2-SHA512 with 210,000 iterations → AES-256-GCM,
and the payload `iv | salt | ciphertext` is base64-encoded. Renaming a `.wzzcrypt` file to `.mdenc` opens
it in Meld Encrypt, without the hidden name.

## Limitations

- Only notes are encrypted: Markdown (`.md`) and Meld Encrypt notes (`.mdenc`, `.encrypted`). All other
  files – PDFs, images, `.txt`, Word documents, … – are not encrypted. They stay visible and are listed
  in the dialog and the result.
- The name of the encrypted folder itself stays visible; only the names of its subfolders are hidden.
- **Bookmarks are not encrypted.** Obsidian keeps them as plain text in `.obsidian/bookmarks.json`, and the
  plugin leaves them unchanged. Obsidian lets bookmarks of encrypted notes and folders follow the random
  names, but the text of a bookmarked heading and a bookmark's own title stay readable there. After
  decrypting permanently, all of them point to the real names again.
- Search, graph and backlinks cannot see encrypted content.
- Links inside an encrypted note that name a subfolder of an encrypted folder, such as
  `![[Projects/Scan.pdf]]`, do not resolve while the folder is encrypted (the plugin cannot update links
  inside encrypted content). Links by file name only, such as `![[Scan.pdf]]`, keep working.
- The file explorer sorts encrypted notes and folders by their random names. The side panel is sorted by
  real names.
- Obsidian Sync only syncs `.wzzcrypt` and `.wzzfolder` files with *Sync all other types* enabled.
- Obsidian's *File recovery* may still hold older unencrypted snapshots of notes that were encrypted later.
- Some features rely on Obsidian internals (explorer and tab titles, rename blocking, link prompt). If
  those change, the plugin falls back to showing the random names; the encryption itself is unaffected.
- Passwords are kept in memory only. A forgotten password cannot be recovered.
- Mobile: tested with Obsidian's mobile layout on a desktop computer, not yet on a real phone or tablet.
  The status bar does not exist on mobile; the side panel shows the lock state instead.

## Development

```bash
npm install
npm run build   # type check + bundle to main.js
npm test        # unit tests, incl. checks against Meld Encrypt's original crypto code
```

`tests/e2e/scenario.mjs` runs an end-to-end scenario against a real Obsidian instance started with
`--remote-debugging-port=9333` and a throw-away vault (`TEST_VAULT=<vault path>`). It deletes everything
in that vault – never point it at a real vault.

### Releasing

```bash
npm version patch   # or minor / major: updates package.json, manifest.json and versions.json, creates a tag
git push --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which builds and tests the plugin and creates a draft
GitHub release with `main.js`, `manifest.json` and `styles.css`. Review and publish the draft on GitHub.

## Credits

- [Meld Encrypt](https://github.com/meld-cp/obsidian-encrypt) by Cleon Pinto (MIT License): the file format
  and cryptography this plugin builds on. `tests/meld-reference/` contains unchanged copies of its crypto
  helpers, used only as a reference in tests.
- [monkey-around](https://github.com/pjeby/monkey-around) by PJ Eby (ISC License), bundled into the plugin.

## License

[MIT](LICENSE) © 2026 archiwzzard. Third-party code and its licenses are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
