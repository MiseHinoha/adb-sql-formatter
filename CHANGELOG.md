# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
用户可见的排版规则变化一律算次版本（会重排已有文件），只增提示不改排版的算修订号。

## [1.6.0] - 未发布（原型，等验收定默认值）

### 新增（可选）

- **结构缩进 `adbSqlFormatter.indentMode`**：三个取值，决定 `from` / `join` / `where` / `and` 这些行的缩进形态。
  - `flat` —— 现状（子句、join、`and`/`or` 续行全挤在同一列）。
  - `nested` —— 每个子句行 / join 行开启一个「体」，属于它的续行深一级：join 比 from 深一级、
    `and` 比 where 深一级、join 的 `on` 续行比该 join 深一级；括号块随开括号那一行整体平移。
  - `nested-on` —— 在 `nested` 之上，把 `left join t on <cond>` 拆成两行，`on` 条件再深一级
    （最深、最啰嗦，简单查询会明显变长）。
  实测（自造语料 15 条 × 2 种模式）：骨架不变（= 只动空白）、二次格式化幂等；
  对 git 基线 A/B：`flat` 输出与 1.5.2 逐字一致 —— 新阶段不影响旧排版。

### 坑与守卫

- **多行字符串 / 块注释内部的行绝不能补缩进**：补了就是把 tab 打进引号里 = 改数据，
  `ab` 闸会判「真动代码」。`startsInLiteral` 逐行跟踪引号与块注释状态，这些行原样放行
  （只在第一版原型里踩过：`a.note in ('第一行\n第二行')` 的第二行被推进一级）。
- 幂等靠「owner 只在基准缩进相同的行之间认领」：再排一次时 join 已经比 from 深，
  认领不到 owner，增量归 0，缩进不变。

### 未定

- 默认值（原型期默认 `nested` 方便肉眼验收，正式发版前定）、是否需要 `nested-on`、以及
  `case when` 内部既有缩进与 join 续行撞在同一列时的观感。

## [1.5.2] - 2026-11-04

### 修复

- **字段末尾带 `--` 行注释时，每个字段被撑成两行**：`sql-formatter` 收尾行注释后先换一行，
  前置逗号又要在新行开头，于是「字段 + 注释」行与下一个 `, 字段` 行之间凭空多出一个空行 ——
  5 个字段的 `select` 从 5 行变 9 行，整段看着松散。现在排版器输出后先吃掉这种空行
  （只针对「空行前一行为行内注释、空行后一行以逗号开头」这一种形态，`'a--b'` 这种字符串里的
  `--` 不算注释），字段与注释回到同一行，行数不再翻倍。
- **保存时有语法错就「没反应」**：以前排版抛错只写进扩展日志、文档按原样存下去，
  用户完全看不到发生了什么。现在会 ① 在出错行画一条波浪线（诊断码 `format-error`，与「缺分号」区分），
  ② 弹一条警告说明失败原因与行列号（解析器那几百行「期望 token 列表」只取第一行），
  同一条错误反复保存只提示一次，改好并成功排版后诊断自动消失。
  新设置 `adbSqlFormatter.notifyOnFormatError`（默认开）可把这两样一起关掉。

### 开发侧

- `npm test` 新增 1.5.2 回归：行尾注释的 `select` 逐字段一行（精确比对整段输出）、幂等、骨架不变、
  字符串里的 `--` 不被当注释、`describeFormatError` 只取报错第一行并拆出行列号。
- `test-extension.js` 的 vscode 桩按集合名分表（排版失败诊断与缺分号诊断互不覆盖），
  并补「语法错 → 波浪线 + 警告」「同错只提示一次」「修好后诊断消失」「开关关掉后静默」四条用例。
- `formatter-core` 导出 `describeFormatError`，并把 `collapseCommaCommentGaps` 挂到 `_internals` 供逐步排查。

## [1.5.1] - 2026-10-08

### 修复

- **CRLF 脚本里的 `/**/` 块注释每保存一次就多一层空行**：`sql-formatter` 会把块注释内容原样带出，
  CRLF 文档里注释正文的 `\r` 因此活到了核心输出里 —— 排完的文本成了「SQL 行只有 `\n`、
  注释行还带 `\r`」的混合换行。扩展按文档换行符回写时做 `\n` → `\r\n`，
  这些注释行就变成 `\r\r\n`；编辑器把孤立的 `\r` 也当换行，于是注释正文每行后面凭空多一个空行，
  而且**只要文件里有任何改动，再保存一次就再多一层**（用户现场：注释块从 5 行滚成「一行正文 + 一行空行」）。
  现在核心在入口与出口各归一次换行符（对外只产出 `\n`），扩展回写走同一套归一（`toEol`）：
  连存多次不再增长，块注释正文原样保留、不做任何重排。
