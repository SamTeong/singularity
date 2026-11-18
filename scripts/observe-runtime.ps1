#!/usr/bin/env pwsh
# Read-only external resource collector for the Singularity main and Rust
# candidate environments. Samples per-process counters through CIM and the TCP
# listener table; it never touches the servers, never reads their command
# lines, and never signals them.
#
#   pwsh scripts/observe-runtime.ps1 -ManifestPath C:/obs/targets.json `
#        -OutputDirectory C:/obs/run1 -IntervalSeconds 2 -DurationSeconds 60
#
# Output is one NDJSON file per run. See docs/runtime-observability.md.

[CmdletBinding()]
param(
  [string]$ManifestPath,
  [string]$OutputDirectory,
  [double]$IntervalSeconds = 2,
  [double]$DurationSeconds = 60,
  [string]$StopFile,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DescendantDepthLimit = 4
$script:DescendantNodeLimit = 128
$script:Sequence = 0
$script:PageSizeBytes = 4096
# Windows reports Win32_Process.PrivatePageCount in pages by contract, but
# some builds return the byte count instead. The scale is validated once at
# run start against the observer's own process and recorded in run_start.
$script:PrivatePageCountIsBytes = $false
$script:PrivatePageCountScaleConfident = $false
$script:Stats = @{ missing = 0; restarts = 0; resumes = 0; warnings = 0; errors = 0; cycles = 0 }

function Get-PrivateBytes([double]$PrivatePageCount) {
  if ($script:PrivatePageCountIsBytes) { return $PrivatePageCount }
  return $PrivatePageCount * $script:PageSizeBytes
}

function Get-PropertyValue($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($prop) { return $prop.Value }
  return $null
}

function Read-Manifest([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "manifest not found: $Path" }
  $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  try { $doc = $raw | ConvertFrom-Json -Depth 20 -ErrorAction Stop }
  catch { throw "manifest is not valid JSON: $($_.Exception.Message)" }
  $targets = @(Get-PropertyValue $doc 'targets')
  if ($targets.Count -eq 0) { throw "manifest must contain a non-empty 'targets' array" }

  $seenKeys = [System.Collections.Generic.HashSet[string]]::new()
  $seenPorts = [System.Collections.Generic.HashSet[int]]::new()
  $validated = foreach ($t in $targets) {
    $label = [string](Get-PropertyValue $t 'label')
    $role = [string](Get-PropertyValue $t 'role')
    $portText = [string](Get-PropertyValue $t 'port')
    $checkoutPath = [string](Get-PropertyValue $t 'checkoutPath')
    foreach ($pair in @(@('label', $label), @('role', $role), @('port', $portText), @('checkoutPath', $checkoutPath))) {
      if ([string]::IsNullOrWhiteSpace($pair[1])) { throw "target is missing required field '$($pair[0])'" }
    }
    if ($role -notin @('backend', 'frontend')) { throw "target '$label' has invalid role '$role' (expected backend or frontend)" }
    $port = 0
    if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
      throw "target '$label' has invalid port '$portText'"
    }
    if (-not [System.IO.Path]::IsPathRooted($checkoutPath)) {
      throw "target '$label' checkoutPath must be absolute: $checkoutPath"
    }
    $key = "$label|$role"
    if (-not $seenKeys.Add($key)) { throw "duplicate target label/role: $key" }
    if (-not $seenPorts.Add($port)) { throw "duplicate target port: $port" }
    $expectedRevision = Get-PropertyValue $t 'expectedRevision'
    if ($null -ne $expectedRevision) { $expectedRevision = [string]$expectedRevision }
    [ordered]@{
      label            = $label
      role             = $role
      port             = $port
      checkoutPath     = $checkoutPath
      expectedRevision = $expectedRevision
    }
  }
  , @($validated)
}

function Get-RevisionInfo([string]$CheckoutPath) {
  $info = [ordered]@{
    commit = $null; shortCommit = $null; branch = $null
    dirty = $null; changedFileCount = $null; error = $null
  }
  try {
    $commit = @(& git -C $CheckoutPath rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $commit.Count -gt 0) {
      $info.commit = [string]$commit[0]
      $info.shortCommit = $info.commit.Substring(0, [math]::Min(12, $info.commit.Length))
    }
    $branch = @(& git -C $CheckoutPath rev-parse --abbrev-ref HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $branch.Count -gt 0) { $info.branch = [string]$branch[0] }
    # Only the count is recorded; file names never reach the output file.
    $status = @(& git -C $CheckoutPath status --porcelain 2>$null)
    if ($LASTEXITCODE -eq 0) {
      $info.changedFileCount = $status.Count
      $info.dirty = $status.Count -gt 0
    }
  } catch {
    $info.error = $_.Exception.Message
  }
  $info
}

