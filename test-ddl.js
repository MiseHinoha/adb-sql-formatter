// ADB DDL 格式化验证：node test-ddl.js
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

const samples = [
	// 1. 典型 ADB 数仓建表（分布键/分区/表注释在右括号后）
	"create table demo_stats.ods_user_details_di (\n    uid bigint not null comment '用户id',\n    dt date not null comment '数据快照日期',\n    etl_time datetime not null default current_timestamp comment 'ETL处理时间',\n    PRIMARY KEY (dt, uid)\n) DISTRIBUTE BY HASH(uid)\nPARTITION BY VALUE(dt)\nCOMMENT = 'ODS-用户详情日快照表';",
	// 2. 带一串表属性 + BROADCAST
	"create table demo_stats.demo_dim_currency (bustype int not null comment '业务大类', bustype_name varchar not null comment '业务大类名称', etl_time datetime not null default current_timestamp comment 'etl时间', primary key (bustype)) DISTRIBUTE by BROADCAST INDEX_ALL = 'Y' STORAGE_POLICY = 'HOT' ENGINE = 'XUANWU' BLOCK_SIZE = 4096 TABLE_PROPERTIES = '{\"format\":\"columnstore\"}' COMMENT = 'DIM-业务大类映射';",
	// 3. 短表：primary key 会不会被挤在同一行
	"create table t_demo (uid bigint not null, dt varchar(10) not null, primary key (uid, dt)) distribute by hash(uid);",
	// 4. LIFECYCLE 应跟在 partition by 后面，不单独拆行
	"create table t_lifecycle (id bigint not null, dt date not null, primary key (id, dt)) distribute by hash(id) partition by value(dt) lifecycle 30 comment 'dwd-生命周期示例';",
];

samples.forEach((s, i) => {
	console.log(`===== DDL样例${i + 1} =====`);
	console.log(formatSql(s, cfg, 4));
});
