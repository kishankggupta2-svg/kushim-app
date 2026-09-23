const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const BOT_TOKEN = defineSecret("BOT_TOKEN");

const HOUR = 3600 * 1000;

// ===== सारे नियम एक ही जगह (बदलना हो तो सिर्फ़ यहीं बदलें) =====
const CFG = {
  miningMs: 24 * HOUR,             // एक माइनिंग सेशन = 24 घंटे
  baseReward: 1000,                // 24 घंटे में 1000 KSH
  boostMs: 4 * HOUR,               // हर Boost = 4 घंटे
  boostMultipliers: [2, 3, 4],     // क्रम से 2x, 3x, 4x
  boostVideoSeq: [15, 20, 30],     // Boost वीडियो: 15s, 20s, 30s, फिर दोहराव
  dailyVideoSeq: [15, 20, 25, 30], // Daily वीडियो: 15s, 20s, 25s, 30s, फिर दोहराव
  miningVideoSeq: [15, 20, 30],    // माइनिंग शुरू करने से पहले वीडियो: 15s, 20s, 30s
  videoClaimVideoSeq: [15, 20, 30],// Video Claim वीडियो: 15s, 20s, 30s
  videoMaxMs: 10 * 60 * 1000,      // हर वीडियो टिकट 10 मिनट में ही चलेगा
  videoClaimReward: 20,            // हर Video Claim पर मिलने वाला KSH
  maxVideoClaimsPerDay: 20,        // रोज़ ज़्यादा से ज़्यादा इतने Video Claim
  dailyStep: 100,                  // Day n का इनाम = n x 100 KSH
  dailyDays: 30,
  dailyCooldownMs: 24 * HOUR,      // अगला दिन 24 घंटे बाद खुलेगा
  dailyResetMs: 48 * HOUR,         // 48 घंटे से ज़्यादा छूटा तो Day 1 से
  weeklyBonusEvery: 7,             // हर 7वें लगातार Daily Claim पर अतिरिक्त बोनस
  weeklyBonusAmount: 500,          // 7-day streak बोनस की रकम
  referralReward: 200,             // दोस्त लिंक से ऐप खोले तो रेफर करने वाले को
  maxReferralsPerDay: 50,          // रोज़ इतने ही रेफरल इनाम (नकली अकाउंट रोकने के लिए)
  teamBoostPerFriend: 20,          // हर सक्रिय (उस वक़्त माइनिंग कर रहे) रेफरल दोस्त पर Claim में अतिरिक्त बोनस
  teamBoostMaxFriends: 10,         // ज़्यादा से ज़्यादा इतने दोस्तों का बोनस गिना जाएगा
  historyLimit: 100,
  leaderboardSize: 20,
  leaderboardCacheMs: 60 * 1000,
  maxSupply: 100000000000,         // Total Supply: 100 अरब KSH
  supplyShards: 5,                 // Total Supply गिनने के बंटे काउंटर
};

const OPT = { region: "asia-south1" };

// ---------- helpers ----------
const round4 = (x) => Math.round(x * 10000) / 10000;
const fp = (msg) => new HttpsError("failed-precondition", msg);

// Boost n का अतिरिक्त इनाम = (गुणक - 1) x आधार दर x 4 घंटे
const boostExtra = (tier) =>
  round4((CFG.boostMultipliers[tier - 1] - 1) * CFG.baseReward * (CFG.boostMs / CFG.miningMs));

// क्रम से बढ़ता वीडियो समय: पहली बार seq[0], दूसरी बार seq[1], ... फिर दोहराव
const videoSeqMs = (seq, count) => seq[count % seq.length] * 1000;

// किसी भी वीडियो-टिकट की जाँच: पूरा समय बीता, बहुत देर तो नहीं हो गई
function checkTicket(t, label) {
  if (!t) throw fp("Watch the " + label + " video first.");
  const elapsed = Date.now() - t.at;
  if (elapsed < (t.durationMs || 0)) throw fp("Please watch the full video.");
  if (elapsed > CFG.videoMaxMs) throw fp("Video session expired. Please try again.");
}

