import express, { type NextFunction, type Request, type Response } from 'express';
import morgan from 'morgan';
import cors, { type CorsOptions } from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import templateRoutes from './routes/templates.js';
import emailRoutes from './routes/email.js';

const app = express();

const corsOptions: CorsOptions = config.cors.allowAll
  ? {
      origin: true,
      credentials: true
    }
  : {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (config.cors.origins.includes(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type']
    };

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/profiles', profileRoutes);
app.use('/templates', templateRoutes);
app.use('/email', emailRoutes);

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
