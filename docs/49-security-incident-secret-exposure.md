# Phase 15.27 — Security Incident Scope and Secret Exposure Verification

**Date:** 2026-07-01
**Investigator:** Claude Code (evidence-only, no modifications)
**Scope:** `apps/admin/.env.example`, `apps/admin/.env.local`, `apps/mobile/.env.example.json`
**Rules:** No secrets printed. No code modified. No secrets tested against external services.

---

## Executive Summary

Two files containing real-looking, non-placeholder sensitive credentials have been committed to the git repository and pushed to a public GitHub remote. The exposed credentials span MongoDB Atlas, Upstash Redis, Firebase (including an RSA private key), Brevo email API, JWT signing secrets, a cron secret, and a seed admin password. All 19 variables across both files are non-empty and not placeholder-looking, except for `NODE_ENV` and `NEXT_PUBLIC_APP_URL` in `.env.local` (which points to localhost — a placeholder URL). No secret scanning, no pre-commit hooks, and no `.gitignore` enforcement protect against this. History rewrite is required to fully remediate. **Incident Decision: C — Real-looking secrets committed and present in git history.**

---

## File Existence and Git Tracking Evidence

| File | Exists | Tracked by Git | In Git History | Commits Containing File | Current Status | Risk |
|---|:---:|:---:|:---:|:---:|---|---|
| `apps/admin/.env.example` | Yes | Yes | Yes | 2 (`5bf3a15`, `9b941a9`) | Unmodified (clean) | CRITICAL |
| `apps/admin/.env.local` | Yes | Yes | Yes | 1 (`9b941a9`) | Modified (unstaged) | CRITICAL |
| `apps/mobile/.env.example.json` | Yes | Yes | Yes | 1 (`5bf3a15`) | Modified (unstaged) | Low |

**`.gitignore` rules observed in `apps/admin/.gitignore`:**

```
.env
.env.*
!.env.example
!.env.template
!.env.local
```

Finding: `.env.local` is explicitly **whitelisted** by the negation rule `!.env.local`. This is a critical misconfiguration — `.env.local` is the standard file for local secrets and should never be committed. The whitelist overrides the `!.env.*` ignore pattern.

**`apps/mobile/.env.example.json` contents:** Non-sensitive config only (`API_BASE_URL` pointing to `company-admin-kappa.vercel.app`, `ENVIRONMENT: production`). No credentials. Low risk — however it reveals the actual production Vercel URL (`company-admin-kappa.vercel.app`), distinct from `genesis-admin.vercel.app` investigated in Phase 15.26.

---

## Redacted Variable Inventory

### `apps/admin/.env.example`

| Variable | Sensitive Category | Empty? | Placeholder-Looking? | Real-Looking? | Value Printed? | Rotation Required? |
|---|---|:---:|:---:|:---:|:---:|:---:|
| `MONGODB_URI` | MongoDB credential/URI | No | No | Yes (len=272, scheme=`mongodb`) | No | **Yes — P0** |
| `JWT_SECRET` | JWT signing secret | No | No | Yes (len=197) | No | **Yes — P0** |
| `JWT_REFRESH_SECRET` | Refresh token secret | No | No | Yes (len=191) | No | **Yes — P0** |
| `JWT_ACCESS_EXPIRES_IN` | Non-sensitive config | No | No | No (len=3, duration) | No | No |
| `JWT_REFRESH_EXPIRES_IN` | Non-sensitive config | No | No | No (len=2, duration) | No | No |
| `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` | Non-sensitive config | No | No | No (len=46, duration) | No | No |
| `UPSTASH_REDIS_REST_URL` | Redis credential/URI | No | No | Yes (len=39, scheme=`https`) | No | **Yes — P0** |
| `UPSTASH_REDIS_REST_TOKEN` | Redis token | No | No | Yes (len=62) | No | **Yes — P0** |
| `FIREBASE_PROJECT_ID` | Firebase client config | No | No | Yes (len=13) | No | **Yes — P1** |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account | No | No | Yes (len=61, email) | No | **Yes — P0** |
| `FIREBASE_PRIVATE_KEY` | Firebase private key (RSA PEM) | No | No | Yes (len=1791, PEM detected) | No | **Yes — P0** |
| `BREVO_API_KEY` | Email API key | No | No | Yes (len=89) | No | **Yes — P0** |
| `BREVO_SENDER_EMAIL` | Email config | No | No | Yes (len=24, email) | No | P3 |
| `BREVO_SENDER_NAME` | Non-sensitive config | No | No | No (display name) | No | No |
| `SEED_ADMIN_EMAIL` | Admin bootstrap credential | No | No | Yes (len=17, email) | No | **Yes — P1** |
| `SEED_ADMIN_INITIAL_PASSWORD` | Admin bootstrap credential | No | No | Yes (len=43) | No | **Yes — P0** |
| `CRON_SECRET` | Application secret | No | No | Yes (len=143) | No | **Yes — P0** |
| `NEXT_PUBLIC_APP_URL` | Public config | No | No | Yes (len=27, https URL) | No | No |
| `NODE_ENV` | Non-sensitive config | No | No | No (`development`) | No | No |

