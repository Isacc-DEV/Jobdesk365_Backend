import express from 'express';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { canAccessManagerScope, isAdmin } from '../lib/accessControl.js';

const router = express.Router();
type RouteScope = 'user' | 'manager' | 'admin';

let applicationsSchemaPromise: Promise<void> | null = null;
const getRouteScope = (baseUrl: string | undefined): RouteScope => {
  if (!baseUrl) return 'user';
  if (baseUrl.startsWith('/admin/')) return 'admin';
  if (baseUrl.startsWith('/manager/')) return 'manager';
  return 'user';
};

const getScopeContext = (req: express.Request) => {
  const scope = getRouteScope(req.baseUrl);
  return { scope, allowAll: scope !== 'user' };
};

const ensureApplicationsSchema = async () => {
  if (applicationsSchemaPromise) return applicationsSchemaPromise;
  applicationsSchemaPromise = (async () => {
    await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await query(`
      CREATE OR REPLACE FUNCTION set_row_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'applications'
            AND column_name = 'job_url'
        ) THEN
          DROP TABLE applications;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'bid_statuses'
        ) AND NOT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'applications'
        ) THEN
          ALTER TABLE bid_statuses RENAME TO applications;
        END IF;
      END
      $$;
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS applications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url text NOT NULL,
        bids jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT applications_user_url_unique UNIQUE (user_id, url)
      )
    `);
    await query(`
      DROP TRIGGER IF EXISTS trg_bid_statuses_updated_at ON applications;
      DROP TRIGGER IF EXISTS trg_applications_updated_at ON applications;
      CREATE TRIGGER trg_applications_updated_at
      BEFORE UPDATE ON applications
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications (user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_applications_updated_at ON applications (updated_at DESC)`);
  })();

  try {
    await applicationsSchemaPromise;
  } catch (err) {
    applicationsSchemaPromise = null;
    throw err;
  }

  return applicationsSchemaPromise;
};


