/**
 * ============================================================================
 * SINNCI MARKET ENGINE PRO (PRO-3.0)
 * Asset: XAUUSD (Gold)
 * File: api/analyze.js
 * Deployment: Vercel Serverless Function
 * ============================================================================
 */

import crypto from "crypto";

const SYMBOL = "XAU/USD";
const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com/time_series";

// Scalping Risk / Reward Constants (Gold Points: 100 points = $1.00)
const SCALP_SL_POINTS = 500;   // 50 pips / $5.00
const SCALP_TP1_POINTS = 600;  // 60 pips / $6.00
const SCALP_TP2_POINTS = 1200; // 120 pips / $12.00

// Intraday Targets
const INTRA_SL_POINTS = 600;
const INTRA_TP1_POINTS = 1500;
const INTRA_TP2_POINTS = 2300;

// Zone sizing boundaries (points)
const ZONE_WIDTH_MIN = 20.0;
const ZONE_WIDTH_MAX = 35.0;

// Thresholds
const SCALP_SIGNAL_SCORE = 65;
const INTRA_SIGNAL_SCORE = 90;

// ==========================================
// 1. HELPERS & MATH
// ==========================================
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 25.0;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!prev) continue;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

// Deterministic Zone Lock Hash
function generateSetupId(tf, direction, setupType, anchorPrice) {
  const roundedAnchor = Math.round(anchorPrice * 2) / 2;
  const rawKey = `${tf}_${direction}_${setupType}_${roundedAnchor}`;
  return crypto.createHash("md5").update(rawKey).digest("hex").slice(0, 10);
}

// ==========================================
// 2. MARKET DATA FETCHER (Twelve Data)
// ==========================================
async function fetchCandles(interval, outputsize, apiKey) {
  const url = `${TWELVE_DATA_BASE_URL}?symbol=${encodeURIComponent(
    SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data HTTP error: ${res.status} (${res.statusText})`);
  }

  const data = await res.json();
  if (data.status === "error" || data.code || !Array.isArray(data.values)) {
    throw new Error(data.message || `No candle data for interval ${interval}`);
  }

  return data.values
    .map((c) => ({
      datetime: c.datetime,
      open: safeNum(c.open),
      high: safeNum(c.high),
      low: safeNum(c.low),
      close: safeNum(c.close),
    }))
    .reverse();
}

// ==========================================
// 3. MARKET STRUCTURE ENGINE (HH / HL / LH / LL)
// ==========================================
function getSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= c.high) isHigh = false;
      if (candles[i - j].low <= c.low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > c.high) isHigh = false;
      if (candles[i + j].low < c.low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: c.high, datetime: c.datetime });
    if (isLow) lows.push({ index: i, price: c.low, datetime: c.datetime });
  }

  return { highs, lows };
}

function analyzeStructure(candles) {
  const { highs, lows } = getSwings(candles, 2, 2);

  if (highs.length < 2 || lows.length < 2) {
    const lastClose = candles[candles.length - 1].close;
    return {
      direction: "NEUTRAL",
      structure: "RANGE",
      highs,
      lows,
      keySupport: lastClose - 20,
      keyResistance: lastClose + 20,
      isSideway: true,
      lastHigh: highs.length ? highs[highs.length - 1].price : lastClose + 20,
      lastLow: lows.length ? lows[lows.length - 1].price : lastClose - 20,
    };
  }

  const h1 = highs[highs.length - 1];
  const h2 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1];
  const l2 = lows[lows.length - 2];

  let direction = "NEUTRAL";
  let structPattern = "RANGE";

  if (h1.price > h2.price && l1.price > l2.price) {
    direction = "BULLISH";
    structPattern = "HH_HL";
  } else if (h1.price < h2.price && l1.price < l2.price) {
    direction = "BEARISH";
    structPattern = "LH_LL";
  } else {
    direction = "RANGING";
    structPattern = "RANGE";
  }

  const recentHighs = highs.slice(-3).map((s) => s.price);
  const recentLows = lows.slice(-3).map((s) => s.price);
  const keyResistance = Math.max(...recentHighs);
  const keySupport = Math.min(...recentLows);
  const isSideway = structPattern === "RANGE" || (keyResistance - keySupport) <= 85.0;

  return {
    direction: direction === "RANGING" ? "NEUTRAL" : direction,
    structure: structPattern,
    highs,
    lows,
    h1,
    h2,
    l1,
    l2,
    keyResistance,
    keySupport,
    isSideway,
    lastHigh: h1.price,
    lastLow: l1.price,
  };
}