function Get-CounterSnapshot($Process) {
  [ordered]@{
    UserModeTime        = [double]$Process.UserModeTime
    KernelModeTime      = [double]$Process.KernelModeTime
    WorkingSetSize      = [double]$Process.WorkingSetSize
    PrivatePageCount    = [double]$Process.PrivatePageCount
    HandleCount         = [int]$Process.HandleCount
    ThreadCount         = [int]$Process.ThreadCount
    ReadTransferCount   = [double]$Process.ReadTransferCount
    WriteTransferCount  = [double]$Process.WriteTransferCount
    OtherTransferCount  = [double]$Process.OtherTransferCount
    ReadOperationCount  = [double]$Process.ReadOperationCount
    WriteOperationCount = [double]$Process.WriteOperationCount
    OtherOperationCount = [double]$Process.OtherOperationCount
  }
}

function Get-CpuDelta {
  param($Previous, $Current, [double]$ElapsedSeconds, [int]$LogicalCpuCount)
  if ($null -eq $Previous -or $null -eq $Current -or $ElapsedSeconds -le 0) { return $null }
  $userDelta = [double]$Current.UserModeTime - [double]$Previous.UserModeTime
  $kernelDelta = [double]$Current.KernelModeTime - [double]$Previous.KernelModeTime
  if ($userDelta -lt 0 -or $kernelDelta -lt 0) {
    return [ordered]@{ cpuSeconds = $null; coreEquivalentPct = $null; machineCapacityPct = $null; counterReset = $true }
  }
  $cpuSeconds = ($userDelta + $kernelDelta) / 1e7
  $corePct = ($cpuSeconds / $ElapsedSeconds) * 100
  [ordered]@{
    cpuSeconds         = [math]::Round($cpuSeconds, 6)
    coreEquivalentPct  = [math]::Round($corePct, 3)
    machineCapacityPct = [math]::Round($corePct / [math]::Max(1, $LogicalCpuCount), 3)
    counterReset       = $false
  }
}

function Get-IoDelta {
  param($Previous, $Current)
  if ($null -eq $Previous -or $null -eq $Current) { return $null }
  $fields = @(
    'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount',
    'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount'
  )
  $out = [ordered]@{}
  $reset = $false
  foreach ($field in $fields) {
    $delta = [double]$Current.$field - [double]$Previous.$field
    if ($delta -lt 0) { $reset = $true; $out[$field] = $null }
    else { $out[$field] = [double]$delta }
  }
  $out['counterReset'] = $reset
  $out
}

function Resolve-TargetIdentity {
  param($PreviousState, [int]$TargetPid, $Process, [bool]$WasMissing = $false)
  $creationDate = $Process.CreationDate.ToUniversalTime()
  $creationKey = $creationDate.Ticks
  $identity = "$TargetPid@$creationKey"
  $transition = 'start'
  if ($null -ne $PreviousState -and (Get-PropertyValue $PreviousState 'Identity') -eq $identity) {
    # Same identity seen again after a missing window: resume, never a restart.
    $transition = if ($WasMissing) { 'resume' } else { 'steady' }
  } elseif ($null -ne $PreviousState) {
    $transition = 'restart'
  }
  [ordered]@{
    transition   = $transition
    identity     = $identity
    pid          = $TargetPid
    creationDate = $creationDate.ToString('o')
    creationKey  = $creationKey
  }
}

function Get-ChildProcessIndex([hashtable]$ProcessByPid) {
  $children = @{}
  foreach ($proc in $ProcessByPid.Values) {
    $parentPid = [int]$proc.ParentProcessId
    if (-not $children.ContainsKey($parentPid)) {
      $children[$parentPid] = [System.Collections.Generic.List[object]]::new()
    }
    $children[$parentPid].Add($proc)
  }
  $children
}

