import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import express from 'express';
import { config } from '../config.js';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

const PRICE_CURRENCY = 'usd';
const FINISHED_STATUS = 'finished';
const FINAL_PAYMENT_STATUSES = new Set(['finished', 'failed', 'expired', 'refunded']);

type BillingTopupRow = {
  id: string;
  user_id: string;
  amount: string | number;
  price_currency: string;
  pay_currency: string;
  nowpayments_invoice_id: string | null;
  nowpayments_payment_id: string | null;
  nowpayments_order_id: string;
  checkout_url: string | null;
  payment_status: string;
  credited_at: string | Date | null;
  credited_amount: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type NowPaymentsInvoiceResponse = {
  id?: string | number;
  invoice_id?: string | number;
  invoice_url?: string;
  url?: string;
  payment_status?: string;
  invoice_status?: string;
};

type NowPaymentsPaymentResponse = {
  payment_id?: string | number;
  invoice_id?: string | number;
  payment_status?: string;
  order_id?: string;
};

let billingSchemaPromise: Promise<void> | null = null;

const ensureBillingSchema = async () => {
  if (billingSchemaPromise) return billingSchemaPromise;
  billingSchemaPromise = (async () => {
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
    await query(`
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
    await query(`
      DROP TRIGGER IF EXISTS trg_billing_topups_updated_at ON billing_topups;
      CREATE TRIGGER trg_billing_topups_updated_at
      BEFORE UPDATE ON billing_topups
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_billing_topups_user_id ON billing_topups (user_id, created_at DESC)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_billing_topups_payment_status ON billing_topups (payment_status)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_billing_topups_credited_at ON billing_topups (credited_at DESC)`
    );
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_topups_invoice_id
       ON billing_topups (nowpayments_invoice_id)
       WHERE nowpayments_invoice_id IS NOT NULL`
    );
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_topups_payment_id
       ON billing_topups (nowpayments_payment_id)
       WHERE nowpayments_payment_id IS NOT NULL`
    );
  })();

  try {
    await billingSchemaPromise;
  } catch (err) {
    billingSchemaPromise = null;
    throw err;
  }

  return billingSchemaPromise;
};

const parseNonEmptyText = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
};

const parseAmount = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const rounded = Math.round(parsed * 100) / 100;
  if (Math.abs(rounded - parsed) > 1e-9) return null;
  return rounded;
};

const getTopupBounds = () => {
  const minRaw = config.nowpayments.topupMin;
  const maxRaw = config.nowpayments.topupMax;
  const min = typeof minRaw === 'number' && Number.isFinite(minRaw) ? Math.round(minRaw * 100) / 100 : NaN;
  const max = typeof maxRaw === 'number' && Number.isFinite(maxRaw) ? Math.round(maxRaw * 100) / 100 : NaN;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new Error('billing_topup_bounds_not_configured');
  }
  return { min, max };
};

const appendQueryParam = (targetUrl: string, key: string, value: string): string => {
  if (!targetUrl) return targetUrl;
  try {
    const url = new URL(targetUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const hashIndex = targetUrl.indexOf('#');
    const hasHash = hashIndex >= 0;
    const withoutHash = hasHash ? targetUrl.slice(0, hashIndex) : targetUrl;
    const hashPart = hasHash ? targetUrl.slice(hashIndex) : '';
    const separator = withoutHash.includes('?') ? '&' : '?';
    return `${withoutHash}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hashPart}`;
  }
};

const sortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortObject(source[key]);
      return acc;
    }, {});
};

const isValidNowPaymentsSignature = (payload: unknown, signatureHeader: string | undefined): boolean => {
  if (!config.nowpayments.ipnSecret) return false;
  if (!signatureHeader) return false;
  const signature = signatureHeader.trim().toLowerCase();
  if (!signature) return false;
  const hashed = createHmac('sha512', config.nowpayments.ipnSecret)
    .update(JSON.stringify(sortObject(payload)))
    .digest('hex')
    .toLowerCase();
  const expected = Buffer.from(hashed);
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
};

const normalizeStatus = (value: unknown): string => {
  const parsed = parseNonEmptyText(value);
  return parsed ? parsed.toLowerCase() : 'unknown';
};

const toTopupResponse = (row: BillingTopupRow) => ({
  id: row.id,
  amount: Number(row.amount),
  price_currency: row.price_currency,
  pay_currency: row.pay_currency,
  nowpayments_invoice_id: row.nowpayments_invoice_id,
  nowpayments_payment_id: row.nowpayments_payment_id,
  nowpayments_order_id: row.nowpayments_order_id,
  checkout_url: row.checkout_url,
  payment_status: row.payment_status,
  credited_at: row.credited_at,
  credited_amount:
    row.credited_amount === null || row.credited_amount === undefined
      ? null
      : Number(row.credited_amount),
  is_terminal: FINAL_PAYMENT_STATUSES.has(String(row.payment_status || '').toLowerCase()),
  created_at: row.created_at,
  updated_at: row.updated_at
});

const nowpaymentsApiBaseUrl = () => config.nowpayments.baseUrl.replace(/\/+$/, '');

const creditTopupInTransaction = async (
  topupId: string,
  paymentStatus: string,
  paymentId: string | null,
  invoiceId: string | null,
  payload: unknown
) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const locked = await client.query<BillingTopupRow>(
      `SELECT *
       FROM billing_topups
       WHERE id = $1
       FOR UPDATE`,
      [topupId]
    );
    const topup = locked.rows[0];
    if (!topup) {
      await client.query('ROLLBACK');
      return { topup: null, credited: false };
    }

    await client.query(
      `UPDATE billing_topups
       SET payment_status = $2,
           nowpayments_invoice_id = COALESCE($3, nowpayments_invoice_id),
           nowpayments_payment_id = COALESCE($4, nowpayments_payment_id),
           ipn_last_payload = $5::jsonb
       WHERE id = $1`,
      [topup.id, paymentStatus, invoiceId, paymentId, JSON.stringify(payload || {})]
    );

    let credited = false;
    if (paymentStatus === FINISHED_STATUS && !topup.credited_at) {
      await client.query(
        `UPDATE users
         SET balance = balance + $1
         WHERE id = $2`,
        [topup.amount, topup.user_id]
      );
      await client.query(
        `UPDATE billing_topups
         SET credited_at = now(),
             credited_amount = amount,
             payment_status = $2
         WHERE id = $1`,
        [topup.id, FINISHED_STATUS]
      );
      credited = true;
    }

    const fresh = await client.query<BillingTopupRow>(
      `SELECT *
       FROM billing_topups
       WHERE id = $1
       LIMIT 1`,
      [topup.id]
    );
    await client.query('COMMIT');
    return { topup: fresh.rows[0] || null, credited };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

router.use(async (_req, _res, next) => {
  try {
    await ensureBillingSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.post('/nowpayments/ipn', async (req, res, next) => {
  if (!config.nowpayments.ipnSecret) {
    return res.status(503).json({ error: 'billing_not_configured' });
  }

  const signatureHeader = req.header('x-nowpayments-sig') || '';
  if (!isValidNowPaymentsSignature(req.body, signatureHeader)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const paymentStatus = normalizeStatus((payload as Record<string, unknown>).payment_status);
  const orderId = parseNonEmptyText((payload as Record<string, unknown>).order_id);
  const invoiceId =
    parseNonEmptyText((payload as Record<string, unknown>).invoice_id) ||
    parseNonEmptyText((payload as Record<string, unknown>).id);
  const paymentId = parseNonEmptyText((payload as Record<string, unknown>).payment_id);

  if (!orderId && !invoiceId) {
    return res.status(400).json({ error: 'missing_provider_reference' });
  }

  try {
    const topupLookup = orderId
      ? await query<{ id: string }>(
          `SELECT id
           FROM billing_topups
           WHERE nowpayments_order_id = $1
           LIMIT 1`,
          [orderId]
        )
      : await query<{ id: string }>(
          `SELECT id
           FROM billing_topups
           WHERE nowpayments_invoice_id = $1
           LIMIT 1`,
          [invoiceId]
        );

    let topupId = topupLookup.rows[0]?.id || null;
    if (!topupId && invoiceId) {
      const invoiceLookup = await query<{ id: string }>(
        `SELECT id
         FROM billing_topups
         WHERE nowpayments_invoice_id = $1
         LIMIT 1`,
        [invoiceId]
      );
      topupId = invoiceLookup.rows[0]?.id || null;
    }

    if (!topupId) {
      return res.json({ received: true, ignored: 'topup_not_found' });
    }

    try {
      const { credited } = await creditTopupInTransaction(
        topupId,
        paymentStatus,
        paymentId,
        invoiceId,
        payload
      );
      return res.json({ received: true, credited, payment_status: paymentStatus });
    } catch (err) {
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

router.use(authRequired, fetchCurrentUser);

router.post('/topups/checkout', async (req, res, next) => {
  if (!config.features.nowpaymentsEnabled) {
    return res.status(503).json({
      error: 'billing_not_configured',
      message: 'NOWPayments integration is not fully configured.'
    });
  }

  const amount = parseAmount(req.body?.amount);
  if (amount === null) {
    return res.status(400).json({
      error: 'invalid_amount',
      message: 'Amount must be a positive number with up to 2 decimals.'
    });
  }
  const { min, max } = getTopupBounds();
  if (amount < min || amount > max) {
    return res.status(400).json({
      error: 'amount_out_of_range',
      message: `Amount must be between ${min.toFixed(2)} and ${max.toFixed(2)}.`
    });
  }

  const topupId = randomUUID();
  const nowpaymentsOrderId = `topup_${topupId}`;
  try {
    await query(
      `INSERT INTO billing_topups (
         id,
         user_id,
         amount,
         price_currency,
         pay_currency,
         nowpayments_order_id,
         payment_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'created')`,
      [topupId, req.currentUser.id, amount, PRICE_CURRENCY, config.nowpayments.payCurrency, nowpaymentsOrderId]
    );

    const successUrl = appendQueryParam(config.nowpayments.successUrl, 'topup_id', topupId);
    const cancelUrl = appendQueryParam(config.nowpayments.cancelUrl, 'topup_id', topupId);

    const providerRes = await fetch(`${nowpaymentsApiBaseUrl()}/invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.nowpayments.apiKey
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: PRICE_CURRENCY,
        pay_currency: config.nowpayments.payCurrency,
        order_id: nowpaymentsOrderId,
        order_description: `Jobdesk365 credit topup (${req.currentUser.id})`,
        ipn_callback_url: config.nowpayments.ipnCallbackUrl,
        success_url: successUrl,
        cancel_url: cancelUrl
      })
    });

    const rawProviderBody = await providerRes.text();
    let providerPayload: NowPaymentsInvoiceResponse = {};
    if (rawProviderBody) {
      try {
        providerPayload = JSON.parse(rawProviderBody) as NowPaymentsInvoiceResponse;
      } catch {
        providerPayload = {};
      }
    }

    if (!providerRes.ok) {
      await query(
        `UPDATE billing_topups
         SET payment_status = 'provider_error',
             ipn_last_payload = $2::jsonb
         WHERE id = $1`,
        [topupId, JSON.stringify({ status: providerRes.status, body: rawProviderBody })]
      );
      return res.status(502).json({
        error: 'provider_error',
        message: 'NOWPayments failed to create invoice.'
      });
    }

    const checkoutUrl =
      parseNonEmptyText(providerPayload.invoice_url) || parseNonEmptyText(providerPayload.url);
    const providerStatusRaw = normalizeStatus(providerPayload.payment_status || providerPayload.invoice_status);
    const providerStatus = providerStatusRaw === 'unknown' ? 'waiting' : providerStatusRaw;
    const providerInvoiceId =
      parseNonEmptyText(providerPayload.invoice_id) || parseNonEmptyText(providerPayload.id);

    if (!checkoutUrl) {
      await query(
        `UPDATE billing_topups
         SET payment_status = 'provider_error',
             ipn_last_payload = $2::jsonb
         WHERE id = $1`,
        [topupId, JSON.stringify(providerPayload || {})]
      );
      return res.status(502).json({
        error: 'provider_error',
        message: 'NOWPayments response did not include invoice URL.'
      });
    }

    const { rows } = await query<BillingTopupRow>(
      `UPDATE billing_topups
       SET checkout_url = $2,
           payment_status = $3,
           nowpayments_invoice_id = COALESCE($4, nowpayments_invoice_id),
           ipn_last_payload = $5::jsonb
       WHERE id = $1
       RETURNING *`,
      [topupId, checkoutUrl, providerStatus, providerInvoiceId, JSON.stringify(providerPayload || {})]
    );

    const row = rows[0];
    return res.json({
      topup_id: row.id,
      checkout_url: row.checkout_url,
      payment_status: row.payment_status,
      amount: Number(row.amount),
      pay_currency: row.pay_currency
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/topups/:topupId', async (req, res, next) => {
  const topupId = parseNonEmptyText(req.params?.topupId);
  if (!topupId) {
    return res.status(400).json({ error: 'invalid_topup_id' });
  }
  try {
    const { rows } = await query<BillingTopupRow>(
      `SELECT *
       FROM billing_topups
       WHERE id = $1
         AND user_id = $2
       LIMIT 1`,
      [topupId, req.currentUser.id]
    );
    let topup = rows[0];
    if (!topup) {
      return res.status(404).json({ error: 'topup_not_found' });
    }

    const npId = parseNonEmptyText(req.query?.np_id);
    const shouldSyncFromProvider =
      Boolean(npId) &&
      !topup.credited_at &&
      ['unknown', 'created', 'waiting', 'pending', 'confirming'].includes(
        String(topup.payment_status || '').toLowerCase()
      ) &&
      Boolean(config.nowpayments.apiKey);

    if (shouldSyncFromProvider) {
      try {
        const providerRes = await fetch(`${nowpaymentsApiBaseUrl()}/payment/${encodeURIComponent(npId as string)}`, {
          method: 'GET',
          headers: {
            'x-api-key': config.nowpayments.apiKey
          }
        });
        if (providerRes.ok) {
          const payload = (await providerRes.json()) as NowPaymentsPaymentResponse;
          const providerOrderId = parseNonEmptyText(payload.order_id);
          const providerStatus = normalizeStatus(payload.payment_status);
          const providerPaymentId =
            parseNonEmptyText(payload.payment_id) || parseNonEmptyText(npId as string);
          const providerInvoiceId = parseNonEmptyText(payload.invoice_id);
          const matchesTopup =
            (providerOrderId && providerOrderId === topup.nowpayments_order_id) ||
            (providerInvoiceId && providerInvoiceId === topup.nowpayments_invoice_id);

          if (matchesTopup) {
            const synced = await creditTopupInTransaction(
              topup.id,
              providerStatus,
              providerPaymentId,
              providerInvoiceId,
              payload
            );
            if (synced.topup) {
              topup = synced.topup;
            }
          }
        }
      } catch {
        // Best effort: if provider sync fails we still return local topup state.
      }
    }

    const { rows: userRows } = await query<{ balance: number | string }>(
      `SELECT balance
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.currentUser.id]
    );
    const balanceRaw = userRows[0]?.balance ?? 0;
    return res.json({
      topup: toTopupResponse(topup),
      balance: Number(balanceRaw)
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/', (_req, res) => {
  res.json({ message: 'Billing API' });
});

export default router;
