// 探针 5A：长驻推流进程（模拟插件常驻回显）
const task = await taskSpace('seeker-probe');
const page = task.page('p1');
await page.cdp('Page.enable');
await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
const t0 = Date.now();
let frames = 0;
const perSec = {};
while (Date.now() - t0 < 9000) {
  let evs = [];
  try { evs = await page.events(); } catch (e) { break; }
  for (const ev of evs) {
    if (ev.method === 'Page.screencastFrame') {
      frames++;
      try { await page.cdp('Page.screencastFrameAck', { sessionId: ev.params.sessionId }); } catch (e) {}
    }
  }
  const sec = Math.floor((Date.now() - t0) / 1000);
  perSec[sec] = frames;
  await new Promise((r) => setTimeout(r, 30));
}
try { await page.cdp('Page.stopScreencast'); } catch (e) {}
console.log(JSON.stringify({ totalFrames: frames, perSec }));
