import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

/* ═══════════════════════════════════════════════
   AUTH LAYER — uses installed @supabase/supabase-js
   Credentials are hardcoded so no .env needed.
═══════════════════════════════════════════════ */
const _SB_URL = "https://aeydtncloiytcgslxotn.supabase.co";
const _SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFleWR0bmNsb2l5dGNnc2x4b3RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODI2NDEsImV4cCI6MjA5MDQ1ODY0MX0.FeIIGISw3fwb8OZ8MLxKvkICDZhK8hk9crnKfDB2MRo";

/* ── Shared singleton ── */
let _authClient = null;

function _getAuthClient() {
  if (_authClient) return _authClient;
  _authClient = createClient(_SB_URL, _SB_KEY, {
    auth: {
      persistSession: true,
      storageKey: "afl:sb:session",
      storage: localStorage,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return _authClient;
}

/* ── Local fallback (when Supabase is unreachable) ── */
const _LK_USERS   = "afl:local:users";
const _LK_SESSION = "afl:local:session";
const _lsGet = (k)    => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; } };
const _lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const _lsDel = (k)    => { try { localStorage.removeItem(k); } catch {} };
function _djb2(pw) { let h=5381; for(let i=0;i<pw.length;i++) h=(h*33)^pw.charCodeAt(i); return (h>>>0).toString(36); }

/* _emit used by local fallback signIn/signUp */
const _bus  = new Set();
const _emit = (user) => _bus.forEach(fn => fn(user));

/* ── Public auth API ── */

async function signUp(email, password, displayName) {
  const sb = _getAuthClient();

  if (sb) {
    /* ── Real Supabase sign-up ── */
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { display_name: displayName || email.split("@")[0] } },
    });
    if (error) return { user: null, session: null, error };
    /* If email confirmation is ON, session is null — tell the UI */
    return { user: data.user ?? null, session: data.session ?? null, error: null };
  }

  /* ── Local fallback ── */
  const users = _lsGet(_LK_USERS) ?? {};
  const key   = email.toLowerCase().trim();
  if (users[key]) return { user: null, session: null, error: { message: "An account with this email already exists." } };
  const user = {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    email: key,
    user_metadata: { display_name: displayName || key.split("@")[0] },
    created_at: new Date().toISOString(),
  };
  users[key] = { ...user, _hash: _djb2(password) };
  _lsSet(_LK_USERS, users);
  _lsSet(_LK_SESSION, { user });
  _emit(user);
  return { user, session: { user }, error: null };
}

async function signIn(email, password) {
  const sb = _getAuthClient();

  if (sb) {
    /* ── Real Supabase sign-in ── */
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { user: null, session: null, error: { message: "Incorrect email or password. Please try again." } };
    _emit(data.user);
    return { user: data.user ?? null, session: data.session ?? null, error: null };
  }

  /* ── Local fallback ── */
  const users  = _lsGet(_LK_USERS) ?? {};
  const key    = email.toLowerCase().trim();
  const record = users[key];
  if (!record || record._hash !== _djb2(password))
    return { user: null, session: null, error: { message: "Incorrect email or password. Please try again." } };
  const { _hash: _, ...user } = record;
  _lsSet(_LK_SESSION, { user });
  _emit(user);
  return { user, session: { user }, error: null };
}

async function signOut() {
  const sb = _getAuthClient();
  if (sb) {
    await sb.auth.signOut();
  } else {
    _lsDel(_LK_SESSION);
  }
  _emit(null);
  return { error: null };
}

async function getSession() {
  const sb = _getAuthClient();

  if (sb) {
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) return { user: data.session.user, session: data.session };
  }

  /* Local fallback */
  const s = _lsGet(_LK_SESSION);
  return s?.user ? { user: s.user, session: s } : { user: null, session: null };
}

function onAuthChange(callback) {
  const sb = _getAuthClient();

  /* Wire up real Supabase listener — this handles login/logout/refresh */
  const { data } = sb.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null, session);
  });

  return {
    data: {
      subscription: {
        unsubscribe: () => data.subscription.unsubscribe(),
      },
    },
  };
}

function getUserDisplayName(u) {
  if (!u) return "Guest";
  return u.user_metadata?.display_name
    || u.user_metadata?.full_name
    || u.email?.split("@")[0]
    || "User";
}

/* ═══════════════════════════════════════════════
   DATABASE LAYER — reuses the auth client
   ▸ Artifact preview: Supabase blocked → localStorage
   ▸ Local Vite project: full cloud sync via user_data table
═══════════════════════════════════════════════ */

/* Reuse the same client the auth layer already loaded */
function _getDB() {
  return _getAuthClient();   // shared singleton
}

/**
 * Load library + mixes for a user.
 * Returns { library: [], mixes: [], source: "supabase"|"local" }
 */
async function dbLoad(userId) {
  const sb = _getDB();
  if (sb) {
    try {
      const { data, error } = await sb
        .from("user_data")
        .select("library, mixes")
        .eq("user_id", userId)
        .maybeSingle();
      if (!error && data) {
        return { library: data.library ?? [], mixes: data.mixes ?? [], source: "supabase" };
      }
    } catch { /* network blocked — fall through to local */ }
  }
  /* localStorage fallback */
  const lib = localStorage.getItem(`afl:${userId}:lib`);
  const mix = localStorage.getItem(`afl:${userId}:mixes`);
  return {
    library: lib ? JSON.parse(lib) : [],
    mixes:   mix ? JSON.parse(mix) : [],
    source:  "local",
  };
}

/**
 * Save library + mixes for a user.
 * Always writes localStorage immediately (instant, offline-safe),
 * then attempts to upsert to Supabase.
 * Returns "supabase" | "local" depending on which succeeded.
 */
async function dbSave(userId, library, mixes) {
  /* 1 — always persist locally first for instant resilience */
  localStorage.setItem(`afl:${userId}:lib`,   JSON.stringify(library));
  localStorage.setItem(`afl:${userId}:mixes`, JSON.stringify(mixes));

  /* 2 — attempt cloud sync */
  const sb = _getDB();
  if (sb) {
    try {
      const { error } = await sb.from("user_data").upsert(
        { user_id: userId, library, mixes, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (!error) return "supabase";
    } catch { /* blocked or network error — local is already saved */ }
  }
  return "local";
}

/* ═══════════════════════════════════════════════
   FRAGRANCE DATABASE  (25 curated perfumes)
═══════════════════════════════════════════════ */
const DB = [
  { id:"f1",  name:"Sauvage EDP",          brand:"Dior",              top:["Bergamot","Pepper"],                 mid:["Lavender","Geranium","Vetiver"],               base:["Ambroxan","Cedar","Labdanum"],                    family:"Fresh Spicy",       lon:9, sil:9, gen:"M" },
  { id:"f2",  name:"Bleu de Chanel EDP",   brand:"Chanel",            top:["Grapefruit","Lemon","Pink Pepper"],  mid:["Ginger","Nutmeg","Jasmine"],                  base:["Incense","Vetiver","Cedar","Sandalwood"],         family:"Aromatic Woody",    lon:8, sil:7, gen:"M" },
  { id:"f3",  name:"Black Opium",          brand:"YSL",               top:["Pink Pepper","Orange Blossom"],      mid:["Coffee","Jasmine","Bitter Almond"],           base:["Patchouli","Vanilla","Cedarwood","White Musk"],   family:"Oriental Floral",   lon:8, sil:8, gen:"F" },
  { id:"f4",  name:"Tobacco Vanille",      brand:"Tom Ford",          top:["Tobacco Leaf","Spices"],             mid:["Vanilla","Cacao","Tonka Bean"],               base:["Dried Fruits","Woody Notes","Oakmoss"],           family:"Oriental Spicy",    lon:10,sil:8, gen:"U" },
  { id:"f5",  name:"Aventus",              brand:"Creed",             top:["Pineapple","Bergamot","Apple"],      mid:["Rose","Dry Birch","Jasmine","Patchouli"],     base:["Musk","Oakmoss","Ambergris","Vanilla"],           family:"Fruity Chypre",     lon:9, sil:8, gen:"M" },
  { id:"f6",  name:"Flowerbomb",           brand:"Viktor & Rolf",     top:["Tea","Bergamot","Osmanthus"],        mid:["Freesia","Jasmine","Orchid","Rose"],          base:["Patchouli","Musk"],                              family:"Floral Oriental",   lon:8, sil:8, gen:"F" },
  { id:"f7",  name:"Acqua di Giò",         brand:"Armani",            top:["Bergamot","Neroli","Marine"],        mid:["Rosemary","Jasmine","Sage"],                  base:["Patchouli","Cedar","White Musk"],                 family:"Aquatic Fresh",     lon:7, sil:7, gen:"M" },
  { id:"f8",  name:"Baccarat Rouge 540",   brand:"MFK",               top:["Jasmine","Saffron"],                 mid:["Amberwood","Ambergris"],                      base:["Fir Resin","Cedar"],                             family:"Floral Woody Musk", lon:10,sil:10,gen:"U" },
  { id:"f9",  name:"Oud Wood",             brand:"Tom Ford",          top:["Oud Wood","Rosewood","Cardamom"],    mid:["Sandalwood","Vetiver","Papyrus"],             base:["Tonka Bean","Amber","Musk"],                      family:"Woody Oriental",    lon:9, sil:7, gen:"U" },
  { id:"f10", name:"Coco Mademoiselle",    brand:"Chanel",            top:["Orange","Bergamot"],                 mid:["Rose","Jasmine","Ylang-Ylang"],               base:["Patchouli","Vetiver","Vanilla","White Musk"],     family:"Oriental Floral",   lon:8, sil:8, gen:"F" },
  { id:"f11", name:"La Vie Est Belle",     brand:"Lancôme",           top:["Blackcurrant","Pear"],               mid:["Iris","Jasmine","Orange Blossom"],            base:["Patchouli","Praline","Vanilla","Sandalwood"],     family:"Oriental Floral",   lon:8, sil:8, gen:"F" },
  { id:"f12", name:"Neroli Portofino",     brand:"Tom Ford",          top:["Neroli","Bergamot","Lemon"],         mid:["Rosewood","Jasmine"],                         base:["Amber","Ambrette"],                              family:"Fresh Citrus",      lon:6, sil:6, gen:"U" },
  { id:"f13", name:"Y EDP",               brand:"YSL",               top:["Ginger","Bergamot","Apple"],         mid:["Sage","Geranium","Juniper"],                  base:["Cedarwood","Ambergris","Vetiver"],                family:"Fresh Woody",       lon:8, sil:8, gen:"M" },
  { id:"f14", name:"Versace Eros",         brand:"Versace",           top:["Mint","Apple","Lemon"],              mid:["Tonka Bean","Ambroxan","Geranium"],           base:["Vanilla","Vetiver","Oak Moss","Cedar"],           family:"Oriental Fresh",    lon:8, sil:8, gen:"M" },
  { id:"f15", name:"Chanel No.5",          brand:"Chanel",            top:["Ylang-Ylang","Neroli","Aldehydes"],  mid:["Jasmine","Rose","Lily of the Valley"],        base:["Sandalwood","Civet","Ambergris","Vetiver"],       family:"Floral Aldehyde",   lon:8, sil:7, gen:"F" },
  { id:"f16", name:"Good Girl",            brand:"Carolina Herrera",  top:["Coffee","Almond","Bergamot"],        mid:["Tuberose","Jasmine Sambac"],                  base:["Tonka Bean","Cocoa","Sandalwood","Cedar"],        family:"Floral Oriental",   lon:9, sil:9, gen:"F" },
  { id:"f17", name:"Molecule 01",          brand:"Escentric Molecules",top:["Iso E Super"],                      mid:["Iso E Super"],                                base:["Iso E Super"],                                   family:"Woody Synthetic",   lon:7, sil:4, gen:"U" },
  { id:"f18", name:"Terre d'Hermès",       brand:"Hermès",            top:["Grapefruit","Orange"],               mid:["Pepper","Flint","Geranium"],                  base:["Vetiver","Cedar","Patchouli","Benzoin"],          family:"Woody Citrus",      lon:8, sil:7, gen:"M" },
  { id:"f19", name:"Angel",               brand:"Mugler",            top:["Melon","Bergamot","Cotton Candy"],   mid:["Honey","Jasmine","Red Berries"],              base:["Patchouli","Vanilla","Dark Chocolate","Caramel"],  family:"Oriental Gourmand", lon:10,sil:10,gen:"F" },
  { id:"f20", name:"Miss Dior Blooming",   brand:"Dior",              top:["Bergamot","Peach"],                  mid:["Grasse Rose","Peony"],                        base:["White Musk","Patchouli"],                         family:"Floral Chypre",     lon:7, sil:7, gen:"F" },
  { id:"f21", name:"Light Blue",           brand:"D&G",               top:["Sicilian Lemon","Apple"],            mid:["Bamboo","Jasmine","White Rose"],              base:["Cedar","Musk","Amber"],                          family:"Fresh Floral",      lon:6, sil:6, gen:"F" },
  { id:"f22", name:"Fahrenheit",           brand:"Dior",              top:["Violet Leaf","Lavender"],            mid:["Leather","Cedar","Nutmeg"],                   base:["Sandalwood","Amber","Vetiver"],                   family:"Woody Oriental",    lon:8, sil:7, gen:"M" },
  { id:"f23", name:"Reflection Man",       brand:"Amouage",           top:["Neroli","Lemon"],                    mid:["Jasmine","Rose","Lily of the Valley"],        base:["Sandalwood","Vetiver","Musk"],                    family:"Floral Woody",      lon:8, sil:8, gen:"M" },
  { id:"f24", name:"Shalimar",             brand:"Guerlain",          top:["Bergamot","Lemon","Mandarin"],       mid:["Jasmine","Rose","Iris"],                      base:["Benzoin","Opoponax","Vanilla","Tonka Bean"],       family:"Oriental",          lon:9, sil:8, gen:"F" },
  { id:"f25", name:"Dior Homme Intense",   brand:"Dior",              top:["Lemon","Lavender","Iris"],           mid:["Iris","Orris Root","Cocoa"],                  base:["Amber","Vetiver","Patchouli","Musk"],             family:"Floral Woody",      lon:9, sil:8, gen:"M" },
];

const OCCASIONS = [
  { id:"daily",  icon:"☀️",  label:"Daily Wear",   desc:"Fresh & versatile" },
  { id:"date",   icon:"🌙",  label:"Date Night",   desc:"Romantic & seductive" },
  { id:"formal", icon:"🎩",  label:"Formal",        desc:"Confident & sophisticated" },
  { id:"gym",    icon:"⚡",  label:"Gym / Fresh",  desc:"Clean & energizing" },
];

const FAMILY_COLORS = {
  "Fresh Spicy":"#5ec9c9","Aromatic Woody":"#c4a060","Oriental Floral":"#e880a8",
  "Oriental Spicy":"#d47840","Fruity Chypre":"#d4a040","Floral Oriental":"#e090b0",
  "Aquatic Fresh":"#5bb5d5","Floral Woody Musk":"#c8a0d8","Woody Oriental":"#906840",
  "Fresh Citrus":"#d8c840","Fresh Woody":"#78b068","Oriental Fresh":"#a8c870",
  "Floral Aldehyde":"#f0d0a0","Woody Synthetic":"#9090a0","Woody Citrus":"#c8b060",
  "Oriental Gourmand":"#c87840","Floral Chypre":"#d070a0","Fresh Floral":"#90c888",
  "Oriental":"#d07840","Floral Woody":"#c890c0",
};

const FRESH_NOTES = ["Bergamot","Lemon","Grapefruit","Orange","Neroli","Marine","Mint","Apple","Pear","Sicilian Lemon","Melon","Cotton Candy","Peach","Blackcurrant","Pineapple","Ginger"];
const BASE_NOTE_KEYWORDS = ["Patchouli","Vanilla","Sandalwood","Cedar","Vetiver","Musk","Amber","Oud","Tonka","Benzoin","Oakmoss","Incense","Labdanum"];

/* ═══════════════════════════════════════════════
   GLOBAL CSS  — now with light/dark themes + responsive
═══════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400;1,600&family=DM+Mono:wght@300;400&family=Outfit:wght@300;400;500;600&display=swap&display=swap');

/* ════════════════════════════
   THEME TOKENS
════════════════════════════ */
:root {
  /* dark mode defaults */
  --bg:#0b0a0f;--surf:#141220;--card:#1b1928;--card2:#201e2e;
  --bord:#2a2840;--bord2:#38354e;
  --gold:#c9a84c;--gold2:#e8c970;--gold-dim:#7a6030;
  --pur:#9b7cd4;--pur-dim:#4a3870;
  --text:#f0eadc;--muted:#8a8098;--dim:#4a4860;
  --ok:#5ec88a;--err:#e06060;
  --r:12px;--rsm:8px;
  /* shadows */
  --shadow-sm:0 2px 8px rgba(0,0,0,.3);
  --shadow-md:0 8px 32px rgba(0,0,0,.4);
  --shadow-gold:0 6px 24px rgba(201,168,76,.3);
}

[data-theme="light"] {
  --bg:#faf9f6;--surf:#ffffff;--card:#ffffff;--card2:#f5f3ee;
  --bord:#e8e4db;--bord2:#d4cfc3;
  --gold:#b8922e;--gold2:#c9a84c;--gold-dim:#e8d9b8;
  --pur:#7b5cb4;--pur-dim:#ede8f8;
  --text:#1a1714;--muted:#6b6560;--dim:#b0a898;
  --ok:#3a9e68;--err:#c04040;
  /* shadows — softer on light */
  --shadow-sm:0 2px 8px rgba(0,0,0,.08);
  --shadow-md:0 8px 32px rgba(0,0,0,.12);
  --shadow-gold:0 6px 24px rgba(184,146,46,.25);
}

/* ════════════════════════════
   RESET + BASE
════════════════════════════ */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg);color:var(--text);font-family:'Outfit',sans-serif;
  line-height:1.5;overflow:hidden;
  transition:background .3s,color .3s;
  opacity:1;
}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bord2);border-radius:3px}
input,textarea,select{
  background:var(--card);border:1px solid var(--bord);color:var(--text);
  border-radius:var(--rsm);padding:10px 14px;font-family:'Outfit',sans-serif;font-size:14px;
  outline:none;transition:border-color .2s,box-shadow .2s,background .3s;width:100%
}
input:focus,textarea:focus,select:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.12)}
input::placeholder,textarea::placeholder{color:var(--dim)}
button{cursor:pointer;border:none;font-family:'Outfit',sans-serif;transition:all .2s}