### `apps/admin/.env.local`

| Variable | Sensitive Category | Empty? | Placeholder-Looking? | Real-Looking? | Value Printed? | Rotation Required? |
|---|---|:---:|:---:|:---:|:---:|:---:|
| `MONGODB_URI` | MongoDB credential/URI | No | No | Yes (len=136, scheme=`mongodb+srv`) | No | **Yes — P0** |
| `JWT_SECRET` | JWT signing secret | No | No | Yes (len=198) | No | **Yes — P0** |
| `JWT_REFRESH_SECRET` | Refresh token secret | No | No | Yes (len=192) | No | **Yes — P0** |
| `JWT_ACCESS_EXPIRES_IN` | Non-sensitive config | No | No | No (duration) | No | No |
| `JWT_REFRESH_EXPIRES_IN` | Non-sensitive config | No | No | No (duration) | No | No |
| `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` | Non-sensitive config | No | No | No (duration) | No | No |
| `UPSTASH_REDIS_REST_URL` | Redis credential/URI | No | No | Yes (len=39, scheme=`https`) | No | **Yes — P0** |
| `UPSTASH_REDIS_REST_TOKEN` | Redis token | No | No | Yes (len=63) | No | **Yes — P0** |
| `FIREBASE_PROJECT_ID` | Firebase client config | No | No | Yes (len=14) | No | **Yes — P1** |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account | No | No | Yes (len=62, email) | No | **Yes — P0** |
| `FIREBASE_PRIVATE_KEY` | Firebase private key (RSA PEM) | No | No | Yes (len=1791, PEM detected) | No | **Yes — P0** |
| `BREVO_API_KEY` | Email API key | No | No | Yes (len=90) | No | **Yes — P0** |
| `BREVO_SENDER_EMAIL` | Email config | No | No | Yes (len=25, email) | No | P3 |
| `BREVO_SENDER_NAME` | Non-sensitive config | No | No | No (display name) | No | No |
| `SEED_ADMIN_EMAIL` | Admin bootstrap credential | No | No | Yes (len=18, email) | No | **Yes — P1** |
| `SEED_ADMIN_INITIAL_PASSWORD` | Admin bootstrap credential | No | No | Yes (len=62) | No | **Yes — P0** |
| `CRON_SECRET` | Application secret | No | No | Yes (len=144) | No | **Yes — P0** |
| `NEXT_PUBLIC_APP_URL` | Public config | No | **Yes** (localhost) | No | No | No |
| `NODE_ENV` | Non-sensitive config | No | No | No | No | No |

**Note:** `MONGODB_URI` differs between the two files. `.env.example` uses `mongodb://` direct connection format (len=272); `.env.local` uses `mongodb+srv://` SRV format (len=136). These may target the same Atlas cluster with different URI formats, or different clusters. Values treated as separately compromised credentials requiring independent rotation.

---

## Secret Classification and Blast Radius

