-- CRON_SECRET must be provisioned first as the hengshi_cron_secret Vault entry.
do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'hengshi_cron_secret'
  ) then
    raise exception 'Vault secret hengshi_cron_secret is required';
  end if;
end;
$$;

select cron.schedule(
  'hengshi-four-hour-scan',
  '5 */4 * * *',
  $job$
    select net.http_post(
      url := 'https://hengshi-perpetual.vercel.app/api/cron',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'hengshi_cron_secret'
          limit 1
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-cron',
        'scheduledAt', now()
      ),
      timeout_milliseconds := 300000
    ) as request_id;
  $job$
);
