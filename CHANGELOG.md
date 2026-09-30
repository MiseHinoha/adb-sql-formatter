# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
用户可见的排版规则变化一律算次版本（会重排已有文件），只增提示不改排版的算修订号。

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
