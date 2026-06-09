---
description: Logging and diagnostics policy
alwaysApply: true
applyTo: "**"
---

# Logging and Diagnostics Policy

- Add actionable logs for all new features and important control-flow decisions.
- Always log failures with enough context to diagnose the issue quickly.
- For multi-step operations, log start, key milestones, and final success/failure.
- Use stable log prefixes so related entries can be filtered in logs.
- Include identifiers and counts when useful, but avoid logging secrets (tokens, passwords, API keys).
