#!/usr/bin/env bash
# Phase 1 (TASK-01): fetch integration bundles and whitelist the agent's tools.
# Prerequisite: `swy login` (device-flow OAuth). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Fetch bundles for integrations declared in tooling.json (Notion, Resend).
swy bootstrap

# 2. Fetch the Twitter/X bundle.
swy get Twitter --non-interactive --yes

# 3. Whitelist the minimum tool set (least privilege).
swy add method notion.page.create
swy add method notion.query.create
swy add method resend.email.create
swy add method twitter_v2.tweet.create

# 4. Connect provider credentials and verify.
echo "Next: swy auth connect Notion; swy auth connect Resend; swy auth connect Twitter; swy doctor"