const userRef = (uid) => db.collection("users").doc(uid);
const miningRef = (uid) => userRef(uid).collection("mining").doc("current");
const notifyRef = (uid) => db.collection("notifyQueue").doc(uid);
const supplyRef = (i) => db.collection("supply").doc("s" + i);

function addSupply(tx, amount) {
  const i = Math.floor(Math.random() * CFG.supplyShards);
  tx.set(supplyRef(i), { total: FieldValue.increment(amount) }, { merge: true });
}

async function readSupply() {
  const refs = [];
  for (let i = 0; i < CFG.supplyShards; i++) refs.push(supplyRef(i));
  const snaps = await db.getAll(...refs);
  return round4(snaps.reduce((s, d) => s + (d.exists ? d.data().total || 0 : 0), 0));
}

// लॉगिन + खाता मौजूद + सस्पेंड नहीं (हर कॉल पर)
async function guard(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  const uid = request.auth.uid;
  const s = await userRef(uid).get();
  if (!s.exists) throw new HttpsError("not-found", "Account not found. Please reopen the app.");
  if (s.data().banned) throw new HttpsError("permission-denied", "Your account is suspended.");
  return uid;
}

function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(calc, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (Date.now() / 1000 - authDate > 86400) return null;

  let user;
  try {
    user = JSON.parse(params.get("user"));
  } catch (e) {
    return null;
  }
  if (!user || !user.id) return null;
  return { user, startParam: params.get("start_param") || "" };
}

function dailyStatus(u, now) {
  const last = u.lastDailyMs || 0;
  let day = u.dailyDay || 1;
  if (last && now - last > CFG.dailyResetMs) day = 1;
  const nextMs = last ? last + CFG.dailyCooldownMs : 0;
  return { day, nextMs };
}

const istDay = (now) => new Date(now + 5.5 * HOUR).toISOString().slice(0, 10);

// रेफर करने वाले को इनाम (रोज़ की सीमा के साथ) + अपने रेफरल की सूची में जोड़ना
function creditReferral(tx, refId, refData, friendUid, friendName, now) {
  const day = istDay(now);
  const count = refData.refDay === day ? refData.refDayCount || 0 : 0;
  if (count >= CFG.maxReferralsPerDay) return false;
  const R = CFG.referralReward;
  const rRef = userRef(refId);
  tx.update(rRef, {
    balanceKSH: FieldValue.increment(R),
    totalEarned: FieldValue.increment(R),
    referralCount: FieldValue.increment(1),
    referralEarned: FieldValue.increment(R),
    refDay: day,
    refDayCount: count + 1,
  });
  tx.set(rRef.collection("history").doc(), {
    type: "referral",
    amount: R,
    from: friendName || "",
    at: now,
  });
  tx.set(rRef.collection("referrals").doc(friendUid), {
    name: friendName || "Friend",
    at: now,
  });
  addSupply(tx, R);
  return true;
}

// लॉक की तारीख आ गई हो तो टोकन वापस बैलेंस में
async function settleLock(uid, now) {
  const ref = userRef(uid);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = s.data();
    if ((d.lockedTokens || 0) > 0 && d.unlockAtMs && now >= d.unlockAtMs) {
      tx.update(ref, {
        balanceKSH: FieldValue.increment(d.lockedTokens),
        lockedTokens: 0,
        unlockAtMs: 0,
      });
    }
  });
}

