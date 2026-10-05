/** Name shown in notices and titles. */
export const PLUGIN_NAME = 'Folder Encrypt';

/** File extension of notes whose content AND name are encrypted. */
export const EXT = 'wzzcrypt';

/** Extension of the file inside an encrypted folder that holds the folder's real name (encrypted). */
export const FOLDER_EXT = 'wzzfolder';

/**
 * File name of that file. No leading dot: Obsidian Sync skips hidden files, and without this
 * file the folder's real name would be lost on other devices.
 */
export const FOLDER_MARKER = `folder.${FOLDER_EXT}`;

/** Marker written into every envelope so we can recognise our own files. */
export const FORMAT = 'wzzcrypt/1';

export const VIEW_TYPE_NOTE = 'folder-encrypt-note';
export const VIEW_TYPE_PANEL = 'folder-encrypt-panel';

/** Extensions used by Meld Encrypt for whole-note encryption. */
export const MELD_EXTENSIONS = ['mdenc', 'encrypted'];

export const ICON_NOTE = 'file-lock-2';
export const ICON_PANEL = 'folder-lock';