- 同类隐患一并收口：选区排版、旧式 `\r` 换行（经典 Mac 风格）残留的 `\r` 也不会再漏进输出。

### 开发侧

- `npm test` 新增 1.5.1 回归：CRLF 与 LF 输入产出同一结果、核心输出不含 `\r`、CRLF 块注释连存三次
  不出现 `\r\r` 且正文行数不变、再次保存幂等、LF 文档不被改成 CRLF。
- `test-extension.js` 的 vscode 桩新增「CRLF + 块注释的保存即格式化」用例：回写里没有 `\r\r`、
  注释行数不变、紧接着再保存一次结果不再增长（旧代码在这条上必红）。
- `formatter-core` 导出 `normalizeEol` / `toEol`（换行符归一与按文档回写），扩展与测试共用一份，
  不在扩展里另抄。

## [1.5.0] - 2026-09-30

### 新增

- **保存即格式化（opt-in，默认关）**：`Ctrl+S` / `Cmd+S` 在 SQL 编辑器里先按本扩展的规则重排、再落盘。
  - **默认不动用户的文件**（与 VS Code 自己的约定一致，`editor.formatOnSave` 默认也是关的）。
    开启方式：第一次在含 SQL 文件的工作区激活时问一次「要在保存时格式化吗？」（每台机器只问一次，
    先记 globalState 再问，选「不用了」不再打扰），或直接把 `adbSqlFormatter.formatOnSave` 打开。
  - **自己接住键位**：命令 `adbSqlFormatter.formatAndSave`（`contributes.keybindings`，`when` 限定在
    sql / mysql 编辑器、非只读，并由 `adbSqlFormatter.takeOverSaveKey` + `formatOnSave` 两个开关共同控制）
    先格式化再调 `workbench.action.files.save` —— 不走 VS Code 的
    「格式化程序解析」，所以 `defaultFormatter` 配错也照样工作；同一次保存里别的扩展的保存钩子抛错
    导致整批编辑作废时（日志里是 `listener failed`）也不受牵连。格式化失败也保证保存发生，不丢改动。
  - **保存钩子兜底**：`onWillSaveTextDocument` 覆盖其它保存入口（失焦保存、从资源管理器或源代码管理
    面板保存等）。两者互不重复：命令刚格式化过的版本，紧接着的保存会跳过。
    自动保存（`AfterDelay`）与「全部保存」（`saveAll` 带 `skipSaveParticipants`）按 VS Code 的设计
    不参与格式化 —— 前者与编辑器自带 `formatOnSave` 的取舍一致，否则边打字边重排、光标乱跳。
  - 不依赖 `editor.formatOnSave`，也不要求 `editor.defaultFormatter` 指向本扩展。
    设置项 `adbSqlFormatter.formatOnSave` 是这套行为的总开关（默认关，见上）。
  - **快捷键可自定义**：新增 `adbSqlFormatter.takeOverSaveKey`（默认开，用 `setContext` + manifest 的
    `when` 开关，改完即时生效；只有 `formatOnSave` 也打开时才真正接管）可让本扩展不再占 `Ctrl/Cmd+S`；
    想把「格式化并保存」绑到别的键，在键位设置（`Cmd+K Cmd+S`）里给命令 `adbSqlFormatter.formatAndSave`
    绑任意键即可 —— VS Code 不允许扩展在运行时声明键位，「选键」只能走这条 UI 路径，设置项负责的是
    「要不要接管」。
- **单一开关说了算（保存侧）**：`adbSqlFormatter.formatOnSave` 关着时保存**绝不重排**，打开时保存即重排。
  两条路分别处理：本扩展自己那条（`Ctrl+S` 键位 + 保存钩子）直接按开关停；编辑器自带的
  `editor.formatOnSave` 是另一条路（VS Code 调本扩展的 provider），**运行时拦不住** —— 实测它的 provider
  调用比扩展收到 `onWillSaveTextDocument` 早 10~50ms，无法判断「这次调用是不是保存」。因此改为**设置对齐**：
  开关被关掉的那一刻，若 `[sql]` / `[mysql]` 的 `editor.formatOnSave` 还是 true 就一起关掉（弹信息提示，
  带一键撤销）；激活时发现这种组合也提示一次。
