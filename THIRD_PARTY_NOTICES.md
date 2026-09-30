# 第三方声明 / Third-Party Notices

本扩展的发布包（`.vsix`）内含下列第三方组件。各组件版权声明原文随包分发，路径见下表。

| 组件 | 版本 | 许可 | 版权声明原文位置 |
| --- | --- | --- | --- |
| sql-formatter | 13.1.0 | MIT | `node_modules/sql-formatter/LICENSE` |
| nearley | 2.20.1 | MIT | `node_modules/nearley/LICENSE.txt` |
| moo | 0.5.3 | BSD-3-Clause | `node_modules/moo/LICENSE` |
| randexp | 0.4.6 | MIT | `node_modules/randexp/LICENSE` |
| railroad-diagrams | 1.0.0 | CC0-1.0 | 见其 `package.json` 的 `license` 字段（CC0 不要求署名） |
| ret | 0.1.15 | MIT | `node_modules/ret/LICENSE` |
| discontinuous-range | 1.0.0 | MIT | `node_modules/discontinuous-range/LICENSE` |
| commander | 2.20.3 | MIT | `node_modules/commander/LICENSE` |
| argparse | 2.0.1 | Python-2.0 | `node_modules/argparse/LICENSE` |
| get-stdin | 8.0.0 | MIT | `node_modules/get-stdin/license` |

`sql-formatter` 是实际参与排版的引擎，其余为它的传递依赖（解析器 nearley 及其工具依赖）。
`sql-formatter` 锁在 v13：v15 起上游移除了 `commaPosition`，而本扩展的逗号前置排版依赖该选项。

## English

This VSIX bundles the third-party packages listed above. Each package's license text ships inside the
package under `node_modules/<package>/LICENSE*`; `railroad-diagrams` is CC0-1.0 and declares its license
in its `package.json`. `sql-formatter` is the formatting engine and the rest are its transitive
dependencies. It is pinned to v13 because upstream removed `commaPosition` in v15, which this extension
relies on.
