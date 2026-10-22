param([string]$AppDirectory = $PSScriptRoot, [string]$PythonExecutable = '', [string]$CacheRoot = '')
$ErrorActionPreference = 'Stop'
$appDirectory = (Resolve-Path -LiteralPath $AppDirectory).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Missing .NET Framework C# compiler' }
$bundled = Join-Path $appDirectory 'runtime\python\python.exe'
if (Test-Path -LiteralPath $bundled) { $PythonExecutable = $bundled }
elseif (-not $PythonExecutable) { $PythonExecutable = (& python -c "import sys;print(sys.executable)").Trim() }
if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Missing Python executable' }
$webview = Join-Path $appDirectory 'runtime\webview2'
if (-not $CacheRoot) { $CacheRoot = Join-Path $env:TEMP 'YuYiAI-build-cache' }
& $PythonExecutable -X utf8 (Join-Path $appDirectory 'packaging\prepare_webview.py') --destination $webview --cache $CacheRoot
if ($LASTEXITCODE -ne 0) { throw 'WebView2 preparation failed' }
$productName = ([char]0x8BED).ToString() + ([char]0x5FC6).ToString() + 'AI'
$output = Join-Path $appDirectory ($productName + '.exe')
$runtimePathFile = Join-Path $appDirectory 'desktop-python-path.txt'
try {
    [IO.File]::WriteAllText($runtimePathFile, $pythonExecutable, [Text.UTF8Encoding]::new($false))
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll "/reference:$webview\Microsoft.Web.WebView2.Core.dll" "/reference:$webview\Microsoft.Web.WebView2.WinForms.dll" "/resource:$runtimePathFile,python-path" "/out:$output" "$appDirectory\desktop-launcher.cs"
    if ($LASTEXITCODE -ne 0) { throw 'Desktop EXE compilation failed' }
} finally {
    if (Test-Path -LiteralPath $runtimePathFile) { Remove-Item -LiteralPath $runtimePathFile }
}
Write-Output $output
