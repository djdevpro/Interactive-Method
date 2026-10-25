# Identify the video's methods and produce the first overview

This is an internal stage 1 workflow. The user does not invoke it separately. A supplied video link starts this work without a deliverable-selection question.

1. Acquire the video's metadata and complete available timestamped transcript using the [CLI contract](../cli-contract.md). Keep the actual origin, language, automatic-caption status and gaps. Read the entire transcript, including separate returns to a topic.
2. Identify candidate methods and supporting intervals in [video-map.json](../../templates/video-map.json). A method has a practical objective, actions or decisions connecting inputs to an outcome, and enough structure to distinguish it from a topic list. Do not turn every chapter, criticism or named concept into a method.
3. Obtain the video early. Select screenshot times from candidate procedures, demonstrations, settings, diagrams and results. Extract and inspect them during this stage using the [visual protocol](../visual-reading.md). Revise the candidate map from what the images actually show.
4. Record the overall detection status and reason. Use `identified` for evidenced methods, `none` when inspected content contains no identifiable method, and `uncertain` when missing or ambiguous evidence prevents a conclusion. Preserve methods that span several separate intervals.
5. Build a concise [overview](../../templates/overview.md) containing the subject, main claims, actual method if any, key timestamps, useful screenshots and limits. Use stable method IDs where applicable. For each identified method, create a minimal [method.json](../../templates/method.json) record with its ID, source ID and intervals, and reference it from the session. Keep session and video-map method lists consistent. A first pass does not need exhaustive method cards or a playbook.
6. Always create `overview.mmd` and the matching Mermaid block in the overview. Use a neutral visual theme, stable IDs and readable labels. When methods exist, show their supported relationships. Otherwise, map topics or the argument and clearly label it as a content overview, not a procedure.
7. Present the first result, then ask once whether the user wants deeper analysis and an HTML playbook. Save the ready state and stop until the answer arrives.

A missing transcript is not proof of silence. An inaccessible video is not proof that no method exists. A talking-head passage can still state a method; inspected screenshots may simply add no information. Document those distinctions.

No external sources are needed to finish this stage. Unsupported claims remain claims made in the video. Do not browse for extra videos, articles or papers unless the user separately requested supplementary research.