async function buildState(uid) {
  const now = Date.now();
  await settleLock(uid, now);

  const [uSnap, mSnap, supply, authRec] = await Promise.all([
    userRef(uid).get(),
    miningRef(uid).get(),
    readSupply(),
    admin.auth().getUser(uid).catch(() => null),
  ]);
  if (!uSnap.exists) throw new HttpsError("not-found", "User not found");

  const u = uSnap.data();
  const m = mSnap.exists ? mSnap.data() : null;
  const daily = dailyStatus(u, now);
  const p = u.profile || {};

  return {
    serverNow: now,
    telegramId: u.telegramId,
    firstName: u.firstName || "",
    balance: u.balanceKSH || 0,
    locked: u.lockedTokens || 0,
    unlockAtMs: u.unlockAtMs || 0,
    referralCount: u.referralCount || 0,
    referralEarned: u.referralEarned || 0,
    earnedMining: u.earnedMining || 0,
    earnedDaily: u.earnedDaily || 0,
    earnedVideo: u.earnedVideo || 0,
    totalEarned: u.totalEarned || 0,
    dailyClaimsTotal: u.dailyClaimsTotal || 0,
    needsMiningVideo: !!(m == null),
    profile: {
      name: p.name || "",
      surname: p.surname || "",
      mobile: p.mobile || "",
      photo: p.photo || "",
      withdrawAddress: p.withdrawAddress || "",
    },
    login: {
      email: authRec && authRec.email ? authRec.email : "",
      emailVerified: !!(authRec && authRec.emailVerified),
    },
    mining: m ? { startMs: m.startMs, endMs: m.endMs, boosts: m.boosts || [] } : null,
    daily: { day: daily.day, nextMs: daily.nextMs },
    supply: { total: supply, max: CFG.maxSupply },
    config: {
      miningMs: CFG.miningMs,
      baseReward: CFG.baseReward,
      boostMs: CFG.boostMs,
      boostMultipliers: CFG.boostMultipliers,
      boostExtras: CFG.boostMultipliers.map((_, i) => boostExtra(i + 1)),
      dailyStep: CFG.dailyStep,
      dailyDays: CFG.dailyDays,
      referralReward: CFG.referralReward,
      videoClaimReward: CFG.videoClaimReward,
      maxVideoClaimsPerDay: CFG.maxVideoClaimsPerDay,
      teamBoostPerFriend: CFG.teamBoostPerFriend,
      teamBoostMaxFriends: CFG.teamBoostMaxFriends,
    },
  };
}

// ---------- 1. Telegram लॉगिन + नया खाता + रेफरल ----------
exports.authTelegram = onCall({ ...OPT, secrets: [BOT_TOKEN] }, async (request) => {
  const initData = request.data && request.data.initData;
  if (!initData) throw new HttpsError("invalid-argument", "initData missing");

  const verified = verifyInitData(initData, BOT_TOKEN.value());
  if (!verified) throw new HttpsError("permission-denied", "Invalid Telegram data");

  const { user, startParam } = verified;
  const uid = "tg_" + user.id;
  const ref = userRef(uid);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (snap.data().banned) throw new HttpsError("permission-denied", "Your account is suspended.");
      return;
    }

    // नया यूज़र: अगर रेफरल लिंक से आया है तो रेफर करने वाले को इनाम (सिर्फ़ एक बार, खाता बनते समय)
    let referredBy = null;
    let refData = null;
    if (startParam.startsWith("ref_")) {
      const digits = startParam.slice(4).replace(/\D/g, "");
      const rid = "tg_" + digits;
      if (digits && rid !== uid) {
        const rs = await tx.get(userRef(rid));
        if (rs.exists && !rs.data().banned) {
          referredBy = rid;
          refData = rs.data();
        }
      }
    }

    tx.set(ref, {
      telegramId: String(user.id),
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      username: user.username || "",
      balanceKSH: 0,
      lockedTokens: 0,
      unlockAtMs: 0,
      totalEarned: 0,
      earnedMining: 0,
      earnedDaily: 0,
      earnedVideo: 0,
      referralCount: 0,
      referralEarned: 0,
      referredBy,
      dailyDay: 1,
      lastDailyMs: 0,
      dailyClaimsTotal: 0,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (referredBy) creditReferral(tx, referredBy, refData, uid, user.first_name, now);
  });

  const token = await admin.auth().createCustomToken(uid);
  return { token, uid };
});

// ---------- 2. पूरी स्थिति ----------
exports.getState = onCall(OPT, async (request) => {
  const uid = await guard(request);
  return await buildState(uid);
});

