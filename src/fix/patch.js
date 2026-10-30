import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { parseStrict } from '../scan/ast.js';

export class PatchError extends Error {}

// A tiny virtual file system over the target repo, so a chain of patches can
// be built and checked without touching the real files.
export class VirtualTree {
  constructor(readFile) {
    this.readFile = readFile;
    this.overrides = new Map();
  }
  get(file) {
    if (this.overrides.has(file)) return this.overrides.get(file);
    return this.readFile(file);
  }
  set(file, content) {
    this.overrides.set(file, content);
  }
  clone() {
    const t = new VirtualTree(this.readFile);
    for (const [k, v] of this.overrides) t.overrides.set(k, v);
    return t;
  }
}

export function safeRelPath(file) {
  const norm = path.posix.normalize(String(file).replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!norm || norm.startsWith('..') || path.posix.isAbsolute(norm) || norm.includes('\0')) {
    throw new PatchError(`Edit targets a path outside the repo: ${file}`);
  }
  return norm;
}

const countOccurrences = (hay, needle) => {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
};

// Apply find/replace edits on a copy of the tree. Returns the per-file
// before/after text and a unified diff. Throws PatchError with a message that
// can be fed back to the model.
export function applyEdits(tree, edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new PatchError('The patch has no edits.');
  const next = tree.clone();
  const touched = new Map();
  for (const [i, edit] of edits.entries()) {
    const file = safeRelPath(edit.file);
    const current = next.get(file);
    if (current == null) throw new PatchError(`Edit ${i + 1}: ${file} does not exist.`);
    const n = countOccurrences(current, edit.find);
    if (n === 0) throw new PatchError(`Edit ${i + 1}: the find text was not found in ${file}. Copy it exactly from the current file.`);
    if (n > 1) throw new PatchError(`Edit ${i + 1}: the find text occurs ${n} times in ${file}; include more surrounding lines so it is unique.`);
    if (!touched.has(file)) touched.set(file, current);
    next.set(file, current.replace(edit.find, () => edit.replace));
  }
  const files = [];
  for (const [file, before] of touched) {
    const after = next.get(file);
    if (/\.(m?js|cjs|jsx|tsx?)$/.test(file)) {
      try {
        parseStrict(after, file);
      } catch (err) {
        throw new PatchError(`After the edits, ${file} no longer parses: ${err.message}`);
      }
    }
    files.push({ file, before, after, diff: unifiedDiff(file, before, after) });
  }
  return { tree: next, files };
}

export function unifiedDiff(file, before, after) {
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after, '', '', { context: 3 })
    .split('\n')
    .filter((l) => !l.startsWith('====') && !l.startsWith('Index:'))
    .join('\n');
}
