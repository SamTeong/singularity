# Runtime resource observations

Compare the main checkout and the Rust candidate without instrumenting either
process. `scripts/observe-runtime.ps1` samples per-process counters from
Windows CIM and the TCP listener table; `scripts/summarize-runtime-observations.mjs`
turns the NDJSON output into per-target, per-identity numbers.

The collector is read-only: it does not restart, signal, or attach to a server,
does not read command lines, and does not change either checkout. Run it while
both environments are live, not during a controlled benchmark.

## Manifest

An absolute JSON manifest names each target. `label` is the environment
(`main` or `rust`), `role` distinguishes backend from frontend, `port` is the
listening port, `checkoutPath` is the checkout used for revision metadata, and
`expectedRevision` is an optional commit prefix (short or full) recorded for
comparison. A malformed manifest fails before any output file is created.

```json
{
  "targets": [
    {
      "label": "main",
      "role": "backend",
      "port": 4317,
      "checkoutPath": "C:/git/singularity",
      "expectedRevision": "66591a9"
    },
    {
      "label": "main",
      "role": "frontend",
      "port": 5317,
      "checkoutPath": "C:/git/singularity"
    },
    {
      "label": "rust",
      "role": "backend",
      "port": 4318,
      "checkoutPath": "C:/git/singularity/.worktrees/native-http-01a17e17",
      "expectedRevision": "d562e1e"
    },
    {
      "label": "rust",
      "role": "frontend",
      "port": 5318,
      "checkoutPath": "C:/git/singularity/.worktrees/native-http-01a17e17"
    }
  ]
}
```

Targets are keyed by `label` plus `role`; ports must be unique.

## Collecting

```powershell
pwsh scripts/observe-runtime.ps1 `
  -ManifestPath C:/obs/targets.json `
  -OutputDirectory C:/obs/run-2026-10-29 `
  -IntervalSeconds 2 -DurationSeconds 60
