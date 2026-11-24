param(
  [int]$Port = 9229,
  [switch]$Watch,
  [string]$ScriptPath,
  [string]$ProcessName = "ChatGPT"
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
if (-not $ScriptPath) { $ScriptPath = Join-Path $here "skin.js" }
$logPath = Join-Path $here "skin-host.log"

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $msg
  try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}

function Get-SkinSource() {
  if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "skin.js not found: $ScriptPath" }
  return [System.IO.File]::ReadAllText($ScriptPath, [System.Text.Encoding]::UTF8)
}

# The CDP port is the only signal the host actually needs: Codex is up and
# debuggable. Watching it costs one refused TCP connect (~0.5ms) per tick and
# follows the process lifetime for free, where enumerating processes to find
# ChatGPT.exe costs ~7ms and does not tell us whether injection is possible yet.
function Test-CdpPort([int]$timeoutMs) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $t = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $t.AsyncWaitHandle.WaitOne($timeoutMs)) { return $false }
    $c.EndConnect($t)
    return $true
  } catch {
    return $false
  } finally {
    $c.Close()
  }
}

function Find-PageTarget() {
  if (-not (Test-CdpPort 300)) { return $null }
  try {
    $list = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + "/json/list") -TimeoutSec 3
  } catch { return $null }
  foreach ($t in @($list)) {
    if ($t.type -eq "page" -and $t.url -like "app://-*" -and $t.webSocketDebuggerUrl) { return $t }
  }
  return $null
}

function Wait-PageTarget([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $t = Find-PageTarget
    if ($t) { return $t }
    Start-Sleep -Milliseconds 2000
  }
  return $null
}

class CdpSession {
  [System.Net.WebSockets.ClientWebSocket]$Ws
  [int]$NextId = 0

  [void] Connect([string]$url) {
    $this.Ws = New-Object System.Net.WebSockets.ClientWebSocket
    $this.Ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(15)
    $ct = [System.Threading.CancellationToken]::None
    $task = $this.Ws.ConnectAsync([Uri]$url, $ct)
    if (-not $task.Wait(10000)) { try { $this.Ws.Abort() } catch { }; throw "connect timeout" }
    if ($this.Ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { throw ("connect failed: " + $this.Ws.State) }
  }

  # A timeout must really cancel the send: abandoning an unfinished WebSocket
  # operation makes the next Send/Receive throw. Cancel, then kill the socket.
  [string] SendRaw([string]$json) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $seg = New-Object "System.ArraySegment[byte]" -ArgumentList @(, $bytes)
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter(20000)
    try {
      $t = $this.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token)
      $t.Wait()
    } catch {
      try { $this.Ws.Abort() } catch { }
      throw ("send failed: " + $_.Exception.Message)
    } finally {
      $cts.Dispose()
    }
    return $json
  }

  # Same rule as SendRaw: a cancelled receive leaves the socket unusable, so
  # abort it and let the caller re-attach instead of polling a dead connection.
  [string] ReceiveMessage([int]$timeoutMs) {
    $sb = New-Object System.Text.StringBuilder
    while ($true) {
      $buf = New-Object byte[] 65536
      $seg = New-Object "System.ArraySegment[byte]" -ArgumentList @(, $buf)
      $cts = New-Object System.Threading.CancellationTokenSource
      $cts.CancelAfter($timeoutMs)
      try {
        $task = $this.Ws.ReceiveAsync($seg, $cts.Token)
        $task.Wait()
        $res = $task.Result
      } catch {
        try { $this.Ws.Abort() } catch { }
        throw ("receive failed: " + $_.Exception.Message)
      } finally {
        $cts.Dispose()
      }
      if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
      if ($res.EndOfMessage) { break }
    }
    return $sb.ToString()
  }

  [string] Send([string]$method, $params) {
    $this.NextId = $this.NextId + 1
    $id = $this.NextId
    $payload = @{ id = $id; method = $method }
    if ($null -ne $params) { $payload["params"] = $params }
    $json = $payload | ConvertTo-Json -Depth 12 -Compress
    [void]$this.SendRaw($json)
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      $raw = $this.ReceiveMessage(5000)
      if ($null -eq $raw) { continue }
      # Prefix match instead of a JSON parse: this runs on every CDP round trip,
      # and ConvertFrom-Json on every response was the bulk of a probe's cost.
      if ($raw.StartsWith('{"id":' + $id + ',')) { return $raw }
    }
    throw ("CDP timeout: " + $method)
  }

  [void] Close() {
    try { if ($this.Ws) { $this.Ws.Dispose() } } catch { }
  }
}

