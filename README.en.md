# ADB SQL Formatter

English | [简体中文](./README.md)

A VS Code formatter for ADB / AnalyticDB MySQL (also useful for MySQL-flavoured DataWorks scripts).
Layout target: **lowercase keywords + leading commas (no comma on the first line) + tab indent +
DataGrip-style clause breaks**, plus one table option per line in `CREATE TABLE`.

## Layout rules

One-line input:

```sql
create table demo_orders_di (order_id bigint not null comment 'order id', dt date not null comment 'snapshot day', primary key (dt, order_id)) DISTRIBUTE BY HASH(uid) PARTITION BY VALUE(dt) COMMENT = 'DWD-orders';
```

Output:

```sql
create table demo_orders_di
(
	order_id bigint not null comment 'order id'
	, dt date not null comment 'snapshot day'
	, primary key (dt, order_id)
)
distribute by hash(uid)
partition by value(dt)
comment = 'DWD-orders';
```

On the DML side:

- Keywords are always lowercased; identifiers and function names are kept as written
- Multi-line column lists use leading commas with no comma on the first line; short lists that fit
  on one line (e.g. `group by 1, 2`) stay inline
- `from table` / `where predicate` / `left join ... on ...` stay on the same line as the keyword
  (DataGrip style)
- `insert overwrite table x partition (dt = '${bizdate}')` stays on one line; DataWorks placeholders
  such as `${bizdate}` are never split
- ADB-specific functions (`nvl`, `date_trunc`, `months_between`, `array_agg`, `to_timestamp`,
  `to_date`, `to_unixtime`, `date_diff`, `regexp_extract`, `cardinality`) bind tightly to their
  parentheses: `nvl(a, 0)`. The space in table-position lists (`insert into t (a, b)`) and in
  window clauses (`over (partition by ...)`) is preserved
- Indentation follows the editor settings: tabs when the file uses tabs, otherwise spaces per
  `editor.tabSize`
- `--` and `/* */` comments are preserved verbatim

## Semicolon policy

**The formatter never inserts semicolons on its own.** It only points at the place where one belongs:

- A file with a single statement has no semicolon requirement at all (same as DataGrip)
- A file with 2 or more statements gets a squiggle on the keyword that starts the next statement
  whenever the previous one was not terminated — without a semicolon the platform parses the whole
  thing as one statement and fails with a syntax error
- Quick Fix: put the cursor on the squiggle and press the Quick Fix key (`Ctrl+.` on Windows/Linux,
  `Alt+Enter` with the IntelliJ keymap), or click the lightbulb. You can choose
  "Insert semicolon" or "Insert semicolon and a blank line"
- When a half-typed statement has unbalanced parentheses or quotes, parsing fails and the document
  is left untouched

## Installation

```
code --install-extension adb-sql-formatter-<version>.vsix
```

Then enable format-on-save per language in your user settings:

```json
"[sql]": {
	"editor.defaultFormatter": "YipTszkwan.adb-sql-formatter",
	"editor.formatOnSave": true
}
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `adbSqlFormatter.keywordCase` | `lower` | Keyword case: `upper` / `preserve` also available |
| `adbSqlFormatter.expressionWidth` | `100` | Maximum single-line width; expression lists break at leading commas beyond it |
| `adbSqlFormatter.logicalOperatorNewline` | `before` | Where to break for `and` / `or` |
| `adbSqlFormatter.linesBetweenQueries` | `1` | Blank lines between statements |
| `adbSqlFormatter.requireSemicolonBetweenStatements` | `true` | Missing-semicolon check for multi-statement files |
| `adbSqlFormatter.missingSemicolonSeverity` | `warning` | Set to `error` to mark it red |

## Localization

UI text follows the VS Code display language; English and Chinese travel on separate channels:

- Manifest strings such as setting descriptions are `%key%` placeholders in `package.json`, resolved
  from `package.nls.json` (English, default) and `package.nls.zh-cn.json` (Chinese). The extension's
  top-level `description` is not localized — the marketplace shows a single string, so it is English
- Runtime strings (diagnostics, quick fix titles) are authored in English and resolved through
  `vscode.l10n.t()` against `l10n/bundle.l10n.zh-cn.json`; `l10n/bundle.l10n.json` is the English template
- VS Code older than 1.73 has no `vscode.l10n`; the extension falls back to the English source text
- Every new string has to be added in both places, otherwise the Settings UI shows a raw
  `%adbSqlFormatter.xxx%`. `npm test` asserts exactly this

## Development and regression

```
npm test                 # in-repo self test: sanitized fixtures + statement splitting + extension wiring
npm run test:real        # full calibration against CREATE TABLE statements in a real SQL script repo
npm run test:ab          # A/B before/after: per-file comparison over real corpus, layout must not touch code
npm run test:semi-scan   # corpus stats: where multi-statement files miss their semicolons
npm run package          # vsce package
```

`test:real` needs the root of the repo holding your SQL scripts. Pick one, in this order:
`--root "<sql-script-repo>"`, the `ADB_SQL_FIXTURE_ROOT` environment variable, or auto-detection.
Auto-detection needs you to declare what a corpus repo looks like:
`ADB_SQL_FIXTURE_MARKERS=sql,etl` (comma separated; the candidate must contain `.sql` files and one of
those subdirectory names; detection never walks above your home directory). With no markers declared
nothing is auto-detected on purpose — the gates would rather report "not verified" than guess wrong.
`test:ab` uses the same resolution and only ever reads the corpus. `test:semi-scan` accepts
`ADB_SQL_FIXTURE_SKIP=<regex>` to hide paths you do not care about (nothing is filtered by default).

Without a corpus repo those three scripts print "not verified" and exit with code 2 — zero statements is
not a pass. `npm test` never needs a corpus and always runs.

- `check-ddl.js` validates each real statement: code skeleton unchanged, comment set unchanged,
  second pass idempotent (a second pass that only shifts blank lines is reported as `BLANK_DRIFT`
  and does not fail)
- `ab-format.js` compares the working tree against a git baseline (default `HEAD`, or
  `node ab-format.js <ref>`) over the whole corpus and buckets the result into identical /
  whitespace-only / case-only / code-changed. Run it after touching a layout rule: only the first
  three buckets are safe
- `test-selfcheck.js` runs on the sanitized fixtures under `test/fixtures/` with no external repo
- `test-extension.js` drives the real `activate()` path through a minimal vscode API stub to verify
  diagnostics and quick fixes

## Known limits

- ADB function names added to the dialect's function table are treated like any other function name
  and follow `keywordCase`: with the default `lower`, `NVL(...)` in your source becomes `nvl(...)`
  (`SUM` → `sum` has always behaved this way)
- The engine is sql-formatter v13 (upstream removed `commaPosition` in v15, hence the pin), so
  pixel-level alignment such as vertically aligned `as` aliases is out of reach
- Statement boundaries and the missing-semicolon check are a "parenthesis depth + top-level keyword"
  heuristic, not a full dialect grammar; exotic constructs may slip through or get flagged, which is
  why the default severity is a warning
- Shapes where the parentheses contain a query body (`create table t (select ...)`) are excluded from
  the `CREATE TABLE` rework and left as they are

## License

MIT, see `LICENSE`. The bundled sql-formatter is MIT as well; its copyright notice ships in
`node_modules/sql-formatter/LICENSE`.
