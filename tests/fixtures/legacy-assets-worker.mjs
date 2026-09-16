// Local integration fixture: reproduce the pre-R2 schema without importing the
// current migration code. Never used by the production Worker.
import { DurableObject } from 'cloudflare:workers';

export class ProjectRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    for (const table of ['images', 'media']) {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL)`);
    }
    for (const table of ['image_chunks', 'media_chunks']) {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))`);
    }
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const table = pathname.endsWith('/images') ? 'images' : 'media';
    const chunks = table === 'images' ? 'image_chunks' : 'media_chunks';
    const bytes = new Uint8Array(await request.arrayBuffer());
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO ${table} (id, mime, size) VALUES (?, ?, ?)`, id, request.headers.get('Content-Type'), bytes.length);
      for (let offset = 0, part = 0; offset < bytes.length; offset += 128 * 1024, part++) {
        this.ctx.storage.sql.exec(`INSERT INTO ${chunks} (id, part, data) VALUES (?, ?, ?)`, id, part, bytes.slice(offset, offset + 128 * 1024));
      }
    });
    return Response.json({ src: `${pathname}/${id}` });
  }
}

export default {
  fetch(request, env) {
    const room = new URL(request.url).pathname.split('/')[3];
    return env.ROOMS.getByName(room).fetch(request);
  },
};
