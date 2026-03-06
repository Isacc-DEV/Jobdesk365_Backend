import express from 'express';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { notifyProfileCreated } from '../services/notifications.js';
import {
  normalizeBaseResumeExperienceDates,
  normalizeResumeDateInput,
  type ResumeDateIssue
} from '../utils/resumeDate.js';

const router = express.Router();
type TalentRole = 'bidder' | 'caller';

const BIDDER_BASE_RATE = 0.08;
const CALLER_BASE_RATE = 0.7;

const getRoleBaseRate = (role: TalentRole): number =>
  role === 'caller' ? CALLER_BASE_RATE : BIDDER_BASE_RATE;

const normalizeRateForRole = (role: TalentRole, rawRate: unknown): number => {
  const parsed = Number(rawRate);
  if (!Number.isFinite(parsed) || parsed < 0) return getRoleBaseRate(role);
  return Math.round(parsed * 100) / 100;
};

const resolveTalentRateForRole = async (
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  role: TalentRole,
  candidateUserIds: Array<string | null | undefined>
): Promise<number | null> => {
  const seen = new Set<string>();
  for (const rawUserId of candidateUserIds) {
    const userId = rawUserId ? String(rawUserId) : '';
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    const { rows } = await client.query(
      `SELECT t.rate
       FROM talents t
       WHERE COALESCE(t.user_id, t.id) = $1
         AND t.talent_role = $2
       LIMIT 1`,
      [userId, role]
    );
    if (!rows.length) continue;
    return normalizeRateForRole(role, rows[0].rate);
  }
  return null;
};

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

let extensionSchemaPromise: Promise<void> | null = null;

