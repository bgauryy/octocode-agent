import fs from 'node:fs';
import path from 'node:path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodPortable(target: string, mode: number): void {
  if (process.platform !== 'win32') fs.chmodSync(target, mode);
}

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Private state directory must be a real directory: ${directory}`);
  chmodPortable(directory, PRIVATE_DIRECTORY_MODE);
}

export function hardenPrivateFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Private state path must be a regular file: ${file}`);
  chmodPortable(file, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomic(file: string, content: string): void {
  ensurePrivateDirectory(path.dirname(file));
  hardenPrivateFile(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', PRIVATE_FILE_MODE);
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
    hardenPrivateFile(file);
    try {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      // Directory fsync is unavailable on some platforms.
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* already moved or removed */ }
    throw error;
  }
}
