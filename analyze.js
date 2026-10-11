/**
 * SINNCI AI — XAU/USD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Analysis only. No automated trading or order execution.
 *
 * Strategy:
 * - Zone accuracy > signal timing > score
 * - D1 + H1 + M15 + M5
 * - Scalping: H1 direction + M5 entry structure
 * - Intraday: H1 direction + M15 entry structure
 * - SNR, breakout/retest, EMA20 reentry
 * - Structural SL, SNR/range targets
 * - Supabase setup locking
 */

const SETTINGS = {
  symbol: "XAU/USD",
  point: 0.01,
  zoneThickness: 2.00,
  candleCount: 50,
  timeout: 15000,

  scalping: {
    minimumScore: 65,
    lockMinutes: 720,
    maxRiskDistance: 8.00,
    maxTargetDistance: 30.00,
    tp1Fallback: 6.00,
    tp2Fallback: 12.00,
  },

  intraday: {
    minimumScore: 65,
    lockMinutes: 4320,
    maxRiskDistance: 15.00,
    maxTargetDistance: 80.00,
    tp1Fallback: 15.00,
    tp2Fallback: 23.00,
  },
};

const TIMEFRAMES = {
  D1: "1day",
  H1: "1h",
  M15: "15min",
  M5: "5min",
};

const TABLE = "sinnci_setup_locks";

/* =========================================================
   HTTP HELPERS
========================================================= */

function json(res, status, payload) {
  res.status(status).setHeader("Cache-Control", "no-store");
  return res.json(payload);
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(decimals));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function uniquePrices(values, tolerance = 0.15) {
  const result = [];

  for (const value of values) {
    if (!Number.isFinite(value)) continue;

    if (!result.some((existing) => Math.abs(existing - value) <= tolerance)) {
      result.push(value);
    }
  }

  return result;
}

function getEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchCandles(interval) {
  const apiKey = getEnv("TWELVE_DATA_API_KEY");

  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY belum ditetapkan di Vercel.");
  }

  const params = new URLSearchParams({
    symbol: SETTINGS.symbol,
    interval,
    outputsize: String(SETTINGS.candleCount),
    order: "ASC",
    timezone: "UTC",
    apikey: apiKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS.timeout);

  try {
    const response = await fetch(
      `https://api.twelvedata.com/time_series?${params.toString()}`,
      {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      }
    );

    const raw = await response.text();
    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(
        `Twelve Data memulangkan respons bukan JSON (HTTP ${response.status}).`
      );
    }

    if (!response.ok || body.status === "error" || body.code) {
      throw new Error(
        body.message ||
        body.msg ||
        `Twelve Data gagal mendapatkan ${interval} (HTTP ${response.status}).`
      );
    }

    if (!Array.isArray(body.values)) {
      throw new Error(`Data candle ${interval} tidak tersedia.`);
    }

    const candles = body.values
      .map((item) => ({
        time: item.datetime,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume || 0),
      }))
      .filter(
        (c) =>
          c.time &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.high >= c.low
      )
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    if (candles.length < 25) {
      throw new Error(
        `Candle ${interval} tidak mencukupi: ${candles.length} diterima.`
      );
    }

    return candles;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function findSwings(candles, wing = 2) {
  const highs = [];
  const lows = [];

  for (let i = wing; i < candles.length - wing; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;

      if (candles[j].high >= current.high) isHigh = false;
      if (candles[j].low <= current.low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: current.high, time: current.time });
    if (isLow) lows.push({ index: i, price: current.low, time: current.time });
  }

  return { highs, lows };
}

