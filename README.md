# ADB SQL Formatter

[English](./README.en.md) | 简体中文

面向 ADB / AnalyticDB MySQL（也适用 DataWorks 上的 MySQL 方言脚本）的 VSCode 格式化扩展。
排版目标：**关键字小写 + 逗号前置（首行不带逗号）+ tab 缩进 + DataGrip 式子句换行**，
并对 ADB 建表语句的表选项做逐行拆分。

## 排版规则

输入挤成一行的 SQL：

```sql
create table demo_orders_di (order_id bigint not null comment '订单id', dt date not null comment '日期', primary key (dt, order_id)) DISTRIBUTE BY HASH(uid) PARTITION BY VALUE(dt) COMMENT = 'DWD-订单';
```

输出：

```sql
create table demo_orders_di
(
	  order_id bigint         not null comment '订单id'
	, dt       date           not null comment '日期'
	, primary key (dt, order_id)
)
distribute by hash(uid)
partition  by value(dt)
comment    = 'DWD-订单';
```

建表区的关键字会**纵向对齐**：列名、类型、约束关键字（`not null` / `default …` / `comment '…'`）各占一列，
表选项的 `by` 与 `=` 也对齐。对齐只补空格、不动任何内容；某行没写某个关键字时留空位，
所以 `comment` 始终落在同一列。解析不出固定形态的行（表级约束、注释行、被拆成多行的列定义）原样保留。

DML 侧：

- 关键字一律小写；标识符与函数名保留原样
- 多行字段列表逗号前置，首行不带逗号；`group by 1, 2` 等能放进一行的短列表保持行内
- 逗号行与同级内容行缩进一致 —— 每级宽度按 `editor.tabSize` 折算，2 / 3 / 4 / 8 都对齐
- `from 表` / `where 条件` / `left join ... on ...` 与关键字同行（DataGrip 风格）
- `insert overwrite table x partition (dt = '${bizdate}')` 保持一行；DataWorks 占位符 `${bizdate}` 不拆坏
- 窗口子句不换行：`row_number() over (partition by ... order by ...)` 排成一行，
  **只有整行超过 `expressionWidth` 时才拆开**；`over (` 的空格照旧保留
- ADB 专有函数（`nvl` / `date_trunc` / `months_between` / `array_agg` / `to_timestamp` / `to_date` /
  `to_unixtime` / `date_diff` / `regexp_extract` / `cardinality`）紧贴括号，排成 `nvl(a, 0)`；
  表名位置的 `insert into t (a, b)` 的空格照旧保留
- 缩进一律输出 tab
- `--` 与 `/* */` 注释原样保留

## 分号策略

**格式化器永不自动补分号**，只在应当出现的位置提示：

- 文件只有 1 条语句 → 不做任何分号要求（与 DataGrip 一致）
- 文件有 2 条及以上语句 → 非末条语句末尾缺分号时，在下一条语句关键字处给波浪线提示
  （多语句缺分号会被平台当成一条语句解析，直接语法错）
- Quick Fix：光标停在波浪线上按 VSCode 的 Quick Fix 键（默认 Windows/Linux 为 `Ctrl+.`；
  装了 IntelliJ 键位方案则是 `Alt+Enter`），或点灯泡图标，可选「插入分号」/「插入分号并空一行」
- 括号或引号未闭合的半截语句解析失败时，文档保持不动

## 安装

```
code --install-extension adb-sql-formatter-<版本>.vsix
```

**默认不碰你的文件。**「保存即格式化」是**opt-in**：装上之后本扩展只提供排版器和缺分号提示，
不会在保存时改动任何东西（与 VS Code 自己的约定一致 —— `editor.formatOnSave` 默认也是关的）。

开启方式二选一：

- 第一次在有 SQL 文件的工作区里激活时会**问一次**「要在保存时格式化吗？」（每台机器只问一次，
  选「不用了」就不再打扰）；
- 或者直接把设置 `adbSqlFormatter.formatOnSave` 打开。

> **唯一的开关**：`adbSqlFormatter.formatOnSave` 决定「保存时自动格式化」——关着时**保存绝不重排**，
> 打开时保存即重排。**手动排版（`Shift+Alt+F`、右键、命令面板）任何时候都可用**，不受它影响。
>
> 要管住两条路：本扩展自己那条（`Ctrl+S` 键位 + 保存钩子）直接按开关停；编辑器自带的 `editor.formatOnSave`
> 是**另一条路**（VS Code 自己调本扩展的排版器），运行时拦不住 —— 实测它会在扩展收到保存钩子**之前**就调用
> （早 10~50ms），无法分辨这次调用是不是保存。所以：开关被关掉的那一刻，本扩展会把 `[sql]` / `[mysql]` 的
> `editor.formatOnSave` 一起关掉（会告知你，可一键撤销）；激活时若发现这种组合也会提示一次。

