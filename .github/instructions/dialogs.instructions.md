---
description: Custom DaisyUI dialogs only
alwaysApply: true
applyTo: "**"
---

# Dialog Policy

- ALWAYS use custom in-app DaisyUI modals/dialogs for confirmations, warnings,
  alerts, and other application prompts on both macOS and Windows.
- NEVER use system message dialogs, including Tauri dialog `confirm`, `ask`, or
  `message`, or browser `window.confirm`, `window.alert`, or `window.prompt`.
- Use the DaisyUI `modal`, `modal-box`, `modal-action`, and `modal-backdrop`
  components. An HTML `<dialog>` opened with `showModal()` is an in-app dialog,
  not a system dialog, and is the preferred implementation.
- Follow existing modal patterns: accessible title/description, focus trapping
  and restoration, explicit confirm/cancel actions, Escape/backdrop cancellation,
  and keyboard-event isolation from underlying views.
- Destructive actions require explicit confirmation when their safety cannot
  be verified. Cancellation must not perform the action.
- Native file/folder pickers are separate OS file-selection integrations, not
  application message dialogs.
