import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();
const RESUME_GENERATE_COST = 0.05;
const RESUME_REGENERATE_BASE_COST = 0.03;
const RESUME_REGENERATE_STEP_COST = 0.005;
const hasRole = (roles: string[] | null | undefined, role: string) =>
  Array.isArray(roles) && roles.includes(role);

type AiErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

const buildAiUrl = () => {
  const base = config.ai.baseUrl.replace(/\/+$/, '');
  return `${base}/chat/completions`;
};

const resolveRegenerateCharge = (rawGenerationTime: unknown) => {
  const parsed = Number(rawGenerationTime);
  const generationTime =
    Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 1;
  const amount =
    RESUME_REGENERATE_BASE_COST +
    RESUME_REGENERATE_STEP_COST * Math.max(0, generationTime - 1);
  return Math.round(amount * 1000) / 1000;
};

const SYSTEM_PROMPT = `You are an expert resume writer and ResumeTailorJSON.

TASK
Given a Job Description (JD) and a Base Resume, output a JSON object with:
- an updated headline aligned to the JD,
- an updated summary aligned to the JD but grounded in the Base Resume,
- bullets that are either NEW (to add) or UPDATED (to replace existing ones).

You rewrite resume bullet points to match a job description while maintaining truthfulness.
For bullets, you can either:
- ADD new bullets for JD requirements that are MISSING or WEAKLY SUPPORTED
- UPDATE existing bullets to better align with JD requirements

Output JSON only. Do not add commentary or markdown.

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
SPEED / OUTPUT LIMITS (HARD)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- summary_new: exactly 3â€“4 short lines
- skills_to_add: max 10
- experience_bullets_to_add: max 3 companies
- total new bullets across all companies: max 8
- Do NOT output JD extraction, requirement lists, or explanations

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
HEADLINE
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- headline_new must align to the JD job title using professional title keywords.
- Keep the headline concise (6-12 words) and truthful to the resume.
- Do NOT add domains, tools, or specialties not supported by the Base Resume.
- You may refine role titles for ATS clarity if supported by the resume content.

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
SUMMARY
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- 3â€“4 concise lines aligned to JD priorities.
- Use ONLY claims supported by Base Resume evidence.
- Prefer concrete impact phrasing; no buzzwords.

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
SKILLS
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- Keep skills the same unless the job description strongly indicates updates.
- Do NOT add credentials or claims not supported by the resume.
- Skills are not included in the output (keep them unchanged from base resume).

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
EXPERIENCE â€” BULLETS (NEW OR UPDATED)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- Keep the same number of experiences, order, and timelines as the Base Resume.
- Do NOT invent new employers, roles, or timelines.
- Internally extract up to 10â€“12 high-signal JD requirements.
- For each requirement, estimate coverage from the Base Resume:
  - strong, weak, adjacent, missing
- For requirements that are missing or weak:
  - If no existing bullet covers it: create a NEW bullet (type: "new")
  - If an existing bullet partially covers it but could be improved: UPDATE that bullet (type: "updated" with original_index)
- Generate ATS-optimized, professional bullets for each company.
- Do NOT generate more than ONE bullet per JD requirement across all companies.
- Distribute bullets across the most relevant companies (not only the most recent one).
- Group bullets by company_index (based on company order in Base Resume, most recent = 0).
- Do NOT output role titles or dates.
- You may refine role titles and company names for ATS clarity if supported by the resume content, but do NOT invent new employers.
- For "updated" bullets, specify the original_index (0-based) of the bullet you're replacing.

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
BULLET QUALITY RULES (CRITICAL)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- EACH bullet must be:
  - ONE complete, grammatically correct sentence.
  - Similar in length to the Base Resume bullets for the same company.
- Word count rule:
  - Estimate the typical bullet length for the company from the Base Resume.
  - New bullets must be within Â±20% of that length.
- Style:
  - No semicolons.
  - Clear action + what + how + impact structure.
- Tools/tech:
  - Include ONLY if evidenced in the Base Resume,
  - otherwise use needs_input=true with placeholders.
- Metrics:
  - Include ONLY if evidenced,
  - otherwise omit or use placeholders.

â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
OPENING PHRASE UNIQUENESS (INTERNAL ONLY â€” HARD)
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
- Internally define opening_phrase as:
  - text from the start of the sentence up to the first comma.
- Internally enforce that for each company_index:
  - every opening_phrase is UNIQUE (case-insensitive) across:
    - existing Base Resume bullets for that company (best-effort parse),
    - all new bullets generated for that company.
- Rewrite bullets internally until uniqueness is satisfied.
- Do NOT output opening_phrase separately; output ONLY the final bullet sentence.


â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
OUTPUT FORMAT â€” JSON ONLY
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Return exactly one valid JSON object with this schema and NO extra keys:

{
  "headline": "",
  "summary": "",
  "bullets": [
    {
      "company_index": 0,
      "bullets": [
        {
          "text": "",
          "type": "new"
        },
        {
          "text": "",
          "type": "updated",
          "original_index": 0
        }
      ]
    }
  ]
}

IMPORTANT:
- headline: Updated headline string (6-12 words, aligned to JD)
- summary: Updated summary string (full text, 3-4 lines when formatted)
- bullets: Array of bullet groups by company_index
  - Each bullet must have "text" and "type"
  - type: "new" for new bullets to add, "updated" for existing bullets to replace
  - For "updated" bullets, include "original_index" (0-based index of the bullet in the original company's bullets array)
  - Do NOT include bullets that remain unchanged

If company bullet parsing or length matching is uncertain, still produce best-effort output.`;