/* ════════════════════════════
   ANIMATIONS
════════════════════════════ */
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes shimmer{0%{background-position:-600px 0}100%{background-position:600px 0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes glow{0%,100%{box-shadow:0 0 20px rgba(201,168,76,.15)}50%{box-shadow:0 0 40px rgba(201,168,76,.35)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes slideIn{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:translateX(0)}}
@keyframes slideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes compatGlow{0%,100%{box-shadow:0 0 0 rgba(94,200,138,0)}50%{box-shadow:0 0 18px rgba(94,200,138,.2)}}
@keyframes warnGlow{0%,100%{box-shadow:0 0 0 rgba(224,160,96,0)}50%{box-shadow:0 0 18px rgba(224,160,96,.2)}}
@keyframes themeSwitch{0%{transform:scale(1)}50%{transform:scale(.85) rotate(20deg)}100%{transform:scale(1)}}
@keyframes goldShine{0%{background-position:200% center}100%{background-position:-200% center}}
@keyframes scaleIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
@keyframes skeletonWave{0%{background-position:-400px 0}100%{background-position:400px 0}}

/* Logo entrance — letter-by-letter feel via blur */
@keyframes logoReveal{
  0%  {opacity:0;filter:blur(12px);letter-spacing:8px}
  60% {opacity:1;filter:blur(0);letter-spacing:5px}
  100%{opacity:1;filter:blur(0);letter-spacing:4px}
}
/* Tagline soft fade */
@keyframes tagReveal{
  0%  {opacity:0;transform:translateY(6px)}
  100%{opacity:1;transform:translateY(0)}
}
/* Splash screen logo pulse ring */
@keyframes ringPulse{
  0%  {transform:scale(.9);opacity:.6}
  50% {transform:scale(1.15);opacity:.15}
  100%{transform:scale(.9);opacity:.6}
}
/* Page cross-fade */
@keyframes pageFadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

.fu{animation:pageFadeIn .5s cubic-bezier(.16,1,.3,1) forwards}
.fi{animation:fadeIn .35s ease forwards}
.si{animation:slideIn .4s cubic-bezier(.16,1,.3,1) forwards}
.su{animation:slideUp .35s ease forwards}
.sc{animation:scaleIn .4s cubic-bezier(.16,1,.3,1) forwards}

/* ════════════════════════════
   SKELETON LOADER
════════════════════════════ */
.skeleton{
  border-radius:var(--rsm);
  background:linear-gradient(90deg,var(--bord) 25%,var(--bord2) 50%,var(--bord) 75%);
  background-size:600px 100%;
  animation:skeletonWave 1.4s ease infinite;
}
.skeleton-text{height:14px;margin-bottom:8px}
.skeleton-title{height:28px;margin-bottom:12px;border-radius:6px}
.skeleton-card{
  background:var(--card);border:1px solid var(--bord);
  border-radius:var(--r);padding:20px;
}
.skeleton-avatar{width:36px;height:36px;border-radius:50%}
.skeleton-badge{height:22px;width:80px;border-radius:20px}

/* ════════════════════════════
   LAYOUT — DESKTOP
════════════════════════════ */
.layout{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar (desktop/tablet) ── */
.sidebar{
  width:64px;background:var(--surf);border-right:1px solid var(--bord);
  display:flex;flex-direction:column;align-items:center;padding:16px 0;gap:4px;
  flex-shrink:0;z-index:10;transition:background .3s,border-color .3s;
}
.sidebar-logo{font-family:'Cormorant Garamond',serif;font-size:22px;color:var(--gold);margin-bottom:16px;letter-spacing:1px}
.nav-btn{
  width:44px;height:44px;border-radius:10px;background:transparent;
  display:flex;align-items:center;justify-content:center;color:var(--muted);
  font-size:20px;position:relative;transition:all .2s;
}
.nav-btn:hover{background:var(--card);color:var(--text)}
.nav-btn.active{background:var(--card2);color:var(--gold);box-shadow:inset 3px 0 0 var(--gold)}
.nav-btn .tip{
  position:absolute;left:54px;background:var(--surf);border:1px solid var(--bord2);
  color:var(--text);font-size:12px;padding:5px 10px;border-radius:6px;white-space:nowrap;
  pointer-events:none;opacity:0;transition:opacity .15s;z-index:100;
  box-shadow:var(--shadow-sm);
}
.nav-btn:hover .tip{opacity:1}
.nav-badge{
  position:absolute;top:4px;right:4px;background:var(--gold);color:#fff;
  font-size:9px;font-weight:600;min-width:16px;height:16px;border-radius:8px;
  display:flex;align-items:center;justify-content:center;padding:0 3px;
}
[data-theme="light"] .nav-badge{color:#0b0a0f}
.sidebar-spacer{flex:1}
.user-avatar{
  width:36px;height:36px;border-radius:50%;background:var(--pur-dim);
  border:2px solid var(--pur);display:flex;align-items:center;justify-content:center;
  font-size:14px;font-weight:600;color:var(--pur);cursor:pointer;
}
[data-theme="dark"] .user-avatar{color:var(--text)}

/* ── Mobile bottom nav (hidden on desktop) ── */
.mobile-nav{
  display:none;position:fixed;bottom:0;left:0;right:0;height:60px;
  background:var(--surf);border-top:1px solid var(--bord);z-index:200;
  align-items:center;justify-content:space-around;padding:0 8px;
  box-shadow:0 -4px 20px rgba(0,0,0,.08);
}
.mob-nav-btn{
  flex:1;height:52px;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:3px;background:transparent;color:var(--muted);
  border-radius:10px;font-size:19px;transition:all .2s;position:relative;
}
.mob-nav-btn.active{color:var(--gold)}
.mob-nav-btn.active::after{content:'';display:block;width:4px;height:4px;border-radius:50%;background:var(--gold);margin:0 auto;margin-top:-2px}
.mob-nav-label{font-size:9px;text-transform:uppercase;letter-spacing:.4px;font-weight:500;line-height:1}
.mob-badge{
  position:absolute;top:6px;right:calc(50% - 18px);background:var(--gold);color:#0b0a0f;
  font-size:8px;font-weight:700;min-width:14px;height:14px;border-radius:7px;
  display:flex;align-items:center;justify-content:center;padding:0 2px;
}

/* Mobile top bar (hidden on desktop) */
.mobile-topbar{
  display:none;height:52px;background:var(--surf);border-bottom:1px solid var(--bord);
  align-items:center;justify-content:space-between;padding:0 16px;flex-shrink:0;
}
.mobile-topbar-logo{font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--gold);letter-spacing:2px}

.main{flex:1;overflow:hidden;display:flex;flex-direction:column}
.page{flex:1;overflow-y:auto;padding:32px;will-change:opacity,transform}

/* ════════════════════════════
   THEME TOGGLE BUTTON
════════════════════════════ */
.theme-switch{
  display:inline-flex;align-items:center;gap:7px;cursor:pointer;flex-shrink:0;user-select:none;
}
.theme-switch-track{
  width:42px;height:24px;border-radius:12px;position:relative;
  background:var(--bord2);border:1px solid var(--bord2);
  transition:background .3s,border-color .3s;flex-shrink:0;
}
.theme-switch-track.on{background:var(--gold);border-color:var(--gold)}
.theme-switch-thumb{
  position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);
  transition:transform .25s cubic-bezier(.34,1.56,.64,1);
  display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;
}
.theme-switch-track.on .theme-switch-thumb{transform:translateX(18px)}
.theme-switch-label{font-size:11px;color:var(--muted);letter-spacing:.3px}
.theme-switch-sidebar{flex-direction:column;gap:4px;margin-bottom:12px}
.theme-switch-sidebar .theme-switch-label{display:none}

/* USER MENU */
.user-menu{position:relative;display:flex;flex-direction:column;align-items:center}
.user-menu-avatar{
  width:36px;height:36px;border-radius:50%;
  background:var(--pur-dim);border:2px solid var(--pur);
  display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:600;color:var(--pur);
  cursor:pointer;overflow:hidden;transition:border-color .2s,box-shadow .2s;flex-shrink:0;
}
.user-menu-avatar:hover{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,168,76,.2)}
.user-menu-avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.user-menu-dropdown{
  position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);
  background:var(--surf);border:1px solid var(--bord2);border-radius:12px;
  min-width:190px;box-shadow:var(--shadow-md);z-index:500;
  animation:fadeUp .18s ease;overflow:hidden;
}
.user-menu-dropdown.down{bottom:auto;top:calc(100% + 10px)}
.user-menu-header{padding:14px 16px 10px;border-bottom:1px solid var(--bord)}
.user-menu-name{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.user-menu-email{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.user-menu-item{
  display:flex;align-items:center;gap:10px;padding:11px 16px;
  font-size:13px;color:var(--text);cursor:pointer;transition:background .15s;
  background:transparent;width:100%;text-align:left;border:none;
}
.user-menu-item:hover{background:var(--card2)}
.user-menu-item.danger{color:var(--err)}
.user-menu-item.danger:hover{background:rgba(224,96,96,.08)}
.user-menu-item-icon{font-size:15px;width:18px;text-align:center;flex-shrink:0}
.user-menu-divider{height:1px;background:var(--bord);margin:2px 0}

/* ════════════════════════════
   BUTTONS
════════════════════════════ */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:11px 22px;border-radius:var(--rsm);font-size:14px;font-weight:500;letter-spacing:.3px;
}
.btn-gold{background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:#fff}
[data-theme="dark"] .btn-gold{color:#0b0a0f}
.btn-gold:hover{opacity:.9;transform:translateY(-1px);box-shadow:var(--shadow-gold)}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--bord)}
.btn-ghost:hover{background:var(--card);color:var(--text);border-color:var(--bord2)}
.btn-surf{background:var(--card2);color:var(--text)}
.btn-surf:hover{background:var(--bord)}
.btn-err{background:rgba(224,96,96,.1);color:var(--err);border:1px solid rgba(224,96,96,.3)}
.btn-err:hover{background:rgba(224,96,96,.2)}
.btn-sm{padding:7px 14px;font-size:12px;border-radius:6px}
.btn:disabled{opacity:.4;pointer-events:none}

/* ════════════════════════════
   CARDS
════════════════════════════ */
.card{
  background:var(--card);border:1px solid var(--bord);border-radius:var(--r);
  padding:20px;transition:background .3s,border-color .3s;
}
.card:hover{border-color:var(--bord2)}
[data-theme="light"] .card{box-shadow:var(--shadow-sm)}

/* ════════════════════════════
   AUTH
════════════════════════════ */
.auth-bg{
  min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(155,124,212,.12) 0%,transparent 60%),
  radial-gradient(ellipse 60% 40% at 80% 100%,rgba(201,168,76,.08) 0%,transparent 50%),var(--bg);
  overflow:auto;padding:20px;
}
[data-theme="light"] .auth-bg{
  background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(201,168,76,.1) 0%,transparent 60%),
  radial-gradient(ellipse 60% 40% at 80% 100%,rgba(155,124,212,.06) 0%,transparent 50%),var(--bg);
}
.auth-card{
  background:var(--surf);border:1px solid var(--bord);border-radius:20px;
  padding:48px 40px;width:100%;max-width:420px;
  box-shadow:var(--shadow-md);
  animation:scaleIn .5s cubic-bezier(.16,1,.3,1) forwards;
}
.auth-logo{
  font-family:'Cormorant Garamond',serif;font-size:40px;font-weight:300;
  color:var(--gold);text-align:center;letter-spacing:3px;margin-bottom:4px;
  animation:logoReveal .8s cubic-bezier(.16,1,.3,1) forwards;
}
.auth-tagline{
  text-align:center;color:var(--muted);font-size:13px;margin-bottom:36px;letter-spacing:.5px;
  animation:tagReveal .6s ease .3s both;
}
.auth-card{animation:scaleIn .5s cubic-bezier(.16,1,.3,1) forwards}
.auth-tab{display:flex;background:var(--card);border-radius:var(--rsm);padding:4px;margin-bottom:28px;gap:4px}
.auth-tab button{flex:1;padding:9px;border-radius:6px;font-size:13px;color:var(--muted);background:transparent}
.auth-tab button.active{background:var(--card2);color:var(--text)}
.form-row{margin-bottom:16px}
.form-label{font-size:12px;color:var(--muted);margin-bottom:6px;display:block;letter-spacing:.5px;text-transform:uppercase}
.auth-divider{text-align:center;color:var(--dim);font-size:12px;margin:20px 0;position:relative}
.auth-divider::before,.auth-divider::after{content:'';position:absolute;top:50%;width:42%;height:1px;background:var(--bord)}
.auth-divider::before{left:0}.auth-divider::after{right:0}
.guest-btn{width:100%;padding:11px;border-radius:var(--rsm);background:transparent;border:1px dashed var(--bord2);color:var(--muted);font-size:13px}
.guest-btn:hover{border-color:var(--gold-dim);color:var(--text)}