开启后由两层保证一定生效：

| 层 | 触发时机 | 为什么需要它 |
| --- | --- | --- |
| 键位 + 命令 `adbSqlFormatter.formatAndSave` | 在 sql / mysql 编辑器里按保存（非只读文件） | 自己格式化再调 `workbench.action.files.save`，**不走 VS Code 的「格式化程序解析」** —— 编辑器自带的 `formatOnSave` 一旦遇到 `defaultFormatter` 指错就整条不干活（报 "Extension … is configured as formatter but not available"），这条路不受它影响 |
| 保存钩子 `onWillSaveTextDocument` | 不经过这个键位的保存：失焦保存、从资源管理器或源代码管理面板保存等 | 覆盖面更广；与键位那层互不重复（命令刚格式化过的版本会被跳过） |

另外，VS Code 把一次保存里**所有扩展**的保存钩子当一批处理：任何一个钩子抛错或超时，整批编辑都会被丢掉
（日志里能看到 `onWillSaveTextDocument-listener from extension '…' threw ERROR` / `listener failed`）。
自己接住键位就绕开了这个不确定因素。命令做完会记下「这个版本已格式化」，紧接着的保存不重复处理；
格式化失败也保证保存照旧发生，不会丢改动。

本扩展不依赖编辑器设置：开关打开后，`editor.formatOnSave` 关着、`editor.defaultFormatter` 没配或配错都照常工作
（`adbSqlFormatter.formatOnSave` 默认关，见上面「安装」一节）。命令面板里也能找到 `ADB SQL Formatter: Format and Save`。

**手动排版随时可用**，与保存开关无关：

- `Shift+Alt+F`（mac `Shift+Option+F`）
- 右键 → **ADB SQL Formatter: 格式化文档**（当默认格式化程序被设成别的 SQL 扩展时，用这条强制走本扩展）
- 命令面板 → `ADB SQL Formatter: Format and Save`（格式化并落盘）

如果 `editor.defaultFormatter` 指向一个**没装的扩展**（常见于扩展换过 publisher、旧 ID 留在设置里），
VS Code 自己会在保存时报 "configured as formatter but not available" 且不格式化；本扩展检测到这种配置会
提示一次，并提供一键改成 `YipTszkwan.adb-sql-formatter`（含「不再提示」）。

若你更想交给编辑器统一管理，也可以照旧配（注意 ID 必须是 Marketplace 上真实的
`发布者.扩展名`，本扩展是 `YipTszkwan.adb-sql-formatter`）：

```json
"[sql]": {
	"editor.defaultFormatter": "YipTszkwan.adb-sql-formatter",
	"editor.formatOnSave": true
}
```

配了也不会重复格式化：`formatOnSave` 开着且默认格式化程序**指向一个真实装着的扩展**时，保存钩子让位给
VS Code（键位那条路径照旧自己处理）。

两个已知不覆盖的入口：**自动保存**（延迟触发，`reason = AfterDelay`）与**「全部保存」**（`Cmd+K S`）——
前者跟随 VS Code 自带 `formatOnSave` 的取舍（否则边打字边重排，光标乱跳），后者 VS Code 按设计跳过
所有保存钩子（`saveAll` 带 `skipSaveParticipants`）。这两个入口想格式化就按 `Ctrl+S`。

### 快捷键自定义

| 想做的事 | 怎么做 |
| --- | --- |
| **换成别的键**触发「格式化并保存」 | `Cmd+K Cmd+S` 打开键位设置 → 搜 `adbSqlFormatter` → 给 **Format and Save** 绑任意键（也可以直接在 `keybindings.json` 里写 `{ "key": "你的键", "command": "adbSqlFormatter.formatAndSave" }`） |
| **不想让本扩展占 `Ctrl/Cmd+S`** | 设置里关掉 `adbSqlFormatter.takeOverSaveKey`（即时生效，不用重载窗口；只有「保存即格式化」打开时它才真正接管这个键）。之后 `Ctrl+S` 由编辑器/你的键位方案决定 —— 注意**保存时格式化仍会生效**（那是保存钩子 + `formatOnSave` 那一层），要停请关下面那条 |
| **关掉/打开保存即格式化** | `adbSqlFormatter.formatOnSave`（默认 `false`）。关掉时本扩展会把 `[sql]`/`[mysql]` 的 `editor.formatOnSave` 也对齐关掉（否则 VS Code 那条路仍会重排），并给你一个撤销入口；打开后 `Ctrl+S` 先重排再落盘。手动排版不受影响 |
| **别的扩展抢了 `Ctrl/Cmd+S` 且它走的是「全部保存」** | 在 `keybindings.json` 里解绑那条（见上一条「与其它 SQL 扩展共存」里的 IntelliJ 键位方案） |

