import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.js';

export const DOCTOR_DIR = process.env.PAYPAL_DOCTOR_HOME || path.join(PROJECT_ROOT, '.doctor');

export function loadTargetConfig(root) {
  const file = path.join(root, 'paypal-doctor.json');
  const base = { name: path.basename(path.resolve(root)) };
  if (!fs.existsSync(file)) return { ...base, missing: true };
  return { ...base, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function reportPath(name) {
  return path.join(DOCTOR_DIR, name, 'report.json');
}

export function readReport(name) {
  const file = reportPath(name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function writeReport(report) {
  const file = reportPath(report.target.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  report.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(DOCTOR_DIR, 'latest.json'), JSON.stringify({ name: report.target.name, file }, null, 2));
  return file;
}

export function latestReport() {
  const pointer = path.join(DOCTOR_DIR, 'latest.json');
  if (!fs.existsSync(pointer)) return null;
  const { name } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  return readReport(name);
}
