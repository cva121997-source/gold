-- Add missing covering indexes for public-schema foreign keys.
-- Existing primary, unique or other indexes with the FK columns as a leading prefix are reused.
begin;

do $gold_fk_indexes$
declare
 r record;
 v_index_name text;
 v_cols text;
begin
 for r in
   select c.oid as constraint_oid,c.conrelid,c.conkey,ns.nspname,rel.relname,c.conname,
          array_agg(a.attname order by key_col.ordinality) as column_names
   from pg_constraint c
   join pg_class rel on rel.oid=c.conrelid
   join pg_namespace ns on ns.oid=rel.relnamespace
   cross join lateral unnest(c.conkey) with ordinality as key_col(attnum,ordinality)
   join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key_col.attnum
   where c.contype='f' and ns.nspname='public'
   group by c.oid,c.conrelid,c.conkey,ns.nspname,rel.relname,c.conname
   having not exists (
     select 1
     from pg_index i
     where i.indrelid=c.conrelid
       and i.indisvalid and i.indisready
       and i.indpred is null
       and i.indnkeyatts>=cardinality(c.conkey)
       and (
         select array_agg(ix.attnum::smallint order by ix.ordinality)
         from unnest(i.indkey::smallint[]) with ordinality as ix(attnum,ordinality)
         where ix.ordinality<=cardinality(c.conkey)
       )=c.conkey
   )
 loop
   select string_agg(format('%I',column_name),', ' order by ordinality)
     into v_cols
   from unnest(r.column_names) with ordinality as columns_list(column_name,ordinality);
   v_index_name:=left('idx_fk_'||r.relname||'_'||r.conname,54)||'_'||substr(md5(r.constraint_oid::text),1,8);
   execute format('create index if not exists %I on %I.%I (%s)',v_index_name,r.nspname,r.relname,v_cols);
 end loop;
end;
$gold_fk_indexes$;

commit;
