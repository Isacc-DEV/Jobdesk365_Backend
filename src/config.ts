import dotenv from 'dotenv';

dotenv.config();

type AiProvider = 'openai' | 'huggingface';
type GroupState = 'none' | 'all' | 'partial';

const configErrors: string[] = [];

const readRaw = (name: string): string => {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
};

const hasValue = (name: string): boolean => readRaw(name).length > 0;

const addError = (name: string, message: string) => {
  configErrors.push(`${name}: ${message}`);
};

const requiredString = (name: string): string => {
  const value = readRaw(name);
  if (!value) {
    addError(name, 'is required');
    return '';
  }
  return value;
};

const optionalString = (name: string): string => readRaw(name);

const parseBooleanValue = (name: string, value: string): boolean | null => {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  addError(name, 'must be a boolean (true/false)');
  return null;
};

const requiredBoolean = (name: string): boolean => {
  const value = requiredString(name);
  if (!value) return false;
  const parsed = parseBooleanValue(name, value);
  return parsed ?? false;
};

const optionalBoolean = (name: string, defaultValue: boolean): boolean => {
  const value = optionalString(name);
  if (!value) return defaultValue;
  const parsed = parseBooleanValue(name, value);
  return parsed ?? defaultValue;
};

const requiredNumber = (
  name: string,
  options: {
    integer?: boolean;
    min?: number;
    max?: number;
  } = {}
): number => {
  const raw = requiredString(name);
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    addError(name, 'must be a valid number');
    return 0;
  }
  if (options.integer && !Number.isInteger(parsed)) {
    addError(name, 'must be an integer');
  }
  if (typeof options.min === 'number' && parsed < options.min) {
    addError(name, `must be >= ${options.min}`);
  }
  if (typeof options.max === 'number' && parsed > options.max) {
    addError(name, `must be <= ${options.max}`);
  }
  return parsed;
};

const optionalNumber = (
  name: string,
  defaultValue: number,
  options: {
    integer?: boolean;
    min?: number;
    max?: number;
  } = {}
): number => {
  const raw = optionalString(name);
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    addError(name, 'must be a valid number');
    return defaultValue;
  }
  if (options.integer && !Number.isInteger(parsed)) {
    addError(name, 'must be an integer');
  }
  if (typeof options.min === 'number' && parsed < options.min) {
    addError(name, `must be >= ${options.min}`);
  }
  if (typeof options.max === 'number' && parsed > options.max) {
    addError(name, `must be <= ${options.max}`);
  }
  return parsed;
};

const parseAbsoluteUrl = (name: string, value: string): string => {
  try {
    const parsed = new URL(value);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    addError(name, 'must be a valid absolute URL');
    return value;
  }
};

const requiredUrl = (name: string): string => {
  const value = requiredString(name);
  if (!value) return '';
  return parseAbsoluteUrl(name, value);
};

const optionalUrl = (name: string): string => {
  const value = optionalString(name);
  if (!value) return '';
  return parseAbsoluteUrl(name, value);
};

const requiredAliasString = (primaryName: string, aliasName: string): string => {
  const primary = optionalString(primaryName);
  if (primary) return primary;
  const alias = optionalString(aliasName);
  if (alias) return alias;
  addError(`${primaryName}/${aliasName}`, 'is required');
  return '';
};

const parseOrigins = (rawOrigins: string): string[] => {
  const values = rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const parsedOrigins: string[] = [];
  for (const value of values) {
    try {
      parsedOrigins.push(new URL(value).origin);
    } catch {
      addError('CORS_ORIGINS', `contains invalid URL: ${value}`);
    }
  }
  return Array.from(new Set(parsedOrigins));
};

const parseScopes = (rawScopes: string): string[] =>
  rawScopes
    .split(' ')
    .map((scope) => scope.trim())
    .filter(Boolean);

const validateAllOrNone = (
  groupName: string,
  fields: Array<{ name: string; present: boolean }>
): GroupState => {
  const present = fields.filter((field) => field.present);
  if (!present.length) return 'none';
  if (present.length === fields.length) return 'all';

  const missing = fields.filter((field) => !field.present).map((field) => field.name);
  addError(groupName, `partial configuration. Missing: ${missing.join(', ')}`);
  return 'partial';
};

const nodeEnv = optionalString('NODE_ENV') || 'development';

const port = requiredNumber('PORT', { integer: true, min: 1, max: 65535 });
const frontendUrl = requiredUrl('FRONTEND_URL');
const corsAllowAll = requiredBoolean('CORS_ALLOW_ALL');
const corsOrigins = parseOrigins(optionalString('CORS_ORIGINS'));
if (!corsAllowAll && corsOrigins.length === 0) {
  addError('CORS_ORIGINS', 'must include at least one origin when CORS_ALLOW_ALL=false');
}

const dbHost = requiredString('DB_HOST');
const dbPort = requiredNumber('DB_PORT', { integer: true, min: 1, max: 65535 });
const dbUser = requiredString('DB_USER');
const dbPassword = requiredString('DB_PASSWORD');
const dbName = requiredString('DB_NAME');
const dbSsl = requiredBoolean('DB_SSL');

