/**
 * GET /api/sync         — return { projects, folders, groups } for the signed-in user
 * PUT /api/sync         — replace all user data (full snapshot from client)
 *
 * The client treats this as a single blob endpoint: on first sign-in it does
 * GET to load, on every change it debounces and PUTs the snapshot. This keeps
 * sync trivially correct (last-write-wins per user) and avoids needing per-row
 * diff logic.
 */
import { getSql, ensureSchema, getUserFromReq } from '../lib/auth.js';

export default async function handler(req, res) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not signed in' });

  try {
    const sql = await getSql();
    await ensureSchema();
    const userId = user.sub;

    if (req.method === 'GET') {
      const [projects, folders, groups] = await Promise.all([
        sql`SELECT id, name, folder_id, group_id, data, thumb, EXTRACT(EPOCH FROM modified) * 1000 AS modified
            FROM projects WHERE user_id = ${userId} ORDER BY modified DESC`,
        sql`SELECT id, name FROM folders WHERE user_id = ${userId}`,
        sql`SELECT id, name, color, brand_kit FROM groups WHERE user_id = ${userId}`,
      ]);
      return res.status(200).json({
        ok: true,
        projects: projects.rows.map(r => ({
          id: r.id, name: r.name,
          folderId: r.folder_id, groupId: r.group_id,
          data: r.data, thumb: r.thumb,
          modified: Number(r.modified),
        })),
        folders: folders.rows,
        groups: groups.rows.map(r => ({
          id: r.id, name: r.name, color: r.color, brandKit: r.brand_kit,
        })),
      });
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
      const { projects = [], folders = [], groups = [] } = body;

      // Size cap — refuse ridiculous payloads (Vercel default is 4.5MB anyway)
      const approxJson = JSON.stringify(body);
      if (approxJson.length > 4_000_000) {
        return res.status(413).json({ ok: false, error: 'Payload too large' });
      }

      // Wipe + insert in a transaction-ish sequence
      await sql`DELETE FROM projects WHERE user_id = ${userId}`;
      await sql`DELETE FROM folders WHERE user_id = ${userId}`;
      await sql`DELETE FROM groups WHERE user_id = ${userId}`;

      for (const f of folders) {
        await sql`INSERT INTO folders (id, user_id, name) VALUES (${f.id}, ${userId}, ${f.name})`;
      }
      for (const g of groups) {
        await sql`INSERT INTO groups (id, user_id, name, color, brand_kit)
                  VALUES (${g.id}, ${userId}, ${g.name}, ${g.color}, ${JSON.stringify(g.brandKit || null)})`;
      }
      for (const p of projects) {
        const modified = p.modified ? new Date(p.modified).toISOString() : new Date().toISOString();
        await sql`INSERT INTO projects (id, user_id, name, folder_id, group_id, data, thumb, modified)
                  VALUES (${p.id}, ${userId}, ${p.name}, ${p.folderId || null}, ${p.groupId || null}, ${JSON.stringify(p.data)}, ${p.thumb || null}, ${modified})`;
      }
      return res.status(200).json({ ok: true, saved: projects.length });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
}
