import express from 'express';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

router.use(authRequired, fetchCurrentUser);

// List resume templates for the current user
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT rt.id,
              rt.title,
              rt.description,
              rt.created_by,
              rt.created_at,
              rt.updated_at,
              COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL AND p.user_id = $1) AS profile_count
       FROM resume_templates rt
       LEFT JOIN profiles p ON p.resume_template_id = rt.id
       WHERE rt.deleted_at IS NULL AND rt.created_by = $1
       GROUP BY rt.id
       ORDER BY rt.created_at DESC`,
      [req.currentUser.id]
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
