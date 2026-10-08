/**
 * ============================================================================
 * SINNCI MARKET ENGINE PRO (api/analyze.js)
 * Asset: XAUUSD (Gold)
 * Deployment: Vercel Serverless Function
 *
 * RECTIFICATIONS APPLIED:
 * 1. Resolved duplicate "status" conflict: API root status is always "success",
 *    while signal state resides in "signalStatus" (with backward compatibility).
 * 2. Closed-candle confirmation: M5 break and M1 confirmation exclusively evaluate
 *    completed candles, excluding the live forming candle (candlestick index [length - 2]).
 * 3. Strict Setup Selection: Setup qualification requires structure, zone validity,
 *    threshold scores (Scalping >= 65, Intraday >= 75), and strict confirmation flow.
 * 4. Anti-Chase Entry Bounds: Limits maximum execution distance strictly to zone thickness.
 * 5. Ephemeral Zone Lock: Explicitly notes in-memory stateless execution without false DB claims.
 * 6. Objective Scoring: Score reflects strictly verified structural conditions.
 * ============================================================================
 */

import crypto from "crypto";

const SYMBOL = "XAU/USD";
const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com/time_series";

// =========================================================
// 1. UNIT & ZONE SPECIFICATIONS
// 10 POINTS = 1 PIP ($0.01 = 1 point, $0.10 = 1 pip, $1.00 = 100 points)
// =========================================================
const POINTS_PER_PIP = 10;
const POINT_VALUE = 0.01;

// UNIFIED ZONE RANGE: 200 - 350 points = 20 - 35 pips ($2.00 - $3.50)
const UNIFIED_ZONE_MIN_POINTS = 200;
const UNIFIED_ZONE_MAX_POINTS = 350;

// UNIFIED STOP LOSS: 300 points = 30 pips ($3.00)
const UNIFIED_SL_POINTS = 300;

// Target Multipliers
const SCALP_TP1_POINTS = 600;  // 60 pips / $6.00
const SCALP_TP2_POINTS = 1200; // 120 pips / $12.00
const INTRA_TP1_POINTS = 1500; // 150 pips / $15.00
const INTRA_TP2_POINTS = 2300; // 230 pips / $23.00

// Score Thresholds
const SCALP_MIN_SCORE = 65;
const INTRA_MIN_SCORE = 75;

