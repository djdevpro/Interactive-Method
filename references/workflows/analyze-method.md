# Deepen a method with transcript and visual evidence

This internal workflow runs after the first overview has been delivered and the user has requested deeper work. Check `session.deepDiveRequested` before starting detailed method missions.

Read the [handoff contract](../handoff-format.md) and [visual protocol](../visual-reading.md). Start from the original video, transcript, method map and screenshots already inspected in stage 1.

1. Bound each mission by a method or coherent group of steps, its timestamped intervals, unresolved questions and expected output. Include relevant surrounding context and dependencies.
2. Reread every interval. Inspect the supplied first-pass screenshots directly, not just their captions. Reconstruct objectives, conditions, inputs, actions, decisions, outputs and checks in [method.json](../../templates/method.json) and its [readable card](../../templates/method-card.md).
3. Record what the author said, what the demonstration showed and what the analysis inferred. Preserve missing transitions and unsupported claims instead of filling them from unverified general knowledge.
4. Request or take targeted additional captures when existing images fail to resolve a question. Move transition frames, compare the state before and after an action, or use a short clip when motion order matters. Preserve each pass and its provenance.
5. Check whether the method is sufficiently specified for a practical example. Separate expected results, results observed in the video and results actually reproduced in an authorized local execution.
6. Return card paths, evidence IDs, dependencies, uncertainties, proposed changes and review requests through [agent-result.json](../../templates/agent-result.json). Write only in the assigned mission folder.

Do not manufacture a method if the first-pass content contains only claims or commentary. When deeper inspection changes the detection decision, return the evidence and proposed correction to the orchestrator.

Further analysis and extra screenshots do not authorize supplementary sources. Research outside supplied material requires the separate explicit opt-in described in [research](../research-protocol.md).
