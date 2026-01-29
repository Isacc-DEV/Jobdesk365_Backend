import dotenv from 'dotenv';

dotenv.config();

const defaultScopes = [
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Calendars.Read'
].join(' ');

const outlookScopes = (process.env.MS_SCOPES || defaultScopes).split(' ').filter(Boolean);

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const defaultOrigin = (() => {
  try {
    return new URL(frontendUrl).origin;
  } catch {
    return frontendUrl;
  }
})();

const devOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const extraCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOrigins = Array.from(new Set([defaultOrigin, ...devOrigins, ...extraCorsOrigins]));

export type Config = {
  port: number;
  frontendUrl: string;
  cors: {
    allowAll: boolean;
    origins: string[];
  };
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: boolean;
  };
  jwt: {
    secret: string;
    expiresIn: string | number;
  };
  outlook: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
    redirectUri: string;
    scopes: string[];
  };
};

export const config: Config = {
  port: Number(process.env.PORT || 4000),
  frontendUrl,
  cors: {
    allowAll: process.env.CORS_ALLOW_ALL === 'true',
    origins: corsOrigins
  },
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME || 'jobdesk365',
    ssl: process.env.DB_SSL === 'true'
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  outlook: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    tenantId: process.env.MS_TENANT_ID || 'common',
    redirectUri: process.env.MS_REDIRECT_URI || 'http://localhost:4000/email/outlook/callback',
    scopes: outlookScopes
  }
};
