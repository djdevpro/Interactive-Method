# Consolidate the analysis and verify evidence

The orchestrator owns shared registries. Use this workflow for the compact stage 1 overview or for stage 2 agent results, applying only the checks relevant to that stage. Read the [session contract](../session-contract.md), [ontology](../domain-ontology.md) and [quality checks](../quality-checks.md).

1. Read returned artifacts and decisive evidence, not only agent summaries. Resolve duplicate sources, concepts and methods with stable IDs. Preserve aliases when a split or merge changes the map.
2. Reconcile step order, prerequisites and dependencies. A method may contain a justified loop; a mission dependency cycle must be decomposed before scheduling.
3. Reopen the transcript passages and images supporting important settings, commands, numbers, changes and success conditions. Qualify conclusions stronger than their evidence.
4. Preserve contradictions and their contexts. A proposed adaptation remains distinct from the author's method. Update domain and method maps only with supported changes.
5. If no method is identified, retain an empty methods collection and summarize the content honestly. If evidence is inaccessible, retain uncertainty. Neither case requires fabricated steps to satisfy the template.

## Neutral Mermaid in every first result

Always produce `overview.mmd` and its matching Markdown diagram. Use the renderer's neutral theme. Plain Mermaid source is sufficient; do not add styling directives, colorful classes or configuration that overrides the neutral theme.

Arrows must express supported relationships. For procedural content, map the method; for nonprocedural content, use a clearly labeled topic or argument map. Stable identifiers are separate from human-readable labels. Keep labels readable and escape problematic syntax.

The deep playbook retains the original diagram and may add a separate diagram of justified adaptations. Explain the distinction in a legend. Render the diagrams when the host has the capability and report any rendering limitation accurately.

## Stage boundaries

Stage 1 ends with an overview, inspected screenshot evidence or an explicit access limitation, a neutral diagram and one invitation to deepen. Do not require deep method cards, external research or a playbook before presenting it.

Stage 2 starts only after the user's request. Consolidate agents' transcript and screenshot analysis, then pass verified cards, evidence, limits and audit results to [playbook production](build-playbook.md). Supplementary research remains optional and separately authorized.
