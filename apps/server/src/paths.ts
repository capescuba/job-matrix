import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '../../..');
export const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data');
export const RESUME_DIR = path.join(DATA_DIR, 'resumes');
export const MIGRATIONS_DIR = path.resolve(here, '../drizzle');
export const WEB_DIST = path.join(REPO_ROOT, 'apps', 'web', 'dist');
export const ENV_FILE = path.join(REPO_ROOT, '.env');
