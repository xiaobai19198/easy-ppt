param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$EasyPptArgs
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $PSCommandPath
$skillDir = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $skillDir '.runtime'
$cacheFile = Join-Path $runtimeDir 'node-path.txt'
$mainScript = Join-Path $scriptDir 'easy-ppt.mjs'

function Find-NodeRuntime {
  if (Test-Path -LiteralPath $cacheFile -PathType Leaf) {
    $cached = (Get-Content -LiteralPath $cacheFile -Raw -Encoding UTF8).Trim()
    if ($cached -and (Test-Path -LiteralPath $cached -PathType Leaf)) { return $cached }
  }

  $homeDir = [Environment]::GetFolderPath('UserProfile')
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($env:CODEX_NODE_PATH) { $candidates.Add($env:CODEX_NODE_PATH) }
  $candidates.Add((Join-Path $homeDir '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
  $candidates.Add((Join-Path $homeDir '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\override\node.exe'))
  $candidates.Add((Join-Path $homeDir '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\node.exe'))

  $runtimeRoot = Join-Path $homeDir '.cache\codex-runtimes'
  if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
    foreach ($runtime in (Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
      $candidates.Add((Join-Path $runtime.FullName 'dependencies\node\bin\node.exe'))
      $candidates.Add((Join-Path $runtime.FullName 'dependencies\bin\override\node.exe'))
      $candidates.Add((Join-Path $runtime.FullName 'dependencies\bin\fallback\node.exe'))
    }
  }

  $systemNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($systemNode) { $candidates.Add($systemNode.Source) }

  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $version = & $candidate --version 2>$null
      if ($LASTEXITCODE -eq 0 -and $version -match '^v\d+') {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        [IO.File]::WriteAllText($cacheFile, ([IO.Path]::GetFullPath($candidate) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        return [IO.Path]::GetFullPath($candidate)
      }
    } catch {}
  }
  return $null
}

$nodeRuntime = Find-NodeRuntime
if (-not $nodeRuntime) {
  $messageBytes = [Convert]::FromBase64String('5b2T5YmN546v5aKD57y65bCRIE5vZGUuanPvvIxFYXN5IFBQVCDml6Dms5Xnu6fnu63ov5DooYzjgILor7fliY3lvoAgaHR0cHM6Ly9ub2RlanMub3JnIOS4i+i9veW5tuWuieijhSBOb2RlLmpz77yM54S25ZCO5paw5bu65Lya6K+d6YeN5paw5L2/55SoIEVhc3kgUFBU44CC')
  [Console]::Error.WriteLine([Text.Encoding]::UTF8.GetString($messageBytes))
  exit 127
}

if ($EasyPptArgs.Count -eq 1 -and $EasyPptArgs[0] -eq '--runtime-check') {
  [Console]::Out.WriteLine((@{ ok = $true; node = $nodeRuntime; cached = $true } | ConvertTo-Json -Compress))
  exit 0
}

& $nodeRuntime $mainScript @EasyPptArgs
exit $LASTEXITCODE
