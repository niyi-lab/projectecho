/********************************************************************
 * AutoVINReveal Server – Stripe + PayPal + Supabase + Caching + Admin
 ********************************************************************/

import dotenv from 'dotenv';
dotenv.config({ path: '/etc/secrets/.env' });
dotenv.config();

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import Stripe from 'stripe';
import { gunzipSync } from 'zlib';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const paypalSdk = require('@paypal/checkout-server-sdk');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const NODE_ENV = process.env.NODE_ENV || 'production';
const PROD = NODE_ENV === 'production';

/* ================================================================
   🔒 Security / redirects (skip Stripe webhook)
================================================================ */
app.set('trust proxy', 1);

const WEBHOOK_PATHS = new Set(['/api/stripe-webhook', '/api/stripe-webhook/']);

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();

  if (PROD) {
    const xfProto = req.get('x-forwarded-proto');
    if (!req.secure && xfProto !== 'https') {
      return res.redirect(308, `https://${req.headers.host}${req.url}`);
    }
  }
  if (process.env.FORCE_WWW === '1' && req.headers.host && !req.headers.host.startsWith('www.')) {
    return res.redirect(308, `https://www.${req.headers.host}${req.url}`);
  }
  next();
});

// Tiny CSP helper (lets http→https upgrade happen)
app.use((_, res, next) => {
  res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
  next();
});

/* ================================================================
   🩺 Health
================================================================ */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/* ================================================================
   💳 Stripe
================================================================ */
const stripeLive = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY || null;

const PRICE_SINGLE       = process.env.STRIPE_PRICE_SINGLE;
const PRICE_10PACK       = process.env.STRIPE_PRICE_10PACK;
const PRICE_SINGLE_TEST  = process.env.STRIPE_PRICE_SINGLE_TEST || null;
const PRICE_10PACK_TEST  = process.env.STRIPE_PRICE_10PACK_TEST || null;

const CREDITS_PER_SINGLE = Number(process.env.CREDITS_PER_SINGLE || '1');
const CREDITS_PER_10PACK = Number(process.env.CREDITS_PER_10PACK || '10');

const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || SITE_URL;

function stripeForId(id) {
  const isTest = typeof id === 'string' && id.startsWith('cs_test_');
  if (isTest) {
    if (!STRIPE_TEST_SECRET_KEY) throw new Error('Test session but STRIPE_TEST_SECRET_KEY not set.');
    return new Stripe(STRIPE_TEST_SECRET_KEY, { apiVersion: '2024-06-20' });
    }
  return stripeLive;
}

/* ================================================================
   🗄️ Supabase
================================================================ */
const SUPABASE_URL      = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY  = process.env.SERVICE_ROLE_KEY;

const supabaseAnon     = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseService  = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const supabaseForToken = (token) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });

async function getUser(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return { token: null, user: null };
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) return { token: null, user: null };
  return { token, user: data.user };
}

/* ================================================================
   🚗 CarSimulcast API
================================================================ */
const CS     = 'https://connect.carsimulcast.com';
const KEY    = process.env.API_KEY;
const SECRET = process.env.API_SECRET;
const H      = { 'API-KEY': KEY, 'API-SECRET': SECRET };

async function csGet(url) {
  const r = await axios.get(url, { headers: H, responseType: 'text', timeout: 30000 });
  return r.data; // base64
}

/* ================================================================
   🧠 Cache / helpers
================================================================ */
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const ck = (vin, type) => path.join(CACHE_DIR, `${vin}-${type}.b64`);
const readCache  = (vin, type) => (fs.existsSync(ck(vin, type)) ? fs.readFileSync(ck(vin, type), 'utf8') : null);
const writeCache = (vin, type, data) => fs.writeFileSync(ck(vin, type), data, 'utf8');

const CONSUMED_FILE = path.join(__dirname, '.consumed_sessions.json');
let CONSUMED = new Set();
try {
  if (fs.existsSync(CONSUMED_FILE)) CONSUMED = new Set(JSON.parse(fs.readFileSync(CONSUMED_FILE, 'utf8')));
} catch {}
function saveConsumed() {
  try { fs.writeFileSync(CONSUMED_FILE, JSON.stringify([...CONSUMED], null, 2)); } catch {}
}