- **手动排版不受开关影响**（上一版曾让手动入口在开关关着时失效，已改正）：排版 provider 永远可用，
  `Shift+Alt+F` / 右键「格式化文档」/ 命令面板都照常；另加命令 `adbSqlFormatter.formatDocument`
  （命令面板 + 右键菜单项），在默认格式化程序被设成别的 SQL 扩展时能强制走本扩展。
- **坏配置自诊断**：`editor.defaultFormatter` 指向一个没装的扩展时（例如扩展换了 publisher 名字，
  旧 ID 留在设置里），VS Code 会报 "Extension '{0}' is configured as formatter but not available"
  并且整条 formatOnSave 路径都不格式化 —— 这是「按了保存没反应」最常见的成因。现在扩展会提示一次，
  并可一键把该设置改成 `YipTszkwan.adb-sql-formatter`（含「不再提示」）。
- 建表语句：**关键字纵向对齐**。列定义按「名称 / 类型 / 约束关键字」分列对齐（`not null`、
  `default …`、`comment '…'` 各占一列，某行没写就留空位，`comment` 始终在同一列）；
  表选项区把首词补齐，`distribute by` / `partition by` 的 `by` 与 `comment =` 的 `=` 对齐。
  只补空格、不动内容；解析不出固定形态的行（表级约束、注释行、跨行定义）原样保留。
  中日韩字符按 2 列宽计算，中文列名/注释也能对齐。

### 修复

- 逗号行丢掉缩进：`tabWidth` 不是 4 时（VS Code 的 `detectIndentation` 常把 2 空格缩进的文件判成
  `tabSize=2`），表头第一行有缩进而后续字段顶格，看起来「只有第一个字段有缩进」。
  逗号行按「同级缩进 − 2 列」的固定偏移补回来，2 / 3 / 4 / 8 均正确。
- 窗口子句被拆行：`row_number() over (partition by … order by …)` 现在排成一行，
  只有整行超过 `expressionWidth` 时才保持拆开的多行形态；带注释的窗口子句不动。
  `over (` 的空格照旧保留。
- 换行符：保存即格式化按文档原有的换行符回写（CRLF 的脚本不再被整篇换成 LF —— 此前全文替换固定按
  LF 拼回，Windows 侧脚本一保存就会整篇 diff）。补分号 quick fix 的「插入分号并空一行」同样跟随文档。

### 开发侧

- `npm test` 新增 1.5.0 回归：逗号行缩进（tabWidth 2/3/4/8）、窗口子句合并且不超宽、
  建表关键字对齐（列名 / 类型 / comment / 表选项）与幂等、骨架不变。
- `test-extension.js` 的 vscode 桩补 `window`、`extensions`、`commands`、`ConfigurationTarget`、
  `inspect/update`、`onWillSaveTextDocument` 与带 section 的 `getConfiguration`，新增用例：
  保存钩子（默认会格式化、编辑器自己会格式化时让位、默认格式化程序指向写错的 ID 时接手、
  指向别的扩展时让位、开关可关、非 sql 不插手、`tabSize=2` 时逗号行有缩进、CRLF 不被换成 LF）、
  Ctrl+S 命令（干净文件也被格式化、随后确实保存、没有活动编辑器也不丢保存）、
  坏配置诊断（提示 + 一键修正 + 配的是真扩展时不提示）。
- 修正 README 的说法：缩进一直是 tab，不会因为文件用空格就切空格；设置项补 `formatOnSave`。
- 真实扩展宿主端到端验证（`@vscode/test-electron` + 本机 VS Code）：干净文件、脏文件、
  坏 `defaultFormatter` 三种组合下，命令与保存钩子都产出格式化后的磁盘内容；
  「扩展开关关着 + 编辑器 `editor.formatOnSave` 开着」时保存不被重排、手动命令仍可排版。

## [1.4.0] - 2026-09-29

### 新增