// ---------- 3a. माइनिंग शुरू करने से पहले वीडियो का टिकट ----------
exports.startMiningVideo = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const mRef = miningRef(uid);
  const uRef = userRef(uid);
  let durationMs = 0;

  await db.runTransaction(async (tx) => {
    const [mSnap, uSnap] = await Promise.all([tx.get(mRef), tx.get(uRef)]);
    if (mSnap.exists) throw fp("Mining is already running or waiting to be claimed.");
    const count = (uSnap.data() && uSnap.data().miningVideoCount) || 0;
    durationMs = videoSeqMs(CFG.miningVideoSeq, count);
    tx.update(uRef, { startTicket: { at: now, durationMs }, miningVideoCount: count + 1 });
  });

  return { ok: true, videoMs: durationMs };
});

// ---------- 3b. माइनिंग शुरू (वीडियो पूरा होने के बाद ही, फिर 24 घंटे) ----------
exports.startMining = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const mRef = miningRef(uid);
  const uRef = userRef(uid);

  await db.runTransaction(async (tx) => {
    const [mSnap, uSnap] = await Promise.all([tx.get(mRef), tx.get(uRef)]);
    if (mSnap.exists) throw fp("Mining is already running or waiting to be claimed.");
    checkTicket(uSnap.data().startTicket, "mining start");

    const endMs = now + CFG.miningMs;
    tx.set(mRef, { startMs: now, endMs, boosts: [] });
    // माइनिंग पूरी होने पर Telegram में सूचना भेजने की कतार
    tx.set(notifyRef(uid), { endMs, chatId: uid.replace("tg_", "") });
    tx.update(uRef, { startTicket: FieldValue.delete() });
  });

  return await buildState(uid);
});

// Boost कब शुरू और कब खत्म होगा (पिछले Boost के बाद कतार में)
function boostPlan(m, tier, now) {
  if (!m) throw fp("Start mining first.");
  if (now >= m.endMs) throw fp("Mining is finished. Claim your tokens first.");
  const boosts = m.boosts || [];
  if (tier !== boosts.length + 1) throw fp("Activate boosts in order: 2x, then 3x, then 4x.");

  // अगर पिछला Boost अभी भी अपनी 4 घंटे वाली विंडो में चल रहा है, तो यह उसी विंडो में जुड़ता है
  // (यानी 2x, 3x, 4x कुछ ही मिनट में एक के बाद एक चालू किए जा सकते हैं, इंतज़ार नहीं करना पड़ता)
  const last = boosts[boosts.length - 1];
  let startMs, endMs;
  if (last && last.endMs > now) {
    startMs = last.startMs;
    endMs = last.endMs;
  } else {
    startMs = now;
    endMs = now + CFG.boostMs;
  }
  if (endMs > m.endMs) throw fp("Not enough mining time left for a full 4 hour boost.");
  return { startMs, endMs };
}

function parseTier(request) {
  const tier = Number(request.data && request.data.tier);
  if (!Number.isInteger(tier) || tier < 1 || tier > CFG.boostMultipliers.length) {
    throw new HttpsError("invalid-argument", "Invalid boost");
  }
  return tier;
}

// ---------- 4a. Boost वीडियो का टिकट (समय बढ़ता क्रम: 15s, 20s, 30s...) ----------
exports.startBoostVideo = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const tier = parseTier(request);
  const now = Date.now();
  const mRef = miningRef(uid);
  const uRef = userRef(uid);
  let durationMs = 0;

  await db.runTransaction(async (tx) => {
    const [mSnap, uSnap] = await Promise.all([tx.get(mRef), tx.get(uRef)]);
    boostPlan(mSnap.exists ? mSnap.data() : null, tier, now);
    const count = (uSnap.data() && uSnap.data().boostVideoCount) || 0;
    durationMs = videoSeqMs(CFG.boostVideoSeq, count);
    tx.update(mRef, { boostTicket: { tier, at: now, durationMs } });
    tx.update(uRef, { boostVideoCount: count + 1 });
  });

  return { ok: true, videoMs: durationMs };
});