function decodeReportBase64(rawB64) {
  const buf = Buffer.from(rawB64, 'base64');
  // gzipped HTML?
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { kind: 'html', html: gunzipSync(buf).toString('utf8') }; }
    catch { return { kind: 'unknown', buffer: buf, error: 'gunzip-failed' }; }
  }
  // PDF?
  if (buf.slice(0, 5).toString() === '%PDF-') return { kind: 'pdf', buffer: buf };
  const asText = buf.toString('utf8');
  if (/<!DOCTYPE html|<html[\s>]/i.test(asText.slice(0, 2048))) return { kind: 'html', html: asText };
  return { kind: 'unknown', buffer: buf };
}

async function fetchAndCacheReport(vin, type = 'carfax') {
  const live = await csGet(`${CS}/getrecord/${type}/${vin}`);
  writeCache(vin, type, live);
  return true;
}

/* ================================================================
   🧾 Stripe Webhook
================================================================ */
const WH_LIVE = process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
const WH_TEST = process.env.STRIPE_WEBHOOK_SECRET_TEST || null;

app.get(['/api/stripe-webhook', '/api/stripe-webhook/'], (_req, res) => res.status(200).send('ok'));

app.post(['/api/stripe-webhook', '/api/stripe-webhook/'],
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripeLive.webhooks.constructEvent(req.body, sig, WH_LIVE);
    } catch (e1) {
      if (WH_TEST) {
        try {
          event = stripeLive.webhooks.constructEvent(req.body, sig, WH_TEST);
        } catch (e2) {
          return res.status(400).send('Webhook signature verification failed');
        }
      } else {
        return res.status(400).send('Webhook signature verification failed');
      }
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const sStripe = stripeForId(session.id);

        const lineItems = await sStripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
        let creditsToAdd = 0;
        for (const li of lineItems.data) {
          const pid = li.price?.id;
          const qty = li.quantity || 1;
          if (pid === PRICE_SINGLE || pid === PRICE_SINGLE_TEST) creditsToAdd += qty * CREDITS_PER_SINGLE;
          else if (pid === PRICE_10PACK || pid === PRICE_10PACK_TEST) creditsToAdd += qty * CREDITS_PER_10PACK;
          else creditsToAdd += qty * CREDITS_PER_SINGLE;
        }

        const userId   = session.metadata?.user_id || session.client_reference_id || null;
        const intent   = session.metadata?.intent || '';
        const metaVin  = (session.metadata?.vin || '').toUpperCase();
        const metaType = (session.metadata?.report_type || 'carfax').toLowerCase();

        if (userId && creditsToAdd > 0) {
          const { data: existing } = await supabaseService
            .from('credits').select('balance').eq('user_id', userId).maybeSingle();
          if (existing) {
            await supabaseService
              .from('credits').update({ balance: (existing.balance || 0) + creditsToAdd }).eq('user_id', userId);
          } else {
            await supabaseService
              .from('credits').insert({ user_id: userId, balance: creditsToAdd });
          }
        }

        if (intent === 'buy_report' && metaVin) {
          try { await fetchAndCacheReport(metaVin, metaType); } catch {}
        }
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).send('Webhook handler error');
    }
  }
);

/* ================================================================
   ⚙️ Normal middleware (after webhook)
================================================================ */
app.use(express.json());
app.use(cookieParser(process.env.APP_SECRET || 'change-me'));
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: false }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

