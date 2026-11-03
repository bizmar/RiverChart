// RiverChart timer: a Cloudflare Worker that starts the "Update data and publish" workflow every 30 minutes.
// GitHub's own schedule is best effort and often runs only every 3-8 hours; a workflow_dispatch request runs at once.
//
// Setup: see timer/README.md. Needs one secret, GITHUB_TOKEN: a fine-grained token for bizmar/RiverChart
// with only "Actions: Read and write". The Worker's web address does nothing, so it cannot be used to start runs.

const WORKFLOW = "https://api.github.com/repos/bizmar/RiverChart/actions/workflows/update.yml";
// Wait a random 0-50 s before asking, so the request doesn't land on the same second as everyone else's cron jobs.
// Waiting costs no CPU time, so it stays within the free plan.
const MAX_DELAY_MS = 50_000;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  async fetch() {
    return new Response("RiverChart timer. Nothing to see here.", { status: 404 });
  },
};

async function dispatch(env) {
  await new Promise((done) => setTimeout(done, Math.random() * MAX_DELAY_MS));
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "riverchart-timer",
  };
  // GitHub says when the token expires in a header on every answer; the run passes it on as a renewal reminder.
  const info = await fetch(WORKFLOW, { headers });
  const expires = (info.headers.get("github-authentication-token-expiration") || "").slice(0, 10);
  const inputs = /^\d{4}-\d{2}-\d{2}$/.test(expires) ? { timer_token_expires: expires } : {};
  const r = await fetch(`${WORKFLOW}/dispatches`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: "main", inputs }),
  });
  // 204 = started. Anything else shows up in the Worker's logs (Cloudflare dashboard → Worker → Logs).
  if (r.status !== 204) console.log(`dispatch failed: HTTP ${r.status} ${await r.text()}`);
  else console.log(`dispatch ok${expires ? `, token expires ${expires}` : ""}`);
}
