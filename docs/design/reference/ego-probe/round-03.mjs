// 探针 3：能否拿到 CDP screencast 帧流（决定常驻推流是否可行）
const task = await taskSpace('seeker-probe');
const page = task.page('p1');

const log = [];
try {
  await page.cdp('Page.enable');
  log.push('Page.enable ok');
} catch (e) { log.push('Page.enable FAIL ' + e.message); }

let started = false;
try {
  await page.cdp('Page.startScreencast', {
    format: 'jpeg', quality: 50, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
  });
  started = true;
  log.push('startScreencast ok');
} catch (e) { log.push('startScreencast FAIL ' + e.message); }

let frames = 0, firstLen = 0, acks = 0;
if (started) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && frames < 5) {
    let evs = [];
    try { evs = await page.events(); } catch (e) { log.push('events FAIL ' + e.message); break; }
    for (const ev of evs) {
      if (ev.method === 'Page.screencastFrame') {
        frames++;
        if (!firstLen) firstLen = (ev.params && ev.params.data ? ev.params.data.length : 0);
        try { await page.cdp('Page.screencastFrameAck', { sessionId: ev.params.sessionId }); acks++; } catch (e) {}
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  try { await page.cdp('Page.stopScreencast'); } catch (e) {}
}

console.log(JSON.stringify({ started, frames, firstLen, acks, log }));