/* ================================================================
   💰 Stripe Checkout
================================================================ */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { user_id: userIdFromBody, price_id, vin, report_type } = req.body || {};
    let userId = userIdFromBody;
    if (!userId) {
      const { user } = await getUser(req);
      if (user?.id) userId = user.id;
    }

    const isTenPack = (price_id === 'STRIPE_PRICE_10PACK' || price_id === '10pack');
    const priceLive = isTenPack ? PRICE_10PACK : PRICE_SINGLE;

    if (vin) {
      const type = (report_type || 'carfax').toLowerCase();
      const cached = readCache((vin || '').toUpperCase(), type);
      if (cached) {
        return res.status(409).json({ alreadyCached: true, vin, report_type: type });
      }
    }

    const intent = vin ? 'buy_report' : (isTenPack ? 'buy_credits_bundle' : 'buy_credit_single');

    const session = await stripeLive.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceLive, quantity: 1 }],
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&intent=${encodeURIComponent(intent)}${vin ? `&vin=${encodeURIComponent(vin)}` : ''}`,
      cancel_url: `${SITE_URL}/?checkout=cancel`,
      ...(userId ? { client_reference_id: userId } : {}),
      metadata: {
        ...(userId ? { user_id: userId } : {}),
        ...(vin ? { vin } : {}),
        ...(report_type ? { report_type } : {}),
        intent,
        purchase_kind: isTenPack ? 'bundle' : 'single'
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('stripe create session error:', err);
    res.status(500).json({ error: 'Stripe error' });
  }
});

/* ================================================================
   ✅ Stripe finalize (safety-net)
================================================================ */
app.post('/api/checkout/finalize', async (req, res) => {
  try {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    const sStripe = stripeForId(session_id);
    const session = await sStripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const lineItems = await sStripe.checkout.sessions.listLineItems(session_id, { limit: 10 });
    let creditsToAdd = 0;
    for (const li of lineItems.data) {
      const pid = li.price?.id;
      const qty = li.quantity || 1;
      if (pid === PRICE_SINGLE || pid === PRICE_SINGLE_TEST) creditsToAdd += qty * CREDITS_PER_SINGLE;
      else if (pid === PRICE_10PACK || pid === PRICE_10PACK_TEST) creditsToAdd += qty * CREDITS_PER_10PACK;
      else creditsToAdd += qty * CREDITS_PER_SINGLE;
    }

    const userId = session.metadata?.user_id || session.client_reference_id || null;
    if (userId && creditsToAdd > 0) {
      const { data: existing } = await supabaseService
        .from('credits').select('balance').eq('user_id', userId).maybeSingle();
      if (existing) {
        await supabaseService
          .from('credits').update({ balance: (existing.balance || 0) + creditsToAdd }).eq('user_id', userId);
      } else {
        await supabaseService
          .from('credits').insert({ user_id: userId, balance: creditsToAdd });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('finalize error:', e?.message || e);
    return res.status(500).json({ error: 'finalize failed' });
  }
});

/* ================================================================
   🔢 Credits API
================================================================ */
app.get('/api/credits/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { data, error } = await supabaseService
      .from('credits').select('balance').eq('user_id', user_id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ balance: data?.balance ?? 0 });
  } catch (err) {
    console.error('credits error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ================================================================
   💵 PayPal
================================================================ */
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const ppEnv =
  PAYPAL_ENV === 'live'
    ? new paypalSdk.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypalSdk.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const ppClient = new paypalSdk.core.PayPalHttpClient(ppEnv);

async function verifyPaypalCapture(captureId) {
  const req = new paypalSdk.payments.CapturesGetRequest(captureId);
  const res = await ppClient.execute(req);
  return res?.result;
}

app.post('/api/paypal/create-order', async (_req, res) => {
  try {
    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '7.00' } }],
      application_context: {
        brand_name: 'AutoVINReveal',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW'
      }
    });
    const order = await ppClient.execute(request);
    res.json({ orderID: order.result.id });
  } catch (e) {
    console.error('paypal create order error:', e);
    res.status(500).json({ error: 'PayPal create-order failed' });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderID, user_id } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'orderID required' });

    const capReq = new paypalSdk.orders.OrdersCaptureRequest(orderID);
    capReq.requestBody({});
    const capRes = await ppClient.execute(capReq);

    const unit = capRes?.result?.purchase_units?.[0];
    const cap  = unit?.payments?.captures?.[0];
    const captureId = cap?.id || null;
    const status    = cap?.status || capRes?.result?.status;

    if (!captureId || status !== 'COMPLETED')
      return res.status(400).json({ error: 'Capture not completed', status });

    if (user_id) {
      const { data: existing } = await supabaseService
        .from('credits').select('balance').eq('user_id', user_id).maybeSingle();
      if (existing) {
        await supabaseService.from('credits').update({ balance: (existing.balance || 0) + 1 }).eq('user_id', user_id);
      } else {
        await supabaseService.from('credits').insert({ user_id, balance: 1 });
      }
    }

    res.json({ ok: true, captureId });
  } catch (e) {
    console.error('paypal capture error:', e?.message || e);
    res.status(500).json({ error: 'PayPal capture failed' });
  }
});

/* ================================================================
   📄 Report API
================================================================ */
app.post('/api/report', async (req, res) => {
  try {
    const {
      vin,
      state,
      plate,
      type = 'carfax',
      as = 'html',
      allowLive: allowLiveRaw,
      oneTimeSession,
    } = req.body || {};

    const allowLive = allowLiveRaw !== false;

    // Resolve VIN
    let targetVin = (vin || '').trim().toUpperCase();
    if (!targetVin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) targetVin = m[0];
    }
    if (!targetVin) return res.status(400).send('VIN or State+Plate required');

    // One-time receipt verification (guests)
    if (oneTimeSession) {
      if (CONSUMED.has(oneTimeSession)) return res.status(409).send('This receipt was already used.');
      try {
        if (oneTimeSession.startsWith('pp_')) {
          const captureId = oneTimeSession.slice(3);
          const cap = await verifyPaypalCapture(captureId);
          if (cap?.status !== 'COMPLETED') return res.status(402).send('Payment not completed.');
        } else {
          const sStripe = stripeForId(oneTimeSession);
          const s = await sStripe.checkout.sessions.retrieve(oneTimeSession);
          if (s.payment_status !== 'paid') return res.status(402).send('Payment not completed.');
        }
        CONSUMED.add(oneTimeSession); saveConsumed();
      } catch {
        return res.status(400).send('Invalid purchase receipt.');
      }
    }

    // Cache lookup
    let raw = readCache(targetVin, type.toLowerCase());

    // If not cached and live allowed, spend credit or require payment
    if (!raw && allowLive) {
      const { token, user } = await getUser(req);

      if (user && !oneTimeSession) {
        const supabaseUser = supabaseForToken(token);
        const { error: rpcErr } = await supabaseUser.rpc('use_credit_for_vin', {
          p_vin: targetVin,
          p_result_url: null,
        });
        if (rpcErr) return res.status(402).send('Insufficient credits');
      } else if (!user && !oneTimeSession) {
        return res.status(401).send('Complete purchase to view this report.');
      }

      const live = await csGet(`${CS}/getrecord/${type}/${targetVin}`);
      raw = live;
      writeCache(targetVin, type.toLowerCase(), raw);
    }

    if (!raw) return res.status(404).send('No cached or archive report found.');

    const decoded = decodeReportBase64(raw);

    if (as === 'pdf') {
      if (decoded.kind === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${targetVin}-${type}.pdf"`);
        return res.send(decoded.buffer);
      }
      if (decoded.kind === 'html') {
        try {
          const form = new FormData();
          form.append('base64_content', Buffer.from(decoded.html, 'utf8').toString('base64'));
          form.append('vin', targetVin);
          form.append('report_type', type);
          const pdf = await axios.post(`${CS}/pdf`, form, {
            headers: { ...H, ...form.getHeaders() },
            responseType: 'arraybuffer',
            timeout: 60000,
          });
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${targetVin}-${type}.pdf"`);
          return res.send(Buffer.from(pdf.data));
        } catch {
          return res.status(502).send('Could not generate PDF from this report.');
        }
      }
      return res.status(500).send('Unsupported report content.');
    }

    if (decoded.kind === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(decoded.html);
    }
    if (decoded.kind === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${targetVin}-${type}.pdf"`);
      return res.send(decoded.buffer);
    }
    return res.status(500).send('Unsupported report content.');
  } catch (err) {
    console.error('report error:', err);
    res.status(500).send('Server error');
  }
});

