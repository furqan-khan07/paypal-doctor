#!/usr/bin/env bash
# Builds the read-only demo from the recorded real run, audits it, and only then
# publishes it to Vercel as its own project. Stops if the audit finds anything.
# This makes a public page, so run it yourself, on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build-demo.mjs "$@"
node scripts/audit-demo.mjs

cd demo-site
vercel project add paypal-doctor-demo 2>/dev/null || true # Fine if it already exists.
vercel link --yes --project paypal-doctor-demo
vercel deploy --prod --yes
