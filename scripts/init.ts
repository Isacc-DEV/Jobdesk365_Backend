import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

const config: DbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME || 'jobdesk365',
  ssl: process.env.DB_SSL === 'true'
};

const maintenanceDb = process.env.DB_MAINTENANCE_DB || 'postgres';

const log = (message: string) => console.log(`[init] ${message}`);

const escapeIdent = (value: string) => `"${String(value).replace(/"/g, '""')}"`;

const DEFAULT_SUCCESS_LABELS = [
  'thank you for applying',
  'application received',
  "you're all set",
  'next steps',
  'proposal confirmation',
  'you have applied',
  'application submitted',
  'submission confirmation',
  'we appreciate your interest',
  'application confirmation',
  'applied successfully',
  'what happens next',
  'your application was submitted',
  'thanks for your interest',
  'submitted',
  'submission complete',
  'thanks for applying',
  'thank you for your application',
  'submission successful',
  'we received your application',
  'your interest has been received',
  'application sent',
  'your application has been submitted',
  'thank you for submitting',
  'all done'
];

async function ensureDatabaseExists() {
  const adminClient = new Client({ ...config, database: maintenanceDb });
  try {
    await adminClient.connect();
    const exists = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [config.database]
    );

    if (exists.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE ${escapeIdent(config.database)}`);
      log(`created database ${config.database}`);
    } else {
      log(`database ${config.database} already exists`);
    }
  } finally {
    await adminClient.end();
  }
}

async function applySchema() {
  const client = new Client(config);
  await client.connect();
  try {
    await client.query('BEGIN');

    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_type') THEN
          CREATE TYPE plan_type AS ENUM ('free', 'plus', 'pro', 'pro_plus');
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION set_row_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider text NOT NULL,
        email_address text NOT NULL,
        access_token text,
        refresh_token text,
        token_expires_at timestamptz,
        scope text,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT email_accounts_provider_allowed CHECK (provider IN ('outlook', 'gmail')),
        CONSTRAINT email_accounts_status_allowed CHECK (status IN ('active', 'expired', 'revoked', 'error'))
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_email_accounts_updated_at ON email_accounts;
      CREATE TRIGGER trg_email_accounts_updated_at
      BEFORE UPDATE ON email_accounts
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        username text NOT NULL,
        password_hash text NOT NULL,
        display_name text,
        bio text,
        photo_link text,
        plan plan_type NOT NULL DEFAULT 'free'::plan_type,
        balance numeric(12, 2) NOT NULL DEFAULT 1,
        verified boolean NOT NULL DEFAULT false,
        blocked_at timestamptz,
        last_login_at timestamptz,
        last_login_place text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
    `);

      await client.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_login_at timestamptz
      `);

      await client.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_login_place text
      `);

      await client.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS balance numeric(12, 2) NOT NULL DEFAULT 1
      `);

      await client.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS blocked_at timestamptz
      `);

      await client.query(`
        UPDATE users
        SET balance = 1
        WHERE balance IS NULL
      `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
      CREATE TRIGGER trg_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`DROP INDEX IF EXISTS idx_users_email_ci_uniq`);
    await client.query(`DROP INDEX IF EXISTS idx_users_username_ci_uniq`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_ci
      ON users (lower(email))
      WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username_ci
      ON users (lower(username))
      WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_blocked_at
      ON users (blocked_at)
      WHERE blocked_at IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS billing_topups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount numeric(12, 2) NOT NULL CHECK (amount > 0),
        price_currency text NOT NULL DEFAULT 'usd',
        pay_currency text NOT NULL DEFAULT 'usdtbsc',
        nowpayments_invoice_id text,
        nowpayments_payment_id text,
        nowpayments_order_id text NOT NULL,
        checkout_url text,
        payment_status text NOT NULL DEFAULT 'waiting',
        credited_at timestamptz,
        credited_amount numeric(12, 2),
        ipn_last_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'billing_topups_order_id_unique'
            AND table_name = 'billing_topups'
        ) THEN
          ALTER TABLE billing_topups
          ADD CONSTRAINT billing_topups_order_id_unique UNIQUE (nowpayments_order_id);
        END IF;
      END
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_billing_topups_updated_at ON billing_topups;
      CREATE TRIGGER trg_billing_topups_updated_at
      BEFORE UPDATE ON billing_topups
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_billing_topups_user_id
      ON billing_topups (user_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_billing_topups_payment_status
      ON billing_topups (payment_status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_billing_topups_credited_at
      ON billing_topups (credited_at DESC)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_topups_invoice_id
      ON billing_topups (nowpayments_invoice_id)
      WHERE nowpayments_invoice_id IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_topups_payment_id
      ON billing_topups (nowpayments_payment_id)
      WHERE nowpayments_payment_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type text NOT NULL,
        title text NOT NULL,
        message text NOT NULL,
        redirect_url text NOT NULL,
        is_read boolean NOT NULL DEFAULT false,
        read_at timestamptz,
        dedupe_key text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at
      ON notifications (user_id, created_at DESC, id DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications (user_id, is_read, created_at DESC)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key
      ON notifications (dedupe_key)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS resume_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        description text,
        code text NOT NULL,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_resume_templates_updated_at ON resume_templates;
      CREATE TRIGGER trg_resume_templates_updated_at
      BEFORE UPDATE ON resume_templates
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_resume_templates_created_by ON resume_templates (created_by)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id),
        name text NOT NULL,
        description text,
        base_info jsonb NOT NULL DEFAULT '{}'::jsonb,
        base_resume jsonb NOT NULL DEFAULT '{}'::jsonb,
        resume_template_id uuid NOT NULL REFERENCES resume_templates(id),
        email_account_id uuid UNIQUE REFERENCES email_accounts(id),
        assigned_bidder_user_id uuid REFERENCES users(id),
        assigned_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        CONSTRAINT profiles_assignment_pair CHECK (
          (assigned_bidder_user_id IS NULL AND assigned_at IS NULL)
          OR (assigned_bidder_user_id IS NOT NULL AND assigned_at IS NOT NULL)
        )
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_profiles_updated_at ON profiles;
      CREATE TRIGGER trg_profiles_updated_at
      BEFORE UPDATE ON profiles
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_name_ci
      ON profiles (user_id, lower(name))
      WHERE deleted_at IS NULL
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_profiles_resume_template_id ON profiles (resume_template_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_profiles_assigned_bidder ON profiles (assigned_bidder_user_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_profiles_user_created_at ON profiles (user_id, created_at)`
    );
    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS email_account_id uuid
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'profiles_email_account_id_fkey'
            AND table_name = 'profiles'
        ) THEN
          ALTER TABLE profiles
          ADD CONSTRAINT profiles_email_account_id_fkey
          FOREIGN KEY (email_account_id) REFERENCES email_accounts(id);
        END IF;
      END;
      $$;
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_account_id_uniq
       ON profiles (email_account_id)
       WHERE email_account_id IS NOT NULL`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS emails (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
        profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        external_message_id text NOT NULL,
        subject text,
        from_email text,
        snippet text,
        received_at timestamptz,
        is_unread boolean NOT NULL DEFAULT true,
        synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT emails_external_message_id_unique UNIQUE (external_message_id)
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_emails_updated_at ON emails;
      CREATE TRIGGER trg_emails_updated_at
      BEFORE UPDATE ON emails
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_emails_email_account_id ON emails (email_account_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_emails_profile_id ON emails (profile_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails (received_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
        profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        external_event_id text NOT NULL,
        title text,
        start_at timestamptz,
        end_at timestamptz,
        synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT calendar_events_external_event_id_unique UNIQUE (external_event_id)
      )
    `);

    await client.query(`
      ALTER TABLE calendar_events
      ADD COLUMN IF NOT EXISTS assigned_user_id uuid
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'calendar_events_assigned_user_fk'
            AND table_name = 'calendar_events'
        ) THEN
          ALTER TABLE calendar_events
          ADD CONSTRAINT calendar_events_assigned_user_fk
          FOREIGN KEY (assigned_user_id)
          REFERENCES users(id)
          ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_calendar_events_updated_at ON calendar_events;
      CREATE TRIGGER trg_calendar_events_updated_at
      BEFORE UPDATE ON calendar_events
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_calendar_events_email_account_id ON calendar_events (email_account_id)`
    );
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_profile_id ON calendar_events (profile_id)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_calendar_events_assigned_user_id ON calendar_events (assigned_user_id)`
    );

    await client.query(`
      UPDATE calendar_events ce
      SET assigned_user_id = p.assigned_bidder_user_id
      FROM profiles p
      WHERE ce.profile_id = p.id
        AND ce.assigned_user_id IS NULL
        AND p.assigned_bidder_user_id IS NOT NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at ON calendar_events (start_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS manual_calendar_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        requested_caller_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        assigned_caller_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        caller_request_id uuid,
        call_status text NOT NULL DEFAULT 'unassigned',
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT manual_calendar_events_call_status_allowed
          CHECK (call_status IN ('unassigned', 'pending', 'assigned', 'rejected')),
        CONSTRAINT manual_calendar_events_time_range_valid CHECK (end_at > start_at)
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_manual_calendar_events_updated_at ON manual_calendar_events;
      CREATE TRIGGER trg_manual_calendar_events_updated_at
      BEFORE UPDATE ON manual_calendar_events
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_owner_user_id ON manual_calendar_events (owner_user_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_assigned_caller_user_id ON manual_calendar_events (assigned_caller_user_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_start_at ON manual_calendar_events (start_at)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_caller_request_id ON manual_calendar_events (caller_request_id)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL,
        name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT roles_key_allowed CHECK (key IN ('admin', 'worker', 'user')),
        CONSTRAINT roles_key_unique UNIQUE (key)
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_roles_updated_at ON roles;
      CREATE TRIGGER trg_roles_updated_at
      BEFORE UPDATE ON roles
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'roles_key_allowed'
            AND table_name = 'roles'
        ) THEN
          ALTER TABLE roles DROP CONSTRAINT roles_key_allowed;
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_roles_unique UNIQUE (user_id, role_id)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles (role_id)`);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'applications'
            AND column_name = 'job_url'
        ) THEN
          DROP TABLE applications;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'bid_statuses'
        ) AND NOT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'applications'
        ) THEN
          ALTER TABLE bid_statuses RENAME TO applications;
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS applications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url text NOT NULL,
        bids jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT applications_user_url_unique UNIQUE (user_id, url)
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_bid_statuses_updated_at ON applications;
      DROP TRIGGER IF EXISTS trg_applications_updated_at ON applications;
      CREATE TRIGGER trg_applications_updated_at
      BEFORE UPDATE ON applications
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_applications_updated_at ON applications (updated_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS success_labels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT success_labels_text_unique UNIQUE (text)
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'success_labels_text_unique'
            AND table_name = 'success_labels'
        ) THEN
          ALTER TABLE success_labels
          ADD CONSTRAINT success_labels_text_unique UNIQUE (text);
        END IF;
      END
      $$;
    `);

    await client.query(
      `INSERT INTO success_labels (text)
       SELECT unnest($1::text[])
       ON CONFLICT (text) DO NOTHING`,
      [DEFAULT_SUCCESS_LABELS]
    );

    await client.query(
      `
      INSERT INTO roles (key, name)
      VALUES 
        ('admin', 'Admin'),
        ('worker', 'Worker'),
        ('user', 'User')
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
      `
    );

      await client.query(`
        CREATE TABLE IF NOT EXISTS dynamic_questions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          question_text text NOT NULL,
        field_type text NOT NULL DEFAULT 'text',
        options jsonb DEFAULT NULL,
        is_required boolean DEFAULT false,
        display_order integer DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_threads (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid REFERENCES users(id) ON DELETE SET NULL,
          guest_id text,
          user_type text NOT NULL CHECK (user_type IN ('client', 'guest')),
          display_name text,
          status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'waiting', 'closed')),
          assigned_manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
          watchers jsonb NOT NULL DEFAULT '[]'::jsonb,
          last_activity_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          closed_at timestamptz
        )
      `);

      await client.query(`
        DO $$
        BEGIN
          UPDATE chat_threads
          SET user_type = 'user'
          WHERE user_type = 'client';

          ALTER TABLE chat_threads DROP CONSTRAINT IF EXISTS chat_threads_user_type_check;
          ALTER TABLE chat_threads
          ADD CONSTRAINT chat_threads_user_type_check
          CHECK (user_type IN ('user', 'guest'));
        END
        $$;
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_channels (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          key text NOT NULL UNIQUE,
          name text NOT NULL,
          position integer NOT NULL DEFAULT 0,
          is_support boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_channel_messages (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
          sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
          content text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_channel_reactions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          message_id uuid NOT NULL REFERENCES chat_channel_messages(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          emoji text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_dm_threads (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_dm_messages (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          thread_id uuid NOT NULL REFERENCES chat_dm_threads(id) ON DELETE CASCADE,
          sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
          content text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_dm_reactions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          message_id uuid NOT NULL REFERENCES chat_dm_messages(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          emoji text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
          sender_type text NOT NULL CHECK (sender_type IN ('system', 'internal', 'external')),
          sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
          content text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          delivered_at timestamptz,
          read_at timestamptz
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_message_reads (
          message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          read_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (message_id, user_id)
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_reactions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          user_id uuid REFERENCES users(id) ON DELETE CASCADE,
          guest_id text,
          emoji text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_attachments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          file_url text NOT NULL,
          file_type text,
          preview_url text,
          size_bytes integer,
          name text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_channel_attachments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          message_id uuid NOT NULL REFERENCES chat_channel_messages(id) ON DELETE CASCADE,
          file_url text NOT NULL,
          file_type text,
          preview_url text,
          size_bytes integer,
          name text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_dm_attachments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          message_id uuid NOT NULL REFERENCES chat_dm_messages(id) ON DELETE CASCADE,
          file_url text NOT NULL,
          file_type text,
          preview_url text,
          size_bytes integer,
          name text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reactions_user_unique
        ON chat_reactions (message_id, user_id, emoji)
        WHERE user_id IS NOT NULL
      `);

      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reactions_guest_unique
        ON chat_reactions (message_id, guest_id, emoji)
        WHERE guest_id IS NOT NULL
      `);

      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_chat_channel_attachments_message_id
         ON chat_channel_attachments (message_id)`
      );

      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_chat_dm_attachments_message_id
         ON chat_dm_attachments (message_id)`
      );

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_threads_user_id ON chat_threads (user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_threads_guest_id ON chat_threads (guest_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_threads_status ON chat_threads (status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_threads_assigned_manager_id ON chat_threads (assigned_manager_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_threads_last_activity ON chat_threads (last_activity_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_channels_position ON chat_channels (position)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_channel_messages_channel_id ON chat_channel_messages (channel_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_channel_messages_created_at ON chat_channel_messages (created_at DESC)
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channel_reactions_user_unique
        ON chat_channel_reactions (message_id, user_id, emoji)
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_dm_threads_unique_pair
        ON chat_dm_threads (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_dm_messages_thread_id ON chat_dm_messages (thread_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_dm_messages_created_at ON chat_dm_messages (created_at DESC)
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_dm_reactions_user_unique
        ON chat_dm_reactions (message_id, user_id, emoji)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages (thread_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at DESC)
      `);

      await client.query(`
        INSERT INTO chat_channels (key, name, position, is_support)
        VALUES
          ('all_to_the_members', 'all_to_the_members', 0, false),
          ('issue_report', 'issue_report', 1, false),
          ('callers_workspace', 'callers_workspace', 2, false),
          ('bidders_workspace', 'bidders_workspace', 3, false),
          ('support_workspace', 'support_workspace', 4, true)
        ON CONFLICT (key) DO UPDATE
          SET name = EXCLUDED.name,
              position = EXCLUDED.position,
              is_support = EXCLUDED.is_support,
              updated_at = now()
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS trg_chat_threads_updated_at ON chat_threads;
        CREATE TRIGGER trg_chat_threads_updated_at
        BEFORE UPDATE ON chat_threads
        FOR EACH ROW
        EXECUTE FUNCTION set_row_updated_at();
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS trg_chat_channels_updated_at ON chat_channels;
        CREATE TRIGGER trg_chat_channels_updated_at
        BEFORE UPDATE ON chat_channels
        FOR EACH ROW
        EXECUTE FUNCTION set_row_updated_at();
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS trg_chat_dm_threads_updated_at ON chat_dm_threads;
        CREATE TRIGGER trg_chat_dm_threads_updated_at
        BEFORE UPDATE ON chat_dm_threads
        FOR EACH ROW
        EXECUTE FUNCTION set_row_updated_at();
      `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_dynamic_questions_updated_at ON dynamic_questions;
      CREATE TRIGGER trg_dynamic_questions_updated_at
      BEFORE UPDATE ON dynamic_questions
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_dynamic_questions_user_id ON dynamic_questions (user_id)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_dynamic_questions_display_order ON dynamic_questions (user_id, display_order)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS dynamic_answers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        question_id uuid NOT NULL REFERENCES dynamic_questions(id) ON DELETE CASCADE,
        answer_text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT unique_dynamic_profile_question UNIQUE (profile_id, question_id)
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_dynamic_answers_updated_at ON dynamic_answers;
      CREATE TRIGGER trg_dynamic_answers_updated_at
      BEFORE UPDATE ON dynamic_answers
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_dynamic_answers_profile_id ON dynamic_answers (profile_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_dynamic_answers_question_id ON dynamic_answers (question_id)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_dynamic_answers_profile_question ON dynamic_answers (profile_id, question_id)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS assistant_chat_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL,
        profile_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_assistant_chat_sessions_updated_at ON assistant_chat_sessions;
      CREATE TRIGGER trg_assistant_chat_sessions_updated_at
      BEFORE UPDATE ON assistant_chat_sessions
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_sessions_user_id ON assistant_chat_sessions (user_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_sessions_updated_at ON assistant_chat_sessions (updated_at DESC)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS assistant_chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES assistant_chat_sessions(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('user', 'assistant')),
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_messages_session_id ON assistant_chat_messages (session_id)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_messages_created_at ON assistant_chat_messages (created_at)`
    );

    await client.query(`
      CREATE OR REPLACE FUNCTION touch_assistant_chat_session()
      RETURNS trigger AS $$
      BEGIN
        UPDATE assistant_chat_sessions
        SET updated_at = now()
        WHERE id = NEW.session_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_touch_assistant_chat_session ON assistant_chat_messages;
      CREATE TRIGGER trg_touch_assistant_chat_session
      AFTER INSERT ON assistant_chat_messages
      FOR EACH ROW
      EXECUTE FUNCTION touch_assistant_chat_session();
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS job_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url text NOT NULL,
        url_normalized text NOT NULL,
        title text,
        open_count integer NOT NULL DEFAULT 0,
        last_opened_at timestamptz DEFAULT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT job_links_user_url_unique UNIQUE (user_id, url_normalized)
      )
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_job_links_updated_at ON job_links;
      CREATE TRIGGER trg_job_links_updated_at
      BEFORE UPDATE ON job_links
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_job_links_user_id ON job_links (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_job_links_updated_at ON job_links (updated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_job_links_url_normalized ON job_links (url_normalized)`);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'hire_people'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'talents'
        ) THEN
          ALTER TABLE hire_people RENAME TO talents;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'talents'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'user_badges'
        ) THEN
          ALTER TABLE talents RENAME TO user_badges;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'hire_requests'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'requests'
        ) THEN
          ALTER TABLE hire_requests RENAME TO requests;
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_badges (
        id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        badge_key text,
        talent_role text,
        name text,
        bio text,
        skill text,
        email text,
        phone_number text,
        whatsapp text,
        telegram text,
        rate numeric(10, 2),
        img_url text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS img_url text`);
    await client.query(`ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS badge_key text`);
    await client.query(`ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS talent_role text`);
    await client.query(`
      ALTER TABLE user_badges
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name = 'user_badges'
            AND constraint_type = 'PRIMARY KEY'
        ) THEN
          ALTER TABLE user_badges DROP CONSTRAINT IF EXISTS user_badges_pkey;
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'user_badges_user_badge_unique'
            AND table_name = 'user_badges'
        ) THEN
          ALTER TABLE user_badges
          ADD CONSTRAINT user_badges_user_badge_unique UNIQUE (id, badge_key);
        END IF;
      END
      $$;
    `);

    await client.query(`
      UPDATE user_badges
      SET user_id = id
      WHERE user_id IS NULL
    `);
    await client.query(`
      UPDATE user_badges
      SET badge_key = talent_role
      WHERE badge_key IS NULL AND talent_role IS NOT NULL
    `);
    await client.query(`
      UPDATE user_badges
      SET talent_role = badge_key
      WHERE talent_role IS NULL AND badge_key IS NOT NULL
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'talents_role_allowed'
            AND table_name = 'user_badges'
        ) THEN
          ALTER TABLE user_badges DROP CONSTRAINT talents_role_allowed;
        END IF;
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'user_badges_role_allowed'
            AND table_name = 'user_badges'
        ) THEN
          ALTER TABLE user_badges DROP CONSTRAINT user_badges_role_allowed;
        END IF;
        ALTER TABLE user_badges
        ADD CONSTRAINT user_badges_role_allowed
        CHECK (badge_key IN ('manager', 'bidder', 'caller'));
      END
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_hire_people_updated_at ON user_badges;
      DROP TRIGGER IF EXISTS trg_talents_updated_at ON user_badges;
      DROP TRIGGER IF EXISTS trg_user_badges_updated_at ON user_badges;
      CREATE TRIGGER trg_user_badges_updated_at
      BEFORE UPDATE ON user_badges
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`DROP INDEX IF EXISTS idx_hire_people_email`);
    await client.query(`DROP INDEX IF EXISTS idx_talents_email`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_badges_email ON user_badges (email)`);

    await client.query(`
      WITH role_ids AS (
        SELECT
          (SELECT id FROM roles WHERE key = 'user' LIMIT 1) AS user_role_id
      ),
      legacy_memberships AS (
        SELECT ur.user_id, r.key
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE r.key IN ('client', 'manager', 'bidder', 'caller')
      )
      INSERT INTO user_roles (user_id, role_id)
      SELECT DISTINCT lm.user_id, ri.user_role_id
      FROM legacy_memberships lm
      CROSS JOIN role_ids ri
      WHERE lm.key = 'client'
        AND ri.user_role_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      WITH role_ids AS (
        SELECT
          (SELECT id FROM roles WHERE key = 'worker' LIMIT 1) AS worker_role_id
      ),
      legacy_memberships AS (
        SELECT ur.user_id, r.key
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE r.key IN ('manager', 'bidder', 'caller')
      )
      INSERT INTO user_roles (user_id, role_id)
      SELECT DISTINCT lm.user_id, ri.worker_role_id
      FROM legacy_memberships lm
      CROSS JOIN role_ids ri
      WHERE ri.worker_role_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO user_badges (id, user_id, badge_key, talent_role, name, bio, email)
      SELECT u.id,
             u.id,
             r.key,
             r.key,
             COALESCE(u.display_name, u.username),
             u.bio,
             u.email
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
      WHERE r.key IN ('manager', 'bidder', 'caller')
      ON CONFLICT (id, badge_key) DO NOTHING
    `);

    await client.query(`
      DELETE FROM user_roles ur
      USING roles r
      WHERE ur.role_id = r.id
        AND r.key IN ('client', 'manager', 'bidder', 'caller')
    `);

    await client.query(`
      DELETE FROM roles
      WHERE key IN ('client', 'manager', 'bidder', 'caller')
    `);

    await client.query(`
      DO $$
      DECLARE
        fixed_admin_role uuid := '4413d466-f31d-46c1-9bef-4680f50c2de8';
        existing_admin_role uuid;
      BEGIN
        SELECT id
        INTO existing_admin_role
        FROM roles
        WHERE key = 'admin'
        LIMIT 1;

        IF existing_admin_role IS NULL THEN
          INSERT INTO roles (id, key, name)
          VALUES (fixed_admin_role, 'admin', 'Admin');
        ELSIF existing_admin_role <> fixed_admin_role THEN
          UPDATE roles
          SET key = 'legacy_admin_' || replace(existing_admin_role::text, '-', '')
          WHERE id = existing_admin_role;

          INSERT INTO roles (id, key, name)
          VALUES (fixed_admin_role, 'admin', 'Admin')
          ON CONFLICT (id) DO UPDATE
          SET key = EXCLUDED.key,
              name = EXCLUDED.name,
              updated_at = now();

          UPDATE user_roles
          SET role_id = fixed_admin_role
          WHERE role_id = existing_admin_role;

          DELETE FROM roles WHERE id = existing_admin_role;
        END IF;
      END
      $$;
    `);

    await client.query(`
      INSERT INTO roles (key, name)
      VALUES ('worker', 'Worker'),
             ('user', 'User')
      ON CONFLICT (key) DO UPDATE
      SET name = EXCLUDED.name,
          updated_at = now()
    `);

    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_key_allowed;
        ALTER TABLE roles
        ADD CONSTRAINT roles_key_allowed
        CHECK (key IN ('admin', 'worker', 'user'));
      END
      $$;
    `);

    await client.query(`
      WITH selected_user AS (
        SELECT id
        FROM users
        WHERE lower(username) = 'isacc1993'
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      ),
      created_user AS (
        INSERT INTO users (email, username, password_hash, display_name, verified)
        SELECT 'wrenikey.dev@gmail.com',
               'isacc1993',
               '$2b$12$ODosbOihRBR6VYpb3zN5SemaGswFYgOCKrLhQiOstLC19YZSjdS/.',
               'isacc1993',
               true
        WHERE NOT EXISTS (SELECT 1 FROM selected_user)
        RETURNING id
      ),
      target_user AS (
        SELECT id FROM selected_user
        UNION ALL
        SELECT id FROM created_user
        LIMIT 1
      )
      UPDATE users
      SET email = 'wrenikey.dev@gmail.com',
          password_hash = '$2b$12$ODosbOihRBR6VYpb3zN5SemaGswFYgOCKrLhQiOstLC19YZSjdS/.',
          deleted_at = NULL,
          updated_at = now()
      WHERE id IN (SELECT id FROM target_user)
    `);

    await client.query(`
      INSERT INTO user_roles (user_id, role_id)
      SELECT u.id, '4413d466-f31d-46c1-9bef-4680f50c2de8'::uuid
      FROM users u
      WHERE lower(u.username) = 'isacc1993'
        AND u.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('bidder', 'caller')),
        detail jsonb,
        assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        hourly_rate numeric(10, 2),
        when_at timestamptz,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'closed')),
        archived boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      ALTER TABLE requests
      ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false
    `);

    await client.query(`
      UPDATE requests
      SET archived = true
      WHERE archived = false
        AND status IN ('working', 'closed')
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'requests'
            AND column_name = 'detail'
            AND data_type <> 'jsonb'
        ) THEN
          ALTER TABLE requests
          ALTER COLUMN detail TYPE jsonb
          USING CASE WHEN detail IS NULL THEN NULL ELSE to_jsonb(detail) END;
        END IF;
      END
      $$;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_hire_requests_updated_at ON requests;
      DROP TRIGGER IF EXISTS trg_requests_updated_at ON requests;
      CREATE TRIGGER trg_requests_updated_at
      BEFORE UPDATE ON requests
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`DROP INDEX IF EXISTS idx_hire_requests_user_id`);
    await client.query(`DROP INDEX IF EXISTS idx_hire_requests_status`);
    await client.query(`DROP INDEX IF EXISTS idx_hire_requests_role`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_requests_role ON requests (role)`);

    await client.query(`
      ALTER TABLE manual_calendar_events
      ADD COLUMN IF NOT EXISTS caller_request_id uuid
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'manual_calendar_events_caller_request_id_fkey'
            AND table_name = 'manual_calendar_events'
        ) THEN
          ALTER TABLE manual_calendar_events
          ADD CONSTRAINT manual_calendar_events_caller_request_id_fkey
          FOREIGN KEY (caller_request_id)
          REFERENCES requests(id)
          ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);

    await client.query('COMMIT');
    log('schema applied to core tables plus extension storage tables');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  log(`connecting to ${config.host}:${config.port} as ${config.user}`);
  await ensureDatabaseExists();
  await applySchema();
  log('init complete');
}

main().catch((err) => {
  console.error('[init] failed:', err.message);
  process.exit(1);
});
