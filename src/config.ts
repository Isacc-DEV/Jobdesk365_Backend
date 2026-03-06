import dotenv from 'dotenv';

const nodeEnv = (process.env.NODE_ENV || 'development').trim();
const envFilePath = `.env.${nodeEnv}`;
const envLoadResult = dotenv.config({ path: envFilePath });
if (envLoadResult.error) {
  dotenv.config();
}

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
const includeDevOrigins =
  process.env.CORS_INCLUDE_DEV_ORIGINS === 'true' || nodeEnv !== 'production';

const extraCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOrigins = Array.from(
  new Set([defaultOrigin, ...(includeDevOrigins ? devOrigins : []), ...extraCorsOrigins])
);

const openAiApiKey = (process.env.OPENAI_API_KEY || '').trim();
const huggingFaceApiKey = (process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY || '').trim();
const preferredAiProvider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
const forceHuggingFace = preferredAiProvider === 'huggingface';
const forceOpenAi = preferredAiProvider === 'openai';

const aiProvider: 'openai' | 'huggingface' = forceOpenAi
  ? 'openai'
  : forceHuggingFace || (!openAiApiKey && Boolean(huggingFaceApiKey))
  ? 'huggingface'
  : 'openai';

const aiModel = aiProvider === 'huggingface'
  ? process.env.HUGGINGFACE_MODEL || process.env.OPENAI_MODEL || 'Qwen/Qwen2.5-7B-Instruct'
  : process.env.OPENAI_MODEL || 'gpt-4o-mini';

const aiBaseUrl = aiProvider === 'huggingface'
  ? process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/v1'
  : process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const aiApiKey = aiProvider === 'huggingface'
  ? huggingFaceApiKey || openAiApiKey
  : openAiApiKey || huggingFaceApiKey;

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
  openai: {
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  ai: {
    provider: 'openai' | 'huggingface';
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  supabase: {
    url: string;
    serviceRoleKey: string;
    avatarBucket: string;
  };
  nowpayments: {
    apiKey: string;
    ipnSecret: string;
    baseUrl: string;
    payCurrency: string;
    successUrl: string;
    cancelUrl: string;
    ipnCallbackUrl: string;
    topupMin: number;
    topupMax: number;
  };
  // Note: Supabase is optional, local file storage is used for avatars
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
  },
  openai: {
    apiKey: aiApiKey,
    model: aiModel,
    baseUrl: aiBaseUrl
  },
  ai: {
    provider: aiProvider,
    apiKey: aiApiKey,
    model: aiModel,
    baseUrl: aiBaseUrl
  },
  supabase: {
    url: (process.env.SUPABASE_URL || '').trim(),
    serviceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim(),
    avatarBucket: (process.env.SUPABASE_AVATAR_BUCKET || 'avatars').trim()
  },
  nowpayments: {
    apiKey: (process.env.NOWPAYMENTS_API_KEY || process.env.NOWPAYMENT_KEY || '').trim(),
    ipnSecret: (process.env.NOWPAYMENTS_IPN_SECRET || '').trim(),
    baseUrl: (process.env.NOWPAYMENTS_BASE_URL || 'https://api.nowpayments.io/v1').trim(),
    payCurrency: (process.env.NOWPAYMENTS_PAY_CURRENCY || 'usdtbsc').trim().toLowerCase(),
    successUrl: (process.env.NOWPAYMENTS_SUCCESS_URL || '').trim(),
    cancelUrl: (process.env.NOWPAYMENTS_CANCEL_URL || '').trim(),
    ipnCallbackUrl: (process.env.NOWPAYMENTS_IPN_CALLBACK_URL || '').trim(),
    topupMin: Number(process.env.NOWPAYMENTS_TOPUP_MIN || 1),
    topupMax: Number(process.env.NOWPAYMENTS_TOPUP_MAX || 10000)
  }
};
