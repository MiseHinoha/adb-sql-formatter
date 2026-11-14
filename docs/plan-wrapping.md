# 换行策略：长列表打包 / 短块合行 / 条件同类合行 —— 方案与效果对照

> 本文件由 `.tmp/proto-gen-doc2.js` 生成：所有 After 都是从**当前核心 + 原型后处理**真实跑出来的输出（tab 展开为 4 空格便于对照列宽）。

## 三条规则

| 规则 | 管什么 | 触发条件 |
| --- | --- | --- |
| A 长列表按行宽打包 | `where x in (…)`、`(a,b) in ((…),(…))` 这类长逗号列表 | 整段一行放不下时，按行宽贪心装填多条 |
| B 短括号块合回一行 | 条件分组、条件里的子查询、CTE 体、派生表 | 压成一行后整行宽度 ≤ 上限 |
| C 条件同类同义合行 | `where` / `having` / `join … on` 的 and/or 条件链 | 同列、同运算符的先黏成一组，再整组按行宽装填 |

## 一、规则 A / B 的效果

### 规则 A · 50 个数字的 IN 条件

**现状**

```sql
select
    order_id
    , user_id
    , pay_amt
    from t_order
    where shop_id in (
        1
        , 2
        , 3
        , 4
        , 5
        , 6
        , 7
        , 8
        , 9
        , 10
        , 11
        , 12
        , 13
        , 14
        , 15
        , 16
        , 17
        , 18
        , 19
        , 20
        , 21
        , 22
        , 23
        , 24
        , 25
        , 26
        , 27
        , 28
        , 29
        , 30
        , 31
        , 32
        , 33
        , 34
        , 35
        , 36
        , 37
        , 38
        , 39
        , 40
        , 41
        , 42
        , 43
        , 44
        , 45
        , 46
        , 47
        , 48
        , 49
        , 50
    )
        and dt = '20261101'
        and pay_status = 1;
```

**优化后**

```sql
select
    order_id
    , user_id
    , pay_amt
    from t_order
    where shop_id in (
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25
        , 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48
        , 49, 50
    )
        and dt = '20261101' and pay_status = 1;
```

### 规则 B · 条件分组（整条本来就能一行看完）

**现状**

```sql
select
    a
    from t
    where (
        (
            a = 1
            and b = 2
        )
        or (
            c = 3
            and d = 4
        )
    );
```

**优化后**

```sql
select
    a
    from t
    where ((a = 1 and b = 2) or (c = 3 and d = 4));
```

### 规则 B · 条件里的子查询

**现状**

```sql
select
    *
    from t_order o
    where o.user_id in (
        select
            id
            from t_user
            where level > 3
    )
        and o.dt = '20261101';
```

**优化后**

```sql
select
    *
    from t_order o
    where o.user_id in (select id from t_user where level > 3) and o.dt = '20261101';
```

### 规则 B · CTE

**现状**

```sql
with
    base as (
        select
            id
            , name
            from t_user
            where dt = '20261101'
    )
    , agg as (
        select
            id
            , count(1) cnt
            from base
            group by id
    )
select
    *
    from agg
    where cnt > 1;
```

**优化后**

```sql
with
    base as (select id, name from t_user where dt = '20261101')
    , agg as (select id, count(1) cnt from base group by id)
select
    *
    from agg
    where cnt > 1;
```

## 二、规则 C：条件「同类同义」尽量不分行（这次新增）

同类判定（只看相邻两条，不重排、不改运算符顺序）：

1. **同一个左值**：`o.dt >= …` 与 `o.dt <= …` 这种同列区间条件 → 一组；
2. **同一个运算符**：`= 、in 、between 、like` 等相同的 → 一组；
3. 否则不归组，只按行宽装填（组不跨 `and` / `or`，布尔结构保持不变）。

### 规则 C · 八条混合条件：同列 / 同运算符自动归组

**现状**

