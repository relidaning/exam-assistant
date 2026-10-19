#!/usr/bin/env node
// Fold a stray account into another: node scripts/merge-account.mjs --from <username> --into <username>
// Moves its Google/GitHub sign-ins and courses, then deletes it. Refuses if it has progress of its own. Back up first.
import { findUser, mergeAccount } from '../lib/store.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [from, into] = [findUser(arg('from')), findUser(arg('into'))];
if (!from || !into) { console.error('Usage: merge-account.mjs --from <username> --into <username> (both must exist)'); process.exit(1); }
try {
  const moved = mergeAccount(from.id, into.id);
  console.log(`Merged “${from.username}” into “${into.username}”: ${moved.identities} sign-in method(s), ${moved.courses} course(s) moved; “${from.username}” deleted.`);
} catch (e) { console.error(e.message); process.exit(1); }
