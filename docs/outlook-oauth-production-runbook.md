# Outlook OAuth Production Verification Runbook

## Purpose
Use this runbook when OAuth popup flow completes but `profiles.email_account_id` appears unchanged.

## Preconditions
- Backend deployment includes latest OAuth trace logging.
- You can access backend logs and production database.
- You have a target profile ID and user account to run the connect flow.

## 1) Run one connect attempt
1. Trigger `POST /admin/profiles/{profile_id}/email/outlook/authorize` (or `/profiles/{profile_id}/email/outlook/authorize`).
2. Complete Microsoft consent in popup.
3. Wait for callback page to close.

## 2) Capture trace and callback lifecycle from backend logs
Search logs for:
- `[outlook-connect][authorize][authorize_ready]`
- `[outlook-connect][callback][callback_start]`
- `[outlook-connect][callback][callback_commit_succeeded]`

Each log entry should share one `trace_id`.

If callback fails, check these events by `trace_id`:
- `token_exchange_failed`
- `graph_me_failed`
- `owner_scope_guard_profile_not_found`
- `db_transaction_failed`

## 3) Confirm runtime DB fingerprint
Find `[outlook-connect][callback][db_fingerprint]` and note:
- `database`
- `server_address`
- `server_port`

Use the same DB connection target when running manual SQL checks.

## 4) SQL verification on runtime DB
Run:

```sql
SELECT id, email_account_id
FROM profiles
WHERE id = '<profile_id>';
```

If `email_account_id` is non-null, run:

```sql
SELECT id, provider, email_address, status
FROM email_accounts
WHERE id = '<email_account_id>';
```

Expected:
- `provider = 'outlook'`
- `status = 'active'`

## 5) API verification on same environment
Run:

```http
GET /admin/profiles/{profile_id}
Authorization: Bearer <token>
```

Expected:
- `email_account_id` is non-null
- `email_connection_status` is `active` (or equivalent connected status)

## 6) Diagnose mismatch cases
- Logs show `callback_commit_succeeded` but SQL/API do not show updates:
  - You are likely checking a different DB than runtime backend.
  - Re-verify connection string source and deployment environment variables.
- Callback never logs:
  - Redirect URI or routing path mismatch.
- Callback logs token failure:
  - Verify `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REDIRECT_URI`, tenant settings, and app registration.
- Callback logs owner scope guard:
  - Profile is not owned by authenticated user; route is intentionally owner-scoped.