/* ════════════════════════════
   DASHBOARD
════════════════════════════ */
.page-header{margin-bottom:32px}
.page-title{
  font-family:'Cormorant Garamond',serif;font-size:34px;font-weight:500;font-style:italic;
  letter-spacing:.5px;line-height:1.2;
  background:linear-gradient(120deg,var(--gold) 0%,var(--gold2) 50%,var(--gold) 100%);
  background-size:200% auto;
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  animation:goldShine 4s linear infinite;
}
.page-sub{color:var(--muted);font-size:14px;margin-top:5px;letter-spacing:.2px}
.stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
.stat-card{
  background:var(--card);border:1px solid var(--bord);border-radius:var(--r);padding:20px 24px;
  box-shadow:var(--shadow-sm);transition:transform .2s,border-color .2s,box-shadow .2s;
  position:relative;overflow:hidden;
}
.stat-card::after{
  content:'';position:absolute;inset:0;border-radius:var(--r);
  background:linear-gradient(135deg,rgba(201,168,76,.04) 0%,transparent 60%);
  pointer-events:none;
}
.stat-card:hover{transform:translateY(-2px);border-color:var(--gold-dim);box-shadow:var(--shadow-gold)}
.stat-n{
  font-family:'Cormorant Garamond',serif;font-size:44px;font-weight:500;line-height:1;
  background:linear-gradient(120deg,var(--gold) 0%,var(--gold2) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.stat-label{font-size:11px;color:var(--muted);margin-top:5px;text-transform:uppercase;letter-spacing:.8px;font-weight:500}
.cta-mix{
  background:linear-gradient(135deg,rgba(201,168,76,.15) 0%,rgba(155,124,212,.1) 100%);
  border:1px solid var(--gold-dim);border-radius:var(--r);padding:28px 32px;
  display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;cursor:pointer;
  transition:all .2s;animation:glow 4s infinite;gap:16px;
}
[data-theme="light"] .cta-mix{background:linear-gradient(135deg,rgba(184,146,46,.1) 0%,rgba(123,92,180,.07) 100%)}
.cta-mix:hover{border-color:var(--gold);transform:translateY(-1px)}
.cta-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-style:italic;color:var(--gold)}
.cta-desc{font-size:13px;color:var(--muted);margin-top:4px}

/* ════════════════════════════
   LIBRARY
════════════════════════════ */
.lib-top{display:flex;align-items:center;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.search-wrap{flex:1;min-width:180px;position:relative}
.search-wrap input{padding-left:36px}
.search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--dim);pointer-events:none;font-size:14px}
.frag-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.frag-card{
  background:var(--card);border:1px solid var(--bord);border-radius:var(--r);
  padding:18px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden;
  box-shadow:var(--shadow-sm);
}
.frag-card::before{content:'';position:absolute;inset:0;border-radius:var(--r);border:2px solid transparent;transition:border-color .2s;pointer-events:none}
.frag-card.selected{border-color:var(--gold)}
.frag-card.selected::before{border-color:var(--gold)}
.frag-card:hover{border-color:var(--gold-dim);transform:translateY(-3px);box-shadow:var(--shadow-gold)}
.frag-family-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.frag-name{font-size:16px;font-weight:500;color:var(--text);margin-bottom:2px}
.frag-brand{font-size:12px;color:var(--muted)}
.frag-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:.4px;text-transform:uppercase;margin-top:8px}
.notes-section{margin-top:12px}
.notes-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-family:'DM Mono',monospace;margin-bottom:4px}
.notes-wrap{display:flex;flex-wrap:wrap;gap:4px}
.note-tag{display:inline-flex;align-items:center;padding:2px 7px;background:var(--card2);border:1px solid var(--bord);border-radius:5px;font-size:10px;color:var(--muted);font-family:'DM Mono',monospace}
.bars-row{display:flex;gap:16px;margin-top:14px}
.bar-item{flex:1}
.bar-label-row{display:flex;justify-content:space-between;margin-bottom:4px}
.bar-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
.bar-val{font-size:10px;font-family:'DM Mono',monospace;color:var(--muted)}
.bar-track{height:4px;background:var(--bord);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;transition:width .6s ease}
.frag-sel-check{position:absolute;top:12px;right:12px;width:22px;height:22px;border-radius:50%;background:var(--gold);display:flex;align-items:center;justify-content:center;font-size:11px;opacity:0;transition:opacity .2s}
[data-theme="dark"] .frag-sel-check{color:#0b0a0f}
.frag-card.selected .frag-sel-check{opacity:1}
.empty-lib{text-align:center;padding:80px 20px;color:var(--muted)}
.empty-icon{font-size:48px;margin-bottom:16px;opacity:.5;display:block;animation:float 3s ease-in-out infinite}
.empty-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-style:italic;color:var(--text);margin-bottom:8px}

/* ════════════════════════════
   MIXER
════════════════════════════ */
.mixer-layout{display:grid;grid-template-columns:340px 1fr;gap:24px;align-items:start}
.step-label{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--gold);font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.step-num{width:20px;height:20px;border-radius:50%;background:var(--gold-dim);color:var(--gold2);font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:700}
[data-theme="light"] .step-num{color:var(--bg)}
.occ-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px}
.occ-btn{padding:12px;border-radius:var(--rsm);background:var(--card);border:2px solid var(--bord);text-align:left;transition:all .2s;cursor:pointer}
.occ-btn:hover{border-color:var(--bord2);background:var(--card2)}
.occ-btn.active{border-color:var(--gold);background:rgba(201,168,76,.08)}
[data-theme="light"] .occ-btn.active{background:rgba(184,146,46,.06)}
.occ-icon{font-size:20px;display:block;margin-bottom:4px}
.occ-label{font-size:13px;font-weight:500;color:var(--text)}
.occ-desc{font-size:11px;color:var(--muted)}
.mixer-sel-list{display:flex;flex-direction:column;gap:8px;margin-bottom:20px;max-height:240px;overflow-y:auto}
.sel-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--card2);border-radius:var(--rsm);border:1px solid var(--bord)}
.sel-item-name{font-size:13px;color:var(--text);flex:1}
.sel-item-brand{font-size:11px;color:var(--muted)}
.sel-remove{width:22px;height:22px;border-radius:50%;background:transparent;color:var(--muted);font-size:14px;display:flex;align-items:center;justify-content:center}
.sel-remove:hover{background:rgba(224,96,96,.2);color:var(--err)}
.gen-btn{width:100%;padding:15px;border-radius:var(--r);font-size:15px;font-weight:600;background:linear-gradient(135deg,var(--gold) 0%,var(--gold2) 100%);color:#fff;position:relative;overflow:hidden}
[data-theme="dark"] .gen-btn{color:#0b0a0f}
.gen-btn:hover{opacity:.9;transform:translateY(-1px);box-shadow:var(--shadow-gold)}
.gen-btn:disabled{opacity:.4;transform:none;box-shadow:none}
.mix-hint{font-size:12px;color:var(--dim);text-align:center;margin-top:10px}
.results-area{display:flex;flex-direction:column;gap:20px}
.result-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;height:400px;background:var(--card);border:1px dashed var(--bord);border-radius:var(--r);color:var(--muted);gap:12px}
.result-placeholder-icon{font-size:48px;opacity:.3;animation:float 4s ease-in-out infinite}
.loading-card{background:var(--card);border:1px solid var(--bord);border-radius:var(--r);padding:48px 40px;display:flex;flex-direction:column;align-items:center;gap:20px;box-shadow:var(--shadow-sm)}
.spinner{width:40px;height:40px;border:3px solid var(--bord);border-top-color:var(--gold);border-right-color:var(--gold-dim);border-radius:50%;animation:spin 0.75s cubic-bezier(.5,0,.5,1) infinite}
.spinner-sm{width:20px;height:20px;border:2px solid var(--bord);border-top-color:var(--gold);border-radius:50%;animation:spin 0.75s linear infinite}

/* ════════════════════════════
   MIX RESULT CARD
════════════════════════════ */
.mix-card{
  background:var(--card);border:1px solid var(--bord);border-radius:var(--r);
  overflow:hidden;animation:scaleIn .4s cubic-bezier(.22,.68,0,1.2) forwards;
  box-shadow:var(--shadow-sm);transition:border-color .25s,box-shadow .25s;
}
.mix-card:hover{border-color:var(--gold-dim);box-shadow:var(--shadow-gold)}
.mix-card-header{
  padding:22px 24px;border-bottom:1px solid var(--bord);
  display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  background:linear-gradient(135deg,rgba(201,168,76,.05) 0%,transparent 50%);
}
[data-theme="light"] .mix-card-header{background:linear-gradient(135deg,rgba(184,146,46,.04) 0%,transparent 50%)}
.mix-card-name{
  font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:500;font-style:italic;
  margin-bottom:5px;
  background:linear-gradient(120deg,var(--gold) 0%,var(--gold2) 60%,var(--gold) 100%);
  background-size:200% auto;
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  animation:goldShine 5s linear infinite;
}
.mix-card-tagline{font-size:13px;color:var(--muted);line-height:1.5}
.score-ring{flex-shrink:0}
.mix-card-body{padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
.mix-frags{grid-column:1/-1}
.mix-frag-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--card2);border-radius:var(--rsm);margin-bottom:8px}
.mix-ratio-bar{flex:1;height:8px;background:var(--bord);border-radius:4px;overflow:hidden}
.mix-ratio-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--gold-dim),var(--gold),var(--gold2));transition:width .8s cubic-bezier(.22,.68,0,1.2)}
.mix-ratio-num{font-family:'DM Mono',monospace;font-size:12px;color:var(--gold);min-width:32px;text-align:right;font-weight:500}
.section-head{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:10px;font-weight:500}
.profile-phases{display:flex;flex-direction:column;gap:8px}
.phase{padding:10px 12px;background:var(--card2);border-radius:var(--rsm);border-left:3px solid}
.phase-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:3px;font-family:'DM Mono',monospace}
.phase-text{font-size:12px;color:var(--text);line-height:1.5}
.app-order{display:flex;flex-direction:column;gap:6px}
.app-step{display:flex;gap:10px;align-items:flex-start;font-size:12px;color:var(--muted)}
.app-step-n{width:18px;height:18px;border-radius:50%;background:var(--pur-dim);color:var(--pur);font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.explain-text{font-size:13px;color:var(--muted);line-height:1.7;font-style:italic;padding:12px 16px;background:var(--card2);border-radius:var(--rsm);border-left:3px solid var(--pur-dim);grid-column:1/-1}
.mix-meta{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1;padding-top:4px}
.meta-chip{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:var(--card2);border:1px solid var(--bord);border-radius:20px;font-size:11px;color:var(--muted)}
.meta-icon{font-size:12px}
.mix-card-footer{padding:14px 24px;border-top:1px solid var(--bord);display:flex;align-items:center;justify-content:flex-end;gap:10px}

/* ════════════════════════════
   ADD MODAL
════════════════════════════ */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:1000;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease;padding:16px}
[data-theme="light"] .modal-overlay{background:rgba(0,0,0,.35)}
.modal{background:var(--surf);border:1px solid var(--bord2);border-radius:16px;width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;animation:fadeUp .3s ease;box-shadow:var(--shadow-md)}
.modal-head{padding:20px 24px;border-bottom:1px solid var(--bord);display:flex;align-items:center;justify-content:space-between}
.modal-title{font-family:'Cormorant Garamond',serif;font-size:20px;font-style:italic;color:var(--text)}
.modal-close{width:32px;height:32px;border-radius:8px;background:var(--card);color:var(--muted);font-size:18px;display:flex;align-items:center;justify-content:center}
.modal-close:hover{background:var(--card2);color:var(--text)}
.modal-body{padding:20px 24px;overflow-y:auto;flex:1}
.db-list{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow-y:auto}
.db-item{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--card);border:1px solid var(--bord);border-radius:var(--rsm);cursor:pointer}
.db-item:hover{border-color:var(--bord2);background:var(--card2)}
.db-item.in-lib{opacity:.4;pointer-events:none}
.db-item-info{flex:1}
.db-item-name{font-size:14px;font-weight:500;color:var(--text)}
.db-item-brand{font-size:11px;color:var(--muted)}
.db-add-icon{color:var(--gold);font-size:18px}

/* ════════════════════════════
   SAVED
════════════════════════════ */
.saved-list{display:flex;flex-direction:column;gap:16px}
.saved-card{background:var(--card);border:1px solid var(--bord);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow-sm)}
.saved-card-head{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;border-bottom:1px solid transparent;transition:background .2s}
.saved-card-head:hover{background:var(--card2)}
.saved-card.open .saved-card-head{border-bottom-color:var(--bord)}
.saved-card-name{
  font-family:'Cormorant Garamond',serif;font-size:19px;font-style:italic;
  background:linear-gradient(120deg,var(--gold) 0%,var(--gold2) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.saved-card-meta{display:flex;align-items:center;gap:10px;margin-top:3px;flex-wrap:wrap}
.saved-card-body{padding:16px 20px}
.expand-icon{color:var(--muted);font-size:12px;transition:transform .2s}
.saved-card.open .expand-icon{transform:rotate(180deg)}
.empty-saved{text-align:center;padding:80px 20px}

/* ════════════════════════════
   SCORE RING
════════════════════════════ */
.score-ring-wrap{display:flex;flex-direction:column;align-items:center;gap:4px}
.score-num{font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--gold);line-height:1}
.score-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}

