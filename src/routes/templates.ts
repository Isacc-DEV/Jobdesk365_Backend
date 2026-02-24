import express from 'express';
import { chromium, type Browser } from 'playwright';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { notifyResumeTemplateAdded } from '../services/notifications.js';

const router = express.Router();

router.use(authRequired, fetchCurrentUser);

const isAdminOrManager = (roles?: string[] | null) =>
  Array.isArray(roles) && roles.some((role) => role === 'admin' || role === 'manager');

const buildSafePdfFilename = (value?: string) => {
  const base =
    String(value || 'resume')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ') || 'resume';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
};

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
    try {
      await notifyResumeTemplateAdded(rows[0].title);
    } catch (notifyErr) {
      console.error('[notifications] resume template event failed', notifyErr);
    }
    return res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Render template HTML to a one-page PDF sized to the content canvas.
router.post('/render-pdf', async (req, res) => {
  const html = typeof req.body?.html === 'string' ? req.body.html.trim() : '';
  const fileName = buildSafePdfFilename(req.body?.filename);

  if (!html) {
    return res.status(400).json({ error: 'missing_html' });
  }
  if (html.length > 2_000_000) {
    return res.status(413).json({ error: 'template_too_large' });
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.emulateMedia({ media: 'screen' });

    const size = await page.evaluate(() => {
      const body = document.body;
      const doc = document.documentElement;
      const candidates = body ? Array.from(body.children) : [];
      let target: Element = body || doc;
      let bestArea = 0;

      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          target = element;
        }
      }

      const targetEl = target as HTMLElement;
      if (targetEl?.style) {
        targetEl.style.margin = '0';
      }
      if (doc?.style) {
        doc.style.margin = '0';
        doc.style.padding = '0';
      }
      if (body?.style) {
        body.style.margin = '0';
        body.style.padding = '0';
      }

      const rect = target.getBoundingClientRect();
      const width = Math.max(1, Math.ceil(rect.width));
      const height = Math.max(1, Math.ceil(rect.height));

      if (body?.style) {
        body.style.width = `${width}px`;
        body.style.height = `${height}px`;
        body.style.overflow = 'hidden';
      }
      if (doc?.style) {
        doc.style.width = `${width}px`;
        doc.style.height = `${height}px`;
        doc.style.overflow = 'hidden';
      }

      return { width, height };
    });

    const pdfWidth = Math.max(1, Math.ceil(size.width));
    const pdfHeight = Math.max(1, Math.ceil(size.height));
    const pdf = await page.pdf({
      width: `${pdfWidth}px`,
      height: `${pdfHeight}px`,
      printBackground: true,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(pdf);
  } catch (err) {
    console.error('[templates] render-pdf failed', err);
    return res.status(500).json({ error: 'pdf_render_failed' });
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
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