function buildStructure(candles) {
  const recent = candles.slice(-20);
  const closes = candles.map((c) => c.close);
  const swings = findSwings(candles, 2);

  const range = recent.length
    ? {
        high: Math.max(...recent.map((c) => c.high)),
        low: Math.min(...recent.map((c) => c.low)),
      }
    : null;

  const lastHighs = swings.highs.slice(-2);
  const lastLows = swings.lows.slice(-2);

  let direction = "NEUTRAL";

  if (lastHighs.length === 2 && lastLows.length === 2) {
    const higherHigh = lastHighs[1].price > lastHighs[0].price;
    const higherLow = lastLows[1].price > lastLows[0].price;
    const lowerHigh = lastHighs[1].price < lastHighs[0].price;
    const lowerLow = lastLows[1].price < lastLows[0].price;

    if (higherHigh && higherLow) direction = "BULLISH";
    else if (lowerHigh && lowerLow) direction = "BEARISH";
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  if (direction === "NEUTRAL" && ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) direction = "BULLISH";
    else if (last.close < ema20 && ema20 < ema50) direction = "BEARISH";
  }

  const breakoutUp =
    last.close > previous.high &&
    range &&
    last.close >= range.high - 0.05;

  const breakoutDown =
    last.close < previous.low &&
    range &&
    last.close <= range.low + 0.05;

  return {
    direction,
    range,
    swingHighs: swings.highs,
    swingLows: swings.lows,
    ema20,
    ema50,
    breakoutUp,
    breakoutDown,
    lastClose: last.close,
    lastTime: last.time,
  };
}

function getTrend(candles) {
  return buildStructure(candles).direction;
}

/* =========================================================
   EARLY ENTRY ZONE
========================================================= */

function buildEarlyZone(candles, direction, cmp, mode) {
  const recent = candles.slice(-35);
  const structure = buildStructure(recent);
  const swings = findSwings(recent, 2);

  const isBuy = direction === "BUY";
  const relevantSwings = isBuy ? swings.lows : swings.highs;

  const candidates = relevantSwings
    .filter((s) => isBuy ? s.price < cmp : s.price > cmp)
    .map((s) => ({
      price: s.price,
      time: s.time,
      source: isBuy ? "SNR_SUPPORT" : "SNR_RESISTANCE",
      index: s.index,
    }));

  let pivot = null;
  let source = "SNR_RANGE";
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = Math.abs(cmp - candidate.price);

    // Keep the nearest valid historical structure level.
    // Do not chase a level that is already behind current price.
    if (distance < bestDistance) {
      pivot = candidate.price;
      source = candidate.source;
      bestDistance = distance;
    }
  }

  // Breakout/retest structure can become the entry reference.
  if (isBuy && structure.breakoutUp && structure.range) {
    const level = structure.range.high;

    if (level < cmp && (pivot === null || Math.abs(cmp - level) < bestDistance)) {
      pivot = level;
      source = "SNR_BREAKOUT_RETEST";
    }
  }

  if (!isBuy && structure.breakoutDown && structure.range) {
    const level = structure.range.low;

    if (level > cmp && (pivot === null || Math.abs(cmp - level) < bestDistance)) {
      pivot = level;
      source = "SNR_BREAKDOWN_RETEST";
    }
  }

  // EMA20 reentry fallback. Use only when it lies on the correct side.
  const closes = recent.map((c) => c.close);
  const ema20 = ema(closes, 20);

  if (pivot === null && ema20 !== null) {
    const correctSide = isBuy ? ema20 < cmp : ema20 > cmp;

    if (correctSide) {
      pivot = ema20;
      source = "EMA20_REENTRY";
    }
  }

  // Final fallback: use recent range edge, not the current price.
  if (pivot === null && structure.range) {
    pivot = isBuy ? structure.range.low : structure.range.high;
    source = "SNR_RANGE_EDGE";
  }

  if (!Number.isFinite(pivot)) {
    return {
      valid: false,
      reason: "Struktur SNR yang sesuai belum ditemui.",
      low: null,
      high: null,
      entry: null,
      pivot: null,
      source,
      status: "WATCH",
      distance: null,
    };
  }

  const half = SETTINGS.zoneThickness / 2;
  const low = round(pivot - half);
  const high = round(pivot + half);
  const distance = isBuy ? low - cmp : cmp - high;

  let status = "WATCH";

  if (cmp >= low && cmp <= high) {
    status = "IN_ZONE";
  } else if (isBuy && cmp < low && low - cmp <= 5) {
    status = "APPROACHING";
  } else if (!isBuy && cmp > high && cmp - high <= 5) {
    status = "APPROACHING";
  }

  return {
    valid: high > low,
    low,
    high,
    entry: round(pivot),
    pivot: round(pivot),
    source,
    status,
    distance: round(Math.abs(distance)),
    timeframe: mode === "scalping" ? "M5" : "M15",
    reason: null,
  };
}

