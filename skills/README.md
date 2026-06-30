# skills/

Skills are portable units of domain knowledge / SOPs that supplement a profile for a class of
work. They improve performance but are **probabilistic** — if a step must happen every time,
codify it as a deterministic rail (playbook task, verification method, or governance gate),
not as skill prose.

Promotion path: a repeated successful trajectory → a skill (knowledge) → a playbook (fixed plan)
→ a specialized harness (deterministic rails + validation gates + templated outputs).

Format (proposed): `skills/<name>/skill.md` with frontmatter `{ name, triggers, tools,
verification_standard }` and a body of procedural guidance. Loaded by tag-matching against
`task.skill_tags`. None are committed yet — the first will be mined from a repeated success
(see the `improve` queue: "Mine repeated successful trajectories into a playbook").
