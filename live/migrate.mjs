import { chmodSync, linkSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.mjs';

class MigrationError extends Error {}

function requireFile(file) {
  if (!lstatSync(file, {throwIfNoEntry: false})?.isFile()) {
    throw new MigrationError('A required database file is missing or is not a regular file.');
  }
}

function snapshot(source, output) {
  requireFile(source);
  const db = new DatabaseSync(source, {readOnly: true});
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workspaces'").get() ||
        !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='requests'").get()) {
      throw new MigrationError('The source is not an Airport workspace database.');
    }
    // SQLite reads a consistent view of the main file and its committed WAL.
    db.prepare('VACUUM INTO ?').run(output);
    chmodSync(output, 0o600);
  } finally {
    db.close();
  }
}

export function exportSnapshot(source, output) {
  const temporary = mkdtempSync(join(dirname(output), '.airport-export-'));
  try {
    const copy = join(temporary, 'copy.sqlite3');
    snapshot(source, copy);
    linkSync(copy, output); // Atomic publication, fails if the destination exists.
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}

function tenantFile(env, ownerGateway) {
  if (!env.AIRPORT_AGENT_BASE || !isAbsolute(env.AIRPORT_HOSTED_DATA_DIR || '')) {
    throw new MigrationError('Set AIRPORT_AGENT_BASE and an absolute AIRPORT_HOSTED_DATA_DIR on the host.');
  }
  let base, url;
  try {
    base = new URL(env.AIRPORT_AGENT_BASE);
    url = new URL(ownerGateway);
  } catch {
    throw new MigrationError('Supply the gateway URL from the signed-in owner console.');
  }
  const prefix = base.pathname.replace(/\/$/, '') + '/gateway/';
  const match = /^([a-f0-9]{64})(?:\/airport\/connect|\/mcp)?$/.exec(url.pathname.slice(prefix.length));
  if ([url, base].some(u => u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) ||
      url.origin !== base.origin || !url.pathname.startsWith(prefix) || !match) {
    throw new MigrationError('The owner gateway URL must match the configured HTTPS agent endpoint.');
  }
  const dir = join(env.AIRPORT_HOSTED_DATA_DIR, 'tenants');
  if (!lstatSync(dir, {throwIfNoEntry: false})?.isDirectory()) {
    throw new MigrationError('Sign in to the hosted owner console to initialize its tenant.');
  }
  const file = join(dir, match[1] + '.sqlite3');
  requireFile(file);
  return file;
}

function tables(db, schema) {
  return db.prepare("SELECT name FROM " + schema + ".sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all().map(row => row.name);
}

function copyToEmptyTenant(target, incoming, blank) {
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;');
    db.prepare('ATTACH DATABASE ? AS incoming').run(incoming);
    db.prepare('ATTACH DATABASE ? AS blank').run(blank);
    // Hold the destination write lock from the first comparison through commit.
    db.exec('BEGIN IMMEDIATE;');
    const expected = tables(db, 'blank');
    for (const schema of ['main', 'incoming']) {
      if (JSON.stringify(tables(db, schema)) !== JSON.stringify(expected) ||
          db.prepare("SELECT 1 FROM " + schema + ".sqlite_schema WHERE type IN ('trigger','view') LIMIT 1").get()) {
        throw new MigrationError('These Airport database schemas are incompatible. Use the matching application release.');
      }
    }
    if (db.prepare('PRAGMA incoming.quick_check').get().quick_check !== 'ok' ||
        db.prepare('PRAGMA incoming.foreign_key_check').get()) {
      throw new MigrationError('The snapshot failed its integrity checks.');
    }
    for (const table of expected) {
      // Identifiers come from a clean database initialized by this release.
      const configured = db.prepare('SELECT * FROM main.' + table + ' EXCEPT SELECT * FROM blank.' + table + ' LIMIT 1').get();
      const missing = db.prepare('SELECT * FROM blank.' + table + ' EXCEPT SELECT * FROM main.' + table + ' LIMIT 1').get();
      if (configured || missing) {
        throw new MigrationError('The destination already contains workspace data. Import requires a newly initialized tenant.');
      }
      const fields = schema => db.prepare('SELECT name FROM pragma_table_info(?, ?) ORDER BY cid')
        .all(table, schema).map(column => column.name);
      if (JSON.stringify(fields('incoming')) !== JSON.stringify(fields('main'))) {
        throw new MigrationError('The snapshot columns are incompatible with the hosted service.');
      }
    }
    // The two untouched starter workspace rows were verified above.
    db.exec('DELETE FROM main.workspaces');
    const parents = ['workspaces', 'catalog_connections', 'requests'];
    for (const table of [...parents, ...expected.filter(name => !parents.includes(name))]) {
      db.exec('INSERT INTO main.' + table + ' SELECT * FROM incoming.' + table);
    }
    if (db.prepare('PRAGMA main.foreign_key_check').get()) throw new MigrationError('The imported records failed validation.');
    db.exec('COMMIT');
  } finally {
    // Closing also rolls back a failed import before releasing its write lock.
    db.close();
  }
}

export function importSnapshot(source, ownerGateway, env = process.env) {
  const target = tenantFile(env, ownerGateway);
  const dir = mkdtempSync(join(dirname(target), '.airport-import-'));
  try {
    const copy = join(dir, 'copy.sqlite3'), blank = join(dir, 'blank.sqlite3');
    snapshot(source, copy);
    // Apply supported schema upgrades to the private copy, leaving the export intact.
    createStore(copy, {recoverOnOpen: false}).close();
    createStore(blank).close();
    copyToEmptyTenant(target, copy, blank);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  try {
    const [action, first, second, ...extra] = process.argv.slice(2);
    if (extra.length || !first || !second || !['export','import'].includes(action)) {
      throw new MigrationError('Usage: node live/migrate.mjs export SOURCE SNAPSHOT or import SNAPSHOT OWNER_GATEWAY_URL');
    }
    if (action === 'export') exportSnapshot(first, second);
    else importSnapshot(first, second);
    console.log(action === 'export' ? 'Airport snapshot created.' : 'Airport workspace migration committed.');
  } catch (error) {
    // Provider IDs, account names, credentials and filesystem paths stay out of output.
    const message = error instanceof MigrationError ? error.message :
      error.code === 'EEXIST' ? 'The output already exists. Choose a new snapshot filename.' :
      error.errcode === 5 ? 'The database is busy. Pause writes and retry.' :
      'Migration failed. Check file access, SQLite compatibility, and available disk space.';
    console.error(message);
    process.exitCode = 1;
  }
}
