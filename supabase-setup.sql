-- Organizador de trabajos: esquema para Supabase
-- Ejecutar completo en Supabase > SQL Editor > New query > Run
-- (se puede volver a ejecutar sin problema: no duplica nada)

-- IMPORTANTE: poner aca el email con el que vas a entrar a la app.
-- Solo ese email va a poder leer o escribir datos y PDFs.
create or replace function is_owner() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'hectorlifter@gmail.com'
$$;

-- tabla principal: un registro por presupuesto/trabajo, con la misma
-- estructura anidada que ya usaba la app local (presupuesto/ordenCompra/factura/pago)
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  data jsonb not null
);

alter table jobs enable row level security;

-- permisos explicitos (funciona igual si "Automatically expose new tables" esta
-- tildado o no): solo el usuario logueado puede tocar la tabla
grant execute on function is_owner() to anon, authenticated, service_role;
grant select, insert, update, delete on jobs to authenticated;
grant all on jobs to service_role;

drop policy if exists "jobs_select_auth" on jobs;
drop policy if exists "jobs_insert_auth" on jobs;
drop policy if exists "jobs_update_auth" on jobs;
drop policy if exists "jobs_delete_auth" on jobs;
drop policy if exists "jobs_select_owner" on jobs;
drop policy if exists "jobs_insert_owner" on jobs;
drop policy if exists "jobs_update_owner" on jobs;
drop policy if exists "jobs_delete_owner" on jobs;

create policy "jobs_select_owner" on jobs for select using (is_owner());
create policy "jobs_insert_owner" on jobs for insert with check (is_owner());
create policy "jobs_update_owner" on jobs for update using (is_owner());
create policy "jobs_delete_owner" on jobs for delete using (is_owner());

-- bucket de almacenamiento para los PDFs (privado, no publico)
insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;

drop policy if exists "pdfs_select_auth" on storage.objects;
drop policy if exists "pdfs_insert_auth" on storage.objects;
drop policy if exists "pdfs_update_auth" on storage.objects;
drop policy if exists "pdfs_delete_auth" on storage.objects;
drop policy if exists "pdfs_select_owner" on storage.objects;
drop policy if exists "pdfs_insert_owner" on storage.objects;
drop policy if exists "pdfs_update_owner" on storage.objects;
drop policy if exists "pdfs_delete_owner" on storage.objects;

create policy "pdfs_select_owner" on storage.objects for select
  using (bucket_id = 'pdfs' and is_owner());
create policy "pdfs_insert_owner" on storage.objects for insert
  with check (bucket_id = 'pdfs' and is_owner());
create policy "pdfs_update_owner" on storage.objects for update
  using (bucket_id = 'pdfs' and is_owner());
create policy "pdfs_delete_owner" on storage.objects for delete
  using (bucket_id = 'pdfs' and is_owner());

-- ---------------------------------------------------------------------------
-- Impuestos y gastos (se puede ejecutar de nuevo sin problema)
-- Cada fila es un concepto: un porcentaje sobre cada cobro (ingresos brutos, tasas...),
-- un gasto fijo mensual o un gasto fijo anual. El "vigente_desde/hasta" permite cambiar un
-- valor sin recalcular lo ya cobrado.
-- ---------------------------------------------------------------------------
create table if not exists impuestos_items (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  nombre text not null check (length(trim(nombre)) > 0),
  tipo text not null check (tipo in ('porcentaje', 'mensual', 'anual')),
  valor numeric not null check (valor >= 0),
  base text not null default 'sin_iva' check (base in ('sin_iva', 'con_iva')),
  retencion_tipo text check (retencion_tipo in ('iibb', 'ganancias', 'suss')),
  vigente_desde date not null default current_date,
  vigente_hasta date check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  notas text
);

alter table impuestos_items enable row level security;

grant select, insert, update, delete on impuestos_items to authenticated;
grant all on impuestos_items to service_role;

drop policy if exists "impuestos_select_owner" on impuestos_items;
drop policy if exists "impuestos_insert_owner" on impuestos_items;
drop policy if exists "impuestos_update_owner" on impuestos_items;
drop policy if exists "impuestos_delete_owner" on impuestos_items;

create policy "impuestos_select_owner" on impuestos_items for select using (is_owner());
create policy "impuestos_insert_owner" on impuestos_items for insert with check (is_owner());
create policy "impuestos_update_owner" on impuestos_items for update using (is_owner());
create policy "impuestos_delete_owner" on impuestos_items for delete using (is_owner());
