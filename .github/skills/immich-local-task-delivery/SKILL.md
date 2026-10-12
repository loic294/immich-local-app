---
name: immich-local-task-delivery
description: Process and deliver pending Notion tasks for the Immich Local app project.
---

# Immich Local Task Delivery

Use the `notion-task-delivery` workflow for end-to-end backlog work, with the following project-specific defaults:

- Notion data source: `collection://3f516ff3-43e7-80f7-beef-000bfda67663` ("Immich Local AI Planning").
- Parent database page: `3f516ff3-43e7-80cc-aa15-f15b18899f19`.
- Repository: `loic294/immich-local-app`.
- Current checkout: `/Users/loicba/dev/immich-local-app`; work on the branch already checked out.
- Status property: `Status`; task title property: `Name`; process `Not started` by default.

Always fetch the data source schema and task page contents before acting. Query all matching tasks, include every task in the plan, and do not substitute a Notion database from another project. Preserve user-owned changes and follow this repository's `.github/instructions/` and root `AGENTS.md` when present.

Before editing implementation files, provide a task-by-task plan and obtain explicit approval. Prepare design/behavior proposals for **all selected tasks concurrently**; do not finish one task's design before beginning another's. Each task still requires the user's explicit design approval before that task's implementation, including non-visual fixes. As approvals arrive, immediately start bounded implementation subagents for those tasks in parallel. Assign separate subagents to independent workstreams within a task when file ownership is clear. Serialize only conflicting edits to the same files or dependent integration steps, never the entire backlog by default. Clarify delivery (local-only, commit, or push/PR) when not specified, including any automatic release consequences. Do not mark Notion tasks complete until implementation is validated and approved delivery requirements are satisfied.

## Parallel execution

For a multi-task backlog, launch design/research work for every selected task concurrently. Do not queue design tasks to start only after earlier designs finish. Present the resulting proposals for individual user approvals; implementation remains gated per task, and approved implementations run concurrently. Split a task into parallel workstreams when responsibilities have clean file boundaries (for example, frontend and Rust backend); give every subagent explicit owned files and acceptance criteria. The coordinator integrates and validates the combined result. Serialize only the specific changes that share files or depend on each other, not the entire backlog.

If the user explicitly waives design approval for the current backlog and asks to implement first, proceed with all selected tasks concurrently without further design prompts. Record that waiver in the session plan; it does not automatically waive design review for future backlogs or authorize commits, pushes, or releases.
