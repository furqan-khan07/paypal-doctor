#!/usr/bin/env bash
# Builds the read-only demo from the recorded real run, audits it, and only then
# publishes it to Vercel as its own project. Stops if the audit finds anything.
# This makes a public page, so run it yourself, on purpose.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
site="${PAYPAL_DOCTOR_DEMO_DIR:-$root/demo-site}"

node scripts/build-demo.mjs --out "$site" "$@"
node scripts/audit-demo.mjs "$site"

cd "$site"
npx --yes vercel@latest project add paypal-doctor-demo 2>/dev/null || true # Fine if it already exists.
npx --yes vercel@latest link --yes --project paypal-doctor-demo

# Linking writes a short-lived Vercel token to .env.local. It must never be uploaded,
# so remove it and audit again: this is exactly what's about to go up.
rm -f .env .env.*
cd "$root"
node scripts/audit-demo.mjs "$site"

cd "$site"
npx --yes vercel@latest deploy --prod --yes
rm -f .env .env.*
