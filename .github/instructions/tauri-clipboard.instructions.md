---
description: Clipboard API policy
alwaysApply: true
applyTo: "**"
---

# Clipboard API Policy

- NEVER use browser clipboard APIs (`navigator.clipboard`, `ClipboardItem`, `document.execCommand("copy")`) in this project.
- ALWAYS use Tauri clipboard functions/commands for clipboard read and write operations.
- Clipboard features must work through Tauri-native implementations so behavior is consistent across supported desktop platforms.