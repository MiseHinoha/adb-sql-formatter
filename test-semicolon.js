// 验证解析器能否识别「粘连语句」（缺分号的真实症状）：node test-semicolon.js
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

const cases = [
	['粘连: DDL + insert 无分号', "create table t (a int) comment 'x' insert into t values (1)"],
	['粘连: select1 select2', 'select 1 select 2'],
	['粘连: insert values + select', 'insert into b (a) values (1) select a from b'],
	['粘连: update + insert', 'update t set x = 1 insert into t values (2)'],
	['合法: update...set（启发式曾误报的形态）', 'update a join (select 1 as x) b on a.id = b.x set a.y = 1'],
	['合法: insert...select', 'insert into t (a) select a from u'],
	['合法: 两句带分号', 'select 1; select 2'],
];

cases.forEach(([label, sql]) => {
	try {
		formatSql(sql, cfg, 4);
		console.log(label.padEnd(36), '→ 解析通过');
	} catch (e) {
		console.log(label.padEnd(36), '→ 抛错:', String(e.message).split('\n')[0].slice(0, 64));
	}
});
