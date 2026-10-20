# Wanderpage installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/buildproven/wanderpage/main/install.ps1 | iex
# Pass a project folder or flags with:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/buildproven/wanderpage/main/install.ps1))) my-trips
#
# Uses the Node.js 24+ already on your PATH. If there is none, it downloads the official Node.js build, checks its SHA-256 against
# nodejs.org's published list, and keeps it in %USERPROFILE%\.wanderpage (override with WANDERPAGE_HOME). It never edits your PATH,
# the registry, or any system setting: the private Node is put in front of PATH for the one command it starts, and PATH is put back after.
# `irm | iex` runs a script in the user's own session, so everything below runs in a child scope (`& { } @args`): the error preference,
# variables, and functions disappear when it ends, and the process environment variables it sets are restored in `finally`.
# Windows is not tested yet (see the README); this script has not been run on Windows.

& {
  $ErrorActionPreference = 'Stop'
  $NodeMajor = 24
  $NodeChannel = "latest-v$NodeMajor.x"

  function Test-NodeSuitable([string]$BinDir) {
    $node = if ($BinDir) { Join-Path $BinDir 'node.exe' } else { 'node' }
    $npx = if ($BinDir) { Join-Path $BinDir 'npx.cmd' } else { 'npx' }
    if ($BinDir -and -not ((Test-Path $node) -and (Test-Path $npx))) { return $false }
    if (-not $BinDir -and -not ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npx -ErrorAction SilentlyContinue))) { return $false }
    $version = & $node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.') { return $false }
    return [int]$Matches[1] -ge $NodeMajor
  }

  function Install-PrivateNode([string]$Home_) {
    $cpu = switch ($env:PROCESSOR_ARCHITECTURE) {
      'AMD64' { 'x64' }
      'ARM64' { 'arm64' }
      default { throw "Unsupported processor $($env:PROCESSOR_ARCHITECTURE)." }
    }
    $baseUrl = if ($env:WANDERPAGE_NODE_BASE_URL) { $env:WANDERPAGE_NODE_BASE_URL } else { 'https://nodejs.org/dist' }
    $base = "$baseUrl/$NodeChannel"
    $work = Join-Path ([IO.Path]::GetTempPath()) ("wanderpage-install-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    $sums = Join-Path $work 'SHASUMS256.txt'
    $zip = $null
    try {
      Write-Host "No Node.js $NodeMajor or newer found. Downloading a private copy into $Home_ (nothing else on your computer changes)..."
      Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -OutFile $sums
      $line = Get-Content $sums | Where-Object { $_ -match " node-v[0-9.]+-win-$cpu\.zip$" } | Select-Object -First 1
      if (-not $line) { throw "nodejs.org lists no Node.js build for win-$cpu." }
      $expected = ($line -split '\s+')[0].ToLowerInvariant()
      $archive = ($line -split '\s+')[-1]
      $name = $archive -replace '\.zip$', ''

      $zip = Join-Path $work $archive
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $zip
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
      if ($actual -ne $expected) { throw 'The downloaded Node.js did not match its published checksum, so it was not installed.' }

      $destination = Join-Path $Home_ $name
      if (Test-Path $destination) { throw "$destination already exists but is not a working Node.js. Delete that folder and run the installer again." }
      New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
      Expand-Archive -Path $zip -DestinationPath $work
      Move-Item -Path (Join-Path $work $name) -Destination $destination
      return $destination
    }
    finally {
      # Only the two files and the then-empty folder we made are removed; nothing is deleted recursively.
      Remove-Item -Force -ErrorAction SilentlyContinue $sums
      if ($zip) { Remove-Item -Force -ErrorAction SilentlyContinue $zip }
      Remove-Item -ErrorAction SilentlyContinue $work
    }
  }

  function Find-PrivateNode([string]$Home_) {
    if (-not (Test-Path $Home_)) { return $null }
    foreach ($dir in Get-ChildItem -Path $Home_ -Directory -Filter 'node-v*-win-*') {
      if (Test-NodeSuitable $dir.FullName) { return $dir.FullName }
    }
    return $null
  }

  function Start-Wanderpage([string[]]$Forwarded) {
    $wanderpageHome = if ($env:WANDERPAGE_HOME) { $env:WANDERPAGE_HOME } else { Join-Path $env:USERPROFILE '.wanderpage' }
    if (Test-NodeSuitable '') {
      & npx.cmd --yes '@buildproven/wanderpage' @Forwarded
      return
    }
    $bin = Find-PrivateNode $wanderpageHome
    if (-not $bin) { $bin = Install-PrivateNode $wanderpageHome }
    Write-Host "Starting Wanderpage with the Node.js in $bin"
    # Process-scope only, and only while npx runs: never the user or machine PATH, and the session's values come back afterwards.
    $saved = @{}
    foreach ($name in 'PATH', 'npm_config_cache', 'npm_config_update_notifier') { $saved[$name] = (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value }
    try {
      $env:PATH = "$bin;$env:PATH"
      $env:npm_config_cache = Join-Path $wanderpageHome 'npm-cache'
      $env:npm_config_update_notifier = 'false'
      & npx.cmd --yes '@buildproven/wanderpage' @Forwarded
    }
    finally {
      foreach ($name in $saved.Keys) {
        if ($null -eq $saved[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item "Env:$name" $saved[$name] }
      }
    }
  }

  # No `exit` anywhere: under `irm | iex` it would close the user's PowerShell window.
  try { Start-Wanderpage $args }
  catch {
    Write-Host "`nWanderpage could not install: $($_.Exception.Message)" -ForegroundColor Red
    $global:LASTEXITCODE = 1
  }
} @args
