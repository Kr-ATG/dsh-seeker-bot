/**
 * Personal Agent — 宿主侧轻量桌面画面抓取服务。
 *
 * 为 Bot 桌面控制（computer-use / desktop-control MCP 等）提供极轻量的前端实时画面流。
 *
 * 性能与安全纪律：
 *  1. 短期内存缓存（400ms）：高频轮询或多个客户端请求时直接复用内存帧，不重复调用操作系统截屏；
 *  2. 并发合并（In-flight Deduplication）：正在抓屏中的请求直接共享同一个 Promise，避免并发争抢；
 *  3. 尺寸与质量优化：默认限制宽度 960px、JPEG 质量 60，单帧仅 ~40-60KB，CPU 占用微乎其微；
 *  4. 绝不进入 LLM 上下文：本接口仅供前端界面作为实时观测画面展示，绝不污染 Token；
 *  5. 零额外 npm 依赖：Windows 下优先使用本地轻量抓屏工具，失败自动回退到 PowerShell。
 */
import { exec, execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/** 最小抓屏间隔（毫秒）：低于此间隔的请求直接返回缓存帧，避免打满 CPU。 */
export const MIN_CAPTURE_INTERVAL_MS = 400

/** 默认截图宽度（px）。 */
export const DEFAULT_SCREEN_WIDTH = 960

/** 默认 JPEG 质量（1-100）。 */
export const DEFAULT_SCREEN_QUALITY = 60

/** 抓屏工具源码（C#）：编译后仅 5KB，抓屏耗时 < 50ms。 */
const SCREEN_CAP_CS = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;

class Program {
    static void Main(string[] args) {
        int maxWidth = 960;
        int quality = 60;
        if (args.Length > 0) int.TryParse(args[0], out maxWidth);
        if (args.Length > 1) int.TryParse(args[1], out quality);

        Rectangle bounds = Screen.PrimaryScreen.Bounds;
        using (Bitmap bmp = new Bitmap(bounds.Width, bounds.Height)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(Point.Empty, Point.Empty, bounds.Size);
            }
            int targetWidth = (maxWidth > 0 && maxWidth < bounds.Width) ? maxWidth : bounds.Width;
            int targetHeight = (int)((double)bounds.Height * targetWidth / bounds.Width);
            using (Bitmap scaled = new Bitmap(bmp, targetWidth, targetHeight)) {
                ImageCodecInfo jpgEncoder = null;
                foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {
                    if (codec.FormatID == ImageFormat.Jpeg.Guid) {
                        jpgEncoder = codec;
                        break;
                    }
                }
                EncoderParameters myEncoderParameters = new EncoderParameters(1);
                myEncoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
                using (Stream stdout = Console.OpenStandardOutput()) {
                    scaled.Save(stdout, jpgEncoder, myEncoderParameters);
                }
            }
        }
    }
}
`

interface CacheEntry {
  buffer: Buffer
  timestamp: number
}

let lastFrame: CacheEntry | null = null
let inflightCapture: Promise<Buffer | null> | null = null
let screencapExePath: string | null = null
let compileAttempted = false

function getBinDir(): string {
  const dir = join(homedir(), '.dsh', 'storages', 'dsh-seeker-bot', 'personal-agent', 'bin')
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  return dir
}

/** 确保或编译轻量 screencap.exe。 */
async function ensureScreencapExe(): Promise<string | null> {
  if (platform() !== 'win32') return null
  if (screencapExePath !== null && existsSync(screencapExePath)) return screencapExePath
  if (compileAttempted) return null
  compileAttempted = true

  const binDir = getBinDir()
  const exePath = join(binDir, 'screencap.exe')
  if (existsSync(exePath)) {
    screencapExePath = exePath
    return exePath
  }

  const cscCandidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ]
  const cscPath = cscCandidates.find((c) => existsSync(c))
  if (!cscPath) return null

  const csFile = join(binDir, 'screencap.cs')
  try {
    writeFileSync(csFile, SCREEN_CAP_CS, 'utf-8')
    await execFileAsync(cscPath, [
      '/target:exe',
      `/out:${exePath}`,
      '/r:System.Drawing.dll,System.Windows.Forms.dll',
      csFile,
    ])
    if (existsSync(exePath)) {
      screencapExePath = exePath
      return exePath
    }
  } catch {
    /* 编译失败回退到 PowerShell 方案 */
  }
  return null
}

/** 通过 PowerShell 兜底抓屏。 */
async function captureViaPowerShell(maxWidth: number, quality: number): Promise<Buffer | null> {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$targetWidth = if (${maxWidth} -gt 0 -and ${maxWidth} -lt $bounds.Width) { ${maxWidth} } else { $bounds.Width }
$targetHeight = [int]($bounds.Height * $targetWidth / $bounds.Width)
$scaled = New-Object System.Drawing.Bitmap $bmp, $targetWidth, $targetHeight
$ms = New-Object System.IO.MemoryStream
$codecs = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()
$jpgCodec = $codecs | Where-Object { $_.FormatID -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
$scaled.Save($ms, $jpgCodec, $params)
[System.Convert]::ToBase64String($ms.ToArray())
$g.Dispose()
$bmp.Dispose()
$scaled.Dispose()
$ms.Dispose()
`
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/\r?\n/g, ' ')}"`,
      { maxBuffer: 16 * 1024 * 1024, timeout: 3000 },
    )
    const b64 = stdout.trim()
    if (b64 === '') return null
    return Buffer.from(b64, 'base64')
  } catch {
    return null
  }
}


