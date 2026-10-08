/**
 * ============================================================================
 * SINNCI MARKET ENGINE PRO (PRO-3.0 REVISED)
 * Asset: XAUUSD (Gold)
 * File: api/analyze.js
 * Deployment: Vercel Serverless Function
 * 
 * FLOW ARCHITECTURE:
 * H1 BIAS -> M15 SETUP -> EARLY ZONE OUTPUT (LOCKED) -> M5 BREAK TRIGGER -> M1 CHECK -> M1 CONFIRM -> READY SIGNAL
 * ============================================================================
 */

import crypto from "crypto";

const SYMBOL = "XAU/USD";
const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com/time_series";

// =========================================================
// 1. UNIT & ZONE RULES
// 10 POINTS = 1 PIP ($0.01 = 1 point, $0.10 = 1 pip, $1.00 = 100 points)
// =========================================================
const POINTS_PER_PIP = 10;
const POINT_VALUE = 0.01;

// UNIFIED ZONE RANGE: 200 - 350 points = 20 - 35 pips ($2.00 - $3.50)
const UNIFIED_ZONE_MIN_POINTS = 200;
const UNIFIED_ZONE_MAX_POINTS = 350;

// UNIFIED STOP LOSS: 300 points = 30 pips ($3.00)
const UNIFIED_SL_POINTS = 300;

// Scalping TP Targets
const SCALP_TP1_POINTS = 600;  // 60 pips / $6.00
const SCALP_TP2_POINTS = 1200; // 120 pips / $12.00

// Intraday TP Targets
const INTRA_TP1_POINTS = 1500; // 150 pips / $15.00
const INTRA_TP2_POINTS = 2300; // 230 pips / $23.00

// =========================================================
// 2. HELPERS & MATH
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
  if (!candles || candles.length < period + 1) return 3.0;
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

function generateSetupId(tf, direction, setupType, anchorPrice) {
  const roundedAnchor = Math.round(anchorPrice * 2) / 2;
  const rawKey = `${tf}_${direction}_${setupType}_${roundedAnchor}`;
  return crypto.createHash("md5").update(rawKey).digest("hex").slice(0, 10);
}

// =========================================================
// 3. MARKET DATA FETCHER (Twelve Data)
// =========================================================
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

// =========================================================
// 4. MARKET STRUCTURE ENGINE (HH / HL / LH / LL)
// =========================================================
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
      keySupport: lastClose - 2.5,
      keyResistance: lastClose + 2.5,
      isSideway: true,
      lastHigh: highs.length ? highs[highs.length - 1].price : lastClose + 2.5,
      lastLow: lows.length ? lows[lows.length - 1].price : lastClose - 2.5,
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
  const isSideway = structPattern === "RANGE" || (keyResistance - keySupport) <= 8.0;

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

// =========================================================
// 5. ZONE BUILDER ENGINE (200 - 350 POINTS / 20 - 35 PIPS)
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
        };
      }
    }
  }

  return zone;
}

// Status zon berasingan daripada status signal
function evaluateZoneStatus(cmp, zone, slOffset) {
  if (!zone) return "INVALID";

  if (zone.type === "BUY") {
    if (cmp < zone.low - slOffset) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "IN_ZONE";
    if (cmp > zone.high && cmp <= zone.high + 2.0) return "APPROACHING";
    return "WATCH";
  } else {
    if (cmp > zone.high + slOffset) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "IN_ZONE";
    if (cmp < zone.low && cmp >= zone.low - 2.0) return "APPROACHING";
    return "WATCH";
  }
}

// =========================================================
// 6. TRIGGER & CONFIRMATION ENGINE (M5 BREAK -> M1 CONFIRM)
// =========================================================
function evaluateM5Break(m5Candles, cmp, direction, isStrongSetup) {
  if (!m5Candles || m5Candles.length < 3) {
    return { hasBroken: false, isStrong: false, details: "Awaiting M5 data" };
  }

  const latest = m5Candles[m5Candles.length - 1];
  const prev = m5Candles[m5Candles.length - 2];

  // Setup kuat: bypass keperluan breakout melampau
  if (isStrongSetup) {
    return {
      hasBroken: true,
      isStrong: true,
      details: "Strong structure alignment active; fast M1 trigger.",
    };
  }

  let hasBroken = false;
  let details = "Awaiting M5 CMP/Structure break";

  if (direction === "BUY") {
    const cmpBrokeHigh = cmp > prev.high;
    const bullishShift = latest.close > prev.high || (latest.close > latest.open && cmp > prev.close);
    const rejectionWick = latest.low < prev.low && cmp > prev.low;

    if (cmpBrokeHigh || bullishShift || rejectionWick) {
      hasBroken = true;
      details = "M5 Bullish CMP/Structure break detected";
    }
  } else if (direction === "SELL") {
    const cmpBrokeLow = cmp < prev.low;
    const bearishShift = latest.close < prev.low || (latest.close < latest.open && cmp < prev.close);
    const rejectionWick = latest.high > prev.high && cmp < prev.high;

    if (cmpBrokeLow || bearishShift || rejectionWick) {
      hasBroken = true;
      details = "M5 Bearish CMP/Structure break detected";
    }
  }

  return { hasBroken, isStrong: false, details };
}

