// ═══════════════════════════════════════════════════════════════
//  TRÆVÆRK – Cloudflare Worker
//  Håndterer to endpoints:
//    POST /create-payment-intent  → opretter Stripe PaymentIntent
//    POST /mobilepay-order        → logger MobilePay-bestilling
//    POST /stripe-webhook         → modtager Stripe-hændelser
//  Alle salg skrives automatisk til Google Sheets via Apps Script.
// ═══════════════════════════════════════════════════════════════

// ── KONFIGURATION ───────────────────────────────────────────────
// Sæt disse som Environment Variables i Cloudflare Dashboard
// (Workers → dit worker → Settings → Variables)
//
//   STRIPE_SECRET_KEY      = sk_live_...
//   STRIPE_WEBHOOK_SECRET  = whsec_...
//   SHEETS_WEBHOOK_URL     = https://script.google.com/macros/s/.../exec
// ────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── 1. Opret PaymentIntent (Stripe kortbetaling) ─────────────
    if (url.pathname === '/create-payment-intent' && request.method === 'POST') {
      return handleCreatePaymentIntent(request, env);
    }

    // ── 2. MobilePay manuel ordre ────────────────────────────────
    if (url.pathname === '/mobilepay-order' && request.method === 'POST') {
      return handleMobilePayOrder(request, env);
    }

    // ── 3. Stripe webhook (automatisk bekræftelse) ───────────────
    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

// ── OPRET PAYMENTINTENT ──────────────────────────────────────────
async function handleCreatePaymentIntent(request, env) {
  try {
    const body = await request.json();
    const { amount, product, name, email, engraving, address } = body;

    // Opret PaymentIntent hos Stripe
    const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        amount: String(amount),           // beløb i øre
        currency: 'dkk',
        'payment_method_types[]': 'card',
        'metadata[product]': product,
        'metadata[name]': name,
        'metadata[email]': email,
        'metadata[engraving]': engraving,
        'metadata[address]': address,
        receipt_email: email,
      }),
    });

    const intent = await stripeRes.json();

    if (intent.error) {
      return new Response(JSON.stringify({ error: intent.error.message }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ clientSecret: intent.client_secret }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

// ── MOBILEPAY ORDRE ──────────────────────────────────────────────
async function handleMobilePayOrder(request, env) {
  try {
    const body = await request.json();
    const { product, amount, name, email, engraving, address } = body;

    const priceExMoms = Math.round(amount / 1.25);
    const moms        = amount - priceExMoms;

    await logToSheets(env, {
      date:          new Date().toLocaleDateString('da-DK'),
      product:       PRODUCT_LABEL(product),
      qty:           1,
      priceInclMoms: amount,
      priceExMoms,
      moms,
      fee:           0,           // MobilePay: ingen platform-gebyr
      netto:         priceExMoms,
      paymentMethod: 'MobilePay',
      status:        'Afventer bekræftelse',
      name,
      email,
      engraving,
      address,
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}

// ── STRIPE WEBHOOK (automatisk ved gennemført betaling) ──────────
async function handleStripeWebhook(request, env) {
  const body      = await request.text();
  const signature = request.headers.get('stripe-signature');

  // Verificér webhook-signatur (sikkerhed)
  const isValid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response('Ugyldig signatur', { status: 400 });
  }

  const event = JSON.parse(body);

  if (event.type === 'payment_intent.succeeded') {
    const intent  = event.data.object;
    const meta    = intent.metadata;
    const amount  = intent.amount / 100; // konvertér fra øre
    const stripeFee   = Math.round(amount * 0.015 + 1.8); // 1,5% + 1,80 kr.
    const priceExMoms = Math.round(amount / 1.25);
    const moms        = amount - priceExMoms;
    const netto       = priceExMoms - stripeFee;

    await logToSheets(env, {
      date:          new Date().toLocaleDateString('da-DK'),
      product:       PRODUCT_LABEL(meta.product),
      qty:           1,
      priceInclMoms: amount,
      priceExMoms,
      moms,
      fee:           stripeFee,
      netto,
      paymentMethod: 'Stripe kort',
      status:        'Betalt',
      name:          meta.name,
      email:         meta.email,
      engraving:     meta.engraving,
      address:       meta.address,
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── LOG TIL GOOGLE SHEETS ────────────────────────────────────────
async function logToSheets(env, data) {
  if (!env.SHEETS_WEBHOOK_URL) return;
  await fetch(env.SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ── STRIPE WEBHOOK SIGNATUR-VERIFIKATION ─────────────────────────
async function verifyStripeSignature(body, signature, secret) {
  try {
    const parts     = signature.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts.t;
    const sig       = parts.v1;
    const payload   = `${timestamp}.${body}`;
    const key       = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const computed  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const hex       = Array.from(new Uint8Array(computed)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hex === sig;
  } catch {
    return false;
  }
}

// ── HJÆLPEFUNKTION: produktnavn ──────────────────────────────────
function PRODUCT_LABEL(key) {
  return {
    stort:       'Stort skærebræt (40×25 cm)',
    mellemstort: 'Mellemstort skærebræt (30×19 cm)',
    begge:       'Begge størrelser',
  }[key] || key;
}
