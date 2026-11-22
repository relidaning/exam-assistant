#!/usr/bin/env node
// Snapshot the database: node scripts/backup.mjs [destDir]   (default data/backups, keeps the newest 30)
// VACUUM INTO writes a consistent copy even while the app is running.
import fs from 'node:fs';
import path from 'node:path';
import { conn, DATA_DIR, DB_FILE } from '../lib/store.mjs';

const dest = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups'));
fs.mkdirSync(dest, { recursive: true });
const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); // name files by local time
const stamp = local.toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(dest, `exam-${stamp}.db`);
const db = conn();
const source = fs.realpathSync(DB_FILE());
const isSource = (candidate) => fs.realpathSync(candidate) === source;
if (fs.existsSync(file) && isSource(file)) throw new Error(`Backup destination is the active database: ${file}`);
if (fs.existsSync(file)) fs.rmSync(file);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

const old = fs.readdirSync(dest)
  .filter((f) => /^exam-.*\.db$/.test(f) && !isSource(path.join(dest, f)))
  .sort().slice(0, -30);
for (const f of old) fs.rmSync(path.join(dest, f));
if (old.length) console.log(`Removed ${old.length} old backup(s)`);
