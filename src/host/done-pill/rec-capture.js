/**
 * dsh-seeker-bot — 录屏窗口抓帧（host 半身，done-pill 模块）。
 *
 * 为什么需要它：窗口录制原来是「整屏流 + 按窗口矩形裁剪」，整屏流拿的是屏幕
 * **合成结果**——窗口被别的窗口挡住时，录到的就是挡在上面的那个窗口（用户
 * 反馈的原始问题）。而 Chromium 自己的窗口捕获在 Electron 33 / Win11 上实测
 * 完全不可用：`getUserMedia({chromeMediaSourceId:'window:<hwnd>:0'})` 与
 * `setDisplayMediaRequestHandler` 两条路对任何窗口源都是
 * `NotReadableError: Could not start video source`（screen: 源正常；禁 WGC、
 * 换 GDI、关 GPU 全试过）。
 *
 * 唯一可用的是 Win32 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)`：它让窗口
 * 自己把内容画到我们的 DC 上，**不经过屏幕合成**，因此天然免遮挡，子窗口
 * （递归 EnumChildWindows 拿到的 hwnd）也能单独抓。实测（8 帧/次）：
 *   - 免遮挡：目标被整屏覆盖时，抓到的仍是目标自身内容（不是覆盖窗）；
 *   - 实时：动画窗口连抓 10 帧，帧间 JPEG 差异 ~59%（不是缓存帧）；
 *   - 吞吐：2576×1456 窗口整尺寸 ~31ms/帧（≈32fps）；缩到 800 宽并掉
 *     插值质量 ~27ms/帧；小窗口 ~6ms/帧。
 *
 * 实现取舍（改前必读）：
 *  1. **常驻 powershell**：`Add-Type` 编译 C# 每次要 300–500ms，逐帧起进程
 *     等于把帧率钉死在 2fps。所以起一个常驻进程，一次性 Add-Type，之后走
 *     stdin/stdout 行协议收 `cap <hwnd> <maxW>`、回 `OK <w> <h> <base64jpeg>`。
 *  2. **base64 是纯 ASCII**：powershell 的 stdout 走系统 OEM 码页（中文机
 *     GBK），二进制/中文直接走 stdout 必花；base64 与码页无关（同 rec-windows
 *     文件头坑 4 的理由）。
 *  3. **JPEG 而非 PNG**：PNG 编码大图 ~100ms/帧，JPEG 质量 80 约 27ms/帧；
 *     帧要经 HTTP 传给 renderer 再解码 → 体积也小一个量级（2K 下 218KB vs
 *     数 MB）。GIF 只有 127 色，JPEG 的有损压缩在量化后几乎不可见。
 *  4. **缩放放 host 做（可选）**：host 侧 HighQualityBicubic 缩放开销不小
 *     （2K→1280 反而比不缩还慢，实测 41ms vs 31ms）。所以默认不缩、原尺寸出，
 *     由 renderer 的 canvas 一次性 drawImage 缩放（那里本来就要画）。maxW
 *     参数保留给「窗口极大 + 要冲帧率」的场景。
 *  5. 空闲 20s 自动退出、进程异常自愈：常驻进程只在录制期间活着，不长期占内存。
 *  6. **抓帧前必须校验窗口状态**（IsWindowVisible / IsIconic / DWM cloaked）。
 *     实测坑：对一个不可见（刚创建未映射，或被 DWM cloaked）的窗口调
 *     PrintWindow，返回的既不是全黑也不是目标内容 —— 实测拿到过**另一个窗口的
 *     画面**（region 验证里抓 hidden 的 A 窗口，得到的是 B 窗口的蓝色内容），
 *     也拿到过全黑。最小化窗口的 GetWindowRect 还会缩成图标矩形（实测
 *     520x420 → 160x28）并画出桌面/任务栏。**录制中途用户最小化窗口**就会
 *     命中这一条：不校验的话 GIF 里会突然混进别人的画面或黑屏，而用户完全
 *     不知道发生了什么。所以校验失败一律回 `ERR window-hidden`，让 client
 *     立刻收尾（保存已录部分）而不是继续录垃圾。
 *
 * 路由：GET /api/dsh-companion/rec-frame?hwnd=<n>&maxW=<n>
 *       → { ok, w, h, data: base64(jpeg) }
 *       → 失败: { ok:false, code, message }，code ∈
 *         window-gone（不是窗口）/ window-hidden（不可见或最小化）/
 *         capture-failed（PrintWindow 或编码失败）
 */