/* =========================================================
   STRUCTURAL STOP LOSS
========================================================= */

function buildStructuralStop(direction, zone, candles, maxRisk) {
  const recent = candles.slice(-35);
  const swings = findSwings(recent, 2);
  const isBuy = direction === "BUY";

  const candidates = isBuy
    ? swings.lows.map((s) => s.price).filter((p) => p < zone.low)
    : swings.highs.map((s) => s.price).filter((p) => p > zone.high);

  candidates.sort((a, b) => isBuy ? b - a : a - b);

  const entry = zone.entry;
  let stop = null;

  for (const level of candidates) {
    const candidate = isBuy ? level - 0.50 : level + 0.50;
    const risk = Math.abs(entry - candidate);

    if (
      (isBuy ? candidate < zone.low : candidate > zone.high) &&
      risk > 0 &&
      risk <= maxRisk
    ) {
      stop = candidate;
      break;
    }
  }

  // Fallback: place a stop outside the entry zone while respecting risk cap.
  if (stop === null) {
    const minimumBuffer = 0.50;
    stop = isBuy
      ? Math.min(zone.low - minimumBuffer, entry - Math.min(maxRisk, 4.50))
      : Math.max(zone.high + minimumBuffer, entry + Math.min(maxRisk, 4.50));
  }

  stop = round(stop);
  const risk = round(Math.abs(entry - stop));

  const correctSide = isBuy
    ? stop < zone.low
    : stop > zone.high;

  return {
    value: stop,
    risk,
    valid: correctSide && risk > 0 && risk <= maxRisk,
  };
}

/* =========================================================
   TARGETS: SWINGS + RECENT RANGE EXTREMES
========================================================= */

function findTargets(direction, entry, targetCandles, secondaryCandles) {
  const primary = targetCandles.slice(-40);
  const secondary = secondaryCandles.slice(-40);

  const primaryStructure = buildStructure(primary);
  const secondaryStructure = buildStructure(secondary);

  let candidates = [];

  if (direction === "BUY") {
    candidates = [
      ...primaryStructure.swingHighs.map((s) => s.price),
      ...secondaryStructure.swingHighs.map((s) => s.price),
      primaryStructure.range?.high,
      secondaryStructure.range?.high,
    ]
      .filter((price) => Number.isFinite(price) && price > entry)
      .sort((a, b) => a - b);
  } else if (direction === "SELL") {
    candidates = [
      ...primaryStructure.swingLows.map((s) => s.price),
      ...secondaryStructure.swingLows.map((s) => s.price),
      primaryStructure.range?.low,
      secondaryStructure.range?.low,
    ]
      .filter((price) => Number.isFinite(price) && price < entry)
      .sort((a, b) => b - a);
  }

  return uniquePrices(candidates);
}

