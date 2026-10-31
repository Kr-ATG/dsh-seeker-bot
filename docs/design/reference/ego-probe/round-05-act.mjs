// 探针 5B：另一个进程同时操作同一 space
const t0 = Date.now();
const task = await taskSpace('seeker-probe');
const page = task.page('p1');
const t1 = Date.now();
await page.evaluate(() => {
  document.body.style.background = '#e8f0ff';
  document.title = 'acted-' + Date.now();
});
const t2 = Date.now();
await page.mouse.click(200, 200);
const t3 = Date.now();
console.log(JSON.stringify({ resumeMs: t1 - t0, evalMs: t2 - t1, clickMs: t3 - t2, url: await page.url() }));
