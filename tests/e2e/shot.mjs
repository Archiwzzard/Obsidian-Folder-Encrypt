// Saves a screenshot of the Obsidian window: node shot.mjs <file.png>
import { connect } from './cdp.mjs';
import fs from 'fs';
const client = await connect();
const res = await client.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(process.argv[2], Buffer.from(res.result.data, 'base64'));
client.close();
console.log('saved', process.argv[2]);