function evaluateM1Confirmation(m1Candles, cmp, direction) {
  if (!m1Candles || m1Candles.length < 4) {
    return { isConfirmed: false, details: "Awaiting M1 candles" };
  }

  const recent = m1Candles.slice(-4);
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  let isConfirmed = false;
  let details = "Validating M1 micro-structure";

  if (direction === "BUY") {
    const bullishBody = current.close > current.open;
    const microBreak = cmp > prev.high || current.close > prev.high;
    const rejectionLow = current.low <= prev.low && current.close > current.open;
    const positiveMomentum = current.close >= prev.close;

    if ((microBreak || rejectionLow) && bullishBody && positiveMomentum) {
      isConfirmed = true;
      details = "M1 confirmed: Bullish micro-reclaim & upward momentum";
    } else {
      details = "M1 waiting for buyer follow-through";
    }
  } else if (direction === "SELL") {
    const bearishBody = current.close < current.open;
    const microBreak = cmp < prev.low || current.close < prev.low;
    const rejectionHigh = current.high >= prev.high && current.close < current.open;
    const negativeMomentum = current.close <= prev.close;

    if ((microBreak || rejectionHigh) && bearishBody && negativeMomentum) {
      isConfirmed = true;
      details = "M1 confirmed: Bearish micro-reclaim & downward momentum";
    } else {
      details = "M1 waiting for seller follow-through";
    }
  }

  return { isConfirmed, details };
}

// Elak mengejar harga jika pasaran sudah lari melebihi 60 pips dari had struktur
function isPriceWithinExecutionBounds(direction, zone, cmp) {
  const maxTolerance = 6.0; // $6.00 = 60 pips = 600 points
  if (direction === "BUY") {
    return cmp <= zone.high + maxTolerance;
  } else {
    return cmp >= zone.low - maxTolerance;
  }
}

// =========================================================
// 7. SCALPING ENGINE (H1 -> M15 -> M5 -> M1)
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
      reason = "M15 Range consolidation support; early zone locked.";
    } else {
      anchor = m15Struct.keyResistance;
      setupType = "RANGE_RESISTANCE";
      reason = "M15 Range consolidation resistance; early zone locked.";
    }
  } else if (isBuy) {
    if (m15Struct.h2 && cmp >= m15Struct.h2.price) {
      anchor = m15Struct.h2.price;
      setupType = "BREAKOUT_PULLBACK";
      reason = "Bullish structure breakout; key resistance-turned-support.";
    } else {
      anchor = m15Struct.l1 ? m15Struct.l1.price : m15Struct.keySupport;
      setupType = "TREND_CONTINUATION";
      reason = "Higher-High / Higher-Low progression; continuing bullish trend.";
    }
  } else {
    if (m15Struct.l2 && cmp <= m15Struct.l2.price) {
      anchor = m15Struct.l2.price;
      setupType = "BREAKOUT_PULLBACK";
      reason = "Bearish structure breakdown; key support-turned-resistance.";
    } else {
      anchor = m15Struct.h1 ? m15Struct.h1.price : m15Struct.keyResistance;
      setupType = "TREND_CONTINUATION";
      reason = "Lower-High / Lower-Low progression; continuing bearish trend.";
    }
  }

  // 1. Zone Output Awal (200 - 350 points) & LOCKED
  const baseZone = buildStandardZone(anchor, side, m15ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  const slOffset = UNIFIED_SL_POINTS * POINT_VALUE; // $3.00
  const zoneStatus = evaluateZoneStatus(cmp, refinedZone, slOffset);

  // 2. Flow Trigger & Execution
  const targetDir = isBuy ? "BULLISH" : "BEARISH";
  const isStrong = h1Struct.direction === targetDir && m15Struct.direction === targetDir;

  const m5Break = evaluateM5Break(m5Candles, cmp, side, isStrong);
  const m1Confirm = (m5Break.hasBroken || m5Break.isStrong)
    ? evaluateM1Confirmation(m1Candles, cmp, side)
    : { isConfirmed: false, details: "Waiting for M5 break" };

  let signalStatus = "WAIT";
  let confirmation = "WAIT_M5_BREAK";

  if (zoneStatus === "INVALID") {
    signalStatus = "INVALID";
    confirmation = "STRUCTURE_INVALIDATED";
  } else if (!m5Break.hasBroken && !m5Break.isStrong) {
    signalStatus = zoneStatus === "APPROACHING" ? "APPROACHING" : "WATCH";
    confirmation = "M5_BREAK_WAIT_M1";
  } else if ((m5Break.hasBroken || m5Break.isStrong) && !m1Confirm.isConfirmed) {
    signalStatus = "M1_CHECKING";
    confirmation = "M5_BREAK";
  } else if ((m5Break.hasBroken || m5Break.isStrong) && m1Confirm.isConfirmed) {
    if (isPriceWithinExecutionBounds(side, refinedZone, cmp)) {
      signalStatus = "READY";
      confirmation = "M5_BREAK_M1_CONFIRMED";
    } else {
      signalStatus = "WAIT";
      confirmation = "OVEREXTENDED_AVOID_CHASE";
    }
  }

  // Pengiraan Aras Struktur SL & TP
  const structuralBase = isBuy ? refinedZone.low : refinedZone.high;
  const sl = isBuy ? round(structuralBase - slOffset, 2) : round(structuralBase + slOffset, 2);
  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (SCALP_TP1_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (SCALP_TP1_POINTS * POINT_VALUE), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (SCALP_TP2_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (SCALP_TP2_POINTS * POINT_VALUE), 2);

  let score = 65;
  if (h1Struct.direction === targetDir) score += 15;
  if (m15Struct.direction === targetDir) score += 10;
  if (signalStatus === "READY") score += 10;
  score = clamp(score, 45, 98);

  const setupId = generateSetupId("SCALP", side, setupType, refinedZone.anchor);

  return {
    setupId,
    side,
    direction: side,
    zoneStatus,
    signalStatus,
    status: signalStatus, // Serasi dengan UI
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
    },
    setup: setupType,
    reason,
    audit: {
      m5Break: m5Break.details,
      m1Confirm: m1Confirm.details,
    },
  };
}