const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const toIsoString = (value: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isDateOnly(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toEndOfDayIso = (value: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isDateOnly(trimmed)) {
    return `${trimmed}T23:59:59.999Z`;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const normalizeBids = (value: unknown) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const getLatestBidTimestamp = (bids: any[]) => {
  for (const bid of bids) {
    if (!bid?.timestamp) continue;
    const parsed = new Date(bid.timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
};

router.use(authRequired, fetchCurrentUser);
router.use((req, res, next) => {
  const scope = getRouteScope(req.baseUrl);
  if (scope === 'admin' && !isAdmin(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'admin_required' });
  }
  if (scope === 'manager' && !canAccessManagerScope(req.currentUser)) {
    return res.status(403).json({ error: 'manager_required' });
  }
  return next();
});
router.use(async (_req, _res, next) => {
  try {
    await ensureApplicationsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  const { q, from, to } = req.query || {};
  const fromIso = typeof from === 'string' ? toIsoString(from) : null;
  const toIso = typeof to === 'string' ? toEndOfDayIso(to) : null;
  const { allowAll } = getScopeContext(req);

  try {
    const params: Array<string | string[]> = [];
    let whereClause = '1=1';
    if (!allowAll) {
      const { rows: visibleProfiles } = await query(
        `SELECT id
         FROM profiles
         WHERE (user_id = $1 OR assigned_bidder_user_id = $1) AND deleted_at IS NULL`,
        [req.currentUser.id]
      );
      const visibleProfileIds = visibleProfiles.map((row) => row.id).filter(Boolean);
      const hasVisibleProfiles = visibleProfileIds.length > 0;

      params.push(req.currentUser.id);
      whereClause = 'a.user_id = $1';
      if (hasVisibleProfiles) {
        params.push(visibleProfileIds);
        whereClause =
          `a.user_id = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.bids) AS bid WHERE bid->>'profile_id' = ANY($2::text[]))`;
      }
    }

    const { rows } = await query(
      `SELECT a.id,
              a.user_id,
              a.url,
              a.bids,
              a.created_at,
              a.updated_at,
              u.email AS user_email,
              u.username AS user_username,
              u.display_name AS user_display_name
       FROM applications a
       JOIN users u ON u.id = a.user_id
       WHERE ${whereClause}
       ORDER BY a.updated_at DESC, a.id DESC`,
      params
    );

    const profileIds = new Set<string>();
    rows.forEach((row) => {
      normalizeBids(row.bids).forEach((bid: any) => {
        const profileId = bid?.profile_id ?? bid?.profileId;
        if (profileId) {
          profileIds.add(String(profileId));
        }
      });
    });

    const profileIdList = Array.from(profileIds);
    const profileOwners = new Map<
      string,
      {
        user_id: string;
        username: string | null;
        email: string | null;
        display_name: string | null;
        assigned_bidder_user_id: string | null;
      }
    >();

    if (profileIdList.length) {
      const { rows: profileRows } = await query(
        `SELECT p.id, p.user_id, p.assigned_bidder_user_id, u.username, u.email, u.display_name
         FROM profiles p
         JOIN users u ON u.id = p.user_id
         WHERE p.id = ANY($1::uuid[])`,
        [profileIdList]
      );
      profileRows.forEach((row) => {
        profileOwners.set(row.id, {
          user_id: row.user_id,
          username: row.username,
          email: row.email,
          display_name: row.display_name,
          assigned_bidder_user_id: row.assigned_bidder_user_id
        });
      });
    }

    const queryText = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const fromMs = fromIso ? new Date(fromIso).getTime() : null;
    const toMs = toIso ? new Date(toIso).getTime() : null;

    const items = rows
      .map((row) => {
        const bids = normalizeBids(row.bids)
          .filter(Boolean)
          .sort((a: any, b: any) => {
            const aTime = new Date(a?.timestamp || 0).getTime();
            const bTime = new Date(b?.timestamp || 0).getTime();
            return bTime - aTime;
          })
          .map((bid: any) => {
            const profileId = bid?.profile_id ?? bid?.profileId;
            const owner = profileId ? profileOwners.get(String(profileId)) : null;
            const ownerName =
              owner?.username || owner?.display_name || owner?.email || null;
            const canReport = allowAll ||
              owner?.user_id === req.currentUser.id ||
              owner?.assigned_bidder_user_id === req.currentUser.id;
            return {
              ...bid,
              profile_owner_id: owner?.user_id ?? null,
              profile_owner_username: ownerName,
              can_report: canReport
            };
          });
        return {
          id: row.id,
          user_id: row.user_id,
          url: row.url,
          bids,
          created_at: row.created_at,
          updated_at: row.updated_at,
          user_email: row.user_email,
          user_username: row.user_username,
          user_display_name: row.user_display_name,
          is_owner: row.user_id === req.currentUser.id,
          latest_applied_at: getLatestBidTimestamp(bids)
        };
      })
      .filter((row) => {
        if (!queryText) return true;
        const urlMatch = row.url?.toLowerCase().includes(queryText);
        const profileMatch = row.bids?.some((bid: any) =>
          String(bid?.profile_name || bid?.profile_id || '').toLowerCase().includes(queryText)
        );
        return urlMatch || profileMatch;
      })
      .filter((row) => {
        if (!fromMs && !toMs) return true;
        const matchesBid = row.bids?.some((bid: any) => {
          const ts = new Date(bid?.timestamp || '').getTime();
          if (Number.isNaN(ts)) return false;
          if (fromMs && ts < fromMs) return false;
          if (toMs && ts > toMs) return false;
          return true;
        });
        return Boolean(matchesBid);
      })
      .sort((a, b) => {
        const aTime = a.latest_applied_at ? new Date(a.latest_applied_at).getTime() : 0;
        const bTime = b.latest_applied_at ? new Date(b.latest_applied_at).getTime() : 0;
        return bTime - aTime;
      });

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/:applicationId/open', async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  try {
    const { rows } = await query(
      `SELECT url
       FROM applications
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'}
       LIMIT 1`,
      allowAll ? [req.params.applicationId] : [req.params.applicationId, req.currentUser.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ url: rows[0].url });
  } catch (err) {
    next(err);
  }
});

router.delete('/:applicationId', async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  try {
    const { rowCount } = await query(
      `DELETE FROM applications
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'}`,
      allowAll ? [req.params.applicationId] : [req.params.applicationId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;