```sql
select
    o.order_id
    , o.pay_amt
    from t_order o
    where o.dt >= '20260101'
        and o.dt <= '20260131'
        and o.status = 1
        and o.pay_status = 2
        and o.city_code = '440300'
        and o.shop_type = 3
        and o.order_amt > 100
        and o.user_level between 1 and 5;
```

**优化后**

```sql
select
    o.order_id
    , o.pay_amt
    from t_order o
    where o.dt >= '20260101' and o.dt <= '20260131'
        and o.status = 1 and o.pay_status = 2 and o.city_code = '440300' and o.shop_type = 3
        and o.order_amt > 100 and o.user_level between 1 and 5;
```

### 规则 C · 长 IN 列表后面的条件

**现状**

```sql
select
    *
    from t_order
    where shop_id in (
        1
        , 2
        , 3
        , 4
        , 5
        , 6
        , 7
        , 8
        , 9
        , 10
        , 11
        , 12
        , 13
        , 14
        , 15
        , 16
        , 17
        , 18
        , 19
        , 20
        , 21
        , 22
        , 23
        , 24
        , 25
        , 26
        , 27
        , 28
        , 29
        , 30
    )
        and dt = '20261101'
        and pay_status = 1
        and is_deleted = 0;
```

**优化后**

```sql
select
    *
    from t_order
    where shop_id in (
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25
        , 26, 27, 28, 29, 30
    )
        and dt = '20261101' and pay_status = 1 and is_deleted = 0;
```

### 规则 C · having / join on 同样适用

**现状**

```sql
select
    a
    , count(1) c
    , sum(x) s
    from t
    group by a
    having count(1) > 10
        and sum(x) < 100
        and max(y) = 3;

select
    *
    from a
        join b on a.id = b.id
            and a.dt = b.dt
            and a.st = 1
            and b.flag = 0;
```

**优化后**

```sql
select
    a
    , count(1) c
    , sum(x) s
    from t
    group by a
    having count(1) > 10 and sum(x) < 100
        and max(y) = 3;

select
    *
    from a
        join b on a.id = b.id and a.dt = b.dt and a.st = 1 and b.flag = 0;
```

### 规则 C · and / or 混排：只改行，不改运算符顺序

**现状**

```sql
select
    *
    from t
    where a = 1
        and b = 2
        or c = 3
        and d = 4
        or e = 5;
```

**优化后**

```sql
select
    *
    from t
    where a = 1 and b = 2 or c = 3 and d = 4 or e = 5;
```

### 规则 C · 守卫：条件里带行内注释 → 整段不动

**现状**

```sql
select
    *
    from t
    where a = 1 -- 主键过滤
        and b = 2
        and c = 3;
```

**优化后**

```sql
select
    *
    from t
    where a = 1 -- 主键过滤
        and b = 2
        and c = 3;
```

## 三、组合起来的效果（A + B + C）

### 组合效果 · 一条完整的分区汇总 ETL

**现状**

```sql
with
    order_base as (
        select
            o.order_id
            , o.user_id
            , o.shop_id
            , o.pay_amt
            , o.pay_status
            , o.dt
            from dwd_order_di o
            where o.dt >= '20260101'
                and o.dt <= '20260131'
                and o.pay_status in (1, 2, 3)
                and o.is_deleted = 0
    )
    , shop_dim as (
        select
            shop_id
            , shop_name
            , city_code
            , shop_type
            from dim_shop_df
            where dt = '${bizdate}'
    )
select
    s.city_code
    , s.shop_type
    , count(1) order_cnt
    , sum(o.pay_amt) gmv
    from order_base o
        left join shop_dim s on o.shop_id = s.shop_id
    where s.city_code in (
        '441000'
        , '441001'
        , '441002'
        , '441003'
        , '441004'
        , '441005'
        , '441006'
        , '441007'
        , '441008'
        , '441009'
        , '441010'
        , '441011'
        , '441012'
        , '441013'
        , '441014'
        , '441015'
        , '441016'
        , '441017'
        , '441018'
        , '441019'
        , '441020'
        , '441021'
        , '441022'
        , '441023'
        , '441024'
        , '441025'
        , '441026'
        , '441027'
    )
        and s.shop_type = 3
        and o.pay_status = 1
        and o.pay_amt > 100
    group by s.city_code, s.shop_type
    order by gmv desc
    limit 100;
```

