# nova Support — Live Operations Dashboard

A live dashboard that combines **Intercom conversations** and the **Jira nova Support (NSP) board**.
It fetches fresh data from both APIs **on every page load** — nothing is baked in.

- **Jira scope:** `project = "NSP"` only (the nova Support service desk). No other board is included.
- **Intercom scope:** all conversations created in 2026.

---

## What's in here

```
nova-support-live/
  server.js          Express backend — live fetch + metrics + serves the dashboard
  public/index.html  The dashboard UI (time ranges, drill-downs, cross-system view)
  package.json
  .gitignore
```

## Required environment variables

Set these in Render (see steps below). **Never commit them.**

| Variable          | What it is                                                        |
|-------------------|-------------------------------------------------------------------|
| `INTERCOM_TOKEN`  | Intercom access token with read access to conversations          |
| `JIRA_EMAIL`      | The Atlassian account email that owns the API token               |
| `JIRA_API_TOKEN`  | Atlassian API token (id.atlassian.com → Security → API tokens)    |
| `JIRA_SITE`       | *(optional)* defaults to `powerdigital.atlassian.net`             |

---

## Getting the two tokens

**Jira / Atlassian API token**
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. **Create API token**, name it (e.g. "nova support dashboard"), copy it.
3. `JIRA_EMAIL` = the email of that Atlassian account.

**Intercom access token**
1. Intercom → **Settings → Integrations → Developer Hub**.
2. Open (or create) an app for your workspace → **Authentication** → copy the **Access Token**.
3. Make sure it has read scope for conversations.

---

## Deploy to Render — step by step

1. **Put this folder in a Git repo**
   ```bash
   cd nova-support-live
   git init
   git add .
   git commit -m "nova Support live dashboard"
   # create an empty repo on GitHub, then:
   git remote add origin https://github.com/<you>/nova-support-live.git
   git push -u origin main
   ```

2. **Create the web service on Render**
   - New → **Web Service** → connect the repo.
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Free is fine to start.

3. **Add the environment variables** (Render → your service → **Environment**):
   `INTERCOM_TOKEN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.

4. **Deploy.** When it's live, open the service URL. The header shows
   *"Live · fetched <timestamp>"* and the Jira scope confirms `project = NSP`.

> Prefer not to use GitHub? In Render, once the repo is connected, deploys can also
> be triggered/managed programmatically. If you give me the repo URL after pushing,
> I can wire up and manage the Render service for you.

---

## Notes

- **Data freshness:** every visit re-queries both APIs, so new NSP tickets and new
  Intercom conversations appear automatically. Use the **↻ Refresh** button to re-pull
  without reloading.
- **Application grouping** for Jira is inferred from ticket summaries — the NSP board
  doesn't populate the component field. Cross-system links are inferred by matching
  Intercom tag names to products and are labelled as such in the UI.
- **Security:** tokens live only in Render's encrypted environment settings, never in
  the code or the repo.