function buildTradePlan(direction, zone, stopResult, primary, secondary, config) {
  if (!zone.valid || !stopResult.valid) {
    return {
      valid: false,
      entry: zone.entry,
      sl: stopResult.value,
      tp1: null,
      tp2: null,
      risk: stopResult.risk,
      reason: "SL tidak sah atau risiko melebihi had.",
    };
  }

  const entry = zone.entry;
  const risk = stopResult.risk;

  const targets = findTargets(direction, entry, primary, secondary)
    .map((price) => round(price))
    .filter((price) => {
      const distance = Math.abs(price - entry);
      return distance > 0 && distance <= config.maxTargetDistance;
    });

  let tp1 = targets[0] ?? null;
  let tp2 = targets[1] ?? null;

  // A fallback TP is allowed only when no reasonable SNR target exists.
  // It must remain in the correct direction and within the configured limit.
  if (tp1 === null) {
    const fallback = direction === "BUY"
      ? entry + config.tp1Fallback
      : entry - config.tp1Fallback;

    if (Math.abs(fallback - entry) <= config.maxTargetDistance) {
      tp1 = round(fallback);
    }
  }

  if (tp2 === null && tp1 !== null) {
    const fallback = direction === "BUY"
      ? entry + config.tp2Fallback
      : entry - config.tp2Fallback;

    if (
      Math.abs(fallback - entry) <= config.maxTargetDistance &&
      (direction === "BUY" ? fallback > tp1 : fallback < tp1)
    ) {
      tp2 = round(fallback);
    }
  }

  const tp1Valid = tp1 !== null && (
    direction === "BUY" ? tp1 > entry : tp1 < entry
  );

  if (!tp1Valid) {
    return {
      valid: false,
      entry,
      sl: stopResult.value,
      tp1: null,
      tp2: null,
      risk,
      reason: "Tiada target TP1 yang munasabah ditemui.",
    };
  }

  return {
    valid: true,
    entry,
    sl: stopResult.value,
    tp1,
    tp2,
    risk,
    reward1: round(Math.abs(tp1 - entry)),
    reward2: tp2 === null ? null : round(Math.abs(tp2 - entry)),
    rr1: risk > 0 ? round(Math.abs(tp1 - entry) / risk) : null,
    rr2: tp2 === null || risk <= 0
      ? null
      : round(Math.abs(tp2 - entry) / risk),
    reason: null,
  };
}

/* =========================================================
   SCORE: SECONDARY TO ZONE QUALITY
========================================================= */

function calculateScore(direction, trendH1, trendEntry, zone, structure) {
  let score = 50;

  const wanted = direction === "BUY" ? "BULLISH" : "BEARISH";

  if (trendH1 === wanted) score += 15;
  else if (trendH1 !== "NEUTRAL") score -= 12;

  if (trendEntry === wanted) score += 10;
  else if (trendEntry !== "NEUTRAL") score -= 8;

  if (zone.source === "SNR_SUPPORT" || zone.source === "SNR_RESISTANCE") {
    score += 10;
  } else if (zone.source.includes("RETEST")) {
    score += 12;
  } else if (zone.source === "EMA20_REENTRY") {
    score += 6;
  }

  if (zone.status === "IN_ZONE") score += 8;
  else if (zone.status === "APPROACHING") score += 5;

  if (structure.breakoutUp && direction === "BUY") score += 5;
  if (structure.breakoutDown && direction === "SELL") score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* =========================================================
   SUPABASE SIGNAL LOCK
========================================================= */

function supabaseConfig() {
  const url = getEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) return null;
  return { url, key };
}

async function supabaseRequest(path, options = {}) {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase environment variables belum lengkap.");

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();

  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = { message: raw };
    }
  }

  if (!response.ok) {
    throw new Error(
      body?.message ||
      body?.hint ||
      `Supabase gagal (HTTP ${response.status}).`
    );
  }

  return body;
}

async function getActiveLocks(mode) {
  if (!supabaseConfig()) return [];

  const query = new URLSearchParams({
    select: "*",
    symbol: `eq.${SETTINGS.symbol}`,
    mode: `eq.${mode}`,
    status: "eq.ACTIVE",
    order: "updated_at.desc",
    limit: "20",
  });

  return await supabaseRequest(`${TABLE}?${query.toString()}`, {
    method: "GET",
    prefer: "return=representation",
  });
}

function lockStillFresh(lock, config) {
  const updatedAt = new Date(lock.updated_at || lock.created_at).getTime();
  if (!Number.isFinite(updatedAt)) return false;

  return Date.now() - updatedAt <= config.lockMinutes * 60 * 1000;
}