- 界面文案中英双语，跟随 VSCode 显示语言：设置项走 `package.nls.json` / `package.nls.zh-cn.json`，
  诊断消息与 quick fix 标题走 `vscode.l10n.t()` + `l10n/bundle.l10n.zh-cn.json`。
  中文环境下看到的仍是原来的中文；低于 1.73 的 VSCode 没有 `vscode.l10n`，退回英文源文。
- 扩展图标（自绘：圆角底板 + 阶梯缩进的代码条 + 前置逗号）。
- `CHANGELOG.md`。
- README 中英双语互链：`README.md`（中文）与 `README.en.md`（英文）。商店详情页只读 `README.md`，
  英文版随仓库发布、不进 vsix。

### 变更

- `package.json` 的 `description` 改为英文：该字段不参与 nls 本地化，商店与扩展页只显示这一条，
  面向更广泛的读者取英文；中文说明保留在 README。
- 打包瘦身：`node_modules` 只保留运行时真正需要的 js，剔除类型声明、map、测试目录、
  CLI 与文档（LICENSE 按 MIT 要求保留）。

### 开发侧

- 开源前脱敏：dev 脚本里的真实库表名与业务口径换成 `demo_stats.*` / `demo_ods.*`，真实文件基线换成自造形状 + 只报聚合数字的语料巡检；语料仓不可用时 `npm test` 走 SKIP 分支。
- 语料仓探测收窄：候选目录须含 `.sql`，且命中 `ADB_SQL_FIXTURE_MARKERS` 声明的子目录名，不再硬编码任何具体目录名；自动探测不越过用户主目录。不拿 `.git` 当特征 —— 本仓自带 `test/fixtures/*.sql`，那样会把自己认成语料仓。
- `test:real` / `test:ab` / `test:semi-scan` 在没有语料仓时打印「未验证」并退出码 2（此前会 0 条静默通过）。
- `scan-semicolon.js` 的归属目录聚合改为通用两级，路径过滤交由 `ADB_SQL_FIXTURE_SKIP` 提供。
- 新增 `corpus.js`（语料枚举与代码骨架）供 `check-ddl` / `scan-semicolon` / `ab-format` 共用。
- `npm test` 新增文案一致性断言：`%key%` 与 `t()` 源文必须在中英两侧都齐全，
  防止设置界面出现 `%adbSqlFormatter.xxx%` 这类坏值。

## [1.3.0] - 2026-09-29

### 新增

- ADB 专有函数补进方言函数表，输出紧贴括号：`nvl`、`date_trunc`、`months_between`、`array_agg`、
  `to_timestamp`、`to_date`、`to_unixtime`、`date_diff`、`regexp_extract`、`cardinality`。
  此前它们会被排成 `nvl (a, 0)`（函数名与括号之间多一个空格）。
  表名位置的 `insert into t (a, b)` 与窗口 `over (partition by ...)` 的空格照旧保留。
- 开发侧新增回归闸 `npm run test:ab`：拿工作树与某个 git 基线对真实语料逐文件比对输出，
  分「完全一致 / 仅空白差异 / 仅大小写差异 / 真动了代码」四档，只有最后一档判失败。

### 已知取舍

- 进了方言函数表的名字会跟随 `keywordCase`：默认 `lower` 下源码里的 `NVL(...)` 会被排成小写，
  与 `SUM` → `sum` 同口径。

## [1.2.1] - 2026-09-29

### 变更

- 从 SQL 脚本仓迁出为独立工具仓；脚本仓此后只作只读校准语料，不随扩展分发。
- 打包与自测脚本拆分：`test`（仓内脱敏样本）、`test:real`（真实建表语句全量校准）、
  `test:semi-scan`（语料缺分号断点统计）。

## [1.2.0] - 2026-09-29

### 新增

- 多语句文件的缺分号诊断：非末条语句末尾没有分号时给黄色波浪线（可配成红色），
  并提供「插入分号」「插入分号并空一行」两个 quick fix。
- 设置项 `adbSqlFormatter.requireSemicolonBetweenStatements`（默认开）与
  `adbSqlFormatter.missingSemicolonSeverity`（默认 `warning`）。

### 说明

- 单语句文件不做任何分号要求（与 DataGrip 一致）；格式化器永不自动补分号。

## [1.0.0 - 1.1.x]

排版规则成型期：关键字小写、逗号前置（首行不带逗号）、tab 缩进、`from 表` / `where 条件` 同行、
ADB 建表表选项逐行拆分、DataWorks `${bizdate}` 占位符保持完整。未逐版留档。
