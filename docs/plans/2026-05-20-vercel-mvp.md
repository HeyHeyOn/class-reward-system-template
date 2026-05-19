# 학급 매점 Vercel MVP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task when delegating. Current session may implement directly with TDD.

**Goal:** Convert the class-store app from a local/tunnel demo into a Vercel-ready deployment using Google Sheets as the durable backend and protecting admin pages.

**Architecture:** Vercel runs the Next.js app and serverless API routes. Google Sheets remains the live backend. The spreadsheet ID is deployment configuration (`GOOGLE_SHEET_ID`), while class/store display settings such as `currencyUnit` live in a `Settings` worksheet so file writes are not required in serverless.

**Tech Stack:** Next.js 16, React 19, Google Sheets API via `googleapis`, Vitest, Vercel environment variables.

---

## Phase 1: Settings persistence

1. Extend `SheetName` with `Settings` and add `Settings!A:Z` to Google Sheets ranges.
2. Add repository helpers to read/write key-value settings from a worksheet shaped as `key | value`.
3. Refactor `src/server/settings.ts` so:
   - `spreadsheetId` comes from `GOOGLE_SHEET_ID` for deployment stability.
   - `currencyUnit` is read from `Settings.currencyUnit` when available.
   - saving settings writes `currencyUnit` to the `Settings` worksheet instead of `data/settings.json`.
4. Keep validation for spreadsheet access, but document that changing the spreadsheet ID in Vercel means changing `GOOGLE_SHEET_ID` and redeploying/restarting.

## Phase 2: Admin protection

1. Add simple cookie-based admin password auth for MVP.
2. Environment variable: `ADMIN_PASSWORD`.
3. Add `/admin/login` page and `/api/admin/login`, `/api/admin/logout` routes.
4. Add middleware guarding `/admin`, `/admin/*`, and mutating admin APIs where needed.
5. If `ADMIN_PASSWORD` is missing, allow local/dev access but show docs warning that production must set it.

## Phase 3: Vercel docs/env

1. Add `.env.example` without secrets.
2. Add `docs/vercel-deploy-guide.md` with GitHub/Vercel setup and environment variable instructions.
3. Add `docs/google-sheets-template.md` including required sheets and columns.
4. Update README if present or create one.

## Phase 4: Verification

1. Add/adjust tests for Settings worksheet persistence.
2. Add admin auth tests for login route or middleware helpers.
3. Run `npm test`.
4. Run `npm run lint`.
5. Run `npm run build`.
6. Browser-check `/`, `/admin/login`, `/admin`, `/admin/transactions` locally.

## Deployment manual step

The final Vercel deployment requires 관리자님 approval/action for GitHub/Vercel account connection and secret entry. Do not expose or copy secrets in chat.
