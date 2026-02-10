import express from 'express';

const router = express.Router();

router.use((_req, res) => {
  res.json({ message: 'Coming Soon' });
});

export default router;
