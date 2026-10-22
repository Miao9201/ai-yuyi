param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [string]$PythonExecutable = 'python',
    [string]$NodeExecutable = '',
    [string]$CacheRoot = ''
)
$ErrorActionPreference = 'Stop'
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node -ErrorAction Stop).Source }
$packageArguments = @('-X', 'utf8', (Join-Path $PSScriptRoot 'build_portable.py'), '--source', $SourceRoot, '--output', $OutputRoot, '--node', $NodeExecutable)
if ($CacheRoot) { $packageArguments += @('--cache', $CacheRoot) }
& $PythonExecutable @packageArguments
if ($LASTEXITCODE -ne 0) { throw 'AIYuYi package build failed. See the error above.' }
