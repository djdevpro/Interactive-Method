# Visual reading guided by a question

Screenshot extraction and inspection happen during the first pass, before the overview is presented and before asking whether to deepen. They help identify whether a method exists and clarify gestures, settings, values and diagrams. Do not defer all visual work to detailed agents.

Use the transcript to select candidate moments, obtain the video early and inspect real images. A talking-head video still receives a targeted inspection; the images may add no method information. If acquisition or image access is unavailable, record the concrete attempt and limitation rather than inventing observations.

## Choose the images

Before extraction, name the question to resolve and choose each capture's role.

| Role | Information sought |
| --- | --- |
| `initial-state` | Data, interface, context or settings before the action |
| `action` | Decisive gesture, command, parameter or choice |
| `result` | Produced output or state after the action |
| `explanation` | Diagram, table or conceptual relationship |

Two to four candidates per method may be enough for an initial pass. This is not a quality threshold. A long method with several decisions may need more evidence; a talking-head passage may add none.

Select moments using the transcript and observed transitions instead of regular intervals. Include surrounding context when the demonstration does not align exactly with the speech.

## Inspect and revisit

1. Extract images with the CLI, then open them using the host's visual capability.
2. Record what is actually readable and how it relates to the question. Treat values, commands and units carefully; an unreadable image does not justify presenting an approximate transcription as exact.
3. If the image is a transition frame, move the timestamp by a few seconds in a new pass. If gesture order matters, examine a short interval or several successive states.
4. Compare nearby captures. Keep the one that best explains the method; record duplicates and rejected images without counting them as new evidence.
5. Stop when the visual question is resolved or the limitation is established. An off-screen sequence, blurry interface or inaccessible video remains an explicit limitation.

A PNG file alone never establishes that its contents were inspected. Retain `reviewedAt`, `observation`, `decision`, `questionId`, timestamp and capture path in the method card. The technical `captures.json` manifest provides provenance; the card provides interpretation.

## Preserve distinctions

- Something **said** by the author is supported by a transcript passage.
- Something **shown** is supported by a capture or interval actually examined.
- Something **inferred** includes the agent's reasoning and supporting evidence.

A displayed command has not necessarily succeeded. The absence of an error message is insufficient proof of success. Look for the final state when the method's success depends on it.

For a talking-head video, use `reviewed-no-added-value` when the examined moments add nothing to the method, and list those moments. Use `unavailable` when the media could not be accessed. Do not confuse the two.

## Reuse during deeper work

After the user requests deeper analysis, give agents the existing first-pass screenshots, their timestamps and transcript context. Agents inspect them directly and add captures only to resolve specific gaps. Keep initial and later passes traceable.

## Other videos and PDFs

Apply the same protocol to relevant passages in other videos, with a separate source ID for each. For a PDF, reference the page, figure or table and relevant area. Check headings, units, axes and legends against the original page before retaining a value or relationship.

User-supplied materials may be inspected as part of the requested analysis. Discovering or retrieving supplementary videos or PDFs requires an explicit request from the human asking for the analysis and `session.supplementarySourcesRequested: true`. An unresolved visual question does not authorize that search automatically.
