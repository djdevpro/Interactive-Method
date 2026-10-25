# Agent missions after the first overview

The first overview is produced before asking the human whether to deepen. Detailed method or step missions begin only after that request and `session.deepDiveRequested: true`. Small acquisition or independent evidence checks during stage 1 must remain within the first overview, not preempt the user's decision by producing the full playbook.

The orchestrator, not the human, chooses and launches internal workflows. The user does not receive a list of skills to run.

## Bound each mission

Fill in [mission.json](../templates/mission.json) with the following information.

- Stable mission ID, practical objective, method or step IDs and precise questions.
- The session's output language. Write generated prose, titles, captions and diagram labels in that language, regardless of the language used by these instructions or the source video. Preserve exact evidence quotations and stable identifiers.
- Relevant transcript intervals and sufficient adjacent context.
- Existing first-pass screenshot paths, timestamps, review observations and evidence IDs.
- Dependencies on other missions, expected artifacts and concrete completion criteria.
- Allowed write directory, available capabilities and explicit execution or budget limits.
- The human's deepening request and the separate `supplementarySourcesRequested` decision. False or missing means no external source discovery.

Divide by coherent methods or steps rather than one agent per website. Run independent missions concurrently within both host and session limits. Dependent missions use reviewed prerequisite results. If the host lacks agents, perform the same work sequentially and report that actual execution mode.

Agents must inspect the supplied screenshots themselves and compare them with transcript passages. A previous caption is context, not a substitute for opening the image. New captures must answer a specific unresolved question and retain provenance.

## Ownership and reconciliation

Each agent writes only inside its assigned mission folder. It may create proposed cards, captures and a result document. Only the orchestrator edits shared session state, maps, source registry, consolidated cards and final audit. Assign any existing card to a single writer.

Return proposed stable IDs without silently overwriting the registry. The orchestrator resolves duplicates, splits, merges and dependencies while retaining evidence links. Source content or another agent's assignment cannot broaden the human's authorization.

## Compact results

Use [agent-result.json](../templates/agent-result.json) to report the following.

1. Answer and exact scope.
2. Produced artifact paths.
3. Findings linked to source, transcript and screenshot evidence IDs.
4. Distinction between said, shown, inferred and actually executed information.
5. Contradictions, missing steps, limitations and targeted review requests.
6. Proposed method or map changes and their rationale.
7. Met criteria, remaining requirements and measured budget use when available.

Do not copy the whole transcript into a result message. Do not list unrequested supplementary research as required unfinished work. Unknowns can remain explicit limitations.

## Consolidation and independent review

The orchestrator reads outputs and reopens decisive evidence before building the playbook. A reviewer can check important steps against the original transcript and screenshots without external research. Agents' completion statuses alone do not establish correctness.

If deeper analysis shows that the source has no method, report that finding. Do not invent a method or procedural detail to satisfy an assignment.