function Get-DescendantAggregate {
  param([hashtable]$ProcessByPid, [hashtable]$ChildIndex, [int]$RootPid, [int]$MaxDepth, [int]$MaxNodes)
  # The child index is built once per cycle and shared across targets; building
  # it here is the convenience path for direct callers (self-test).
  $children = if ($null -ne $ChildIndex) { $ChildIndex } else { Get-ChildProcessIndex -ProcessByPid $ProcessByPid }
  # All values are lifetime cumulative counters of the currently alive children,
  # not interval deltas; the cumulative* names keep them from being summed as
  # deltas. The summarizer intentionally does not aggregate them.
  $aggregate = [ordered]@{
    basis                    = 'lifetime-cumulative'
    observedNodes            = 0
    capped                   = $false
    cumulativeCpuSeconds     = 0.0
    cumulativeWorkingSetBytes = 0.0
    cumulativePrivateBytes   = 0.0
    cumulativeReadBytes      = 0.0
    cumulativeWriteBytes     = 0.0
    cumulativeOtherBytes     = 0.0
    cumulativeReadOperations = 0.0
    cumulativeWriteOperations = 0.0
    cumulativeOtherOperations = 0.0
  }
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue([pscustomobject]@{ Pid = $RootPid; Depth = 0 })
  $visited = [System.Collections.Generic.HashSet[int]]::new()
  [void]$visited.Add($RootPid)
  while ($queue.Count -gt 0) {
    $node = $queue.Dequeue()
    if ($node.Depth -ge $MaxDepth) { continue }
    if (-not $children.ContainsKey($node.Pid)) { continue }
    foreach ($child in $children[$node.Pid]) {
      $childPid = [int]$child.ProcessId
      if (-not $visited.Add($childPid)) { continue }
      if ($aggregate.observedNodes -ge $MaxNodes) { $aggregate.capped = $true; break }
      $aggregate.observedNodes++
      $aggregate.cumulativeCpuSeconds += ([double]$child.UserModeTime + [double]$child.KernelModeTime) / 1e7
      $aggregate.cumulativeWorkingSetBytes += [double]$child.WorkingSetSize
      $aggregate.cumulativePrivateBytes += Get-PrivateBytes ([double]$child.PrivatePageCount)
      $aggregate.cumulativeReadBytes += [double]$child.ReadTransferCount
      $aggregate.cumulativeWriteBytes += [double]$child.WriteTransferCount
      $aggregate.cumulativeOtherBytes += [double]$child.OtherTransferCount
      $aggregate.cumulativeReadOperations += [double]$child.ReadOperationCount
      $aggregate.cumulativeWriteOperations += [double]$child.WriteOperationCount
      $aggregate.cumulativeOtherOperations += [double]$child.OtherOperationCount
      $queue.Enqueue([pscustomobject]@{ Pid = $childPid; Depth = $node.Depth + 1 })
    }
    if ($aggregate.capped) { break }
  }
  foreach ($key in @('cumulativeCpuSeconds', 'cumulativeWorkingSetBytes', 'cumulativePrivateBytes', 'cumulativeReadBytes', 'cumulativeWriteBytes', 'cumulativeOtherBytes')) {
    $aggregate[$key] = [math]::Round($aggregate[$key], 3)
  }
  $aggregate
}

function Write-JsonLine([System.IO.TextWriter]$Writer, $Object) {
  $Writer.WriteLine(($Object | ConvertTo-Json -Compress -Depth 12))
}