> 说明：VS Code 不允许扩展在运行时声明键位，所以「本扩展帮你提供任意键」做不到 —— 换键走上面第一行的
> UI；`takeOverSaveKey` 这个开关是用 `setContext` + manifest 的 `when` 条件实现的，改完即时生效。

## 与其它 SQL 扩展共存

`.sql` 是公共地盘，装了别的 SQL 扩展时会互相抢。本扩展只提供两件事：**排版**与**缺分号提示**；
诊断来源固定是 `ADB SQL Formatter`，**从不报语法错**。常见的两种干扰：

- **SQL Server (mssql)** 把 `.sql` 当成 T-SQL 解析（它自带 `Microsoft.SqlServer.TransactSql.ScriptDom`
  解析器），于是 ADB / Hive 风格写法整片报红 —— 截图里的 `"comment"附近有语法错误。`、
  `"dt"附近有语法错误。应为 '('，或 SELECT。` 就是 T-SQL 解析器的原话
  （`distribute by` / `partition by` / `comment` / `index_all` / `table_properties` / `lifecycle`
  在 T-SQL 里都不存在）。想让它安静下来，任选其一：

  ```json
  "mssql.intelliSense.enableErrorChecking": false,  // 只关语法检查，保留补全/悬停
  "mssql.intelliSense.enableIntelliSense": false    // 不用 SQL Server 就整套关掉
  ```

  也可以右键该扩展 → `Disable (Workspace)`，只在这个工作区关掉。

- **IntelliJ 键位方案**（`k--kato.intellij-idea-keybindings`）会把 `Cmd+S` 绑成「全部保存」
  （`workbench.action.files.saveAll`），而 VS Code 的 `saveAll` 源码里带 `skipSaveParticipants:!0` ——
  **按设计跳过所有扩展的保存钩子**，那条路上任何格式化扩展都不会生效（症状正是「手动格式化没问题、
  保存时不动」）。想让 `Cmd+S` 回到「保存并格式化」，在 `keybindings.json` 里把这一条解绑即可
  （「全部保存」仍可用 `Cmd+K S`）：

  ```json
  [{ "key": "cmd+s", "command": "-workbench.action.files.saveAll" }]
  ```

- **格式化程序冲突**：SQL Server / SQLTools / MySQL 等也声称能格式化 `sql`，所以手动触发「格式化文档」
  时 VS Code 会弹「选择格式化程序」。把默认格式化程序指向本扩展即可
  （`editor.defaultFormatter` = `YipTszkwan.adb-sql-formatter`，设置里那条坏配置的提示也会帮你设），
  之后保存走默认值、不再弹。**别把默认值设成 T-SQL 那一类**：它会按 T-SQL 规则重排 ADB 语法，
  `distribute by` / `comment` 这些会被改坏。

## 设置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `adbSqlFormatter.keywordCase` | `lower` | 关键字大小写，可选 `upper` / `preserve` |
| `adbSqlFormatter.expressionWidth` | `100` | 单行最大宽度，超出后表达式列表按逗号前置换行、窗口子句保持拆行 |
| `adbSqlFormatter.logicalOperatorNewline` | `before` | `and` / `or` 换行位置 |
| `adbSqlFormatter.linesBetweenQueries` | `1` | 多条 SQL 之间空行数 |
| `adbSqlFormatter.formatOnSave` | `false` | 保存即格式化的**唯一开关**（opt-in）：打开后 `Ctrl+S` 先重排再落盘；关着时保存绝不重排（并把 `editor.formatOnSave` 对齐关掉）。手动排版与它无关 |
| `adbSqlFormatter.takeOverSaveKey` | `true` | 在上面那条打开的前提下接管 `Ctrl/Cmd+S`；关掉则只依赖保存钩子（可被别的键位方案影响） |
| `adbSqlFormatter.requireSemicolonBetweenStatements` | `true` | 多语句文件的缺分号提示开关 |
| `adbSqlFormatter.missingSemicolonSeverity` | `warning` | 提示级别，可改 `error` 标红 |

