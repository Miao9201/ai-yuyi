param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [string]$PythonExecutable = 'python',
    [string]$NodeExecutable = '',
    [string]$CacheRoot = ''
)
$ErrorActionPreference = 'Stop'
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node -ErrorAction Stop).Source }
& $PythonExecutable (Join-Path $PSScriptRoot 'build_portable.py') --source $SourceRoot --output $OutputRoot --node $NodeExecutable --cache $CacheRoot
if ($LASTEXITCODE -ne 0) { throw '便携版/安装包构建失败，请查看上面的错误。' }