function Invoke-SampleCycle {
  param(
    [object[]]$Targets,
    [hashtable]$State,
    [System.IO.TextWriter]$Writer,
    [hashtable]$ProcByPid,
    [hashtable]$ListenersByPort,
    [double]$Elapsed,
    [string]$RunId,
    [int]$LogicalCpuCount
  )
  # Built once per cycle: rebuilding the parent index per target multiplied the
  # process-snapshot cost by the target count.
  $childIndex = Get-ChildProcessIndex -ProcessByPid $ProcByPid
  foreach ($target in $Targets) {
    $label = [string]$target.label
    $role = [string]$target.role
    $port = [int]$target.port
    $stateKey = "$label|$role"
    $sequence = $script:Sequence++
    $timestampUtc = [DateTime]::UtcNow.ToString('o')
    $roundedElapsed = [math]::Round($Elapsed, 3)

    $pids = @()
    if ($ListenersByPort.ContainsKey($port)) { $pids = @(@($ListenersByPort[$port]) | Sort-Object) }
    if ($pids.Count -eq 0) {
      $script:Stats.missing++
      # Retain the baseline: a same-identity reappearance resumes the delta
      # across the gap; only an identity change resets it.
      if ($null -ne $State[$stateKey]) { $State[$stateKey]['MissingSinceElapsed'] = $Elapsed }
      Write-JsonLine $Writer ([ordered]@{
          kind = 'missing'; schemaVersion = 1; runId = $RunId; sequence = $sequence
          timestampUtc = $timestampUtc; elapsedSeconds = $roundedElapsed
          label = $label; role = $role; port = $port
          reason = 'no-listener'; process = $null
        })
      continue
    }
    if ($pids.Count -gt 1) {
      $script:Stats.warnings++
      Write-JsonLine $Writer ([ordered]@{
          kind = 'warning'; schemaVersion = 1; runId = $RunId
          timestampUtc = [DateTime]::UtcNow.ToString('o'); elapsedSeconds = [math]::Round($Elapsed, 3)
          label = $label; role = $role; port = $port
          reason = 'multiple-listeners'; pids = @($pids)
        })
    }

    $procPid = [int]$pids[0]
    $proc = $ProcByPid[$procPid]
    if ($null -eq $proc) {
      $script:Stats.missing++
      if ($null -ne $State[$stateKey]) { $State[$stateKey]['MissingSinceElapsed'] = $Elapsed }
      Write-JsonLine $Writer ([ordered]@{
          kind = 'missing'; schemaVersion = 1; runId = $RunId; sequence = $sequence
          timestampUtc = $timestampUtc; elapsedSeconds = $roundedElapsed
          label = $label; role = $role; port = $port
          reason = 'process-gone'; process = [ordered]@{ pid = $procPid }
        })
      continue
    }

    $previous = $State[$stateKey]
    $wasMissing = $null -ne (Get-PropertyValue $previous 'MissingSinceElapsed')
    $resolved = Resolve-TargetIdentity -PreviousState (Get-PropertyValue $previous 'IdentityState') -TargetPid $procPid -Process $proc -WasMissing $wasMissing
    if ($resolved.transition -ne 'steady') {
      if ($resolved.transition -eq 'restart') { $script:Stats.restarts++ }
      elseif ($resolved.transition -eq 'resume') { $script:Stats.resumes++ }
      $revision = Get-RevisionInfo ([string]$target.checkoutPath)
      $expected = [string]$target.expectedRevision
      $revisionMatches = $null
      if (-not [string]::IsNullOrWhiteSpace($expected) -and $revision.commit) {
        $revisionMatches = $revision.commit.StartsWith($expected, [System.StringComparison]::OrdinalIgnoreCase)
      }
      $gapSeconds = $null
      if ($resolved.transition -eq 'resume' -and $null -ne (Get-PropertyValue $previous 'Elapsed')) {
        $gapSeconds = [math]::Round($Elapsed - [double](Get-PropertyValue $previous 'Elapsed'), 3)
      }
      Write-JsonLine $Writer ([ordered]@{
          kind = 'identity'; schemaVersion = 1; runId = $RunId
          timestampUtc = [DateTime]::UtcNow.ToString('o'); elapsedSeconds = [math]::Round($Elapsed, 3)
          label = $label; role = $role; port = $port
          reason = $resolved.transition
          gapSeconds = $gapSeconds
          process = [ordered]@{ pid = $procPid; creationDate = $resolved.creationDate; identity = $resolved.identity }
          revision = $revision
          expectedRevision = if ([string]::IsNullOrWhiteSpace($expected)) { $null } else { $expected }
          revisionMatches = $revisionMatches
        })
      if ($resolved.transition -eq 'resume') {
        # Keep the counters and elapsed baseline so the next delta spans the
        # missing window instead of being dropped.
        $previous.Remove('MissingSinceElapsed')
      } else {
        $previous = [ordered]@{
          IdentityState = $resolved
          Counters      = $null
          Elapsed       = $null
        }
        $State[$stateKey] = $previous
      }
    }

    $elapsedSeconds = 0.0
    if ($null -ne (Get-PropertyValue $previous 'Elapsed')) { $elapsedSeconds = $Elapsed - [double]$previous.Elapsed }
    $cpuDelta = Get-CpuDelta -Previous (Get-PropertyValue $previous 'Counters') -Current $proc -ElapsedSeconds $elapsedSeconds -LogicalCpuCount $LogicalCpuCount
    $ioDelta = Get-IoDelta -Previous (Get-PropertyValue $previous 'Counters') -Current $proc
    $descendants = Get-DescendantAggregate -ProcessByPid $ProcByPid -ChildIndex $childIndex -RootPid $procPid -MaxDepth $script:DescendantDepthLimit -MaxNodes $script:DescendantNodeLimit

    $counters = Get-CounterSnapshot $proc
    Write-JsonLine $Writer ([ordered]@{
        kind = 'sample'; schemaVersion = 1; runId = $RunId; sequence = $sequence
        timestampUtc = $timestampUtc; elapsedSeconds = $roundedElapsed
        label = $label; role = $role; port = $port
        process = [ordered]@{ pid = $procPid; creationDate = $resolved.creationDate; identity = $resolved.identity }
        counters = [ordered]@{
          userModeTime100ns   = $counters.UserModeTime
          kernelModeTime100ns = $counters.KernelModeTime
          workingSetBytes     = $counters.WorkingSetSize
          privatePageCountRaw = $counters.PrivatePageCount
          privateBytes        = Get-PrivateBytes ([double]$counters.PrivatePageCount)
          handleCount         = $counters.HandleCount
          threadCount         = $counters.ThreadCount
          readTransferCount   = $counters.ReadTransferCount
          writeTransferCount  = $counters.WriteTransferCount
          otherTransferCount  = $counters.OtherTransferCount
          readOperationCount  = $counters.ReadOperationCount
          writeOperationCount = $counters.WriteOperationCount
          otherOperationCount = $counters.OtherOperationCount
        }
        deltas = [ordered]@{
          intervalSeconds = [math]::Round($elapsedSeconds, 3)
          cpu             = $cpuDelta
          io              = $ioDelta
        }
        descendants = $descendants
        sampling = [ordered]@{
          descendantDepthLimit = $script:DescendantDepthLimit
          descendantNodeLimit  = $script:DescendantNodeLimit
          shortLivedChildren   = 'Children that start and exit between samples are not observed.'
          ioScope              = 'Win32_Process process I/O counters; not physical disk I/O.'
        }
      })

    $previous.Counters = $counters
    $previous.Elapsed = $Elapsed
  }
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Label)
  $actualText = if ($null -eq $Actual) { '<null>' } else { [string]$Actual }
  $expectedText = if ($null -eq $Expected) { '<null>' } else { [string]$Expected }
  if ($Actual -is [double] -and $Expected -is [double]) {
    if ([math]::Abs($Actual - $Expected) -le 1e-6) { return }
  } elseif ($actualText -ceq $expectedText) { return }
  throw "self-test failed: $Label expected $expectedText, got $actualText"
}

