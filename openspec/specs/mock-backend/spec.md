# mock-backend

## Purpose

Defines the in-browser mock backend (Mirage server + mock-socket WebSocket)
that lets the web UI run with no daemon and no machine configuration, for use
in `pnpm dev-mock` / `pnpm build:mock`. The mock answers every REST route and
WebSocket frame the client uses, matches the daemon's response contract
exactly (including its inconsistencies), persists mutations for the lifetime
of the page, ships a seeded fixture corpus rich enough to populate every view,
and is excluded entirely from the production build.

## Requirements

### Requirement: The web UI runs with no daemon and no machine configuration

The application SHALL provide a mock run mode in which the full web shell loads
and operates against an in-browser stand-in for the daemon. In this mode the
application SHALL NOT require a running daemon, a `.env` file, or any of the
machine-specific variables the daemon demands (`SINGULARITY_HOME`,
`DAEMON_PORT`, `CLAUDE_BIN`). Every view reachable from the navigation rail and
the More menu SHALL render its populated state, not an error or empty state.

#### Scenario: Shell loads with nothing else running
- **WHEN** a developer starts mock mode on a machine with no `.env` file and no daemon process listening
- **THEN** the shell loads and the session dock, tasks board, and default view render populated content

#### Scenario: Every view renders
- **WHEN** a developer visits each view in turn in mock mode
- **THEN** each view renders its populated state and the browser console reports no errors or warnings

#### Scenario: No machine configuration is read
- **WHEN** mock mode runs
- **THEN** no request reaches a daemon, and no state is read from or written to `SINGULARITY_HOME`, `~/.claude`, or any other location outside the browser

### Requirement: The mock answers every endpoint the client calls

The mock SHALL respond to every HTTP endpoint the web client requests, covering
both reads and writes, so that no panel is left non-functional. A request to an
endpoint the mock does not implement SHALL fail loudly and visibly rather than
resolving to an empty or default response, so that coverage gaps surface during
development instead of being mistaken for correct behaviour.

#### Scenario: A panel's reads and writes both work
- **WHEN** a developer opens an editor panel in mock mode, changes content, and saves
- **THEN** the save succeeds and the panel reflects the saved content

#### Scenario: An unimplemented endpoint is loud
- **WHEN** the client requests an endpoint the mock does not implement
- **THEN** the failure is raised as a console error identifying the unhandled request, and any test observing the console fails

### Requirement: Mock responses match the daemon's response contract

Mock responses SHALL match the daemon's shape for each endpoint exactly,
including the daemon's inconsistencies. Specifically, the mock SHALL return bare
arrays where the daemon returns bare arrays, bare objects with no success
wrapper where the daemon returns them, an error key inside an HTTP 200 body
where the daemon reports failure that way, and HTTP 409 where the daemon rejects
a write whose supplied modification time no longer matches the stored one.

#### Scenario: Unwrapped response shapes are preserved
- **WHEN** the client requests an endpoint whose daemon response is a bare array or a bare object with no success wrapper
- **THEN** the mock returns the same unwrapped shape, and the consuming panel renders without a shape-mismatch error

#### Scenario: Soft failures stay inside a 200
- **WHEN** the client requests an endpoint whose daemon reports failure as an error key inside a successful response
- **THEN** the mock returns HTTP 200 carrying that error key, and the panel renders its corresponding degraded state

#### Scenario: Stale-write conflict is rejected
- **WHEN** the client submits a write carrying a modification time that no longer matches the mock's stored value, without forcing
- **THEN** the mock responds HTTP 409 and the stored content is left unchanged

#### Scenario: Forced write overrides the conflict
- **WHEN** the client submits the same stale write with the force flag set
- **THEN** the mock accepts the write and returns the new modification time

### Requirement: The mock serves the live WebSocket protocol

The mock SHALL implement the daemon's WebSocket protocol, because the session
list, tasks, scheduled jobs, and background jobs are delivered only over that
socket and four HTTP polls in the client are gated on the socket being
connected. On connection the mock SHALL emit the daemon's opening burst of
frames. It SHALL respond to the client frames that drive terminal and session
behaviour, and SHALL stream a terminated response for chat requests.

#### Scenario: Opening burst populates the live surfaces
- **WHEN** the client's socket connects in mock mode
- **THEN** the mock emits the session list, tasks, scheduled jobs, and background jobs frames, and the dock and boards populate from them

#### Scenario: Socket-gated polling starts
- **WHEN** the client's socket reaches the connected state
- **THEN** the client's socket-gated periodic requests begin and the mock answers them

