// 半截 SQL / 无分号 场景验证：node test-partial.js
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

const cases = [
	['原本就没有分号的建表', "create table t_demo (\nuid bigint not null,\nprimary key (uid)\n) distribute by hash(uid)\ncomment 'x'"],
	['建表写到一半（括号未闭合）', "create table t_demo (\n\tuid bigint not null,\n\t"],
	['select 写到一半（where 后空白）', "select a.uid, b.amount from t as a left join u as b on a.uid = b.uid where "],
	['select 只写了关键字', "sel"],
	['字符串未闭合', "insert into t values (1, 'abc"],
	['括号未闭合的函数', "select count(distinct uid from t"],
	['多语句：第一条有分号第二条没有', "select 1;\nselect a,b from t"],
	['group by 刚打了逗号', "select a from t group by "],
];

cases.forEach(([name, sql]) => {
	console.log(`\n===== ${name} =====`);
	console.log('输入: ' + JSON.stringify(sql));
	try {
		const out = formatSql(sql, cfg, 4);
		console.log('输出: ' + JSON.stringify(out));
		console.log('是否新增分号:', /;\s*$/.test(out) && !/;\s*$/.test(sql));
	} catch (e) {
		console.log('抛错（扩展会放弃格式化、不改文档）:', e.message.slice(0, 80));
	}
});