function Invoke-SelfTest {
  # Counter math: 25,000,000 - 10,000,000 user and 15,000,000 - 5,000,000
  # kernel are 2.5 s over 2 s across 4 logical CPUs.
  $previous = [pscustomobject]@{ UserModeTime = [double]10000000; KernelModeTime = [double]5000000 }
  $current = [pscustomobject]@{ UserModeTime = [double]25000000; KernelModeTime = [double]15000000 }
  $cpu = Get-CpuDelta -Previous $previous -Current $current -ElapsedSeconds 2 -LogicalCpuCount 4
  Assert-Equal $cpu.cpuSeconds 2.5 'cpu seconds'
  Assert-Equal $cpu.coreEquivalentPct 125.0 'core-equivalent percent'
  Assert-Equal $cpu.machineCapacityPct 31.25 'machine-capacity percent'
  Assert-Equal $cpu.counterReset $false 'no counter reset'
  Assert-Equal (Get-CpuDelta -Previous $null -Current $current -ElapsedSeconds 2 -LogicalCpuCount 4) $null 'baseline delta is null'
  $reset = Get-CpuDelta -Previous $current -Current $previous -ElapsedSeconds 2 -LogicalCpuCount 4
  Assert-Equal $reset.counterReset $true 'negative delta flagged as reset'
  Assert-Equal $reset.cpuSeconds $null 'reset delta has no value'

  $ioPrevious = [pscustomobject]@{
    ReadTransferCount = [double]1000; WriteTransferCount = [double]2000; OtherTransferCount = [double]0
    ReadOperationCount = [double]10; WriteOperationCount = [double]20; OtherOperationCount = [double]0
  }
  $ioCurrent = [pscustomobject]@{
    ReadTransferCount = [double]1500; WriteTransferCount = [double]2600; OtherTransferCount = [double]0
    ReadOperationCount = [double]13; WriteOperationCount = [double]24; OtherOperationCount = [double]0
  }
  $io = Get-IoDelta -Previous $ioPrevious -Current $ioCurrent
  Assert-Equal $io.ReadTransferCount 500.0 'read byte delta'
  Assert-Equal $io.WriteOperationCount 4.0 'write operation delta'
  Assert-Equal $io.counterReset $false 'io no reset'
  Assert-Equal (Get-IoDelta -Previous $ioCurrent -Current $ioPrevious).counterReset $true 'io reset flagged'

  # PID reuse: same PID with a different creation time is a restart, never a
  # counter delta.
  $creationA = [datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
  $creationB = [datetime]::new(2026, 1, 1, 1, 0, 0, [DateTimeKind]::Utc)
  $first = Resolve-TargetIdentity -PreviousState $null -TargetPid 100 -Process ([pscustomobject]@{ CreationDate = $creationA })
  Assert-Equal $first.transition 'start' 'first identity is start'
  $steady = Resolve-TargetIdentity -PreviousState $first -TargetPid 100 -Process ([pscustomobject]@{ CreationDate = $creationA })
  Assert-Equal $steady.transition 'steady' 'same identity is steady'
  $reused = Resolve-TargetIdentity -PreviousState $first -TargetPid 100 -Process ([pscustomobject]@{ CreationDate = $creationB })
  Assert-Equal $reused.transition 'restart' 'PID reuse is restart'
  Assert-Equal ($reused.identity -ne $first.identity) $true 'PID reuse changes identity'

  # Descendant bounds: a 5-deep chain stops at depth 4; a 200-child fan-out
  # stops at 128 nodes and is marked capped.
  $processByPid = @{}
  for ($processId = 1; $processId -le 6; $processId++) {
    $processByPid[$processId] = [pscustomobject]@{
      ProcessId = $processId; ParentProcessId = $processId - 1
      UserModeTime = [double]0; KernelModeTime = [double]0
      WorkingSetSize = [double]0; PrivatePageCount = [double]0
      ReadTransferCount = [double]0; WriteTransferCount = [double]0; OtherTransferCount = [double]0
      ReadOperationCount = [double]0; WriteOperationCount = [double]0; OtherOperationCount = [double]0
    }
  }
  $script:PageSizeBytes = 4096
  $chain = Get-DescendantAggregate -ProcessByPid $processByPid -RootPid 1 -MaxDepth 4 -MaxNodes 128
  Assert-Equal $chain.observedNodes 4 'depth limit counts four levels'
  Assert-Equal $chain.capped $false 'depth-limited walk is not node-capped'

  $fanOut = @{}
  $fanOut[1] = $processByPid[1]
  for ($processId = 2; $processId -le 201; $processId++) {
    $fanOut[$processId] = [pscustomobject]@{
      ProcessId = $processId; ParentProcessId = 1
      UserModeTime = [double]0; KernelModeTime = [double]0
      WorkingSetSize = [double]0; PrivatePageCount = [double]0
      ReadTransferCount = [double]0; WriteTransferCount = [double]0; OtherTransferCount = [double]0
      ReadOperationCount = [double]0; WriteOperationCount = [double]0; OtherOperationCount = [double]0
    }
  }
  $capped = Get-DescendantAggregate -ProcessByPid $fanOut -RootPid 1 -MaxDepth 4 -MaxNodes 128
  Assert-Equal $capped.observedNodes 128 'node limit stops at 128'
  Assert-Equal $capped.capped $true 'node limit is marked capped'
  Assert-Equal $capped.basis 'lifetime-cumulative' 'descendant aggregate is labeled cumulative'

  # Missing-window behavior: a missing row must keep the baseline, a
  # same-identity reappearance resumes and the next delta spans the gap, and a
  # changed identity is a restart with no cross-identity delta.
  $missingTargets = @([pscustomobject]@{
      label = 'main'; role = 'backend'; port = 4317
      checkoutPath = 'C:/__selftest_no_checkout__'; expectedRevision = $null
    })
  $missingState = @{}
  $missingWriter = [System.IO.StringWriter]::new()
  $listeners = @{ 4317 = [System.Collections.Generic.HashSet[int]]::new() }
  [void]$listeners[4317].Add(100)
  $observed = [pscustomobject]@{
    ProcessId = 100; ParentProcessId = 1; CreationDate = $creationA
    UserModeTime = [double]10000000; KernelModeTime = [double]0
    WorkingSetSize = [double]0; PrivatePageCount = [double]0
    HandleCount = 1; ThreadCount = 1
    ReadTransferCount = [double]0; WriteTransferCount = [double]0; OtherTransferCount = [double]0
    ReadOperationCount = [double]0; WriteOperationCount = [double]0; OtherOperationCount = [double]0
  }
  $observedByPid = @{ 100 = $observed }
  $cycle = @{
    Targets = $missingTargets; State = $missingState; Writer = $missingWriter
    ProcByPid = $observedByPid; ListenersByPort = $listeners
    RunId = 'selftest'; LogicalCpuCount = 4
  }
  Invoke-SampleCycle @cycle -Elapsed 0
  $observed.UserModeTime = [double]30000000
  Invoke-SampleCycle @cycle -Elapsed 2
  $cycle.ListenersByPort = @{}
  Invoke-SampleCycle @cycle -Elapsed 4
  Assert-Equal ($null -ne $missingState['main|backend']) $true 'missing rows retain the baseline'
  Assert-Equal $missingState['main|backend']['MissingSinceElapsed'] 4.0 'missing marker records the gap start'
  $observed.UserModeTime = [double]45000000
  $cycle.ListenersByPort = $listeners
  Invoke-SampleCycle @cycle -Elapsed 10
  $observedByPid[100] = [pscustomobject]@{
    ProcessId = 100; ParentProcessId = 1; CreationDate = $creationB
    UserModeTime = [double]50000000; KernelModeTime = [double]0
    WorkingSetSize = [double]0; PrivatePageCount = [double]0
    HandleCount = 1; ThreadCount = 1
    ReadTransferCount = [double]0; WriteTransferCount = [double]0; OtherTransferCount = [double]0
    ReadOperationCount = [double]0; WriteOperationCount = [double]0; OtherOperationCount = [double]0
  }
  Invoke-SampleCycle @cycle -Elapsed 12

  $rows = @($missingWriter.ToString() -split "\r?\n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
  $identityReasons = @($rows | Where-Object { $_.kind -eq 'identity' } | ForEach-Object { $_.reason })
  Assert-Equal ($identityReasons -join ',') 'start,resume,restart' 'identity transitions across a missing window'
  $resumeRow = @($rows | Where-Object { $_.kind -eq 'identity' -and $_.reason -eq 'resume' })[0]
  Assert-Equal $resumeRow.gapSeconds 8.0 'resume records the unobserved gap'
  $resumeSample = @($rows | Where-Object { $_.kind -eq 'sample' -and $_.elapsedSeconds -eq 10 })[0]
  Assert-Equal $resumeSample.deltas.intervalSeconds 8.0 'resumed delta spans the gap'
  Assert-Equal $resumeSample.deltas.cpu.cpuSeconds 1.5 'resumed delta measures CPU across the gap'
  Assert-Equal $resumeSample.deltas.cpu.coreEquivalentPct 18.75 'resumed interval percent uses the gap duration'
  $restartSample = @($rows | Where-Object { $_.kind -eq 'sample' -and $_.elapsedSeconds -eq 12 })[0]
  Assert-Equal $restartSample.deltas.cpu $null 'restart sample has no cross-identity delta'
  Assert-Equal @($rows | Where-Object { $_.kind -eq 'sample' }).Count 4 'missing cycle emits no sample row'

  Write-Output "self-test: all checks passed"
}

if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ManifestPath)) { throw '-ManifestPath is required' }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw '-OutputDirectory is required' }
if ($IntervalSeconds -le 0) { throw '-IntervalSeconds must be greater than 0' }
if ($DurationSeconds -lt 0) { throw '-DurationSeconds must be 0 (run until stopped) or greater' }