/* ================================================================
   🔗 Share links (cache-only)
================================================================ */
const SHARE_FILE = path.join(__dirname, '.share_tokens.json');
let SHARE_TOKENS = {};
try { if (fs.existsSync(SHARE_FILE)) SHARE_TOKENS = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch {}
function saveShareTokens() { try { fs.writeFileSync(SHARE_FILE, JSON.stringify(SHARE_TOKENS, null, 2)); } catch {} }
function makeToken() { return Buffer.from(crypto.randomUUID()).toString('base64url').replace(/=/g,''); }
function pruneShareTokens() {
  const now = Date.now(); let changed = false;
  for (const [tok, meta] of Object.entries(SHARE_TOKENS)) {
    if (!meta || meta.exp <= now) { delete SHARE_TOKENS[tok]; changed = true; }
  }
  if (changed) saveShareTokens();
}
setInterval(pruneShareTokens, 60 * 60 * 1000);

app.post('/api/share', async (req, res) => {
  try {
    const { vin, type = 'carfax' } = req.body || {};
    if (!vin) return res.status(400).json({ error: 'vin required' });

    const raw = readCache(vin.toUpperCase(), type.toLowerCase());
    if (!raw) return res.status(404).json({ error: 'Report not cached yet. Open it once first.' });

    const token = makeToken();
    const exp = Date.now() + 24 * 60 * 60 * 1000;
    SHARE_TOKENS[token] = { vin: vin.toUpperCase(), type: type.toLowerCase(), exp };
    saveShareTokens();

    const url = `${SITE_URL}/view/${token}`;
    res.json({ url, expiresAt: exp });
  } catch {
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

app.get('/view/:token', async (req, res) => {
  pruneShareTokens();
  const t = req.params.token;
  const meta = SHARE_TOKENS[t];
  if (!meta || meta.exp <= Date.now()) return res.status(404).send('Link expired or invalid');

  const raw = readCache(meta.vin, meta.type);
  if (!raw) return res.status(404).send('Report not found in cache');

  const decoded = decodeReportBase64(raw);
  if (decoded.kind === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(decoded.html);
  }
  if (decoded.kind === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${meta.vin}-${meta.type}.pdf"`);
    return res.send(decoded.buffer);
  }
  return res.status(500).send('Unsupported report content.');
});

/* ================================================================
   👑 Admin: auth & utilities
================================================================ */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_TTL_SECONDS = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 60 * 60 * 12); // 12h

function adminOnly(req, res, next) {
  const val = req.signedCookies?.admin || '';
  if (val === '1') return next();
  return res.status(401).json({ error: 'admin auth required' });
}

// Login / logout / check
app.post('/api/admin/login', (req, res) => {
  const pass = (req.body?.password || '').toString();
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'invalid password' });
  res.cookie('admin', '1', {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: ADMIN_SESSION_TTL_SECONDS * 1000,
  });
  res.json({ ok: true });
});
app.post('/api/admin/logout', adminOnly, (req, res) => {
  res.clearCookie('admin');
  res.json({ ok: true });
});
app.get('/api/admin/check', (req, res) => {
  res.json({ ok: (req.signedCookies?.admin === '1') });
});

// Admin “open free” (no credit spent), fetches live + caches, returns HTML/PDF
app.post('/api/admin/open', adminOnly, async (req, res) => {
  try {
    const {
      vin: vinIn,
      state,
      plate,
      type = 'carfax',
      as = 'html'
    } = req.body || {};
    let vin = (vinIn || '').toUpperCase();

    if (!vin && state && plate) {
      const txt = await csGet(`${CS}/checkplate/${state}/${plate}`);
      const m = txt.match(/[A-HJ-NPR-Z0-9]{17}/);
      if (m) vin = m[0];
    }
    if (!vin) return res.status(400).json({ error: 'VIN or state+plate required' });

    await fetchAndCacheReport(vin, type.toLowerCase());
    const raw = readCache(vin, type.toLowerCase());
    const decoded = decodeReportBase64(raw);

    if (as === 'pdf') {
      if (decoded.kind === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${vin}-${type}.pdf"`);
        return res.send(decoded.buffer);
      }
      if (decoded.kind === 'html') {
        const form = new FormData();
        form.append('base64_content', Buffer.from(decoded.html, 'utf8').toString('base64'));
        form.append('vin', vin);
        form.append('report_type', type);
        const pdf = await axios.post(`${CS}/pdf`, form, {
          headers: { ...H, ...form.getHeaders() },
          responseType: 'arraybuffer',
          timeout: 60000,
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${vin}-${type}.pdf"`);
        return res.send(Buffer.from(pdf.data));
      }
      return res.status(500).json({ error: 'Unsupported content' });
    }

    if (decoded.kind === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(decoded.html);
    }
    if (decoded.kind === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${vin}-${type}.pdf"`);
      return res.send(decoded.buffer);
    }
    return res.status(500).json({ error: 'Unsupported content' });
  } catch (e) {
    console.error('admin open error:', e);
    res.status(500).json({ error: 'admin open failed' });
  }
});

// Cached-view helper (no spend, cache only)
app.get('/api/report-view', adminOnly, (req, res) => {
  const vin  = (req.query.vin || '').toUpperCase();
  const type = (req.query.type || 'carfax').toLowerCase();
  if (!vin) return res.status(400).send('vin required');
  const raw = readCache(vin, type);
  if (!raw) return res.status(404).send('not cached');
  const decoded = decodeReportBase64(raw);
  if (decoded.kind === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(decoded.html);
  }
  if (decoded.kind === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${vin}-${type}.pdf"`);
    return res.send(decoded.buffer);
  }
  return res.status(500).send('unsupported');
});

/* ================================================================
   👑 Admin – History APIs
================================================================ */
app.get('/api/admin/history', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(+(req.query.limit || 200), 1000);

    const { data: rows, error } = await supabaseService
      .from('vin_queries')
      .select('id, user_id, vin, success, result_url, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    const userIds = [...new Set(rows.map(r => r.user_id))];
    let emailByUser = {};
    if (userIds.length) {
      const { data: profiles, error: pErr } = await supabaseService
        .from('profiles')
        .select('id, email')
        .in('id', userIds);
      if (!pErr && profiles) {
        for (const p of profiles) emailByUser[p.id] = p.email || '';
      }
    }

    const mapped = rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      email: emailByUser[r.user_id] || '',
      vin: r.vin,
      success: !!r.success,
      result_url: r.result_url || null,
      created_at: r.created_at
    }));

    return res.json({ rows: mapped });
  } catch (e) {
    console.error('admin history error:', e);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

app.get('/api/admin/ledger', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(+(req.query.limit || 200), 1000);
    const { data: rows, error } = await supabaseService
      .from('credit_ledger')
      .select('id, user_id, delta, reason, ref, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    const userIds = [...new Set(rows.map(r => r.user_id))];
    let emailByUser = {};
    if (userIds.length) {
      const { data: profiles, error: pErr } = await supabaseService
        .from('profiles')
        .select('id, email')
        .in('id', userIds);
      if (!pErr && profiles) {
        for (const p of profiles) emailByUser[p.id] = p.email || '';
      }
    }

    const mapped = rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      email: emailByUser[r.user_id] || '',
      delta: r.delta,
      reason: r.reason,
      ref: r.ref,
      created_at: r.created_at
    }));

    res.json({ rows: mapped });
  } catch (e) {
    console.error('admin ledger error:', e);
    res.status(500).json({ error: 'Failed to load ledger' });
  }
});

