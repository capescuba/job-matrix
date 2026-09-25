# Job Matrix

Local job-search tracker with AI fit scoring against your resume. Everything stays on your machine (SQLite in `data/`), except the job description, resume text and goals sent to the AI provider when you score a job.

## Launching

Use the **Job Matrix** icon (Start menu or Desktop, pin either to the taskbar). It runs `scripts/launch.vbs`, which:

1. starts the local server hidden on http://127.0.0.1:5174 if it isn't already running (rebuilding the UI first if its source changed),
2. opens it in a normal **Chrome** tab (Chrome only — it never falls back to another browser).

The server shuts itself down 10 minutes after the last Job Matrix tab closes. Logs: `data/server.log`, `data/server-error.log`.
Recreate the shortcuts with `powershell -File scripts/install-shortcuts.ps1`; regenerate the icon with `node scripts/make-icon.mjs`.

Set the Anthropic API key and model on the **Profile** page (saved to `.env`).

## Using it

1. **Profile** — upload your resume (PDF/DOCX/TXT/MD) and write your goals, must-haves and deal-breakers.
2. **Applications** — add jobs (paste a URL and hit Fetch, or paste the JD), log follow-ups, move them through statuses in the table or Kanban board. "Import N descriptions" fetches JDs for every job with a link.
3. **Score fit** on a job page, or "Score N unscored" on the list. Results are cached per (JD, resume, goals, model); "Re-score" forces a fresh run.
4. **Dashboard** — pipeline, weekly volume, response rate, fit vs. outcome, next actions.

## Chrome extension

The side panel shows what Job Matrix knows about the page you're on:
- **This posting:** tracked or not; if tracked, its status, applied date and fit. It also flags the same role at another address, e.g. its LinkedIn copy.
- **The company:** its brief.
- **Adding:** adds a new posting to Screening, optionally scoring it straight away.
- **Application forms:** drafts answers to questions like "Why X?".
- **Teach this site:** records where a site keeps its title, company and description.

It also adds a right-click menu item, **Add selection to Job Matrix**.

One-time setup:
1. `powershell -File scripts\install-extension.ps1`. This registers the native helper (per user, HKCU), which lets the extension start Job Matrix and fetch its token from `data\extension-token`.
   - Run it from a normal PowerShell window. Apps packaged by Windows, such as the Claude desktop app, get a private copy of the registry, so a key written from inside them is invisible to Chrome. The result is "Specified native messaging host not found".
   - To check the registration, run `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.jobmatrix.host` from that same normal window.
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `apps\extension`. Pin the icon; clicking it opens the side panel.

The extension's ID is fixed by the `key` in `apps/extension/manifest.json`: `keiamknmppkefljklkaceniaafephpcf`. To test a PR preview, set the server to `http://127.0.0.1:5185` on the extension's Options page.

## Email updates

The **Email** page reads your Hotmail / Outlook.com mailbox (read-only, Microsoft Graph) and finds application emails: receipts, rejections, interview requests, forms or assessments to do, offers.

- **Review first.** Each email becomes a suggestion (e.g. "DoorDash: Applied → Rejected", quoting the sentence that says so). Nothing changes until you press **Apply**, which logs the email on the job's timeline, dated to the email, and moves the status.
- **Your choice of what happens next.** For a company where you track several jobs, you pick which one the email is about. Emails about jobs you don't track can be added with **Add to tracker**. Unclear ones get **Ask AI**: one small call, recorded on the AI usage page under "Email updates".
- **When it checks.** **Manual only** by default: press **Check now**. You can instead choose "When Job Matrix opens" or every 15/30/60 minutes (only while the app is open). The first check, or **Re-scan history**, goes back to two weeks before your first application.
- **Where it looks.** Every folder (Inbox, Junk, Deleted Items, your own folders) except Sent, Drafts and Outbox. Only job-related emails are kept, and only a short excerpt of each.
- **Sign-in.** Shared with the [email-mcp](https://github.com/capescuba/mcp/tree/master/email-mcp) server: `%USERPROFILE%\.email-mcp\config.json` holds the Azure app ID, and `token.json` holds the sign-in. **Connect Outlook** shows a code to enter at microsoft.com/link. `OUTLOOK_CLIENT_ID` in `.env` overrides the app ID.

## Log

The **Log** page shows the app's log files from `data/`:
- `server.log` for this run, and `server.1.log` to `.3.log` for the previous three (the launcher rotates them);
- `server-error.log` for errors;
- `build.log` for the web build.

The log has one line per API call, with the polled ones left out, plus named events (`mail.sync.*`, `mail.update.*`, `ai.call`, `app.start`, `app.idle-exit`). The page has filters for level and routine requests, a search box, and **Follow**.

## Development

```bash
npm install
npm run dev            # web http://127.0.0.1:5173 (hot reload), API http://127.0.0.1:5174
```

## Layout

| Path | What |
|---|---|
| `apps/server` | Fastify API, Drizzle + better-sqlite3, fit service (`src/services/fit.ts`) |
| `apps/web` | Vite + React + TanStack Query + Tailwind |
| `packages/shared` | Status enum, zod input schemas, fit result schema |
| `packages/ai` | `LLMProvider` interface + Anthropic implementation (`AI_PROVIDER`, `AI_MODEL`) |
| `packages/mail` | Read-only Outlook.com client (Microsoft Graph, device-code sign-in shared with email-mcp) |
| `apps/extension` | Chrome extension (Manifest V3, plain JS): side panel, page reader, site templates, application helper |
| `scripts/native-host` | Native messaging helper: starts Job Matrix and hands the extension its token |

## Scripts

- `npm run dev` — server + web with reload
- `npm test` — vitest (API, status transitions, fit caching with a fake provider)
- `npm run typecheck`
- `npm run db:generate` — after editing `apps/server/src/db/schema.ts`; migrations apply on server start

## Roadmap

Lightweight resume tailoring suggestions.
