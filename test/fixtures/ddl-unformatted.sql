-- 未对齐（乱输入）样本：验「乱 → 齐」这条路径
-- 注意：它是**输入**，不是期望输出 —— 别对它按保存格式化（会失去覆盖价值）
-- 对照：ddl.sql / dml.sql 是已对齐形态的样本，验「已对齐输入再排版不破坏对齐」

select
  order_id
  , uid
  , row_number() over (partition by uid order by etl_time desc) as rn
  from dwd_orders_di
  where dt between '2026-09-01' and '2026-09-30'
  and amount > 0;

create table dwd_orders_di
(
  order_id bigint not null comment '订单id'
  , uid bigint not null comment '下单用户'
  , amount decimal(18, 4) not null comment '付费金额'
  , dt date not null comment '数据快照日期'
  , etl_time datetime not null default current_timestamp comment 'ETL处理时间'
  , primary key (dt, order_id)
)
distribute by hash(uid)
partition by value(dt) lifecycle 366
comment = 'DWD-订单日增量';
