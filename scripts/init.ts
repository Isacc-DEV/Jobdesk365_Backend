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

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci_uniq
      ON users (lower(email))
      WHERE deleted_at IS NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci_uniq
      ON users (lower(username))
      WHERE deleted_at IS NULL
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
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL,
        name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT roles_key_allowed CHECK (key IN ('client', 'admin', 'manager', 'worker')),
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
        ('client', 'Client'),
        ('admin', 'Admin'),
        ('manager', 'Manager'),
        ('worker', 'Worker')
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
      CREATE TABLE IF NOT EXISTS talents (
        id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
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

    await client.query(`
      ALTER TABLE talents
      ADD COLUMN IF NOT EXISTS img_url text
    `);

    await client.query(`
      ALTER TABLE talents
      ADD COLUMN IF NOT EXISTS talent_role text
    `);

    await client.query(`
      ALTER TABLE talents
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name = 'talents'
            AND constraint_type = 'PRIMARY KEY'
        ) THEN
          ALTER TABLE talents DROP CONSTRAINT IF EXISTS talents_pkey;
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'talents_user_role_unique'
            AND table_name = 'talents'
        ) THEN
          ALTER TABLE talents
          ADD CONSTRAINT talents_user_role_unique UNIQUE (id, talent_role);
        END IF;
      END
      $$;
    `);

    await client.query(`
      UPDATE talents
      SET user_id = id
      WHERE user_id IS NULL
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'talents_role_allowed'
            AND table_name = 'talents'
        ) THEN
          ALTER TABLE talents
          ADD CONSTRAINT talents_role_allowed
          CHECK (talent_role IN ('bidder', 'caller'));
        END IF;
      END
      $$;
    `);

    await client.query(`
      UPDATE talents t
      SET talent_role = r.key
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE t.talent_role IS NULL
        AND ur.user_id = COALESCE(t.user_id, t.id)
        AND r.key IN ('bidder', 'caller')
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_hire_people_updated_at ON talents;
      DROP TRIGGER IF EXISTS trg_talents_updated_at ON talents;
      CREATE TRIGGER trg_talents_updated_at
      BEFORE UPDATE ON talents
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await client.query(`DROP INDEX IF EXISTS idx_hire_people_email`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_talents_email ON talents (email)`);

    await client.query(`
      INSERT INTO talents (id, user_id, talent_role, name, bio, skill, email, phone_number, whatsapp, telegram, rate)
      SELECT u.id,
             u.id,
             r.key,
             COALESCE(u.display_name, u.username),
             u.bio,
             CASE WHEN r.key = 'caller' THEN 'Calling' ELSE 'Applications' END,
             u.email,
             NULL,
             NULL,
             NULL,
             CASE WHEN r.key = 'caller' THEN 35 ELSE 3 END
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE r.key IN ('bidder', 'caller')
      ON CONFLICT (id, talent_role) DO NOTHING
    `);

    await client.query(
      `
      WITH mock_talents (email, username, display_name, bio, role_key, rate, img_url, phone_number, whatsapp, telegram, skill) AS (
        VALUES
          ('mock.caller1@jobdesk.local', 'caller.one', 'Callie Stone', 'Customer-focused caller with a calm tone.', 'caller', 32, 'https://your-project.supabase.co/storage/v1/object/public/talents/caller-1.jpg', '555-0101', '555-0101', 'caller.one', 'Outbound calling'),
          ('mock.caller2@jobdesk.local', 'caller.two', 'Noah Reed', 'Fast, friendly outreach and follow-up specialist.', 'caller', 28, 'https://your-project.supabase.co/storage/v1/object/public/talents/caller-2.jpg', '555-0102', '555-0102', 'caller.two', 'Lead follow-up'),
          ('mock.caller3@jobdesk.local', 'caller.three', 'Ava Brooks', 'Empathetic caller with experience in pipelines.', 'caller', 30, 'https://your-project.supabase.co/storage/v1/object/public/talents/caller-3.jpg', '555-0103', '555-0103', 'caller.three', 'Pipeline outreach'),
          ('mock.bidder1@jobdesk.local', 'bidder.one', 'Ethan Park', 'High-volume application specialist.', 'bidder', 4, 'https://your-project.supabase.co/storage/v1/object/public/talents/bidder-1.jpg', '555-0201', '555-0201', 'bidder.one', 'Applications'),
          ('mock.bidder2@jobdesk.local', 'bidder.two', 'Mia Patel', 'Accurate and fast bidder with ATS expertise.', 'bidder', 5, 'https://your-project.supabase.co/storage/v1/object/public/talents/bidder-2.jpg', '555-0202', '555-0202', 'bidder.two', 'ATS bids'),
          ('mock.bidder3@jobdesk.local', 'bidder.three', 'Lucas Ortiz', 'Detail-oriented application optimizer.', 'bidder', 3, 'https://your-project.supabase.co/storage/v1/object/public/talents/bidder-3.jpg', '555-0203', '555-0203', 'bidder.three', 'Application targeting')
      ),
      ensured_users AS (
        INSERT INTO users (email, username, password_hash, display_name, bio, photo_link, plan)
        SELECT mt.email, mt.username, $1, mt.display_name, mt.bio, NULL, 'free'
        FROM mock_talents mt
        WHERE NOT EXISTS (
          SELECT 1 FROM users u WHERE lower(u.email) = lower(mt.email)
        )
        RETURNING id, email
      ),
      all_users AS (
        SELECT u.id, u.email
        FROM users u
        JOIN mock_talents mt ON lower(u.email) = lower(mt.email)
      ),
      role_links AS (
        INSERT INTO user_roles (user_id, role_id)
        SELECT au.id, r.id
        FROM all_users au
        JOIN mock_talents mt ON lower(mt.email) = lower(au.email)
        JOIN roles r ON r.key = 'worker'
        ON CONFLICT DO NOTHING
      )
      INSERT INTO talents (id, user_id, talent_role, name, bio, skill, email, phone_number, whatsapp, telegram, rate, img_url)
      SELECT au.id,
             au.id,
             mt.role_key,
             mt.display_name,
             mt.bio,
             mt.skill,
             mt.email,
             mt.phone_number,
             mt.whatsapp,
             mt.telegram,
             mt.rate,
             mt.img_url
      FROM all_users au
      JOIN mock_talents mt ON lower(mt.email) = lower(au.email)
      ON CONFLICT (id, talent_role) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        talent_role = EXCLUDED.talent_role,
        name = EXCLUDED.name,
        bio = EXCLUDED.bio,
        skill = EXCLUDED.skill,
        email = EXCLUDED.email,
        phone_number = EXCLUDED.phone_number,
        whatsapp = EXCLUDED.whatsapp,
        telegram = EXCLUDED.telegram,
        rate = EXCLUDED.rate,
        img_url = EXCLUDED.img_url
      `,
      ['$2b$10$N9qo8uLOickgx2ZMRZo5e.Puq8No3BFEtGYwd5j9Vn0iJrO9wBLs.']
    );

    await client.query(`
      WITH worker_role AS (
        SELECT id FROM roles WHERE key = 'worker' LIMIT 1
      ),
      legacy_roles AS (
        SELECT id FROM roles WHERE key IN ('bidder', 'caller')
      ),
      legacy_rows AS (
        SELECT ur.id,
               ur.user_id,
               ROW_NUMBER() OVER (PARTITION BY ur.user_id ORDER BY ur.id) AS rn,
               EXISTS (
                 SELECT 1
                 FROM user_roles ur2
                 WHERE ur2.user_id = ur.user_id
                   AND ur2.role_id = (SELECT id FROM worker_role)
               ) AS has_worker
        FROM user_roles ur
        WHERE ur.role_id IN (SELECT id FROM legacy_roles)
      )
      DELETE FROM user_roles ur
      USING legacy_rows lr
      WHERE ur.id = lr.id
        AND (lr.has_worker OR lr.rn > 1)
    `);

    await client.query(`
      WITH worker_role AS (
        SELECT id FROM roles WHERE key = 'worker' LIMIT 1
      ),
      legacy_roles AS (
        SELECT id FROM roles WHERE key IN ('bidder', 'caller')
      )
      UPDATE user_roles ur
      SET role_id = (SELECT id FROM worker_role)
      WHERE ur.role_id IN (SELECT id FROM legacy_roles)
        AND EXISTS (SELECT 1 FROM worker_role)
    `);

    await client.query(`DELETE FROM roles WHERE key IN ('bidder', 'caller')`);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'roles_key_allowed'
            AND table_name = 'roles'
        ) THEN
          ALTER TABLE roles
          ADD CONSTRAINT roles_key_allowed
          CHECK (key IN ('client', 'admin', 'manager', 'worker'));
        END IF;
      END
      $$;
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