| Secret Category | Affected System | Possible Impact | Rotation Owner | Rotation Priority |
|---|---|---|---|---|
| MongoDB URI (direct format) | MongoDB Atlas cluster | Database compromise, data exfiltration, data destruction | Atlas project owner | **P0** |
| MongoDB URI (SRV format) | MongoDB Atlas cluster | Same as above | Atlas project owner | **P0** |
| JWT signing secret | All active user sessions | Forge arbitrary admin JWT tokens, bypass authentication entirely | App developer | **P0** |
| JWT refresh secret | All refresh token sessions | Forge long-lived session tokens, persist unauthorized access indefinitely | App developer | **P0** |
| Upstash Redis URL + Token | Upstash Redis instance | Read/write/flush session cache, rate limit bypass, session poisoning | Upstash account owner | **P0** |
| Firebase service account email + RSA private key | Firebase project | Full admin access to Firebase: push arbitrary notifications, read/write Firestore/RTDB if configured, impersonate service account | Firebase project owner | **P0** |
| Brevo API key | Brevo email service | Send phishing/spam from production sender, read email contact lists, billing abuse | Brevo account owner | **P0** |
| SEED_ADMIN_INITIAL_PASSWORD | Bootstrap admin account in MongoDB | Login to admin portal as super-admin if account not changed post-seed | App developer | **P0** |
| CRON_SECRET | Cron job authorization | Trigger arbitrary cron jobs (session auto-close, leave allocation, carryforward) outside schedule | App developer | **P0** |
| FIREBASE_PROJECT_ID | Firebase project identity | Low impact alone; combined with private key enables full impersonation | Firebase project owner | **P1** |
| SEED_ADMIN_EMAIL | Admin portal | Identifies admin account email for targeted attacks | App developer | **P1** |
| BREVO_SENDER_EMAIL | Email delivery | Identifies sender identity; low impact alone | App developer | P3 |

**Highest blast radius:** Firebase RSA private key (grants full service account access to Firebase project), JWT secrets (allow arbitrary session forgery without credentials), and MongoDB URI (direct database access).

---

## Git History Exposure

| File | First Appeared In | Commits Containing File | On Current Branch | History Rewrite Required? |
|---|---|:---:|:---:|:---:|
| `apps/admin/.env.example` | `5bf3a15` (2nd oldest commit) | 2 | Yes | **Yes** |
| `apps/admin/.env.local` | `9b941a9` (3rd commit) | 1 | Yes | **Yes** |
| `apps/mobile/.env.example.json` | `5bf3a15` (2nd oldest commit) | 1 | Yes | No (non-sensitive) |

**Total repository commits:** 5 (`8979f57`, `5bf3a15`, `9b941a9`, `fe058b9`, `66c9dc7`)

**`.env.example` commit exposure timeline:**
- `5bf3a15` — "chore(scaffold): initialize monorepo structure — Phase 09.1 repository creation" — `.env.example` first added
- `9b941a9` — `.` — `.env.example` and `.env.local` both present

**Finding:** Removing the files from the working tree does NOT remove them from git history. `git rm --cached` removes index tracking but leaves blob data in all prior commits. A `git filter-repo` or BFG Repo Cleaner history rewrite on both files is required to eliminate the blobs from the entire repository history.

**Removing from history alone is insufficient** if the repository has already been pushed to a remote and potentially cloned or cached — secret rotation must happen regardless of history rewrite.

---

## Remote Exposure Risk

| Remote | Host | Visibility Known? | Visibility | Risk |
|---|---|:---:|---|---|
| `origin` | `github.com` (Sarvesh-V-Sawant/Company) | Partially | Unknown — cannot determine public/private from local metadata | HIGH if public, MEDIUM if private |

**Evidence:**
- Remote URL: `https://github.com/Sarvesh-V-Sawant/Company.git`
- Remote is reachable: `git ls-remote origin` returned HEAD at `66c9dc7` — confirmed push-synced.
- All 5 local commits including `5bf3a15` (first `.env.example` commit) and `9b941a9` (`.env.local` commit) are confirmed pushed to `origin/master`.
- Repository visibility (public vs private) cannot be confirmed without GitHub authentication.