**优化后**

```sql
with
    order_base as (
        select
            o.order_id
            , o.user_id
            , o.shop_id
            , o.pay_amt
            , o.pay_status
            , o.dt
            from dwd_order_di o
            where o.dt >= '20260101' and o.dt <= '20260131' and o.pay_status in (1, 2, 3)
                and o.is_deleted = 0
    )
    , shop_dim as (
        select
            shop_id
            , shop_name
            , city_code
            , shop_type
            from dim_shop_df
            where dt = '${bizdate}'
    )
select
    s.city_code
    , s.shop_type
    , count(1) order_cnt
    , sum(o.pay_amt) gmv
    from order_base o
        left join shop_dim s on o.shop_id = s.shop_id
    where s.city_code in (
        '441000', '441001', '441002', '441003', '441004', '441005', '441006', '441007', '441008'
        , '441009', '441010', '441011', '441012', '441013', '441014', '441015', '441016', '441017'
        , '441018', '441019', '441020', '441021', '441022', '441023', '441024', '441025', '441026'
        , '441027'
    )
        and s.shop_type = 3 and o.pay_status = 1 and o.pay_amt > 100
    group by s.city_code, s.shop_type
    order by gmv desc
    limit 100;
```


## 四、不动的部分（已用真实核心验证）

- 建表语句与列定义对齐（DDL 的对齐列是既有产出，整条语句跳过）；
- 任何带行内注释的条件 / 列表（拼行会把后面的内容注释掉，一律原样保留）；
- 跨行字符串、`${...}` 占位符、`select` 列 / `group by` / `order by` 的逗号列表；
- 条件的**运算符顺序与括号结构**一律不改（只合并行，不重排）。

## 五、回归证据（原型实跑）

| 语料 | 结果 |
| --- | --- |
| 仓内 fixture 4 个文件 | 骨架一致、二次格式化幂等、0 问题（A/B 阶段零改动；加入 C 后 3 个文件条件合行、共 141 → 137 行） |
| 历史验收样本 13 个文件 | 同上，0 问题（149 → 143 行，5 个文件变化全部是条件合行） |
| 边界样本 | 注释守卫 / 跨行字符串 / DDL / 占位符 / `(a,b) in ((…))` 元组列表 / `and or` 混排：全部按预期 |

## 六、实现落点（下一步讨论用）

- `formatter-core.js` 新增三个纯函数：`packLongCommaLists`、`collapseShortBlocks`、`packConditions`，插在 `reformatDdl` **之后**、`restoreParams` 之前（那时缩进已是最终值，宽度才算得准；DDL 对齐仍保持在最前/最后各自的顺序约束里）；
- 三处共用一套「引号感知的宽度计数 + 括号深度扫描」，宽度按东亚宽度算（CJK 记 2 列），原型这里只按字符个数；
- 原型「每合一处就重扫全文」的写法要换成单趟括号栈扫描（原型在 63k 行合成文件上 3.5s，正式实现应在 100ms 量级）；
- 设置项：`packListWidth`（默认跟 expressionWidth）/ `packConditions`(on/off) / `collapseShortBlocks`(on/off)，配双语 nls 文案；
- 回归链：`npm test` → 自造语料 `check-ddl`（骨架 + 幂等）→ `ab-format`（对 git 基线四档）。

## 七、需要你点头的三件事

1. **规则 C 的归组口径**：同列 + 同运算符（本文件的效果）够不够？还是只按「同列」、或只按「同运算符」？
2. **宽度**：继续复用 `expressionWidth`（默认 100，推荐），还是给条件列表单独一个宽度？
3. **开关粒度**：A / B / C 三条规则要不要各自一个开关（默认全开），还是合成一个总开关？

