// 探针 6B：只读连接（不改页面），看是否打断推流
const task = await taskSpace('seeker-probe');
const page = task.page('p1');
console.log(JSON.stringify({ url: await page.url(), title: await page.title() }));