function makeSetupId(mode, direction, zone) {
  const zoneKey = `${zone.low.toFixed(2)}_${zone.high.toFixed(2)}`;
  return `${SETTINGS.symbol.replace("/", "")}_${mode}_${direction}_${zoneKey}`
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function saveLock(setup, mode) {
  if (!supabaseConfig()) {
    return {
      enabled: false,
      persisted: false,
      reason: "Supabase belum dikonfigurasi.",
    };
  }

  if (
    setup.status !== "READY" ||
    !setup.plan?.valid ||
    !setup.zone?.valid
  ) {
    return {
      enabled: true,
      persisted: false,
      reason: "Setup belum layak untuk disimpan.",
    };
  }

  const setupId = makeSetupId(mode, setup.direction, setup.zone);

  const row = {
    setup_id: setupId,
    symbol: SETTINGS.symbol,
    mode,
    direction: setup.direction,
    zone_low: setup.zone.low,
    zone_high: setup.zone.high,
    entry: setup.plan.entry,
    stop_loss: setup.plan.sl,
    tp1: setup.plan.tp1,
    tp2: setup.plan.tp2,
    source: setup.zone.source,
    status: "ACTIVE",
    updated_at: new Date().toISOString(),
  };

  try {
    const query = new URLSearchParams({
      on_conflict: "setup_id",
    });

    await supabaseRequest(`${TABLE}?${query.toString()}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      prefer: "resolution=merge-duplicates,return=representation",
      body: JSON.stringify(row),
    });

    return {
      enabled: true,
      persisted: true,
      setupId,
      reason: null,
    };
  } catch (error) {
    return {
      enabled: true,
      persisted: false,
      reason: error.message,
    };
  }
}

async function applyExistingLock(setup, mode, config) {
  if (!supabaseConfig() || !setup.zone?.valid) return setup;

  try {
    const locks = await getActiveLocks(mode);
    const matching = locks.find((lock) => {
      if (!lockStillFresh(lock, config)) return false;
      if (lock.direction !== setup.direction) return false;

      // Match the same zone approximately to avoid locking unrelated setups.
      return (
        Math.abs(Number(lock.zone_low) - setup.zone.low) <= 0.25 &&
        Math.abs(Number(lock.zone_high) - setup.zone.high) <= 0.25
      );
    });

    if (!matching) return setup;

    const lockedZone = {
      ...setup.zone,
      low: Number(matching.zone_low),
      high: Number(matching.zone_high),
      entry: Number(matching.entry),
      pivot: Number(matching.entry),
      source: matching.source || setup.zone.source,
      locked: true,
      setupId: matching.setup_id,
    };

    const lockedPlan = {
      ...setup.plan,
      entry: Number(matching.entry),
      sl: Number(matching.stop_loss),
      tp1: matching.tp1 == null ? null : Number(matching.tp1),
      tp2: matching.tp2 == null ? null : Number(matching.tp2),
      risk: round(Math.abs(Number(matching.entry) - Number(matching.stop_loss))),
    };

    return {
      ...setup,
      zone: lockedZone,
      plan: lockedPlan,
      signalLock: {
        enabled: true,
        persisted: true,
        reused: true,
        setupId: matching.setup_id,
        reason: null,
      },
    };
  } catch (error) {
    return {
      ...setup,
      signalLock: {
        enabled: true,
        persisted: false,
        reused: false,
        reason: error.message,
      },
    };
  }
}

/* =========================================================
   SETUP BUILDER
========================================================= */

function buildSetup({
  mode,
  cmp,
  direction,
  trendH1,
  entryCandles,
  targetCandles,
  secondaryCandles,
  entryStructure,
  config,
}) {
  const zone = buildEarlyZone(entryCandles, direction, cmp, mode);

  if (!zone.valid) {
    return {
      mode,
      direction,
      status: "WAIT",
      score: 0,
      zone,
      plan: {
        valid: false,
        entry: null,
        sl: null,
        tp1: null,
        tp2: null,
        risk: null,
        reason: zone.reason,
      },
      reason: zone.reason,
    };
  }

  const stop = buildStructuralStop(
    direction,
    zone,
    entryCandles,
    config.maxRiskDistance
  );

  const plan = buildTradePlan(
    direction,
    zone,
    stop,
    targetCandles,
    secondaryCandles,
    config
  );

  const entryTrend = entryStructure.direction;
  const score = calculateScore(
    direction,
    trendH1,
    entryTrend,
    zone,
    entryStructure
  );

  const status =
    zone.valid &&
    plan.valid &&
    score >= config.minimumScore
      ? "READY"
      : "WAIT";

  let reason = null;

  if (!plan.valid) reason = plan.reason;
  else if (score < config.minimumScore) {
    reason = `Score ${score} belum mencapai minimum ${config.minimumScore}.`;
  } else if (zone.status === "WATCH") {
    reason = "Zon dikenal pasti; tunggu harga menghampiri zon.";
  }

  return {
    mode,
    direction,
    status,
    score,
    zone,
    plan,
    reason,
    trend: {
      h1: trendH1,
      entry: entryTrend,
    },
    signalLock: {
      enabled: Boolean(supabaseConfig()),
      persisted: false,
      reason: null,
    },
  };
}

/* =========================================================
   API HANDLER
========================================================= */

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, {
      success: false,
      error: "Method tidak dibenarkan. Gunakan GET atau POST.",
    });
  }

  try {
    const [d1, h1, m15, m5] = await Promise.all([
      fetchCandles(TIMEFRAMES.D1),
      fetchCandles(TIMEFRAMES.H1),
      fetchCandles(TIMEFRAMES.M15),
      fetchCandles(TIMEFRAMES.M5),
    ]);

    const cmp = round(m5[m5.length - 1].close);
    const d1Structure = buildStructure(d1);
    const h1Structure = buildStructure(h1);
    const m15Structure = buildStructure(m15);
    const m5Structure = buildStructure(m5);

    const h1Trend = h1Structure.direction;
    const d1Trend = d1Structure.direction;

    // H1 is the preferred direction filter. D1 is the fallback.
    const preferredTrend =
      h1Trend !== "NEUTRAL" ? h1Trend : d1Trend;

    // If higher-timeframe direction is neutral, do not force a BUY or SELL.
    const direction =
      preferredTrend === "BULLISH"
        ? "BUY"
        : preferredTrend === "BEARISH"
          ? "SELL"
          : null;

    let scalping;
    let intraday;

    if (!direction) {
      const neutralSetup = (mode) => ({
        mode,
        direction: "WAIT",
        status: "WAIT",
        score: 0,
        zone: {
          valid: false,
          low: null,
          high: null,
          entry: null,
          pivot: null,
          source: null,
          status: "WATCH",
          distance: null,
        },
        plan: {
          valid: false,
          entry: null,
          sl: null,
          tp1: null,
          tp2: null,
          risk: null,
          reason: "Arah D1 dan H1 belum jelas.",
        },
        reason: "Arah D1 dan H1 belum jelas; elakkan memaksa signal.",
        signalLock: {
          enabled: Boolean(supabaseConfig()),
          persisted: false,
          reason: "Tiada setup arah yang layak.",
        },
      });

      scalping = neutralSetup("scalping");
      intraday = neutralSetup("intraday");
    } else {
      scalping = buildSetup({
        mode: "scalping",
        cmp,
        direction,
        trendH1: h1Trend,
        entryCandles: m5,
        targetCandles: m5,
        secondaryCandles: m15,
        entryStructure: m5Structure,
        config: SETTINGS.scalping,
      });

      intraday = buildSetup({
        mode: "intraday",
        cmp,
        direction,
        trendH1: h1Trend,
        entryCandles: m15,
        targetCandles: m15,
        secondaryCandles: h1,
        entryStructure: m15Structure,
        config: SETTINGS.intraday,
      });

      // Reuse a previously saved matching setup before attempting to save.
      scalping = await applyExistingLock(
        scalping,
        "scalping",
        SETTINGS.scalping
      );

      intraday = await applyExistingLock(
        intraday,
        "intraday",
        SETTINGS.intraday
      );

      if (!scalping.signalLock?.reused) {
        scalping.signalLock = await saveLock(scalping, "scalping");
      }

      if (!intraday.signalLock?.reused) {
        intraday.signalLock = await saveLock(intraday, "intraday");
      }
    }

    // Prefer READY intraday, then READY scalping, otherwise WAIT.
    const mainSetup =
      intraday.status === "READY"
        ? intraday
        : scalping.status === "READY"
          ? scalping
          : null;

    const mainSignal = mainSetup
      ? mainSetup.direction
      : "WAIT";

    const mainPlan = mainSetup?.plan || {
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      risk: null,
      valid: false,
      reason:
        intraday.reason ||
        scalping.reason ||
        "Belum ada setup yang memenuhi syarat.",
    };

    const mainZone = mainSetup?.zone || null;

    return json(res, 200, {
      success: true,
      symbol: SETTINGS.symbol,
      timestamp: new Date().toISOString(),
      cmp,

      signal: mainSignal,
      direction: {
        D1: d1Trend,
        H1: h1Trend,
        M15: m15Structure.direction,
        M5: m5Structure.direction,
      },

      entry: mainPlan.entry,
      sl: mainPlan.sl,
      tp1: mainPlan.tp1,
      tp2: mainPlan.tp2,
      risk: mainPlan.risk,
      maxAllowedRisk: mainSetup
        ? SETTINGS[mainSetup.mode].maxRiskDistance
        : null,

      punca: mainZone
        ? {
            price: mainZone.pivot,
            source: mainZone.source,
          }
        : {
            price: null,
            source: null,
          },

      zone: mainZone,
      waitReason: mainSetup
        ? null
        : mainPlan.reason,

      scores: {
        buy: direction === "BUY"
          ? Math.max(scalping.score || 0, intraday.score || 0)
          : 0,
        sell: direction === "SELL"
          ? Math.max(scalping.score || 0, intraday.score || 0)
          : 0,
      },

      scalping,
      intraday,

      marketStructure: {
        D1: d1Structure,
        H1: h1Structure,
        M15: m15Structure,
        M5: m5Structure,
      },

      signalLock: {
        enabled: Boolean(supabaseConfig()),
        scalping: scalping.signalLock,
        intraday: intraday.signalLock,
      },

      settings: {
        zoneThickness: SETTINGS.zoneThickness,
        minimumScore: {
          scalping: SETTINGS.scalping.minimumScore,
          intraday: SETTINGS.intraday.minimumScore,
        },
        maxRiskDistance: {
          scalping: SETTINGS.scalping.maxRiskDistance,
          intraday: SETTINGS.intraday.maxRiskDistance,
        },
        maxTargetDistance: {
          scalping: SETTINGS.scalping.maxTargetDistance,
          intraday: SETTINGS.intraday.maxTargetDistance,
        },
        timeframes: TIMEFRAMES,
      },

      data: {
        candleCount: {
          D1: d1.length,
          H1: h1.length,
          M15: m15.length,
          M5: m5.length,
        },
        latestCandle: {
          D1: d1[d1.length - 1].time,
          H1: h1[h1.length - 1].time,
          M15: m15[m15.length - 1].time,
          M5: m5[m5.length - 1].time,
        },
      },
    });
  } catch (error) {
    console.error("[SINNCI AI analyze]", error);

    return json(res, 500, {
      success: false,
      error: "Analisis XAU/USD gagal.",
      message: error.message || "Ralat tidak diketahui.",
      timestamp: new Date().toISOString(),
    });
  }
};
