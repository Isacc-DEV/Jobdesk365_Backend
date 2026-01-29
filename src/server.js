import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import templateRoutes from './routes/templates.js';
import emailRoutes from './routes/email.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/profiles', profileRoutes);
app.use('/templates', templateRoutes);
app.use('/email', emailRoutes);

// Error handler
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