// =========================================================
// 2. HELPERS & UTILITIES
// =========================================================
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
  if (!candles || candles.length < period + 2) return 3.0;
  let trSum = 0;
  // Calculate ATR based on closed candles up to candles.length - 2
  const endIdx = candles.length - 1;
  const startIdx = endIdx - period;
  for (let i = startIdx; i < endIdx; i++) {
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

function generateSetupId(tf, direction, setupType, anchorPrice) {
  const roundedAnchor = Math.round(anchorPrice * 2) / 2;
  const rawKey = `${tf}_${direction}_${setupType}_${roundedAnchor}`;
  return crypto.createHash("md5").update(rawKey).digest("hex").slice(0, 10);
}

// =========================================================
// 3. CANDLE FETCHER
// =========================================================
async function fetchCandles(interval, outputsize, apiKey) {
  const url = `${TWELVE_DATA_BASE_URL}?symbol=${encodeURIComponent(
    SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw {
      code: "NETWORK_ERROR",
      message: `Failed to connect to Twelve Data for ${interval}: ${err.message}`,
      source: "Twelve Data Network"
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw {
      code: "PARSE_ERROR",
      message: `Failed to parse JSON response for ${interval}.`,
      source: "Twelve Data Parser"
    };
  }

  if (!res.ok || data.status === "error" || data.code || !Array.isArray(data.values)) {
    throw {
      code: data.code || res.status || "API_ERROR",
      message: data.message || `No candle data returned for interval ${interval}`,
      source: "Twelve Data API"
    };
  }

  return data.values
    .map((c) => ({
      datetime: c.datetime,
      open: safeNum(c.open),
      high: safeNum(c.high),
      low: safeNum(c.low),
      close: safeNum(c.close)
    }))
    .reverse();
}

// =========================================================
// 4. MARKET STRUCTURE ENGINE (HH / HL / LH / LL)
// =========================================================
function getSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  // Exclude current forming candle (last index) from swing pivot generation
  const closedCandles = candles.slice(0, -1);

  for (let i = left; i < closedCandles.length - right; i++) {
    const c = closedCandles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {
      if (closedCandles[i - j].high >= c.high) isHigh = false;
      if (closedCandles[i - j].low <= c.low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (closedCandles[i + j].high > c.high) isHigh = false;
      if (closedCandles[i + j].low < c.low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: c.high, datetime: c.datetime });
    if (isLow) lows.push({ index: i, price: c.low, datetime: c.datetime });
  }

  return { highs, lows };
}

function analyzeStructure(candles) {
  if (!candles || candles.length < 8) {
    return {
      direction: "NEUTRAL",
      structure: "RANGE",
      highs: [],
      lows: [],
      keySupport: 0,
      keyResistance: 0,
      isSideway: true,
      lastHigh: 0,
      lastLow: 0
    };
  }

  const { highs, lows } = getSwings(candles, 2, 2);
  const lastClosed = candles[candles.length - 2];

  if (highs.length < 2 || lows.length < 2) {
    const highVal = highs.length ? highs[highs.length - 1].price : lastClosed.high;
    const lowVal = lows.length ? lows[lows.length - 1].price : lastClosed.low;
    return {
      direction: "NEUTRAL",
      structure: "RANGE",
      highs,
      lows,
      keySupport: lowVal,
      keyResistance: highVal,
      isSideway: true,
      lastHigh: highVal,
      lastLow: lowVal
    };
  }

  const h1 = highs[highs.length - 1];
  const h2 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1];
  const l2 = lows[lows.length - 2];

  let direction = "NEUTRAL";
  let structure = "RANGE";

  if (h1.price > h2.price && l1.price > l2.price) {
    direction = "BULLISH";
    structure = "HH_HL";
  } else if (h1.price < h2.price && l1.price < l2.price) {
    direction = "BEARISH";
    structure = "LH_LL";
  } else {
    direction = "NEUTRAL";
    structure = "RANGE";
  }

  const recentHighs = highs.slice(-3).map((s) => s.price);
  const recentLows = lows.slice(-3).map((s) => s.price);
  const keyResistance = Math.max(...recentHighs);
  const keySupport = Math.min(...recentLows);
  const isSideway = structure === "RANGE" || (keyResistance - keySupport) <= 8.0;

  return {
    direction,
    structure,
    highs,
    lows,
    h1: h1.price,
    h2: h2.price,
    l1: l1.price,
    l2: l2.price,
    keyResistance,
    keySupport,
    isSideway,
    lastHigh: h1.price,
    lastLow: l1.price
  };
}

// =========================================================
// 5. ZONE BUILDER ENGINE (200 - 350 POINTS)
// =========================================================
function buildStandardZone(anchor, type, atrPrice = 3.0) {
  const minWidth = UNIFIED_ZONE_MIN_POINTS * POINT_VALUE; // $2.00
  const maxWidth = UNIFIED_ZONE_MAX_POINTS * POINT_VALUE; // $3.50
  const adaptiveWidth = clamp(atrPrice * 0.85, minWidth, maxWidth);

  let low, high;
  if (type === "BUY") {
    high = anchor;
    low = anchor - adaptiveWidth;
  } else {
    low = anchor;
    high = anchor + adaptiveWidth;
  }

  const pointsWidth = round((high - low) / POINT_VALUE, 0);

  return {
    type,
    low: round(low, 2),
    high: round(high, 2),
    anchor: round(anchor, 2),
    width: round(high - low, 2),
    points: pointsWidth,
    pips: round(pointsWidth / POINTS_PER_PIP, 1),
    locked: true,
    lockType: "EPHEMERAL_PER_REQUEST"
  };
}

function refineZoneWithM5(zone, m5Swings) {
  if (!zone) return null;

  const minAllowed = UNIFIED_ZONE_MIN_POINTS * POINT_VALUE;
  const maxAllowed = UNIFIED_ZONE_MAX_POINTS * POINT_VALUE;

  if (zone.type === "BUY") {
    const validLows = m5Swings.lows.filter(
      (s) => s.price >= zone.low - 0.5 && s.price <= zone.high + 0.5
    );
    if (validLows.length > 0) {
      const best = validLows[validLows.length - 1].price;
      const refLow = Math.max(zone.low, best - 1.2);
      const refHigh = Math.min(zone.high, best + 1.3);
      const span = refHigh - refLow;

      if (span >= minAllowed && span <= maxAllowed) {
        const points = round(span / POINT_VALUE, 0);
        return {
          type: "BUY",
          low: round(refLow, 2),
          high: round(refHigh, 2),
          anchor: round(best, 2),
          width: round(span, 2),
          points,
          pips: round(points / POINTS_PER_PIP, 1),
          locked: true,
          lockType: "EPHEMERAL_PER_REQUEST"
        };
      }
    }
  } else if (zone.type === "SELL") {
    const validHighs = m5Swings.highs.filter(
      (s) => s.price >= zone.low - 0.5 && s.price <= zone.high + 0.5
    );
    if (validHighs.length > 0) {
      const best = validHighs[validHighs.length - 1].price;
      const refLow = Math.max(zone.low, best - 1.3);
      const refHigh = Math.min(zone.high, best + 1.2);
      const span = refHigh - refLow;

      if (span >= minAllowed && span <= maxAllowed) {
        const points = round(span / POINT_VALUE, 0);
        return {
          type: "SELL",
          low: round(refLow, 2),
          high: round(refHigh, 2),
          anchor: round(best, 2),
          width: round(span, 2),
          points,
          pips: round(points / POINTS_PER_PIP, 1),
          locked: true,
          lockType: "EPHEMERAL_PER_REQUEST"
        };
      }
    }
  }

  return zone;
}

function evaluateZoneStatus(cmp, zone, invalidationLevel) {
  if (!zone) return "INVALID";

  if (zone.type === "BUY") {
    if (cmp < invalidationLevel) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "IN_ZONE";
    if (cmp > zone.high && cmp <= zone.high + 1.5) return "APPROACHING";
    return "WATCH";
  } else {
    if (cmp > invalidationLevel) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "IN_ZONE";
    if (cmp < zone.low && cmp >= zone.low - 1.5) return "APPROACHING";
    return "WATCH";
  }
}

// =========================================================
// 6. CLOSED-CANDLE TRIGGER & CONFIRMATION
// =========================================================
function checkM5BreakClosed(m5Candles, direction) {
  // Requires at least 3 candles: current live (length-1), last closed (length-2), prior closed (length-3)
  if (!m5Candles || m5Candles.length < 3) {
    return { hasBroken: false, details: "INSUFFICIENT_M5_CLOSED_DATA" };
  }

  const lastClosed = m5Candles[m5Candles.length - 2];
  const priorClosed = m5Candles[m5Candles.length - 3];

  let hasBroken = false;
  let details = "WAITING_M5_CLOSED_BREAK";

  if (direction === "BUY") {
    const brokeHigh = lastClosed.close > priorClosed.high;
    const strongBullishClose = lastClosed.close > lastClosed.open &&
      (lastClosed.close - lastClosed.open) >= (priorClosed.high - priorClosed.low) * 0.35;
    const rejectionWick = lastClosed.low < priorClosed.low && lastClosed.close > priorClosed.close;

    if (brokeHigh || strongBullishClose || rejectionWick) {
      hasBroken = true;
      details = "CMP BREAK CONFIRMED";
    }
  } else if (direction === "SELL") {
    const brokeLow = lastClosed.close < priorClosed.low;
    const strongBearishClose = lastClosed.close < lastClosed.open &&
      (lastClosed.open - lastClosed.close) >= (priorClosed.high - priorClosed.low) * 0.35;
    const rejectionWick = lastClosed.high > priorClosed.high && lastClosed.close < priorClosed.close;

    if (brokeLow || strongBearishClose || rejectionWick) {
      hasBroken = true;
      details = "CMP BREAK CONFIRMED";
    }
  }

  return { hasBroken, details };
}

function checkM1ConfirmationClosed(m1Candles, direction) {
  // Requires at least 4 candles to check closed sequence (excluding index length-1)
  if (!m1Candles || m1Candles.length < 4) {
    return { isConfirmed: false, status: "WAIT", details: "INSUFFICIENT_M1_CLOSED_DATA" };
  }

  const lastClosed = m1Candles[m1Candles.length - 2];
  const priorClosed = m1Candles[m1Candles.length - 3];

  let isConfirmed = false;
  let status = "NO CONFIRMATION";
  let details = "VALIDATING_M1_CLOSED_STRUCTURE";

  if (direction === "BUY") {
    const isBullish = lastClosed.close > lastClosed.open;
    const closedAbovePrior = lastClosed.close > priorClosed.high;
    const rejectionFollowThrough = lastClosed.low <= priorClosed.low && lastClosed.close > priorClosed.close;
    const positiveMomentum = lastClosed.close >= priorClosed.close;

    if ((closedAbovePrior || rejectionFollowThrough) && isBullish && positiveMomentum) {
      isConfirmed = true;
      status = "BULLISH CONFIRMED";
      details = "M5 BREAK + M1 CONFIRMED";
    } else {
      status = "CHECKING";
      details = "M5 BREAK -> CHECKING M1";
    }
  } else if (direction === "SELL") {
    const isBearish = lastClosed.close < lastClosed.open;
    const closedBelowPrior = lastClosed.close < priorClosed.low;
    const rejectionFollowThrough = lastClosed.high >= priorClosed.high && lastClosed.close < priorClosed.close;
    const negativeMomentum = lastClosed.close <= priorClosed.close;

    if ((closedBelowPrior || rejectionFollowThrough) && isBearish && negativeMomentum) {
      isConfirmed = true;
      status = "BEARISH CONFIRMED";
      details = "M5 BREAK + M1 CONFIRMED";
    } else {
      status = "CHECKING";
      details = "M5 BREAK -> CHECKING M1";
    }
  }

  return { isConfirmed, status, details };
}

function isWithinExecutionBounds(direction, zone, cmp) {
  // Hard limit: price must not exceed zone boundaries by more than the zone width itself
  const maxChase = Math.max(zone.width, UNIFIED_ZONE_MIN_POINTS * POINT_VALUE);

  if (direction === "BUY") {
    // If CMP is too far above zone.high, entering represents chasing
    return cmp <= round(zone.high + maxChase, 2) && cmp >= round(zone.low - 1.0, 2);
  } else {
    // If CMP is too far below zone.low, entering represents chasing
    return cmp >= round(zone.low - maxChase, 2) && cmp <= round(zone.high + 1.0, 2);
  }
}

// =========================================================
// 7. OBJECTIVE SCORING ENGINE
// =========================================================
function computeObjectiveScore({
  direction,
  higherTfTrend,
  entryTfTrend,
  isSideway,
  zoneStatus,
  m5Broken,
  m1Confirmed,
  isExecutionInRange
}) {
  let score = 30; // Base baseline score

  const targetTrend = direction === "BUY" ? "BULLISH" : "BEARISH";

  // Higher timeframe alignment: +20
  if (higherTfTrend === targetTrend) {
    score += 20;
  }

  // Intermediate setup timeframe alignment: +15
  if (entryTfTrend === targetTrend) {
    score += 15;
  }

  // Clean structure (not heavily consolidating): +10
  if (!isSideway) {
    score += 10;
  }

  // Zone proximity condition: +10
  if (zoneStatus === "IN_ZONE" || zoneStatus === "APPROACHING") {
    score += 10;
  }

  // M5 Closed Structure Break: +10
  if (m5Broken) {
    score += 10;
  }

  // M1 Closed Confirmation: +10
  if (m1Confirmed && isExecutionInRange) {
    score += 10;
  }

  return clamp(score, 0, 100);
}

// =========================================================
// 8. SCALPING ENGINE (H1 -> M15 -> M5 -> M1)
// =========================================================
function buildScalpSide(side, cmp, h1Struct, m15Struct, m5Swings, m15ATR, m5Candles, m1Candles) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

  if (m15Struct.isSideway) {
    if (isBuy) {
      anchor = m15Struct.keySupport;
      setupType = "RANGE_SUPPORT";
      reason = "M15 Range consolidation support; structural bounce setup.";
    } else {
      anchor = m15Struct.keyResistance;
      setupType = "RANGE_RESISTANCE";
      reason = "M15 Range consolidation resistance; structural rejection setup.";
    }
  } else if (isBuy) {
    if (m15Struct.h2 && cmp >= m15Struct.h2) {
      anchor = m15Struct.h2;
      setupType = "BREAKOUT_PULLBACK";
      reason = "Bullish structure breakout; pullback to structural RBS.";
    } else {
      anchor = m15Struct.l1 ? m15Struct.l1 : m15Struct.keySupport;
      setupType = "TREND_CONTINUATION";
      reason = "Higher-High / Higher-Low progression; continuing bullish structure.";
    }
  } else {
    if (m15Struct.l2 && cmp <= m15Struct.l2) {
      anchor = m15Struct.l2;
      setupType = "BREAKOUT_PULLBACK";
      reason = "Bearish structure breakdown; pullback to structural SBR.";
    } else {
      anchor = m15Struct.h1 ? m15Struct.h1 : m15Struct.keyResistance;
      setupType = "TREND_CONTINUATION";
      reason = "Lower-High / Lower-Low progression; continuing bearish structure.";
    }
  }

  const baseZone = buildStandardZone(anchor, side, m15ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  const slOffset = UNIFIED_SL_POINTS * POINT_VALUE; // $3.00
  const invalidationLevel = isBuy ? refinedZone.low - slOffset : refinedZone.high + slOffset;
  const zoneStatus = evaluateZoneStatus(cmp, refinedZone, invalidationLevel);

  // M5 Closed Break & M1 Closed Confirmation Checks
  const m5Break = checkM5BreakClosed(m5Candles, side);
  const m1Confirm = m5Break.hasBroken
    ? checkM1ConfirmationClosed(m1Candles, side)
    : { isConfirmed: false, status: "WAIT", details: "WAITING_M5_BREAK" };

  const inExecutionRange = isWithinExecutionBounds(side, refinedZone, cmp);

  // Compute non-random, verified score
  const score = computeObjectiveScore({
    direction: side,
    higherTfTrend: h1Struct.direction,
    entryTfTrend: m15Struct.direction,
    isSideway: m15Struct.isSideway,
    zoneStatus,
    m5Broken: m5Break.hasBroken,
    m1Confirmed: m1Confirm.isConfirmed,
    isExecutionInRange: inExecutionRange
  });

  let signalStatus = "WAIT";
  let confirmation = "Waiting for M5 break";

  if (zoneStatus === "INVALID") {
    signalStatus = "INVALID";
    confirmation = "STRUCTURE_INVALIDATED";
  } else if (!m5Break.hasBroken) {
    signalStatus = "WAIT";
    confirmation = "Waiting for M5 break";
  } else if (m5Break.hasBroken && !m1Confirm.isConfirmed) {
    signalStatus = "M1_CHECKING";
    confirmation = "M5 BREAK -> CHECKING M1";
  } else if (m5Break.hasBroken && m1Confirm.isConfirmed) {
    if (!inExecutionRange) {
      signalStatus = "WAIT";
      confirmation = "OVEREXTENDED_AVOID_CHASE";
    } else if (score < SCALP_MIN_SCORE) {
      signalStatus = "WAIT";
      confirmation = `SCORE_BELOW_THRESHOLD (${score}/${SCALP_MIN_SCORE})`;
    } else {
      signalStatus = "READY";
      confirmation = "M5 BREAK + M1 CONFIRMED";
    }
  }

  const structuralBase = isBuy ? refinedZone.low : refinedZone.high;
  const sl = isBuy ? round(structuralBase - slOffset, 2) : round(structuralBase + slOffset, 2);
  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (SCALP_TP1_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (SCALP_TP1_POINTS * POINT_VALUE), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (SCALP_TP2_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (SCALP_TP2_POINTS * POINT_VALUE), 2);

  const setupId = generateSetupId("SCALP", side, setupType, refinedZone.anchor);

  return {
    setupId,
    side,
    direction: side,
    signalStatus,
    zoneStatus,
    confirmation,
    score,
    entry,
    sl,
    tp1,
    tp2,
    slPoints: UNIFIED_SL_POINTS,
    slPips: UNIFIED_SL_POINTS / POINTS_PER_PIP,
    zone: {
      type: side,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
      points: refinedZone.points,
      pips: refinedZone.pips,
      locked: true,
      status: zoneStatus,
      persistence: "EPHEMERAL_PER_REQUEST"
    },
    setup: setupType,
    reason,
    m5Status: m5Break.hasBroken ? "CMP BREAK CONFIRMED" : "WAIT",
    m1Status: m1Confirm.status,
    isEligible: score >= SCALP_MIN_SCORE && zoneStatus !== "INVALID"
  };
}

// =========================================================
// 9. INTRADAY ENGINE (H4 -> H1 -> M15 -> M5 -> M1)
// =========================================================
function buildIntradaySide(side, cmp, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR, m5Candles, m1Candles) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

  // Hierarchy: Fibonacci Pullback (0.382 / 0.500 ONLY) on H1 Swing
  if (h1Struct.h1 && h1Struct.l1 && h1Struct.h1 > h1Struct.l1) {
    const range = h1Struct.h1 - h1Struct.l1;
    if (isBuy) {
      anchor = h1Struct.h1 - (range * 0.5);
      setupType = "PULLBACK_FIB_50";
      reason = "H4/H1 structural alignment with 50.0% Fibonacci pullback level.";
    } else {
      anchor = h1Struct.l1 + (range * 0.382);
      setupType = "PULLBACK_FIB_382";
      reason = "H4/H1 structural alignment with 38.2% Fibonacci pullback rejection.";
    }
  } else {
    anchor = isBuy ? h1Struct.keySupport : h1Struct.keyResistance;
    setupType = isBuy ? "PULLBACK_SUPPORT" : "PULLBACK_RESISTANCE";
    reason = isBuy ? "H4/H1 structural support demand zone." : "H4/H1 major resistance rejection.";
  }

  const baseZone = buildStandardZone(anchor, side, h1ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  const slOffset = UNIFIED_SL_POINTS * POINT_VALUE; // $3.00
  const invalidationLevel = isBuy ? refinedZone.low - slOffset : refinedZone.high + slOffset;
  const zoneStatus = evaluateZoneStatus(cmp, refinedZone, invalidationLevel);

  // M5 Closed Break & M1 Closed Confirmation Checks
  const m5Break = checkM5BreakClosed(m5Candles, side);
  const m1Confirm = m5Break.hasBroken
    ? checkM1ConfirmationClosed(m1Candles, side)
    : { isConfirmed: false, status: "WAIT", details: "WAITING_M5_BREAK" };

  const inExecutionRange = isWithinExecutionBounds(side, refinedZone, cmp);

  // Compute non-random, verified score
  const score = computeObjectiveScore({
    direction: side,
    higherTfTrend: h4Struct.direction,
    entryTfTrend: h1Struct.direction,
    isSideway: h1Struct.isSideway,
    zoneStatus,
    m5Broken: m5Break.hasBroken,
    m1Confirmed: m1Confirm.isConfirmed,
    isExecutionInRange: inExecutionRange
  });

  let signalStatus = "WAIT";
  let confirmation = "Waiting for M5 break";

  if (zoneStatus === "INVALID") {
    signalStatus = "INVALID";
    confirmation = "STRUCTURE_INVALIDATED";
  } else if (!m5Break.hasBroken) {
    signalStatus = "WAIT";
    confirmation = "Waiting for M5 break";
  } else if (m5Break.hasBroken && !m1Confirm.isConfirmed) {
    signalStatus = "M1_CHECKING";
    confirmation = "M5 BREAK -> CHECKING M1";
  } else if (m5Break.hasBroken && m1Confirm.isConfirmed) {
    if (!inExecutionRange) {
      signalStatus = "WAIT";
      confirmation = "OVEREXTENDED_AVOID_CHASE";
    } else if (score < INTRA_MIN_SCORE) {
      signalStatus = "WAIT";
      confirmation = `SCORE_BELOW_THRESHOLD (${score}/${INTRA_MIN_SCORE})`;
    } else {
      signalStatus = "READY";
      confirmation = "M5 BREAK + M1 CONFIRMED";
    }
  }

  const structuralBase = isBuy ? refinedZone.low : refinedZone.high;
  const sl = isBuy ? round(structuralBase - slOffset, 2) : round(structuralBase + slOffset, 2);
  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (INTRA_TP1_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (INTRA_TP1_POINTS * POINT_VALUE), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (INTRA_TP2_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (INTRA_TP2_POINTS * POINT_VALUE), 2);

  const setupId = generateSetupId("INTRA", side, setupType, refinedZone.anchor);

  return {
    setupId,
    side,
    direction: side,
    signalStatus,
    zoneStatus,
    confirmation,
    score,
    entry,
    sl,
    tp1,
    tp2,
    slPoints: UNIFIED_SL_POINTS,
    slPips: UNIFIED_SL_POINTS / POINTS_PER_PIP,
    zone: {
      type: side,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
      points: refinedZone.points,
      pips: refinedZone.pips,
      locked: true,
      status: zoneStatus,
      persistence: "EPHEMERAL_PER_REQUEST"
    },
    setup: setupType,
    reason,
    m5Status: m5Break.hasBroken ? "CMP BREAK CONFIRMED" : "WAIT",
    m1Status: m1Confirm.status,
    isEligible: score >= INTRA_MIN_SCORE && zoneStatus !== "INVALID"
  };
}

// =========================================================
// 10. MAIN HANDLER
// =========================================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey || apiKey.trim() === "") {
      return res.status(500).json({
        success: false,
        status: "error",
        error: "TWELVE_DATA_API_KEY is not configured in Vercel Environment Variables.",
        code: "CONFIG_ERROR",
        details: "Missing environment variable: TWELVE_DATA_API_KEY",
        source: "Vercel Environment"
      });
    }

    // Parallel fetch across 5 intervals
    let h4Candles, h1Candles, m15Candles, m5Candles, m1Candles;
    try {
      [h4Candles, h1Candles, m15Candles, m5Candles, m1Candles] = await Promise.all([
        fetchCandles("4h", 40, apiKey),
        fetchCandles("1h", 45, apiKey),
        fetchCandles("15min", 50, apiKey),
        fetchCandles("5min", 50, apiKey),
        fetchCandles("1min", 35, apiKey)
      ]);
    } catch (apiErr) {
      return res.status(502).json({
        success: false,
        status: "error",
        error: apiErr.message || "Twelve Data fetch error",
        code: apiErr.code || 502,
        details: apiErr.message,
        source: apiErr.source || "Twelve Data API"
      });
    }

    if (!m5Candles.length || !m15Candles.length || !h1Candles.length || !h4Candles.length || !m1Candles.length) {
      return res.status(502).json({
        success: false,
        status: "error",
        error: "Insufficient candle history returned from Twelve Data. Market may be closed or symbol data delayed.",
        code: "INSUFFICIENT_DATA",
        details: "Candle length verification failed across one or more critical timeframes.",
        source: "Twelve Data API"
      });
    }

    // Current Market Price: derived from the latest live candle close
    const cmpCandle = m1Candles[m1Candles.length - 1];
    const currentPrice = round(cmpCandle.close, 2);

    // Multi-timeframe structure mapping
    const h4Struct = analyzeStructure(h4Candles);
    const h1Struct = analyzeStructure(h1Candles);
    const m15Struct = analyzeStructure(m15Candles);
    const m5Swings = getSwings(m5Candles, 2, 2);
    const m15ATR = calculateATR(m15Candles, 14);
    const h1ATR = calculateATR(h1Candles, 14);

    // Scalping Side Evaluators
    const scalpBuy = buildScalpSide("BUY", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR, m5Candles, m1Candles);
    const scalpSell = buildScalpSide("SELL", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR, m5Candles, m1Candles);

    // Intraday Side Evaluators
    const intraBuy = buildIntradaySide("BUY", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR, m5Candles, m1Candles);
    const intraSell = buildIntradaySide("SELL", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR, m5Candles, m1Candles);

    // Filter sides by structural trend qualification, NOT raw score alone
    const pickBestSide = (buySetup, sellSetup, tfBias) => {
      if (tfBias === "BULLISH" && buySetup.isEligible) return buySetup;
      if (tfBias === "BEARISH" && sellSetup.isEligible) return sellSetup;
      // In sideways / neutral, pick qualified side with active zone proximity
      if (buySetup.isEligible && (buySetup.zoneStatus === "IN_ZONE" || buySetup.zoneStatus === "APPROACHING")) return buySetup;
      if (sellSetup.isEligible && (sellSetup.zoneStatus === "IN_ZONE" || sellSetup.zoneStatus === "APPROACHING")) return sellSetup;
      // Fallback: return higher verified score if eligible, otherwise default to higher score in WAIT state
      if (buySetup.isEligible && !sellSetup.isEligible) return buySetup;
      if (sellSetup.isEligible && !buySetup.isEligible) return sellSetup;
      return buySetup.score >= sellSetup.score ? buySetup : sellSetup;
    };

    const primaryScalp = pickBestSide(scalpBuy, scalpSell, h1Struct.direction);
    const primaryIntra = pickBestSide(intraBuy, intraSell, h4Struct.direction);

    // Dominant Setup selection strictly based on timeframe confluence & qualification
    let bestSetup = primaryScalp;
    if (primaryIntra.isEligible && !primaryScalp.isEligible) {
      bestSetup = primaryIntra;
    } else if (primaryIntra.isEligible && primaryScalp.isEligible) {
      bestSetup = primaryIntra.score >= primaryScalp.score ? primaryIntra : primaryScalp;
    } else {
      bestSetup = primaryScalp.score >= primaryIntra.score ? primaryScalp : primaryIntra;
    }

    const puncaPrice = bestSetup.zone.anchor;
    const puncaSource = `${m15Struct.isSideway ? "M15 Range" : "M15 S/R"} (${bestSetup.setup})`;

    const calculatedRisk = round(Math.abs(bestSetup.entry - bestSetup.sl), 2);
    const maxAllowedRisk = round(UNIFIED_SL_POINTS * POINT_VALUE, 2); // $3.00

    // Construct robust response payload (resolving duplicate "status" collision)
    const responsePayload = {
      // API Protocol State (Unambiguous)
      success: true,
      status: "success",

      engine: {
        name: "SINNCI MARKET ENGINE PRO",
        version: "PRO-3.0",
        mode: "MARKET_STRUCTURE_ANALYSIS_ONLY",
        disclaimer: "Analysis and signal mapping only. Automated trade execution is strictly disabled.",
        standards: {
          unit: "10 points = 1 pip",
          zoneRange: "200 - 350 points (20 - 35 pips)",
          stopLoss: "300 points (30 pips)",
          closedCandleVerification: "Active on M5 & M1"
        }
      },
      market: {
        symbol: "XAUUSD",
        price: currentPrice,
        atr: round(m15ATR, 2)
      },
      direction: {
        H4: h4Struct.direction,
        H1: h1Struct.direction,
        M15: m15Struct.direction,
        M5: bestSetup.m5Status
      },
      structure: {
        H4: h4Struct.structure,
        H1: h1Struct.structure,
        M15: m15Struct.structure
      },
      multiTimeframe: {
        H4: h4Struct.direction,
        H1: h1Struct.direction,
        M15: m15Struct.direction,
        M5: bestSetup.m5Status,
        M1: bestSetup.m1Status
      },
      // Scalping Setup Node
      scalping: {
        signal: primaryScalp.side,
        direction: primaryScalp.side,
        structure: m15Struct.structure,
        signalStatus: primaryScalp.signalStatus,
        status: primaryScalp.signalStatus, // Backward compatibility for legacy UI
        score: primaryScalp.score,
        zone: primaryScalp.zone,
        entry: primaryScalp.entry,
        sl: primaryScalp.sl,
        tp1: primaryScalp.tp1,
        tp2: primaryScalp.tp2,
        reason: primaryScalp.reason,
        locked: true,
        m5Status: primaryScalp.m5Status,
        m1Status: primaryScalp.m1Status,
        buy: { ...scalpBuy, status: scalpBuy.signalStatus },
        sell: { ...scalpSell, status: scalpSell.signalStatus }
      },
      // Intraday Setup Node
      intraday: {
        signal: primaryIntra.side,
        direction: primaryIntra.side,
        signalStatus: primaryIntra.signalStatus,
        status: primaryIntra.signalStatus, // Backward compatibility for legacy UI
        score: primaryIntra.score,
        zone: primaryIntra.zone,
        entry: primaryIntra.entry,
        sl: primaryIntra.sl,
        tp1: primaryIntra.tp1,
        tp2: primaryIntra.tp2,
        reason: primaryIntra.reason,
        locked: true,
        m5Status: primaryIntra.m5Status,
        m1Status: primaryIntra.m1Status,
        buy: { ...intraBuy, status: intraBuy.signalStatus },
        sell: { ...intraSell, status: intraSell.signalStatus }
      },
      // Distinct Signal Execution State
      signal: {
        direction: bestSetup.side,
        status: bestSetup.signalStatus,
        signalStatus: bestSetup.signalStatus,
        confirmation: bestSetup.confirmation
      },
      // Explicit Dedicated Signal State
      signalStatus: bestSetup.signalStatus,
      zone: bestSetup.zone,
      m1: {
        status: bestSetup.m1Status,
        direction: bestSetup.m1Status.includes("CONFIRMED") ? bestSetup.side : "NONE"
      },
      audit: {
        m5Break: bestSetup.m5Status === "CMP BREAK CONFIRMED",
        m5BreakDetails: bestSetup.m5Status,
        m1Confirmed: bestSetup.m1Status.includes("CONFIRMED"),
        m1Details: bestSetup.m1Status,
        evaluationModel: "CLOSED_CANDLES_ONLY"
      },
      score: bestSetup.score,
      scores: {
        buy: Math.max(scalpBuy.score, intraBuy.score),
        sell: Math.max(scalpSell.score, intraSell.score)
      },
      entry: bestSetup.entry,
      sl: bestSetup.sl,
      tp1: bestSetup.tp1,
      tp2: bestSetup.tp2,
      plan: {
        entry: bestSetup.entry,
        sl: bestSetup.sl,
        tp1: bestSetup.tp1,
        tp2: bestSetup.tp2
      },
      punca: {
        price: puncaPrice,
        source: puncaSource
      },
      risk: calculatedRisk,
      maxAllowedRisk: maxAllowedRisk,
      reason: bestSetup.reason,
      waitReason: bestSetup.signalStatus === "READY" ? null : bestSetup.confirmation,
      timestamp: new Date().toISOString()
    };

    return res.status(200).json(responsePayload);
  } catch (error) {
    return res.status(500).json({
      success: false,
      status: "error",
      error: error.message || "Market analysis execution encountered an unhandled exception.",
      code: error.code || 500,
      details: error.details || error.stack || "Internal Execution Exception",
      source: error.source || "Serverless Execution Engine"
    });
  }
}
