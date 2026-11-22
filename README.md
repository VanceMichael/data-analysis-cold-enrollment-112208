# 寒潮期间取暖点服务量及覆盖切换

不同预报版本保留发报时点。到场事件用合成匿名号，离开和换取暖点同样有记录。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

同一个服务窗口可以包含多个站点的登记，匿名号相同且窗口相同时算一个人。值班人员、车辆和无障碍座位按时段是不可重复的资源。已经接上对象的车辆使用要保留到该窗口结束。

- `weather.json` 记录字段为 `issue`、`valid`、`block`、`temp`、`snow`、`wind`。
- `attendance.json` 记录字段为 `anonymous`、`block`、`site`、`slot`、`event`、`window`。
- `mobility.json` 记录字段为 `block`、`site`、`slot`、`vehicle`、`service`、`available`。
- `sites.json` 记录字段为 `site`、`window`、`chairs`、`wheelchair`、`staff`、`state`。
- `coverage.json` 记录字段为 `block`、`eligible`、`reserved`、`prior_state`。
- `seats.json` 记录字段为 `id`、`site`、`closing`、`window`、`phase`、`vehicle`。
- `notifications.json` 记录字段为 `notice`、`block`、`site`、`slot`、`vehicle`、`state`、`revision`。
- `queue.json` 记录字段为 `anonymous`、`site`、`arrive`、`leave`、`window`、`state`。
- `disclosure.json` 记录字段为 `group`、`slots`、`min_group`、`share`。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。
