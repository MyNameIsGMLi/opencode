---
name: opencode-upgrade
description: Use when user invokes /upgrade to update opencode CLI from local source installation, especially when installed in a custom directory like /Users/ggm/SelfProjects/PrivateOpenCode/opencode and managed by git. Use for symptoms like outdated features, bugs in current version, or user urgency for updates in forked repositories.
---

# Skill: opencode-upgrade

## Overview
Structured workflow for safely updating a local git fork of opencode, ensuring upstream synchronization, handling local changes, and verifying success. Core principle: Always sync fork with upstream before local pull, protect work with stashing, retry on transients, and verify post-update.

## When to Use
- When user explicitly invokes /upgrade
- For source installations in custom directories managed by git as forks
- When encountering outdated code, missing features, reported bugs, or update failures
- Under pressures like deadlines, uncommitted changes, network instability, or repeated failures

When NOT to use:
- For official binary installations (suggest GitHub releases)
- When repository isn't a fork or lacks upstream remote
- For non-opencode upgrades

## Core Pattern
Before: Simple git pull origin, missing upstream changes.
After: Stash → fetch/merge upstream → push origin → build → unstash → verify.

## Quick Reference
| Step | Command | Purpose | Common Errors |
|------|---------|---------|---------------|
| 1. Status | `git -C /Users/ggm/SelfProjects/PrivateOpenCode/opencode status` | Check local changes | Ignored changes |
| 2. Stash | `git stash` | Protect local work | Conflicts on merge |
| 3. Sync upstream | `git fetch upstream && git checkout main && git merge upstream/main` | Get original repo updates | No upstream remote, conflicts |
| 4. Push fork | `git push origin main` | Sync fork on GitHub | Push rejected |
| 5. Install deps | `pnpm install` | Update packages | pnpm not found |
| 6. Build | `pnpm build` | Compile new version | Build errors |
| 7. Unstash | `git stash pop` | Restore local changes | Pop conflicts |
| 8. Verify | `opencode --version` | Confirm success | Version unchanged |

## Implementation
Use Bash for each step sequentially in workdir `/Users/ggm/SelfProjects/PrivateOpenCode/opencode`.

- If no upstream remote: `git remote add upstream <original-repo-url>` (confirm URL with user if unknown)
- On network failure: Retry 3 times with 5s, 10s, 20s delays
- On merge conflicts: Abort, notify user for manual resolution
- After build: Tell user to restart opencode

## Common Mistakes
- Not syncing upstream: Fork drifts from original, missing fixes/features
- Direct pull without stashing: Leads to conflicts or lost work
- Using wrong package manager: Use pnpm, not npm or bun
- Aborting on first error: Retry transients; only stop for unresolvable issues
- Skipping verification: Silent failures go unnoticed
- Assuming branch name: Always confirm with `git branch`, typically `main`

## Shell Script Pattern
```bash
cd /Users/ggm/SelfProjects/PrivateOpenCode/opencode
git status
git stash
git fetch upstream || (sleep 5 && git fetch upstream) || (sleep 10 && git fetch upstream)
git checkout main
git merge upstream/main
git push origin main
pnpm install
pnpm build
git stash pop
opencode --version
```

Final message: "Upgrade successful. Restart opencode to use the latest version. If there were conflicts, resolve them manually."