const buildUserPrompt = (jobDescription: string, baseResumeText: string) => `Tailor my resume to the JD using the system rules and return JSON only.

Return updated headline, summary, and bullets (with type: "new" or "updated").
For updated bullets, include the original_index of the bullet being replaced.

JOB DESCRIPTION:
<<<
${jobDescription}
>>>

BASE RESUME:
<<<
${baseResumeText}
>>>

Return JSON with:
- headline: Updated headline string
- summary: Updated summary string (full text)
- bullets: Array of bullet groups with company_index, each bullet having text, type ("new" or "updated"), and original_index if type is "updated"

Return the JSON now.`;

const QUESTION_ANSWER_SYSTEM_PROMPT = `You are a senior software engineer helping generate answers for job application questions.

Context you will receive:
1. My Resume
2. The Question
3. Previous answers to avoid repeating style

Answering priority:
- 60% focus on what the question is asking.
- 40% use my resume as supporting background.

Rules for generating the answer:

STYLE
- Write in natural spoken English.
- Only 1-2 sentences.
- Sound like a real engineer describing real experience.
- Avoid generic phrases such as "I am passionate about".
- Keep it simple and human.

EXPERIENCE HANDLING
- If the question asks for years of experience, return the largest reasonable number based on the career timeline.
- If the question mentions technologies not clearly in the resume, generate realistic related experience that fits a senior engineer background.
- The resume is a base resume and may not include every technology used, so realistic inference is allowed.

REALISM
- Experiences must sound believable for a senior software engineer.
- The answer should sound like it comes from real work projects.

VARIATION
- Do not repeat the same sentence structure used in previous answers.
- Slightly change tone and phrasing each time.

OUTPUT
- Return only the final answer text.
- No explanation, no bullet points, no markdown.`;

type QuestionAnswerPromptInput = {
  question: string;
  resumeText: string;
  previousAnswers: string[];
  estimatedCareerYears: number | null;
};

const buildQuestionAnswerPrompt = ({
  question,
  resumeText,
  previousAnswers,
  estimatedCareerYears
}: QuestionAnswerPromptInput) => {
  const history =
    previousAnswers.length > 0
      ? previousAnswers.map((answer, index) => `${index + 1}. ${answer}`).join('\n')
      : 'None';
  const yearsHint =
    typeof estimatedCareerYears === 'number' && Number.isFinite(estimatedCareerYears)
      ? String(estimatedCareerYears)
      : 'Unknown from timeline parsing';

  return `Generate one answer to the job application question using the system rules.

QUESTION:
<<<
${question}
>>>

RESUME:
<<<
${resumeText}
>>>

PREVIOUS ANSWERS (avoid repeating these patterns):
<<<
${history}
>>>

ESTIMATED CAREER YEARS FROM RESUME DATES:
${yearsHint}

Return the answer now.`;
};

const parsePossibleJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const toFourDigitYear = (yearValue: number) => {
  if (!Number.isFinite(yearValue)) return NaN;
  if (yearValue >= 100) return yearValue;
  const currentYearTwoDigits = new Date().getUTCFullYear() % 100;
  return yearValue <= currentYearTwoDigits ? 2000 + yearValue : 1900 + yearValue;
};

const buildMonthDate = (year: number, month: number): Date | null => {
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
};

const parseResumeMonthDate = (rawValue: unknown): Date | null => {
  if (rawValue === null || rawValue === undefined) return null;
  const value = String(rawValue).trim();
  if (!value || /^present$/i.test(value)) return null;

  let match = value.match(/^(\d{1,2})\/(\d{2})$/);
  if (match) {
    const month = Number(match[1]);
    const year = toFourDigitYear(Number(match[2]));
    return buildMonthDate(year, month);
  }

  match = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (match) {
    const month = Number(match[1]);
    const year = Number(match[2]);
    return buildMonthDate(year, month);
  }

  match = value.match(/^(\d{4})-(\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    return buildMonthDate(year, month);
  }

  match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    return buildMonthDate(year, month);
  }

  match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (match) {
    const month = Number(match[1]);
    const year = toFourDigitYear(Number(match[3]));
    return buildMonthDate(year, month);
  }

  match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const month = Number(match[1]);
    const year = Number(match[3]);
    return buildMonthDate(year, month);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return buildMonthDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
};

const getExperienceCollections = (resume: Record<string, any>) => {
  const collections: any[] = [];
  const candidateKeys = ['workExperience', 'work_experience', 'experience'];
  const objectsToCheck = [resume, resume?.resume, resume?.base_resume, resume?.baseResume];

  objectsToCheck.forEach((obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    candidateKeys.forEach((key) => {
      if (Array.isArray(obj[key])) {
        collections.push(obj[key]);
      }
    });
  });

  return collections;
};

