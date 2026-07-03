// ---------------------------------------------------------------------------
// nova Support — Live Operations Dashboard
// Backend: fetches LIVE data on every page load from:
//   - Intercom  (conversations, 2026)
//   - Jira      (project = "NSP" only — the "nova Support" board)
// then computes metrics and serves the dashboard in /public.
//
// No data is baked in. Every request to /api/data hits both APIs fresh.
// ---------------------------------------------------------------------------

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// --- Credentials (set these in Render → Environment) -----------------------
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const JIRA_EMAIL     = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_SITE      = process.env.JIRA_SITE || "powerdigital.atlassian.net";

// Scope constants — DO NOT widen. Only the NSP ("nova Support") board.
const JIRA_PROJECT_KEY = "NSP";
const YEAR_START = "2026-01-01";
const YEAR_END   = "2026-12-31";
// 2026-01-01 00:00:00 UTC — lower bound for Intercom created_at
const YEAR_START_UNIX = 1767225600;

// Map an Intercom tag -> product/application bucket (used for cross-system inference).
const TAGMAP = {
  "Intelligence": "Creative Affinity",
  "Creative affinity": "Creative Affinity",
  "Cohorts": "Creative Affinity",
  "Integrations": "Integrations & Data",
  "Data Intelligence": "Integrations & Data",
  "dataq": "Audiences / DataQ",
  "Blueprints": "Blueprints",
  "nova Fee Removal": "Blueprints",
  "Talent": "Talent",
  "Power View": "Power View",
  "Appraisals": "Appraisals",
  "scoreboards": "Scoreboards",
  "Forecasts": "Reporting / Looker",
  "customer insights": "Reporting / Looker"
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jiraAuthHeader() {
  const raw = `${JIRA_EMAIL}:${JIRA_API_TOKEN}`;
  return "Basic " + Buffer.from(raw).toString("base64");
}

// Classify a Jira ticket into a product bucket from its summary text.
function classifyProduct(summary) {
  const s = (summary || "").toLowerCase();
  const has = (...ws) => ws.some(w => s.includes(w));
  if (has("creative collab", "collab")) return "Creative Collab";
  if (has("blueprint", "bp ", " bps", "fee removal")) return "Blueprints";
  if (has("appraisal", "presentation generation")) return "Appraisals";
  if (has("dataq", "data q", "audience")) return "Audiences / DataQ";
  if (has("talent")) return "Talent";
  if (has("scoreboard")) return "Scoreboards";
  if (has("power view", "client view", "client portal", "power-view")) return "Power View";
  if (has("looker", "reporting dashboard", "reporting request", "dr review", "review score")) return "Reporting / Looker";
  if (has("login", "log in", "account", "email change", "sign in", "sso")) return "Account / Access";
  if (has("customer insight", "creative affinity", "affinity", "creative report",
          "ai creative", "ai tags", "ads", "roas", "ctr", "catalog", "playbook",
          "fatigue", "meta ads", "tiktok", "creative insight")) return "Creative Affinity";
  if (has("warehouse", "fivetran", "snowflake", "connector", "integration",
          "matia", "klaviyo", "pipeline", "dag", "pinterest data", "missing data")) return "Integrations & Data";
  return "Platform / Other";
}

function bump(map, key) { if (!key && key !== 0) return; map[key] = (map[key] || 0) + 1; }
function sortEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// Intercom — fetch all 2026 conversations (paginated search)
// ---------------------------------------------------------------------------
async function fetchIntercom() {
  if (!INTERCOM_TOKEN) throw new Error("INTERCOM_TOKEN is not set");
  const out = [];
  let startingAfter = null;

  do {
    const body = {
      query: {
        field: "created_at",
        operator: ">",
        value: YEAR_START_UNIX
      },
      pagination: { per_page: 150 }
    };
    if (startingAfter) body.pagination.starting_after = startingAfter;

    const res = await fetch("https://api.intercom.io/conversations/search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${INTERCOM_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Intercom-Version": "2.11"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Intercom ${res.status}: ${await res.text()}`);
    const json = await res.json();
    for (const c of (json.conversations || [])) {
      const stats = c.statistics || {};
      out.push({
        id: String(c.id),
        created: c.created_at,
        updated: c.updated_at,
        state: c.state,                       // open | closed | snoozed
        open: !!c.open,
        priority: c.priority || null,
        tags: (c.tags && c.tags.tags ? c.tags.tags : []).map(t => t.name),
        ttfr: stats.time_to_admin_reply ?? null,     // first response, secs
        ttfc: stats.time_to_first_close ?? null,      // resolution, secs
        url: `https://app.intercom.com/a/inbox/_/inbox/conversation/${c.id}`
      });
    }
    startingAfter = json.pages && json.pages.next ? json.pages.next.starting_after : null;
  } while (startingAfter);

  return out;
}

// ---------------------------------------------------------------------------
// Jira — fetch all 2026 issues from the NSP board (paginated JQL)
// ---------------------------------------------------------------------------
async function fetchJira() {
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) throw new Error("JIRA_EMAIL / JIRA_API_TOKEN not set");
  const out = [];
  let nextPageToken = null;
  const jql = `project = "${JIRA_PROJECT_KEY}" AND created >= "${YEAR_START}" AND created <= "${YEAR_END}" ORDER BY created DESC`;
  const url = `https://${JIRA_SITE}/rest/api/3/search/jql`;

  do {
    const body = {
      jql,
      maxResults: 100,
      fields: ["summary", "status", "issuetype", "priority", "assignee",
               "reporter", "created", "updated", "resolution"]
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": jiraAuthHeader(),
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
    const json = await res.json();
    for (const it of (json.issues || [])) {
      const f = it.fields || {};
      out.push({
        key: it.key,
        summary: (f.summary || "").trim(),
        type: f.issuetype ? f.issuetype.name.trim() : null,
        status: f.status ? f.status.name.trim() : null,
        statusCat: f.status && f.status.statusCategory ? f.status.statusCategory.key : null,
        priority: f.priority ? f.priority.name : null,
        reporter: f.reporter ? f.reporter.displayName : null,
        assignee: f.assignee ? f.assignee.displayName : null,
        resolution: f.resolution ? f.resolution.name : null,
        created: f.created,
        updated: f.updated,
        product: classifyProduct(f.summary),
        url: `https://${JIRA_SITE}/browse/${it.key}`
      });
    }
    nextPageToken = json.nextPageToken || null;
  } while (nextPageToken);

  return out;
}

// ---------------------------------------------------------------------------
// API: live data on every call
// ---------------------------------------------------------------------------
app.get("/api/data", async (_req, res) => {
  try {
    const [intercom, jira] = await Promise.all([fetchIntercom(), fetchJira()]);

    // Precompute tag -> product mapping list for the frontend's inference panel.
    const tagCounts = {};
    for (const c of intercom) for (const t of c.tags) bump(tagCounts, t);

    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      scope: { jiraProject: JIRA_PROJECT_KEY, year: 2026 },
      tagmap: TAGMAP,
      intercom,
      jira,
      tagCounts: sortEntries(tagCounts)
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`nova Support live dashboard on :${PORT}`));
