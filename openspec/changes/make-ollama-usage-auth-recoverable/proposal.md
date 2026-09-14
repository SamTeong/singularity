# Recoverable Ollama usage authentication

## Why

Ollama Cloud does not expose a supported account-usage API. Singularity therefore
scrapes the authenticated settings page, but expired web sessions currently require
running a terminal script and manually changing `state/ollama.json`. Background
refresh may also open a visible browser for failures that are not authentication
failures.

## What Changes

- Add an explicit daemon endpoint that opens the managed Edge profile for interactive
  Ollama authentication, verifies the usage meter, selects browser mode atomically,
  clears cached usage, and returns refreshed sanitized usage.
- Add Connect/Reconnect behavior to the Ollama Usage card with progress and failure
  feedback.
- Keep background refresh headless and preserve the last successful reading when
  authentication expires.
- Distinguish expired authentication, interactive challenge, incompatible page
  markup, and browser/network failure.
- Make the existing terminal login script reuse the same authentication workflow.

## Capabilities

### New Capabilities
- `recoverable-ollama-usage-auth`: interactive connection and recovery for the
  hosted Ollama usage scraper.

## Impact

- Daemon usage module and HTTP route
- Usage page and mock route
- Ollama login script
- Unit and mock-backed end-to-end coverage