import { spawn } from 'node:child_process'

const ROUTE = '/api/dsh-companion/rec-frame'
/** 单帧抓取超时（ms）：正常 6–45ms，超过就认为 agent 卡死并重启。 */
const CAPTURE_TIMEOUT_MS = 4000
/** 空闲多久后关掉常驻进程（ms）。 */
const IDLE_MS = 20000
/** JPEG 质量（80 是体积/画质的平衡点，见文件头取舍 3）。 */
const JPEG_QUALITY = 80

/**
 * 抓帧 agent 的 PS 脚本（一次性 Add-Type + 行协议循环）。
 * 回执协议：
 *   READY                     启动完成
 *   OK <w> <h> <base64jpeg>   抓帧成功
 *   ERR <code>                失败（code 见文件头路由说明）
 */
const AGENT_PS = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshGrab {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.L, r.T, r.R - r.L, r.B - r.T }; }
  // 0 = 可抓；1 = 不是窗口；2 = 不可见/最小化/被 DWM cloaked（抓了就是垃圾帧）
  public static int State(IntPtr h) {
    if (!IsWindow(h)) return 1;
    if (!IsWindowVisible(h)) return 2;
    if (IsIconic(h)) return 2;
    int cloaked = 0;
    try {
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return 2;
    } catch { }
    return 0;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);

  public static IntPtr FindProc(string procNamesCsv, string taskQuery, out string title, out string matchedProc, out bool isMinimized) {
    title = "";
    matchedProc = "";
    isMinimized = false;
    if (string.IsNullOrEmpty(procNamesCsv)) return IntPtr.Zero;
    string[] procs = procNamesCsv.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
    IntPtr found = IntPtr.Zero;
    IntPtr fallbackFound = IntPtr.Zero;
    IntPtr iconicFound = IntPtr.Zero;
    string t = "";
    string fallbackT = "";
    string iconicT = "";
    string mp = "";
    string fallbackMp = "";
    string iconicMp = "";

    string[] queryKeywords = string.IsNullOrEmpty(taskQuery)
      ? new string[0]
      : taskQuery.ToLower().Split(new char[] { ' ', ',', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);

    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      try {
        var p = System.Diagnostics.Process.GetProcessById((int)pid);
        string name = p.ProcessName;
        for (int i = 0; i < procs.Length; i++) {
          if (string.Equals(name, procs[i].Trim(), StringComparison.OrdinalIgnoreCase)) {
            var sb = new System.Text.StringBuilder(512);
            GetWindowText(h, sb, 512);
            string winTitle = sb.ToString();
            if (winTitle.Length > 0) {
              string lowerTitle = winTitle.ToLower();
              // 关键过滤 1: 排除非任务相关的私人后台常驻页面
              if (lowerTitle.IndexOf("magpie") >= 0) return true;

              // 关键过滤 2: 若指定了任务关键词，必须命中至少一个关键词
              bool matchQuery = true;
              if (queryKeywords.Length > 0) {
                matchQuery = false;
                for (int k = 0; k < queryKeywords.Length; k++) {
                  if (queryKeywords[k].Length >= 2 && lowerTitle.IndexOf(queryKeywords[k]) >= 0) {
                    matchQuery = true;
                    break;
                  }
                }
              }

              if (matchQuery) {
                if (!IsIconic(h)) {
                  found = h;
                  t = winTitle;
                  mp = name;
                  return false;
                } else if (iconicFound == IntPtr.Zero) {
                  iconicFound = h;
                  iconicT = winTitle;
                  iconicMp = name;
                }
              } else if (fallbackFound == IntPtr.Zero && !IsIconic(h)) {
                fallbackFound = h;
                fallbackT = winTitle;
                fallbackMp = name;
              } else if (iconicFound == IntPtr.Zero && IsIconic(h)) {
                iconicFound = h;
                iconicT = winTitle;
                iconicMp = name;
              }
            }
          }
        }
      } catch {}
      return true;
    }, IntPtr.Zero);
    if (found != IntPtr.Zero) {
      title = t;
      matchedProc = mp;
      isMinimized = false;
      return found;
    }
    if (fallbackFound != IntPtr.Zero) {
      title = fallbackT;
      matchedProc = fallbackMp;
      isMinimized = false;
      return fallbackFound;
    }
    if (iconicFound != IntPtr.Zero) {
      title = iconicT;
      matchedProc = iconicMp;
      isMinimized = true;
      return iconicFound;
    }
    return IntPtr.Zero;
  }
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);

  // 查找顶层窗口下的主内容视口子窗口（如 Chrome_RenderWidgetHostHWND，剥除外层浏览器外壳与标题栏）
  public static IntPtr FindContentChild(IntPtr parent) {
    if (parent == IntPtr.Zero) return IntPtr.Zero;
    IntPtr bestChild = IntPtr.Zero;
    int maxArea = 0;
    EnumChildWindows(parent, (ch, l) => {
      if (!IsWindowVisible(ch)) return true;
      var cls = new System.Text.StringBuilder(128);
      GetClassName(ch, cls, 128);
      if (string.Equals(cls.ToString(), "Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase)) {
        RECT r; GetWindowRect(ch, out r);
        int w = r.R - r.L;
        int h = r.B - r.T;
        int area = w * h;
        if (w >= 300 && h >= 200 && area > maxArea) {
          maxArea = area;
          bestChild = ch;
        }
      }
      return true;
    }, IntPtr.Zero);
    return bestChild;
  }
}
'@
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]${JPEG_QUALITY})
$ms = New-Object System.IO.MemoryStream