const estimateCareerYearsFromResume = (resumeInput: unknown): number | null => {
  const parsed = parsePossibleJson(resumeInput);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const startDateKeys = ['startDate', 'start_date', 'from', 'fromDate', 'from_date', 'start'];
  const collections = getExperienceCollections(parsed as Record<string, any>);
  let earliestStart: Date | null = null;

  collections.forEach((items) => {
    items.forEach((item: any) => {
      if (!item || typeof item !== 'object') return;
      for (const key of startDateKeys) {
        const parsedDate = parseResumeMonthDate(item[key]);
        if (!parsedDate) continue;
        if (!earliestStart || parsedDate.getTime() < earliestStart.getTime()) {
          earliestStart = parsedDate;
        }
        break;
      }
    });
  });

  if (!earliestStart) return null;
  const now = Date.now();
  const diffYears = (now - earliestStart.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (!Number.isFinite(diffYears) || diffYears < 0) return null;

  const wholeYears = Math.floor(diffYears);
  if (wholeYears <= 0) return 1;
  return Math.min(wholeYears, 50);
};

const normalizeAnswerTo1or2Sentences = (rawText: string) => {
  let cleaned = String(rawText || '')
    .replace(/```(?:[\w-]+)?/g, ' ')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '').trim();
  cleaned = cleaned.replace(/^[-*]\s+/, '');
  if (!cleaned) return '';

  const sentenceMatches = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const sentences = sentenceMatches
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) return cleaned;
  return sentences.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
};

const extractAssistantContent = (payload: Record<string, any>) => {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
};

const parseJsonFromText = (text: string) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
};

const buildUpdatedResume = (baseResume: any, updates: any) => {
  // Start with a copy of base resume
  const updated = typeof baseResume === 'string' 
    ? JSON.parse(baseResume) 
    : JSON.parse(JSON.stringify(baseResume));

  // Update headline if provided
  if (updates.headline && typeof updates.headline === 'string') {
    if (updated.Profile) {
      updated.Profile.headline = updates.headline;
    } else {
      updated.headline = updates.headline;
      if (!updated.Profile) {
        updated.Profile = { headline: updates.headline };
      }
    }
  }

  // Update summary if provided
  if (updates.summary && typeof updates.summary === 'string') {
    if (updated.summary && typeof updated.summary === 'object' && updated.summary !== null) {
      updated.summary.text = updates.summary;
    } else {
      updated.summary = { text: updates.summary };
    }
  }

  // Update bullets if provided
  if (Array.isArray(updates.bullets)) {
    const workExperience = updated.workExperience || updated.work_experience || [];
    
    updates.bullets.forEach((group: any) => {
      const companyIndex = Number(group?.company_index);
      if (!Number.isFinite(companyIndex) || companyIndex < 0 || companyIndex >= workExperience.length) {
        return;
      }

      const company = workExperience[companyIndex];
      if (!company) return;

      // Ensure bullets array exists
      if (!Array.isArray(company.bullets)) {
        company.bullets = [];
      }

      // Process each bullet update
      if (Array.isArray(group.bullets)) {
        group.bullets.forEach((bulletUpdate: any) => {
          if (!bulletUpdate?.text || !bulletUpdate?.type) return;

          if (bulletUpdate.type === 'new') {
            // Add new bullet
            company.bullets.push(bulletUpdate.text);
          } else if (bulletUpdate.type === 'updated' && typeof bulletUpdate.original_index === 'number') {
            // Update existing bullet
            const originalIndex = bulletUpdate.original_index;
            if (originalIndex >= 0 && originalIndex < company.bullets.length) {
              company.bullets[originalIndex] = bulletUpdate.text;
            }
          }
        });
      }
    });
  }

  return updated;
};

router.use(authRequired, fetchCurrentUser);

router.post('/resume-tailor', async (req, res, next) => {
  if (!config.ai.apiKey) {
    return res.status(503).json({ error: 'ai_not_configured' });
  }

  const { job_description, profile_id } = req.body || {};
  const regenerate = Boolean(req.body?.regenerate);
  const generationTimeInput =
    req.body?.generation_time ??
    req.body?.generationTime ??
    req.body?.regeneration_time ??
    req.body?.regenerationTime;
  if (!job_description || typeof job_description !== 'string') {
    return res.status(400).json({ error: 'missing_job_description' });
  }
  if (!profile_id || typeof profile_id !== 'string') {
    return res.status(400).json({ error: 'missing_profile_id' });
  }

  let charged = false;
  let chargeAmount = regenerate
    ? resolveRegenerateCharge(generationTimeInput)
    : RESUME_GENERATE_COST;
  if (!Number.isFinite(chargeAmount) || chargeAmount < 0) chargeAmount = 0;
  const isAdmin = hasRole(req.currentUser?.roles, 'admin');
  let chargeUserId = req.currentUser.id;
  const refundCharge = async () => {
    if (!charged || chargeAmount <= 0) return;
    try {
      await query(
        `UPDATE users
         SET balance = balance + $1
         WHERE id = $2`,
        [chargeAmount, chargeUserId]
      );
    } catch {
      // best-effort refund
    }
  };

  try {
    const { rows } = await query<{ base_resume: unknown; user_id: string }>(
      isAdmin
        ? `SELECT base_resume, user_id
           FROM profiles
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`
        : `SELECT base_resume, user_id
           FROM profiles
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
      isAdmin ? [profile_id] : [profile_id, req.currentUser.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'profile_not_found' });
    }
    chargeUserId = rows[0]?.user_id || req.currentUser.id;

    if (chargeAmount > 0) {
      const { rows: chargeRows } = await query(
        `UPDATE users
         SET balance = balance - $1
         WHERE id = $2 AND balance >= $1
         RETURNING balance`,
        [chargeAmount, chargeUserId]
      );
      if (!chargeRows.length) {
        const { rows: balanceRows } = await query(
          `SELECT balance FROM users WHERE id = $1`,
          [chargeUserId]
        );
        const balance = balanceRows[0]?.balance ?? 0;
        return res.status(402).json({
          error: 'insufficient_balance',
          message: 'Insufficient balance to generate a resume.',
          balance,
          required: chargeAmount
        });
      }
      charged = true;
    }

    const baseResume = rows[0]?.base_resume ?? {};
    const baseResumeText =
      typeof baseResume === 'string' ? baseResume : JSON.stringify(baseResume, null, 2);
    const trimmedJobDescription = job_description.trim();
    if (!trimmedJobDescription) {
      return res.status(400).json({ error: 'missing_job_description' });
    }

    // Store baseResume for later use in buildUpdatedResume
    const baseResumeForUpdate = typeof baseResume === 'string' 
      ? JSON.parse(baseResume) 
      : baseResume;

    const userPrompt = buildUserPrompt(trimmedJobDescription, baseResumeText || '{}');
    const requestBody: Record<string, any> = {
      model: config.ai.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    };
    if (config.ai.provider === 'openai') {
      requestBody.response_format = { type: 'json_object' };
    }

    const response = await fetch(buildAiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const rawText = await response.text();
    let payload: Record<string, any> = {};

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { error: { message: rawText } };
      }
    }

    if (!response.ok) {
      const errorPayload = payload as AiErrorResponse;
      const message =
        errorPayload?.error?.message || 'AI provider request failed.';
      await refundCharge();
      return res.status(response.status).json({ error: 'ai_provider_error', message });
    }

    const content = payload?.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonFromText(content);

    if (!parsed) {
      await refundCharge();
      return res.status(502).json({
        error: 'invalid_ai_response',
        message: 'AI response was not valid JSON.',
        raw: content
      });
    }

    // Generate updated resume from the AI response
    const updatedResume = buildUpdatedResume(baseResumeForUpdate, parsed);

    return res.json({
      updates: parsed,
      resume: updatedResume
    });
  } catch (err) {
    await refundCharge();
    return next(err);
  }
});

