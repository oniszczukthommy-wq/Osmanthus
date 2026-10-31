param([ValidateSet('setup','start','stop','doctor')][string]$Action='start')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$python=Join-Path $root '.venv\Scripts\python.exe'
function Run-Python([string[]]$Arguments) {
    & $script:python @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Python command failed (exit $LASTEXITCODE)." }
}
try {
    if ($Action -eq 'setup') {
        foreach ($tool in @('node','ffmpeg','ffprobe','curl.exe')) {
            if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
                throw "Missing $tool. Install prerequisites listed in docs/WINDOWS.md, reopen this window, then retry."
            }
        }
        $nodeVersion=(& node --version).TrimStart('v').Split('.')[0]
        if ([int]$nodeVersion -lt 22) { throw 'Node.js 22 or newer is required.' }
        if (-not (Test-Path -LiteralPath $python)) {
            $base=$null
            if (Get-Command py.exe -ErrorAction SilentlyContinue) {
                $candidate=(& py.exe -3.12 -c 'import sys; print(sys.executable)' 2>$null)
                if ($LASTEXITCODE -eq 0) { $base=$candidate }
            }
            if (-not $base -and (Get-Command python.exe -ErrorAction SilentlyContinue)) {
                $candidate=(& python.exe -c 'import sys; assert sys.version_info[:2] in [(3,11),(3,12)]; print(sys.executable)' 2>$null)
                if ($LASTEXITCODE -eq 0) { $base=$candidate }
            }
            if (-not $base) { throw 'Install Python 3.12 (64-bit), then retry. See docs/WINDOWS.md.' }
            & $base -X utf8 -m venv (Join-Path $root '.venv')
            if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
        }
        Run-Python @('-m','pip','install','-r','music-workbench/requirements-core.txt')
        if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
        Run-Python @('-X','utf8','music-workbench/tools/osmanthus_web.py','doctor')
        Write-Host 'Setup complete. Add your own API keys to .env, then run Start-Osmanthus.cmd.'
    } else {
        if (-not (Test-Path -LiteralPath $python)) { throw 'Run Setup-Windows.cmd first.' }
        $arguments=@('-X','utf8','music-workbench/tools/osmanthus_web.py',$Action)
        if ($Action -eq 'start') { $arguments+='--open' }
        Run-Python $arguments
    }
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
