import webpush from 'npm:web-push';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails('mailto:jperichta@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const body = await req.json();
    const { table, type, record, old_record } = body;

    let payload: object | null = null;

    // Nová ponuka: invitation zmení status na submitted
    if (
      table === 'invitations' &&
      record?.status === 'submitted' &&
      old_record?.status !== 'submitted'
    ) {
      const reqs = await sbGet(`requests?id=eq.${record.request_id}&select=project_cislo,project_name,profession`);
      const r = reqs[0];
      const proj = r ? `${r.project_cislo ? r.project_cislo + ' – ' : ''}${r.project_name}` : '';
      payload = {
        title: 'Nová cenová ponuka',
        body: `${proj}${r?.profession ? ' · ' + r.profession : ''}`,
        url: 'https://architt-ctrl.github.io/prehladpm/ponuky.html',
        tag: `ponuka-${record.request_id}`,
      };
    }

    // Nový zápis v denníku
    if (table === 'dennik' && type === 'INSERT') {
      payload = {
        title: 'Nový zápis v denníku',
        body: `${record.cislo}: ${(record.text || '').substring(0, 100)}`,
        url: 'https://architt-ctrl.github.io/prehladpm/index.html',
        tag: `dennik-${record.cislo}`,
      };
    }

    if (!payload) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const subs: { id: string; endpoint: string; subscription: object }[] =
      await sbGet('push_subscriptions?select=id,endpoint,subscription');

    const results = await Promise.allSettled(
      subs.map(s => webpush.sendNotification(s.subscription, JSON.stringify(payload)))
    );

    // Vymazať expirované subscriptions (HTTP 410)
    const expired = results.flatMap((r, i) =>
      r.status === 'rejected' && (r.reason as { statusCode?: number })?.statusCode === 410
        ? [subs[i].id]
        : []
    );
    if (expired.length) {
      await fetch(`${SB_URL}/rest/v1/push_subscriptions?id=in.(${expired.join(',')})`, {
        method: 'DELETE',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
    }

    const sent = results.filter(r => r.status === 'fulfilled').length;
    return new Response(JSON.stringify({ ok: true, sent, expired: expired.length }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