const jwtSecret = requiredString('JWT_SECRET');
const jwtExpiresIn = requiredString('JWT_EXPIRES_IN');

const aiProviderRaw = requiredString('AI_PROVIDER').toLowerCase();
let aiProvider: AiProvider = 'openai';
if (aiProviderRaw === 'openai' || aiProviderRaw === 'huggingface') {
  aiProvider = aiProviderRaw;
} else {
  addError('AI_PROVIDER', 'must be either "openai" or "huggingface"');
}

let aiApiKey = '';
let aiModel = '';
let aiBaseUrl = '';

if (aiProvider === 'openai') {
  aiApiKey = requiredString('OPENAI_API_KEY');
  aiModel = requiredString('OPENAI_MODEL');
  aiBaseUrl = requiredUrl('OPENAI_BASE_URL');
} else {
  aiApiKey = requiredString('HUGGINGFACE_API_KEY');
  aiModel = requiredString('HUGGINGFACE_MODEL');
  aiBaseUrl = requiredUrl('HUGGINGFACE_BASE_URL');
}

const outlookGroupState = validateAllOrNone('OUTLOOK_OAUTH', [
  { name: 'MS_CLIENT_ID', present: hasValue('MS_CLIENT_ID') },
  { name: 'MS_CLIENT_SECRET', present: hasValue('MS_CLIENT_SECRET') },
  { name: 'MS_TENANT_ID', present: hasValue('MS_TENANT_ID') },
  { name: 'MS_REDIRECT_URI', present: hasValue('MS_REDIRECT_URI') },
  { name: 'MS_SCOPES', present: hasValue('MS_SCOPES') }
]);

const outlookEnabled = outlookGroupState === 'all';
let outlookClientId = '';
let outlookClientSecret = '';
let outlookTenantId = '';
let outlookRedirectUri = '';
let outlookScopes: string[] = [];

if (outlookEnabled) {
  outlookClientId = requiredString('MS_CLIENT_ID');
  outlookClientSecret = requiredString('MS_CLIENT_SECRET');
  outlookTenantId = requiredString('MS_TENANT_ID');
  outlookRedirectUri = requiredUrl('MS_REDIRECT_URI');
  outlookScopes = parseScopes(requiredString('MS_SCOPES'));
  if (!outlookScopes.length) {
    addError('MS_SCOPES', 'must contain at least one scope');
  }
}

const nowpaymentsGroupState = validateAllOrNone('NOWPAYMENTS', [
  {
    name: 'NOWPAYMENTS_API_KEY (or NOWPAYMENT_KEY)',
    present: hasValue('NOWPAYMENTS_API_KEY') || hasValue('NOWPAYMENT_KEY')
  },
  { name: 'NOWPAYMENTS_IPN_SECRET', present: hasValue('NOWPAYMENTS_IPN_SECRET') },
  { name: 'NOWPAYMENTS_BASE_URL', present: hasValue('NOWPAYMENTS_BASE_URL') },
  { name: 'NOWPAYMENTS_PAY_CURRENCY', present: hasValue('NOWPAYMENTS_PAY_CURRENCY') },
  { name: 'NOWPAYMENTS_SUCCESS_URL', present: hasValue('NOWPAYMENTS_SUCCESS_URL') },
  { name: 'NOWPAYMENTS_CANCEL_URL', present: hasValue('NOWPAYMENTS_CANCEL_URL') },
  { name: 'NOWPAYMENTS_IPN_CALLBACK_URL', present: hasValue('NOWPAYMENTS_IPN_CALLBACK_URL') },
  { name: 'NOWPAYMENTS_TOPUP_MIN', present: hasValue('NOWPAYMENTS_TOPUP_MIN') },
  { name: 'NOWPAYMENTS_TOPUP_MAX', present: hasValue('NOWPAYMENTS_TOPUP_MAX') }
]);

const nowpaymentsEnabled = nowpaymentsGroupState === 'all';
let nowpaymentsApiKey = '';
let nowpaymentsIpnSecret = '';
let nowpaymentsBaseUrl = '';
let nowpaymentsPayCurrency = '';
let nowpaymentsSuccessUrl = '';
let nowpaymentsCancelUrl = '';
let nowpaymentsIpnCallbackUrl = '';
let nowpaymentsTopupMin: number | null = null;
let nowpaymentsTopupMax: number | null = null;

if (nowpaymentsEnabled) {
  nowpaymentsApiKey = requiredAliasString('NOWPAYMENTS_API_KEY', 'NOWPAYMENT_KEY');
  nowpaymentsIpnSecret = requiredString('NOWPAYMENTS_IPN_SECRET');
  nowpaymentsBaseUrl = requiredUrl('NOWPAYMENTS_BASE_URL');
  nowpaymentsPayCurrency = requiredString('NOWPAYMENTS_PAY_CURRENCY').toLowerCase();
  nowpaymentsSuccessUrl = requiredUrl('NOWPAYMENTS_SUCCESS_URL');
  nowpaymentsCancelUrl = requiredUrl('NOWPAYMENTS_CANCEL_URL');
  nowpaymentsIpnCallbackUrl = requiredUrl('NOWPAYMENTS_IPN_CALLBACK_URL');
  nowpaymentsTopupMin = requiredNumber('NOWPAYMENTS_TOPUP_MIN', { min: 0.01 });
  nowpaymentsTopupMax = requiredNumber('NOWPAYMENTS_TOPUP_MAX', { min: nowpaymentsTopupMin });
}

