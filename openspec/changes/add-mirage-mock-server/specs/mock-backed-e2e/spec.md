## ADDED Requirements

### Requirement: A second end-to-end suite runs against the mock backend

The project SHALL provide a second end-to-end suite that drives the web UI
against the mock backend instead of a daemon, invoked by its own documented
command and governed by its own test-runner configuration. This suite SHALL be
the fast sanity layer: it verifies that the UI renders, navigates, and responds
to interaction, and does not attempt to verify daemon behaviour.

#### Scenario: The mock suite runs without a daemon
- **WHEN** a developer runs the mock end-to-end command with no daemon running and no sandbox state directory present
- **THEN** the suite executes to completion and reports results

#### Scenario: The suite is discoverable
- **WHEN** a developer reads the project's run and testing documentation
- **THEN** the mock end-to-end command is listed alongside the existing one, with the distinction between the two suites stated

### Requirement: The mock suite runs in parallel with per-worker isolation

Because the mock's state lives inside the browser page rather than in a shared
process or directory, the mock suite SHALL run its tests in parallel across
multiple workers. Each test SHALL start from the seeded baseline regardless of
what any other test did, and the suite SHALL produce the same results whether
run with one worker or many.

#### Scenario: Tests run concurrently
- **WHEN** the mock suite is executed
- **THEN** more than one test runs at a time

#### Scenario: Tests do not observe each other's writes
- **WHEN** one test mutates state and another test reads the same surface concurrently
- **THEN** the reading test observes the seeded baseline, not the other test's mutation

#### Scenario: Repeated runs agree
- **WHEN** the mock suite is run twice in succession
- **THEN** both runs report the same set of passing tests

### Requirement: The mock suite completes faster than the daemon-backed suite

The mock suite SHALL complete in less wall-clock time than the existing
daemon-backed suite for comparable coverage, and that comparison SHALL be
measured and recorded rather than assumed.

#### Scenario: Wall time is measured and lower
- **WHEN** both suites are run on the same machine and their wall-clock durations recorded
- **THEN** the mock suite's duration is lower, and both figures are reported

### Requirement: The mock suite drives the same build semantics as the daemon-backed suite

The mock suite SHALL exercise a production-mode bundle, matching the existing
suite, so that specs behave identically under both. This matters because the
application gates at least one menu item on the production flag and runs a
development-only validation pass that emits console output, either of which
would change spec outcomes if the suite drove a development bundle.

#### Scenario: Production-gated UI is present
- **WHEN** a mock-suite test opens a menu containing a production-gated item
- **THEN** that item is present, as it is in the daemon-backed suite

#### Scenario: No development-only console output
- **WHEN** any mock-suite test runs with the console guard active
- **THEN** no development-only validation output causes a failure

### Requirement: Ported specs keep their existing assertions

Specs moved into the mock suite SHALL retain the assertions and accessible-name
selectors they use today, so that the two suites test equivalent behaviour and
divergence between mock and daemon surfaces as a failure. Where a spec currently
asserts against the real filesystem, it SHALL be rewritten to assert the same
outcome through the user interface.

#### Scenario: A ported spec is unchanged apart from its imports
- **WHEN** a spec that does not touch the filesystem is ported to the mock suite
- **THEN** its assertions and selectors are unchanged

#### Scenario: A filesystem assertion becomes a UI assertion
- **WHEN** a spec that asserts a saved file's contents on disk is ported
- **THEN** it instead reopens the file through the interface and asserts the content shown

### Requirement: Daemon-dependent behaviour stays in the existing suite

The existing daemon-backed suite, its sandbox harness, and its fixtures SHALL
remain unchanged and SHALL continue to pass. Flows that only the real daemon can
exercise — spawning agent processes, terminating real system processes, running
skills, and any flow the existing suite already forbids driving — SHALL NOT be
ported to the mock suite, because passing against a mock would assert nothing
about them.

#### Scenario: The existing suite still passes
- **WHEN** the daemon-backed suite is run after this change
- **THEN** it passes with no modification to its specs, harness, or fixtures

#### Scenario: Unsafe flows are not ported
- **WHEN** the mock suite is reviewed against the existing suite's list of flows that must never be driven
- **THEN** none of those flows appear in the mock suite

#### Scenario: The division of responsibility is recorded
- **WHEN** a developer reads the testing documentation
- **THEN** it states which suite covers UI behaviour and which covers daemon behaviour, and where a new spec belongs

### Requirement: The mock suite fails when the mock diverges from the client

The mock suite SHALL fail rather than silently pass when the client requests
something the mock does not implement, so that a route added to the daemon and
the client but not to the mock is caught by running the suite.

#### Scenario: A missing mock route fails the suite
- **WHEN** the client calls an endpoint the mock does not implement during a mock-suite test
- **THEN** that test fails and the failure names the unhandled endpoint
