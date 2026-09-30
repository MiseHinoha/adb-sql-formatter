-- 脱敏建表样本：覆盖 ADB 表选项的各种形态，用于仓内自测（不含任何真实库表名）
create table demo_orders_di (
	order_id bigint not null comment '订单id',
	uid bigint not null comment '下单用户',
	amount decimal(18, 4) not null comment '付费金额',
	dt date not null comment '数据快照日期',
	etl_time datetime not null default current_timestamp comment 'ETL处理时间',
	primary key (dt, order_id)
) DISTRIBUTE BY HASH(uid)
PARTITION BY VALUE(dt) LIFECYCLE 366
COMMENT = 'DWD-订单日增量';

create table demo_dim_currency (
	bustype int not null comment '业务大类',
	bustype_name varchar not null comment '业务大类名称',
	mark varchar comment '说明',
	etl_time datetime not null default current_timestamp comment 'etl时间',
	primary key (bustype)
) DISTRIBUTE by BROADCAST INDEX_ALL = 'Y' STORAGE_POLICY = 'HOT' ENGINE = 'XUANWU' BLOCK_SIZE = 4096 TABLE_PROPERTIES = '{"format":"columnstore"}' COMMENT = 'DIM-业务大类映射';

create table demo_dim_store_map (
	prod_id bigint not null comment '产品id',
	group_name varchar not null comment '分组名',
	etl_time datetime not null default current_timestamp comment '处理时间',
	primary key (prod_id)
) DISTRIBUTE BY BROADCAST   -- join表加速
comment 'DIM-商店映射';

create table demo_no_semi (
	uid bigint not null comment '用户',
	dt date not null comment '日期',
	primary key (uid, dt)
) distribute by hash(uid)
partition by value(dt)
comment 'DWD-末条无分号形态';