**Conclusion:** Repository visibility is unknown. If the repository is or has ever been public, the secrets are globally accessible. GitHub also retains commit history even after force-push or deletion for a period (content via raw/blob endpoints). Treat as **potentially exposed to all GitHub users** until the repository owner verifies visibility AND rotates all P0 secrets.

> **Repository visibility unknown. Treat as potentially exposed until verified by owner.**

---

## Env Hygiene and Policy Check

| Control | Present? | Evidence | Gap |
|---|:---:|---|---|
| `.env.local` ignored | **No** | `!.env.local` explicitly whitelists it in `.gitignore` | Critical gap — must be removed from whitelist |
| `.env*.local` ignored | **No** | Pattern `.env.*` present but overridden by `!.env.local` | Same gap |
| `.env.example` placeholder-only convention | **No** | All 12 sensitive vars in `.env.example` contain real values, not placeholders | Convention violated at file creation |
| Secret scanning configured | **No** | No `.gitleaks.toml`, `.secretlintrc`, `.detect-secrets.yaml`, or equivalent found | No automated secret detection |
| Pre-commit hooks configured | **No** | `.git/hooks/` directory empty (no non-sample hooks) | No gate to prevent future secret commits |
| Documented rotation procedure | **No** | No doc found covering secret rotation steps | Gap in operational runbook |
| Documented production env setup | **Partial** | `docs/25-environment-configuration-guide.md` exists but no explicit "never commit real values" warning confirmed | Insufficient guidance |
| CI secret scanning | **No** | `ci.yml` contains no gitleaks/trufflehog/secret-scan step | CI would not catch committed secrets |

**Additional finding in CI:** `ci.yml` injects `JWT_SECRET: test-secret-min-64-chars-xxxxxxxxxx` inline — this is placeholder-safe. However `MONGODB_URI` and Redis credentials pull from GitHub Actions secrets (`${{ secrets.TEST_MONGODB_URI }}`), indicating separate test credentials exist. This is correct practice for CI — but the committed `.env.example` bypasses it entirely for local development.

---

## Incident Decision

**Decision: C — Real-looking secrets committed and present in git history.**

**Supporting evidence:**

1. `apps/admin/.env.example` contains 12 non-empty, non-placeholder sensitive variables including MongoDB URI, Firebase RSA private key, JWT secrets, Brevo API key, Redis token, seed admin password, and cron secret.
2. `apps/admin/.env.local` contains the same 12 sensitive variables with slightly different values (SRV vs direct MongoDB URI, marginally different lengths).
3. Both files are tracked by `git ls-files` — they were not accidentally staged; they were committed intentionally (due to `!.env.local` in `.gitignore`).
4. `apps/admin/.env.example` appears in commits `5bf3a15` and `9b941a9`.
5. `apps/admin/.env.local` appears in commit `9b941a9`.
6. All commits are confirmed pushed to `github.com/Sarvesh-V-Sawant/Company` — remote HEAD matches local HEAD `66c9dc7`.
7. No git history rewrite has been performed — blobs persist in full history.

**Evidence limitations:**

- GitHub repository visibility (public/private) not confirmed — requires authenticated GitHub access.
- Cannot confirm whether secrets have been actively abused (no access to service audit logs).
- Cannot confirm whether Atlas, Firebase, or Brevo access logs show anomalous access.
- The two MongoDB URIs may target the same Atlas cluster or different clusters — cannot determine without printing URI.

**Confidence level:** 99% — file tracking confirmed by `git ls-files`, history confirmed by `git log`, remote push confirmed by `git ls-remote`. Only unknown is whether damage has already occurred.

**What remains unknown:**

- Whether repository is public or private on GitHub.
- Whether any third party has cloned, forked, or scraped the repository.
- Whether GitHub secret scanning (if repo is private with Advanced Security) has already flagged these.
- Whether Atlas, Firebase, Brevo, or Upstash access logs show unauthorized use.
- Whether the seed admin account password has been changed since initial seeding.
- Whether active JWTs signed with the compromised secrets are currently in use.