// ==========================================
// 4. ZONE ENGINE & M5 REFINEMENT
// ==========================================
function constructZone(anchor, type, atrVal = 25.0) {
  const width = clamp(atrVal * 0.45, ZONE_WIDTH_MIN, ZONE_WIDTH_MAX);
  let low, high;

  if (type === "BUY") {
    high = anchor;
    low = anchor - width;
  } else {
    low = anchor;
    high = anchor + width;
  }

  return {
    type,
    low: round(low, 2),
    high: round(high, 2),
    anchor: round(anchor, 2),
    width: round(high - low, 2),
  };
}

function refineZoneWithM5(zone, m5Swings) {
  if (!zone) return null;

  if (zone.type === "BUY") {
    const validLows = m5Swings.lows.filter(
      (s) => s.price >= zone.low - 5 && s.price <= zone.high + 5
    );
    if (validLows.length > 0) {
      const best = validLows[validLows.length - 1].price;
      const refLow = Math.max(zone.low, best - 12);
      const refHigh = Math.min(zone.high, best + 12);
      if (refHigh - refLow >= 18) {
        return {
          type: "BUY",
          low: round(refLow, 2),
          high: round(refHigh, 2),
          anchor: round(best, 2),
          width: round(refHigh - refLow, 2),
        };
      }
    }
  } else if (zone.type === "SELL") {
    const validHighs = m5Swings.highs.filter(
      (s) => s.price >= zone.low - 5 && s.price <= zone.high + 5
    );
    if (validHighs.length > 0) {
      const best = validHighs[validHighs.length - 1].price;
      const refLow = Math.max(zone.low, best - 12);
      const refHigh = Math.min(zone.high, best + 12);
      if (refHigh - refLow >= 18) {
        return {
          type: "SELL",
          low: round(refLow, 2),
          high: round(refHigh, 2),
          anchor: round(best, 2),
          width: round(refHigh - refLow, 2),
        };
      }
    }
  }

  return zone;
}

function evaluateStatus(cmp, zone, invalidationLevel) {
  if (!zone) return "WAIT";

  if (zone.type === "BUY") {
    if (cmp < invalidationLevel) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "READY";
    if (cmp > zone.high && cmp <= zone.high + 15) return "APPROACHING";
    if (cmp > zone.high + 15 && cmp <= zone.high + 60) return "WAIT_RETEST";
    return "WATCH";
  } else {
    if (cmp > invalidationLevel) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "READY";
    if (cmp < zone.low && cmp >= zone.low - 15) return "APPROACHING";
    if (cmp < zone.low - 15 && cmp >= zone.low - 60) return "WAIT_RETEST";
    return "WATCH";
  }
}

// ==========================================
// 5. SCALPING ENGINE (H1 -> M15 -> M5)
// ==========================================
function buildScalpSide(side, cmp, h1Struct, m15Struct, m5Swings, m15ATR) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

  // 1. Sideway Market Logic (Range Support / Resistance)
  if (m15Struct.isSideway) {
    if (isBuy) {
      anchor = m15Struct.keySupport;
      setupType = "RANGE_SUPPORT";
      reason = "M15 Range consolidation support holding; buy dip setup.";
    } else {
      anchor = m15Struct.keyResistance;
      setupType = "RANGE_RESISTANCE";
      reason = "M15 Range consolidation resistance holding; sell rejection setup.";
    }
  }
  // 2. Trend Continuation & Pullback / Retest
  else if (isBuy) {
    if (m15Struct.h2 && cmp >= m15Struct.h2.price) {
      anchor = m15Struct.h2.price;
      setupType = "BREAKOUT_PULLBACK";
      reason = "Bullish structure breakout; pullback to previous resistance (RBS).";
    } else {
      anchor = m15Struct.l1 ? m15Struct.l1.price : m15Struct.keySupport;
      setupType = "TREND_CONTINUATION";
      reason = "Higher-High / Higher-Low progression; continuing bullish trend.";
    }
  } else {
    if (m15Struct.l2 && cmp <= m15Struct.l2.price) {
      anchor = m15Struct.l2.price;
      setupType = "BREAKOUT_PULLBACK";
      reason = "Bearish structure breakdown; pullback to previous support (SBR).";
    } else {
      anchor = m15Struct.h1 ? m15Struct.h1.price : m15Struct.keyResistance;
      setupType = "TREND_CONTINUATION";
      reason = "Lower-High / Lower-Low progression; continuing bearish trend.";
    }
  }

  // Construct zone and refine with M5
  const baseZone = constructZone(anchor, side, m15ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  const invalidationLevel = isBuy ? refinedZone.low - 35 : refinedZone.high + 35;
  const status = evaluateStatus(cmp, refinedZone, invalidationLevel);

  // Targets (TP1: 600 pts / $6.00, TP2: 1200 pts / $12.00)
  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);
  const sl = isBuy
    ? round(refinedZone.low - (SCALP_SL_POINTS / 100), 2)
    : round(refinedZone.high + (SCALP_SL_POINTS / 100), 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (SCALP_TP1_POINTS / 100), 2)
    : round(refinedZone.low - (SCALP_TP1_POINTS / 100), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (SCALP_TP2_POINTS / 100), 2)
    : round(refinedZone.low - (SCALP_TP2_POINTS / 100), 2);

  // Scoring
  let score = 65;
  const targetDir = isBuy ? "BULLISH" : "BEARISH";
  if (h1Struct.direction === targetDir) score += 15;
  if (m15Struct.direction === targetDir) score += 10;
  if (status === "READY" || status === "APPROACHING") score += 8;
  score = clamp(score, 45, 96);

  const setupId = generateSetupId("SCALP", side, setupType, refinedZone.anchor);

  return {
    setupId,
    side,
    direction: side,
    status: score >= SCALP_SIGNAL_SCORE ? "SIGNAL" : status,
    score,
    entry,
    sl,
    tp1,
    tp2,
    zone: {
      type: side,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
    },
    setup: setupType,
    reason,
    locked: true,
  };
}

