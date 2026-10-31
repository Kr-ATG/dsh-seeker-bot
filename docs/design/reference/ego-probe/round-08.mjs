// 探针 8：长驻脚本流式输出（模拟插件常驻推流进程）
const task = await taskSpace('seeker-probe');
const page = task.page('p1');
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < 8000) {
  const s = Date.now();
  let bytes = 0, err = null;
  try {
    const r = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 40, captureBeyondViewport: false });
    bytes = r && r.data ? r.data.length : 0;
  } catch (e) { err = String(e && e.message || e); }
  console.log(JSON.stringify({ i: i++, t: Date.now() - t0, shotMs: Date.now() - s, bytes, err }));
  await new Promise((r) => setTimeout(r, 200));
}
console.log(JSON.stringify({ done: true, total: i, elapsed: Date.now() - t0 }));
