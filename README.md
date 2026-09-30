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
	order_id bigint not null comment '订单id'
	, dt date not null comment '日期'
	, primary key (dt, order_id)
)
distribute by hash(uid)
partition by value(dt)
comment = 'DWD-订单';
```

DML 侧：

- 关键字一律小写；标识符与函数名保留原样
- 多行字段列表逗号前置，首行不带逗号；`group by 1, 2` 等能放进一行的短列表保持行内
- `from 表` / `where 条件` / `left join ... on ...` 与关键字同行（DataGrip 风格）
- `insert overwrite table x partition (dt = '${bizdate}')` 保持一行；DataWorks 占位符 `${bizdate}` 不拆坏
- ADB 专有函数（`nvl` / `date_trunc` / `months_between` / `array_agg` / `to_timestamp` / `to_date` /
  `to_unixtime` / `date_diff` / `regexp_extract` / `cardinality`）紧贴括号，排成 `nvl(a, 0)`；
  表名位置的 `insert into t (a, b)` 与窗口 `over (partition by ...)` 的空格照旧保留
- 缩进跟随编辑器设置：文件用 tab 就输出 tab，用空格则按 `editor.tabSize`
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

然后在用户设置里按语言开启保存即格式化（示例）：

```json
"[sql]": {
	"editor.defaultFormatter": "YipTszkwan.adb-sql-formatter",
	"editor.formatOnSave": true
}
```

## 设置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `adbSqlFormatter.keywordCase` | `lower` | 关键字大小写，可选 `upper` / `preserve` |
| `adbSqlFormatter.expressionWidth` | `100` | 单行最大宽度，超出后表达式列表按逗号前置换行 |
| `adbSqlFormatter.logicalOperatorNewline` | `before` | `and` / `or` 换行位置 |
| `adbSqlFormatter.linesBetweenQueries` | `1` | 多条 SQL 之间空行数 |
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

## 已知边界

- 补进方言函数表的 ADB 函数名与其它函数名同待遇，会跟随 `keywordCase`：默认 `lower` 下
  源码里的 `NVL(...)`、`MONTHS_BETWEEN(...)` 会被排成小写（`SUM` → `sum` 一直就是这个行为）
- 引擎基于 sql-formatter v13（v15 起官方移除了 `commaPosition`，故锁版本），
  做不到 AS 别名纵向对齐这类像素级排版
- 语句边界与缺分号判定是「括号深度 + 顶层语句关键字」启发式，不是完整方言语法树，
  极端写法可能漏报或误报，因此默认级别是警告
- `create table t (select ...)` 这类括号内含查询体的形态不参与建表重排，保持原样

## 许可

MIT，见 `LICENSE`。依赖的 sql-formatter 同为 MIT，其版权声明保留在
`node_modules/sql-formatter/LICENSE`。
