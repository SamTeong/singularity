## ADDED Requirements

### Requirement: Users can connect Ollama usage from the Usage page

The application SHALL provide an explicit Connect or Reconnect action for Ollama
usage. The action SHALL open the managed browser profile for user authentication,
verify that the usage meter is visible, select browser mode without manual file
editing, and refresh the sanitized usage result.

#### Scenario: Successful connection
- **WHEN** the user completes Ollama sign-in and the usage meter becomes visible
- **THEN** browser mode is persisted atomically and the Usage card displays verified data

#### Scenario: Incomplete connection
- **WHEN** authentication is cancelled or times out before a usage meter appears
- **THEN** existing configuration is retained and the card presents an actionable failure

### Requirement: Background refresh never opens a visible browser

Automated and manual data refresh SHALL scrape headlessly and SHALL NOT launch a
visible browser. A visible browser SHALL open only through the explicit connection
operation.

#### Scenario: Stored web session expires
- **WHEN** background refresh reaches the Ollama sign-in page
- **THEN** it reports `auth-expired` and offers Reconnect without opening a window

### Requirement: Failed refresh preserves useful prior data

The application SHALL retain the last successful Ollama reading when a later refresh
fails and SHALL identify it as stale with its collection time. Failed refreshes SHALL
NOT be appended to usage history.

#### Scenario: Network fails after a successful reading
- **WHEN** a refresh cannot reach Ollama after usage was previously collected
- **THEN** the prior reading remains visible with stale status and the current failure

### Requirement: Ollama scrape failures are actionable

The daemon SHALL distinguish expired authentication, an interactive challenge,
incompatible authenticated markup, and browser or network unavailability.

#### Scenario: Authenticated page markup changes
- **WHEN** the settings page is authenticated but contains no recognized usage meter
- **THEN** the result reports `scrape-incompatible` rather than requesting reauthentication

### Requirement: CLI and web connection share one workflow

The terminal login command and daemon connection endpoint SHALL use one browser,
verification, configuration, and cache-invalidation implementation.

#### Scenario: Terminal connection succeeds
- **WHEN** the terminal login flow detects the usage meter
- **THEN** browser mode is persisted automatically with no hand-edit instruction
