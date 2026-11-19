// Optional maintainer bootstrap. Secrets travel over stdin/HTTPS, never argv or stdout.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const site = process.argv[2];
if (!site || !site.startsWith('https://')) throw new Error('Usage: node scripts/provision-pilot.mjs https://your-worker.workers.dev');
const local = resolve('.local');
await mkdir(local, { recursive: true, mode: 0o700 });
try { await access(resolve(local, 'pilot-provisioned.json')); throw new Error('Pilot connection already provisioned. Use the existing Keychain connection in the app.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let invitation;
try { invitation = (await readFile(resolve(local, 'owner-invitation'), 'utf8')).trim(); }
catch (error) { if (error.code !== 'ENOENT') throw error; invitation = randomBytes(32).toString('base64url'); await writeFile(resolve(local, 'owner-invitation'), invitation, { mode: 0o600, flag: 'wx' }); }

async function run(command, args, input) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes.toString(); });
  child.stderr.on('data', bytes => { output += bytes.toString(); });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error(`Provisioning step failed (${command}, exit ${code}). Review locally; no secrets have been printed.`);
}

await run(resolve('node_modules/.bin/wrangler'), ['secret', 'bulk'], JSON.stringify({ PILOT_INVITE: invitation }));
const response = await fetch(new URL('/api/collections', site), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: invitation }), redirect: 'error' });
if (response.status !== 201) throw new Error(`Could not create pilot collection (${response.status}).`);
const connection = await response.json();
await run(resolve('build/Passed Around.app/Contents/MacOS/PassedAround'), ['--pair-stdin'], JSON.stringify(connection));
await writeFile(resolve(local, 'pilot-provisioned.json'), JSON.stringify({ collectionId: connection.collectionId, siteURL: site, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
console.log('Pilot connection saved in macOS Keychain. No chat was scanned and no songs were published.');