// ==========================================
// 6. INTRADAY ENGINE (H4 -> H1 -> M15 -> M5)
// ==========================================
function buildIntradaySide(side, cmp, h4Struct, h1Struct, m15Struct, m5Swings) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

  // Fibonacci Retracement (0.382 / 0.500 ONLY)
  if (h1Struct.h1 && h1Struct.l1 && h1Struct.h1.price > h1Struct.l1.price) {
    const range = h1Struct.h1.price - h1Struct.l1.price;
    if (isBuy) {
      anchor = h1Struct.h1.price - (range * 0.5);
      setupType = "PULLBACK_FIB_50";
      reason = "H4/H1 structural alignment with 50.0% Fibonacci pullback level.";
    } else {
      anchor = h1Struct.l1.price + (range * 0.382);
      setupType = "PULLBACK_FIB_382";
      reason = "H4/H1 structural alignment with 38.2% Fibonacci pullback rejection.";
    }
  } else {
    anchor = isBuy ? h1Struct.keySupport : h1Struct.keyResistance;
    setupType = isBuy ? "PULLBACK_SUPPORT" : "PULLBACK_RESISTANCE";
    reason = isBuy ? "H4/H1 structural support demand." : "H4/H1 major resistance rejection.";
  }

  const baseZone = constructZone(anchor, side, 30.0);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  const invalidationLevel = isBuy ? refinedZone.low - 45 : refinedZone.high + 45;
  const status = evaluateStatus(cmp, refinedZone, invalidationLevel);

  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);
  const sl = isBuy
    ? round(refinedZone.low - (INTRA_SL_POINTS / 100), 2)
    : round(refinedZone.high + (INTRA_SL_POINTS / 100), 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (INTRA_TP1_POINTS / 100), 2)
    : round(refinedZone.low - (INTRA_TP1_POINTS / 100), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (INTRA_TP2_POINTS / 100), 2)
    : round(refinedZone.low - (INTRA_TP2_POINTS / 100), 2);

  let score = 70;
  const targetDir = isBuy ? "BULLISH" : "BEARISH";
  if (h4Struct.direction === targetDir) score += 15;
  if (h1Struct.direction === targetDir) score += 10;
  score = clamp(score, 50, 95);

  const setupId = generateSetupId("INTRA", side, setupType, refinedZone.anchor);

  return {
    setupId,
    side,
    direction: side,
    status: score >= INTRA_SIGNAL_SCORE ? "SIGNAL" : status,
    score,
    entry,
    sl,
    tp1,
    tp2,
    zone: {
      type: side,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
    },
    setup: setupType,
    reason,
    locked: true,
  };
}