## 本地化

界面文案跟随 VSCode 显示语言，中英双语各走各的通道：

- 设置项等清单文案：`package.json` 里写 `%key%`，由 `package.nls.json`（英文，默认）与
  `package.nls.zh-cn.json`（中文）提供文案。扩展的 `description` 不参与 nls，商店里只显示一条，故写英文
- 运行时文案（诊断消息、quick fix 标题）：代码里是英文源文，经 `vscode.l10n.t()` 查
  `l10n/bundle.l10n.zh-cn.json` 取中文；`l10n/bundle.l10n.json` 是英文模板
- 低于 1.73 的 VSCode 没有 `vscode.l10n`，此时退回英文源文，不影响功能
- 加新文案必须两处都补，否则用户在设置界面会看到 `%adbSqlFormatter.xxx%` 这样的坏值——
  `npm test` 里有专门的一致性断言兜这条

## 开发与回归

```
npm test                 # 仓内自测：脱敏样本 + 语句切分单测 + 扩展接线测试
npm run test:real        # 全量校准：扫描真实 SQL 脚本仓的建表语句
npm run test:ab          # 改动前后 A/B：真实语料逐文件比对，排版不许动到代码
npm run test:semi-scan   # 语料统计：多语句文件的缺分号断点分布
npm run package          # vsce 打包 vsix
```

`test:real` 需要指向存放 SQL 脚本的仓库根，按优先级任选：
`--root "<SQL 脚本仓根目录>"`、环境变量 `ADB_SQL_FIXTURE_ROOT`，或自动探测。
自动探测需要你声明语料仓的目录特征：`set ADB_SQL_FIXTURE_MARKERS=sql,etl`
（逗号分隔，候选目录须含 `.sql`，且含其中任一子目录名；探测不会越过用户主目录）。
不声明特征时不自动认任何目录 —— 探测宁可空着报「未验证」，也不猜错。
`test:ab` 同样走这套根解析，且只读语料，不写任何脚本文件。
`test:semi-scan` 可用 `ADB_SQL_FIXTURE_SKIP=<正则>` 过滤不想看的路径（默认不过滤）。

没有语料仓时，这三个脚本打印「未验证」并以退出码 2 结束 —— 0 条语料不算通过。
`npm test` 不依赖语料仓，任何时候都能跑。

- `check-ddl.js` 会对真实脚本逐条校验：代码骨架不变、注释集合不变、二次格式化幂等
  （二次格式化仅空行差异记为 BLANK_DRIFT，不判失败）
- `ab-format.js` 拿工作树与某个 git 基线（默认 `HEAD`，可 `node ab-format.js <ref>`）
  对全量语料比对输出，分四档：完全一致 / 仅空白差异 / 仅大小写差异 / 真动了代码。
  改排版规则后跑一次，只有前三档才算安全 —— 它拦的是"顺手改了语义"
- `test-selfcheck.js` 用 `test/fixtures/` 下的脱敏样本自测，不依赖外部脚本仓
- `test-extension.js` 用最小 vscode API 桩跑真实 activate 链路，验证诊断与 quick fix

打包与发布流程见 `RELEASING.md`（Marketplace 上架走 trusted publishing，不存 PAT）。

## 已知边界

- 补进方言函数表的 ADB 函数名与其它函数名同待遇，会跟随 `keywordCase`：默认 `lower` 下
  源码里的 `NVL(...)`、`MONTHS_BETWEEN(...)` 会被排成小写（`SUM` → `sum` 一直就是这个行为）
- 引擎基于 sql-formatter v13（v15 起官方移除了 `commaPosition`，故锁版本）。像素级对齐只做了
  **建表关键字纵向对齐**这一类：`select` 的 AS 别名、`where` 条件的等号不做对齐
- 建表对齐遇到解析不出的形态会整行跳过（表级约束、`--` 注释行、被拆成多行的列定义），
  这些行不对齐但不改动内容；表里能解析的列少于 2 行时不做对齐
- 语句边界与缺分号判定是「括号深度 + 顶层语句关键字」启发式，不是完整方言语法树，
  极端写法可能漏报或误报，因此默认级别是警告
- `create table t (select ...)` 这类括号内含查询体的形态不参与建表重排，保持原样

## 许可

MIT，见 `LICENSE`。依赖的 sql-formatter 同为 MIT；第三方组件与其版权声明原文清单见
`THIRD_PARTY_NOTICES.md`，声明文件随包分发在 `node_modules/<包名>/LICENSE`。
