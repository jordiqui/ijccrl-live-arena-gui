# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Jorge Ruiz Centelles
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateCount(2, 128)]
  [string[]]$Engines,

  [Parameter(Mandatory = $true)]
  [string]$OpeningsPgn,

  [int]$Port = 3012,
  [int]$BaseMs = 600000,
  [int]$IncrementMs = 2000,
  [int]$Threads = 1,
  [int]$HashMb = 64,
  [string]$SyzygyPath = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (($Engines.Count % 2) -ne 0) {
  throw "The engine count must be even. Received $($Engines.Count)."
}

foreach ($engine in $Engines) {
  if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
    throw "Engine executable not found: $engine"
  }
}

if (-not (Test-Path -LiteralPath $OpeningsPgn -PathType Leaf)) {
  throw "Opening PGN not found: $OpeningsPgn"
}

$env:IJCCRL_ENGINES = ($Engines -join ";")
$env:IJCCRL_OPENINGS_PGN = $OpeningsPgn
$env:PORT = [string]$Port
$env:IJCCRL_BASE_MS = [string]$BaseMs
$env:IJCCRL_INC_MS = [string]$IncrementMs
$env:IJCCRL_THREADS = [string]$Threads
$env:IJCCRL_HASH_MB = [string]$HashMb

if ([string]::IsNullOrWhiteSpace($SyzygyPath)) {
  Remove-Item Env:\IJCCRL_SYZYGY_PATH -ErrorAction SilentlyContinue
} else {
  if (-not (Test-Path -LiteralPath $SyzygyPath -PathType Container)) {
    throw "Syzygy directory not found: $SyzygyPath"
  }
  $env:IJCCRL_SYZYGY_PATH = $SyzygyPath
}

& node server.js
exit $LASTEXITCODE
