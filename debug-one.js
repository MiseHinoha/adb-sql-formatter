// 逐步跟踪某条建表语句的 DDL 重排环节：node debug-one.js 1
// 扫描根与 check-ddl.js 一致，序号可直接照抄它报出来的编号
const { collectFromFixtureRoot } = require('./extract-ddl');
const { formatSql, _internals } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

const fixtures = collectFromFixtureRoot();
if (!fixtures) process.exit(0);
const idx = Number(process.argv[2] || 1);
const f = fixtures[idx];
if (!f) {
	console.log(`无此序号 ${idx}（本次扫描共 ${fixtures.length} 条，序号从 0 起）`);
	process.exit(1);
}
console.log('=== 原文尾部 ===\n' + JSON.stringify(f.stmt.slice(-180)));

const raw = _internals.formatDialect(f.stmt, {
	dialect: _internals.buildDialect(),
	keywordCase: 'lower',
	commaPosition: 'before',
	useTabs: false,
	tabWidth: 4,
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	paramTypes: { custom: [{ regex: String.raw`\$\{[a-zA-Z0-9_.]+\}` }] },
});
const stage2 = _internals.joinShortLists(_internals.toTabs(raw, 4), 100);
console.log('\n=== sql-formatter + tab + 短列表（进 reformatDdl 之前）尾部 ===\n' + JSON.stringify(stage2.slice(-180)));
console.log('\n=== 该行是否 create table 开头:', /^(\s*)create\s+table\s/i.test(stage2.split('\n')[0]));
console.log('=== 各行的分号/深度终止线索:');
stage2.split('\n').forEach((l, i) => {
	if (/;\s*$/.test(l)) console.log('   ; 终止于行', i, JSON.stringify(l.slice(0, 60)));
});
const ddlLine = stage2.split('\n').find((l) => /^\s*create\s+table\s/i.test(l));
console.log('=== 找到 create 行:', JSON.stringify(ddlLine && ddlLine.slice(0, 60)));
console.log('\n=== squeeze(tail) 结果 ===');
const stmt = stage2.trim();
const m = stmt.match(/^create\s+table\s+(if\s+not\s+exists\s+)?[`0-9a-zA-Z_.]+\s*/i);
if (m) {
	const rest = stmt.slice(m[0].length);
	const open = rest.indexOf('(');
	const close = _internals.matchParen(rest, open);
	console.log(JSON.stringify(_internals.squeeze(rest.slice(close + 1))));
	console.log('\n=== splitOptionLines 结果 ===');
	console.log(JSON.stringify(_internals.splitOptionLines(rest.slice(close + 1)), null, 1));
}
console.log('\n=== 最终输出尾部 ===\n' + JSON.stringify(formatSql(f.stmt, cfg, 4).slice(-180)));