---

## Unsupported Assumptions Rejected

- **Rejected:** "`.env.example` is safe to commit because it's an example file." — The file contains real values, not placeholders. The `example` naming convention implies placeholder content; that convention was violated.
- **Rejected:** "`.env.local` is a local-only file so it won't be pushed." — The `!.env.local` whitelist in `.gitignore` overrides the standard ignore behavior. It was committed and pushed.
- **Rejected:** "GitHub private repos are safe from exposure." — Repository visibility unknown. Even if currently private, prior exposure window cannot be ruled out. Secrets must be rotated regardless.
- **Rejected:** "Removing files from the working tree removes them from history." — Git object blobs persist in all prior commits until a history rewrite is performed.

---

## Remaining Unknowns

1. GitHub repository visibility (public vs private).
2. Whether any unauthorized actors have accessed any of the exposed services.
3. Whether the seed admin account uses the committed initial password or has been changed.
4. Whether active sessions signed with the committed JWT secrets are in flight.
5. Whether `company-admin-kappa.vercel.app` (from `apps/mobile/.env.example.json`) is the correct production URL rather than `genesis-admin.vercel.app` (Phase 15.26 finding). Both should be treated as production candidates.
6. Whether the `.env.example` and `.env.local` MongoDB URIs target the same Atlas cluster (same credentials, different URI format) or distinct clusters.

---

## Remediation Plan

**DO NOT IMPLEMENT THIS PLAN WITHOUT EXPLICIT AUTHORIZATION.**

| Step | Action | Owner | Risk If Skipped | Requires Code Change? |
|---|---|---|---|:---:|
| 1 | **FREEZE:** Halt all production deployment changes immediately. No new Vercel deployments until secrets are rotated and env vars are updated. | Project lead | New deployment could use compromised secrets | No |
| 2 | **P0 — Rotate MongoDB credentials:** Atlas → Database Access → rotate password for the compromised user. Update connection string. | Atlas project owner | Database fully accessible with committed credentials | No |
| 3 | **P0 — Rotate JWT signing secrets:** Generate two new secrets (access + refresh), minimum 64 characters of cryptographic randomness. | App developer | All sessions can be forged by attacker indefinitely | No |
| 4 | **P0 — Rotate Firebase private key:** Firebase Console → Service Accounts → generate new key, delete old key. | Firebase project owner | Full Firebase project access for anyone with committed key | No |
| 5 | **P0 — Rotate Upstash Redis token:** Upstash Console → Database → reset REST token. | Upstash account owner | Session cache readable/writable, rate limits bypassable | No |
| 6 | **P0 — Rotate Brevo API key:** Brevo → API Keys → delete old key, generate new. | Brevo account owner | Arbitrary email sending from production sender identity | No |
| 7 | **P0 — Rotate CRON_SECRET:** Generate new random secret (minimum 64 hex chars). | App developer | Cron jobs triggerable without schedule | No |
| 8 | **P0 — Change seed admin account password:** Login to admin portal, change password for the seed admin email account. | App developer | Direct admin portal access with committed password | No |
| 9 | **P1 — Verify or create new Firebase service account email:** Determine if client email is a separate service account or shared; revoke if compromised. | Firebase project owner | Lateral access risk across Firebase project | No |
| 10 | **Update Vercel environment variables:** Set all rotated values in Vercel project settings (production + preview environments). | Vercel project owner | Production app will fail to connect after rotation | No |
| 11 | **Fix `.env.example`:** Replace all sensitive values with placeholder strings (e.g., `your-mongodb-uri-here`, `CHANGE_ME_min_64_chars`). | App developer | Future developers will inadvertently copy real credentials | **Yes** |
| 12 | **Fix `.gitignore`:** Remove `!.env.local` rule. Add `.env.local` to ignore list explicitly. | App developer | `.env.local` will be re-committed on next `git add` | **Yes** |
| 13 | **Remove `.env.local` from git index:** Run `git rm --cached apps/admin/.env.local` and commit the change. | App developer | File remains tracked; future changes will be committed | **Yes** |
| 14 | **Rewrite git history:** Use `git filter-repo --path apps/admin/.env.example --invert-paths` and `git filter-repo --path apps/admin/.env.local --invert-paths` to remove blobs from all commits. Force-push rewritten history. | App developer | Historical blobs accessible via commit SHAs indefinitely | **Yes** (history) |
| 15 | **Notify GitHub:** If repo is or was public, contact GitHub Support to invalidate cached raw blob URLs for the affected commits. | Project lead | GitHub CDN may cache blobs even after force-push | No |
| 16 | **Invalidate active sessions:** *(Corrected 2026-11-08 — see doc 84.)* Rotating `JWT_SECRET` invalidates only the 15-minute access tokens. Refresh sessions ARE persisted in MongoDB (`devicesessions`, hashed tokens) and survive the rotation, so users stay signed in. Do **not** configure the exposed key as `JWT_SECRET_PREVIOUS`. If the MongoDB credentials were exposed (they were — row MONGODB_URI), the owner should decide whether to revoke all `DeviceSession` documents after rotating the DB credentials (forces every user to sign in again). | Owner / app developer | Old compromised tokens could remain valid if the exposed key is still trusted | No |
| 17 | **Redeploy:** Deploy to Vercel after all rotated env vars are set. Verify health endpoint returns `status: ok`. | App developer | N/A | No |
| 18 | **Re-run targeted runtime verification:** Confirm MongoDB, Redis, Firebase connections succeed with new credentials. | App developer | Unknown if rotation broke any connection | No |
| 19 | **Add secret scanning:** Configure `gitleaks` pre-commit hook or GitHub Advanced Security secret scanning to prevent future commits. | App developer | Next secret commit will go undetected | **Yes** |
| 20 | **Quality gates:** Run `npm test`, `npm lint`, `flutter analyze` only after code/file changes in steps 11–13 are committed. | App developer | N/A | No |

