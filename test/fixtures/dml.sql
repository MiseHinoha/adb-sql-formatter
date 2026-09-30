-- 脱敏 DML 样本：覆盖逗号前置、子查询、CTE、占位符等排版约定
insert overwrite table demo_stats.dws_order_sum_di partition (dt = '${bizdate}')
select a.uid, b.paid_id, sum(a.amount_abs) as coin_amount, count(*) as order_cnt
from demo_stats.dwd_trans_di as a
left join demo_stats.dim_user as b on a.buyer_uid = b.uid
where a.dt = '${bizdate}' and a.trans_type = 7913
group by 1, 2;

with base as (
	select uid, count(*) as cnt
	from demo_stats.dwd_login_di
	where dt >= '${bizdate}'
	group by uid
)
select b.uid, b.cnt, u.name
from base as b
left join demo_stats.dim_user as u on b.uid = u.uid
order by cnt desc
limit 100;

select
	uid
	, case when amount > 100 then 'high' else 'low' end as level -- 消费分层
	, amount
from demo_stats.dwd_trans_di
where dt = '${bizdate}'
	and status in (1, 2, 3);

update demo_stats.dws_order_sum_di as t
join (select uid, max(etl_time) as etl_time from demo_stats.dwd_trans_di group by uid) as s
on t.uid = s.uid
set t.etl_time = s.etl_time
where t.dt = '${bizdate}';

-- ADB 专有函数（不在 mysql 方言函数表里）必须紧贴括号，表名位置的括号则保持有空格
select date_trunc('month', a.dt) as stats_month
	, months_between(date_trunc('month', a.dt), date_trunc('month', b.dt)) as month_gap
	, nvl(a.coin_amount, 0) + nvl(b.coin_amount, 0) as coin_amount
	, to_date(a.etl_time) as etl_day
from demo_stats.dws_order_sum_di as a
left join demo_stats.dws_order_sum_di as b on a.uid = b.uid
where a.dt = '${bizdate}';
