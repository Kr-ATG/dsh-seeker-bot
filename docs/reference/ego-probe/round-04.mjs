// 探针 4：页面持续变化时的帧率 + 单帧大小
const task = await taskSpace('seeker-probe');
const page = task.page('p1');

await page.cdp('Page.enable');
await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });

// 让页面持续变化：每 80ms 改一次背景 + 计数器
await page.evaluate(() => {
  let n = 0;
  window.__probe = setInterval(() => {
    n++;
    document.body.style.background = n % 2 ? '#ffffff' : '#f2f4f7';
    const el = document.createElement('div');
    el.textContent = 'tick ' + n;
    el.style.cssText = 'position:fixed;top:8px;left:8px;font:12px monospace;color:#111;z-index:99999';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 60);
  }, 80);
});

const t0 = Date.now();
let frames = 0, bytes = 0, minLen = 1e9, maxLen = 0;
const deadline = t0 + 3000;
while (Date.now() < deadline) {
  let evs = [];
  try { evs = await page.events(); } catch (e) { break; }
  for (const ev of evs) {
    if (ev.method === 'Page.screencastFrame') {
      frames++;
      const len = ev.params && ev.params.data ? ev.params.data.length : 0;
      bytes += len; minLen = Math.min(minLen, len); maxLen = Math.max(maxLen, len);
      try { await page.cdp('Page.screencastFrameAck', { sessionId: ev.params.sessionId }); } catch (e) {}
    }
  }
  await new Promise((r) => setTimeout(r, 30));
}
const elapsed = Date.now() - t0;

try { await page.evaluate(() => clearInterval(window.__probe)); } catch (e) {}
try { await page.cdp('Page.stopScreencast'); } catch (e) {}

console.log(JSON.stringify({
  elapsedMs: elapsed, frames, fps: +(frames / (elapsed / 1000)).toFixed(1),
  avgBytes: frames ? Math.round(bytes / frames) : 0, minLen, maxLen,
}));