function Invoke-Evaluate($cdp, [string]$expression) {
  $params = @{ expression = $expression; returnByValue = $true; awaitPromise = $true }
  $raw = $cdp.Send("Runtime.evaluate", $params)
  $obj = $raw | ConvertFrom-Json
  if ($obj.PSObject.Properties.Name -contains "error") { throw ("CDP error: " + $raw) }
  if ($obj.result.exceptionDetails) { throw ("JS error: " + ($obj.result.exceptionDetails.text)) }
  return $obj.result.result
}

# The panel pushes an update request through a CDP binding, so the host never
# polls: it blocks on the socket and wakes only when the button is pressed.
$BindingName = "codexSkinUpdate"

function Get-BindingPayload([string]$raw) {
  try {
    $msg = $raw | ConvertFrom-Json
    if ($msg.method -eq "Runtime.bindingCalled" -and $msg.params.name -eq $BindingName) {
      return [string]$msg.params.payload
    }
  } catch { }
  return $null
}

function Short-Hash([string]$h) {
  if ($h -and $h.Length -ge 7) { return $h.Substring(0, 7) }
  return $h
}

# The renderer cannot read a private repo, so the button only drops a token in
# localStorage; the real check is a git fetch here, with the machine's credentials.
function Set-UpdateState($cdp, [string]$token, $state) {
  $state["for"] = $token
  if (-not $state.ContainsKey("at")) { $state["at"] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $json = $state | ConvertTo-Json -Compress
  # Ship as a JS single-quoted literal: only backslashes and single quotes need escaping.
  $lit = $json.Replace("\", "\\").Replace("'", "\'")
  [void](Invoke-Evaluate $cdp ("localStorage.setItem('codexSkin.update.state', '" + $lit + "')"))
}

function Invoke-SkinUpdate($cdp, [string]$token) {
  $state = @{ ok = $false; updated = $false; version = $null; message = ""; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $env:GIT_TERMINAL_PROMPT = "0"
    $oldHead = (& git -C $here rev-parse HEAD 2>&1) -join " "
    if ($LASTEXITCODE -ne 0) { $state.message = "not a git checkout: $oldHead"; return (Set-UpdateState $cdp $token $state) }
    $fetch = (& git -C $here fetch --quiet origin 2>&1) -join " "
    if ($LASTEXITCODE -ne 0) { $state.message = "fetch failed: $fetch"; return (Set-UpdateState $cdp $token $state) }
    $newHead = (& git -C $here rev-parse origin/main 2>&1) -join " "
    if ($LASTEXITCODE -ne 0) { $state.message = "no origin/main: $newHead"; return (Set-UpdateState $cdp $token $state) }
    if ($newHead.Trim() -eq $oldHead.Trim()) {
      $state.ok = $true
      $state.message = ("up to date at " + (Short-Hash $oldHead))
      return (Set-UpdateState $cdp $token $state)
    }
    $merge = (& git -C $here merge --ff-only origin/main 2>&1) -join " "
    if ($LASTEXITCODE -ne 0) { $state.message = "merge failed: $merge"; return (Set-UpdateState $cdp $token $state) }
    Write-Log ("update pulled " + (Short-Hash $oldHead) + ".." + (Short-Hash $newHead))
    $changed = (& git -C $here diff --name-only $oldHead.Trim() $newHead.Trim() 2>&1) -join " "
    $hostChanged = $changed -match "skin-host\.ps1"
    $source = Get-SkinSource
    try {
      [void](Invoke-Evaluate $cdp $source)
      $probe = Invoke-Evaluate $cdp "JSON.stringify({v:(window.__codexSkinRuntime||{}).version||null})"
      $state.ok = $true
      $state.updated = $true
      $state.version = ($probe.value | ConvertFrom-Json).v
      if ($hostChanged) { $state.message = "hot-swapped; skin-host.ps1 changed, run install.ps1" }
      else { $state.message = "hot-swapped" }
      Write-Log ("update applied v=" + $state.version)
    } catch {
      # A broken payload would take the panel with it, so put the old file back.
      $state.message = ("inject failed, rolled back: " + $_.Exception.Message)
      Write-Log ("update inject failed: " + $_.Exception.Message)
      [void](& git -C $here checkout $oldHead.Trim() -- skin.js 2>&1)
      try { [void](Invoke-Evaluate $cdp (Get-SkinSource)) } catch { }
    }
  } catch {
    $state.message = ("update error: " + $_.Exception.Message)
    Write-Log ("update error: " + $_.Exception.Message)
  } finally {
    $ErrorActionPreference = $prev
  }
  return (Set-UpdateState $cdp $token $state)
}

function Attach-AndInject() {
  $target = Wait-PageTarget 90
  if (-not $target) { Write-Log "page target not found"; return $null }
  $cdp = New-Object CdpSession
  try {
    $cdp.Connect($target.webSocketDebuggerUrl)
    Write-Log ("attached: " + $target.id)
    # No Page.enable / Runtime.enable on purpose: they flood the socket with
    # console and navigation events (hundreds per second), and the idle loop now
    # blocks on that socket. addBinding and evaluate work without them.
    [void]$cdp.Send("Runtime.addBinding", @{ name = $BindingName })
    $source = Get-SkinSource
    $reg = $cdp.Send("Page.addScriptToEvaluateOnNewDocument", @{ source = $source })
    Write-Log ("auto-inject registered id=" + ($reg | ConvertFrom-Json).result.identifier)
    [void](Invoke-Evaluate $cdp $source)
    $probe = Invoke-Evaluate $cdp "JSON.stringify({v:(window.__codexSkinRuntime||{}).version||null})"
    Write-Log ("injected, probe=" + $probe.value)
    return $cdp
  } catch {
    # Close the half-open session too, or -Watch leaks one socket every 3 s.
    $cdp.Close()
    throw
  }
}

$mutexName = "CodexSkinHost-" + $ProcessName
$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  # The one-minute task lands here every single time; a log line here buries the
  # real events (139 of 209 lines were this one). Keep it on the console only.
  Write-Host "another host already running, exit"
  exit 0
}

# Held open (FileShare.None) for the life of this process, so the launcher can
# tell "already running" from "gone" with a file open instead of starting a
# second powershell.exe. A full PS 5.1 start costs ~0.9s of CPU, and the task
# fires on a timer, so that spawn used to land as a hitch every time it ran.
$pidLock = $null
try {
  $pidLockPath = Join-Path $here "skin-host.pid"
  $pidLock = [System.IO.File]::Open($pidLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $pidBytes = [System.Text.Encoding]::ASCII.GetBytes([string]$PID)
  $pidLock.SetLength(0)
  $pidLock.Write($pidBytes, 0, $pidBytes.Length)
  $pidLock.Flush()
} catch {
  $pidLock = $null
}

Write-Log ("start port=" + $Port + " script=" + $ScriptPath + " process=" + $ProcessName + " watch=" + $Watch)
if (-not (Test-CdpPort 300)) { Write-Log "waiting for Codex CDP port" }

while ($true) {
  # Sit on the port instead of on the process list (resident mode must not burn
  # the 90s attach timeout). Polling a refused connect is ~0.5ms, so this loop
  # idles at a few hundredths of a percent of one core.
  if (-not (Test-CdpPort 300)) {
    if (-not $Watch) { Write-Log "Codex CDP port not up, host exits"; break }
    while (-not (Test-CdpPort 300)) { Start-Sleep -Seconds 3 }
    Write-Log "Codex CDP port up"
  }

  $cdp = $null
  try {
    $cdp = Attach-AndInject
  } catch {
    Write-Log ("attach failed: " + $_.Exception.Message)
  }

  if (-not $cdp) {
    if ($Watch) { Start-Sleep -Seconds 3; continue }
    Write-Log "no attach, host exits"
    break
  }

  # Blocked on the socket until the panel asks for something. No timer, no probe:
  # an idle host costs nothing, and a dropped socket (Codex exited) ends the wait.
  while ($true) {
    $raw = $null
    try {
      $raw = $cdp.ReceiveMessage(86400000)
    } catch {
      Write-Log ("receive failed: " + $_.Exception.Message)
      break
    }
    if ($null -eq $raw) { Write-Log "cdp closed, re-attach"; break }
    $token = Get-BindingPayload $raw
    if ($token) {
      Write-Log ("update requested by panel (" + $token + ")")
      Invoke-SkinUpdate $cdp $token
    }
    if ($cdp.Ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { Write-Log "cdp closed, re-attach"; break }
  }

  if (-not (Test-CdpPort 300)) { Write-Log "Codex exited" } else { Write-Log "re-attaching" }
  $cdp.Close()
  if (-not $Watch) { break }
  Start-Sleep -Seconds 1
}

if ($pidLock) { try { $pidLock.Dispose() } catch { } }
Write-Log "host stopped"