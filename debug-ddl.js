// 诊断问题样本为何未走 DDL 重排：node debug-ddl.js
// 扫描根与 check-ddl.js 一致，序号可直接照抄它报出来的编号
const { collectFromFixtureRoot } = require('./extract-ddl');
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

const fixtures = collectFromFixtureRoot();
if (!fixtures) process.exit(0);
const targets = (process.argv[2] || '7,21,34,118,119,160,247,345,346').split(',').map(Number);

targets.forEach((i) => {
	const f = fixtures[i];
	if (!f) return;
	const out = formatSql(f.stmt, cfg, 4);
	const lines = out.split('\n');
	console.log(`\n##### #${i} ${f.file.split('/').slice(-1)[0]}`);
	console.log('  原文以分号结尾:', /;\s*$/.test(f.stmt.trim()));
	console.log('  输出以分号结尾:', /;\s*$/.test(out.trim()));
	console.log('  首行:', JSON.stringify(lines[0]));
	console.log('  第二行:', JSON.stringify(lines[1] || ''));
	console.log('  末两行:', JSON.stringify(lines.slice(-2).join(' ⏎ ')));
});
