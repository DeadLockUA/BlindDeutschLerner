#!/usr/bin/env node
// Deletes audio clips in public/audio that are no longer referenced by the manifest.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'public/course/audio-manifest.json'), 'utf8'));
const keep = new Set(manifest.map((e) => `${e.id}.ogg`));
let n = 0;
for (const f of readdirSync(join(ROOT, 'public/audio'))) {
  if (f.endsWith('.ogg') && !keep.has(f)) {
    unlinkSync(join(ROOT, 'public/audio', f));
    n++;
  }
}
console.log(`removed ${n} unreferenced clips`);
