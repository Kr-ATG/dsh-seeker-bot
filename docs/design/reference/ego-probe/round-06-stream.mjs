// 探针 6A：推流 12 秒；第 6 秒自己改页面作对照
const task = await taskSpace('seeker-probe');
const page = task.page('p1');
await page.cdp('Page.enable');
await page.cdp('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
const t0 = Date.now();
let frames = 0;
const marks = [];
let selfTouched = false;
while (Date.now() - t0 < 12000) {
  let evs = [];
  try { evs = await page.events(); } catch (e) { break; }
  for (const ev of evs) {
    if (ev.method === 'Page.screencastFrame') {
      frames++;
      try { await page.cdp('Page.screencastFrameAck', { sessionId: ev.params.sessionId }); } catch (e) {}
    }
  }
  const sec = Math.floor((Date.now() - t0) / 1000);
  if (marks[sec] === undefined) marks[sec] = frames;
  if (!selfTouched && Date.now() - t0 > 6000) {
    selfTouched = true;
    try { await page.evaluate(() => { document.body.style.background = '#fff7e6'; }); } catch (e) {}
  }
  await new Promise((r) => setTimeout(r, 30));
}
console.log(JSON.stringify({ totalFrames: frames, marks }));