/* ════════════════════════════
   MISC
════════════════════════════ */
.divider{height:1px;background:var(--bord);margin:20px 0}
.gender-badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-family:'DM Mono',monospace;margin-left:6px}
.lib-mini-list{display:flex;flex-direction:column;gap:8px;margin-top:12px;max-height:260px;overflow-y:auto}
.lib-mini-item{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--card2);border:1px solid var(--bord);border-radius:var(--rsm);cursor:pointer;transition:all .15s;position:relative}
.lib-mini-item:hover{border-color:var(--gold);background:rgba(201,168,76,.06)}
.lib-mini-item.checked{border-color:var(--gold);background:rgba(201,168,76,.1)}
[data-theme="light"] .lib-mini-item.checked{background:rgba(184,146,46,.08)}
.lib-mini-check{width:18px;height:18px;border-radius:4px;border:2px solid var(--bord2);display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;transition:all .15s}
.lib-mini-item.checked .lib-mini-check{background:var(--gold);border-color:var(--gold);color:#0b0a0f}
.error-box{background:rgba(224,96,96,.1);border:1px solid rgba(224,96,96,.3);border-radius:var(--rsm);padding:12px 16px;color:var(--err);font-size:13px;margin-bottom:16px}

/* ════════════════════════════
   SIGNATURE BLEND / TASTE / SUGGESTED
════════════════════════════ */
.sig-blend-card{
  background:linear-gradient(135deg,rgba(201,168,76,.12) 0%,rgba(155,124,212,.08) 60%,rgba(201,168,76,.06) 100%);
  border:1px solid var(--gold-dim);border-radius:var(--r);padding:24px 28px;
  margin-bottom:24px;position:relative;overflow:hidden;animation:glow 5s infinite;
}
[data-theme="light"] .sig-blend-card{background:linear-gradient(135deg,rgba(184,146,46,.08) 0%,rgba(123,92,180,.05) 60%,rgba(184,146,46,.04) 100%)}
.sig-blend-card::before{content:'';position:absolute;top:-40px;right:-40px;width:160px;height:160px;background:radial-gradient(circle,rgba(201,168,76,.1) 0%,transparent 70%);pointer-events:none}
.sig-blend-label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--gold);font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.sig-blend-label::before{content:'✦';font-size:8px}
.sig-blend-title{font-family:'Cormorant Garamond',serif;font-size:26px;font-style:italic;font-weight:500;color:var(--text);margin-bottom:4px}
.sig-blend-frags{display:flex;align-items:center;gap:6px;margin:12px 0;flex-wrap:wrap}
.sig-frag-pill{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:rgba(201,168,76,.12);border:1px solid var(--gold-dim);border-radius:20px;font-size:12px;font-weight:500;color:var(--gold2)}
[data-theme="light"] .sig-frag-pill{color:var(--gold)}
.sig-plus{color:var(--muted);font-size:14px;font-weight:300}
.sig-blend-why{font-size:13px;color:var(--muted);font-style:italic;line-height:1.6;padding:10px 14px;background:rgba(0,0,0,.1);border-radius:var(--rsm);border-left:2px solid var(--gold-dim);margin-top:12px}
[data-theme="light"] .sig-blend-why{background:rgba(0,0,0,.04)}
.sig-blend-footer{display:flex;align-items:center;justify-content:space-between;margin-top:16px;flex-wrap:wrap;gap:10px}
.sig-score-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;background:rgba(201,168,76,.15);border:1px solid var(--gold-dim);border-radius:20px;font-family:'DM Mono',monospace;font-size:11px;color:var(--gold)}
.taste-card{background:var(--card);border:1px solid var(--bord);border-radius:var(--r);padding:20px 24px;margin-bottom:24px;box-shadow:var(--shadow-sm)}
.taste-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.taste-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--pur);font-weight:600;display:flex;align-items:center;gap:6px}
.taste-profile-text{font-size:14px;color:var(--text);line-height:1.6;font-style:italic;margin-bottom:16px;font-family:'Cormorant Garamond',serif;font-size:16px}
.taste-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.taste-tag{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500}
.taste-tag-note{background:rgba(155,124,212,.12);color:var(--pur);border:1px solid rgba(155,124,212,.2)}
[data-theme="light"] .taste-tag-note{background:rgba(123,92,180,.1)}
.taste-tag-family{background:rgba(201,168,76,.1);color:var(--gold);border:1px solid rgba(201,168,76,.18)}
.family-bar-track{height:3px;background:var(--bord);border-radius:2px;overflow:hidden}
.family-bar-fill{height:100%;border-radius:2px;transition:width .8s ease}
.compat-preview{border-radius:var(--rsm);padding:12px 14px;margin:12px 0;display:flex;align-items:flex-start;gap:10px;transition:all .3s;animation:slideIn .35s ease}
.compat-preview.ok{background:rgba(94,200,138,.08);border:1px solid rgba(94,200,138,.25);animation:compatGlow 3s infinite}
.compat-preview.risky{background:rgba(224,160,96,.08);border:1px solid rgba(224,160,96,.25);animation:warnGlow 3s infinite}
.compat-preview.neutral{background:var(--card2);border:1px solid var(--bord)}
.compat-icon{font-size:16px;flex-shrink:0;margin-top:1px}
.compat-body{flex:1}
.compat-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.compat-label.ok{color:var(--ok)}
.compat-label.risky{color:#e0a060}
.compat-label.neutral{color:var(--muted)}
.compat-text{font-size:12px;color:var(--muted);line-height:1.4}
.compat-score-row{display:flex;align-items:center;gap:8px;margin-top:6px}
.compat-score-dots{display:flex;gap:3px}
.compat-dot{width:6px;height:6px;border-radius:50%;transition:background .3s}
.compat-dot.on{background:var(--gold)}
.compat-dot.off{background:var(--bord2)}
.compat-score-num{font-family:'DM Mono',monospace;font-size:11px;color:var(--gold)}
.role-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;font-family:'DM Mono',monospace;flex-shrink:0}
.role-base{background:rgba(201,168,76,.15);color:var(--gold)}
.role-heart{background:rgba(155,124,212,.15);color:var(--pur)}
.role-top{background:rgba(94,200,138,.15);color:var(--ok)}
.longevity-timeline{margin-top:8px}
.lon-track{height:6px;background:var(--bord);border-radius:3px;overflow:hidden;margin-bottom:4px}
.lon-fill{height:100%;border-radius:3px;transition:width 1s ease;background:linear-gradient(90deg,var(--gold-dim),var(--gold),var(--gold2))}
.lon-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--dim);font-family:'DM Mono',monospace}
.proj-indicator{display:flex;align-items:center;gap:6px;margin-top:8px}
.proj-bar{display:flex;gap:2px}
.proj-seg{width:10px;height:10px;border-radius:2px;transition:background .3s}
.proj-seg.on-soft{background:#5bb5d5}
.proj-seg.on-moderate{background:var(--pur)}
.proj-seg.on-strong{background:var(--gold)}
.proj-seg.off{background:var(--bord2)}
.proj-label{font-size:11px;color:var(--muted)}
.suggested-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.suggested-label{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:500}
.suggested-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(155,124,212,.12);border:1px solid rgba(155,124,212,.2);border-radius:10px;font-size:10px;color:var(--pur)}
.suggested-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:28px}
.suggested-card{background:var(--card2);border:1px solid var(--bord);border-radius:var(--r);padding:14px 16px;cursor:pointer;transition:all .2s}
.suggested-card:hover{border-color:var(--pur);transform:translateY(-2px);box-shadow:0 6px 24px rgba(155,124,212,.12)}
.suggested-card-names{font-size:13px;font-weight:500;color:var(--text);margin-bottom:4px}
.suggested-card-reason{font-size:11px;color:var(--muted);line-height:1.4;margin-bottom:8px}
.suggested-card-footer{display:flex;align-items:center;justify-content:space-between}
.suggested-score{font-family:'DM Mono',monospace;font-size:11px;color:var(--gold)}
.three-frag-tip{display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(201,168,76,.06);border:1px solid rgba(201,168,76,.15);border-radius:var(--rsm);font-size:11px;color:var(--muted);margin-top:6px}
.three-frag-tip strong{color:var(--gold)}

/* ════════════════════════════════════════════════
   RESPONSIVE — TABLET  (max 1024px)
════════════════════════════════════════════════ */
@media (max-width:1024px) {
  .mixer-layout{grid-template-columns:300px 1fr;gap:16px}
  .frag-grid{grid-template-columns:repeat(2,1fr);gap:12px}
  .stats-row{gap:12px}
  .page{padding:24px}
  .stat-n{font-size:32px}
  .page-title{font-size:26px}
  .suggested-grid{grid-template-columns:repeat(2,1fr)}
}

/* ════════════════════════════════════════════════
   RESPONSIVE — MOBILE  (max 768px)
════════════════════════════════════════════════ */
@media (max-width:768px) {
  /* Kill side overflow everywhere */
  body{overflow-x:hidden}

  /* ── Sidebar: hide on mobile ── */
  .sidebar{display:none !important}

  /* ── Mobile nav: show ── */
  .mobile-nav{display:flex}
  .mobile-topbar{display:flex}

  /* ── Page padding + bottom nav clearance ── */
  .page{padding:14px;padding-bottom:80px}
  .main{flex-direction:column}
  
  /* Snappier animations on mobile */
  .fu{animation-duration:.3s}
  .si{animation-duration:.25s}
  .sc{animation-duration:.25s}
  
  /* Tighter page header */
  .page-header{margin-bottom:20px}
  .page-title{font-size:28px}

  /* ── Layout ── */
  .mixer-layout{grid-template-columns:1fr}
  .frag-grid{grid-template-columns:1fr;gap:12px}
  .stats-row{grid-template-columns:1fr;gap:10px}
  .occ-grid{grid-template-columns:repeat(2,1fr)}

  /* ── Stat card: horizontal layout on mobile ── */
  .stat-card{display:flex;align-items:center;gap:16px;padding:16px 18px}
  .stat-n{font-size:30px}
  .stat-label{font-size:11px;margin-top:0}

  /* ── Page headers ── */
  .page-title{font-size:24px}
  .page-sub{font-size:13px}
  .page-header{margin-bottom:20px}

  /* ── CTA ── */
  .cta-mix{flex-direction:column;align-items:flex-start;padding:20px}
  .cta-title{font-size:18px}

  /* ── Cards ── */
  .card{padding:16px}
  .mix-card-header{padding:16px}
  .mix-card-body{padding:16px;grid-template-columns:1fr}
  .mix-card-body .mix-frags{grid-column:1}
  .mix-card-body .explain-text{grid-column:1}
  .mix-card-body .mix-meta{grid-column:1}
  .mix-card-footer{padding:12px 16px}

  /* ── Auth card ── */
  .auth-card{padding:32px 24px}
  .auth-logo{font-size:30px}

  /* ── Modal ── */
  .modal{max-width:100%;margin:0;border-radius:16px 16px 0 0;max-height:90vh;position:fixed;bottom:0;left:0;right:0}
  .modal-overlay{align-items:flex-end;padding:0}

  /* ── Sig blend card ── */
  .sig-blend-card{padding:18px}
  .sig-blend-title{font-size:20px}

  /* ── Taste card ── */
  .taste-card{padding:16px}

  /* ── Suggested grid ── */
  .suggested-grid{grid-template-columns:1fr}

  /* ── Frag card bars ── */
  .bars-row{gap:10px}

  /* ── Mix frags ── */
  .mix-frag-row{flex-wrap:wrap;gap:8px}

  /* ── Lib top ── */
  .lib-top{gap:8px}
  .lib-top .btn-gold{padding:10px 14px;font-size:13px}

  /* ── Buttons full width on small screens ── */
  .gen-btn{font-size:14px;padding:13px}

  /* ── Saved card meta wrap ── */
  .saved-card-head{flex-wrap:wrap;gap:8px}

  /* ── Score ring smaller ── */
  .score-ring-wrap svg{width:54px;height:54px}

  /* ── Empty states ── */
  .empty-lib{padding:48px 16px}
  .empty-saved{padding:48px 16px}
  .result-placeholder{height:280px}
}