function DshGrabOne([IntPtr]$h, [int]$maxW) {
  $st = [DshGrab]::State($h)
  if ($st -eq 1) { return 'ERR window-gone' }
  if ($st -eq 2) { return 'ERR window-hidden' }
  $r = [DshGrab]::Rect($h)
  $w = $r[2]; $hh = $r[3]
  if ($w -lt 8 -or $hh -lt 8) { return 'ERR window-gone' }
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [DshGrab]::PrintWindow($h, $hdc, [uint32]2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); return 'ERR capture-failed' }
  $out = $bmp
  if ($maxW -gt 0 -and $w -gt $maxW) {
    $oh = [int]([math]::Round($hh * $maxW / $w))
    if ($oh -lt 8) { $oh = 8 }
    $scaled = New-Object System.Drawing.Bitmap($maxW, $oh)
    $g2 = [System.Drawing.Graphics]::FromImage($scaled)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    $g2.DrawImage($bmp, 0, 0, $maxW, $oh)
    $g2.Dispose(); $bmp.Dispose(); $out = $scaled
  }
  $ms.SetLength(0)
  $out.Save($ms, $jpeg, $ep)
  $ow = $out.Width; $oh2 = $out.Height
  $out.Dispose()
  return 'OK ' + $ow + ' ' + $oh2 + ' ' + [Convert]::ToBase64String($ms.ToArray())
}

