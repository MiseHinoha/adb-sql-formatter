// 格式化效果验证脚本（与 extension.js 共用 formatter-core）：node test.js
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

const samples = [
	// 1. 标准 select：逗号前置 + from/where 同行 + group by 短列表行内
	"select a.uid, b.ext_id, sum(a.amount_abs) as coin_amount from demo_stats.dwd_trans_di as a left join demo_stats.dim_user as b on a.buyer_uid = b.uid where a.dt = '${bizdate}' and a.trans_type = 101 group by 1,2",
	// 2. insert overwrite
	"insert overwrite table demo_stats.dws_channel_sell_di partition (dt = '${bizdate}') select dt, seller_uid, count(*) as order_cnt, sum(amount_abs) as sell_coin_cnt, now() as etl_time from demo_stats.dwd_trans_di where trans_type = 101 group by 1,2;",
	// 3. DDL
	"create table if not exists t_demo (uid bigint not null comment '用户id', dt varchar(10) not null comment '日分区', etl_time datetime comment '写入时间', primary key (uid, dt))",
	// 4. 子查询 + order by / limit
	"select * from (select uid, count(*) as cnt from demo_ods.orders where gmt_create >= '2026-09-01' group by uid) as t left join demo_stats.dim_user as u on t.uid = u.uid order by cnt desc limit 100",
	// 5. 长 values 列表：保持逐行逗号前置
	"insert into demo_ods.users (uid, name) values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e'), (6, 'f'), (7, 'g'), (8, 'h'), (9, 'i'), (10, 'j'), (11, 'k'), (12, 'l'), (13, 'm'), (14, 'n'), (15, 'o'), (16, 'p'), (17, 'q'), (18, 'r'), (19, 's'), (20, 't'); -- 长列表",
	// 6. 文件头块注释 + 大写关键字输入
	"/* 渠道每日兑换汇总 */\nINSERT INTO a.b SELECT uid, amount FROM t WHERE dt = '${yesterday}';",
];

samples.forEach((s, i) => {
	console.log(`===== 样例${i + 1} =====`);
	console.log(formatSql(s, cfg, 4));
});