// =========================================================
// 8. INTRADAY ENGINE (H4 -> H1 -> M15 -> M5 -> M1)
// =========================================================
function buildIntradaySide(side, cmp, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR, m5Candles, m1Candles) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

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
    reason = isBuy ? "H4/H1 structural demand zone." : "H4/H1 major resistance rejection.";
  }

  const baseZone = buildStandardZone(anchor, side, h1ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  const slOffset = UNIFIED_SL_POINTS * POINT_VALUE; // $3.00
  const zoneStatus = evaluateZoneStatus(cmp, refinedZone, slOffset);

  const targetDir = isBuy ? "BULLISH" : "BEARISH";
  const isStrong = h4Struct.direction === targetDir && h1Struct.direction === targetDir;

  const m5Break = evaluateM5Break(m5Candles, cmp, side, isStrong);
  const m1Confirm = (m5Break.hasBroken || m5Break.isStrong)
    ? evaluateM1Confirmation(m1Candles, cmp, side)
    : { isConfirmed: false, details: "Waiting for M5 break" };

  let signalStatus = "WAIT";
  let confirmation = "WAIT_M5_BREAK";

  if (zoneStatus === "INVALID") {
    signalStatus = "INVALID";
    confirmation = "STRUCTURE_INVALIDATED";
  } else if (!m5Break.hasBroken && !m5Break.isStrong) {
    signalStatus = zoneStatus === "APPROACHING" ? "APPROACHING" : "WATCH";
    confirmation = "M5_BREAK_WAIT_M1";
  } else if ((m5Break.hasBroken || m5Break.isStrong) && !m1Confirm.isConfirmed) {
    signalStatus = "M1_CHECKING";
    confirmation = "M5_BREAK";
  } else if ((m5Break.hasBroken || m5Break.isStrong) && m1Confirm.isConfirmed) {
    if (isPriceWithinExecutionBounds(side, refinedZone, cmp)) {
      signalStatus = "READY";
      confirmation = "M5_BREAK_M1_CONFIRMED";
    } else {
      signalStatus = "WAIT";
      confirmation = "OVEREXTENDED_AVOID_CHASE";
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

  let score = 70;
  if (h4Struct.direction === targetDir) score += 15;
  if (h1Struct.direction === targetDir) score += 10;
  if (signalStatus === "READY") score += 10;
  score = clamp(score, 50, 98);

  const setupId = generateSetupId("INTRA", side, setupType, refinedZone.anchor);

  return {
    setupId,
    side,
    direction: side,
    zoneStatus,
    signalStatus,
    status: signalStatus,
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
    },
    setup: setupType,
    reason,
    audit: {
      m5Break: m5Break.details,
      m1Confirm: m1Confirm.details,
    },
  };
}

// =========================================================
// 9. MAIN HANDLER (Vercel Serverless Function)
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

    if (!apiKey) {
      return res.status(500).json({
        status: "error",
        error: "TWELVE_DATA_API_KEY is not configured in Vercel environment variables.",
      });
    }

    // Parallel fetch H4, H1, M15, M5, M1
    const [h4Candles, h1Candles, m15Candles, m5Candles, m1Candles] = await Promise.all([
      fetchCandles("4h", 40, apiKey),
      fetchCandles("1h", 45, apiKey),
      fetchCandles("15min", 50, apiKey),
      fetchCandles("5min", 50, apiKey),
      fetchCandles("1min", 30, apiKey),
    ]);

    if (!m1Candles.length || !m5Candles.length || !m15Candles.length || !h1Candles.length || !h4Candles.length) {
      return res.status(502).json({
        status: "error",
        error: "Insufficient candle history returned from Twelve Data.",
      });
    }

    const currentPrice = round(m1Candles[m1Candles.length - 1].close, 2);

    // Multi-timeframe structures
    const h4Struct = analyzeStructure(h4Candles);
    const h1Struct = analyzeStructure(h1Candles);
    const m15Struct = analyzeStructure(m15Candles);
    const m5Swings = getSwings(m5Candles, 2, 2);
    const m15ATR = calculateATR(m15Candles, 14);
    const h1ATR = calculateATR(h1Candles, 14);

    // Bina Setup Scalping & Intraday
    const scalpBuy = buildScalpSide("BUY", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR, m5Candles, m1Candles);
    const scalpSell = buildScalpSide("SELL", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR, m5Candles, m1Candles);
    const intraBuy = buildIntradaySide("BUY", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR, m5Candles, m1Candles);
    const intraSell = buildIntradaySide("SELL", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR, m5Candles, m1Candles);

    // Pemilihan setup utama
    const primaryScalp = scalpBuy.score >= scalpSell.score ? scalpBuy : scalpSell;
    const primaryIntra = intraBuy.score >= intraSell.score ? intraBuy : intraSell;
    const bestSetup = primaryScalp.score >= primaryIntra.score ? primaryScalp : primaryIntra;

    const calculatedRisk = round(Math.abs(bestSetup.entry - bestSetup.sl), 2);
    const maxAllowedRisk = round(UNIFIED_SL_POINTS * POINT_VALUE, 2);

    // Output JSON Payload (Menyokong UI sedia ada & logic baharu)
    const responsePayload = {
      status: "success",
      engine: {
        name: "SINNCI MARKET ENGINE PRO",
        version: "PRO-3.0",
        flow: "H1 -> M15 -> EARLY ZONE LOCKED -> M5 BREAK -> M1 CONFIRM -> READY",
        standards: {
          unit: "10 points = 1 pip",
          zoneRange: "200 - 350 points (20 - 35 pips)",
          stopLoss: "300 points (30 pips)",
        },
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
        M5: m5BreakDirection(m5Candles),
      },
      structure: {
        H4: h4Struct.structure,
        H1: h1Struct.structure,
        M15: m15Struct.structure,
      },
      // Pemisahan Eksplisit: Zone vs Signal mengikut flow baru
      zone: {
        type: bestSetup.zone.type,
        low: bestSetup.zone.low,
        high: bestSetup.zone.high,
        anchor: bestSetup.zone.anchor,
        points: bestSetup.zone.points,
        pips: bestSetup.zone.pips,
        locked: true,
        status: bestSetup.zoneStatus,
      },
      signal: {
        direction: bestSetup.side,
        status: bestSetup.signalStatus,
        confirmation: bestSetup.confirmation,
      },
      scalping: {
        signal: primaryScalp.side,
        direction: h1Struct.direction,
        structure: m15Struct.structure,
        status: primaryScalp.signalStatus,
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
      intraday: {
        signal: primaryIntra.side,
        direction: h4Struct.direction,
        status: primaryIntra.signalStatus,
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
      // Medan warisan untuk UI lama
      status: bestSetup.signalStatus,
      score: bestSetup.score,
      entry: bestSetup.entry,
      sl: bestSetup.sl,
      tp1: bestSetup.tp1,
      tp2: bestSetup.tp2,
      punca: {
        price: bestSetup.zone.anchor,
        source: `${m15Struct.isSideway ? "M15 Range" : "M15 S/R"} (${bestSetup.setup})`,
      },
      risk: calculatedRisk,
      maxAllowedRisk: maxAllowedRisk,
      reason: bestSetup.reason,
      waitReason: bestSetup.signalStatus === "READY" ? null : bestSetup.confirmation,
      audit: bestSetup.audit,
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

function m5BreakDirection(candles) {
  if (!candles || candles.length < 2) return "NEUTRAL";
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  if (c.close > p.high) return "BULLISH_BREAK";
  if (c.close < p.low) return "BEARISH_BREAK";
  return "INSIDE";
}
