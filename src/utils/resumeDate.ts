type ResumeDateField = 'startDate' | 'endDate';

export type ResumeDateIssue = {
  key: string;
  index: number;
  field: ResumeDateField;
  value: string;
  message: string;
};

type NormalizeResumeDateOptions = {
  allowPresent?: boolean;
};

type NormalizeResumeDateResult = {
  value: string;
  isValid: boolean;
  isEmpty: boolean;
  error: string | null;
};

const PRESENT_LABEL = 'Present';
const WORK_EXPERIENCE_KEYS = ['workExperience', 'work_experience', 'experience'] as const;

const toTrimmedString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const normalizeMonthYear = (monthRaw: string, yearRaw: string): string | null => {
  const month = Number(monthRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!/^(\d{2}|\d{4})$/.test(yearRaw)) return null;
  const year2 = yearRaw.slice(-2);
  return `${String(month).padStart(2, '0')}/${year2}`;
};

const normalizeDateUsingPatterns = (value: string): string | null => {
  const mmYY = value.match(/^(\d{1,2})\/(\d{2})$/);
  if (mmYY) return normalizeMonthYear(mmYY[1], mmYY[2]);

  const mmYYYY = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (mmYYYY) return normalizeMonthYear(mmYYYY[1], mmYYYY[2]);

  const yyyyMM = value.match(/^(\d{4})-(\d{1,2})$/);
  if (yyyyMM) return normalizeMonthYear(yyyyMM[2], yyyyMM[1]);

  const yyyyMMDD = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
  if (yyyyMMDD) return normalizeMonthYear(yyyyMMDD[2], yyyyMMDD[1]);

  const mmDDYY = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mmDDYY) return normalizeMonthYear(mmDDYY[1], mmDDYY[3]);

  const mmDDYYYY = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmDDYYYY) return normalizeMonthYear(mmDDYYYY[1], mmDDYYYY[3]);

  return null;
};

export const normalizeResumeDateInput = (
  rawValue: unknown,
  options: NormalizeResumeDateOptions = {}
): NormalizeResumeDateResult => {
  const allowPresent = Boolean(options.allowPresent);
  const value = toTrimmedString(rawValue);
  if (!value) {
    return { value: '', isValid: true, isEmpty: true, error: null };
  }

  if (allowPresent && value.toLowerCase() === PRESENT_LABEL.toLowerCase()) {
    return { value: PRESENT_LABEL, isValid: true, isEmpty: false, error: null };
  }

  const normalized = normalizeDateUsingPatterns(value);
  if (normalized) {
    return { value: normalized, isValid: true, isEmpty: false, error: null };
  }

  return {
    value,
    isValid: false,
    isEmpty: false,
    error: `Invalid date "${value}". Expected MM/YY${allowPresent ? ' or Present' : ''}.`
  };
};

const readExperienceValue = (entry: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (!(key in entry)) continue;
    const value = entry[key];
    if (toTrimmedString(value)) return value;
  }
  return entry[keys[0]];
};

const normalizeExperienceEntriesForKey = (
  key: string,
  items: unknown[]
): { entries: unknown[]; issues: ResumeDateIssue[] } => {
  const entries = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;

    const entry = item as Record<string, unknown>;
    const nextEntry: Record<string, unknown> = { ...entry };
    const issues: ResumeDateIssue[] = [];

    const endRaw = readExperienceValue(entry, ['endDate', 'end_date']);
    const isPresent = Boolean(
      entry.isPresent ??
        entry.isCurrent ??
        (toTrimmedString(endRaw).toLowerCase() === PRESENT_LABEL.toLowerCase())
    );

    const startRaw = readExperienceValue(entry, ['startDate', 'start_date']);
    const normalizedStart = normalizeResumeDateInput(startRaw, { allowPresent: false });
    if (!normalizedStart.isValid) {
      issues.push({
        key,
        index,
        field: 'startDate',
        value: normalizedStart.value,
        message: normalizedStart.error || 'Invalid start date.'
      });
    } else {
      nextEntry.startDate = normalizedStart.value;
      if ('start_date' in entry) {
        nextEntry.start_date = normalizedStart.value;
      }
    }

    const normalizedEnd = normalizeResumeDateInput(
      isPresent ? PRESENT_LABEL : endRaw,
      { allowPresent: true }
    );
    if (!normalizedEnd.isValid) {
      issues.push({
        key,
        index,
        field: 'endDate',
        value: normalizedEnd.value,
        message: normalizedEnd.error || 'Invalid end date.'
      });
    } else {
      nextEntry.endDate = normalizedEnd.value;
      if ('end_date' in entry) {
        nextEntry.end_date = normalizedEnd.value;
      }
      nextEntry.isPresent = normalizedEnd.value === PRESENT_LABEL;
    }

    return { nextEntry, issues };
  });

  const issues = entries.flatMap((item) =>
    item && typeof item === 'object' && !Array.isArray(item) && 'issues' in item
      ? ((item as { issues: ResumeDateIssue[] }).issues || [])
      : []
  );
  const normalizedEntries = entries.map((item) =>
    item && typeof item === 'object' && !Array.isArray(item) && 'nextEntry' in item
      ? (item as { nextEntry: Record<string, unknown> }).nextEntry
      : item
  );

  return { entries: normalizedEntries, issues };
};

export const normalizeBaseResumeExperienceDates = (
  baseResume: unknown
): { resume: unknown; issues: ResumeDateIssue[] } => {
  if (!baseResume || typeof baseResume !== 'object' || Array.isArray(baseResume)) {
    return { resume: baseResume, issues: [] };
  }

  const source = baseResume as Record<string, unknown>;
  const nextResume: Record<string, unknown> = { ...source };
  const issues: ResumeDateIssue[] = [];

  for (const key of WORK_EXPERIENCE_KEYS) {
    const value = source[key];
    if (!Array.isArray(value)) continue;

    const normalized = normalizeExperienceEntriesForKey(key, value);
    nextResume[key] = normalized.entries;
    issues.push(...normalized.issues);
  }

  return { resume: nextResume, issues };
};
