# Stétho

Test maker for medical lectures. Runs on Vercel, uses your Anthropic API key, with user accounts, manual approval and a free trial.

## Files
stetho.html : the app (served at /)
stetho-admin.html : your admin page (served at /admin)
api/claude.js : server function that holds the API key, checks the user's session, trial and daily caps
api/auth.js : sign up, log in, log out
api/admin.js : approve accounts, extend trials, reset passwords, pilot stats
lib/store.js : shared code (database, passwords, sessions, usage)
vercel.json : maps / to stetho.html and /admin to stetho-admin.html
package.json, README.md

## How accounts work
1. A student opens the site, clicks "Créer un compte" and enters name, email and password.
2. The account is "en attente". They cannot log in yet.
3. You open /admin, enter ADMIN_PASSWORD and click "Valider". The trial (30 days by default) starts at that moment.
4. You tell the student they can log in.
5. When the trial ends, the student can still log in but cannot generate tests. On /admin, "+30 jours" extends it.
6. Forgotten password: on /admin click "Nouveau mot de passe" and send them the temporary one.

## Setup on Vercel
1. Put all the files in a GitHub repo (keep the api and lib folders) and import it into Vercel.
2. Database: in the Vercel project open Storage (or Marketplace), add "Upstash for Redis", create a free database and connect it to this project. This adds KV_REST_API_URL and KV_REST_API_TOKEN by itself.
3. Project > Settings > Environment Variables:
   ANTHROPIC_API_KEY : your key from console.anthropic.com
   ADMIN_PASSWORD : a long password for /admin (only you)
   CLAUDE_MODEL (optional) : defaults to claude-sonnet-5-5
   TRIAL_DAYS (optional) : defaults to 30
   DAILY_USER_USD (optional) : max spend per student per day, defaults to 1
   DAILY_TOTAL_USD (optional) : max spend for everyone per day, defaults to 15
   PRICE_IN_PER_MTOK and PRICE_OUT_PER_MTOK (optional) : model prices in USD per million tokens, default 2 and 10 (Sonnet 5.5). Change them if you change the model.
   SIGNUPS_OPEN (optional) : set to false to close sign ups
4. Redeploy (Deployments > ... > Redeploy) after any change to the variables.
5. In console.anthropic.com set a monthly spend limit. The caps above are estimates from token counts; the console limit is the real safety net.

APP_PASSWORD is no longer used. You can delete it.

## Notes
A test counts as "used" when its first part is generated. Grading is never blocked by the personal daily cap, so nobody gets stuck in the middle of a test.
Days and weeks follow Casablanca time.
Test history stays in each browser, not in the account.