function DshGrabProc([string]$procs, [int]$maxW, [string]$query) {
  $title = ""
  $matched = ""
  $isMin = $false
  $h = [DshGrab]::FindProc($procs, $query, [ref]$title, [ref]$matched, [ref]$isMin)
  if ($h -eq [IntPtr]::Zero) { return 'ERR window-not-found' }
  if ($isMin) {
    $tBytes = [System.Text.Encoding]::UTF8.GetBytes($title)
    $tB64 = [Convert]::ToBase64String($tBytes)
    return 'ERR window-hidden ' + $h.ToInt64() + ' ' + $matched + ' ' + $tB64
  }
  # 优先找工作空间/页面内容子视口（Chrome_RenderWidgetHostHWND），剥除浏览器外壳
  $grabTarget = [DshGrab]::FindContentChild($h)
  if ($grabTarget -eq [IntPtr]::Zero) {
    $grabTarget = $h
  }
  $res = DshGrabOne $grabTarget $maxW
  if ($res.StartsWith('OK ')) {
    $tBytes = [System.Text.Encoding]::UTF8.GetBytes($title)
    $tB64 = [Convert]::ToBase64String($tBytes)
    $parts = $res.Split(' ')
    return 'OK ' + $parts[1] + ' ' + $parts[2] + ' ' + $h.ToInt64() + ' ' + $matched + ' ' + $tB64 + ' ' + $parts[3]
  }
  if ($grabTarget -ne $h) {
    $res2 = DshGrabOne $h $maxW
    if ($res2.StartsWith('OK ')) {
      $tBytes = [System.Text.Encoding]::UTF8.GetBytes($title)
      $tB64 = [Convert]::ToBase64String($tBytes)
      $parts2 = $res2.Split(' ')
      return 'OK ' + $parts2[1] + ' ' + $parts2[2] + ' ' + $h.ToInt64() + ' ' + $matched + ' ' + $tB64 + ' ' + $parts2[3]
    }
  }
  return $res
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'quit') { break }
  if ($line.Length -gt 0) {
    $parts = $line.Split(' ')
    if ($parts.Length -ge 3 -and $parts[0] -eq 'cap') {
      $res = DshGrabOne ([IntPtr][int64]$parts[1]) ([int]$parts[2])
      [Console]::Out.WriteLine($res)
      [Console]::Out.Flush()
    } elseif ($parts.Length -ge 3 -and $parts[0] -eq 'capp') {
      $q = ""
      if ($parts.Length -ge 4 -and $parts[3] -ne '') {
        try {
          $q = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[3]))
        } catch {}
      }
      $res = DshGrabProc $parts[1] ([int]$parts[2]) $q
      [Console]::Out.WriteLine($res)
      [Console]::Out.Flush()
    }
  }
}`

/** 常驻 agent 句柄。 */
let agent = null

/** 关掉常驻进程并清空句柄。 */
function killAgent() {
  const cur = agent
  agent = null
  if (cur === null) return
  try { cur.child.stdin.end() } catch { /* 管道已断 */ }
  try { cur.child.kill() } catch { /* 已退出 */ }
  if (cur.idleTimer !== null) clearTimeout(cur.idleTimer)
}

/** 刷新空闲计时（每次抓帧调用）。 */
function touchIdle() {
  if (agent === null) return
  if (agent.idleTimer !== null) clearTimeout(agent.idleTimer)
  agent.idleTimer = setTimeout(() => { killAgent() }, IDLE_MS)
  if (typeof agent.idleTimer.unref === 'function') agent.idleTimer.unref()
}

/**
 * 起常驻 agent。返回 { child, ready: Promise, queue }。
 * ready 在 PS 打印 READY 后兑现——早于它的请求会排队，不会丢帧。
 */
function startAgent() {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(AGENT_PS, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdin.on('error', () => { /* 吞掉 EPIPE 破裂管道异常 */ })

  const state = {
    child,
    idleTimer: null,
    buf: '',
    /** 已发出的请求的兑现函数队列（FIFO：PS 顺序处理，回包也顺序）。 */
    waiters: [],
    /** 进程已死（stdout 关闭/出错）时置位，后续请求直接失败。 */
    dead: false,
    /** 最近一条 stderr（失败时报给用户，便于定位）。 */
    lastErr: '',
    ready: null,
    resolveReady: null,
  }
  state.ready = new Promise((resolve) => { state.resolveReady = resolve })

  child.stdout.on('data', (chunk) => {
    state.buf += chunk
    let idx
    while ((idx = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, idx).replace(/\r$/, '')
      state.buf = state.buf.slice(idx + 1)
      if (line === 'READY') { state.resolveReady(); continue }
      const waiter = state.waiters.shift()
      if (waiter !== undefined) waiter(line)
    }
  })
  child.stderr.on('data', (chunk) => { state.lastErr = String(chunk).slice(0, 500) })
  // stdout 关闭 = agent 退出：把所有等待中的请求一次性失败掉（否则永久挂起）。
  child.stdout.on('close', () => {
    state.dead = true
    state.resolveReady()
    for (const waiter of state.waiters.splice(0)) waiter('ERR agent-exited')
  })
  child.on('error', (error) => {
    state.dead = true
    state.lastErr = String(error && error.message)
    state.resolveReady()
    for (const waiter of state.waiters.splice(0)) waiter('ERR agent-spawn-failed')
  })
  return state
}

/** 取（必要时启动）常驻 agent，并把上一个已死的清掉。 */
function ensureAgent() {
  if (agent !== null && agent.dead) killAgent()
  if (agent === null) agent = startAgent()
  touchIdle()
  return agent
}

/**
 * 抓一帧：`cap <hwnd> <maxW>` → `OK <w> <h> <base64>` / `ERR <code>`。
 * @returns {Promise<{w:number,h:number,data:string}|null>} null = 这一帧失败。
 *   失败原因经 `lastError` 模块变量暴露给路由（结构化 code 给 client 判终结）。
 */
let lastErrorCode = ''
let lastHiddenInfo = null

/** 把 agent 回执里的 code 归一化（未知的一律 capture-failed）。 */
function normalizeErrorCode(line) {
  const code = line.slice(4).trim()
  if (code.startsWith('window-gone')) return 'window-gone'
  if (code.startsWith('window-hidden')) return 'window-hidden'
  if (code.startsWith('window-not-found')) return 'window-not-found'
  if (code.startsWith('capture-failed')) return 'capture-failed'
  if (code.startsWith('not-a-window') || code.startsWith('bad-rect') || code.startsWith('too-small')) return 'window-gone'
  if (code.startsWith('printwindow-failed')) return 'capture-failed'
  return 'capture-failed'
}

async function captureFrame(hwnd, maxW) {
  lastErrorCode = ''
  if (process.platform !== 'win32') {
    lastErrorCode = 'unsupported-platform'
    return null
  }
  if (!Number.isFinite(hwnd) || hwnd <= 0) {
    lastErrorCode = 'window-gone'
    return null
  }
  const state = ensureAgent()
  await state.ready
  if (state.dead) {
    killAgent()
    lastErrorCode = 'capture-failed'
    return null
  }

  const line = await new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    // 超时：agent 可能卡在某个窗口的 PrintWindow 上（有应用会阻塞它）。
    // 清理该 waiter 并杀掉 agent（下一个请求会重启），否则后续请求全部错位。
    const timer = setTimeout(() => {
      const i = state.waiters.indexOf(waiter)
      if (i >= 0) state.waiters.splice(i, 1)
      killAgent()
      lastErrorCode = 'capture-failed'
      done(null)
    }, CAPTURE_TIMEOUT_MS)
    const waiter = (value) => done(value)
    state.waiters.push(waiter)
    try { state.child.stdin.write(`cap ${hwnd} ${maxW}\n`) } catch { done(null) }
  })
  if (typeof line !== 'string') {
    if (lastErrorCode === '') lastErrorCode = 'capture-failed'
    return null
  }
  if (!line.startsWith('OK ')) {
    lastErrorCode = normalizeErrorCode(line)
    // 窗口没了/不可见：正常终结条件，不重启 agent（agent 本身健康）。
    if (lastErrorCode === 'window-gone' || lastErrorCode === 'window-hidden') {
      touchIdle()
      return null
    }
    // 其它错误（capture-failed / agent-exited / 重启后错位）：重启自愈。
    killAgent()
    return null
  }
  const parts = line.split(' ')
  const w = Number(parts[1])
  const h = Number(parts[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    lastErrorCode = 'capture-failed'
    return null
  }
  return { w, h, data: parts[3] === undefined ? '' : parts[3] }
}

/** 进程退出时清掉常驻 agent（避免留下孤儿 powershell）。 */
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('exit', () => { killAgent() })
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * 注册抓帧路由（在已注入 webServer 的子上下文中调用）。
 *
 * 调用方（dsh-seeker-bot 入口）保证 webCtx.webServer 已就绪：路由用 effect 包住，
 * 插件卸载/重载时自动回收。
 */
export function applyRecCapture(webCtx) {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, message: 'method not allowed' })
        return
      }
      let hwnd = NaN
      let maxW = 0
      try {
        const query = String(req.url ?? '').split('?')[1] ?? ''
        const params = new URLSearchParams(query)
        hwnd = Number(params.get('hwnd'))
        maxW = Number(params.get('maxW'))
      } catch { /* 参数解析失败按下面的校验拒绝 */ }
      if (!Number.isFinite(hwnd) || hwnd <= 0) {
        sendJson(res, 400, { ok: false, message: 'hwnd required' })
        return
      }
      if (!Number.isFinite(maxW) || maxW < 0) maxW = 0
      let frame = null
      try {
        frame = await captureFrame(hwnd, Math.round(maxW))
      } catch { /* 抓帧失败按下面的错误码回 */ }
      if (frame === null) {
        // 502：让 client 区分「窗口没了/不可见」（正常终结，收尾出 GIF）与
        // 「抓帧本身坏了」（可重试）——两者在 UI 上的处置完全不同。
        sendJson(res, 502, {
          ok: false,
          code: lastErrorCode === '' ? 'capture-failed' : lastErrorCode,
          message: 'capture failed',
        })
        return
      }
      sendJson(res, 200, { ok: true, w: frame.w, h: frame.h, data: frame.data })
    },
  }), 'dsh-seeker-bot: done-pill rec-frame route')
}

export const REC_FRAME_ROUTE = ROUTE
export { captureFrame }

/**
 * 按进程名列表查找首个可见未最小化窗口并抓取一帧。
 * @param {string} procs 进程名，如 'ego,chrome,msedge'
 * @param {number} maxW 最大宽度，默认 600
 * @returns {Promise<{w:number,h:number,hwnd:number,process:string,title:string,data:string}|null>}
 */
export async function captureProcessFrame(procs = 'ego,chrome,msedge', maxW = 600, query = '') {
  lastErrorCode = ''
  if (process.platform !== 'win32') {
    lastErrorCode = 'unsupported-platform'
    return null
  }
  const cleanProcs = String(procs || 'ego').replace(/[^a-zA-Z0-9,_-]/g, '')
  if (!cleanProcs) {
    lastErrorCode = 'invalid-procs'
    return null
  }
  const state = ensureAgent()
  await state.ready
  if (state.dead) {
    killAgent()
    lastErrorCode = 'capture-failed'
    return null
  }

  const line = await new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => {
      const i = state.waiters.indexOf(waiter)
      if (i >= 0) state.waiters.splice(i, 1)
      killAgent()
      lastErrorCode = 'capture-failed'
      done(null)
    }, CAPTURE_TIMEOUT_MS)
    const waiter = (value) => done(value)
    state.waiters.push(waiter)
    const qB64 = query ? Buffer.from(String(query)).toString('base64') : ''
    try { state.child.stdin.write(`capp ${cleanProcs} ${Math.round(maxW)}${qB64 ? ' ' + qB64 : ''}\n`) } catch { done(null) }
  })
  if (typeof line !== 'string') {
    if (lastErrorCode === '') lastErrorCode = 'capture-failed'
    return null
  }
  if (!line.startsWith('OK ')) {
    lastErrorCode = normalizeErrorCode(line)
    if (line.startsWith('ERR window-hidden')) {
      const p = line.split(' ')
      const h = Number(p[2])
      const pr = p[3] || ''
      let ti = ''
      try { ti = Buffer.from(p[4] || '', 'base64').toString('utf8') } catch {}
      lastHiddenInfo = { hwnd: h, process: pr, title: ti }
    } else {
      lastHiddenInfo = null
    }
    if (lastErrorCode === 'window-gone' || lastErrorCode === 'window-hidden' || lastErrorCode === 'window-not-found') {
      touchIdle()
      return null
    }
    killAgent()
    return null
  }
  // 回执格式：OK <w> <h> <hwnd> <matchedProc> <titleB64> <base64Jpeg>
  const parts = line.split(' ')
  const w = Number(parts[1])
  const h = Number(parts[2])
  const hwnd = Number(parts[3])
  const proc = parts[4] || ''
  let title = ''
  try {
    title = Buffer.from(parts[5] || '', 'base64').toString('utf8')
  } catch { /* ignore */ }
  const data = parts[6] || ''
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    lastErrorCode = 'capture-failed'
    return null
  }
  return { w, h, hwnd, process: proc, title, data }
}

export function getCaptureLastErrorCode() {
  return lastErrorCode
}

export function getLastHiddenInfo() {
  return lastHiddenInfo
}