/* ════════════════════════════════════════════════
   RESPONSIVE — SMALL MOBILE  (max 400px)
════════════════════════════════════════════════ */
@media (max-width:400px) {
  .auth-card{padding:28px 18px}
  .occ-grid{grid-template-columns:1fr}
  .mix-meta{gap:5px}
  .meta-chip{padding:4px 8px;font-size:10px}
  .page{padding:12px;padding-bottom:80px}
}
`;

/* ═══════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════ */
const fc = (id) => DB.find(f => f.id === id);
const familyColor = (fam) => FAMILY_COLORS[fam] || "#9090a0";
const genderColor = (g) => g==="M"?"#5bb5d5":g==="F"?"#e880a8":"#c8a0d8";

/* ── Compatibility Score ── */
function calculateCompatibility(fragsArr) {
  if (fragsArr.length < 2) return 0;
  let score = 60;
  const allNotes = fragsArr.flatMap(f => [...f.top, ...f.mid, ...f.base]).map(n => n.toLowerCase());
  const uniqueNotes = new Set(allNotes);
  const sharedRatio = 1 - (uniqueNotes.size / allNotes.length);
  score += sharedRatio * 20;
  const families = fragsArr.map(f => f.family);
  const familyKeywords = families.flatMap(f => f.split(" ").map(w => w.toLowerCase()));
  const uniqueKw = new Set(familyKeywords);
  const familyOverlap = 1 - (uniqueKw.size / familyKeywords.length);
  score += familyOverlap * 10;
  const lonAvg = fragsArr.reduce((a, f) => a + f.lon, 0) / fragsArr.length;
  score += (lonAvg / 10) * 8;
  const CLASHING_PAIRS = [
    ["aquatic","oriental spicy"],["fresh citrus","oriental gourmand"],
    ["woody synthetic","oriental floral"],
  ];
  let clashPenalty = 0;
  for (const [a, b] of CLASHING_PAIRS) {
    const hasA = families.some(f => f.toLowerCase().includes(a));
    const hasB = families.some(f => f.toLowerCase().includes(b));
    if (hasA && hasB) clashPenalty += 12;
  }
  score -= clashPenalty;
  return Math.min(98, Math.max(35, Math.round(score)));
}

function calculateCompatibilityPreview(fragsArr) {
  if (fragsArr.length < 2) return null;
  const score = calculateCompatibility(fragsArr);
  const allNotes = fragsArr.flatMap(f => [...f.top, ...f.mid, ...f.base]);
  const sharedNotes = allNotes.filter((n) => {
    const lower = n.toLowerCase();
    return fragsArr.filter(f =>
      [...f.top, ...f.mid, ...f.base].some(fn => fn.toLowerCase() === lower)
    ).length > 1;
  });
  const uniqueShared = [...new Set(sharedNotes)].slice(0, 3);
  let tier, icon, label, text;
  if (score >= 78) {
    tier = "ok"; icon = "✦"; label = "Great Pairing";
    text = uniqueShared.length
      ? `Shared notes like ${uniqueShared.join(", ")} create natural harmony.`
      : `These families blend cohesively — expect a smooth olfactory arc.`;
  } else if (score >= 58) {
    tier = "neutral"; icon = "◈"; label = "Interesting Combo";
    text = `Unconventional but wearable — the contrast creates tension and character.`;
  } else {
    tier = "risky"; icon = "⚠"; label = "Risky Combo";
    text = `Clashing note families. Bold choice — wear in small doses.`;
  }
  return { score, tier, icon, label, text };
}

function assignFragRoles(fragsArr) {
  return fragsArr.map(f => {
    const topNotes = f.top.map(n => n.toLowerCase());
    const baseNotes = f.base.map(n => n.toLowerCase());
    const isFresh = topNotes.some(n => FRESH_NOTES.map(x=>x.toLowerCase()).includes(n));
    const isBase = baseNotes.some(n => BASE_NOTE_KEYWORDS.some(k => n.includes(k.toLowerCase())));
    const highLon = f.lon >= 9;
    if (isFresh && !isBase) return { ...f, role: "top", ratio: 25 };
    if (highLon && isBase) return { ...f, role: "base", ratio: 40 };
    return { ...f, role: "heart", ratio: 35 };
  });
}

function assignRatios(fragsArr) {
  if (fragsArr.length === 2) {
    const lonA = fragsArr[0].lon, lonB = fragsArr[1].lon;
    const total = lonA + lonB;
    return [
      { ...fragsArr[0], ratio: Math.round((lonA / total) * 100) },
      { ...fragsArr[1], ratio: Math.round((lonB / total) * 100) },
    ];
  }
  const roles = assignFragRoles(fragsArr);
  const total = roles.reduce((a, r) => a + r.ratio, 0);
  return roles.map(r => ({ ...r, ratio: Math.round((r.ratio / total) * 100) }));
}

function analyzeUserTaste(libraryIds, savedMixes) {
  const frags = libraryIds.map(id => fc(id)).filter(Boolean);
  if (frags.length === 0) return null;
  const noteCount = {};
  const familyCount = {};
  frags.forEach(f => {
    f.family.split(" ").forEach(kw => { familyCount[kw] = (familyCount[kw] || 0) + 1; });
    [...f.top, ...f.mid, ...f.base].forEach(n => { noteCount[n] = (noteCount[n] || 0) + 1; });
  });
  savedMixes.forEach(m => {
    (m.fragrances || []).forEach(mf => {
      const f = DB.find(d => d.id === mf.id || d.name === mf.name);
      if (!f) return;
      [...f.top, ...f.mid, ...f.base].forEach(n => { noteCount[n] = (noteCount[n] || 0) + 2; });
      f.family.split(" ").forEach(kw => { familyCount[kw] = (familyCount[kw] || 0) + 2; });
    });
  });
  const favoriteNotes = Object.entries(noteCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n]) => n);
  const favoriteFamilies = Object.entries(familyCount).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f]) => f);
  const topFamilyEntry = Object.entries(familyCount).sort((a,b)=>b[1]-a[1])[0];
  const warmNotes = ["Vanilla","Amber","Patchouli","Tonka Bean","Sandalwood","Oud Wood","Labdanum"];
  const freshNoteList = ["Bergamot","Lemon","Marine","Mint","Grapefruit"];
  const floralNoteList = ["Jasmine","Rose","Iris","Orchid","Peony"];
  const warmScore = frags.filter(f => [...f.mid, ...f.base].some(n => warmNotes.includes(n))).length;
  const freshScore = frags.filter(f => f.top.some(n => freshNoteList.includes(n))).length;
  const floralScore = frags.filter(f => f.mid.some(n => floralNoteList.includes(n))).length;
  let profileWords = [];
  if (warmScore > frags.length / 2) profileWords.push("warm, enveloping");
  if (freshScore > frags.length / 2) profileWords.push("crisp, fresh");
  if (floralScore > frags.length / 2) profileWords.push("floral");
  if (topFamilyEntry) profileWords.push(topFamilyEntry[0].toLowerCase());
  const silAvg = frags.reduce((a, f) => a + f.sil, 0) / frags.length;
  const projDesc = silAvg >= 8 ? "bold projection" : silAvg >= 6 ? "moderate sillage" : "intimate wear";
  const profile = profileWords.length
    ? `You gravitate toward ${profileWords.join(", ")} fragrances with ${projDesc}.`
    : `Your collection is eclectic and adventurous.`;
  return { favoriteNotes, favoriteFamilies, profile, familyCount, lonAvg: frags.reduce((a, f) => a + f.lon, 0) / frags.length, silAvg };
}

function generateSmartMatches(libraryIdsOrFrags, count = 2) {
  const frags = libraryIdsOrFrags.map(item => typeof item === "string" ? fc(item) : item).filter(Boolean);
  if (frags.length < 2) return [];
  const pairs = [];
  for (let i = 0; i < frags.length; i++) {
    for (let j = i + 1; j < frags.length; j++) {
      const score = calculateCompatibility([frags[i], frags[j]]);
      const sharedNotes = [...frags[i].top, ...frags[i].mid, ...frags[i].base]
        .filter(n => [...frags[j].top, ...frags[j].mid, ...frags[j].base]
          .some(m => m.toLowerCase() === n.toLowerCase()));
      const reason = sharedNotes.length
        ? `Linked by ${sharedNotes.slice(0, 2).join(" and ")}`
        : `Complementary ${frags[i].family.split(" ")[0]} and ${frags[j].family.split(" ")[0]} families`;
      pairs.push({ fragrances: [frags[i], frags[j]], score, reason });
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, count);
}

function getProjectionLevel(sil) {
  if (sil <= 5) return "soft";
  if (sil <= 7) return "moderate";
  return "strong";
}

/* ═══════════════════════════════════════════════
   UI COMPONENTS
═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════
   SKELETON LOADERS
═══════════════════════════════════════════════ */
function SkeletonFragCard() {
  return (
    <div className="skeleton-card">
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div className="skeleton skeleton-avatar" style={{width:10,height:10,borderRadius:"50%",flexShrink:0}}/>
        <div style={{flex:1}}>
          <div className="skeleton skeleton-text" style={{width:"60%"}}/>
          <div className="skeleton skeleton-text" style={{width:"40%",height:10,marginBottom:0}}/>
        </div>
      </div>
      <div className="skeleton skeleton-badge" style={{marginBottom:12}}/>
      <div className="skeleton skeleton-text" style={{width:"100%"}}/>
      <div className="skeleton skeleton-text" style={{width:"80%"}}/>
      <div style={{display:"flex",gap:12,marginTop:10}}>
        <div style={{flex:1}}><div className="skeleton" style={{height:4,borderRadius:2}}/></div>
        <div style={{flex:1}}><div className="skeleton" style={{height:4,borderRadius:2}}/></div>
      </div>
    </div>
  );
}

function SkeletonMixCard() {
  return (
    <div className="skeleton-card" style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
        <div style={{flex:1}}>
          <div className="skeleton skeleton-title" style={{width:"55%"}}/>
          <div className="skeleton skeleton-text" style={{width:"75%"}}/>
        </div>
        <div className="skeleton skeleton-avatar" style={{width:68,height:68,borderRadius:"50%",flexShrink:0}}/>
      </div>
      {[1,2].map(i=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"var(--card2)",borderRadius:"var(--rsm)",marginBottom:8}}>
          <div className="skeleton" style={{width:8,height:8,borderRadius:"50%",flexShrink:0}}/>
          <div style={{flex:1}}><div className="skeleton skeleton-text" style={{width:"50%",marginBottom:4}}/><div className="skeleton skeleton-text" style={{width:"35%",height:10,marginBottom:0}}/></div>
          <div className="skeleton" style={{width:60,height:8,borderRadius:4}}/>
        </div>
      ))}
      <div className="skeleton skeleton-text" style={{width:"100%",marginTop:8}}/>
      <div className="skeleton skeleton-text" style={{width:"90%"}}/>
    </div>
  );
}

function SkeletonStatRow() {
  return (
    <div className="stats-row" style={{marginBottom:28}}>
      {[1,2,3].map(i=>(
        <div key={i} className="skeleton-card">
          <div className="skeleton" style={{width:60,height:40,borderRadius:6,marginBottom:8}}/>
          <div className="skeleton skeleton-text" style={{width:"70%",height:10}}/>
        </div>
      ))}
    </div>
  );
}

function ScoreRing({ score }) {
  const r = 26, circ = 2 * Math.PI * r, dash = circ - (circ * score / 100);
  const col = score >= 80 ? "var(--gold)" : score >= 60 ? "var(--pur)" : "var(--ok)";
  return (
    <div className="score-ring-wrap">
      <svg width="68" height="68" viewBox="0 0 68 68">
        <circle cx="34" cy="34" r={r} fill="none" stroke="var(--bord)" strokeWidth="4"/>
        <circle cx="34" cy="34" r={r} fill="none" stroke={col} strokeWidth="4"
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={dash}
          transform="rotate(-90 34 34)" style={{transition:"stroke-dashoffset 1s ease"}}/>
        <text x="34" y="38" textAnchor="middle" fill={col}
          fontFamily="Cormorant Garamond,serif" fontSize="14" fontWeight="500">{score}</text>
      </svg>
      <span className="score-lbl">Score</span>
    </div>
  );
}

function Bar({ value, max = 10, color }) {
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width:`${(value/max)*100}%`, background: color || "var(--gold)" }} />
    </div>
  );
}

function NoteTag({ label }) {
  return <span className="note-tag">{label}</span>;
}

function LongevityTimeline({ longevityStr }) {
  const hours = parseInt(longevityStr) || 8;
  const pct = Math.min(100, (hours / 12) * 100);
  return (
    <div className="longevity-timeline">
      <div className="lon-track"><div className="lon-fill" style={{ width: `${pct}%` }} /></div>
      <div className="lon-labels"><span>0h</span><span>3h</span><span>6h</span><span>9h</span><span>12h+</span></div>
    </div>
  );
}

function ProjectionIndicator({ projectionStr }) {
  const str = (projectionStr || "").toLowerCase();
  const level = str.includes("strong") || str.includes("heavy") ? "strong"
    : str.includes("soft") || str.includes("intimate") ? "soft" : "moderate";
  const segments = [
    { label: "Soft",     cls: "on-soft",     active: true },
    { label: "Moderate", cls: "on-moderate", active: level === "moderate" || level === "strong" },
    { label: "Strong",   cls: "on-strong",   active: level === "strong" },
  ];
  return (
    <div className="proj-indicator">
      <div className="proj-bar">
        {segments.map(s => <div key={s.label} className={`proj-seg ${s.active ? s.cls : "off"}`} title={s.label}/>)}
      </div>
      <span className="proj-label">{level.charAt(0).toUpperCase() + level.slice(1)} projection</span>
    </div>
  );
}

function CompatPreview({ fragsArr }) {
  const prev = useMemo(() => calculateCompatibilityPreview(fragsArr), [fragsArr.map(f=>f.id).join(",")]);
  if (!prev) return null;
  const dots = Array.from({ length: 10 }, (_, i) => i < Math.round(prev.score / 10));
  return (
    <div className={`compat-preview ${prev.tier}`}>
      <span className="compat-icon">{prev.icon}</span>
      <div className="compat-body">
        <div className={`compat-label ${prev.tier}`}>{prev.label}</div>
        <div className="compat-text">{prev.text}</div>
        <div className="compat-score-row">
          <div className="compat-score-dots">
            {dots.map((on, i) => <div key={i} className={`compat-dot ${on ? "on" : "off"}`}/>)}
          </div>
          <span className="compat-score-num">{prev.score}/100</span>
        </div>
      </div>
    </div>
  );
}

function TasteProfileCard({ taste }) {
  if (!taste) return null;
  const topFamilies = Object.entries(taste.familyCount || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const maxCount = topFamilies[0]?.[1] || 1;
  return (
    <div className="taste-card si">
      <div className="taste-header">
        <div className="taste-title">🧠 Your Scent Profile</div>
        <span className="meta-chip" style={{ fontSize: 10 }}>Personalized</span>
      </div>
      <div className="taste-profile-text">"{taste.profile}"</div>
      <div style={{ marginBottom: 12 }}>
        <div className="notes-label" style={{ marginBottom: 6 }}>Signature Notes</div>
        <div className="taste-tags">
          {taste.favoriteNotes.map(n => <span key={n} className="taste-tag taste-tag-note">{n}</span>)}
        </div>
      </div>
      <div>
        <div className="notes-label" style={{ marginBottom: 8 }}>Dominant Families</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {topFamilies.map(([fam, cnt]) => (
            <div key={fam} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: "var(--muted)", minWidth: 80 }}>{fam}</span>
              <div className="family-bar-track" style={{ flex: 1 }}>
                <div className="family-bar-fill" style={{ width: `${(cnt / maxCount) * 100}%`, background: "var(--pur)" }} />
              </div>
              <span style={{ fontSize: 10, fontFamily: "'DM Mono',monospace", color: "var(--dim)" }}>{cnt}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SignatureBlendCard({ libraryIds, onGoMixer }) {
  const matches = useMemo(() => generateSmartMatches(libraryIds, 1), [libraryIds.join(",")]);
  if (matches.length === 0) return null;
  const { fragrances, score, reason } = matches[0];
  const whyText = `${reason}. With an average longevity of ${((fragrances[0].lon + fragrances[1].lon) / 2).toFixed(1)}/10, this pairing rewards the occasion.`;
  return (
    <div className="sig-blend-card fu">
      <div className="sig-blend-label">✦ Your Signature Blend</div>
      <div className="sig-blend-title">
        {fragrances[0].name} <span style={{ color: "var(--muted)", fontStyle: "normal" }}>×</span> {fragrances[1].name}
      </div>
      <div className="sig-blend-frags">
        {fragrances.map((f, i) => (
          <>
            <span key={f.id} className="sig-frag-pill">
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: familyColor(f.family), display: "inline-block" }} />
              {f.name}
            </span>
            {i < fragrances.length - 1 && <span key={`plus-${i}`} className="sig-plus">+</span>}
          </>
        ))}
      </div>
      <div className="sig-blend-why">💡 Why this works for you: {whyText}</div>
      <div className="sig-blend-footer">
        <span className="sig-score-badge">⬡ Compatibility {score}/100</span>
        <button className="btn btn-gold btn-sm" onClick={onGoMixer}>Mix it now →</button>
      </div>
    </div>
  );
}

function SuggestedMixesStrip({ libraryIds, onGoMixer }) {
  const suggestions = useMemo(() => generateSmartMatches(libraryIds, 4), [libraryIds.join(",")]);
  if (suggestions.length < 2) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="suggested-header">
        <span className="suggested-label">Recommended for you</span>
        <span className="suggested-badge">✦ AI Matched</span>
      </div>
      <div className="suggested-grid">
        {suggestions.map(({ fragrances, score, reason }, i) => (
          <div key={i} className="suggested-card" onClick={() => onGoMixer(fragrances.map(f=>f.id))}>
            <div className="suggested-card-names">{fragrances.map(f => f.name).join(" + ")}</div>
            <div className="suggested-card-reason">{reason}</div>
            <div className="suggested-card-footer">
              <div style={{ display: "flex", gap: 4 }}>
                {fragrances.map(f => <span key={f.id} className="note-tag" style={{ fontSize: 9 }}>{f.family.split(" ")[0]}</span>)}
              </div>
              <span className="suggested-score">⬡ {score}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   THEME SWITCH — pill toggle
═══════════════════════════════════════════════ */
function ThemeToggle({ theme, onToggle, className = "" }) {
  const isLight = theme === "light";
  return (
    <div
      className={`theme-switch ${className}`}
      onClick={onToggle}
      role="switch"
      aria-checked={isLight}
      aria-label="Toggle light/dark mode"
      title={`Switch to ${isLight ? "dark" : "light"} mode`}
    >
      <div className={`theme-switch-track ${isLight ? "on" : ""}`}>
        <div className="theme-switch-thumb">
          {isLight ? "☀️" : "🌙"}
        </div>
      </div>
      <span className="theme-switch-label">
        {isLight ? "Light" : "Dark"}
      </span>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   USER MENU — avatar + dropdown
═══════════════════════════════════════════════ */
function UserMenu({ user, onLogout, dropDirection = "up" }) {
  const [open,    setOpen]   = useState(false);
  const [photo,   setPhoto]  = useState(() => {
    try { return localStorage.getItem(`afl:${user?.id}:photo`) || null; } catch { return null; }
  });
  const fileRef = useRef(null);
  const menuRef = useRef(null);

  /* Close on outside click */
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      setPhoto(dataUrl);
      try { localStorage.setItem(`afl:${user?.id}:photo`, dataUrl); } catch {}
    };
    reader.readAsDataURL(file);
    setOpen(false);
  };

  const initials = (user?.name || user?.email || "?").slice(0, 2).toUpperCase();

  return (
    <div className="user-menu" ref={menuRef}>
      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handlePhotoChange}
      />

      {/* Avatar trigger */}
      <div
        className="user-menu-avatar"
        onClick={() => setOpen(o => !o)}
        title="Account menu"
      >
        {photo
          ? <img src={photo} alt="avatar" />
          : initials
        }
      </div>

      {/* Dropdown */}
      {open && (
        <div className={`user-menu-dropdown ${dropDirection === "down" ? "down" : ""}`}>
          {/* Header */}
          <div className="user-menu-header">
            <div className="user-menu-name">{user?.name || "User"}</div>
            <div className="user-menu-email">{user?.email}</div>
          </div>

          {/* Change photo */}
          <button
            className="user-menu-item"
            onClick={() => { fileRef.current?.click(); }}
          >
            <span className="user-menu-item-icon">🖼</span>
            {photo ? "Change Photo" : "Add Photo"}
          </button>

          {photo && (
            <button
              className="user-menu-item"
              onClick={() => {
                setPhoto(null);
                try { localStorage.removeItem(`afl:${user?.id}:photo`); } catch {}
                setOpen(false);
              }}
            >
              <span className="user-menu-item-icon">✕</span>
              Remove Photo
            </button>
          )}

          <div className="user-menu-divider"/>

          {/* Logout */}
          <button
            className="user-menu-item danger"
            onClick={() => { setOpen(false); onLogout(); }}
          >
            <span className="user-menu-item-icon">⎋</span>
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   AUTH PAGE  — wired to Supabase Auth
═══════════════════════════════════════════════ */
function AuthPage({ theme, onToggleTheme }) {
  const [tab,      setTab]      = useState("login");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [name,     setName]     = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [info,     setInfo]     = useState("");   // e.g. "Check your email"

  /* Clear messages whenever the user switches tabs */
  const switchTab = (t) => { setTab(t); setError(""); setInfo(""); };

  const handleSubmit = async () => {
    setError(""); setInfo("");
    if (!email || !password) { setError("Please fill in all fields."); return; }
    if (tab === "signup" && !name) { setError("Please enter your name."); return; }
    if (password.length < 6)       { setError("Password must be at least 6 characters."); return; }

    setLoading(true);
    try {
      if (tab === "signup") {
        const { session, error: err } = await signUp(email, password, name);
        if (err) { setError(err.message); return; }
        /* If email confirmation is ON, session will be null */
        if (!session) {
          setInfo("Almost there! Check your inbox and click the confirmation link, then sign in.");
          switchTab("login");
        }
        /* If email confirmation is OFF, onAuthStateChange fires → App handles redirect */
      } else {
        const { error: err } = await signIn(email, password);
        if (err) {
          setError(
            err.message.toLowerCase().includes("invalid")
              ? "Incorrect email or password. Please try again."
              : err.message
          );
        }
        /* On success, onAuthStateChange fires in App — no manual navigation needed */
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-bg">
      {/* Theme toggle top-right */}
      <div style={{ position:"fixed", top:16, right:16, zIndex:999 }}>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>

      <div className="auth-card">
        <div className="auth-logo">AFL</div>
        <div className="auth-tagline">✦ Intelligent Fragrance Layering ✦</div>

        <div className="auth-tab">
          <button className={tab==="login"  ?"active":""} onClick={()=>switchTab("login")}>Sign In</button>
          <button className={tab==="signup" ?"active":""} onClick={()=>switchTab("signup")}>Create Account</button>
        </div>

        {/* Info banner (e.g. "check your email") */}
        {info && (
          <div style={{
            background:"rgba(94,200,138,.1)",border:"1px solid rgba(94,200,138,.3)",
            borderRadius:"var(--rsm)",padding:"10px 14px",color:"var(--ok)",
            fontSize:13,marginBottom:14,lineHeight:1.5,
          }}>✦ {info}</div>
        )}

        {/* Error banner */}
        {error && (
          <div className="error-box" style={{marginBottom:14}}>⚠ {error}</div>
        )}

        {tab === "signup" && (
          <div className="form-row">
            <label className="form-label">Your Name</label>
            <input
              placeholder="e.g. Alex Noir"
              value={name}
              onChange={e=>{ setName(e.target.value); setError(""); }}
              disabled={loading}
            />
          </div>
        )}

        <div className="form-row">
          <label className="form-label">Email</label>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={e=>{ setEmail(e.target.value); setError(""); }}
            disabled={loading}
          />
        </div>

        <div className="form-row">
          <label className="form-label">Password</label>
          <input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={e=>{ setPassword(e.target.value); setError(""); }}
            onKeyDown={e=>e.key==="Enter" && !loading && handleSubmit()}
            disabled={loading}
          />
          {tab === "signup" && (
            <div style={{fontSize:11,color:"var(--dim)",marginTop:4}}>Minimum 6 characters</div>
          )}
        </div>

        <button
          className="btn btn-gold"
          style={{width:"100%",marginTop:8,opacity:loading?0.7:1,gap:10}}
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading
            ? <><span style={{width:14,height:14,border:"2px solid rgba(255,255,255,.4)",borderTopColor:"#fff",borderRadius:"50%",display:"inline-block",animation:"spin .7s linear infinite"}}/>
                {tab==="login" ? "Signing in…" : "Creating account…"}
              </>
            : tab==="login" ? "Enter the Lab →" : "Create Account →"
          }
        </button>

        <div className="auth-divider">or</div>

        <button
          className="guest-btn"
          onClick={async () => {
            setError(""); setLoading(true);
            const { error: err } = await signIn("guest@afl-demo.io", "guest123456");
            if (err) setError("Guest account unavailable. Please create a free account.");
            setLoading(false);
          }}
          disabled={loading}
        >
          🧪 Explore as Guest
        </button>

        <div style={{fontSize:11,color:"var(--dim)",textAlign:"center",marginTop:14,lineHeight:1.6}}>
          Your data is private and encrypted.{" "}
          <span style={{color:"var(--muted)"}}>Each account has its own library.</span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SIDEBAR  (desktop — with theme toggle)
═══════════════════════════════════════════════ */
const NAV = [
  { id:"dashboard", icon:"⬡",  label:"Dashboard" },
  { id:"library",   icon:"◈",  label:"My Library" },
  { id:"mixer",     icon:"⚗",  label:"Mix Generator" },
  { id:"saved",     icon:"♦",  label:"Saved Mixes" },
];

function Sidebar({ page, setPage, user, libCount, savedCount, theme, onToggleTheme, onLogout, syncStatus }) {
  const syncInfo = {
    saving: { icon:"↑", label:"Saving…",   color:"var(--gold)"  },
    saved:  { icon:"✦", label:"Synced",    color:"var(--ok)"    },
    local:  { icon:"◈", label:"Local only",color:"var(--muted)" },
    idle:   null,
  }[syncStatus] ?? null;

  return (
    <div className="sidebar">
      <div className="sidebar-logo">✦</div>
      {NAV.map(n => (
        <button key={n.id} className={`nav-btn ${page===n.id?"active":""}`} onClick={()=>setPage(n.id)}>
          <span>{n.icon}</span>
          <span className="tip">{n.label}</span>
          {n.id==="library" && libCount>0 && <span className="nav-badge">{libCount}</span>}
          {n.id==="saved"   && savedCount>0 && <span className="nav-badge">{savedCount}</span>}
        </button>
      ))}
      <div className="sidebar-spacer"/>

      {/* Sync status badge */}
      {syncInfo && (
        <div title={syncInfo.label} style={{
          display:"flex",alignItems:"center",justifyContent:"center",
          marginBottom:6,width:36,height:20,borderRadius:10,
          background:"var(--card2)",border:"1px solid var(--bord)",
          fontSize:9,color:syncInfo.color,gap:3,letterSpacing:.3,
          fontFamily:"'DM Mono',monospace",fontWeight:600,
          animation: syncStatus==="saving" ? "pulse 1s infinite" : "none",
        }}>
          <span style={{fontSize:8}}>{syncInfo.icon}</span>
          <span className="tip">{syncInfo.label}</span>
        </div>
      )}

      {/* Theme pill switch */}
      <ThemeToggle theme={theme} onToggle={onToggleTheme} className="theme-switch-sidebar" />
      {/* Avatar with dropdown menu (logout lives here) */}
      <UserMenu user={user} onLogout={onLogout} dropDirection="up" />
      <div style={{height:12}}/>
    </div>
  );
}

/* Mobile Nav Bar */
function MobileNav({ page, setPage, libCount, savedCount }) {
  return (
    <nav className="mobile-nav">
      {NAV.map(n => (
        <button key={n.id} className={`mob-nav-btn ${page===n.id?"active":""}`} onClick={()=>setPage(n.id)}>
          <span>{n.icon}</span>
          <span className="mob-nav-label">{n.label.split(" ")[0]}</span>
          {n.id==="library" && libCount>0 && <span className="mob-badge">{libCount}</span>}
          {n.id==="saved"   && savedCount>0 && <span className="mob-badge">{savedCount}</span>}
        </button>
      ))}
    </nav>
  );
}

/* ═══════════════════════════════════════════════
   FRAGRANCE CARD
═══════════════════════════════════════════════ */
function FragCard({ frag, selected, onToggle, onRemove }) {
  const col = familyColor(frag.family);
  return (
    <div className={`frag-card ${selected?"selected":""}`} onClick={()=>onToggle && onToggle(frag.id)}>
      <div className="frag-sel-check">✓</div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <div className="frag-family-dot" style={{background:col}}/>
        <div style={{flex:1}}>
          <div className="frag-name">{frag.name}</div>
          <div className="frag-brand">{frag.brand}</div>
        </div>
        {onRemove && (
          <button className="btn btn-ghost btn-sm" style={{padding:"4px 8px",fontSize:11}}
            onClick={e=>{e.stopPropagation();onRemove(frag.id)}}>✕</button>
        )}
      </div>
      <span className="frag-badge" style={{background:`${col}1a`,color:col}}>{frag.family}</span>
      <span className="gender-badge" style={{background:genderColor(frag.gen)+"22",color:genderColor(frag.gen)}}>
        {frag.gen==="M"?"Masculine":frag.gen==="F"?"Feminine":"Unisex"}
      </span>
      <div className="notes-section">
        <div className="notes-label">Top · Mid · Base</div>
        <div className="notes-wrap">
          {[...frag.top.slice(0,2), ...frag.mid.slice(0,1), ...frag.base.slice(0,1)].map((n,i)=>(
            <NoteTag key={i} label={n}/>
          ))}
        </div>
      </div>
      <div className="bars-row">
        <div className="bar-item">
          <div className="bar-label-row">
            <span className="bar-label">Longevity</span>
            <span className="bar-val">{frag.lon}/10</span>
          </div>
          <Bar value={frag.lon} color="var(--gold)"/>
        </div>
        <div className="bar-item">
          <div className="bar-label-row">
            <span className="bar-label">Sillage</span>
            <span className="bar-val">{frag.sil}/10</span>
          </div>
          <Bar value={frag.sil} color="var(--pur)"/>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   ADD MODAL
═══════════════════════════════════════════════ */
function AddModal({ library, onAdd, onClose }) {
  const [search, setSearch] = useState("");
  const libIds = new Set(library);
  const filtered = DB.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    f.brand.toLowerCase().includes(search.toLowerCase()) ||
    f.family.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Add to Your Library</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{marginBottom:14}}>
            <input placeholder="Search fragrances, brands, families…" value={search} onChange={e=>setSearch(e.target.value)} autoFocus/>
          </div>
          <div className="db-list">
            {filtered.map(f => {
              const inLib = libIds.has(f.id);
              const col = familyColor(f.family);
              return (
                <div key={f.id} className={`db-item ${inLib?"in-lib":""}`} onClick={()=>!inLib && onAdd(f.id)}>
                  <div className="frag-family-dot" style={{background:col,width:8,height:8}}/>
                  <div className="db-item-info">
                    <div className="db-item-name">{f.name}</div>
                    <div className="db-item-brand" style={{display:"flex",gap:8,alignItems:"center"}}>
                      {f.brand}
                      <span className="note-tag" style={{fontSize:9}}>{f.family}</span>
                    </div>
                  </div>
                  <span className="db-add-icon">{inLib?"✓":"+"}</span>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{textAlign:"center",padding:"24px",color:"var(--muted)"}}>No results found</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   MIX RESULT CARD
═══════════════════════════════════════════════ */
function MixResultCard({ combo, index, onSave, alreadySaved }) {
  const phaseColors = ["var(--gold)","var(--pur)","#5b8cc8"];
  const getRoleBadge = (frag) => {
    const f = DB.find(d => d.id === frag.id || d.name === frag.name);
    if (!f) return null;
    const assigned = assignFragRoles([f])[0];
    const roleMap = {
      base:  { cls: "role-base",  label: "Base Layer" },
      heart: { cls: "role-heart", label: "Heart Layer" },
      top:   { cls: "role-top",   label: "Top Layer" },
    };
    return roleMap[assigned.role] || null;
  };
  return (
    <div className="mix-card fu" style={{animationDelay:`${index*0.1}s`}}>
      <div className="mix-card-header">
        <div>
          <div className="mix-card-name">"{combo.name}"</div>
          <div className="mix-card-tagline">{combo.tagline}</div>
        </div>
        <ScoreRing score={combo.score}/>
      </div>
      <div className="mix-card-body">
        <div className="mix-frags">
          <div className="section-head">Blend Composition</div>
          {combo.fragrances.map((fr, i) => {
            const roleBadge = getRoleBadge(fr);
            return (
              <div key={i} className="mix-frag-row">
                <div className="frag-family-dot" style={{background:familyColor(fc(fr.id)?.family||""),width:8,height:8}}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,fontWeight:500,color:"var(--text)"}}>{fr.name}</span>
                    {roleBadge && <span className={`role-badge ${roleBadge.cls}`}>{roleBadge.label}</span>}
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>{fr.brand} · {fr.application}</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,minWidth:100}}>
                  <div className="mix-ratio-bar"><div className="mix-ratio-fill" style={{width:`${fr.ratio}%`}}/></div>
                  <span className="mix-ratio-num">{fr.ratio}%</span>
                </div>
              </div>
            );
          })}
        </div>
        <div>
          <div className="section-head">Scent Journey</div>
          <div className="profile-phases">
            {[["Opening (0-30m)", combo.scentProfile?.opening, 0],
              ["Heart (30m-3h)",  combo.scentProfile?.heart,   1],
              ["Drydown (3h+)",   combo.scentProfile?.drydown, 2]].map(([lbl,text,ci])=>(
              <div key={lbl} className="phase" style={{borderLeftColor:phaseColors[ci]}}>
                <div className="phase-label">{lbl}</div>
                <div className="phase-text">{text}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="section-head">Application Order</div>
          <div className="app-order">
            {(combo.applicationOrder||[]).map((step, i) => (
              <div key={i} className="app-step">
                <div className="app-step-n">{i+1}</div>
                <span>{step}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="section-head">Performance</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 3 }}>Longevity</div>
                <LongevityTimeline longevityStr={combo.longevity} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 3 }}>Projection</div>
                <ProjectionIndicator projectionStr={combo.projection} />
              </div>
            </div>
          </div>
        </div>
        <div className="explain-text">💡 {combo.explanation}</div>
        <div className="mix-meta">
          <span className="meta-chip"><span className="meta-icon">⏱</span>{combo.longevity}</span>
          <span className="meta-chip"><span className="meta-icon">💨</span>{combo.projection}</span>
          {(combo.season||[]).map(s=><span key={s} className="meta-chip"><span className="meta-icon">🌿</span>{s}</span>)}
          {(combo.mood||[]).map(m=><span key={m} className="meta-chip"><span className="meta-icon">✦</span>{m}</span>)}
        </div>
      </div>
      <div className="mix-card-footer">
        {alreadySaved
          ? <span style={{fontSize:12,color:"var(--ok)"}}>✓ Saved to collection</span>
          : <button className="btn btn-gold btn-sm" onClick={()=>onSave(combo)}>Save Mix ♦</button>
        }
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   DASHBOARD PAGE
═══════════════════════════════════════════════ */
function DashboardPage({ user, library, savedMixes, setPage, onPreloadMixer, dataLoading }) {
  const taste = useMemo(() => analyzeUserTaste(library, savedMixes), [library.join(","), savedMixes.length]);
  const avgLon = library.length
    ? (library.map(id=>fc(id)).filter(Boolean).reduce((a,f)=>a+f.lon,0)/library.length).toFixed(1)
    : "—";
  return (
    <div className="page fu">
      <div className="page-header">
        <div className="page-title">Welcome back, {user?.name} 👋</div>
        <div className="page-sub">Your personal AI-powered fragrance laboratory</div>
      </div>
      {dataLoading ? <SkeletonStatRow/> : (
      <div className="stats-row">
        {[
          ["Library", library.length, "fragrances collected"],
          ["Mixes", savedMixes.length, "combinations saved"],
          ["Avg Longevity", avgLon, "hours on skin"],
        ].map(([lbl, val, sub]) => (
          <div key={lbl} className="stat-card sc" style={{animationDelay:`${["Library","Mixes","Avg Longevity"].indexOf(lbl)*0.07}s`,opacity:0}}>
            <div className="stat-n">{val}</div>
            <div>
              <div className="stat-label">{lbl}</div>
              <div style={{fontSize:11,color:"var(--dim)",marginTop:2}}>{sub}</div>
            </div>
          </div>
        ))}
      </div>
      )}
      {/* ── Build Library CTA — shown first when library is empty ── */}
      {library.length === 0 && (
        <div className="card sc" style={{
          textAlign:"center",padding:"36px 28px",marginBottom:20,
          background:"linear-gradient(135deg,rgba(201,168,76,.08) 0%,rgba(155,124,212,.06) 100%)",
          border:"1px solid var(--gold-dim)",
        }}>
          <div style={{fontSize:36,marginBottom:14,animation:"float 3s ease-in-out infinite"}}>◈</div>
          <div style={{fontFamily:"Cormorant Garamond,serif",fontSize:22,fontStyle:"italic",
            background:"linear-gradient(120deg,var(--gold),var(--gold2))",
            WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
            marginBottom:8}}>
            Start by building your library
          </div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:20,maxWidth:300,margin:"0 auto 20px"}}>
            Add the fragrances you own and the AI will craft perfect combinations for you
          </div>
          <button className="btn btn-gold" style={{padding:"12px 28px",fontSize:15}} onClick={()=>setPage("library")}>
            Build My Library →
          </button>
        </div>
      )}

      {/* ── Signature blend + taste — only when library has items ── */}
      {library.length >= 2 && <SignatureBlendCard libraryIds={library} onGoMixer={() => setPage("mixer")} />}
      {taste && library.length >= 2 && <TasteProfileCard taste={taste} />}
      {library.length >= 2 && (
        <SuggestedMixesStrip libraryIds={library} onGoMixer={(ids) => { onPreloadMixer(ids); setPage("mixer"); }} />
      )}

      {/* ── Mix CTA ── */}
      <div className="cta-mix" onClick={()=>setPage("mixer")}>
        <div>
          <div className="cta-title">⚗ Generate a New Mix</div>
          <div className="cta-desc">Let AI recommend the perfect fragrance combination for your occasion</div>
        </div>
        <button className="btn btn-gold">Start Mixing →</button>
      </div>

      {/* ── Recent mixes ── */}
      {savedMixes.length > 0 && (
        <div>
          <div style={{fontSize:13,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".6px",fontWeight:500,marginBottom:14}}>Recent Mixes</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {savedMixes.slice(0,3).map((m,i)=>(
              <div key={i} className="card" style={{display:"flex",alignItems:"center",gap:14,cursor:"pointer",padding:"14px 18px"}}
                onClick={()=>setPage("saved")}>
                <div style={{fontSize:22}}>♦</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:"Cormorant Garamond,serif",fontSize:16,fontStyle:"italic",color:"var(--gold)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{m.name}</div>
                  <div style={{fontSize:11,color:"var(--muted)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                    {m.fragrances.map(f=>f.name).join(" + ")} · Score: {m.score}
                  </div>
                </div>
                <span className="meta-chip" style={{flexShrink:0}}>{m.occasion}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   LIBRARY PAGE
═══════════════════════════════════════════════ */
function LibraryPage({ library, setLibrary, dataLoading }) {
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const fragrances = library.map(id=>fc(id)).filter(Boolean);
  const filtered = fragrances.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    f.brand.toLowerCase().includes(search.toLowerCase())
  );
  const addFrag = (id) => { if (!library.includes(id)) setLibrary(prev=>[...prev,id]); setShowAdd(false); };
  const removeFrag = (id) => setLibrary(prev=>prev.filter(x=>x!==id));
  return (
    <div className="page fu">
      <div className="page-header">
        <div className="page-title">My Fragrance Library</div>
        <div className="page-sub">{library.length} fragrances in your collection</div>
      </div>
      <div className="lib-top">
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input placeholder="Search your collection…" value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
        <button className="btn btn-gold" onClick={()=>setShowAdd(true)}>+ Add Fragrance</button>
      </div>
      {dataLoading ? (
        <div className="frag-grid">{[1,2,3,4].map(i=><SkeletonFragCard key={i}/>)}</div>
      ) : filtered.length === 0 && library.length === 0 ? (
        <div className="empty-lib">
          <span className="empty-icon">⬡</span>
          <div className="empty-title">Your collection awaits</div>
          <div style={{fontSize:13,marginBottom:24}}>Add perfumes from our curated database of 25 fragrances</div>
          <button className="btn btn-gold" onClick={()=>setShowAdd(true)}>+ Add Your First Fragrance</button>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{textAlign:"center",padding:"40px",color:"var(--muted)"}}>No fragrances match your search</div>
      ) : (
        <div className="frag-grid">{filtered.map(f=><FragCard key={f.id} frag={f} onRemove={removeFrag}/>)}</div>
      )}
      {showAdd && <AddModal library={library} onAdd={addFrag} onClose={()=>setShowAdd(false)}/>}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   OCCASION PROFILE MAP
═══════════════════════════════════════════════ */
const OCCASION_PROFILES = {
  daily: {
    families:["Fresh Spicy","Aromatic Woody","Fresh Citrus","Fresh Woody","Aquatic Fresh","Fresh Floral","Woody Citrus","Floral Woody"],
    noteKeywords:["Bergamot","Lemon","Grapefruit","Cedar","Vetiver","Lavender","Sage"],
    mood:["Versatile","Clean","Effortless"],season:["Spring","Summer","Fall"],
    projectionTarget:"moderate",
    names:["Morning Ritual","Quiet Clarity","Everyday Silk","Urban Current","Open Air"],
    taglines:["A signature that moves with you through the day.","Effortless freshness that never overstays its welcome.","Clean confidence from first light to last hour."],
  },
  date: {
    families:["Oriental Floral","Oriental Spicy","Floral Oriental","Oriental","Oriental Gourmand","Floral Woody Musk","Fruity Chypre"],
    noteKeywords:["Vanilla","Amber","Patchouli","Jasmine","Rose","Tonka Bean","Oud","Saffron","Sandalwood"],
    mood:["Romantic","Sensual","Mysterious"],season:["Fall","Winter","Spring"],
    projectionTarget:"strong",
    names:["Velvet Dusk","Midnight Accord","Séduction Noire","Golden Hour","Dangerous Liaison"],
    taglines:["An olfactory invitation that lingers long after you've left the room.","Warmth and mystery woven into a single breath.","Sensuality distilled — magnetic, unforgettable."],
  },
  formal: {
    families:["Aromatic Woody","Woody Oriental","Floral Aldehyde","Floral Woody","Woody Citrus","Floral Woody Musk"],
    noteKeywords:["Cedar","Sandalwood","Vetiver","Incense","Iris","Rose","Leather","Pepper","Nutmeg"],
    mood:["Confident","Sophisticated","Authoritative"],season:["Fall","Winter"],
    projectionTarget:"moderate",
    names:["The Counsel","Grand Presence","Boardroom Noir","Quiet Authority","The Signature"],
    taglines:["Refined power that speaks before you do.","The invisible accessory every formal occasion demands.","Gravitas, bottled."],
  },
  gym: {
    families:["Aquatic Fresh","Fresh Citrus","Fresh Spicy","Fresh Floral","Fresh Woody"],
    noteKeywords:["Marine","Mint","Lemon","Grapefruit","Bergamot","Apple","Sage","Rosemary"],
    mood:["Energizing","Clean","Focused"],season:["Spring","Summer"],
    projectionTarget:"soft",
    names:["Clean Velocity","Morning Sprint","Clear Signal","Pure Motion","Oxygen Rush"],
    taglines:["Light, clean, and built for movement.","Freshness that keeps pace with you.","Energy in every molecule."],
  },
};

function filterFragsByOccasion(frags, occasionId) {
  const profile = OCCASION_PROFILES[occasionId];
  if (!profile || frags.length === 0) return frags;
  const scored = frags.map(f => {
    let affinity = 0;
    if (profile.families.some(fam => f.family.toLowerCase().includes(fam.toLowerCase()) || fam.toLowerCase().includes(f.family.toLowerCase()))) affinity += 3;
    const profileFamilyWords = profile.families.flatMap(fam => fam.toLowerCase().split(" "));
    const fragFamilyWords = f.family.toLowerCase().split(" ");
    affinity += fragFamilyWords.filter(w => profileFamilyWords.includes(w)).length;
    const allNotes = [...f.top, ...f.mid, ...f.base].map(n => n.toLowerCase());
    affinity += profile.noteKeywords.filter(kw => allNotes.some(n => n.includes(kw.toLowerCase()))).length * 2;
    if (occasionId === "date" || occasionId === "formal") affinity += (f.lon - 7) * 0.5;
    if (occasionId === "gym") affinity -= f.sil > 8 ? 2 : 0;
    return { ...f, affinity };
  });
  scored.sort((a, b) => b.affinity - a.affinity);
  const cutoff = Math.max(2, Math.min(8, Math.ceil(scored.length * 0.6)));
  const pool = scored.slice(0, cutoff);
  return pool.length >= 2 ? pool : frags;
}

function buildLocalCombos(pairs, occasionId) {
  const profile = OCCASION_PROFILES[occasionId] || OCCASION_PROFILES.daily;
  return pairs.map((pair, pairIndex) => {
    const { fragrances, score, reason } = pair;
    const withRoles = assignRatios(fragrances);
    const appSpots = ["inner wrists","base of neck","chest","behind ears","hair ends"];
    const applicationOrder = withRoles.map((f, i) => {
      const spot = appSpots[i % appSpots.length];
      const isBase = f.role === "base" || (i === 0 && !f.role);
      return isBase
        ? `Apply ${f.name} on ${spot} — its deep base anchors the blend for hours`
        : `After 60–90 seconds, mist ${f.name} on ${appSpots[(i + 1) % appSpots.length]} to layer the ${f.role || "heart"} notes`;
    });
    const allTop  = [...new Set(fragrances.flatMap(f => f.top))].slice(0, 3).join(", ");
    const allMid  = [...new Set(fragrances.flatMap(f => f.mid))].slice(0, 3).join(", ");
    const allBase = [...new Set(fragrances.flatMap(f => f.base))].slice(0, 3).join(", ");
    const scentProfile = {
      opening: `${allTop} burst forward — bright, immediate, and arresting. The opening announces intent.`,
      heart:   `${allMid} emerge as the top notes settle, creating the emotional core of the blend. The character becomes clear.`,
      drydown: `${allBase} take hold and fuse into a singular skin-close signature that endures.`,
    };
    const avgLon = Math.round(fragrances.reduce((a, f) => a + f.lon, 0) / fragrances.length);
    const avgSil = Math.round(fragrances.reduce((a, f) => a + f.sil, 0) / fragrances.length);
    const longevityStr = avgLon >= 9 ? "8–12 hours" : avgLon >= 7 ? "6–8 hours" : "4–6 hours";
    const projLevel = avgSil >= 9 ? "Strong" : avgSil >= 7 ? "Moderate" : "Soft";
    const name = profile.names[pairIndex % profile.names.length];
    const tagline = profile.taglines[pairIndex % profile.taglines.length];
    const sharedNotes = fragrances[0]
      ? [...fragrances[0].top, ...fragrances[0].mid, ...fragrances[0].base]
          .filter(n => fragrances[1] && [...fragrances[1].top, ...fragrances[1].mid, ...fragrances[1].base]
            .some(m => m.toLowerCase() === n.toLowerCase()))
      : [];
    const chemistry = sharedNotes.length
      ? `Shared accord of ${sharedNotes.slice(0, 2).join(" and ")} creates olfactory cohesion between the two fragrances.`
      : `The ${fragrances.map(f => f.family.split(" ")[0]).join(" and ")} families complement each other through harmonic contrast.`;
    return {
      name, tagline,
      fragrances: withRoles.map(f => ({ id: f.id, name: f.name, brand: f.brand, ratio: f.ratio, application: appSpots[withRoles.indexOf(f) % appSpots.length] })),
      applicationOrder, scentProfile, score,
      explanation: `${chemistry} ${reason}. Optimal for ${profile.mood[0].toLowerCase()} moments with ${projLevel.toLowerCase()} sillage.`,
      longevity: longevityStr, projection: `${projLevel} sillage`,
      mood: profile.mood, season: profile.season,
    };
  });
}

function generateMixesForOccasion(libraryIds, occasionId) {
  const allFrags = libraryIds.map(id => fc(id)).filter(Boolean);
  if (allFrags.length < 2) return [];
  const filtered = filterFragsByOccasion(allFrags, occasionId);
  const pairs = generateSmartMatches(filtered.map(f => f.id), 3);
  const finalPairs = pairs.length >= 1 ? pairs : generateSmartMatches(allFrags.map(f => f.id), 3);
  return buildLocalCombos(finalPairs, occasionId);
}

/* ═══════════════════════════════════════════════
   MIXER PAGE
═══════════════════════════════════════════════ */
function MixerPage({ library, savedMixes, setSavedMixes, preloadIds, clearPreload }) {
  const [occasion, setOccasion] = useState("daily");
  const [results, setResults]   = useState(null);
  const [loading, setLoading]   = useState(false);
  const [thinking, setThinking] = useState("");
  const timerRef = useRef(null);
  const occ      = OCCASIONS.find(o => o.id === occasion);
  const libFrags = library.map(id => fc(id)).filter(Boolean);
  const isSaved  = (combo) => savedMixes.some(m => m.name === combo.name);
  const saveMix  = (combo) => setSavedMixes(prev => [...prev, { ...combo, savedAt: Date.now(), occasion: occ.label }]);

  const THINKING_PHRASES = ["Mapping note families…","Scoring olfactory harmony…","Resolving accord conflicts…","Layering the pyramid…","Calibrating sillage…","Consulting the perfumer…"];

  const runGeneration = useCallback((occId) => {
    if (library.length < 2) { setResults([]); return; }
    clearTimeout(timerRef.current);
    setLoading(true); setResults(null);
    let phraseIdx = 0; setThinking(THINKING_PHRASES[0]);
    const phraseTimer = setInterval(() => { phraseIdx = (phraseIdx + 1) % THINKING_PHRASES.length; setThinking(THINKING_PHRASES[phraseIdx]); }, 160);
    timerRef.current = setTimeout(() => {
      clearInterval(phraseTimer);
      setResults(generateMixesForOccasion(library, occId));
      setLoading(false);
    }, 520);
  }, [library]);

  useEffect(() => { runGeneration(occasion); return () => clearTimeout(timerRef.current); }, [occasion, library.join(",")]);

  useEffect(() => {
    if (preloadIds && preloadIds.length) { clearPreload(); runGeneration(occasion); }
  }, [preloadIds]);

  const profiledFrags = useMemo(() => {
    if (libFrags.length === 0) return [];
    return filterFragsByOccasion(libFrags, occasion).slice(0, 6);
  }, [library.join(","), occasion]);

  return (
    <div className="page fu">
      <div className="page-header">
        <div className="page-title">⚗ Mix Generator</div>
        <div className="page-sub">Pick an occasion — AI instantly crafts your best blends</div>
      </div>
      <div className="mixer-layout">
        {/* Left panel */}
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="step-label"><span className="step-num">1</span>Choose Occasion</div>
            <div className="occ-grid">
              {OCCASIONS.map(o => (
                <button key={o.id} className={`occ-btn ${occasion === o.id ? "active" : ""}`} onClick={() => setOccasion(o.id)}>
                  <span className="occ-icon">{o.icon}</span>
                  <div className="occ-label">{o.label}</div>
                  <div className="occ-desc">{o.desc}</div>
                </button>
              ))}
            </div>
            <div style={{
              display:"flex",alignItems:"center",gap:8,padding:"10px 14px",
              background:"var(--card2)",borderRadius:"var(--rsm)",
              border:`1px solid ${loading ? "var(--gold-dim)" : "var(--bord)"}`,
              transition:"border-color .3s",marginBottom:16,
            }}>
              {loading
                ? <span style={{width:8,height:8,borderRadius:"50%",background:"var(--gold)",flexShrink:0,animation:"pulse 1s infinite"}}/>
                : <span style={{width:8,height:8,borderRadius:"50%",background:"var(--ok)",flexShrink:0}}/>
              }
              <span style={{fontSize:12,color:loading?"var(--gold)":"var(--muted)",fontFamily:"'DM Mono',monospace",transition:"color .3s"}}>
                {loading ? thinking : results && results.length > 0
                  ? `${results.length} blend${results.length > 1 ? "s" : ""} ready for ${occ?.label}`
                  : library.length < 2 ? "Add ≥ 2 fragrances to your library" : "Ready"
                }
              </span>
            </div>
            <div className="step-label" style={{ marginBottom: 8 }}>
              <span className="step-num">2</span>
              AI-Selected Pool
              <span style={{ fontSize: 10, color: "var(--dim)", fontWeight: 400, marginLeft: 4, textTransform: "none", letterSpacing: 0 }}>
                ({profiledFrags.length} of {libFrags.length} matched)
              </span>
            </div>
            {libFrags.length < 2 ? (
              <div style={{ textAlign:"center",padding:"20px 12px",color:"var(--muted)",fontSize:13 }}>
                Add fragrances to your library first
              </div>
            ) : (
              <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                {profiledFrags.map(f => (
                  <div key={f.id} style={{
                    display:"flex",alignItems:"center",gap:9,padding:"8px 10px",
                    background:"var(--card2)",border:"1px solid var(--bord)",
                    borderLeft:`3px solid ${familyColor(f.family)}`,
                    borderRadius:"var(--rsm)",opacity:loading?0.45:1,transition:"opacity .3s",
                  }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:12,fontWeight:500,color:"var(--text)" }}>{f.name}</div>
                      <div style={{ fontSize:10,color:"var(--muted)" }}>{f.brand} · {f.family}</div>
                    </div>
                    <div style={{ display:"flex",gap:3 }}>
                      {[...f.top.slice(0,1), ...f.base.slice(0,1)].map((n, i) => (
                        <span key={i} className="note-tag" style={{ fontSize:9 }}>{n}</span>
                      ))}
                    </div>
                  </div>
                ))}
                {libFrags.length > profiledFrags.length && (
                  <div style={{ fontSize:11,color:"var(--dim)",textAlign:"center",padding:"4px 0" }}>
                    +{libFrags.length - profiledFrags.length} more considered
                  </div>
                )}
              </div>
            )}
            {results && results.length > 0 && (
              <div className="three-frag-tip" style={{ marginTop:14 }}>
                <span>✦</span>
                <span>Curated for <strong>{occ?.label}</strong> — {OCCASION_PROFILES[occasion]?.mood.join(", ").toLowerCase()}</span>
              </div>
            )}
          </div>
        </div>
        {/* Right panel */}
        <div className="results-area">
          {loading && (
            <div>
              <div className="loading-card">
                <div className="spinner"/>
                <div style={{ fontFamily:"Cormorant Garamond,serif",fontSize:18,fontStyle:"italic",
                  background:"linear-gradient(120deg,var(--gold),var(--gold2),var(--gold))",
                  backgroundSize:"200% auto",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
                  animation:"goldShine 2s linear infinite" }}>{thinking}</div>
                <div style={{ fontSize:12,color:"var(--muted)",textAlign:"center",maxWidth:280 }}>
                  Filtering your library for <strong style={{ color:"var(--text)" }}>{occ?.label}</strong>
                </div>
              </div>
              <div style={{marginTop:16}}>{[1,2].map(i=><SkeletonMixCard key={i}/>)}</div>
            </div>
          )}
          {!loading && library.length < 2 && (
            <div className="result-placeholder">
              <span className="result-placeholder-icon">◈</span>
              <div style={{ fontFamily:"Cormorant Garamond,serif",fontSize:18,fontStyle:"italic",color:"var(--muted)" }}>Your library needs more fragrances</div>
              <div style={{ fontSize:12,color:"var(--dim)",textAlign:"center",maxWidth:240 }}>Add at least 2 fragrances — AI does the rest instantly</div>
            </div>
          )}
          {!loading && library.length >= 2 && results && results.length === 0 && (
            <div className="result-placeholder">
              <span className="result-placeholder-icon">⚗</span>
              <div style={{ fontFamily:"Cormorant Garamond,serif",fontSize:18,fontStyle:"italic",color:"var(--muted)" }}>No strong matches found</div>
              <div style={{ fontSize:12,color:"var(--dim)",textAlign:"center",maxWidth:240 }}>Try a different occasion or add more fragrances</div>
            </div>
          )}
          {!loading && results && results.map((combo, i) => (
            <MixResultCard key={`${occasion}-${i}`} combo={combo} index={i} onSave={saveMix} alreadySaved={isSaved(combo)}/>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SAVED PAGE
═══════════════════════════════════════════════ */
function SavedPage({ savedMixes, setSavedMixes }) {
  const [open, setOpen] = useState(null);
  const deleteMix = (i) => setSavedMixes(prev=>prev.filter((_,idx)=>idx!==i));
  return (
    <div className="page fu">
      <div className="page-header">
        <div className="page-title">Saved Mixes</div>
        <div className="page-sub">{savedMixes.length} combinations in your collection</div>
      </div>
      {savedMixes.length === 0 ? (
        <div className="empty-saved">
          <div className="empty-icon" style={{fontSize:48,display:"block",marginBottom:16,animation:"float 3s ease-in-out infinite"}}>♦</div>
          <div className="empty-title">No saved mixes yet</div>
          <div style={{fontSize:13,color:"var(--muted)"}}>Generate and save your first AI fragrance combination</div>
        </div>
      ) : (
        <div className="saved-list">
          {savedMixes.map((m, i) => (
            <div key={i} className={`saved-card ${open===i?"open":""}`}>
              <div className="saved-card-head" onClick={()=>setOpen(open===i?null:i)}>
                <div style={{flex:1,minWidth:0}}>
                  <div className="saved-card-name">"{m.name}"</div>
                  <div className="saved-card-meta">
                    <span className="meta-chip" style={{fontSize:11}}>{m.occasion}</span>
                    <span style={{fontSize:11,color:"var(--muted)"}}>Score: {m.score}</span>
                    <span style={{fontSize:11,color:"var(--dim)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:200}}>
                      {m.fragrances.map(f=>f.name).join(" + ")}
                    </span>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                  <button className="btn btn-err btn-sm" onClick={e=>{e.stopPropagation();deleteMix(i)}}>Delete</button>
                  <span className="expand-icon">▼</span>
                </div>
              </div>
              {open===i && (
                <div className="saved-card-body fi">
                  <div style={{marginBottom:12}}>
                    <div className="section-head">Blend</div>
                    {m.fragrances.map((fr,fi)=>(
                      <div key={fi} className="mix-frag-row" style={{marginBottom:6}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:13,fontWeight:500}}>{fr.name}</div>
                          <div style={{fontSize:11,color:"var(--muted)"}}>{fr.brand} · {fr.application}</div>
                        </div>
                        <span className="mix-ratio-num">{fr.ratio}%</span>
                      </div>
                    ))}
                  </div>
                  <div className="explain-text" style={{marginBottom:12}}>💡 {m.explanation}</div>
                  <div style={{marginBottom:12}}>
                    <LongevityTimeline longevityStr={m.longevity}/>
                    <ProjectionIndicator projectionStr={m.projection}/>
                  </div>
                  <div className="mix-meta">
                    <span className="meta-chip">⏱ {m.longevity}</span>
                    <span className="meta-chip">💨 {m.projection}</span>
                    {(m.season||[]).map(s=><span key={s} className="meta-chip">🌿 {s}</span>)}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   ROOT APP  — Supabase Auth + session management
═══════════════════════════════════════════════ */
export default function App() {
  /*
   * authLoading: true while we wait for Supabase to restore the
   * session from localStorage — prevents the auth screen flashing
   * on refresh for already-logged-in users.
   */
  const [authLoading, setAuthLoading] = useState(true);
  const [page,        setPage]        = useState("dashboard");
  const [user,        setUser]        = useState(null);   // normalised app user
  const [library,     setLibrary]     = useState([]);
  const [savedMixes,  setSavedMixes]  = useState([]);
  const [mixerPreload,setMixerPreload]= useState(null);

  /* ── Theme ── */
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("afl:theme") || "dark"; } catch { return "dark"; }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("afl:theme", theme); } catch {}
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

  /* ─────────────────────────────────────────────
     SESSION BOOTSTRAP
     1. getSession() — restores from localStorage instantly
     2. onAuthChange — handles login / logout / token refresh
  ───────────────────────────────────────────── */
  /* Fonts — no-op now, body is always visible */
  useEffect(() => {}, []);

  const normalise = (supabaseUser) => supabaseUser
    ? { id: supabaseUser.id, name: getUserDisplayName(supabaseUser), email: supabaseUser.email }
    : null;

  useEffect(() => {
    let mounted = true;

    /* Restore existing session without any round-trip flash */
    getSession().then(({ user: u }) => {
      if (!mounted) return;
      setUser(normalise(u));
      setAuthLoading(false);
    });

    /* Subscribe to real-time auth events */
    const { data: { subscription } } = onAuthChange((supabaseUser) => {
      if (!mounted) return;
      setUser(normalise(supabaseUser));
      setAuthLoading(false);
    });

    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  /* ─────────────────────────────────────────────
     USER-SCOPED PERSISTENCE
     Tries Supabase cloud sync first; silently falls
     back to localStorage if network is blocked.
     Shows a live sync-status badge in the sidebar.
  ───────────────────────────────────────────── */
  const [syncStatus,   setSyncStatus]   = useState("idle");
  const [dataLoading,  setDataLoading]  = useState(true);  // true until first load completes
  // syncStatus: "idle" | "saving" | "saved" | "local"
  const saveTimerRef = useRef(null);
  const isFirstLoad  = useRef(true);

  /* ── Load on login / user switch ── */
  useEffect(() => {
    if (!user) { setLibrary([]); setSavedMixes([]); setDataLoading(false); return; }
    isFirstLoad.current = true;
    setSyncStatus("idle");
    setDataLoading(true);
    (async () => {
      try {
        const { library: lib, mixes, source } = await dbLoad(user.id);
        setLibrary(lib);
        setSavedMixes(mixes);
        setSyncStatus(source === "supabase" ? "saved" : "local");
      } catch {
        setLibrary([]);
        setSavedMixes([]);
        setSyncStatus("local");
      } finally {
        setDataLoading(false);
      }
    })();
  }, [user?.id]);

  /* ── Debounced save whenever library or mixes change ── */
  useEffect(() => {
    /* Skip the very first render after load to avoid an immediate re-save */
    if (isFirstLoad.current) { isFirstLoad.current = false; return; }
    if (!user) return;

    setSyncStatus("saving");
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const result = await dbSave(user.id, library, savedMixes);
      setSyncStatus(result === "supabase" ? "saved" : "local");
      /* Reset "saved" badge after 3s */
      if (result === "supabase") {
        setTimeout(() => setSyncStatus("idle"), 3000);
      }
    }, 800);   // 800ms debounce — no spam on rapid changes

    return () => clearTimeout(saveTimerRef.current);
  }, [library, savedMixes, user?.id]);

  /* ── Logout ── */
  const handleLogout = async () => {
    await signOut();
    setLibrary([]); setSavedMixes([]);
    setDataLoading(true);
    setPage("dashboard");
    /* setUser(null) is handled by onAuthChange above */
  };

  /* ─────────────────────────────────────────────
     RENDER STATES
  ───────────────────────────────────────────── */

  /* 1 — Restoring session: full-screen elegant loader */
  if (authLoading) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }}/>
        <div className="auth-bg" style={{flexDirection:"column",gap:0,position:"relative",overflow:"hidden"}}>
          {/* Ambient glow rings */}
          <div style={{
            position:"absolute",width:320,height:320,borderRadius:"50%",
            border:"1px solid rgba(201,168,76,.12)",
            animation:"ringPulse 3s ease-in-out infinite",
            pointerEvents:"none",
          }}/>
          <div style={{
            position:"absolute",width:200,height:200,borderRadius:"50%",
            border:"1px solid rgba(201,168,76,.2)",
            animation:"ringPulse 3s ease-in-out infinite .6s",
            pointerEvents:"none",
          }}/>
          {/* Logo */}
          <div style={{
            fontFamily:"Cormorant Garamond,serif",
            fontSize:52,fontWeight:300,
            color:"var(--gold)",letterSpacing:4,
            animation:"logoReveal .9s cubic-bezier(.16,1,.3,1) forwards",
            marginBottom:8,
          }}>AFL</div>
          {/* Tagline */}
          <div style={{
            fontSize:12,color:"var(--muted)",letterSpacing:2,
            textTransform:"uppercase",
            animation:"tagReveal .7s ease .5s both",
            marginBottom:36,
          }}>Intelligent Fragrance Layering</div>
          {/* Slim progress bar */}
          <div style={{
            width:120,height:2,borderRadius:1,
            background:"var(--bord)",overflow:"hidden",
          }}>
            <div style={{
              height:"100%",borderRadius:1,
              background:"linear-gradient(90deg,var(--gold-dim),var(--gold),var(--gold2))",
              animation:"shimmer 1.4s ease infinite",
              backgroundSize:"200% 100%",
            }}/>
          </div>
        </div>
      </>
    );
  }

  /* 2 — Not logged in: show auth screen */
  if (!user) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }}/>
        <AuthPage theme={theme} onToggleTheme={toggleTheme}/>
      </>
    );
  }

  /* 3 — Logged in: show main app */
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }}/>
      <div className="layout">
        {/* Desktop sidebar */}
        <Sidebar
          page={page} setPage={setPage} user={user}
          libCount={library.length} savedCount={savedMixes.length}
          theme={theme} onToggleTheme={toggleTheme}
          onLogout={handleLogout} syncStatus={syncStatus}
        />

        <main className="main">
          {/* Mobile top bar */}
          <div className="mobile-topbar">
            <span className="mobile-topbar-logo">AFL ✦</span>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              {/* Pill switch */}
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
              {/* Avatar dropdown — logout lives inside */}
              <UserMenu user={user} onLogout={handleLogout} dropDirection="down" />
            </div>
          </div>

          {page==="dashboard" && (
            <DashboardPage
              user={user} library={library} savedMixes={savedMixes}
              setPage={setPage} onPreloadMixer={ids => setMixerPreload(ids)}
              dataLoading={dataLoading}
            />
          )}
          {page==="library" && <LibraryPage library={library} setLibrary={setLibrary}
            dataLoading={dataLoading}/>}
          {page==="mixer"   && (
            <MixerPage
              library={library} savedMixes={savedMixes} setSavedMixes={setSavedMixes}
              preloadIds={mixerPreload} clearPreload={() => setMixerPreload(null)}
            />
          )}
          {page==="saved"   && <SavedPage savedMixes={savedMixes} setSavedMixes={setSavedMixes}/>}
        </main>

        {/* Mobile bottom nav */}
        <MobileNav
          page={page} setPage={setPage}
          libCount={library.length} savedCount={savedMixes.length}
        />
      </div>
    </>
  );
}