app.get('/api/admin/cache', adminOnly, async (req, res) => {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.b64'));
    const rows = files.map(f => {
      const fp = path.join(CACHE_DIR, f);
      const st = fs.statSync(fp);
      const [vin, typeWithExt] = f.split('-');
      const type = typeWithExt.replace(/\.b64$/, '');
      return {
        vin,
        type,
        size_bytes: st.size,
        mtime: st.mtime
      };
    }).sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ rows });
  } catch (e) {
    console.error('admin cache list error:', e);
    res.status(500).json({ error: 'Failed to read cache' });
  }
});

/* ================================================================
   🔍 Route dump (debug)
================================================================ */
function dumpRoutes() {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map(k => k.toUpperCase()).join(',');
      routes.push(`${methods} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route && h.route.path) {
          const methods = Object.keys(h.route.methods).map(k => k.toUpperCase()).join(',');
          routes.push(`${methods} ${h.route.path}`);
        }
      });
    }
  });
  console.log('Mounted routes:\n' + routes.join('\n'));
}

/* ================================================================
   🗂️ Static (LAST)
================================================================ */
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================
   🚀 Boot
================================================================ */
const server = app.listen(PORT, HOST, () =>
  console.log(`✅ Server running on ${process.env.SITE_URL || `http://${HOST}:${PORT}`}`)
);
server.keepAliveTimeout = 120000;
server.headersTimeout   = 125000;

dumpRoutes();