router.post('/resume-question-answer', async (req, res, next) => {
  if (!config.ai.apiKey) {
    return res.status(503).json({ error: 'ai_not_configured' });
  }

  const rawQuestion = req.body?.question;
  const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : '';
  if (!question) {
    return res.status(400).json({ error: 'missing_question' });
  }

  const rawProfileId = req.body?.profile_id;
  const profileId = typeof rawProfileId === 'string' ? rawProfileId.trim() : '';
  const isAdmin = hasRole(req.currentUser?.roles, 'admin');

  const previousAnswers = Array.isArray(req.body?.previous_answers)
    ? req.body.previous_answers
        .map((value: unknown) => String(value || '').trim())
        .filter(Boolean)
        .slice(-8)
    : [];

  try {
    let resumeSource = req.body?.resume;

    if (
      resumeSource === undefined ||
      resumeSource === null ||
      (typeof resumeSource === 'string' && !resumeSource.trim())
    ) {
      if (!profileId) {
        return res.status(400).json({ error: 'missing_resume_context' });
      }

      const { rows } = await query<{ base_resume: unknown }>(
        isAdmin
          ? `SELECT base_resume
             FROM profiles
             WHERE id = $1 AND deleted_at IS NULL
             LIMIT 1`
          : `SELECT base_resume
             FROM profiles
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
             LIMIT 1`,
        isAdmin ? [profileId] : [profileId, req.currentUser.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'profile_not_found' });
      }
      resumeSource = rows[0]?.base_resume;
    }

    let resumeText = '';
    if (typeof resumeSource === 'string') {
      resumeText = resumeSource.trim();
    } else if (resumeSource && typeof resumeSource === 'object') {
      try {
        resumeText = JSON.stringify(resumeSource, null, 2);
      } catch {
        resumeText = '';
      }
    }

    if (!resumeText) {
      return res.status(400).json({ error: 'missing_resume_context' });
    }

    const estimatedCareerYears = estimateCareerYearsFromResume(resumeSource);
    const userPrompt = buildQuestionAnswerPrompt({
      question,
      resumeText,
      previousAnswers,
      estimatedCareerYears
    });

    const requestBody: Record<string, any> = {
      model: config.ai.model,
      messages: [
        { role: 'system', content: QUESTION_ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.9,
      max_tokens: 140
    };

    const response = await fetch(buildAiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const rawText = await response.text();
    let payload: Record<string, any> = {};

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { error: { message: rawText } };
      }
    }

    if (!response.ok) {
      const errorPayload = payload as AiErrorResponse;
      const message = errorPayload?.error?.message || 'AI provider request failed.';
      return res.status(response.status).json({ error: 'ai_provider_error', message });
    }

    const content = extractAssistantContent(payload);
    const answer = normalizeAnswerTo1or2Sentences(content);
    if (!answer) {
      return res.status(502).json({
        error: 'invalid_ai_response',
        message: 'AI response did not include a valid answer.',
        raw: content
      });
    }

    return res.json({ answer });
  } catch (err) {
    return next(err);
  }
});

export default router;

