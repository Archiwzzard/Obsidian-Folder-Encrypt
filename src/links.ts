/**
 * Keeps links between notes working when a set of notes is encrypted or decrypted.
 * Pure string functions (no Obsidian imports) so they can be unit tested.
 */

import { EXT } from './constants';

/** A link as reported by Obsidian's metadata cache. */
export interface LinkSpan {
	start: number;
	end: number;
	/** Exact source text, e.g. `[[Note#Heading|alias]]` or `[label](Note.md)`. */
	original: string;
	/** Link target without alias, decoded, may contain a `#subpath`. */
	link: string;
}

/** Ranges of fenced code blocks and inline code, where brackets are not links. */
function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const fence = /^(\s*)(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\s*\2[^\n]*(?=\n|$)|$)/gm;
	for (let m = fence.exec(text); m; m = fence.exec(text)) {
		ranges.push([m.index, m.index + m[0].length]);
	}
	const inline = /(`+)[^`\n]+?\1/g;
	for (let m = inline.exec(text); m; m = inline.exec(text)) {
		ranges.push([m.index, m.index + m[0].length]);
	}
	return ranges;
}

/**
 * Finds wiki links and markdown links outside of code. Fallback for when Obsidian's
 * metadata cache is not up to date with the text.
 */
export function findLinkSpans(text: string): LinkSpan[] {
	const code = codeRanges(text);
	const inCode = (pos: number) => code.some(([s, e]) => pos >= s && pos < e);
	const spans: LinkSpan[] = [];
	const wiki = /!?\[\[([^[\]\n]+?)\]\]/g;
	for (let m = wiki.exec(text); m; m = wiki.exec(text)) {
		if (inCode(m.index)) {
			continue;
		}
		const inner = m[1];
		const pipe = inner.search(/\\?\|/);
		spans.push({ start: m.index, end: m.index + m[0].length, original: m[0], link: (pipe < 0 ? inner : inner.slice(0, pipe)).trim() });
	}
	const md = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)\)/g;
	for (let m = md.exec(text); m; m = md.exec(text)) {
		if (inCode(m.index) || spans.some(s => m != null && m.index >= s.start && m.index < s.end)) {
			continue;
		}
		let url = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1];
		if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
			continue; // external link
		}
		try {
			url = decodeURI(url);
		} catch {
			// keep as written
		}
		spans.push({ start: m.index, end: m.index + m[0].length, original: m[0], link: url });
	}
	return spans;
}

export function splitSubpath(link: string): { path: string; subpath: string } {
	const idx = link.indexOf('#');
	return idx < 0 ? { path: link, subpath: '' } : { path: link.slice(0, idx), subpath: link.slice(idx) };
}

const WIKI_RE = /^(!?)\[\[([\s\S]*)\]\]$/;
const MD_RE = /^(!?)\[([\s\S]*?)\]\(([\s\S]*)\)$/;

function splitAlias(inner: string): { target: string; sep: string; alias: string | null } {
	const p = inner.indexOf('|');
	if (p < 0) {
		return { target: inner, sep: '', alias: null };
	}
	if (p > 0 && inner[p - 1] === '\\') {
		return { target: inner.slice(0, p - 1), sep: '\\|', alias: inner.slice(p + 1) };
	}
	return { target: inner.slice(0, p), sep: '|', alias: inner.slice(p + 1) };
}

function lineAt(text: string, offset: number): string {
	const start = text.lastIndexOf('\n', offset - 1) + 1;
	const end = text.indexOf('\n', offset);
	return text.slice(start, end < 0 ? text.length : end);
}

/**
 * Rewrites links that point to notes which are being encrypted so they point to the
 * new `<id>.wzzcrypt` files. The text the reader sees is kept as alias.
 *
 * @param resolve maps a link path to the new file name (e.g. `k3x9q2mf7a1b.wzzcrypt`) or null to keep the link
 * @returns null if a span does not match the text (stale metadata); nothing is rewritten then
 */
export function rewriteLinksForEncryption(
	text: string,
	spans: LinkSpan[],
	resolve: (linkpath: string) => string | null,
): { text: string; changed: number } | null {
	for (const span of spans) {
		if (text.slice(span.start, span.end) !== span.original) {
			return null;
		}
	}
	const sorted = [...spans].sort((a, b) => b.start - a.start);
	let out = text;
	let changed = 0;
	for (const span of sorted) {
		const { path, subpath } = splitSubpath(span.link);
		const target = resolve(path);
		if (target == null) {
			continue;
		}
		const inTable = lineAt(text, span.start).trimStart().startsWith('|');
		const replacement = buildEncryptedLink(span.original, target, subpath, inTable);
		if (replacement == null) {
			continue;
		}
		out = out.slice(0, span.start) + replacement + out.slice(span.end);
		changed++;
	}
	return { text: out, changed };
}

function buildEncryptedLink(original: string, target: string, subpath: string, inTable: boolean): string | null {
	const wiki = WIKI_RE.exec(original);
	if (wiki) {
		const [, bang, inner] = wiki;
		const { target: shown, sep, alias } = splitAlias(inner);
		const separator = sep || (inTable ? '\\|' : '|');
		return `${bang}[[${target}${subpath}${separator}${alias ?? shown}]]`;
	}
	const md = MD_RE.exec(original);
	if (md) {
		const [, bang, label] = md;
		return `${bang}[${label}](${target}${encodeURI(subpath)})`;
	}
	return null;
}

export interface DecryptedTarget {
	/** Link text for wiki links, e.g. `Plan` or `Projects/Plan` (no extension). */
	linktext: string;
	/** Path for markdown links incl. extension, e.g. `Plan.md`. */
	mdPath: string;
	/** Aliases equal to one of these are dropped, e.g. basename and full path without extension. */
	plainNames: string[];
}

// ids: see paths.ts (ID_CHAR_CLASS, ID_LENGTH) — kept literal here, checked by the unit tests
const WIKI_ID_RE = new RegExp(String.raw`(!?)\[\[([a-km-np-z2-9]{12})\.${EXT}(#[^\]|\\]*)?(?:(\\?\|)([^\]]*))?\]\]`, 'g');
const MD_ID_RE = new RegExp(String.raw`(!?)\[([^\]]*)\]\(([a-km-np-z2-9]{12})\.${EXT}(#[^)\s]*)?\)`, 'g');

/**
 * Rewrites links to `<id>.wzzcrypt` files that were just decrypted back to normal links.
 * @param resolve maps an id to its decrypted note, or null to keep the link unchanged
 */
export function rewriteLinksForDecryption(
	text: string,
	resolve: (id: string) => DecryptedTarget | null,
): { text: string; changed: number } {
	let changed = 0;
	let out = text.replace(WIKI_ID_RE, (match, bang: string, id: string, subpath: string | undefined, sep: string | undefined, alias: string | undefined) => {
		const target = resolve(id);
		if (target == null) {
			return match;
		}
		changed++;
		const sub = subpath ?? '';
		const keepAlias = alias != null && !target.plainNames.some(n => alias === n || alias === n + sub);
		return `${bang}[[${target.linktext}${sub}${keepAlias ? (sep ?? '|') + alias : ''}]]`;
	});
	out = out.replace(MD_ID_RE, (match, bang: string, label: string, id: string, subpath: string | undefined) => {
		const target = resolve(id);
		if (target == null) {
			return match;
		}
		changed++;
		return `${bang}[${label}](${encodeURI(target.mdPath)}${subpath ?? ''})`;
	});
	return { text: out, changed };
}
