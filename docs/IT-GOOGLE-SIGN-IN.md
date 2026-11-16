# Google sign-in for Note Manager: one-time setup for IT

Note Manager is a desktop app for people at our company. It reads (never writes) a person's own
Google Calendar, Gmail, Meet notes and Chat so it can prepare meeting notes and follow-ups.

So that nobody has to create their own Google Cloud project, we need **one OAuth client for the
whole company**. Each person then signs in with their own Google account. This takes about 15 minutes, once.

The app is for internal use only. Because the consent screen is **Internal**, Google does not
need to review or verify it.

## What to create

1. **Project.** In the Google Cloud Console, create a project inside our Google Workspace
   organization, for example `note-manager`.
2. **APIs.** Under *APIs & Services → Library*, enable:
   - Google Calendar API
   - Gmail API
   - Google Drive API
   - Google Docs API
   - Google Chat API
3. **Consent screen.** Under *APIs & Services → OAuth consent screen*:
   - User type: **Internal**
   - App name: `Note Manager`; support email: the IT mailbox
   - Add these scopes (all read-only):
     | Scope | Why |
     | --- | --- |
     | `openid`, `email`, `profile` | Know which account is signed in |
     | `https://www.googleapis.com/auth/calendar.readonly` | Meetings, guests and Meet links |
     | `https://www.googleapis.com/auth/gmail.readonly` | Mail that may need a reply; actions and decisions (text is read in memory, not stored) |
     | `https://www.googleapis.com/auth/drive.metadata.readonly` | Find "Notes by Gemini" attached to meetings (file names only) |
     | `https://www.googleapis.com/auth/documents.readonly` | Read those meeting notes |
     | `https://www.googleapis.com/auth/chat.spaces.readonly` | List the person's Chat spaces |
     | `https://www.googleapis.com/auth/chat.messages.readonly` | Read Chat messages for actions and mentions |
4. **Client.** Under *APIs & Services → Credentials → Create credentials → OAuth client ID*:
   - Application type: **Desktop app**
   - Name: `Note Manager desktop`

## What to send back

Send the **Client ID** (`…apps.googleusercontent.com`) and the **client secret** Google shows
for the Desktop client. For Desktop apps Google treats this "secret" as public (the app uses PKCE,
and it ships inside every installer). It grants no access by itself: each person still signs in
and approves read-only access to their own account.

## What happens next (for whoever builds the installer)

1. Save the values as `build/google-client.json` in the repository (this file is git-ignored):

   ```json
   { "clientId": "1234567890-abc.apps.googleusercontent.com", "clientSecret": "GOCSPX-…" }
   ```

2. Run `npm run build:win`. The build stops with a clear message if this file is missing, so an
   installer can't ship without sign-in by accident. (`npm run build:win:script-only` builds
   without it on purpose, for personal builds.)
3. Colleagues install it, open Settings → Google (or the first-run guide) and press
   **Sign In With Google**. Nothing else is needed.

## Turning it off

To revoke everything at once, delete or disable the OAuth client in the Cloud Console. Each
person can also remove access themselves at <https://myaccount.google.com/permissions>, or press
**Sign Out** in the app.
