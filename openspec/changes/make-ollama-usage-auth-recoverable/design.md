## Context

The daemon scrapes `https://ollama.com/settings`. Manual-cookie mode and the managed
Playwright profile are separate authentication stores. The managed profile persists
cookies but cannot renew a deliberately expired Ollama session without user input.

## Goals / Non-Goals

**Goals:** remove manual JSON editing; make reauthentication available from the Usage
page; prevent background browser popups; retain useful stale data; expose actionable
failure states.

**Non-Goals:** automate magic-link, OAuth, MFA, or CAPTCHA interaction; bypass Ollama
session expiry; invent an unsupported account-usage API; scrape a user's ordinary
browser profile.

## Decisions

### Interactive authentication is an explicit operation

A dedicated server operation launches the existing persistent profile headfully and
waits for a usage meter. On success it atomically writes browser mode, invalidates the
Ollama cache entry, performs a headless verification, and returns sanitized usage.
Only an explicit user action may launch a visible browser.

### Background scraping stays headless

Normal polling performs one headless attempt. A redirect to sign-in is
`auth-expired`; an authenticated page without the expected meter is
`scrape-incompatible`; browser launch/navigation failures are `unavailable`.
Interactive challenge state is reported only when the page indicates a challenge.

### Failed refresh retains the last successful value

The response carries the last successful Ollama reading with `stale: true`, its
timestamp, and the current error state. Failed readings are not appended to history.

### One shared login implementation

The daemon endpoint and `scripts/ollama-login.mjs` call the same exported workflow.
The CLI wrapper may prompt for Enter, but it must not duplicate browser/config logic.

## Risks / Trade-offs

- The scraper remains coupled to Ollama page markup; the incompatible state makes
  that distinguishable from authentication expiry.
- A web session can still expire and require user interaction because Ollama offers
  no supported quota API or refresh-token contract.
- Only one connect/scrape operation may own the persistent profile at a time.

## Migration Plan

Existing manual-cookie configuration remains readable. A successful interactive
connection replaces it with browser mode. Rollback leaves the persistent profile and
legacy configuration usable by the previous implementation.
