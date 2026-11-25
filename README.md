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

## 应用结构

无第三方依赖，纯 ESM，Node.js 22 内置测试运行器。

| 模块 | 职责 |
| --- | --- |
| `src/records.js` | 字符串/问号/组合编号的解析访问器，原始表不被改写 |
| `src/time.js` | slot↔供暖窗时间轴、历史/当夜/次日分期、未来时段判定 |
| `src/weather.js` | 按发报时点取预报、温度风雪签名、通达三态、历史可比性 |
| `src/demand.js` | 同窗去重、三层需求估计、历史证据、次日重新识别 |
| `src/resources.js` | 站点容量、人员/车辆共用、轮椅与普通分开校验、车辆锁定 |
| `src/coverage.js` | 当夜承诺对账、关闭点影响、按可到达去重人群核算覆盖变化 |
| `src/queue.js` | 只承认有离场证据的排队重估，滞留不滚入下一时段 |
| `src/notifications.js` | 回单分桶、暂挂互斥受理、原车锁、当日履约复核 |
| `src/disclosure.js` | 对外简报口径（仅本点分组与最小规模门槛） |
| `src/engine.js` | 组装门面：按街区/服务点/班次查询、预报更新、决策证据 |
| `src/cli.js` | JSON 命令行，可被其他系统管道消费 |

### 关键口径（可在测试中逐条复核）

1. **去重键是（匿名号，供暖窗）**。同一窗两个点登记算一人；不同窗是不同服务需要，转点不是误报，再次入站不是重复计数。
2. **三层需求分开报**：
   - 看得见的需求：去重后的接纳、满员未接、轮椅预约；
   - 阻断下限 `minUnmet = 满员未接 + 断报街区未见履约的已承诺人数`；
   - 潜在上限 `maxUnmet = max(0, eligible − 已服务)`；
   - 点估计仅在存在可比历史时给出，部分可比标 `partial`，不可比只保留区间。
3. **历史可比性** = 温度风雪组合一致 **且** 到各点通达无硬冲突；任一侧缺通达资料降为部分可比。
4. **覆盖改善只数可到达的去重人群**。已经能到达其他营业点的人单列 `alreadyCoveredPersons`，不计新增；资料不足列 `unknownReachPersons`；阻断列 `blockedPersons`；人次 `personTripsConsidered` 仅作对照，不进结论。
5. **轮椅与普通条件分别成立**：普通车辆/座位不能承接轮椅需要（`serviceMismatchPersons`）。
6. **车辆锁定**：已出发/已开始的预约保留到窗结束；联系人确认家庭架轮椅等原车时，该车不得向另一街区承诺新预约。
7. **预报更新只影响未来 slot**；已开始时段的更新被跳过并说明原因，已接送对象不重新当待派。
8. **暂挂互斥**：两份改派可同时暂挂；受理一份后，另一份立即显示共享资源被占的原因（资料不被改写，决策单独留痕）。
9. **排队**：只有 `state=离开` 且 `leave` 有实际时段的人移出等待；缺离场证据者保留在本窗，不灌进下一时段。
10. **对外简报**：`share=仅本点` 的脆弱分组不进对外小计；`share=对外` 还要达到 `min_group`；小计按去重人数。
11. **次日窗**：低温持续时按窗重新识别需求，今天已服务人次不充当次日新增服务证据。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

### 命令行示例

```sh
# 三个街区的三层需求估计（默认最新发报时点）
node src/cli.js blocks
# 指定只能使用 issue 99 及以前的预报
node src/cli.js block B2 --as-of 99
# 服务点维度：容量状态与门口滞留重估
node src/cli.js sites S2
# 预约班次（now=101，已开始的班次显示不可重派）
node src/cli.js shifts --now 101
# 当夜需求与承诺对账
node src/cli.js reconcile
# 邻点临时关闭：失效承诺与需联系人群
node src/cli.js closures W2
# 评估延长/重开/增派方案（JSON 入参）
node src/cli.js plan '[{"site":"S1","window":"W2","chairsNeeded":5,"wheelchairNeeded":1,"vehicles":[]}]'
# 通知回单、暂挂受理、对外简报、次日需求、气象决策证据
node src/cli.js notices
node src/cli.js accept N3
node src/cli.js briefing
node src/cli.js next-day
node src/cli.js basis
# 应用新一轮预报（已开始时段自动跳过）
node src/cli.js forecast '[{"issue":"101","valid":"101","block":"B1","temp":"-14","snow":"多","wind":"强"}]' --now 100
```

## 测试与规则的对应

| 测试文件 | 覆盖的业务规则 |
| --- | --- |
| `test/weather.test.js` | 发报时点选版、温度风雪签名、通达三态、历史可比性、未来时段 |
| `test/demand.test.js` | 同窗去重、转点非误报、三层需求、断报下限、次日重新识别 |
| `test/resources.test.js` | 人员/车辆共用、轮椅普通分验、锁车、阻断趟次 |
| `test/coverage.test.js` | 同区间对账、关闭影响、可达去重覆盖、服务类型匹配、排队离场证据与滞留不滚窗 |
| `test/notifications.test.js` | 回单分桶、原车锁、暂挂互斥、履约复核 |
| `test/disclosure.test.js` | 仅本点分组排除、最小规模门槛、去重小计 |
| `test/engine.test.js` | 三维查询、预报不回溯、决策证据、端到端联动 |
| `test/cli.test.js` | 命令行 JSON 契约 |