// ---------- 4b. Boost चालू (वीडियो का पूरा टिकट-समय बीतने के बाद ही) ----------
exports.activateBoost = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const tier = parseTier(request);
  const now = Date.now();
  const mRef = miningRef(uid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(mRef);
    const m = snap.exists ? snap.data() : null;
    const plan = boostPlan(m, tier, now);

    const t = m.boostTicket;
    if (!t || t.tier !== tier) throw fp("Watch the boost video first.");
    checkTicket(t, "boost");

    const boosts = m.boosts || [];
    boosts.push({ tier, startMs: plan.startMs, endMs: plan.endMs });
    tx.update(mRef, { boosts, boostTicket: FieldValue.delete() });
  });

  return await buildState(uid);
});

// ---------- 5. माइनिंग Claim (सिर्फ़ 24 घंटे पूरे होने पर, बिना वीडियो, तभी Firebase में जुड़ता है) ----------
// इसमें Pi Network जैसा "Team Mining Bonus" भी जुड़ता है: जितने रेफर किए दोस्त इस वक़्त खुद माइनिंग कर रहे हैं, हर एक पर अतिरिक्त बोनस
exports.claimMining = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const uRef = userRef(uid);
  const mRef = miningRef(uid);
  let reward = 0;
  let teamBonus = 0;
  let teamCount = 0;

  await db.runTransaction(async (tx) => {
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists) throw fp("No mining session to claim.");
    const m = mSnap.data();
    if (now < m.endMs) throw fp("Mining is not finished yet.");

    // Team Mining Bonus: हाल ही के रेफरल दोस्तों में से जो अभी माइनिंग कर रहे हैं
    const refSnap = await tx.get(
      uRef.collection("referrals").orderBy("at", "desc").limit(CFG.teamBoostMaxFriends * 2)
    );
    const friendMiningSnaps = await Promise.all(refSnap.docs.map((d) => tx.get(miningRef(d.id))));
    teamCount = Math.min(
      friendMiningSnaps.filter((s) => s.exists && s.data().endMs > now).length,
      CFG.teamBoostMaxFriends
    );
    teamBonus = teamCount * CFG.teamBoostPerFriend;

    const extra = round4((m.boosts || []).reduce((s, b) => s + boostExtra(b.tier), 0));
    reward = round4(CFG.baseReward + extra + teamBonus);

    tx.update(uRef, {
      balanceKSH: FieldValue.increment(reward),
      earnedMining: FieldValue.increment(reward),
      totalEarned: FieldValue.increment(reward),
    });
    tx.delete(mRef);
    tx.delete(notifyRef(uid));
    tx.set(uRef.collection("history").doc(), {
      type: "mining",
      amount: reward,
      base: CFG.baseReward,
      boostExtra: extra,
      teamBonus,
      at: now,
    });
    addSupply(tx, reward);
  });

  const state = await buildState(uid);
  return { ...state, reward, teamBonus, teamCount };
});

// ---------- 6a. Daily वीडियो का टिकट (समय बढ़ता क्रम: 15s, 20s, 25s, 30s...) ----------
exports.startDailyVideo = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const uRef = userRef(uid);
  let durationMs = 0;

  await db.runTransaction(async (tx) => {
    const s = await tx.get(uRef);
    const u = s.data();
    const st = dailyStatus(u, now);
    if (st.nextMs && now < st.nextMs) throw fp("Daily reward is not ready yet.");
    const count = u.dailyVideoCount || 0;
    durationMs = videoSeqMs(CFG.dailyVideoSeq, count);
    tx.update(uRef, {
      dailyTicket: { day: st.day, at: now, durationMs },
      dailyVideoCount: count + 1,
    });
  });

  return { ok: true, videoMs: durationMs };
});

