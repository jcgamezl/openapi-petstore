# .pdlc/ — generated, do not edit

Self-contained PDLC runtime, distributed from the spine fork via
`spine compile` / `spine distribute-runtime`. This is what an agent
(Claude Code / Cursor) invokes via Bash for phase/gate/routing
operations in this repo — it is not meant to be run by hand.

Prerequisites on a developer machine: Node >= 18 and git >= 2.20.
No npm install needed — js-yaml is vendored under vendor/.

Commit this whole directory (plus .claude/, .cursor/ and
.github/workflows/pdlc-gate-check.yml): ticket worktrees only
contain committed files, and the CI check needs it on every branch.

Ticket state and artifacts live in pdlc/<TICKET-ID>/ inside each
ticket's worktree — see PDLC-QUICKSTART.md at the repo root.
Re-distributed automatically whenever the spine fork re-compiles
into this repo — do not hand-edit anything under here.