---

## Risk

**Current risk level: CRITICAL**

- 9 P0 secrets committed to git and pushed to GitHub.
- Repository visibility unknown — may be publicly accessible.
- All secrets must be treated as compromised as of commit `5bf3a15` (earliest exposure).
- An attacker with the Firebase private key has full service account access regardless of MongoDB or Redis rotation.
- An attacker with the JWT secrets can forge valid admin tokens without any database access.
- No mechanism currently prevents re-commitment of secrets on next `git add .`.

---

## Regression Risk

**Post-remediation regression risks:**

| Item | Risk | Mitigation |
|---|---|---|
| JWT rotation invalidates all active user sessions | Users logged in at rotation time are logged out | Accept this; inform users; rotate during low-traffic window |
| MongoDB password rotation requires Vercel env var update before redeploy | App will fail to connect if env var lags behind rotation | Update Vercel env first, then rotate Atlas password, then redeploy |
| History rewrite breaks all local clones | Contributors will have diverged history | Force-push and require all contributors to re-clone |
| `.env.local` removal from index breaks local dev setups | Local dev cannot build without `.env.local` | Ensure each developer has a local copy before git rm --cached |

---

## Production Readiness Impact

This incident adds three additional blockers to the NOT READY status already documented in Phase 15.26:

| Blocker | Source | Severity |
|---|---|---|
| 9 P0 secrets committed to git and pushed to remote | This phase | CRITICAL |
| Firebase RSA private key committed in full | This phase | CRITICAL |
| Git history contains secret blobs (not removable without rewrite) | This phase | CRITICAL |
| Health probe never calls `connectDB()` | Phase 15.26 | HIGH |
| `proxy.ts` not registered as Next.js middleware | Phase 15.26 | HIGH |
| Vercel Deployment Protection blocks all unauthenticated external requests | Phase 15.26 | MEDIUM |

---

## Final Decision

**NOT READY**

All 9 P0 secrets must be rotated, Vercel environment variables updated with rotated values, `.gitignore` corrected, `.env.local` removed from git index, `.env.example` replaced with placeholder values, git history rewritten, and the health probe defect fixed before any production launch.
