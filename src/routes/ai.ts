import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();
const RESUME_GENERATE_COST = 0.04;
const RESUME_REGENERATE_COST = 0.02;
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

────────────────────────
SPEED / OUTPUT LIMITS (HARD)
────────────────────────
- summary_new: exactly 3–4 short lines
- skills_to_add: max 10
- experience_bullets_to_add: max 3 companies
- total new bullets across all companies: max 8
- Do NOT output JD extraction, requirement lists, or explanations

────────────────────────
HEADLINE
────────────────────────
- headline_new must align to the JD job title using professional title keywords.
- Keep the headline concise (6-12 words) and truthful to the resume.
- Do NOT add domains, tools, or specialties not supported by the Base Resume.
- You may refine role titles for ATS clarity if supported by the resume content.

────────────────────────
SUMMARY
────────────────────────
- 3–4 concise lines aligned to JD priorities.
- Use ONLY claims supported by Base Resume evidence.
- Prefer concrete impact phrasing; no buzzwords.

────────────────────────
SKILLS
────────────────────────
- Keep skills the same unless the job description strongly indicates updates.
- Do NOT add credentials or claims not supported by the resume.
- Skills are not included in the output (keep them unchanged from base resume).

────────────────────────
EXPERIENCE — BULLETS (NEW OR UPDATED)
────────────────────────
- Keep the same number of experiences, order, and timelines as the Base Resume.
- Do NOT invent new employers, roles, or timelines.
- Internally extract up to 10–12 high-signal JD requirements.
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

────────────────────────
BULLET QUALITY RULES (CRITICAL)
────────────────────────
- EACH bullet must be:
  - ONE complete, grammatically correct sentence.
  - Similar in length to the Base Resume bullets for the same company.
- Word count rule:
  - Estimate the typical bullet length for the company from the Base Resume.
  - New bullets must be within ±20% of that length.
- Style:
  - No semicolons.
  - Clear action + what + how + impact structure.
- Tools/tech:
  - Include ONLY if evidenced in the Base Resume,
  - otherwise use needs_input=true with placeholders.
- Metrics:
  - Include ONLY if evidenced,
  - otherwise omit or use placeholders.

────────────────────────
OPENING PHRASE UNIQUENESS (INTERNAL ONLY — HARD)
────────────────────────
- Internally define opening_phrase as:
  - text from the start of the sentence up to the first comma.
- Internally enforce that for each company_index:
  - every opening_phrase is UNIQUE (case-insensitive) across:
    - existing Base Resume bullets for that company (best-effort parse),
    - all new bullets generated for that company.
- Rewrite bullets internally until uniqueness is satisfied.
- Do NOT output opening_phrase separately; output ONLY the final bullet sentence.


────────────────────────
OUTPUT FORMAT — JSON ONLY
────────────────────────
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
  if (!job_description || typeof job_description !== 'string') {
    return res.status(400).json({ error: 'missing_job_description' });
  }
  if (!profile_id || typeof profile_id !== 'string') {
    return res.status(400).json({ error: 'missing_profile_id' });
  }

  let charged = false;
  let chargeAmount = regenerate ? RESUME_REGENERATE_COST : RESUME_GENERATE_COST;
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

export default router;