const ensureExtensionSchema = async () => {
  if (extensionSchemaPromise) return extensionSchemaPromise;
  extensionSchemaPromise = (async () => {
    await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await query(`
      CREATE OR REPLACE FUNCTION set_row_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await query(`
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

    await query(`
      DROP TRIGGER IF EXISTS trg_dynamic_questions_updated_at ON dynamic_questions;
      CREATE TRIGGER trg_dynamic_questions_updated_at
      BEFORE UPDATE ON dynamic_questions
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_dynamic_questions_user_id ON dynamic_questions (user_id)`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_dynamic_questions_display_order ON dynamic_questions (user_id, display_order)`
    );

    await query(`
      CREATE TABLE IF NOT EXISTS dynamic_answers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id uuid NOT NULL,
        question_id uuid NOT NULL REFERENCES dynamic_questions(id) ON DELETE CASCADE,
        answer_text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT unique_dynamic_profile_question UNIQUE (profile_id, question_id)
      )
    `);

    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_class rt ON rt.oid = c.confrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
          WHERE t.relname = 'dynamic_answers'
            AND rt.relname = 'profiles'
            AND a.attname = 'profile_id'
        ) THEN
          ALTER TABLE dynamic_answers
          ADD CONSTRAINT dynamic_answers_profile_id_fkey
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
        END IF;
      END
      $$;
    `);

    await query(`
      DROP TRIGGER IF EXISTS trg_dynamic_answers_updated_at ON dynamic_answers;
      CREATE TRIGGER trg_dynamic_answers_updated_at
      BEFORE UPDATE ON dynamic_answers
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_dynamic_answers_profile_id ON dynamic_answers (profile_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_dynamic_answers_question_id ON dynamic_answers (question_id)`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_dynamic_answers_profile_question ON dynamic_answers (profile_id, question_id)`
    );

    await query(`
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

    await query(`
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

    await query(`
      DROP TRIGGER IF EXISTS trg_bid_statuses_updated_at ON applications;
      DROP TRIGGER IF EXISTS trg_applications_updated_at ON applications;
      CREATE TRIGGER trg_applications_updated_at
      BEFORE UPDATE ON applications
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_applications_user_id ON applications (user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_applications_updated_at ON applications (updated_at DESC)`);

    await query(`
      CREATE TABLE IF NOT EXISTS assistant_chat_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL,
        profile_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      DROP TRIGGER IF EXISTS trg_assistant_chat_sessions_updated_at ON assistant_chat_sessions;
      CREATE TRIGGER trg_assistant_chat_sessions_updated_at
      BEFORE UPDATE ON assistant_chat_sessions
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_sessions_user_id ON assistant_chat_sessions (user_id)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_sessions_updated_at ON assistant_chat_sessions (updated_at DESC)`
    );

    await query(`
      CREATE TABLE IF NOT EXISTS assistant_chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES assistant_chat_sessions(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('user', 'assistant')),
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_messages_session_id ON assistant_chat_messages (session_id)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_assistant_chat_messages_created_at ON assistant_chat_messages (created_at)`
    );

    await query(`
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

    await query(`
      DROP TRIGGER IF EXISTS trg_touch_assistant_chat_session ON assistant_chat_messages;
      CREATE TRIGGER trg_touch_assistant_chat_session
      AFTER INSERT ON assistant_chat_messages
      FOR EACH ROW
      EXECUTE FUNCTION touch_assistant_chat_session();
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS job_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url text NOT NULL,
        url_normalized text NOT NULL,
        title text,
        notes text,
        job_description text,
        open_count integer NOT NULL DEFAULT 0,
        last_opened_at timestamptz DEFAULT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT job_links_user_url_unique UNIQUE (user_id, url_normalized)
      )
    `);

    // Add notes and job_description columns if they don't exist
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'job_links' AND column_name = 'notes') THEN
          ALTER TABLE job_links ADD COLUMN notes text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_name = 'job_links' AND column_name = 'job_description') THEN
          ALTER TABLE job_links ADD COLUMN job_description text;
        END IF;
      END $$;
    `);

    await query(`
      DROP TRIGGER IF EXISTS trg_job_links_updated_at ON job_links;
      CREATE TRIGGER trg_job_links_updated_at
      BEFORE UPDATE ON job_links
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_job_links_user_id ON job_links (user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_job_links_updated_at ON job_links (updated_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_job_links_url_normalized ON job_links (url_normalized)`);

    await query(`
      CREATE TABLE IF NOT EXISTS success_labels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT success_labels_text_unique UNIQUE (text)
      )
    `);

    await query(`
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

    await query(
      `INSERT INTO success_labels (text)
       SELECT unnest($1::text[])
       ON CONFLICT (text) DO NOTHING`,
      [DEFAULT_SUCCESS_LABELS]
    );
  })();

  try {
    await extensionSchemaPromise;
  } catch (err) {
    extensionSchemaPromise = null;
    throw err;
  }

  return extensionSchemaPromise;
};

router.use(authRequired, fetchCurrentUser);
router.use(async (_req, _res, next) => {
  try {
    await ensureExtensionSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/success-labels', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, text, created_at
       FROM success_labels
       ORDER BY created_at ASC, id ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const ensureUrlProtocol = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const mapResumeDateIssues = (issues: ResumeDateIssue[]) =>
  issues.map((issue) => ({
    key: issue.key,
    index: issue.index,
    field: issue.field,
    path: `${issue.key}[${issue.index}].${issue.field}`,
    value: issue.value,
    message: issue.message
  }));

const normalizeJobUrl = (value: string): string => {
  const raw = value.trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(ensureUrlProtocol(raw));
    const origin = parsed.origin.toLowerCase();
    let pathname = parsed.pathname || '';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${origin}${pathname}`;
  } catch {
    return raw.toLowerCase();
  }
};

const getProfileDefaults = () => ({
  personal_info: {},
  additional_info: {},
  education: [],
  work_experience: [],
  custom_fields: [],
  settings: { shortcutKey: 'Alt+Shift+F', autoFillOnLoad: false, fillDelay: 100 }
});

const toJson = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.stringify(value);
};

const DEFAULT_SETTINGS = { shortcutKey: 'Alt+Shift+F', autoFillOnLoad: false, fillDelay: 100 };

const DEFAULT_TEMPLATE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>FlyBid Resume</title>
  </head>
  <body style="font-family: Arial, sans-serif; padding: 24px; color: #111827;">
    <h1>{{Profile.name}}</h1>
    <div>{{Profile.headline}}</div>
    <div>{{Profile.contact.location}} | {{Profile.contact.email}} | {{Profile.contact.phone}}</div>
    <hr />
    {{#hasSummary}}
    <h2>Summary</h2>
    <div>{{summary.text}}</div>
    {{/hasSummary}}
    {{#hasWorkExperience}}
    <h2>Experience</h2>
    {{workExperience}}
    {{/hasWorkExperience}}
    {{#hasEducation}}
    <h2>Education</h2>
    {{education}}
    {{/hasEducation}}
    {{#hasSkills}}
    <h2>Skills</h2>
    <div>{{skills.raw}}</div>
    {{/hasSkills}}
  </body>
</html>`;

const ensureResumeTemplateId = async (userId: string) => {
  const { rows } = await query(
    `SELECT id
     FROM resume_templates
     WHERE created_by = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId]
  );
  if (rows.length > 0) return rows[0].id;

  const created = await query(
    `INSERT INTO resume_templates (title, description, code, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    ['FlyBid Default', 'Auto-generated template for FlyBid profiles.', DEFAULT_TEMPLATE_HTML, userId]
  );
  return created.rows[0]?.id;
};

const getExtensionBlock = (baseInfo: any) => {
  if (!baseInfo || typeof baseInfo !== 'object') return {};
  const ext = (baseInfo as any).extension_profile;
  return ext && typeof ext === 'object' ? ext : {};
};

const isNonEmpty = (value: unknown) => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

const pickValue = (source: any, keys: string[]) => {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = (source as any)[key];
    if (isNonEmpty(value)) return value;
  }
  return undefined;
};

const asString = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
};

const normalizePhone = (baseInfo: any) => {
  const phoneObj = baseInfo && typeof baseInfo.phone === 'object' ? baseInfo.phone : {};
  const countryCode =
    pickValue(baseInfo, ['phone_country_code', 'phoneCountryCode', 'phone_country']) ??
    pickValue(phoneObj, ['countryCode', 'country_code']);
  const number =
    pickValue(baseInfo, ['phone_number', 'phoneNumber', 'phone']) ??
    pickValue(phoneObj, ['number', 'phone', 'value']);
  const formatted =
    pickValue(baseInfo, ['phone_formatted', 'phoneFormatted']) ??
    pickValue(phoneObj, ['formatted']);

  const payload: Record<string, string> = {};
  if (isNonEmpty(countryCode)) payload.countryCode = String(countryCode);
  if (isNonEmpty(number)) payload.number = String(number);
  if (isNonEmpty(formatted)) payload.formatted = String(formatted);
  return payload;
};

const buildPersonalInfoFromBaseInfo = (baseInfo: any) => {
  const payload: Record<string, unknown> = {
    prefix: asString(pickValue(baseInfo, ['prefix', 'name_prefix'])),
    firstName: asString(pickValue(baseInfo, ['first_name', 'firstName'])),
    middleName: asString(pickValue(baseInfo, ['middle_name', 'middleName'])),
    lastName: asString(pickValue(baseInfo, ['last_name', 'lastName'])),
    familyName: asString(pickValue(baseInfo, ['family_name', 'familyName'])),
    address: asString(pickValue(baseInfo, ['address', 'street_address', 'streetAddress'])),
    streetName: asString(pickValue(baseInfo, ['street_name', 'streetName'])),
    city: asString(pickValue(baseInfo, ['city'])),
    state: asString(pickValue(baseInfo, ['state'])),
    province: asString(pickValue(baseInfo, ['province'])),
    postalCode: asString(pickValue(baseInfo, ['postal_code', 'postalCode'])),
    country: asString(pickValue(baseInfo, ['country'])),
    email: asString(pickValue(baseInfo, ['email', 'email_address', 'emailAddress'])),
    password: asString(pickValue(baseInfo, ['password', 'profile_password'])),
    nationality: asString(pickValue(baseInfo, ['nationality'])),
    linkedInURL: asString(
      pickValue(baseInfo, ['linkedin_url', 'linkedInUrl', 'linkedInURL', 'linkedin'])
    ),
    twitterURL: asString(pickValue(baseInfo, ['twitter_url', 'twitterUrl', 'twitter'])),
    facebookURL: asString(pickValue(baseInfo, ['facebook_url', 'facebookUrl', 'facebook'])),
    githubURL: asString(pickValue(baseInfo, ['github_url', 'githubUrl', 'github'])),
    website: asString(pickValue(baseInfo, ['website', 'website_url', 'websiteUrl'])),
    gender: asString(pickValue(baseInfo, ['gender'])),
    phone: normalizePhone(baseInfo)
  };

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'phone') continue;
    if (value !== undefined) compacted[key] = value;
  }
  if (payload.phone && Object.keys(payload.phone as object).length > 0) {
    compacted.phone = payload.phone;
  }
  return compacted;
};

const buildAdditionalInfoFromBaseInfo = (baseInfo: any) => {
  const payload: Record<string, unknown> = {
    currentSalary: asString(pickValue(baseInfo, ['current_salary', 'currentSalary'])),
    expectedSalary: asString(
      pickValue(baseInfo, [
        'desired_annual_salary',
        'desiredAnnualSalary',
        'desiredSalary',
        'expectedSalary'
      ])
    ),
    noticePeriod: asString(pickValue(baseInfo, ['notice_period', 'noticePeriod'])),
    earliestAvailableDate: asString(
      pickValue(baseInfo, ['earliest_available_date', 'earliestAvailableDate'])
    ),
    coverLetter: asString(pickValue(baseInfo, ['cover_letter', 'coverLetter'])),
    genderIdentity: asString(pickValue(baseInfo, ['gender_identity', 'genderIdentity'])),
    raceEthnicity: asString(pickValue(baseInfo, ['race_ethnicity', 'raceEthnicity'])),
    sexualOrientation: asString(
      pickValue(baseInfo, ['sexual_orientation', 'sexualOrientation'])
    ),
    disabilityStatus: asString(
      pickValue(baseInfo, ['disability_status', 'disabilityStatus'])
    ),
    veteranStatus: asString(pickValue(baseInfo, ['veteran_status', 'veteranStatus']))
  };

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
};

const normalizeResumeWorkExperience = (value: any) => {
  if (!value || typeof value !== 'object') return null;
  const bulletsValue =
    value.bullets ?? value.bullet_points ?? value.bulletPoints ?? value.description ?? '';
  const bullets = Array.isArray(bulletsValue)
    ? bulletsValue.filter(Boolean)
    : String(bulletsValue || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
  const isPresent = Boolean(
    value.isPresent ?? value.isCurrent ?? String(value.end_date || value.endDate || '').toLowerCase() === 'present'
  );
  const startRaw = asString(pickValue(value, ['startDate', 'start_date'])) || '';
  const endRaw = asString(pickValue(value, ['endDate', 'end_date'])) || '';
  const normalizedStart = normalizeResumeDateInput(startRaw, { allowPresent: false });
  const normalizedEnd = normalizeResumeDateInput(isPresent ? 'Present' : endRaw, { allowPresent: true });

  return {
    companyTitle: asString(pickValue(value, ['companyTitle', 'company_name', 'companyName'])) || '',
    roleTitle: asString(pickValue(value, ['roleTitle', 'role_title', 'title'])) || '',
    employmentType:
      asString(pickValue(value, ['employmentType', 'employment_type'])) || '',
    location: asString(pickValue(value, ['location', 'location_text', 'locationText'])) || '',
    startDate: normalizedStart.isValid ? normalizedStart.value : startRaw,
    endDate: normalizedEnd.isValid ? normalizedEnd.value : (isPresent ? 'Present' : endRaw),
    bullets
  };
};

const normalizeResumeEducation = (value: any) => {
  if (!value || typeof value !== 'object') return null;
  const courseworkValue = value.coursework ?? value.courses ?? value.coursework_list ?? [];
  const coursework = Array.isArray(courseworkValue)
    ? courseworkValue.filter(Boolean)
    : String(courseworkValue || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
  const dateRaw = asString(pickValue(value, ['date', 'graduationDate', 'endDate'])) || '';
  const normalizedDate = normalizeResumeDateInput(dateRaw, { allowPresent: false });

  return {
    institution: asString(pickValue(value, ['institution', 'school', 'schoolName'])) || '',
    degree: asString(pickValue(value, ['degree'])) || '',
    field: asString(pickValue(value, ['field', 'major'])) || '',
    date: normalizedDate.isValid ? normalizedDate.value : dateRaw,
    coursework
  };
};

const normalizeResumeSkills = (value: any) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value?.raw)) return value.raw.filter(Boolean);
  if (Array.isArray(value?.skills)) return value.skills.filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeResumeFromBaseResume = (baseResume: any) => {
  if (!baseResume || typeof baseResume !== 'object') return null;

  const profileBlock = baseResume.Profile || baseResume.profile || {};
  const contactBlock = profileBlock.contact || baseResume.contact || {};

  const name =
    asString(pickValue(profileBlock, ['name'])) ||
    asString(pickValue(baseResume, ['name', 'full_name', 'fullName'])) ||
    '';
  const headline =
    asString(pickValue(profileBlock, ['headline'])) ||
    asString(pickValue(baseResume, ['headline'])) ||
    '';
  const location =
    asString(pickValue(contactBlock, ['location'])) ||
    asString(pickValue(baseResume, ['location', 'location_text', 'locationText'])) ||
    '';
  const email =
    asString(pickValue(contactBlock, ['email'])) ||
    asString(pickValue(baseResume, ['email'])) ||
    '';
  const phone =
    asString(pickValue(contactBlock, ['phone'])) ||
    asString(pickValue(baseResume, ['phone', 'phone_number', 'phoneNumber'])) ||
    '';
  const linkedin =
    asString(pickValue(contactBlock, ['linkedin'])) ||
    asString(pickValue(baseResume, ['linkedin', 'linkedin_url', 'linkedinUrl'])) ||
    '';

  const summaryValue =
    (baseResume.summary && typeof baseResume.summary === 'object'
      ? pickValue(baseResume.summary, ['text', 'summary'])
      : undefined) ??
    pickValue(baseResume, ['summary', 'summary_text', 'summaryText']);

  const workExperienceSource =
    baseResume.workExperience || baseResume.work_experience || baseResume.experience || [];
  const workExperience = Array.isArray(workExperienceSource)
    ? workExperienceSource.map(normalizeResumeWorkExperience).filter(Boolean)
    : [];

  const educationSource = baseResume.education || baseResume.educationHistory || [];
  const education = Array.isArray(educationSource)
    ? educationSource.map(normalizeResumeEducation).filter(Boolean)
    : [];

  const skillsRaw = normalizeResumeSkills(baseResume.skills ?? baseResume.skill ?? []);

  return {
    Profile: {
      name,
      headline,
      contact: {
        location,
        email,
        phone,
        linkedin
      }
    },
    summary: { text: asString(summaryValue) || '' },
    workExperience,
    education,
    skills: { raw: skillsRaw }
  };
};

const mapExtensionProfile = (row: any) => {
  const baseInfo = row.base_info || {};
  const ext = getExtensionBlock(baseInfo);
  const basePersonalInfo = buildPersonalInfoFromBaseInfo(baseInfo);
  const baseAdditionalInfo = buildAdditionalInfoFromBaseInfo(baseInfo);
  const extPersonalInfo = (ext as any).personal_info ?? (ext as any).personalInfo ?? {};
  const extAdditionalInfo = (ext as any).additional_info ?? (ext as any).additionalInfo ?? {};
  const mergedPersonalInfo = {
    ...extPersonalInfo,
    ...basePersonalInfo,
    phone: {
      ...(extPersonalInfo?.phone || {}),
      ...(basePersonalInfo as any).phone || {}
    }
  };
  const mergedAdditionalInfo = {
    ...extAdditionalInfo,
    ...baseAdditionalInfo
  };
  const normalizedResume = normalizeResumeFromBaseResume(row.base_resume);
  const extWorkExperienceSource = ext.work_experience ?? ext.workExperience ?? [];
  const normalizedExtWorkExperience = Array.isArray(extWorkExperienceSource)
    ? extWorkExperienceSource.map(normalizeResumeWorkExperience).filter(Boolean)
    : [];
  return {
    id: row.id,
    user_id: row.user_id,
    profile_name: row.name,
    color: ext.color ?? baseInfo.color ?? '#3B82F6',
    personal_info: mergedPersonalInfo,
    additional_info: mergedAdditionalInfo,
    education: ext.education ?? [],
    work_experience: normalizedExtWorkExperience,
    custom_fields: ext.custom_fields ?? ext.customFields ?? [],
    settings: ext.settings ?? DEFAULT_SETTINGS,
    resume: normalizedResume ?? row.base_resume ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
};

const mergeExtensionProfile = (baseInfo: any, payload: any) => {
  const nextBaseInfo = baseInfo && typeof baseInfo === 'object' ? { ...baseInfo } : {};
  const ext = { ...getExtensionBlock(nextBaseInfo) } as Record<string, unknown>;

  const setField = (key: string, value: unknown) => {
    if (value === undefined) return;
    ext[key] = value;
  };

  setField('color', payload.color);
  setField('personal_info', payload.personal_info ?? payload.personalInfo);
  setField('additional_info', payload.additional_info ?? payload.additionalInfo);
  setField('education', payload.education);
  setField('work_experience', payload.work_experience ?? payload.workExperience);
  setField('custom_fields', payload.custom_fields ?? payload.customFields);
  setField('settings', payload.settings);

  (nextBaseInfo as any).extension_profile = ext;
  return nextBaseInfo;
};

// Extension profiles
router.get('/profiles', async (req, res, next) => {
  try {
    const userRoles = req.currentUser?.roles || [];
    const userBadges = req.currentUser?.badges || [];
    const isAdmin = userRoles.includes('admin');
    const isManager = userRoles.includes('worker') && userBadges.includes('manager');
    const isBidder = userBadges.includes('bidder');
    
    let whereClause = 'p.deleted_at IS NULL';
    let params: any[] = [];
    
    if (isAdmin || isManager) {
      // Return all profiles
      whereClause = 'p.deleted_at IS NULL';
    } else if (isBidder) {
      // Return assigned profiles
      whereClause = 'p.assigned_bidder_user_id = $1 AND p.deleted_at IS NULL';
      params = [req.currentUser.id];
    } else {
      // Return owned profiles
      whereClause = 'p.user_id = $1 AND p.deleted_at IS NULL';
      params = [req.currentUser.id];
    }
    
    const { rows } = await query(
      `SELECT *
       FROM profiles p
       WHERE ${whereClause}
       ORDER BY p.created_at ASC`,
      params
    );
    res.json(rows.map(mapExtensionProfile));
  } catch (err) {
    next(err);
  }
});

router.get('/profiles/:profileId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT *
       FROM profiles
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.profileId, req.currentUser.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(mapExtensionProfile(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/profiles', async (req, res, next) => {
  const defaults = getProfileDefaults();
  const payload = req.body || {};
  const profileName = payload.profile_name ?? payload.name;
  if (!profileName) {
    return res.status(400).json({ error: 'missing_profile_name' });
  }

  const personalInfo = payload.personal_info ?? payload.personalInfo ?? defaults.personal_info;
  const additionalInfo = payload.additional_info ?? payload.additionalInfo ?? defaults.additional_info;
  const education = payload.education ?? defaults.education;
  const workExperience = payload.work_experience ?? payload.workExperience ?? defaults.work_experience;
  const customFields = payload.custom_fields ?? payload.customFields ?? defaults.custom_fields;
  const settings = payload.settings ?? defaults.settings;
  const resume = payload.resume ?? null;
  const normalizedResumeResult = normalizeBaseResumeExperienceDates(resume ?? {});
  if (normalizedResumeResult.issues.length > 0) {
    return res.status(400).json({
      error: 'invalid_resume_date',
      message: 'Invalid work experience date format. Use MM/YYYY, and use Present only for endDate.',
      issues: mapResumeDateIssues(normalizedResumeResult.issues)
    });
  }
  const normalizedResume = normalizedResumeResult.resume;

  try {
    const templateId = await ensureResumeTemplateId(req.currentUser.id);
    const extensionProfile = {
      color: payload.color ?? null,
      personal_info: personalInfo,
      additional_info: additionalInfo,
      education,
      work_experience: workExperience,
      custom_fields: customFields,
      settings
    };
    const baseInfoJson = toJson({ extension_profile: extensionProfile });
    const resumeJson = toJson(normalizedResume ?? {});
    const { rows } = await query(
      `INSERT INTO profiles
       (user_id, name, description, base_info, base_resume, resume_template_id)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb), COALESCE($5::jsonb, '{}'::jsonb), $6)
       RETURNING *`,
      [
        req.currentUser.id,
        profileName,
        payload.description ?? null,
        baseInfoJson,
        resumeJson,
        templateId
      ]
    );
    try {
      await notifyProfileCreated(req.currentUser.id, profileName);
    } catch (notifyErr) {
      console.error('[notifications] profile created event failed', notifyErr);
    }
    res.status(201).json(mapExtensionProfile(rows[0]));
  } catch (err) {
    const error = err as any;
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'duplicate_name' });
    }
    next(err);
  }
});

router.patch('/profiles/:profileId', async (req, res, next) => {
  const payload = req.body || {};
  const hasUpdates = [
    payload.profile_name,
    payload.name,
    payload.color,
    payload.personal_info,
    payload.personalInfo,
    payload.additional_info,
    payload.additionalInfo,
    payload.education,
    payload.work_experience,
    payload.workExperience,
    payload.custom_fields,
    payload.customFields,
    payload.settings,
    payload.resume
  ].some((value) => value !== undefined);

  if (!hasUpdates) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  try {
    const existing = await query(
      `SELECT id, name, base_info, base_resume
       FROM profiles
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.profileId, req.currentUser.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const row = existing.rows[0];
    const nameValue = payload.profile_name ?? payload.name;
    const nextName = nameValue ?? row.name;
    const extFieldsProvided = [
      payload.color,
      payload.personal_info,
      payload.personalInfo,
      payload.additional_info,
      payload.additionalInfo,
      payload.education,
      payload.work_experience,
      payload.workExperience,
      payload.custom_fields,
      payload.customFields,
      payload.settings
    ].some((value) => value !== undefined);

    const nextBaseInfo = extFieldsProvided ? mergeExtensionProfile(row.base_info, payload) : row.base_info;
    let nextResume = payload.resume !== undefined ? payload.resume : row.base_resume;
    if (payload.resume !== undefined) {
      const normalizedResumeResult = normalizeBaseResumeExperienceDates(payload.resume ?? {});
      if (normalizedResumeResult.issues.length > 0) {
        return res.status(400).json({
          error: 'invalid_resume_date',
          message: 'Invalid work experience date format. Use MM/YYYY, and use Present only for endDate.',
          issues: mapResumeDateIssues(normalizedResumeResult.issues)
        });
      }
      nextResume = normalizedResumeResult.resume;
    }

    const updates: string[] = [];
    const params: unknown[] = [req.params.profileId, req.currentUser.id];
    let idx = params.length + 1;

    if (nextName !== row.name) {
      updates.push(`name = $${idx}`);
      params.push(nextName);
      idx += 1;
    }
    if (extFieldsProvided) {
      updates.push(`base_info = $${idx}::jsonb`);
      params.push(toJson(nextBaseInfo));
      idx += 1;
    }
    if (payload.resume !== undefined) {
      updates.push(`base_resume = COALESCE($${idx}::jsonb, '{}'::jsonb)`);
      params.push(toJson(nextResume ?? {}));
      idx += 1;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    const { rows } = await query(
      `UPDATE profiles
       SET ${updates.join(', ')}
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(mapExtensionProfile(rows[0]));
  } catch (err) {
    const error = err as any;
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'duplicate_name' });
    }
    next(err);
  }
});

