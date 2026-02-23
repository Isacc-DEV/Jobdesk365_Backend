import { chromium, type Browser, type Page } from 'playwright';
import { XMLParser } from 'fast-xml-parser';
import { query } from '../db.js';

type BrowserScrapeConfig = {
  kind: 'browser';
  selector: string;
  multiple?: boolean;
  pageSelector?: string;
  pageQuery?: string;
  keywords?: string[];
  jobDescriptionSelector?: string;
};

type ApiScrapeConfig = {
  kind: 'remotive' | 'remoteok' | 'weworkremotely';
  jobDescriptionSelector?: string;
};

type ScrapeConfig = BrowserScrapeConfig | ApiScrapeConfig;

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];

const sourceConfigs: Record<string, ScrapeConfig> = {
  'Remote Rocketship': {
    kind: 'browser',
    selector: 'h3.mr-4>a'
  },
  Himalayas: {
    kind: 'browser',
    selector: 'article.border-gray-200 a.text-xl',
    multiple: true,
    pageSelector: 'nav[aria-label=pagination] ul>li:nth-last-child(1)>a',
    pageQuery: '&page=',
    keywords: ['developer', 'engineer', 'programmer']
  },
  Remotive: {
    kind: 'remotive'
  },
  RemoteOK: {
    kind: 'remoteok'
  },
  'We Work Remotely': {
    kind: 'weworkremotely'
  }
};

export type ScrapeResult = {
  url: string;
  title?: string;
  jobDescription?: string;
};

export type ScrapeOptions = {
  sourceName?: string;
  sourceUrl?: string;
  userId: string;
  maxPages?: number;
  timeoutMs?: number;
  headless?: boolean;
};

const pickUserAgent = (): string =>
  userAgents[Math.floor(Math.random() * userAgents.length)];

const normalizeJobUrl = (baseUrl: string, href: string): string | null => {
  try {
    const resolved = new URL(href, baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
};

const extractJobDescription = async (
  page: Page,
  url: string,
  selector?: string
): Promise<string | null> => {
  if (!selector) {
    // Try common selectors
    const commonSelectors = [
      '[data-testid*="job-description"]',
      '.job-description',
      '#job-description',
      '[class*="jobDescription"]',
      'main',
      'article'
    ];
    for (const sel of commonSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.textContent();
          if (text && text.length > 100) {
            return text.substring(0, 5000); // Limit length
          }
        }
      } catch {
        // Continue to next selector
      }
    }
    return null;
  }

  try {
    const el = await page.$(selector);
    if (el) {
      const text = await el.textContent();
      return text ? text.substring(0, 5000) : null;
    }
  } catch {
    // Ignore errors
  }
  return null;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': pickUserAgent(),
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': pickUserAgent(),
      Accept: 'application/xml,text/xml'
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
};

const collectRemotiveJobLinks = async (url: string): Promise<string[]> => {
  const data = await fetchJson<{ jobs?: Array<{ url?: string }> }>(url);
  const urls = (data.jobs ?? [])
    .map((job) => job.url)
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl));
  return urls.map((u) => normalizeJobUrl(url, u)).filter((u): u is string => Boolean(u));
};

const collectRemoteOkJobLinks = async (url: string): Promise<string[]> => {
  const data = await fetchJson<Array<{ url?: string }>>(url);
  const urls = data
    .map((job) => job.url)
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl));
  return urls.map((u) => normalizeJobUrl(url, u)).filter((u): u is string => Boolean(u));
};

const collectWeWorkRemotelyJobLinks = async (url: string): Promise<string[]> => {
  const xml = await fetchText(url);
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true
  });
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: Array<{ link?: string }> | { link?: string } } };
  };
  const items = parsed.rss?.channel?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  const urls = list
    .map((item) => item.link)
    .filter((jobUrl): jobUrl is string => Boolean(jobUrl));
  return urls.map((u) => normalizeJobUrl(url, u)).filter((u): u is string => Boolean(u));
};

const collectApiJobLinks = async (
  url: string,
  config: ApiScrapeConfig
): Promise<string[]> => {
  switch (config.kind) {
    case 'remotive':
      return collectRemotiveJobLinks(url);
    case 'remoteok':
      return collectRemoteOkJobLinks(url);
    case 'weworkremotely':
      return collectWeWorkRemotelyJobLinks(url);
    default:
      return [];
  }
};

