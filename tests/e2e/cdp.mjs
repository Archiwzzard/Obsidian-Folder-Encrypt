// Tiny Chrome DevTools Protocol client to drive an Obsidian instance started with
// --remote-debugging-port. Usage: node cdp.mjs "<async js body>"   (prints the JSON result)
export async function connect(port = Number(process.env.CDP_PORT ?? 9333)) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = targets.find(t => t.type === 'page' && t.url.startsWith('app://obsidian.md'));
	if (!page) throw new Error('no Obsidian window found');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let nextId = 0;
	const pending = new Map();
	ws.onmessage = event => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
	};
	const send = (method, params = {}) => new Promise(resolve => {
		const id = ++nextId;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});
	async function evaluate(body) {
		const res = await send('Runtime.evaluate', { expression: `(async () => {\n${body}\n})()`, awaitPromise: true, returnByValue: true });
		if (res.error) throw new Error(JSON.stringify(res.error));
		if (res.result.exceptionDetails) {
			const d = res.result.exceptionDetails;
			throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
		}
		return res.result.result.value;
	}
	return { evaluate, send, close: () => ws.close() };
}

if (process.argv[1] && process.argv[1].endsWith('cdp.mjs') && process.argv[2]) {
	const client = await connect();
	try {
		const value = await client.evaluate(process.argv[2]);
		console.log(JSON.stringify(value, null, 2));
	} catch (error) {
		console.log('ERROR:', error.message);
		process.exitCode = 1;
	} finally {
		client.close();
	}
}