router.delete('/profiles/:profileId', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `UPDATE profiles
       SET deleted_at = now(), assigned_bidder_user_id = NULL, assigned_at = NULL
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params.profileId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Dynamic questions
router.get('/dynamic-questions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT *
       FROM dynamic_questions
       WHERE user_id = $1
       ORDER BY display_order ASC, created_at ASC`,
      [req.currentUser.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/dynamic-questions', async (req, res, next) => {
  const { question_text, field_type, options, is_required, display_order } = req.body || {};
  if (!question_text) return res.status(400).json({ error: 'missing_question_text' });

  try {
    const { rows } = await query(
      `INSERT INTO dynamic_questions
       (user_id, question_text, field_type, options, is_required, display_order)
       VALUES ($1, $2, COALESCE($3, 'text'), $4::jsonb, COALESCE($5, false), COALESCE($6, 0))
       RETURNING *`,
      [
        req.currentUser.id,
        question_text,
        field_type,
        toJson(options ?? null),
        is_required,
        display_order
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/dynamic-questions/:questionId', async (req, res, next) => {
  const { question_text, field_type, options, is_required, display_order } = req.body || {};
  const updates: string[] = [];
  const params: unknown[] = [req.params.questionId, req.currentUser.id];
  let idx = params.length + 1;

  const addUpdate = (column: string, value: unknown, castJson?: boolean) => {
    if (value === undefined) return;
    updates.push(`${column} = ${castJson ? `$${idx}::jsonb` : `$${idx}`}`);
    params.push(castJson ? toJson(value) : value);
    idx += 1;
  };

  addUpdate('question_text', question_text);
  addUpdate('field_type', field_type);
  addUpdate('options', options, true);
  addUpdate('is_required', is_required);
  addUpdate('display_order', display_order);

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  try {
    const { rows } = await query(
      `UPDATE dynamic_questions
       SET ${updates.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/dynamic-questions/:questionId', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM dynamic_questions
       WHERE id = $1 AND user_id = $2`,
      [req.params.questionId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Dynamic answers
router.get('/profiles/:profileId/dynamic-answers', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT da.*
       FROM dynamic_answers da
       JOIN profiles p ON p.id = da.profile_id
       WHERE da.profile_id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL`,
      [req.params.profileId, req.currentUser.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.put('/profiles/:profileId/dynamic-answers/:questionId', async (req, res, next) => {
  const { answer_text } = req.body || {};
  try {
    const owner = await query(
      `SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params.profileId, req.currentUser.id]
    );
    if (owner.rowCount === 0) return res.status(404).json({ error: 'profile_not_found' });

    const { rows } = await query(
      `INSERT INTO dynamic_answers (profile_id, question_id, answer_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile_id, question_id)
       DO UPDATE SET answer_text = EXCLUDED.answer_text, updated_at = now()
       RETURNING *`,
      [req.params.profileId, req.params.questionId, answer_text ?? '']
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/profiles/:profileId/dynamic-answers/:questionId', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM dynamic_answers da
       USING profiles p
       WHERE da.profile_id = p.id
         AND p.user_id = $1
         AND p.deleted_at IS NULL
         AND da.profile_id = $2
         AND da.question_id = $3`,
      [req.currentUser.id, req.params.profileId, req.params.questionId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.delete('/profiles/:profileId/dynamic-answers', async (req, res, next) => {
  try {
    await query(
      `DELETE FROM dynamic_answers da
       USING profiles p
       WHERE da.profile_id = p.id
         AND p.user_id = $1
         AND p.deleted_at IS NULL
         AND da.profile_id = $2`,
      [req.currentUser.id, req.params.profileId]
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

const listApplications = async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT *
       FROM applications
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.currentUser.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

// Applications (formerly bid statuses)
router.get('/applications', listApplications);
router.get('/bid-statuses', listApplications);

const upsertApplication = async (req, res, next) => {
  const { url, bid_entry } = req.body || {};
  if (!url || !bid_entry) {
    return res.status(400).json({ error: 'missing_bid_entry' });
  }
  const profileId = bid_entry?.profile_id;
  if (!profileId) {
    return res.status(400).json({ error: 'missing_profile_id' });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { rows: profileRows } = await client.query(
      `SELECT user_id,
              assigned_bidder_user_id
       FROM profiles
       WHERE id = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [profileId]
    );
    if (!profileRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'profile_not_found' });
    }
    const ownerId = profileRows[0].user_id;
    const assignedBidderId = profileRows[0].assigned_bidder_user_id
      ? String(profileRows[0].assigned_bidder_user_id)
      : null;
    const resolvedBidderRate = await resolveTalentRateForRole(client, 'bidder', [
      assignedBidderId,
      req.currentUser.id,
      ownerId
    ]);
    const applicationCost = resolvedBidderRate ?? getRoleBaseRate('bidder');

    const existing = await client.query(
      `SELECT id, bids
       FROM applications
       WHERE user_id = $1 AND url = $2
       LIMIT 1`,
      [req.currentUser.id, url]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const existingBids = Array.isArray(row.bids) ? row.bids : [];
      const alreadyApplied = existingBids.some(
        (bid: any) => bid?.profile_id === profileId
      );
      const updatedBids = existingBids.filter(
        (bid: any) => bid?.profile_id !== profileId
      );
      updatedBids.push(bid_entry);

      if (!alreadyApplied && applicationCost > 0) {
        const { rows: chargeRows } = await client.query(
          `UPDATE users
           SET balance = balance - $1
           WHERE id = $2 AND balance >= $1
           RETURNING balance`,
          [applicationCost, ownerId]
        );
        if (!chargeRows.length) {
          await client.query('ROLLBACK');
          const { rows: balanceRows } = await query(
            `SELECT balance FROM users WHERE id = $1`,
            [ownerId]
          );
          const balance = balanceRows[0]?.balance ?? 0;
          return res.status(402).json({
            error: 'insufficient_balance',
            message: 'Insufficient balance to apply.',
            balance,
            required: applicationCost
          });
        }
      }

      const { rows } = await client.query(
        `UPDATE applications
         SET bids = $1::jsonb
         WHERE id = $2
         RETURNING *`,
        [JSON.stringify(updatedBids), row.id]
      );
      await client.query('COMMIT');
      return res.json(rows[0]);
    }

    if (applicationCost > 0) {
      const { rows: chargeRows } = await client.query(
        `UPDATE users
         SET balance = balance - $1
         WHERE id = $2 AND balance >= $1
         RETURNING balance`,
        [applicationCost, ownerId]
      );
      if (!chargeRows.length) {
        await client.query('ROLLBACK');
        const { rows: balanceRows } = await query(
          `SELECT balance FROM users WHERE id = $1`,
          [ownerId]
        );
        const balance = balanceRows[0]?.balance ?? 0;
        return res.status(402).json({
          error: 'insufficient_balance',
          message: 'Insufficient balance to apply.',
          balance,
          required: applicationCost
        });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO applications (user_id, url, bids)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [req.currentUser.id, url, JSON.stringify([bid_entry])]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    next(err);
  } finally {
    client.release();
  }
};

router.post('/applications', upsertApplication);
router.post('/bid-statuses', upsertApplication);

const deleteApplication = async (req, res, next) => {
  const applicationId = req.params.applicationId ?? req.params.bidStatusId;
  try {
    const { rowCount } = await query(
      `DELETE FROM applications
       WHERE id = $1 AND user_id = $2`,
      [applicationId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

router.delete('/applications/:applicationId', deleteApplication);
router.delete('/bid-statuses/:bidStatusId', deleteApplication);

// Job links
router.get('/job-links', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT *
       FROM job_links
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.currentUser.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/job-links', async (req, res, next) => {
  const payload = req.body || {};
  const links = Array.isArray(payload.links)
    ? payload.links
    : payload.url
    ? [{ url: payload.url, title: payload.title, url_normalized: payload.url_normalized }]
    : [];

  if (links.length === 0) {
    return res.status(400).json({ error: 'missing_links' });
  }

  try {
    const results: any[] = [];
    for (const link of links) {
      const urlValue = String(link.url || '').trim();
      if (!urlValue) continue;
      const normalized = link.url_normalized ? String(link.url_normalized) : normalizeJobUrl(urlValue);
      if (!normalized) continue;
      const title = link.title ? String(link.title).trim() : null;
      const notes = link.notes ? String(link.notes).trim() : null;
      const jobDescription = link.job_description ? String(link.job_description).trim() : null;

      const { rows } = await query(
        `INSERT INTO job_links (user_id, url, url_normalized, title, notes, job_description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, url_normalized)
         DO UPDATE SET
           url = EXCLUDED.url,
           title = COALESCE(EXCLUDED.title, job_links.title),
           notes = COALESCE(EXCLUDED.notes, job_links.notes),
           job_description = COALESCE(EXCLUDED.job_description, job_links.job_description),
           updated_at = now()
         RETURNING *`,
        [req.currentUser.id, ensureUrlProtocol(urlValue), normalized, title, notes, jobDescription]
      );
      if (rows[0]) results.push(rows[0]);
    }
    res.json(results);
  } catch (err) {
    next(err);
  }
});

router.post('/job-links/:linkId/open', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE job_links
       SET open_count = open_count + 1,
           last_opened_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.linkId, req.currentUser.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/job-links/:linkId', async (req, res, next) => {
  try {
    const { title, notes, job_description } = req.body || {};
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(title ? String(title).trim() : null);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      values.push(notes ? String(notes).trim() : null);
    }
    if (job_description !== undefined) {
      updates.push(`job_description = $${paramIndex++}`);
      values.push(job_description ? String(job_description).trim() : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'no_updates' });
    }

    values.push(req.params.linkId, req.currentUser.id);
    const { rows } = await query(
      `UPDATE job_links
       SET ${updates.join(', ')}, updated_at = now()
       WHERE id = $${paramIndex++} AND user_id = $${paramIndex++}
       RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/job-links/:linkId', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM job_links
       WHERE id = $1 AND user_id = $2`,
      [req.params.linkId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Assistant chat
router.get('/assistant-chat/sessions', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT *
       FROM assistant_chat_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.currentUser.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/assistant-chat/sessions', async (req, res, next) => {
  const { title, profile_ids } = req.body || {};
  if (!title) return res.status(400).json({ error: 'missing_title' });

  try {
    const { rows } = await query(
      `INSERT INTO assistant_chat_sessions (user_id, title, profile_ids)
       VALUES ($1, $2, COALESCE($3::uuid[], '{}'::uuid[]))
       RETURNING *`,
      [req.currentUser.id, title, profile_ids ?? []]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/assistant-chat/sessions/:sessionId', async (req, res, next) => {
  const { title, profile_ids } = req.body || {};
  const updates: string[] = [];
  const params: unknown[] = [req.params.sessionId, req.currentUser.id];
  let idx = params.length + 1;

  if (title !== undefined) {
    updates.push(`title = $${idx}`);
    params.push(title);
    idx += 1;
  }
  if (profile_ids !== undefined) {
    updates.push(`profile_ids = COALESCE($${idx}::uuid[], '{}'::uuid[])`);
    params.push(profile_ids);
    idx += 1;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  try {
    const { rows } = await query(
      `UPDATE assistant_chat_sessions
       SET ${updates.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/assistant-chat/sessions/:sessionId/messages', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*
       FROM assistant_chat_messages m
       JOIN assistant_chat_sessions s ON s.id = m.session_id
       WHERE m.session_id = $1 AND s.user_id = $2
       ORDER BY m.created_at ASC`,
      [req.params.sessionId, req.currentUser.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/assistant-chat/sessions/:sessionId/messages', async (req, res, next) => {
  const { role, content } = req.body || {};
  if (!role || !content) {
    return res.status(400).json({ error: 'missing_message_fields' });
  }

  try {
    const owner = await query(
      `SELECT 1 FROM assistant_chat_sessions WHERE id = $1 AND user_id = $2`,
      [req.params.sessionId, req.currentUser.id]
    );
    if (owner.rowCount === 0) return res.status(404).json({ error: 'not_found' });

    const { rows } = await query(
      `INSERT INTO assistant_chat_messages (session_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.sessionId, role, content]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
