-- 交接给运营的脚本：部分库不支持用 `` 套表名，占位符直接贴在表名尾部
select
a.id
, b.amount
from order_gift_send_record_${年月：格式yyyymm。如：202611} a
left join dim_gift_${年月：格式yyyymm} b on a.gift_id = b.id
where a.dt = '${bizdate}'
and b.status = 1;

create table dwd_gift_detail_${年月：格式yyyymm。如：202611} (
id bigint not null comment '主键',
gift_id bigint comment '权益 ID',
amt decimal(18,2) comment '金额',
primary key (id)
)
distribute by hash(id)
partition by value(id)
comment '权益发放明细';
