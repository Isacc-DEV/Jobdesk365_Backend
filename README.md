# Jobdesk365 Backend

## Prerequisites
- Node.js 18+
- PostgreSQL accessible at `localhost:5432` (default user/password `postgres`/`postgres`)

## Setup
1) Install dependencies
```
npm install
```
2) Configure environment (optional, defaults match local dev)
```
cp .env.example .env
# adjust values as needed
```
3) Initialize database and schema
```
npm run init
```
This will create the `jobdesk365` database (if missing) and provision the `users` table with the required indexes and triggers.

4) Run the API in dev mode
```
npm run dev
```
The server listens on `http://localhost:4000` by default.

## Auth API
- `POST /auth/register` — body: `{ email, username, password, display_name?, bio?, photo_link?, plan? }` → returns `{ token, user }`
- Username rules: lowercase letters and numbers only; must be unique per active user.
- `POST /auth/login` — body: `{ email, password }` → returns `{ token, user }`
- `GET /auth/me` — header: `Authorization: Bearer <token>` → returns `{ user }`
- `POST /auth/logout` — stateless; returns `{ success: true }` (client should discard its token)

## Profiles API (auth required)
- Route scopes:
- `/profiles` for standard access (self + assigned visibility).
- `/manager/profiles` for manager-only access (full visibility).
- `/admin/profiles` for admin-only access (full visibility).
- `GET /profiles` — query: `q?`, `limit?` (default 20, max 100), `cursor?`, `include_deleted?`. Returns `{ items: Profile[], next_cursor }`. Filters to the current user's profiles, defaulting to non-deleted, ordered newest-first with keyset pagination.
- `POST /profiles` — body: `{ name (required), description?, base_info?, base_resume?, resume_template_id (required) }` → returns created `Profile`. Name is unique per user ignoring soft-deleted rows.
- `GET /profiles/{profile_id}` — respects `?include_deleted=true`; 404 if not found or soft-deleted when not included.
- `PATCH /profiles/{profile_id}` — body: any of `{ name, description, base_info, base_resume, resume_template_id }`; cannot change assignment fields here. Returns updated `Profile`; 404 on missing/soft-deleted.
- `DELETE /profiles/{profile_id}` — soft-deletes profile (sets `deleted_at`), clears bidder assignment; returns 204.
- `POST /profiles/{profile_id}/assign-bidder` — body: `{ bidder_user_id }`; bidder must hold the `bidder` role in `user_roles`. Returns updated `Profile`.
- `POST /profiles/{profile_id}/unassign-bidder` — clears `assigned_bidder_user_id/assigned_at`. Returns updated `Profile`.

## Users table
- `id` uuid PK (default `gen_random_uuid()`)
- `email`, `username` text (required, case-insensitive unique when `deleted_at` is null)
- `password_hash` text (required)
- `display_name`, `bio`, `photo_link` text (optional)
- `plan` enum (`free|plus|pro|pro_plus`, default `free`)
- `verified` boolean (default `false`)
- `created_at`, `updated_at` (auto timestamps), `deleted_at` nullable for soft delete

## Resume templates
- `resume_templates`: stores reusable HTML templates; fields `title` (required), `description` optional, `code` (HTML string, required), `created_by` FK → users.id, timestamps with auto `updated_at`, optional `deleted_at` soft delete.

## Profiles
- `profiles`: user-owned job profiles; fields `user_id` FK → users, `name` required, `description` optional, `base_info` jsonb default `{}`, `base_resume` jsonb default `{}`, `resume_template_id` FK → resume_templates, `assigned_bidder_user_id` FK → users, `assigned_at` timestamp (must co-exist with assigned user), timestamps with auto `updated_at`, optional `deleted_at`.
- Constraints: case-insensitive unique `(user_id, lower(name))` where `deleted_at` is null; check enforces `assigned_bidder_user_id` null iff `assigned_at` null.
- Indexes: `user_id`, `resume_template_id`, `assigned_bidder_user_id`, `(user_id, created_at)`.

## Roles & user_roles tables
- `roles`: master list seeded with keys `client, admin, manager, bidder, caller`; fields include `key` (unique, check-constrained), `name`, timestamps.
- `user_roles`: assigns multiple roles to a user; fields `user_id`, `role_id`, `created_at`; unique on `(user_id, role_id)` with FK to users/roles.

