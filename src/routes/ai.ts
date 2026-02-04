import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

type OpenAiErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

const buildOpenAiUrl = () => {
  const base = config.openai.baseUrl.replace(/\/+$/, '');
  return `${base}/chat/completions`;
};

const SYSTEM_PROMPT = `You are ResumeTailorJSON.

TASK
Given a Job Description (JD) and a Base Resume, output a minimal JSON object with:
- an updated headline aligned to the JD,
- an updated summary aligned to the JD but grounded in the Base Resume,
- skills_to_add (only if evidenced in the Base Resume),
- NEW bullets to add for JD requirements that are MISSING or WEAKLY SUPPORTED,
- a single match_score (0–100).

You must NOT rewrite, edit, or upgrade any existing base resume bullets.
You may ONLY ADD new bullets.

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
- headline_new must align to the JD job title.
- Do NOT add domains, tools, or specialties not supported by the Base Resume.

────────────────────────
SUMMARY
────────────────────────
- 3–4 concise lines aligned to JD priorities.
- Use ONLY claims supported by Base Resume evidence.
- Prefer concrete impact phrasing; no buzzwords.

────────────────────────
SKILLS
────────────────────────
- skills_to_add must include ONLY skills that:
  (a) are important for the JD AND
  (b) are clearly evidenced in the Base Resume text.
- Each skill item: { "skill": ""}
- Do NOT include unsupported JD keywords.

────────────────────────
EXPERIENCE — NEW BULLETS ONLY
────────────────────────
- Internally extract up to 10–12 high-signal JD requirements.
- For each requirement, estimate coverage from the Base Resume:
  - strong, weak, adjacent, missing
- Generate new bullets ONLY for requirements that are:
  - missing OR
  - weak
- Do NOT generate more than ONE new bullet per JD requirement across all companies.
- Distribute bullets across the most relevant companies (not only the most recent one).
- Group bullets by company_index (based on company order in Base Resume, most recent = 0).
- Do NOT output role titles or dates.

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
MATCH SCORE (ONLY SCORE)
────────────────────────
- Coverage values:
  - strong = 1.0
  - weak = 0.6
  - adjacent = 0.3
  - missing = 0.0
- Weight:
  - must-like = 3
  - preferred-like = 2
- match_score = round(100 * sum(weight × coverage) / sum(weight))
- Output ONLY the final match_score number.

────────────────────────
OUTPUT FORMAT — JSON ONLY
────────────────────────
Return exactly one valid JSON object with this schema and NO extra keys:

{
  "schema_version": "2.4",
  "match_score": 0,
  "headline_new": "",
  "summary_new": ["", "", ""],
  "skills_to_add": [
    { "skill": ""}
  ],
  "experience_bullets_to_add": [
    {
      "company_index": 0,
      "bullets": [
        {
          "text": "",
          "needs_input": false,
          "needs_input_fields": []
        }
      ]
    }
  ],
  "parsing_warnings": []
}

If company bullet parsing or length matching is uncertain, add a short note to parsing_warnings and still produce best-effort output.`;

const buildUserPrompt = (jobDescription: string, baseResumeText: string) => `Tailor my resume to the JD using the system rules and return JSON only.

JOB DESCRIPTION:
<<<
${jobDescription}
>>>

BASE RESUME:
<<<
${baseResumeText}
>>>
Return the tailored resume JSON now.`;

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

router.use(authRequired, fetchCurrentUser);

router.post('/resume-tailor', async (req, res, next) => {
  if (!config.openai.apiKey) {
    return res.status(503).json({ error: 'openai_not_configured' });
  }

  const { job_description, profile_id } = req.body || {};
  if (!job_description || typeof job_description !== 'string') {
    return res.status(400).json({ error: 'missing_job_description' });
  }
  if (!profile_id || typeof profile_id !== 'string') {
    return res.status(400).json({ error: 'missing_profile_id' });
  }

  try {
    const { rows } = await query(
      `SELECT base_resume
       FROM profiles
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [profile_id, req.currentUser.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'profile_not_found' });
    }

    const baseResume = rows[0]?.base_resume ?? {};
    const baseResumeText =
      typeof baseResume === 'string' ? baseResume : JSON.stringify(baseResume, null, 2);
    const trimmedJobDescription = job_description.trim();
    if (!trimmedJobDescription) {
      return res.status(400).json({ error: 'missing_job_description' });
    }

    const userPrompt = buildUserPrompt(trimmedJobDescription, baseResumeText || '{}');
    const response = await fetch(buildOpenAiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.openai.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
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
      const errorPayload = payload as OpenAiErrorResponse;
      const message =
        errorPayload?.error?.message || 'OpenAI request failed.';
      return res.status(response.status).json({ error: 'openai_error', message });
    }

    const content = payload?.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonFromText(content);

    if (!parsed) {
      return res.status(502).json({
        error: 'invalid_ai_response',
        message: 'AI response was not valid JSON.',
        raw: content
      });
    }

    return res.json(parsed);
  } catch (err) {
    return next(err);
  }
});

export default router;
