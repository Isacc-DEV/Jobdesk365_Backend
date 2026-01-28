import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME || 'jobdesk365',
  ssl: process.env.DB_SSL === 'true'
};

const maintenanceDb = process.env.DB_MAINTENANCE_DB || 'postgres';

const log = (message) => console.log(`[init] ${message}`);

const escapeIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

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
        verified boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz
      )
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at ON calendar_events (start_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL,
        name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT roles_key_allowed CHECK (key IN ('client', 'admin', 'manager', 'bidder', 'caller')),
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

    await client.query(
      `
      INSERT INTO roles (key, name)
      VALUES 
        ('client', 'Client'),
        ('admin', 'Admin'),
        ('manager', 'Manager'),
        ('bidder', 'Bidder'),
        ('caller', 'Caller')
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
      `
    );

    await client.query('COMMIT');
    log('schema applied to users, resume_templates, profiles, roles, user_roles tables');
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
