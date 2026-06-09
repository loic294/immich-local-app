---
description: Cross-platform feature policy
alwaysApply: true
applyTo: "**"
---

# Cross-Platform Support Policy

- All new features MUST support both macOS and Windows.
- NEVER ship a feature as macOS-only.
- If a platform-specific implementation is necessary, provide an equivalent Windows implementation in the same change.
- For unsupported platforms, return a clear and explicit error message rather than silently failing.
- Platform parity is a requirement for feature completion.
