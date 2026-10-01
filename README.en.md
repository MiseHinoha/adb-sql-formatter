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
	  order_id bigint         not null comment 'order id'
	, dt       date           not null comment 'snapshot day'
	, primary key (dt, order_id)
)
distribute by hash(uid)
partition  by value(dt)
comment    = 'DWD-orders';
```

Keywords inside `CREATE TABLE` line up vertically: column name, type and the constraint keywords
(`not null` / `default …` / `comment '…'`) each get a column, and the `by` / `=` of the table options
line up too. Alignment only adds spaces — content is never touched; a row that omits a keyword leaves
that column blank, so `comment` always lands in the same column. Lines that do not match a known shape
(table-level constraints, comment-only lines, column definitions broken over several lines) are left
alone.

On the DML side:

- Keywords are always lowercased; identifiers and function names are kept as written
- Multi-line column lists use leading commas with no comma on the first line; short lists that fit
  on one line (e.g. `group by 1, 2`) stay inline
- A comma line has the same indent as its sibling content lines — each level is derived from the
  editor's `editor.tabSize`, so 2 / 3 / 4 / 8 all line up
- `from table` / `where predicate` / `left join ... on ...` stay on the same line as the keyword
  (DataGrip style)
- `insert overwrite table x partition (dt = '${bizdate}')` stays on one line; DataWorks placeholders
  such as `${bizdate}` are never split
- Window clauses stay on one line: `row_number() over (partition by ... order by ...)`; it is only
  broken up when the line exceeds `expressionWidth`. The space in `over (` is preserved
- ADB-specific functions (`nvl`, `date_trunc`, `months_between`, `array_agg`, `to_timestamp`,
  `to_date`, `to_unixtime`, `date_diff`, `regexp_extract`, `cardinality`) bind tightly to their
  parentheses: `nvl(a, 0)`. The space in table-position lists (`insert into t (a, b)`) is preserved
- Indentation is always emitted as tabs
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

**Nothing touches your files by default.** Formatting on save is **opt-in**: right after installing,
this extension only provides a formatter and a missing-semicolon hint — saving never rewrites anything
(this matches VS Code's own convention, where `editor.formatOnSave` defaults to off).

Turn it on either way:

- the first time it activates in a workspace with a SQL file it **asks once** ("format on save?") —
  once per machine; picking "No thanks" stops the asking;
- or just enable `adbSqlFormatter.formatOnSave`.

> **One switch, and it is this one**: `adbSqlFormatter.formatOnSave` decides save-time formatting —
> while it is off, **saving never reformats**; while it is on, saving reformats. **Manual formatting
> (`Shift+Alt+F`, the context menu, the Command Palette) always works**, regardless of this switch.
>
> Two paths have to be covered: the extension's own (`Ctrl+S` keybinding + save hook), stopped
> directly by the switch; and the editor's own `editor.formatOnSave`, which is *a separate path* (VS
> Code calls the formatter this extension registers) and cannot be blocked at runtime — it is called
> *before* extensions receive the save hook (10-50ms earlier), so a save-time call cannot be told
> apart from a manual one. Therefore, the moment the switch is turned off, the extension also turns
> `editor.formatOnSave` off for `[sql]` / `[mysql]` (telling you, with a one-click undo); on
> activation it notices that combination once and offers the same.

Once on, two layers make sure it always happens:

| Layer | When it fires | Why it is needed |
| --- | --- | --- |
| Keybinding + command `adbSqlFormatter.formatAndSave` | Pressing save inside a sql / mysql editor (non-readonly file) | Formats on its own and then calls `workbench.action.files.save`, so it **never goes through VS Code's formatter resolution** — the built-in `formatOnSave` stops doing anything once `editor.defaultFormatter` names a missing extension ("… is configured as formatter but not available"), this path is unaffected |
| Save hook `onWillSaveTextDocument` | Saves that never touch that key: focus-out save, saving from the Explorer or the SCM view | Broader coverage; the two never double-format (a version the command already formatted is skipped) |

Also note that VS Code treats the save hooks of **all** extensions as one batch: if any single hook
throws or times out, the whole batch of edits is dropped for that save (`onWillSaveTextDocument-listener
from extension '…' threw ERROR` / `listener failed` in the logs). Taking over the key sidesteps that
too. The command records the version it formatted, so the save that follows does not format again, and
if formatting fails the save still happens — your change is never lost.

No editor setting is required: with the switch on it works with `editor.formatOnSave` off and with
`editor.defaultFormatter` unset or pointing somewhere wrong. All of it is gated by
`adbSqlFormatter.formatOnSave`, which is off by default (see Installation above).

**Manual formatting is always available**, regardless of the save switch:

- `Shift+Alt+F` (mac `Shift+Option+F`)
- right-click → **ADB SQL Formatter: Format Document** (forces *this* formatter when another SQL
  formatter is set as your default)
- Command Palette → `ADB SQL Formatter: Format and Save` (formats and writes)

If `editor.defaultFormatter` names an extension that is **not installed** (common after an extension
changes its publisher and the old id stays in your settings), VS Code itself reports
"configured as formatter but not available" on save and formats nothing. This extension detects that
configuration, tells you once, and offers a one-click switch to `YipTszkwan.adb-sql-formatter`
(with a "do not show again" option).

If you prefer to let the editor own it, the classic setup still works (the id must be the real
`publisher.name` from the Marketplace — for this extension that is `YipTszkwan.adb-sql-formatter`):

```json
"[sql]": {
	"editor.defaultFormatter": "YipTszkwan.adb-sql-formatter",
	"editor.formatOnSave": true
}
```

With both in place nothing is formatted twice: when format-on-save is on *and* the default formatter
names an extension that actually exists, the save hook stands down and lets VS Code do it (the
keybinding path still handles the key itself).

Two entries are knowingly not covered: **auto save** (after a delay, `reason = AfterDelay`) and
**Save All** (`Cmd+K S`). The first follows the trade-off VS Code's own `formatOnSave` makes (otherwise
the file is reflowed while you type and the cursor jumps); the second has VS Code skipping all save
hooks by design (`saveAll` passes `skipSaveParticipants`). Press `Ctrl+S` for those.

### Customizing the shortcut

| What you want | How |
| --- | --- |
| **Bind "format and save" to a different key** | `Cmd+K Cmd+S` to open the Keyboard Shortcuts editor → search `adbSqlFormatter` → assign any key to **Format and Save** (or write `{ "key": "your-key", "command": "adbSqlFormatter.formatAndSave" }` in `keybindings.json`) |
| **Keep this extension off `Ctrl/Cmd+S`** | Turn off `adbSqlFormatter.takeOverSaveKey` (takes effect immediately, no window reload; it only takes that key over while format-on-save is on). `Ctrl+S` then belongs to the editor or your keymap again — note **formatting on save still happens** (that is the save hook plus `formatOnSave`); turn the next row off to stop that |
| **Turn save formatting on / off** | `adbSqlFormatter.formatOnSave` (off by default). Turning it off also aligns `editor.formatOnSave` for `[sql]`/`[mysql]` (otherwise VS Code's own path would still reformat) and gives you an undo; turning it on makes `Ctrl+S` reformat before writing. Manual formatting is unaffected either way |
| **Another extension owns `Ctrl/Cmd+S` and saves everything** | Unbind that entry in `keybindings.json` (see the IntelliJ keymap case above) |

> Note: VS Code does not let an extension declare keybindings at runtime, so "pick your own key inside
> the extension" is not possible — use the Keyboard Shortcuts editor above. The `takeOverSaveKey`
> switch is implemented with `setContext` plus a manifest `when` clause, so it applies instantly.

## Coexisting with other SQL extensions

`.sql` is shared ground: other SQL extensions will fight over it. This extension contributes exactly
two things — **formatting** and a **missing-semicolon hint**. Its diagnostics always have the source
`ADB SQL Formatter` and it **never reports syntax errors**. Two common clashes:

- **SQL Server (mssql)** parses `.sql` as T-SQL (it ships the `Microsoft.SqlServer.TransactSql.ScriptDom`
  parser), so ADB / Hive style DDL lights up red — `Incorrect syntax near 'comment'`,
  `… near 'dt'. Expected '(' or SELECT.` is the T-SQL parser talking (`distribute by` / `partition by` /
  `comment` / `index_all` / `table_properties` / `lifecycle` do not exist in T-SQL). To quiet it down,
  pick one:

  ```json
  "mssql.intelliSense.enableErrorChecking": false,  // syntax check off, completion/hover kept
  "mssql.intelliSense.enableIntelliSense": false    // turn the whole language service off
  ```

  You can also right-click that extension → `Disable (Workspace)` to silence it in this workspace only.

- **IntelliJ keymap** (`k--kato.intellij-idea-keybindings`) binds `Cmd+S` to Save All
  (`workbench.action.files.saveAll`), and VS Code's `saveAll` carries `skipSaveParticipants:!0` —
  it **skips every extension's save hook by design**, so no formatter can ever run on that path
  (the symptom is exactly "manual formatting works, saving does not"). To get "save and format" back
  on `Cmd+S`, unbind it in `keybindings.json` (Save All stays available on `Cmd+K S`):

  ```json
  [{ "key": "cmd+s", "command": "-workbench.action.files.saveAll" }]
  ```

- **Formatter conflicts**: SQL Server / SQLTools / MySQL also claim to format `sql`, so a manually
  triggered Format Document pops VS Code's "Select a formatter" picker. Point the default formatter at
  this extension (`editor.defaultFormatter` = `YipTszkwan.adb-sql-formatter`; the extension's own
  bad-config notice offers to set it) and saves will use that default without asking again.
  **Do not make a T-SQL formatter the default**: it reflows ADB syntax as T-SQL and breaks
  `distribute by` / `comment` and friends.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `adbSqlFormatter.keywordCase` | `lower` | Keyword case: `upper` / `preserve` also available |
| `adbSqlFormatter.expressionWidth` | `100` | Maximum single-line width; expression lists break at leading commas beyond it and window clauses stay broken |
| `adbSqlFormatter.logicalOperatorNewline` | `before` | Where to break for `and` / `or` |
| `adbSqlFormatter.linesBetweenQueries` | `1` | Blank lines between statements |
| `adbSqlFormatter.formatOnSave` | `false` | The **single switch** for format-on-save (opt-in): while on, `Ctrl+S` reformats before writing; while off, saving never reformats (and `editor.formatOnSave` is aligned off to match). Manual formatting is independent of it |
| `adbSqlFormatter.takeOverSaveKey` | `true` | Take over `Ctrl/Cmd+S` while the setting above is on; off means relying on the save hook, which other keymaps can bypass |
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
npm run package          # vsce package (writes to dist/)
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

Packaging and publishing are documented in `RELEASING.md` (the Marketplace publish goes through
trusted publishing — no PAT is stored anywhere).

## Known limits

- ADB function names added to the dialect's function table are treated like any other function name
  and follow `keywordCase`: with the default `lower`, `NVL(...)` in your source becomes `nvl(...)`
  (`SUM` → `sum` has always behaved this way)
- The engine is sql-formatter v13 (upstream removed `commaPosition` in v15, hence the pin). Pixel-level
  alignment is limited to **vertically aligned keywords inside `CREATE TABLE`**: `AS` aliases in
  `select` lists and `=` signs in `where` clauses are not aligned
- A column definition the aligner cannot parse is skipped line by line (table-level constraints,
  `--` comment lines, definitions broken over several lines): those lines stay as they are, content is
  never touched, and a table with fewer than 2 parseable columns is not aligned at all
- Statement boundaries and the missing-semicolon check are a "parenthesis depth + top-level keyword"
  heuristic, not a full dialect grammar; exotic constructs may slip through or get flagged, which is
  why the default severity is a warning
- Shapes where the parentheses contain a query body (`create table t (select ...)`) are excluded from
  the `CREATE TABLE` rework and left as they are

## License

MIT, see `LICENSE`. The bundled `sql-formatter` is MIT as well; the list of third-party components and
where their license texts live is in `THIRD_PARTY_NOTICES.md`, and each notice ships inside the package
under `node_modules/<package>/LICENSE`.
