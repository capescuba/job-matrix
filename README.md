# Job Matrix

Local job-search tracker with AI fit scoring against your resume. Everything stays on your machine (SQLite in `data/`), except the job description, resume text and goals sent to the AI provider when you score a job.

## Launching

Use the **Job Matrix** icon (Start menu or Desktop, pin either to the taskbar). It runs `scripts/launch.vbs`, which:

1. starts the local server hidden on http://127.0.0.1:5174 if it isn't already running (rebuilding the UI first if its source changed),
2. opens it in a normal **Chrome** tab (Chrome only — it never falls back to another browser).

The server shuts itself down 10 minutes after the last Job Matrix tab closes. Logs: `data/server.log`, `data/server-error.log`.
Recreate the shortcuts with `powershell -File scripts/install-shortcuts.ps1`; regenerate the icon with `node scripts/make-icon.mjs`.

Set the Anthropic API key and model under **More → Profile → Settings** (saved to `.env`).

## Using it

1. **Profile** (under **More**, top right) — upload your resume (PDF/DOCX/TXT/MD) on **About you**, and write your goals, must-haves and deal-breakers on **Criteria**.
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
- **Other company names.** A company can go by other names: a new owner after an acquisition, a parent brand, or an old name. Say you track a job at Cursor and the email says "SpaceXAI". If the email's job title matches exactly one of your jobs, it shows under **Possible matches**. When you apply it, Job Matrix can remember "SpaceXAI" as another name for Cursor. You can also manage these names on a job's **Company** tab (**Also known as**). The Chrome extension uses them too.
- **When it checks.** **Manual only** by default: press **Check now**. You can instead choose "When Job Matrix opens" or every 15/30/60 minutes (only while the app is open). The first check, or **Re-scan history**, goes back to two weeks before your first application.
- **Where it looks.** Every folder (Inbox, Junk, Deleted Items, your own folders) except Sent, Drafts and Outbox. Only job-related emails are kept, and only a short excerpt of each.
- **Sign-in.** Shared with the [email-mcp](https://github.com/capescuba/mcp/tree/master/email-mcp) server: `%USERPROFILE%\.email-mcp\config.json` holds the Azure app ID, and `token.json` holds the sign-in. **Connect Outlook** shows a code to enter at microsoft.com/link. `OUTLOOK_CLIENT_ID` in `.env` overrides the app ID.

## Watchlist

The **Watchlist** page follows company job boards, so new jobs reach the Screening inbox on their own.

- **Follow a company.** Paste its careers page, its job board or any one of its job postings. Greenhouse, Ashby, Lever and Workday boards are supported. The board is read once straight away, so a wrong address is reported there and then.
- **Job sites.** For companies you haven't heard of, the **Job sites** card lists LinkedIn, Indeed, Glassdoor and ZipRecruiter, each searching for your keywords and place (newest first). **Search now** on a site, or **Search all now**; the switch beside each site says whether **Search all** and the schedule include it. You can also paste a results page of your own under **Your own searches**. The Chrome extension (version 0.3 or later) opens each saved search in a tab of your signed-in Chrome, reads the listings on the first page, closes the tab and sends them to Job Matrix, where the same rules and pre-screen apply.
  - Nothing runs by itself unless you choose a schedule under **Automatic** at the top of the Watchlist page (it starts as **Manual only**). A schedule only runs while Job Matrix is open in Chrome.
  - Only LinkedIn postings can be read in full by Job Matrix. Jobs from the other sites arrive with their title, company, place and pay, and no description until you open them and capture it with the extension.
  - A robot check or a signed-out page is shown on the search and skipped; nothing tries to get past it. Page layouts change, so a reader can stop finding listings; the search then says so.
- **What is picked up.** Jobs whose title contains one of your **titles to look for**. "TPM" and "Sr." are read as "technical program manager" and "senior".
- **What is filtered out.** Titles on your skip list, contracts, internships and hourly pay, a posted range whose top is below your minimum base, a place that is neither remote nor on your list, and jobs you already track. A posting that doesn't state its pay or place passes.
- **Where the rest goes.** Into the Screening inbox, with a timeline note naming the board. Filtered-out jobs are listed on Screening under **Filtered out**, each with its reason and an **Add anyway** button.
- **Decided once.** A job added or filtered out is remembered by its address and not looked at again. The exception is a job a rule filtered out: it is judged again on each check, so a change to the rules takes effect.
- **When it checks.** When Job Matrix opens, by default. You can choose manual only, or also every 1, 3 or 6 hours while the app is open. **Check now** is on both pages.
- **Pre-screen (optional).** A small model can look at each job the rules let through and answer yes, maybe or no. Yes and maybe go to the inbox with the model's reason on the timeline. A no is listed under **Filtered out** with the reason. Choose the model on the Watchlist page: Groq, Google Gemini or OpenRouter (free, each needs its own free key), Ollama on this PC, any other OpenAI-compatible service, or Claude Haiku 4.5 (paid). It is off until you choose one.
  - The model is sent the posting and your goals, pay floor, must-haves and deal-breakers. It is never sent your resume or career profile.
  - Free tiers are rate-limited. A short "slow down" is waited out. A daily limit leaves the remaining jobs waiting, and the next check asks about them again. Nothing falls back to a paid model.
  - Every call is listed on the AI usage page under "Watchlist pre-screen".
- **Cost.** None with the rules alone or a free model. Reading the boards is free.

## Log

The **Log** page shows the app's log files from `data/`:
- `server.log` for this run, and `server.1.log` to `.3.log` for the previous three (the launcher rotates them);
- `server-error.log` for errors;
- `build.log` for the web build.

The log has one line per API call, with the polled ones left out, plus named events (`mail.sync.*`, `mail.update.*`, `crawl.*`, `ai.call`, `app.start`, `app.idle-exit`). The page has filters for level and routine requests, a search box, and **Follow**.

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
