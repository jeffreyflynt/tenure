# Beliefs

Everything Tenure knows about you is stored as a belief. Beliefs are the unit of memory: typed, scoped, versioned, and auditable.

## Belief types

| Type          | What it captures                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Preference    | How you work and communicate: tools, patterns, communication style, explanation depth                      |
| Decision      | Commitments your future sessions must respect: architectural choices, plot decisions, ruled-out approaches |
| Entity        | Named things in your world: characters, services, systems, teams                                           |
| Relation      | Connections between entities: dependencies, ownership, structural relationships                            |
| Open Question | Things you are actively working through but have not yet decided                                           |

### Subtypes

Preferences carry an optional subtype that changes how the belief is used:

| Subtype   | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| expertise | Depth calibration. Tells the model how much to explain based on your level in a domain.       |
| style     | Communication patterns. Shapes tone, verbosity, and formatting rather than technical content. |

A preference without a subtype is a general working preference (tools, patterns, conventions).

## Epistemic status

Every belief carries a status that tells the model how much weight to give it.

| Status      | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| active      | You explicitly stated or decided this                                 |
| inferred    | Derived without an explicit statement. Shown to you for confirmation. |
| exploratory | You are considering this but have not committed                       |
| superseded  | Replaced by a newer belief. Retained for audit, never injected.       |

## Scope

Beliefs are scoped by domain. A belief scoped to `domain:code` is only injected in code sessions. A belief scoped to `domain:writing` is only injected in writing sessions. `user:universal` beliefs are injected in every session.

This prevents bleed between unrelated workstreams. If you have a character named Redis in your novel and Redis the cache in your codebase, the right belief surfaces based on the active scope.

## The beliefs dashboard

Visit `http://localhost:5757/beliefs` to view and manage your world model.

From the dashboard you can:

- Search and filter by type, status, or scope
- Edit any belief: content, canonical name, status, or the reasoning behind it
- Pin beliefs to keep them prioritized in every session
- View the full change history per belief
- Remove beliefs that are wrong or no longer relevant. They are marked superseded and hidden, recoverable from the Superseded filter.

## Pinning

Pinned beliefs are always injected regardless of query signal. Use pinning for facts that are always relevant to a session: your primary language, your framework, your narrative voice. Unpinned beliefs surface when the query is relevant to them.

## How beliefs are created

Beliefs are created in three ways:

1. **Extraction:** The sidecar worker reads every exchange and writes new
   beliefs asynchronously after the response is returned. You can pause
   extraction globally from Settings, or for a single session by sending
   `!extract off` in your chat client.
2. **Onboarding:** The onboarding flow at `http://localhost:5757/onboarding` seeds your world model from a short questionnaire.
3. **Manual authoring:** You can create and edit beliefs directly from the dashboard at any time.
   _For a full account of how retrieval works, see [retrieval.md](retrieval.md)._
