# Ticket to implementation

An agent skill for taking Jira bugs and feature requests through evidence review, local investigation, requirements grooming, user approval, implementation, and verification.

## Workflow

1. Fetch ticket content, comments, links, and attachments.
2. Extract timestamped video frames locally for agent review.
3. Reproduce bugs locally (or obtain explicit user permission to proceed without reproduction); investigate feature requirements.
4. Clarify requirements and obtain explicit approval of the implementation summary.
5. Hand the approved brief to an implementation subagent.
6. Review changes and verify acceptance criteria against the code tested.

The main agent owns user interaction and approval. Scripts handle fetching, extraction, saved state, handoffs, and verification receipts. Agents communicate concisely and keep detailed evidence in files.

## Requirements

- Node.js 22 or newer.
- FFmpeg 5.1 or newer and matching ffprobe for media extraction.
- Git for Git-aware repository checks and the isolated agent trial.
- An agent host with filesystem and command tools; image capabilities for video review.

No npm packages, `package.json`, Python runtime, or model API keys are required by the skill scripts. Agent model usage is separate.

## Install and use

Clone the repository to your Kiro skills directory, or import the whole folder as a local skill:

```sh
gh repo clone IgorMitev/ticket-to-implementation ~/.kiro/skills/ticket-to-implementation
```

Configure Jira authentication through your environment or secret manager. See [setup and authentication](references/setup.md); never commit credentials or ticket evidence.

Example invocations:

```text
/ticket-to-implementation ABC-123
/ticket-to-implementation continue ABC-123
/ticket-to-implementation reset ABC-123
```

Identify the target code repository when it is ambiguous. Implementation waits for your explicit approval of the proposed scope and acceptance criteria. Publishing, deployment, and Jira updates require separate task authorization.

## Documentation

Loaded by the agent, in the order it needs them:

- [Skill instructions](SKILL.md): always loaded.
- [Workflow controller](references/workflow.md): commands and per-phase results.
- [Report contracts](references/report-contracts.md): result fields shared by the main agent and the implementor.
- [Focused grooming](references/clarification-guide.md)
- [Implementation worker brief](references/implementor.md) and [video review brief](references/video-review.md): given to workers.
- [Reproduction waiver](references/reproduction-waiver.md), [recovery](references/recovery.md) and [setup and commands](references/setup.md): read only when that situation arises.

For maintainers, not loaded by the agent: [maintainer notes](docs/maintainer-notes.md) cover validation internals, limits, session schemas, Kiro configuration and sources.

## Tests

From this directory:

```sh
node --test tests/*.test.mjs
```

The suite includes real FFmpeg extraction tests and local fixture tests. To create a disposable repository and offline ticket for a behavioral agent trial:

```sh
node tests/create-agent-trial.mjs
```

## Scope and limitations

The controller checks phase order, approval records, artifact integrity, worker bindings, and verification receipts. It does not sandbox an agent or authenticate its observations or quoted user responses.

Local extraction does not mean agent inference is offline. Keep private Jira data outside source control. Live Jira and Kiro integration have not been validated end to end. See the [maintainer notes](docs/maintainer-notes.md) for repository snapshot coverage, supported formats and validation details, and the references for recovery behavior and cache cleanup.