// ---------- 6b. Daily reward Claim (वीडियो पूरा होने के बाद ही, Day 1..30, फिर दोबारा Day 1) ----------
exports.claimDaily = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const uRef = userRef(uid);
  let reward = 0;

  await db.runTransaction(async (tx) => {
    const s = await tx.get(uRef);
    const u = s.data();
    const st = dailyStatus(u, now);
    if (st.nextMs && now < st.nextMs) throw fp("Daily reward is not ready yet.");

    const t = u.dailyTicket;
    if (!t || t.day !== st.day) throw fp("Watch the daily video first.");
    checkTicket(t, "daily reward");

    reward = st.day * CFG.dailyStep;
    tx.update(uRef, {
      balanceKSH: FieldValue.increment(reward),
      earnedDaily: FieldValue.increment(reward),
      totalEarned: FieldValue.increment(reward),
      dailyDay: st.day >= CFG.dailyDays ? 1 : st.day + 1,
      lastDailyMs: now,
      dailyClaimsTotal: FieldValue.increment(1),
      dailyTicket: FieldValue.delete(),
    });
    tx.set(uRef.collection("history").doc(), { type: "daily", amount: reward, day: st.day, at: now });
    addSupply(tx, reward);
  });

  const state = await buildState(uid);
  return { ...state, reward };
});

// ---------- 6c. Video Claim: वीडियो देखो, सीधे Firebase में जुड़े (रोज़ की सीमा के साथ) ----------
exports.startVideoClaim = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const uRef = userRef(uid);
  let durationMs = 0;

  await db.runTransaction(async (tx) => {
    const s = await tx.get(uRef);
    const u = s.data();
    const day = istDay(now);
    const count = u.vcDay === day ? u.vcDayCount || 0 : 0;
    if (count >= CFG.maxVideoClaimsPerDay) throw fp("Daily video claim limit reached. Try again tomorrow.");
    const vcount = u.videoClaimCount || 0;
    durationMs = videoSeqMs(CFG.videoClaimVideoSeq, vcount);
    tx.update(uRef, { vcTicket: { at: now, durationMs }, videoClaimCount: vcount + 1 });
  });

  return { ok: true, videoMs: durationMs };
});

exports.claimVideoAd = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();
  const uRef = userRef(uid);
  let reward = 0;

  await db.runTransaction(async (tx) => {
    const s = await tx.get(uRef);
    const u = s.data();
    checkTicket(u.vcTicket, "claim");

    const day = istDay(now);
    const count = u.vcDay === day ? u.vcDayCount || 0 : 0;
    if (count >= CFG.maxVideoClaimsPerDay) throw fp("Daily video claim limit reached. Try again tomorrow.");

    reward = CFG.videoClaimReward;
    tx.update(uRef, {
      balanceKSH: FieldValue.increment(reward),
      earnedVideo: FieldValue.increment(reward),
      totalEarned: FieldValue.increment(reward),
      vcDay: day,
      vcDayCount: count + 1,
      vcTicket: FieldValue.delete(),
    });
    tx.set(uRef.collection("history").doc(), { type: "video", amount: reward, at: now });
    addSupply(tx, reward);
  });

  const state = await buildState(uid);
  return { ...state, reward };
});

// ---------- 7. Lock ----------
exports.lockTokens = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const amount = Number(request.data && request.data.amount);
  const date = String((request.data && request.data.date) || "");
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", "Enter a whole number amount.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError("invalid-argument", "Invalid date.");

  const unlockAtMs = Date.parse(date + "T00:00:00+05:30");
  const now = Date.now();
  if (isNaN(unlockAtMs) || unlockAtMs <= now) {
    throw new HttpsError("invalid-argument", "Unlock date must be in the future.");
  }

  await settleLock(uid, now);
  const ref = userRef(uid);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const u = s.data();
    if ((u.lockedTokens || 0) > 0) throw fp("Tokens are already locked.");
    if (amount > (u.balanceKSH || 0)) throw fp("Not enough claimed KSH balance.");
    tx.update(ref, {
      balanceKSH: FieldValue.increment(-amount),
      lockedTokens: amount,
      unlockAtMs,
    });
  });

  return await buildState(uid);
});

