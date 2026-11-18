# Note Manager

A local-first desktop app for a technical delivery manager: meeting notes and tasks as plain Markdown
files, your Google Calendar and email follow-ups, gentle nudges, and an optional AI Co-Pilot that uses
**your own** API key.

Windows, per-user install, no administrator rights needed.

## What it does

- **Notes are files.** Every note is a `.md` file in a folder you choose (put it inside a Drive-synced
  folder such as your Desktop for automatic backup). The app never deletes a note. The search index is
  disposable and rebuilt from the files.
- **Tasks find themselves.** "Remind Sarah to send the deck by Friday" becomes a task with the right
  owner and due date. People, accounts and systems are tagged automatically.
- **Calendar, email, meeting notes and Chat.** Meetings appear ready for notes, with a prep sheet.
  Email subjects, senders and dates feed a follow-up list, and recent email text is read in memory to
  find actions and decisions (only those points are kept). Gemini meeting notes land
  in the matching meeting's note. Chat is sorted into **Needs you**, **Waiting on them** and **Worth
  a look**, with the reason shown. Nothing is read from a screen: press **Sign In With Google** (the
  company sign-in is built into the installer; nobody creates a project or pastes a key), or use a
  small read-only script you paste into your own Google account (Settings → Google walks you through
  it). Nothing is sent or changed on your behalf.
- **Action Center: what matters, with where it came from.** Actions, decisions, risks, open questions and who-is-who, pulled from meetings, email and chat. Each item links back to its source (the meeting, the email thread, the chat). Your own actions become tasks; someone else's become **Waiting On** note lines (tasks are only for you). Nothing is added until you say so.
- **Nudges.** Morning brief, meeting prep, missing notes, heavy days, follow-ups, end of day, and a
  Friday weekly review, all worked out on your computer.
- **Free first.** Questions like "what's waiting on me in Chat?" and one-click actions answer on your computer with no AI; a **Polish with AI** button is there when you want more.
- **Co-Pilot (Ctrl+J).** Talk to it: it looks things up itself (notes, tasks, calendar, people, mail,
  chat), answers in the voice of the persona you picked (Nova, Pip, Sage or Rook), and says what it
  looked at. Paste a pile of to-dos and it offers to turn them into tasks, notes and reminders as
  cards you approve. Bring a key for Gemini, Groq, OpenRouter, OpenAI or Anthropic.
  There are no content filters: nothing is blocked or redacted before it is sent to your provider.
- **Tasks are always yours.** `@John Smith` in a task says who or what it is about (people, companies, places, projects, systems); Tasks has an About filter. Tasks → Meeting Series (its own sidebar row) gathers repeating meetings with carried-forward actions, open questions and decisions, and starts the next session. Add meetings to a series by hand, see topics that run through several sessions, and create a master page. Settings → Auto-Tagging shows Tag Health.
- **One Tasks dashboard.** A small calendar, your tasks (search, filter, sort, quick add) and an Action Center for email, chat and meeting follow-ups. Mail is scored for importance automatically; unimportant mail waits under Hidden, and Important / Not important teaches it.
- **Auto-tagging.** Type "Tell Matt he likes cats" and it becomes "Tell @Matt he likes #cats": names, companies, systems, places and topics get their @ or # as you finish each word (Ctrl+Z puts the plain word back). Known topics are tagged offline; with AI on, new topics and names are found too. A name shared by two people (two Priyas) is still tagged and waits in Review Names. It leans toward too many tags rather than missing one. Settings has a never-tag list.
- **AI modes.** Quick, Standard or Detailed sets how many tokens the Co-Pilot may spend (notes read, model size, answer length, follow-ups, automatic day brief). One-click actions: summarize a note, find action items, draft a follow-up email, brief me for a meeting, draft my weekly update, plan my day, catch me up on a person or account.
- **Explore.** One calm dashboard: today at a glance, then your notes as cards by week, meeting series, company, project, person, system, place or topic. Pick a card, then a bucket, then a note. **Manage names** merges duplicates ("Joe C", "Joe Cardone") and fixes categories.
- **A writing surface that stays Markdown.** Live preview with a toolbar button for every action (headings, bold, lists, checkboxes, @ people, due dates, priority). Start a note from a meeting in one step.
- **An assistant with a personality** (Nova, Pip, Sage or Rook) that messages you first: morning brief, a heads-up before meetings, overdue work, replies you owe.
- **Everywhere shortcuts.** Ctrl+N new note, Ctrl+K search/command palette, Ctrl+J Co-Pilot,
  Ctrl+Shift+Space quick task or note from any app (Tab switches between them).

## Install (end users)

Run `dist\note-manager-1.0.0-setup.exe`. It is **not code-signed**, so Windows SmartScreen shows "Windows
protected your PC": choose **More info → Run anyway**. The first-run guide walks through the rest.

## Develop

```bash
npm install
npm run dev          # run with hot reload
npm run typecheck    # TypeScript (main + renderer)
npm run lint
npm test             # unit tests (Vitest)
npm run e2e          # drives the built app and checks the main screens (needs a desktop)
npm run build:win    # installer in dist/ (needs build/google-client.json, see docs/IT-GOOGLE-SIGN-IN.md)
npm run build:win:script-only   # personal installer without the built-in Google sign-in
```

### Layout

| Path           | What lives there                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `src/main`     | Electron main process: vault (files + SQLite index), calendar/Gmail sync, nudges, LLM router, IPC |
| `src/preload`  | The only bridge to the UI: an allow-listed `window.api`                                           |
| `src/renderer` | React UI (Tailwind 4, CodeMirror)                                                                 |
| `src/shared`   | Pure code shared by both: IPC contract (zod), parsing, grouping, time zones                       |
| `e2e`          | Smoke tests that drive the real app over the Chrome DevTools Protocol                             |
| `SPEC.md`      | The product spec and numbered decision log: read this first                                       |

### Principles

Files are the source of truth. All IPC input and output is schema-checked. Deterministic code decides
_when_ and _what_; the LLM only proposes, and the user approves. Nothing is auto-sent anywhere.

## Troubleshooting

Settings → **Backup and support** has _Back up my notes_, _Copy diagnostics_ (no note or email content)
and _Open the log folder_.