// ==========================================
// 7. MAIN HANDLER (Vercel Serverless Function)
// ==========================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        status: "error",
        error: "TWELVE_DATA_API_KEY is not configured in Vercel environment variables.",
      });
    }

    // Parallel fetch for H4, H1, M15, M5
    const [h4Candles, h1Candles, m15Candles, m5Candles] = await Promise.all([
      fetchCandles("4h", 40, apiKey),
      fetchCandles("1h", 45, apiKey),
      fetchCandles("15min", 50, apiKey),
      fetchCandles("5min", 50, apiKey),
    ]);

    if (!m5Candles.length || !m15Candles.length || !h1Candles.length || !h4Candles.length) {
      return res.status(502).json({
        status: "error",
        error: "Insufficient candle history returned from Twelve Data.",
      });
    }

    const currentPrice = round(m5Candles[m5Candles.length - 1].close, 2);

    // Analyze Structures
    const h4Struct = analyzeStructure(h4Candles);
    const h1Struct = analyzeStructure(h1Candles);
    const m15Struct = analyzeStructure(m15Candles);
    const m5Swings = getSwings(m5Candles, 2, 2);
    const m15ATR = calculateATR(m15Candles, 14);

    // Build Scalping & Intraday Sides
    const scalpBuy = buildScalpSide("BUY", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR);
    const scalpSell = buildScalpSide("SELL", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR);
    const intraBuy = buildIntradaySide("BUY", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings);
    const intraSell = buildIntradaySide("SELL", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings);

    // Determine Dominant Side
    const primaryScalp = scalpBuy.score >= scalpSell.score ? scalpBuy : scalpSell;
    const primaryIntra = intraBuy.score >= intraSell.score ? intraBuy : intraSell;
    const bestSetup = primaryScalp.score >= primaryIntra.score ? primaryScalp : primaryIntra;

    // Punca S/R Level identification for UI
    const puncaPrice = bestSetup.zone.anchor;
    const puncaSource = `${m15Struct.isSideway ? "M15 Range" : "M15 S/R"} (${bestSetup.setup})`;

    // Risk calculation
    const calculatedRisk = round(Math.abs(bestSetup.entry - bestSetup.sl), 2);
    const maxAllowedRisk = round(m15ATR * 1.5, 2);

    // Structured JSON (Supports new engine format & existing HTML properties)
    const responsePayload = {
      status: "success",
      engine: {
        name: "SINNCI MARKET ENGINE PRO",
        version: "PRO-3.0",
        mode: "ACTIVE SCALPING / SELECTIVE INTRADAY",
      },
      market: {
        symbol: "XAUUSD",
        price: currentPrice,
        atr: round(m15ATR, 2),
      },
      direction: {
        H4: h4Struct.direction,
        H1: h1Struct.direction,
        M15: m15Struct.direction,
        M5: m5Swings.highs.length ? "BULLISH" : "NEUTRAL",
      },
      structure: {
        H4: h4Struct.structure,
        H1: h1Struct.structure,
        M15: m15Struct.structure,
      },
      // Full Scalping Object with buy/sell branches for HTML compatibility
      scalping: {
        signal: primaryScalp.side,
        direction: h1Struct.direction,
        structure: m15Struct.structure,
        status: primaryScalp.status,
        score: primaryScalp.score,
        zone: primaryScalp.zone,
        entry: primaryScalp.entry,
        sl: primaryScalp.sl,
        tp1: primaryScalp.tp1,
        tp2: primaryScalp.tp2,
        reason: primaryScalp.reason,
        locked: true,
        buy: scalpBuy,
        sell: scalpSell,
      },
      // Full Intraday Object with buy/sell branches for HTML compatibility
      intraday: {
        signal: primaryIntra.side,
        direction: h4Struct.direction,
        status: primaryIntra.status,
        score: primaryIntra.score,
        zone: primaryIntra.zone,
        entry: primaryIntra.entry,
        sl: primaryIntra.sl,
        tp1: primaryIntra.tp1,
        tp2: primaryIntra.tp2,
        reason: primaryIntra.reason,
        locked: true,
        buy: intraBuy,
        sell: intraSell,
      },
      // Legacy UI direct bindings
      signal: bestSetup.status === "SIGNAL" ? bestSetup.side : "WAIT",
      status: bestSetup.status,
      score: bestSetup.score,
      scores: {
        buy: Math.max(scalpBuy.score, intraBuy.score),
        sell: Math.max(scalpSell.score, intraSell.score),
      },
      entry: bestSetup.entry,
      sl: bestSetup.sl,
      tp1: bestSetup.tp1,
      tp2: bestSetup.tp2,
      zone: bestSetup.zone,
      punca: {
        price: puncaPrice,
        source: puncaSource,
      },
      risk: calculatedRisk,
      maxAllowedRisk: maxAllowedRisk,
      reason: bestSetup.reason,
      waitReason: bestSetup.status === "SIGNAL" ? null : "Approaching structure zone; waiting for reaction.",
    };

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error("SINNCI ENGINE ERROR:", error);
    return res.status(500).json({
      status: "error",
      error: error.message || "Market analysis failed.",
    });
  }
}