const collectJobLinks = async (
  page: Page,
  pageUrl: string,
  config: BrowserScrapeConfig,
  options?: { skipNavigation?: boolean; timeoutMs?: number }
): Promise<string[]> => {
  const timeout = options?.timeoutMs ?? 20000;
  if (!options?.skipNavigation) {
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout
    });
  }

  await page.waitForSelector(config.selector, {
    timeout
  });

  const hrefs = await page.$$eval(config.selector, (nodes) =>
    nodes
      .map((node) => node.getAttribute('href'))
      .filter((href): href is string => Boolean(href))
  );

  const uniqueUrls = new Set<string>();
  for (const href of hrefs) {
    const jobUrl = normalizeJobUrl(pageUrl, href);
    if (!jobUrl) {
      continue;
    }
    if (config.keywords && !config.keywords.some((k) => jobUrl.toLowerCase().includes(k.toLowerCase()))) {
      continue;
    }
    uniqueUrls.add(jobUrl);
  }

  return Array.from(uniqueUrls);
};

const resolvePageUrls = async (
  page: Page,
  url: string,
  config: BrowserScrapeConfig,
  maxPages: number,
  timeoutMs: number
): Promise<{ pageUrls: string[]; firstPageReady: boolean }> => {
  if (!config.multiple || !config.pageSelector) {
    return { pageUrls: [url], firstPageReady: false };
  }

  let pageCount = 1;
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    await page.waitForSelector(config.selector, {
      timeout: timeoutMs
    });
    const pageText = await page.textContent(config.pageSelector);
    const extracted = pageText ? parseInt(pageText.match(/\d+/)?.[0] || '1', 10) : 1;
    if (extracted > 1) {
      pageCount = Math.min(extracted, maxPages);
    }
  } catch {
    return { pageUrls: [url], firstPageReady: false };
  }

  const pageQuery = config.pageQuery ?? '&page=';
  const pageUrls = Array.from({ length: pageCount }, (_value, index) =>
    index === 0 ? url : `${url}${pageQuery}${index + 1}`
  );

  return { pageUrls, firstPageReady: true };
};

const ensureUrlProtocol = (url: string): string => {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
};

const normalizeJobUrlForDb = (url: string): string => {
  try {
    const u = new URL(ensureUrlProtocol(url));
    const normalized = `${u.origin.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
    return normalized;
  } catch {
    return url.toLowerCase();
  }
};

export const scrapeJobLinks = async (options: ScrapeOptions): Promise<{
  found: number;
  saved: number;
  errors: number;
}> => {
  const {
    sourceName = 'Manual',
    sourceUrl,
    userId,
    maxPages = 2,
    timeoutMs = 20000,
    headless = true
  } = options;

  if (!sourceUrl) {
    throw new Error('sourceUrl is required');
  }

  const config = sourceConfigs[sourceName];
  if (!config) {
    throw new Error(`Unknown source: ${sourceName}`);
  }

  let browser: Browser | null = null;
  const results: ScrapeResult[] = [];
  let errors = 0;

  try {
    if (config.kind !== 'browser') {
      // API-based scraping
      const jobUrls = await collectApiJobLinks(sourceUrl, config);
      results.push(...jobUrls.map((url) => ({ url })));
    } else {
      // Browser-based scraping
      browser = await chromium.launch({ headless });
      const context = await browser.newContext({
        userAgent: pickUserAgent()
      });
      const page = await context.newPage();

      try {
        const { pageUrls, firstPageReady } = await resolvePageUrls(
          page,
          sourceUrl,
          config,
          maxPages,
          timeoutMs
        );

        for (const [index, pageUrl] of pageUrls.entries()) {
          const skipNavigation = firstPageReady && index === 0;
          let jobUrls: string[] = [];

          try {
            jobUrls = await collectJobLinks(page, pageUrl, config, {
              skipNavigation,
              timeoutMs
            });
          } catch (error) {
            errors++;
            console.error(`Page scrape failed for ${pageUrl}:`, error);
            continue;
          }

          results.push(...jobUrls.map((url) => ({ url })));
        }
      } finally {
        await page.close();
        await context.close();
      }
    }

    // Save to database
    let saved = 0;
    for (const result of results) {
      try {
        const normalized = normalizeJobUrlForDb(result.url);
        const { rows } = await query(
          `INSERT INTO job_links (user_id, url, url_normalized, title, job_description)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, url_normalized)
           DO UPDATE SET
             url = EXCLUDED.url,
             title = COALESCE(EXCLUDED.title, job_links.title),
             job_description = COALESCE(EXCLUDED.job_description, job_links.job_description),
             updated_at = now()
           RETURNING *`,
          [userId, ensureUrlProtocol(result.url), normalized, result.title || null, result.jobDescription || null]
        );
        if (rows[0]) saved++;
      } catch (error) {
        errors++;
        console.error(`Failed to save job link ${result.url}:`, error);
      }
    }

    return {
      found: results.length,
      saved,
      errors
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
