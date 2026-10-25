# moyu-editor 一键验证
#   用法： .\verify.ps1          → 静态档：类型检查 + 单元测试（约 30-60 秒）
#          .\verify.ps1 -Full    → 全量档：另外跑 next build + 接口测试
#   退出码： 0 = 全部通过（SKIP 不算失败）   1 = 有失败项
#   完整输出写入 verify.log（UTF-8），控制台只打印结论。
#
#   沙箱说明：dsh 沙箱内子进程管道被封（spawn EPERM），next build 与 api-test 会被拦，
#             脚本自动识别并标 SKIP，不算代码问题；真实打包请在 dsh 外双击 verify.cmd。

param([switch]$Full)

$ErrorActionPreference = 'Continue'
if ($PSScriptRoot) { $root = $PSScriptRoot }
elseif ($MyInvocation.MyCommand.Path) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
else { $root = (Get-Location).Path }

$node = 'C:\Program Files\nodejs\node.exe'
$npm  = 'C:\Program Files\nodejs\npm.cmd'
$log  = Join-Path $root 'verify.log'

$logOk = $true
try {
  Set-Content -Path $log -Value ("moyu-editor 验证  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "  Full=$Full  root=$root") -Encoding utf8
} catch {
  $logOk = $false
  Write-Host '（提示：verify.log 不可写，本次只输出到控制台）' -ForegroundColor Yellow
}
function Write-Log([string]$t) {
  if (-not $logOk) { return }
  try { Add-Content -Path $log -Value $t -Encoding utf8 } catch { $script:logOk = $false }
}

function Invoke-Step([string]$dir, [string]$exe, [string[]]$argv) {
  Push-Location $dir
  try {
    $out = & $exe @argv *>&1 | Out-String
    return @{ code = $LASTEXITCODE; out = $out }
  } finally { Pop-Location }
}

function Test-PortBusy([int]$p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-Path $node)) { Write-Host "找不到 node：$node" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $npm))  { Write-Host "找不到 npm：$npm" -ForegroundColor Red; exit 1 }

$total   = if ($Full) { 4 } else { 2 }
$results = @()
Write-Host ''
Write-Host "== moyu-editor 验证（$(if ($Full) { '全量' } else { '静态' })）==" -ForegroundColor Cyan

# ---------- 1. 类型检查（不 spawn 子进程，沙箱内可跑） ----------
Write-Host "[1/$total] 类型检查 tsc --noEmit ..." -NoNewline
$r1 = Invoke-Step $root $node @('.\node_modules\typescript\bin\tsc', '--noEmit')
Write-Log "`n----- [1] tsc --noEmit (exit=$($r1.code)) -----"; Write-Log $r1.out
if ($r1.code -eq 0) { Write-Host ' PASS' -ForegroundColor Green; $results += 'PASS  类型检查' }
else { Write-Host ' FAIL' -ForegroundColor Red; $results += 'FAIL  类型检查（见 verify.log）' }

# ---------- 2. 单元测试（threads 池：forks 池要 spawn 子进程，沙箱会拦） ----------
Write-Host "[2/$total] 单元测试 vitest run tests/unit ..." -NoNewline
$r2 = Invoke-Step $root $node @('.\node_modules\vitest\vitest.mjs', 'run', 'tests/unit', '--pool=threads')
Write-Log "`n----- [2] vitest unit (exit=$($r2.code)) -----"; Write-Log $r2.out
$m2 = [regex]::Match($r2.out, 'Tests\s+(\d+)\s+passed')
$d2 = if ($m2.Success) { "（$($m2.Groups[1].Value) 通过）" } else { '' }
if ($r2.code -eq 0) {
  Write-Host " PASS$d2" -ForegroundColor Green; $results += "PASS  单元测试$d2"
} elseif ($r2.out -match 'spawn EPERM|EPERM') {
  Write-Host ' SKIP（沙箱拦截子进程，请在 dsh 外跑）' -ForegroundColor Yellow
  $results += 'SKIP  单元测试（沙箱 EPERM，请在 dsh 外双击 verify.cmd）'
} else {
  Write-Host " FAIL$d2" -ForegroundColor Red; $results += "FAIL  单元测试$d2（见 verify.log）"
}

# ---------- 3. 构建（接口测试的前提） ----------
$buildOk = $false
if ($Full) {
  Write-Host "[3/$total] 构建 next build ..." -NoNewline
  $r3 = Invoke-Step $root $npm @('run', 'build')
  Write-Log "`n----- [3] npm run build (exit=$($r3.code)) -----"; Write-Log $r3.out
  if ($r3.code -eq 0) {
    Write-Host ' PASS' -ForegroundColor Green; $results += 'PASS  构建'; $buildOk = $true
  } elseif ($r3.out -match 'spawn EPERM') {
    Write-Host ' SKIP（沙箱拦截子进程，需在 dsh 外跑）' -ForegroundColor Yellow
    $results += 'SKIP  构建（沙箱 spawn EPERM，请在 dsh 外双击 verify.cmd -Full）'
  } else {
    Write-Host ' FAIL' -ForegroundColor Red; $results += 'FAIL  构建（见 verify.log）'
  }
} else {
  $results += 'SKIP  构建（静态档不跑，加 -Full）'
}

# ---------- 4. 接口测试 ----------
if ($Full) {
  $busy = @()
  foreach ($p in 3002, 11499) { if (Test-PortBusy $p) { $busy += $p } }
  Write-Host "[4/$total] 接口测试 (3002 + 假AI 11499) ..." -NoNewline
  if ($busy.Count -gt 0) {
    Write-Host (" 端口被占：" + ($busy -join ',')) -ForegroundColor Red
    $results += ("FAIL  接口测试（端口 " + ($busy -join ',') + " 被占用，先关掉占用进程）")
  } elseif (-not $buildOk) {
    Write-Host ' SKIP（构建未通过，接口测试需要先有 .next）' -ForegroundColor Yellow
    $results += 'SKIP  接口测试（前置构建未通过）'
  } else {
    $r4 = Invoke-Step $root $npm @('run', 'test:api')
    Write-Log "`n----- [4] npm run test:api (exit=$($r4.code)) -----"; Write-Log $r4.out
    if ($r4.code -eq 0) { Write-Host ' PASS' -ForegroundColor Green; $results += 'PASS  接口测试' }
    elseif ($r4.out -match 'spawn EPERM') {
      Write-Host ' SKIP（沙箱拦截子进程，需在 dsh 外跑）' -ForegroundColor Yellow
      $results += 'SKIP  接口测试（沙箱 spawn EPERM，请在 dsh 外双击 verify.cmd -Full）'
    } else {
      Write-Host ' FAIL' -ForegroundColor Red; $results += 'FAIL  接口测试（见 verify.log）'
    }
  }
} else {
  $results += 'SKIP  接口测试（静态档不跑，加 -Full）'
}

# ---------- 收尾 ----------
$failedCnt = @($results | Where-Object { $_ -like 'FAIL*' }).Count
$logTip = if ($logOk) { '  日志：verify.log' } else { '  （verify.log 不可写，只有控制台输出）' }
Write-Log "`n===== 汇总 ====="
$results | ForEach-Object { Write-Log $_ }
Write-Host ''
$results | ForEach-Object { Write-Host "  $_" }
Write-Host ''
if ($failedCnt -gt 0) {
  Write-Host ("结果：FAIL（$failedCnt 项）" + $logTip) -ForegroundColor Red
  exit 1
}
Write-Host ("结果：PASS" + $logTip) -ForegroundColor Green
exit 0
