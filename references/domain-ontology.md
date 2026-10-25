# Lightweight domain ontology

The map places the method, its prerequisites and limitations in context. It remains a working file inside the investigation; no graph database is required.

Use [domain-map.json](../templates/domain-map.json). An entity has `id`, `type`, `label`, `description`, `aliases`, `evidenceIds` and `status`. A relation has `id`, `from`, `type`, `to`, `context`, `evidenceIds` and `basis` (`said`, `shown`, `inferred`).

## Types and relations

| Entity | Role in the analysis |
| --- | --- |
| `goal` | Intended outcome and its evaluation criteria |
| `concept` | Idea or mechanism to understand |
| `method` / `step` | Overall procedure and ordered actions |
| `technique` / `tool` | Approach used and tool implementing it |
| `prerequisite` / `constraint` | Required condition or contextual limitation |
| `decision` | Choice between paths |
| `result` / `check` | Expected output and means of checking it |
| `risk` | Failure mode or undesirable consequence |
| `claim` / `source` / `evidence` | Proposition and verifiable source connections |

Prefer `requires`, `precedes`, `uses`, `produces`, `evaluated-by`, `implements`, `alternative-to`, `limited-by`, `fails-when`, `supports`, `contradicts`, `clarifies` and `derived-from` relations.

Describe a new relation in `proposedVocabulary` before sharing it with other agents. Reuse existing identities when two labels name the same concept. Two distinct tools implementing the same technique remain separate entities.

## Controlled changes

The initial map reflects the video's concepts, including unclear terminology. Analysis of the supplied video and materials may clarify relations or expose gaps without looking for external sources. Keep inferred prerequisites, alternatives, risks and checks identifiable as inferences.

Supplementary research may extend the map only when `session.supplementarySourcesRequested` is true following an explicit human request. No complete map or ontology audit requires external research by default. Each change records its reason and evidence.

Retain the objective and `boundary` to limit expansion. A neighboring concept warrants a new branch only when it helps understand, execute, evaluate or choose the method within the requested scope. Topics useful later belong in `outOfScopeQuestions`.

Before consolidation, check that relation endpoints exist, identifiers remain stable, duplicates are handled and important relations have evidence or an explicit inference. A graph representation adds no certainty to the information it connects.
