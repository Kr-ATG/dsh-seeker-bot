// 探针 1：冷启动开销 + goto + screenshot 耗时
const t0 = Date.now();
const task = await taskSpace('seeker-probe');
const t1 = Date.now();
const page = task.page('p1');
await page.goto('https://example.com');
const t2 = Date.now();
const shotPath = await page.screenshot({ path: 'D:/AI/dsh-seeker-bot/_tmp/ego-probe/shot-1.png' });
const t3 = Date.now();
console.log(JSON.stringify({
  spaceId: task.spaceId,
  page: page.label,
  taskSpaceMs: t1 - t0,
  gotoMs: t2 - t1,
  shotMs: t3 - t2,
  totalMs: t3 - t0,
  shotPath,
  url: await page.url(),
  title: await page.title(),
}));