// ---------- 8. Profile ----------
exports.saveProfile = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const d = request.data || {};
  const name = String(d.name || "").trim();
  const surname = String(d.surname || "").trim();
  const mobile = String(d.mobile || "").trim();

  if (!name || name.length > 40) throw new HttpsError("invalid-argument", "Enter a valid first name.");
  if (!surname || surname.length > 40) throw new HttpsError("invalid-argument", "Enter a valid surname.");
  if (mobile && !/^\+?\d{7,15}$/.test(mobile)) {
    throw new HttpsError("invalid-argument", "Enter a valid mobile number (7-15 digits).");
  }

  await userRef(uid).update({
    "profile.name": name,
    "profile.surname": surname,
    "profile.mobile": mobile,
  });
  return await buildState(uid);
});

exports.savePhoto = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const photo = String((request.data && request.data.photo) || "");
  if (!photo.startsWith("data:image/jpeg;base64,") || photo.length > 80000) {
    throw new HttpsError("invalid-argument", "Invalid photo. Please choose another image.");
  }
  await userRef(uid).update({ "profile.photo": photo });
  return await buildState(uid);
});

// भविष्य में BNB Chain (BEP-20) पर असली टोकन भेजने के लिए यूज़र का वॉलेट पता सेव करना
// (सिर्फ़ पता सेव होता है; असली Withdrawal अभी "Coming Soon" ही है)
exports.saveWithdrawAddress = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const address = String((request.data && request.data.address) || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new HttpsError("invalid-argument", "Enter a valid BNB Chain (BEP-20) address.");
  }
  await userRef(uid).update({ "profile.withdrawAddress": address });
  return await buildState(uid);
});

// ---------- 9. History ----------
exports.getHistory = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const snap = await userRef(uid)
    .collection("history")
    .orderBy("at", "desc")
    .limit(CFG.historyLimit)
    .get();
  return { items: snap.docs.map((d) => d.data()) };
});

// ---------- 9b. मैंने जिन्हें रेफर किया, उनकी सूची ----------
exports.getReferralList = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const snap = await userRef(uid)
    .collection("referrals")
    .orderBy("at", "desc")
    .limit(200)
    .get();
  return { items: snap.docs.map((d) => d.data()) };
});

// ---------- 10. Leaderboard (कुल कमाई के हिसाब से, नाम के साथ) ----------
let lbCache = { at: 0, rows: [] };

exports.getLeaderboard = onCall(OPT, async (request) => {
  const uid = await guard(request);
  const now = Date.now();

  if (now - lbCache.at > CFG.leaderboardCacheMs) {
    const snap = await db
      .collection("users")
      .orderBy("totalEarned", "desc")
      .limit(CFG.leaderboardSize + 5)
      .get();
    const rows = [];
    snap.docs.forEach((d) => {
      const u = d.data();
      if (u.banned) return;
      const p = u.profile || {};
      const first = p.name || u.firstName || "Miner";
      const sur = (p.surname || u.lastName || "").charAt(0);
      rows.push({ id: d.id, name: (first + (sur ? " " + sur + "." : "")).trim(), total: u.totalEarned || 0 });
    });
    lbCache = { at: now, rows: rows.slice(0, CFG.leaderboardSize) };
  }

  const items = lbCache.rows.map((r, i) => ({ rank: i + 1, name: r.name, total: r.total, me: r.id === uid }));

  const me = await userRef(uid).get();
  const myTotal = (me.data() && me.data().totalEarned) || 0;
  const higher = await db.collection("users").where("totalEarned", ">", myTotal).count().get();
  return { items, myRank: higher.data().count + 1, myTotal };
});

// ---------- 11. माइनिंग पूरी होने पर Telegram सूचना (हर 10 मिनट) ----------
exports.notifyFinished = onSchedule(
  { region: "asia-south1", schedule: "every 10 minutes", secrets: [BOT_TOKEN] },
  async () => {
    const now = Date.now();
    const snap = await db.collection("notifyQueue").where("endMs", "<=", now).limit(100).get();
    for (const d of snap.docs) {
      const { chatId } = d.data();
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN.value()}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "⛏ Your Kushim mining is complete! Open the app and claim your tokens.",
          }),
        });
      } catch (e) {
        // यूज़र ने बोट को अनुमति न दी हो तो सूचना नहीं जाएगी, बाकी पर असर नहीं
      }
      await d.ref.delete();
    }
  }
);
