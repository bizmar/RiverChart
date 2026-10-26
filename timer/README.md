# RiverChart timer (Cloudflare Worker)

GitHub's scheduled runs are best effort: in practice the "every 30 minutes" job runs only every 3-8 hours.
This free Cloudflare Worker asks GitHub to run the workflow every 30 minutes instead, which it does at once.
GitHub's own schedule stays in the workflow as a backup (and for the daily archive re-check).

## 1. GitHub key (fine-grained token)

1. GitHub → your picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Name: `riverchart-timer`. Expiration: the longest offered (put a reminder in your calendar to renew it).
3. Repository access: **Only select repositories → RiverChart**.
4. Permissions → Repository permissions → **Actions: Read and write**. Nothing else.
5. **Generate token** and copy it (it is shown once).

## 2. Cloudflare Worker

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan, no card needed).
2. **Workers & Pages → Create → Create Worker** (start from "Hello World"). Name: `riverchart-timer` → **Deploy**.
3. **Edit code**: replace everything with the contents of `timer/worker.js` → **Deploy**.
4. Worker → **Settings → Variables and Secrets → Add**: type **Secret**, name `GITHUB_TOKEN`, value = the token from step 1 → **Deploy**.
5. Worker → **Settings → Trigger Events → Add → Cron Triggers**: `4,34 * * * *` (minute 4 and 34 of every hour, UTC) → **Add**.

## 3. Check

- After the next :04 or :34, GitHub → **Actions** shows a new run started by `workflow_dispatch`.
- Cloudflare → Worker → **Logs** shows `dispatch ok`. `HTTP 401/403/404` means the token or its permission is wrong.
- Then the Notify! beacon (`NOTIFY_BEACON_URL`) can be tightened to: expected every **60 minutes**, grace **60 minutes**.
