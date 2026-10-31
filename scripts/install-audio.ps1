$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$python=Join-Path $root '.venv\Scripts\python.exe'
try {
    if (-not (Test-Path -LiteralPath $python)) { throw 'Run Setup-Windows.cmd first.' }
    & $python -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
    if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
    & $python -m pip install -r music-workbench/requirements-separation.txt
    if ($LASTEXITCODE -ne 0) { throw 'Demucs installation failed.' }
    & $python -X utf8 -c "import torch,torchaudio; from demucs.pretrained import get_model; print('Audio tools ready; model weights download on first use.')"
    if ($LASTEXITCODE -ne 0) { throw 'Audio tools import check failed.' }
    exit 0
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
