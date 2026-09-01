import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads .env into process.env.
 *
 * Imported for its side effect, and it must be the FIRST import in any entry
 * point, because config.ts validates required variables at module load. An
 * import placed after config.ts runs too late, and the process exits reporting
 * a variable that is sitting in the file unread.
 *
 * Next.js does this for core-web on its own. Node does not, which is why this
 * exists here and not there.
 *
 * Variables already present in the environment always win, so Coolify's
 * injected values (Section 12) are never overwritten by a stray .env file in a
 * deployment.
 */
const envPath = resolve(process.cwd(), '.env');

function parseAndApply(contents: string): void {
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // Already set wins.

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

if (existsSync(envPath)) {
  try {
    // process.loadEnvFile arrived in Node 20.12. This project targets Node 22,
    // but a machine with an older system Node earlier on PATH would otherwise
    // fail reporting a missing variable rather than a wrong Node version, which
    // is a genuinely confusing way to discover the real problem.
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
    } else {
      parseAndApply(readFileSync(envPath, 'utf8'));
    }
  } catch (error) {
    console.warn(
      `[env] could not read ${envPath}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
