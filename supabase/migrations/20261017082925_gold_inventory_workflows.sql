-- Controlled inventory creation and movement ledger.
begin;

create or replace function private.create_inventory_product(
 p_tenant_id uuid,p_branch_id uuid,p_category_id uuid,p_product_code text,p_barcode text,p_name text,p_description text,
 p_metal_id smallint,p_purity_id smallint,p_gross_weight numeric,p_net_weight numeric,p_stone_weight numeric,
 p_making_charge_mode text,p_making_charge_value numeric,p_wastage_percent numeric,p_purchase_cost numeric,p_selling_price numeric,
 p_huid text,p_item_code text
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_product_id uuid; v_item_id uuid; v_code text; v_gross numeric; v_net numeric; v_stone numeric;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','inventory_manager']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if nullif(trim(p_product_code),'') is null or nullif(trim(p_name),'') is null then raise exception 'Product code and name are required'; end if;
 if p_branch_id is null then raise exception 'Select a branch for stock intake'; end if;
 v_gross:=coalesce(p_gross_weight,0); v_net:=coalesce(p_net_weight,0); v_stone:=coalesce(p_stone_weight,0);
 if v_gross<0 or v_net<0 or v_stone<0 or v_net>v_gross or v_stone>v_gross then raise exception 'Weight details are invalid'; end if;
 if p_making_charge_mode not in ('percent','fixed','per_gram') then raise exception 'Invalid making charge mode'; end if;
 if coalesce(p_making_charge_value,0)<0 or coalesce(p_wastage_percent,0)<0 or coalesce(p_purchase_cost,0)<0 or coalesce(p_selling_price,0)<0 then raise exception 'Charges and prices cannot be negative'; end if;
 if p_category_id is not null and not exists(select 1 from public.product_categories where tenant_id=p_tenant_id and id=p_category_id) then raise exception 'Category belongs to another shop or does not exist'; end if;
 insert into public.products(tenant_id,category_id,product_code,barcode,name,description,metal_id,purity_id,gross_weight_grams,net_metal_weight_grams,stone_weight_grams,making_charge_mode,making_charge_value,wastage_percent,purchase_cost,base_selling_price,huid,created_by)
 values(p_tenant_id,p_category_id,trim(p_product_code),nullif(trim(p_barcode),''),trim(p_name),nullif(trim(p_description),''),p_metal_id,p_purity_id,v_gross,v_net,v_stone,p_making_charge_mode,coalesce(p_making_charge_value,0),coalesce(p_wastage_percent,0),p_purchase_cost,p_selling_price,nullif(trim(p_huid),''),v_user)
 returning id into v_product_id;
 v_code:=coalesce(nullif(trim(p_item_code),''),trim(p_product_code));
 insert into public.inventory_items(tenant_id,branch_id,product_id,item_code,status,purchase_cost,current_valuation)
 values(p_tenant_id,p_branch_id,v_product_id,v_code,'in_stock',p_purchase_cost,p_selling_price)
 returning id into v_item_id;
 insert into public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
 values(p_tenant_id,p_branch_id,v_item_id,v_product_id,'purchase',1,null,p_branch_id,v_code,'Initial stock intake',v_user);
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'inventory.item_created','inventory_item',v_item_id::text,jsonb_build_object('product_id',v_product_id,'product_code',p_product_code,'branch_id',p_branch_id));
 return v_item_id;
end;
$$;
revoke execute on function private.create_inventory_product(uuid,uuid,uuid,text,text,text,text,smallint,smallint,numeric,numeric,numeric,text,numeric,numeric,numeric,numeric,text,text) from public,anon;
grant execute on function private.create_inventory_product(uuid,uuid,uuid,text,text,text,text,smallint,smallint,numeric,numeric,numeric,text,numeric,numeric,numeric,numeric,text,text) to authenticated;
create or replace function public.create_inventory_product(p_tenant_id uuid,p_branch_id uuid,p_category_id uuid,p_product_code text,p_barcode text,p_name text,p_description text,p_metal_id smallint,p_purity_id smallint,p_gross_weight numeric,p_net_weight numeric,p_stone_weight numeric,p_making_charge_mode text,p_making_charge_value numeric,p_wastage_percent numeric,p_purchase_cost numeric,p_selling_price numeric,p_huid text,p_item_code text)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.create_inventory_product(p_tenant_id,p_branch_id,p_category_id,p_product_code,p_barcode,p_name,p_description,p_metal_id,p_purity_id,p_gross_weight,p_net_weight,p_stone_weight,p_making_charge_mode,p_making_charge_value,p_wastage_percent,p_purchase_cost,p_selling_price,p_huid,p_item_code); $$;
revoke execute on function public.create_inventory_product(uuid,uuid,uuid,text,text,text,text,smallint,smallint,numeric,numeric,numeric,text,numeric,numeric,numeric,numeric,text,text) from public,anon;
grant execute on function public.create_inventory_product(uuid,uuid,uuid,text,text,text,text,smallint,smallint,numeric,numeric,numeric,text,numeric,numeric,numeric,numeric,text,text) to authenticated;

