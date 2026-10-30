// Materialise a patched tree as a real directory the app can run from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.doctor']);

export function makeWorkRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `paypal-doctor-${name}-`));
}

function nearestNodeModules(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    const nm = path.join(cur, 'node_modules');
    if (fs.existsSync(nm)) return nm;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function materialize(root, tree, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(b, { recursive: true });
        copy(a, b);
      } else if (entry.isFile()) {
        fs.copyFileSync(a, b);
      }
    }
  };
  copy(root, dest);
  for (const [file, content] of tree.overrides) {
    const abs = path.join(dest, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const nm = nearestNodeModules(root);
  if (nm) fs.symlinkSync(nm, path.join(dest, 'node_modules'), 'dir');
  return dest;
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
