import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import path from 'path';
import morgan from 'morgan';
import cors, { type CorsOptions } from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import profileRoutes, { createProfilesRouter } from './routes/profiles.js';
import templateRoutes from './routes/templates.js';
import emailRoutes from './routes/email.js';
import calendarRoutes from './routes/calendar.js';
import aiRoutes from './routes/ai.js';
import extensionRoutes from './routes/extension.js';
import applicationRoutes from './routes/applications.js';
import hireRoutes from './routes/hire.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import billingRoutes from './routes/billing.js';
import notificationsRoutes from './routes/notifications.js';
import { initChatRealtime } from './realtime/chatRealtime.js';
import { startNotificationScheduler } from './services/notificationScheduler.js';

const app = express();

const corsOptions: CorsOptions = config.cors.allowAll
  ? {
      origin: true,
      credentials: true
    }
  : {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
          return callback(null, true);
        }
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
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/billing', billingRoutes);
app.use('/payments', billingRoutes);
app.use('/payment', billingRoutes);

app.use('/auth', authRoutes);
app.use('/profiles', profileRoutes);
app.use('/manager/profiles', createProfilesRouter('manager'));
app.use('/admin/profiles', createProfilesRouter('admin'));
app.use('/templates', templateRoutes);
app.use('/email', emailRoutes);
app.use('/manager/email', emailRoutes);
app.use('/admin/email', emailRoutes);
app.use('/calendar', calendarRoutes);
app.use('/manager/calendar', calendarRoutes);
app.use('/admin/calendar', calendarRoutes);
app.use('/ai', aiRoutes);
app.use('/extension', extensionRoutes);
app.use('/applications', applicationRoutes);
app.use('/manager/applications', applicationRoutes);
app.use('/admin/applications', applicationRoutes);
app.use('/hire', hireRoutes);
app.use('/manager/hire', hireRoutes);
app.use('/admin/hire', hireRoutes);
app.use('/admin', adminRoutes);
app.use('/chat', chatRoutes);
app.use('/notifications', notificationsRoutes);

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
initChatRealtime(server);
startNotificationScheduler();

server.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
