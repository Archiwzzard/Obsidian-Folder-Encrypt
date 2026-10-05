// Minimal stand-in for the parts of the Obsidian API used by the pure modules under test.
export class Events {
	constructor() {
		this.handlers = new Map();
	}
	on(name, callback) {
		const list = this.handlers.get(name) ?? [];
		list.push(callback);
		this.handlers.set(name, list);
		return { name, callback };
	}
	off() {}
	offref() {}
	trigger(name, ...args) {
		for (const callback of this.handlers.get(name) ?? []) {
			callback(...args);
		}
	}
}
