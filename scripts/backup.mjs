#!/usr/bin/env node
// Snapshot the database: node scripts/backup.mjs [destDir]   (default data/backups, keeps the newest 30)
// VACUUM INTO writes a consistent copy even while the app is running.
import fs from 'node:fs';
import path from 'node:path';
import { conn, DATA_DIR } from '../lib/store.mjs';

const dest = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups'));
fs.mkdirSync(dest, { recursive: true });
const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); // name files by local time
const stamp = local.toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(dest, `exam-${stamp}.db`);
if (fs.existsSync(file)) fs.rmSync(file);
conn().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

const old = fs.readdirSync(dest).filter((f) => /^exam-.*\.db$/.test(f)).sort().slice(0, -30);
for (const f of old) fs.rmSync(path.join(dest, f));
if (old.length) console.log(`Removed ${old.length} old backup(s)`);
