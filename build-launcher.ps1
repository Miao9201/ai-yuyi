param([string]$AppDirectory = $PSScriptRoot, [string]$PythonExecutable = '')
$ErrorActionPreference = 'Stop'
$appDirectory = (Resolve-Path -LiteralPath $AppDirectory).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '未找到本机 .NET Framework C# 编译器' }
$bundled = Join-Path $appDirectory 'runtime\python\pythonw.exe'
if (Test-Path -LiteralPath $bundled) { $PythonExecutable = $bundled }
elseif (-not $PythonExecutable) { $PythonExecutable = (& python -c "import sys;from pathlib import Path;print(Path(sys.executable).with_name('pythonw.exe'))").Trim() }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw '未找到本机 pythonw.exe' }
$runtimePathFile = Join-Path $appDirectory 'desktop-python-path.txt'
try {
    [IO.File]::WriteAllText($runtimePathFile, $pythonExecutable, [Text.UTF8Encoding]::new($false))
    & $compiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll "/resource:$runtimePathFile,python-path" "/out:$appDirectory\AI语忆.exe" "$appDirectory\desktop-launcher.cs"
    if ($LASTEXITCODE -ne 0) { throw 'EXE 编译失败' }
} finally {
    if (Test-Path -LiteralPath $runtimePathFile) { Remove-Item -LiteralPath $runtimePathFile }
}
Write-Output (Join-Path $appDirectory 'AI语忆.exe')