/** 通过 Linux 常见命令行工具（X11 / Xvfb / Wayland）抓屏。 */
async function captureLinuxDesktop(maxWidth: number, quality: number): Promise<Buffer | null> {
  // 检查是否具备显示环境（物理桌面或 Xvfb 虚拟显示）
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
  if (!display) return null

  // 1. 优先尝试 ImageMagick 的 import（绝大多数安装了桌面工具的 Linux 都有，直接输出 JPEG 流）
  try {
    const { stdout } = await execAsync(
      `import -window root -resize ${maxWidth}x -quality ${quality} jpg:-`,
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 2500 }
    )
    if (stdout.length > 100) return stdout
  } catch {
    /* 尝试下一候选 */
  }

  // 2. 尝试 Wayland 下的 grim
  if (process.env.WAYLAND_DISPLAY) {
    try {
      const { stdout } = await execAsync(
        `grim -t jpeg -q ${quality} -`,
        { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 2500 }
      )
      if (stdout.length > 100) return stdout
    } catch {
      /* 尝试下一候选 */
    }
  }

  // 3. 尝试 scrot
  try {
    const { stdout } = await execAsync(
      `scrot -q ${quality} -o -`,
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 2500 }
    )
    if (stdout.length > 100) return stdout
  } catch {
    /* 尝试下一候选 */
  }

  return null
}

/** 通过 macOS screencapture 抓屏。 */
async function captureMacDesktop(maxWidth: number, quality: number): Promise<Buffer | null> {
  try {
    const tmpPath = join(getBinDir(), `mac-cap-${Date.now()}.jpg`)
    await execFileAsync('screencapture', ['-x', '-t', 'jpg', tmpPath], { timeout: 2500 })
    if (existsSync(tmpPath)) {
      const buf = await import('node:fs/promises').then(f => f.readFile(tmpPath))
      try { await import('node:fs/promises').then(f => f.unlink(tmpPath)) } catch {}
      return buf
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 执行一次桌面屏幕截图。 */
async function doCapture(maxWidth: number, quality: number): Promise<Buffer | null> {
  const osType = platform()
  if (osType === 'win32') {
    // 1. 优先尝试本地编译好的微型可执行程序（耗时约 20-50ms）
    const exe = await ensureScreencapExe()
    if (exe !== null) {
      try {
        const { stdout } = await execFileAsync(exe, [String(maxWidth), String(quality)], {
          encoding: 'buffer',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 2500,
        })
        if (stdout.length > 100) return stdout
      } catch {
        /* 回退 */
      }
    }

    // 2. 回退到 PowerShell 方案
    return captureViaPowerShell(maxWidth, quality)
  }

  if (osType === 'linux') {
    return captureLinuxDesktop(maxWidth, quality)
  }

  if (osType === 'darwin') {
    return captureMacDesktop(maxWidth, quality)
  }

  return null
}

/**
 * 抓取当前桌面屏幕一帧 JPEG 图片。
 *
 * 具备防抖内存缓存：如果距上次抓屏 < MIN_CAPTURE_INTERVAL_MS，直接返回上次的 Buffer；
 * 具备并发保护：若有正在进行的抓屏，等待并复用其结果。
 */
export async function captureDesktopScreen(options?: {
  maxWidth?: number
  quality?: number
}): Promise<Buffer | null> {
  const now = Date.now()
  if (lastFrame !== null && now - lastFrame.timestamp < MIN_CAPTURE_INTERVAL_MS) {
    return lastFrame.buffer
  }

  if (inflightCapture !== null) {
    return inflightCapture
  }

  const maxWidth = options?.maxWidth ?? DEFAULT_SCREEN_WIDTH
  const quality = options?.quality ?? DEFAULT_SCREEN_QUALITY

  inflightCapture = doCapture(maxWidth, quality)
    .then((buf) => {
      if (buf !== null && buf.length > 0) {
        lastFrame = { buffer: buf, timestamp: Date.now() }
      }
      return buf
    })
    .catch(() => null)
    .finally(() => {
      inflightCapture = null
    })

  return inflightCapture
}

/** 清理抓屏缓存（测试或重置时调用）。 */
export function clearDesktopScreenCache(): void {
  lastFrame = null
  inflightCapture = null
}
