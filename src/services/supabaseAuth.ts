import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

const authClientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
};

const supabaseOtpClient =
  config.features.supabaseEnabled && config.features.emailVerificationEnabled
    ? createClient(config.supabase.url, config.supabase.publishableKey, authClientOptions)
    : null;

const supabaseAdminClient =
  config.features.supabaseEnabled && config.features.emailVerificationEnabled
    ? createClient(config.supabase.url, config.supabase.serviceRoleKey, authClientOptions)
    : null;

export function requireSupabaseOtpClient() {
  if (!supabaseOtpClient) {
    throw new Error('Supabase OTP client is not configured.');
  }
  return supabaseOtpClient;
}

export function requireSupabaseAdminClient() {
  if (!supabaseAdminClient) {
    throw new Error('Supabase admin client is not configured.');
  }
  return supabaseAdminClient;
}