# Manifest validation happens before the output file exists, so a malformed
# manifest never leaves a partial run behind.
$targets = Read-Manifest $ManifestPath
$script:PageSizeBytes = 4096
try { $script:PageSizeBytes = [int][System.Environment]::SystemPageSize } catch { }
if (-not $script:PageSizeBytes) { $script:PageSizeBytes = 4096 }

[void][System.IO.Directory]::CreateDirectory($OutputDirectory)
$runId = ([guid]::NewGuid().ToString('N')).Substring(0, 12)
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$outputPath = Join-Path $OutputDirectory "runtime-observations-$stamp-$runId.ndjson"

$logicalCpuCount = [Environment]::ProcessorCount
$writer = [System.IO.StreamWriter]::new($outputPath, $true, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$state = @{}
$ownProcess = Get-Process -Id $PID
try {
  $ownCim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -Property ProcessId, PrivatePageCount -ErrorAction Stop
  $referencePrivateBytes = [double]$ownProcess.PrivateMemorySize64
  if ($null -ne $ownCim -and $referencePrivateBytes -gt 0) {
    # The two reads happen moments apart, so compare candidate scales rather
    # than requiring exact equality.
    $cimValue = [double]$ownCim.PrivatePageCount
    $bytesError = [math]::Abs($cimValue - $referencePrivateBytes) / $referencePrivateBytes
    $pagesError = [math]::Abs(($cimValue * $script:PageSizeBytes) - $referencePrivateBytes) / $referencePrivateBytes
    if ([math]::Min($bytesError, $pagesError) -lt 0.2) {
      $script:PrivatePageCountIsBytes = $bytesError -lt $pagesError
      $script:PrivatePageCountScaleConfident = $true
    }
  }
} catch { }
$ownCpuStart = if ($null -ne $ownProcess.CPU) { [double]$ownProcess.CPU } else { 0.0 }
$previousOwnCpu = $ownCpuStart
$peakOwnWorkingSet = [double]$ownProcess.WorkingSet64

Write-JsonLine $writer ([ordered]@{
    kind = 'run_start'; schemaVersion = 1; runId = $runId
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    tool = [ordered]@{ name = 'observe-runtime.ps1'; version = 1 }
    host = [ordered]@{
      logicalCpuCount = $logicalCpuCount
      pageSizeBytes   = $script:PageSizeBytes
      privatePageCountScale = if ($script:PrivatePageCountIsBytes) { 'bytes' } else { 'pages' }
      # False means neither candidate scale was within 20% of the observer's
      # own private bytes, so privateBytes carries the 'pages' assumption.
      privatePageCountScaleConfident = $script:PrivatePageCountScaleConfident
      os              = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    }
    arguments = [ordered]@{
      intervalSeconds = $IntervalSeconds
      durationSeconds = $DurationSeconds
      stopFile        = if ([string]::IsNullOrWhiteSpace($StopFile)) { $null } else { $StopFile }
      outputPath      = $outputPath
    }
    limits = [ordered]@{
      descendantDepthLimit = $script:DescendantDepthLimit
      descendantNodeLimit  = $script:DescendantNodeLimit
      ioScope              = 'Win32_Process process I/O counters; not physical disk I/O.'
      childScope           = 'Descendant metrics are sampled observations, not an exhaustive accounting of CLI children.'
    }
    targets = @($targets)
  })

$stopReason = 'duration'
$durationLimit = if ($DurationSeconds -gt 0) { $DurationSeconds } else { [double]::PositiveInfinity }

try {
  while ($true) {
    if (-not [string]::IsNullOrWhiteSpace($StopFile) -and (Test-Path -LiteralPath $StopFile)) {
      $stopReason = 'stop-file'; break
    }
    $cycleStart = $stopwatch.Elapsed.TotalSeconds
    $script:Stats.cycles++
    try {
      $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
      $listenersByPort = @{}
      foreach ($listener in $listeners) {
        $port = [int]$listener.LocalPort
        if (-not $listenersByPort.ContainsKey($port)) {
          $listenersByPort[$port] = [System.Collections.Generic.HashSet[int]]::new()
        }
        [void]$listenersByPort[$port].Add([int]$listener.OwningProcess)
      }
      $processProperties = @(
        'ProcessId', 'ParentProcessId', 'CreationDate', 'UserModeTime', 'KernelModeTime',
        'WorkingSetSize', 'PrivatePageCount', 'HandleCount', 'ThreadCount',
        'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount',
        'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount'
      )
      $processes = @(Get-CimInstance -ClassName Win32_Process -Property $processProperties -ErrorAction Stop)
      $procByPid = @{}
      foreach ($proc in $processes) { $procByPid[[int]$proc.ProcessId] = $proc }

      Invoke-SampleCycle -Targets $targets -State $state -Writer $writer `
        -ProcByPid $procByPid -ListenersByPort $listenersByPort `
        -Elapsed $stopwatch.Elapsed.TotalSeconds -RunId $runId `
        -LogicalCpuCount $logicalCpuCount

      $ownProcess = Get-Process -Id $PID
      $ownCpu = if ($null -ne $ownProcess.CPU) { [double]$ownProcess.CPU } else { $previousOwnCpu }
      $ownWorkingSet = [double]$ownProcess.WorkingSet64
      if ($ownWorkingSet -gt $peakOwnWorkingSet) { $peakOwnWorkingSet = $ownWorkingSet }
      Write-JsonLine $writer ([ordered]@{
          kind = 'observer'; schemaVersion = 1; runId = $runId
          timestampUtc = [DateTime]::UtcNow.ToString('o')
          elapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
          cpuSeconds = [math]::Round($ownCpu - $previousOwnCpu, 6)
          workingSetBytes = $ownWorkingSet
          handleCount = [int]$ownProcess.HandleCount
        })
      $previousOwnCpu = $ownCpu
    } catch {
      $script:Stats.errors++
      Write-JsonLine $writer ([ordered]@{
          kind = 'error'; schemaVersion = 1; runId = $runId
          timestampUtc = [DateTime]::UtcNow.ToString('o')
          elapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
          message = $_.Exception.Message
        })
    }

    if ($stopwatch.Elapsed.TotalSeconds -ge $durationLimit) { $stopReason = 'duration'; break }
    if (-not [string]::IsNullOrWhiteSpace($StopFile) -and (Test-Path -LiteralPath $StopFile)) {
      $stopReason = 'stop-file'; break
    }
    $remaining = $IntervalSeconds - ($stopwatch.Elapsed.TotalSeconds - $cycleStart)
    Start-Sleep -Milliseconds ([math]::Max(0, [math]::Round($remaining * 1000)))
  }
} finally {
  $totalOwnCpu = 0.0
  try { $totalOwnCpu = [double](Get-Process -Id $PID).CPU - $ownCpuStart } catch { }
  Write-JsonLine $writer ([ordered]@{
      kind = 'run_end'; schemaVersion = 1; runId = $runId
      timestampUtc = [DateTime]::UtcNow.ToString('o')
      elapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
      stopReason = $stopReason
      sampleCycles = $script:Stats.cycles
      events = [ordered]@{
        missing = $script:Stats.missing; restarts = $script:Stats.restarts
        resumes = $script:Stats.resumes
        warnings = $script:Stats.warnings; errors = $script:Stats.errors
      }
      observer = [ordered]@{
        totalCpuSeconds = [math]::Round($totalOwnCpu, 6)
        peakWorkingSetBytes = $peakOwnWorkingSet
      }
    })
  $writer.Dispose()
  Write-Output "observations: $outputPath"
}
