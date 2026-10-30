import fs from 'node:fs';
import path from 'node:path';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.doctor', '.turbo', 'vendor']);
const SOURCE_EXT = /\.(m?js|cjs|jsx|tsx?|mts|cts)$/;
const MAX_BYTES = 400_000;

// Every source file plus package.json files, relative to root, sorted.
export function listFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (entry.isDirectory()) continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) visit(abs);
      } else if (entry.isFile() && (SOURCE_EXT.test(entry.name) || entry.name === 'package.json')) {
        if (/\.min\.js$/.test(entry.name)) continue;
        if (fs.statSync(abs).size > MAX_BYTES) continue;
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  return out.sort();
}

export function isTestFile(rel) {
  return /(^|\/)(__tests__|test|tests|spec)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

// Browser bundles: a client id there is expected, a secret is not.
export function isClientFile(rel, code) {
  return /(^|\/)(public|static|client|frontend|www)\//.test(rel) || /\bdocument\.|\bwindow\./.test(code.slice(0, 20000));
}
