// 收尾：关闭探针 TaskSpace
const task = await taskSpace('seeker-probe');
const receipt = await task.finish({ keep: [] });
console.log(JSON.stringify(receipt));