const supabaseGroupState = validateAllOrNone('SUPABASE', [
  { name: 'SUPABASE_URL', present: hasValue('SUPABASE_URL') },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)',
    present: hasValue('SUPABASE_SERVICE_ROLE_KEY') || hasValue('SUPABASE_SECRET_KEY')
  },
  {
    name: 'SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)',
    present: hasValue('SUPABASE_PUBLISHABLE_KEY') || hasValue('SUPABASE_ANON_KEY')
  },
  { name: 'SUPABASE_AVATAR_BUCKET', present: hasValue('SUPABASE_AVATAR_BUCKET') }
]);

const supabaseEnabled = supabaseGroupState === 'all';
let supabaseUrl = '';
let supabaseServiceRoleKey = '';
let supabasePublishableKey = '';
let supabaseAvatarBucket = '';

if (supabaseEnabled) {
  supabaseUrl = requiredUrl('SUPABASE_URL');
  supabaseServiceRoleKey = requiredAliasString('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
  supabasePublishableKey = requiredAliasString('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
  supabaseAvatarBucket = requiredString('SUPABASE_AVATAR_BUCKET');
}

const emailVerificationEnabled = optionalBoolean('AUTH_EMAIL_VERIFICATION_ENABLED', true);
const emailVerificationTtlSeconds = optionalNumber('AUTH_EMAIL_VERIFICATION_TTL_SECONDS', 900, {
  integer: true,
  min: 60
});
const emailVerificationResendCooldownSeconds = optionalNumber(
  'AUTH_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS',
  60,
  { integer: true, min: 1 }
);
const emailVerificationPath =
  optionalString('AUTH_EMAIL_VERIFICATION_PATH').replace(/\s+/g, '') || '/auth/verify';

if (!emailVerificationPath.startsWith('/')) {
  addError('AUTH_EMAIL_VERIFICATION_PATH', 'must start with "/"');
}
if (emailVerificationEnabled && !supabaseEnabled) {
  addError('AUTH_EMAIL_VERIFICATION_ENABLED', 'requires SUPABASE configuration');
}

export type Config = {
  nodeEnv: string;
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
    provider: AiProvider;
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  supabase: {
    url: string;
    serviceRoleKey: string;
    publishableKey: string;
    avatarBucket: string;
  };
  auth: {
    emailVerificationEnabled: boolean;
    emailVerificationTtlSeconds: number;
    emailVerificationResendCooldownSeconds: number;
    emailVerificationPath: string;
  };
  nowpayments: {
    apiKey: string;
    ipnSecret: string;
    baseUrl: string;
    payCurrency: string;
    successUrl: string;
    cancelUrl: string;
    ipnCallbackUrl: string;
    topupMin: number | null;
    topupMax: number | null;
  };
  features: {
    outlookOauthEnabled: boolean;
    nowpaymentsEnabled: boolean;
    supabaseEnabled: boolean;
    emailVerificationEnabled: boolean;
  };
};

if (configErrors.length > 0) {
  throw new Error(`Invalid environment configuration:\n- ${configErrors.join('\n- ')}`);
}

export const config: Config = {
  nodeEnv,
  port,
  frontendUrl,
  cors: {
    allowAll: corsAllowAll,
    origins: corsOrigins
  },
  db: {
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
    ssl: dbSsl
  },
  jwt: {
    secret: jwtSecret,
    expiresIn: jwtExpiresIn
  },
  outlook: {
    clientId: outlookClientId,
    clientSecret: outlookClientSecret,
    tenantId: outlookTenantId,
    redirectUri: outlookRedirectUri,
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
    url: supabaseUrl,
    serviceRoleKey: supabaseServiceRoleKey,
    publishableKey: supabasePublishableKey,
    avatarBucket: supabaseAvatarBucket
  },
  auth: {
    emailVerificationEnabled,
    emailVerificationTtlSeconds,
    emailVerificationResendCooldownSeconds,
    emailVerificationPath
  },
  nowpayments: {
    apiKey: nowpaymentsApiKey,
    ipnSecret: nowpaymentsIpnSecret,
    baseUrl: nowpaymentsBaseUrl,
    payCurrency: nowpaymentsPayCurrency,
    successUrl: nowpaymentsSuccessUrl,
    cancelUrl: nowpaymentsCancelUrl,
    ipnCallbackUrl: nowpaymentsIpnCallbackUrl,
    topupMin: nowpaymentsTopupMin,
    topupMax: nowpaymentsTopupMax
  },
  features: {
    outlookOauthEnabled: outlookEnabled,
    nowpaymentsEnabled: nowpaymentsEnabled,
    supabaseEnabled,
    emailVerificationEnabled
  }
};
