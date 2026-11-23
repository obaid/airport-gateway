import { createCatalog, parseProjectAuthConfigs } from './catalog.mjs';

// Run with the hosted project's environment. Only public names and slugs go to stdout.
const catalog = createCatalog(process.env.COMPOSIO_API_KEY, {
  authConfigs: parseProjectAuthConfigs(process.env.AIRPORT_AUTH_CONFIGS_JSON)
});
const seenCursors = new Set();
const apps = new Map();
let cursor;
do {
  const page = await catalog.listToolkits({ publicOnly: true, cursor });
  for (const { slug, name } of page.items) {
    if (apps.has(slug)) throw new Error('Duplicate application in the public catalog: ' + slug);
    apps.set(slug, { slug, name });
  }
  cursor = page.nextCursor;
  if (cursor && seenCursors.has(cursor)) throw new Error('Public catalog pagination did not advance.');
  if (cursor) seenCursors.add(cursor);
} while (cursor);
if (!apps.size) throw new Error('Public catalog returned no applications.');
process.stdout.write(JSON.stringify([...apps.values()]) + '\n');
