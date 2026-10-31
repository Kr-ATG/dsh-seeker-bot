// 探针 7：单进程内批量抓帧（摊薄进程启动开销）——决定轮询方案的真实帧率上限
const task = await taskSpace('seeker-probe');
const page = task.page('p1');
await page.goto('https://example.com');
await page.waitForLoadState();

const N = 15;
const frames = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const s = Date.now();
  const r = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 45, captureBeyondViewport: false });
  frames.push({ ms: Date.now() - s, bytes: r && r.data ? r.data.length : 0 });
  if (i < N - 1) await new Promise((res) => setTimeout(res, 100));
}
const total = Date.now() - t0;
const avgShot = frames.reduce((a, b) => a + b.ms, 0) / frames.length;
const avgBytes = Math.round(frames.reduce((a, b) => a + b.bytes, 0) / frames.length);
console.log(JSON.stringify({
  totalMs: total,
  frames: N,
  effectiveFps: +(N / (total / 1000)).toFixed(1),
  avgShotMs: +avgShot.toFixed(1),
  minShotMs: Math.min(...frames.map(f => f.ms)),
  maxShotMs: Math.max(...frames.map(f => f.ms)),
  avgBytes,
  totalKB: Math.round(frames.reduce((a, b) => a + b.bytes, 0) / 1024),
}));