create or replace function private.move_inventory_item(p_tenant_id uuid,p_inventory_item_id uuid,p_movement text,p_to_branch_id uuid default null,p_reason text default null)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_item public.inventory_items%rowtype; v_status text; v_target uuid; v_ref text;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select * into v_item from public.inventory_items where tenant_id=p_tenant_id and id=p_inventory_item_id for update;
 if not found then raise exception 'Inventory item not found'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_item.branch_id,array['owner','manager','inventory_manager']) then raise exception 'Permission denied for source branch' using errcode='42501'; end if;
 if p_movement='transfer' then
   v_target:=p_to_branch_id;
   if v_target is null or v_target=v_item.branch_id or not exists(select 1 from public.branches where tenant_id=p_tenant_id and id=v_target and is_active) then raise exception 'Select a different active destination branch'; end if;
   if not private.has_tenant_branch_access(p_tenant_id,v_target,array['owner','manager','inventory_manager']) then raise exception 'Permission denied for destination branch' using errcode='42501'; end if;
   v_ref:='MOVE-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
   insert into public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
   values(p_tenant_id,v_item.branch_id,v_item.id,v_item.product_id,'transfer_out',1,v_item.branch_id,v_target,v_ref,coalesce(p_reason,'Branch transfer'),v_user);
   update public.inventory_items set branch_id=v_target,status='in_stock',updated_at=now() where tenant_id=p_tenant_id and id=v_item.id;
   insert into public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
   values(p_tenant_id,v_target,v_item.id,v_item.product_id,'transfer_in',1,v_item.branch_id,v_target,v_ref,coalesce(p_reason,'Branch transfer'),v_user);
 elsif p_movement in ('reserve','release_reservation','repair_out','repair_in','write_off') then
   v_status:=case p_movement when 'reserve' then 'reserved' when 'release_reservation' then 'in_stock' when 'repair_out' then 'repair' when 'repair_in' then 'in_stock' when 'write_off' then 'written_off' end;
   if p_movement='reserve' and v_item.status<>'in_stock' then raise exception 'Only stock items can be reserved'; end if;
   if p_movement='release_reservation' and v_item.status<>'reserved' then raise exception 'Item is not reserved'; end if;
   if p_movement='repair_out' and v_item.status not in ('in_stock','reserved') then raise exception 'Item cannot be sent to repair from its current status'; end if;
   if p_movement='repair_in' and v_item.status<>'repair' then raise exception 'Item is not currently in repair'; end if;
   if p_movement='write_off' and v_item.status not in ('in_stock','reserved','repair') then raise exception 'Item cannot be written off from its current status'; end if;
   update public.inventory_items set status=v_status,updated_at=now() where tenant_id=p_tenant_id and id=v_item.id;
   v_ref:='MOV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
   insert into public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
   values(p_tenant_id,v_item.branch_id,v_item.id,v_item.product_id,
     case p_movement when 'reserve' then 'adjustment' when 'release_reservation' then 'adjustment' when 'repair_out' then 'repair_out' when 'repair_in' then 'repair_in' else 'adjustment' end,
     1,v_item.branch_id,v_item.branch_id,v_ref,coalesce(p_reason,p_movement),v_user);
 else raise exception 'Unsupported inventory movement'; end if;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'inventory.item_moved','inventory_item',p_inventory_item_id::text,jsonb_build_object('movement',p_movement,'to_branch_id',p_to_branch_id,'reason',p_reason));
end;
$$;
revoke execute on function private.move_inventory_item(uuid,uuid,text,uuid,text) from public,anon;
grant execute on function private.move_inventory_item(uuid,uuid,text,uuid,text) to authenticated;
create or replace function public.move_inventory_item(p_tenant_id uuid,p_inventory_item_id uuid,p_movement text,p_to_branch_id uuid default null,p_reason text default null)
returns void language plpgsql security invoker set search_path=public,private,pg_temp as $$
begin perform private.move_inventory_item(p_tenant_id,p_inventory_item_id,p_movement,p_to_branch_id,p_reason); end;
$$;
revoke execute on function public.move_inventory_item(uuid,uuid,text,uuid,text) from public,anon;
grant execute on function public.move_inventory_item(uuid,uuid,text,uuid,text) to authenticated;

-- Preserve a history of inventory status changes; browser sessions can read but cannot write movements directly.
revoke insert,update,delete on public.inventory_items,public.inventory_movements from public,anon,authenticated;
grant select on public.inventory_items,public.inventory_movements to authenticated;
commit;