```

- `-ManifestPath` and `-OutputDirectory` are required.
- `-IntervalSeconds` (default 2) sets the sampling period.
- `-DurationSeconds` (default 60; `0` runs until stopped) bounds the run.
- `-StopFile` is an optional path; its appearance ends the run on the next
  interval without sending anything to the server.

Keep the output directory outside the checkout. Each run writes a unique
`runtime-observations-<UTC stamp>-<run id>.ndjson` file. Touching the stop file
ends the run and writes a `run_end` row; whether Ctrl+C runs the `finally`
block that writes it depends on the host shell, so the summarizer treats a file
without `run_end` as incomplete instead of assuming the row exists. Use
`-SelfTest` to run the deterministic counter, PID-reuse, descendant-bound, and
missing-window checks.

## Output

NDJSON, one JSON object per line:

- `run_start` — tool/host metadata, arguments, sampling limits, declared targets.
- `identity` — first sighting or a change of `(pid, creationDate)` for a target.
  `reason` is `start`, `restart` (identity changed) or `resume` (the same
  identity seen again after a `missing` row); a `resume` row also carries
  `gapSeconds`, the unobserved span. Carries the checkout revision (commit,
  short commit, branch, dirty flag, changed file count — never file names) and
  whether it matches `expectedRevision`.
- `sample` — cumulative counters, interval deltas, and a lifetime-cumulative
  descendant aggregate for one target.
- `missing` — the port had no listener or the listening PID was gone. The row is
  still written, so a target that disappears never silently shortens the file.
  The last baseline is retained: a same-identity reappearance resumes the delta
  across the gap rather than dropping it, and only an identity change resets it.
- `warning` — e.g. more than one listening PID on a port.
- `error` — a sampling cycle failed; later cycles continue.
- `observer` — the collector's own CPU delta and working set.
- `run_end` — stop reason, event counts, and observer totals.

Counter and delta fields per sample:

| Field | Meaning |
| --- | --- |
| `counters.userModeTime100ns`, `counters.kernelModeTime100ns` | cumulative process CPU time |
| `deltas.cpu.cpuSeconds` | CPU seconds consumed in the interval |
| `deltas.cpu.coreEquivalentPct` | CPU seconds / interval wall seconds × 100 |
| `deltas.cpu.machineCapacityPct` | core-equivalent percent / logical CPU count |
| `counters.workingSetBytes`, `counters.privateBytes` | memory; `privateBytes` follows the recorded `privatePageCountScale` |
| `counters.privatePageCountRaw` | the raw `Win32_Process` value: bytes on `bytes`-scale hosts, pages on `pages`-scale hosts |
| `counters.handleCount`, `counters.threadCount` | handles and threads |
| `deltas.io.ReadTransferCount` etc. | interval byte deltas from process I/O counters |
| `deltas.io.ReadOperationCount` etc. | interval operation deltas |
| `descendants` | `basis: "lifetime-cumulative"` aggregate of observed child processes; the `cumulative*` fields are lifetime counters of currently alive children, not interval deltas |

Files written before this change carry the old field names —
`counters.privatePageCount` (now `privatePageCountRaw`) and unprefixed
`descendants.cpuSeconds`/`descendants.workingSetBytes`/… (now `cumulative*`).
`schemaVersion` stayed `1`, so a reader must key on the field names, not the
version. <!-- VERIFY: wave15-docs-1 -->

CPU percentages come from counter deltas over the same interval, so a PID
restart never produces a delta across identities. The first sample of an
identity has no delta. A resumed identity keeps its baseline, so its first
sample after the missing window reports one delta covering the gap, with the
span recorded as `gapSeconds` on the `resume` row.

Revision metadata describes the checkout when an identity is first observed.
It does not prove which source built the running executable; record build and
startup evidence separately before comparing candidate revisions.

Windows normally reports `PrivatePageCount` in pages, but some builds report
bytes. The collector validates the scale once against the observer's own
process and records `host.privatePageCountScale` (`pages` or `bytes`) in
`run_start`; `counters.privateBytes` follows that recorded scale.
`host.privatePageCountScaleConfident` is `false` when neither candidate was
within 20% of the observer's own private bytes, or when the probe could not
read the observer's own counters (it threw, returned no instance, or reported
zero private bytes) — so `false` does not prove the comparison ran. In either
case the recorded `pages` scale is an assumption and `privateBytes` should be
treated as unverified rather than silently trusted.
<!-- VERIFY: wave15-docs-2 -->

## Summarizing

```powershell
node scripts/summarize-runtime-observations.mjs C:/obs/run-2026-10-29
node scripts/summarize-runtime-observations.mjs C:/obs/run-2026-10-29 --json
node scripts/summarize-runtime-observations.mjs --self-test
```

A directory expands to its `*.ndjson` files. The summary groups by
`label/role`, then by process identity (an epoch), and reports duration and
coverage, CPU seconds total, mean and peak core-equivalent and machine-capacity
percent, mean and peak working set and private bytes, and cumulative I/O
deltas. It marks runs without `run_end` as incomplete, counts missing rows,
restarts, resumes and I/O counter resets, flags sampling gaps, ignores
unrecognized record kinds without calling them malformed, and never combines
percentages across epochs. `coverage` is the share of nominal sampling slots
that were filled — a cadence-drift measure, not proof of continuous
measurement; a resumed epoch can still show a gap and a delta that spans it.
I/O intervals whose counters reset are skipped and counted as `ioResets`
rather than added as zero. A final line that is still being written is ignored
rather than treated as malformed.

## Measurement limits

- I/O counters are **process** I/O (`Win32_Process` read/write/other transfer
  and operation counts), not physical disk I/O. They include file, network, and
  device I/O issued by the process, and buffered or cached I/O accounting can
  differ from storage-level counters.
- Metrics cover the listening process only. Descendants are a sampled,
  depth-limited (4) and node-limited (128) aggregate; a cap sets
  `descendants.capped`. The `cumulative*` fields are **lifetime** counters of
  currently alive children, not interval deltas, and the summarizer does not
  aggregate them. Children that start and exit between samples are not
  observed, so descendant figures are not an exhaustive accounting of CLI
  children.
- CIM sampling has its own cost; the `observer` rows report the collector's CPU
  and working set. On the implementation host, one recorded 3 462-cycle,
  4-target run at a 5 s interval spent **480.3125 observer CPU s** against
  **286.782 CPU s** summed across the measured targets (1.67×), peaked at
  **207.2 MiB** working set, and sustained **2.61% of one core** (480.3125 s
  over ~18 384 s wall). These are a mid-run snapshot of an **incomplete** run
  (no `run_end`; the file was still appending) taken by the **pre-fix**
  collector, before the per-cycle child-index rebuild shipped, so they
  overstate what the current tool costs; the run has not been re-measured.
  That is a live-host observation, not a controlled
  benchmark: co-resident observer load inflates absolute target CPU, so compare
  ratios and read the observer rows rather than treating raw seconds as ground
  truth. Cost scales with host process count; keep the interval at 2 s or
  longer. <!-- VERIFY: wave15-docs-3 -->
- A process that never listens on its port is recorded as `missing`; use the
  port the environment actually serves on.
- Revision metadata is read at each identity event only; edits inside a live
  process are not re-read per sample.
- These observations are for comparable baseline trends. Controlled benchmarks
  belong to the later performance phase.
