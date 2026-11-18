# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-19

### Fixed

- **DeepSeek Harness Desktop / dsh `0.2.2-rc.3`:** `task_endurance_set` and
  `task_endurance_cancel` no longer crash on the non-existent `agents.roots()`
  API. Root-agent detection now uses the supported contract:
  `ctx.agents.get(agent.id) === agent && agent.session.header.origin !== 'subagent'`
  (the same rule the official goal tools use).
- Unexpected tool exceptions are wrapped as `ENDURANCE_INTERNAL` instead of
  escaping as raw `TypeError`, so a PTC `run_code` batch no longer marks every
  call in the batch as failed.

### Added

- Regression tests for subagent-origin sessions, stale agent instances, and
  unexpected tool errors.
- `CHANGELOG.md`.

## [0.1.0] - 2026-11-17

### Added

- Initial public release: dual convergence modes (`converge` / `idempotent_soak`),
  five `task_endurance_*` tools, idle/tick injection driver, kickoff, session-log
  persistence, safety limits, and the design contract in `docs/DESIGN.md`.
