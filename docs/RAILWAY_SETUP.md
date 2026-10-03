# Run your fork in your own Railway account

This guide deploys `businessbotuae77-svg/ai-powered-instagram-real-estate-lead-generator`.
The freelancer's original repository and Railway project are separate resources.
Deploying this fork does not move the Instagram connection or existing conversations.

## 1. Create the account and select your fork

1. Open https://railway.com and sign in using the GitHub account that owns your fork.
2. Create/select your own Railway workspace. Confirm that you control its billing and membership.
3. Choose **New Project → Deploy from GitHub repo**. Authorize Railway's GitHub app for your fork if asked.
4. Select `businessbotuae77-svg/ai-powered-instagram-real-estate-lead-generator`.
5. In the service's **Settings → Source**, confirm this owner/repository and the branch containing the Railway setup changes. After merging the setup PR, use `main`.
6. Name the project, for example `instagram-property-bot`. Save the dashboard URL from the browser; this is your project management link.

An initial deployment may fail until Airtable variables are supplied. The production service intentionally refuses to use demo property data. Do not change `NODE_ENV` to bypass this.

## 2. Add storage and production variables

1. Attach a Railway **Volume** to this service, mounted at `/data`.
2. In **Variables**, copy the settings from [`.env.railway.example`](../.env.railway.example).
3. Set `NODE_ENV=production`, `RUNTIME_DATA_DIR=/data/runtime` and `INSTAGRAM_POLLER_ENABLED=false`. Leave test and runtime-key endpoints disabled.
4. Fill `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` for a base you control, containing the expected `Developers`, `Projects` and `Units` tables. Use your approved catalogue; see [HANDOVER](../HANDOVER.md). If the current base belongs to the freelancer, obtain access or copy its schema and approved records into your own base first. Do not run demo-seeding commands on the production base.
5. Add your Anthropic API key if you want Claude responses; otherwise the deterministic response path remains available. If overriding `ANTHROPIC_MODEL`, select a supported model in your account.
6. Add the HubSpot and WhatsApp values for your accounts when ready to test lead handoff. The WhatsApp alert template must be approved for the configured language and expected parameters; see the integration handover.
7. Keep Meta credentials blank until you are ready for the connection step below. Enter all tokens directly in Railway, never in chat, commits or screenshots.
8. Redeploy after applying the variables and volume.

Railway supplies `PORT`. The included `railway.json` runs `npm start`, checks `/api/health`, restarts on failure and uses one replica. Keep one replica and disable service sleeping/serverless mode: the JSON conversation state and retry queue require a single continuously running process. The volume keeps this state through redeploys; also maintain backups. A fresh volume starts with no conversation history. If history must carry over, arrange an export/import while the old service is stopped, before cutover.

## 3. Get your public URL and check the deployment

1. Open the service's **Settings → Networking / Public Networking → Generate Domain**.
2. Copy its public HTTPS address, usually `https://<name>.up.railway.app`.
3. Open `https://<name>.up.railway.app/api/health`. Expect `ok: true` and `source: "airtable"`.
4. Compare `deploymentCommit` with the active deployment's GitHub commit. In **Settings → Source**, verify your fork again. The commit and source together identify which code is running.
5. Check the Railway deployment logs. A healthy HTTP process does not prove that Meta tokens, catalogue approvals, HubSpot or WhatsApp work; the `*Configured` fields only report whether values are present. Test those connections before switching users over.

The dashboard URL manages the project; the public HTTPS URL receives Instagram webhooks. They are different links.

## 4. Connect the Instagram account you control

You need administrator access to the relevant Meta developer app and business/Instagram assets. Having the repository does not grant this access. If the freelancer owns the app, obtain access/transfer it or create an app under your business and complete the required Instagram permissions, account connection and review for your use case. A new development app may only work with authorized test accounts until its permissions are approved.

1. Set `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN` and `META_PAGE_ID` using the account identifiers and token type expected by this repository's Meta integration. See [HANDOVER](../HANDOVER.md); do not substitute a random personal Instagram token.
2. Choose a long random `META_VERIFY_TOKEN` and put it in Railway. Keep `INSTAGRAM_POLLER_ENABLED=false`.
3. Redeploy and inspect logs for token account identity and subscription results. This service attempts to subscribe messaging fields at startup; that does not change the app's callback URL.
4. In your Meta app's Instagram messaging webhook settings, enter callback URL `https://<name>.up.railway.app/webhook/meta` and the same verify token. Subscribe the messaging fields required by the integration.
5. Coordinate a cutover window. Stop the old bot's service/poller before sending the first test message to the new bot. Changing a callback alone does not stop the freelancer's poller; if it retains messaging access it could still reply. Confirm old token/access revocation or service shutdown as appropriate for the shared app.
6. Send a real DM from an authorized test account. Check that one reply arrives, buyer memory persists and the message is shown as processed in Railway logs.
7. Test an explicitly requested follow-up and confirm the expected HubSpot record and WhatsApp advisor alert. Check stop/no-calls behavior and English/Arabic answers using the [30-case acceptance checklist](../ACCEPTANCE.md).
8. Run the full live acceptance checklist before routing general customer traffic. Keep the poller disabled if verified webhook delivery meets your needs. If a fallback poller is needed, enable it only after the old service is stopped and duplicate delivery tests pass.

## 5. Verify ongoing ownership

- Railway project membership and billing belong to your account.
- Source points to your fork and the deployed commit matches it.
- Meta callback points to your public Railway domain.
- Airtable, Anthropic, HubSpot and WhatsApp credentials belong to accounts you control or have authorized business access to.
- Old bot processing is disabled and conversation state survives a redeploy.

If cutover fails, stop new processing before restoring the previous callback/service; do not run two bots simultaneously. Preserve the volume and logs for diagnosis. Live deployment and Instagram operation must be verified in these accounts; repository tests alone cannot establish either.