#### Scenario: Attaching a session shows terminal content
- **WHEN** the user selects a session in the dock
- **THEN** the mock replies with scrollback output and a status frame, and the terminal renders that content

#### Scenario: Typing echoes into the terminal
- **WHEN** the user types into an attached terminal
- **THEN** the mock returns the input as output and the terminal renders it

#### Scenario: A chat request streams and terminates
- **WHEN** the client sends a chat request
- **THEN** the mock emits one or more incremental response frames followed by a completion frame, and the UI leaves its loading state

### Requirement: Write actions converge through the same path as the daemon

Board and job state in the client converges from WebSocket frames, not from the
response body of the write request. The mock SHALL therefore broadcast the
corresponding update frame after any write that mutates tasks, scheduled jobs,
or background jobs, so the affected surface updates as it does against the real
daemon.

#### Scenario: Moving a task card persists on screen
- **WHEN** the user drags a task card to a different column
- **THEN** the mock records the move, broadcasts the updated tasks frame, and the card remains in its new column

#### Scenario: Creating a scheduled job appears in the list
- **WHEN** the user creates a scheduled job through its dialog
- **THEN** the mock records it, broadcasts the updated jobs frame, and the new job appears in the list

### Requirement: Mutations persist for the lifetime of the page

The mock SHALL hold its state in memory for the lifetime of the page, so that a
write is observable by subsequent reads within the same session. Reloading the
page SHALL reset the mock to its seeded starting state, giving every page load a
clean, identical baseline.

#### Scenario: A saved file reads back
- **WHEN** the user saves a file, closes its tab, and reopens the same file
- **THEN** the reopened file shows the saved content

#### Scenario: Reload restores the baseline
- **WHEN** the user makes several changes and then reloads the page
- **THEN** every surface returns to its seeded starting state

### Requirement: The mock ships a seeded fixture corpus

The mock SHALL start from a fixture corpus rich enough that every view has
meaningful content — including multiple projects with session transcripts, a
wiki with interlinked pages, grouped skills, editable configuration and rule
files, task cards across all board columns with history, and scheduled and
background jobs. Fixture identifiers SHALL match those used by the existing
sandbox corpus so that assertions written against one hold against the other.

#### Scenario: A view with a list has more than one entry
- **WHEN** a developer opens a list-bearing view in mock mode
- **THEN** the list contains multiple distinct entries rather than a single placeholder

#### Scenario: Pagination is reachable
- **WHEN** a developer opens the session transcript list in mock mode
- **THEN** the corpus contains enough sessions to require a second page

#### Scenario: Identifiers match the sandbox corpus
- **WHEN** a fixture entity exists in both the mock corpus and the existing sandbox corpus
- **THEN** its name and identifier are identical in both

### Requirement: Subresource paths are served in mock mode

Two endpoints are loaded by the browser as element subresources rather than
through the application's request layer, and so cannot be intercepted by the
in-page mock. Mock mode SHALL serve these paths by another means, so that binary
file preview and the embedded usage report render rather than showing a broken
or missing resource.

#### Scenario: Binary file preview renders
- **WHEN** the user selects an image file in the file explorer in mock mode
- **THEN** an image renders in the preview rather than a broken-image placeholder

#### Scenario: The embedded usage report renders
- **WHEN** the user opens the usage report view in mock mode with a report present
- **THEN** the embedded report renders its content rather than a missing-resource page

### Requirement: The mock is absent from production output

The mock and its dependencies SHALL be excluded from the production build. A
production build SHALL contain no mock code, and the production run path SHALL
be unaffected by the mock's existence.

#### Scenario: Production bundle contains no mock code
- **WHEN** a production build is produced
- **THEN** searching the build output for the mock library and the mock source directory yields no matches

#### Scenario: Production run path is unchanged
- **WHEN** the application is built and served by the daemon as before
- **THEN** its behaviour is identical to its behaviour prior to this change

### Requirement: Mock mode is invoked by a documented command

The mock run mode SHALL be reachable through a single documented command that
works on the shells this project supports, without requiring the developer to
set environment variables inline. The command SHALL be recorded in the project's
run documentation alongside the existing commands.

#### Scenario: One command starts mock mode
- **WHEN** a developer runs the documented mock command on either supported shell
- **THEN** the mock-mode shell starts and is reachable in a browser

#### Scenario: The command is discoverable
- **WHEN** a developer reads the project's run documentation
- **THEN** the mock command is listed with a description of what it does and what it does not require
