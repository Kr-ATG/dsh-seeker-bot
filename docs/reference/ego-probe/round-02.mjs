// 探针 2：热路径截图耗时 + CDP captureScreenshot 对比
const t0 = Date.now();
const task = await taskSpace('seeker-probe');
const tResume = Date.now() - t0;
const page = task.page('p1');

const shots = [];
for (let i = 0; i < 3; i++) {
  const s = Date.now();
  await page.screenshot({ path: 'D:/AI/dsh-seeker-bot/_tmp/ego-probe/hot-' + i + '.png' });
  shots.push(Date.now() - s);
}

// CDP 直接抓帧（jpeg，低质量）
let cdpMs = -1, cdpBytes = 0, cdpErr = null;
try {
  const s = Date.now();
  const r = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
  cdpMs = Date.now() - s;
  cdpBytes = r && r.data ? r.data.length : 0;
} catch (e) {
  cdpErr = String(e && e.message || e);
}

// 视口尺寸（回显需要知道画面比例）
let vp = null;
try {
  vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
} catch (e) { vp = String(e); }

console.log(JSON.stringify({ resumeMs: tResume, hotShots: shots, cdpMs, cdpBytes, cdpErr, viewport: vp }));
