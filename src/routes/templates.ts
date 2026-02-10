import express from 'express';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

router.use(authRequired, fetchCurrentUser);

const isAdminOrManager = (roles?: string[] | null) =>
  Array.isArray(roles) && roles.some((role) => role === 'admin' || role === 'manager');

// List resume templates for all authenticated users
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT rt.id,
              rt.title,
              rt.description,
              rt.created_by,
              rt.created_at,
              rt.updated_at,
              COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL) AS profile_count,
              COUNT(DISTINCT p.user_id) FILTER (WHERE p.deleted_at IS NULL) AS people_count
       FROM resume_templates rt
       LEFT JOIN profiles p ON p.resume_template_id = rt.id
       WHERE rt.deleted_at IS NULL
       GROUP BY rt.id
       ORDER BY rt.created_at DESC`
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// Create a resume template
router.post('/', async (req, res, next) => {
  const { title, name, description, code, html } = req.body || {};
  const finalTitle = title ?? name;
  const finalCode = code ?? html;

  if (!finalTitle || !finalCode) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO resume_templates (title, description, code, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, description, code, created_by, created_at, updated_at`,
      [finalTitle, description ?? null, finalCode, req.currentUser.id]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Get a single template (including code)
router.get('/:templateId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id,
              title,
              description,
              code,
              created_by,
              created_at,
              updated_at
       FROM resume_templates
       WHERE id = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.templateId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Update a resume template
router.patch('/:templateId', async (req, res, next) => {
  const { title, name, description, code, html } = req.body || {};
  const updates: string[] = [];
  const allowAll = isAdminOrManager(req.currentUser?.roles);
  const params: unknown[] = [req.params.templateId];
  let idx = params.length + 1;

  const resolvedTitle = title ?? name;
  const resolvedCode = code ?? html;

  if (resolvedTitle !== undefined) {
    updates.push(`title = $${idx}`);
    params.push(resolvedTitle);
    idx += 1;
  }
  if (description !== undefined) {
    updates.push(`description = $${idx}`);
    params.push(description ?? null);
    idx += 1;
  }
  if (resolvedCode !== undefined) {
    updates.push(`code = $${idx}`);
    params.push(resolvedCode);
    idx += 1;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  try {
    const { rows } = await query(
      `UPDATE resume_templates
       SET ${updates.join(', ')}
       WHERE id = $1 ${allowAll ? '' : 'AND created_by = $2'} AND deleted_at IS NULL
       RETURNING id, title, description, code, created_by, created_at, updated_at`,
      allowAll ? params : [...params, req.currentUser.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Soft delete template
router.delete('/:templateId', async (req, res, next) => {
  const allowAll = isAdminOrManager(req.currentUser?.roles);
  try {
    const { rowCount } = await query(
      `UPDATE resume_templates
       SET deleted_at = now()
       WHERE id = $1 ${allowAll ? '' : 'AND created_by = $2'} AND deleted_at IS NULL`,
      allowAll ? [req.params.templateId] : [req.params.templateId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
