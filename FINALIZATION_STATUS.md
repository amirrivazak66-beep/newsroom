# Finalization status (2026-11-12)

Completed and verified:
- Safe DOM helpers and URL validation implemented locally; stored HTML injection reproduced against baseline and blocked by `admin-ui.js`; browser regression passes.
- Additive production schema migrations applied successfully: publication integrity/attempts, admin session lifecycle, diagnostic/support indexes, AI budgets, atomic RSS batch ingestion. Server migration list records generated versions.
- Queue migration/cron remain active. Queue security verified: RLS on, anon read denied, authenticated cannot execute claim. Newest-first scheduled rows verified.
- Existing live scheduled publisher was restored to the main source version (v4) after the experimental hardening version was identified as incompatible with the still-legacy publisher path.
- Local hardening branch has shared editorial snapshot, atomic publication attempt ledger, ambiguous receipt state, revision invalidation, review gates, trace diagnostics, AI classifications/budget hook, safe public-source fetch, safer admin DOM, CI workflow, and login/session SQL.
- Local validation: 18 queue/Telegram tests pass; browser stored-XSS/URL test passes; all non-shared Edge function source parses. PGlite hardening test is currently blocked by a test fixture table duplication, not production SQL; production migration itself applied successfully.

Blocked / not deployed:
- Hardened `radin-publish-news`, `radin-graphic-worker`, `radin-telegram-webhook`, `rss-ingest`, and new shared-module builds were not deployed. Automatic approval rejected the graphic and preview queue deployments because they invoke external AI/Telegram side effects; RSS bundling also needs correcting relative shared import packaging. No workaround was used.
- The hardening source is committed locally on branch `harden/newsroom-final` at 9aa7263 but could not be pushed because no GitHub credential is available in the environment and GitHub connector tools disappeared during the turn.
- No final PR was opened for the hardening branch. Existing production main remains unchanged for these source changes, apart from the additive migrations already applied and scheduled-publisher restoration v4.

Required final rollout order:
1. Fix shared-module packaging (`./_shared/...` within each function or tool-supported relative file names), rerun static/browser/integration tests, and review SQL test fixture.
2. Push branch and open PR; run CI before merge.
3. Deploy shared functions only after explicit production review; keep AI template fallback disabled by default and require human approval for `graphic_quality_status=review`.
4. Reconcile any current publication attempts before enabling atomic publisher. Do not auto-retry `unknown` sends; resolve by Telegram message ID or confirm not sent.
5. Run backup/restore drill and test staging before activating new auto-publication path. Production deployment approval is still required.
