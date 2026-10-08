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

// =========================================================
// 1. UNIT & ZONE RULES (RULE TERKINI SAHAJA)
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

// Thresholds
const SCALP_SIGNAL_SCORE = 65;
const INTRA_SIGNAL_SCORE = 90;

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
  if (!candles || candles.length < period + 1) return 3.0; // Fallback price ATR
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

// Deterministic Zone Lock Hash (Mengunci zon selagi aras struktur tidak terbatal)
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
  // Tetapan ketat: 200 - 350 points ($2.00 - $3.50) berasaskan turun naik pasaran sebenar
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
  };
}

// Refine M15 zone dengan structure M5 tanpa melanggar had 200–350 points
function refineZoneWithM5(zone, m5Swings) {
  if (!zone) return null;

  const minAllowed = UNIFIED_ZONE_MIN_POINTS * POINT_VALUE; // $2.00
  const maxAllowed = UNIFIED_ZONE_MAX_POINTS * POINT_VALUE; // $3.50

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
    if (cmp > zone.high && cmp <= zone.high + 1.5) return "APPROACHING";
    if (cmp > zone.high + 1.5 && cmp <= zone.high + 5.0) return "WAIT_RETEST";
    return "WATCH";
  } else {
    if (cmp > invalidationLevel) return "INVALID";
    if (cmp >= zone.low && cmp <= zone.high) return "READY";
    if (cmp < zone.low && cmp >= zone.low - 1.5) return "APPROACHING";
    if (cmp < zone.low - 1.5 && cmp >= zone.low - 5.0) return "WAIT_RETEST";
    return "WATCH";
  }
}

// =========================================================
// 6. SCALPING ENGINE (H1 -> M15 -> M5)
// =========================================================
function buildScalpSide(side, cmp, h1Struct, m15Struct, m5Swings, m15ATR) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

  // 1. Sideway Market Logic (Range Support / Resistance - JANGAN TUNGGU BREAKOUT)
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

  // 200 - 350 points zone
  const baseZone = buildStandardZone(anchor, side, m15ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  // Invalidation & SL: 300 points ($3.00) dari sempadan zon
  const slOffset = UNIFIED_SL_POINTS * POINT_VALUE; // $3.00
  const invalidationLevel = isBuy ? refinedZone.low - slOffset : refinedZone.high + slOffset;
  const status = evaluateStatus(cmp, refinedZone, invalidationLevel);

  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);
  const sl = isBuy ? round(refinedZone.low - slOffset, 2) : round(refinedZone.high + slOffset, 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (SCALP_TP1_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (SCALP_TP1_POINTS * POINT_VALUE), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (SCALP_TP2_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (SCALP_TP2_POINTS * POINT_VALUE), 2);

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
    slPoints: UNIFIED_SL_POINTS,
    slPips: UNIFIED_SL_POINTS / POINTS_PER_PIP,
    zone: {
      type: side,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
      points: refinedZone.points,
      pips: refinedZone.pips,
    },
    setup: setupType,
    reason,
    locked: true,
  };
}

// =========================================================
// 7. INTRADAY ENGINE (H4 -> H1 -> M15 -> M5)
// =========================================================
function buildIntradaySide(side, cmp, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR) {
  const isBuy = side === "BUY";
  let anchor = 0;
  let setupType = "SR_LEVEL";
  let reason = "";

  // Hierarchy: Fibonacci Pullback (0.382 / 0.500 ONLY) pada H1 Swing
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

  // Unified Zone Range: 200 - 350 points
  const baseZone = buildStandardZone(anchor, side, h1ATR);
  const refinedZone = refineZoneWithM5(baseZone, m5Swings);

  // Invalidation & SL: 300 points ($3.00)
  const slOffset = UNIFIED_SL_POINTS * POINT_VALUE; // $3.00
  const invalidationLevel = isBuy ? refinedZone.low - slOffset : refinedZone.high + slOffset;
  const status = evaluateStatus(cmp, refinedZone, invalidationLevel);

  const entry = round((refinedZone.low + refinedZone.high) / 2, 2);
  const sl = isBuy ? round(refinedZone.low - slOffset, 2) : round(refinedZone.high + slOffset, 2);

  const tp1 = isBuy
    ? round(refinedZone.high + (INTRA_TP1_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (INTRA_TP1_POINTS * POINT_VALUE), 2);

  const tp2 = isBuy
    ? round(refinedZone.high + (INTRA_TP2_POINTS * POINT_VALUE), 2)
    : round(refinedZone.low - (INTRA_TP2_POINTS * POINT_VALUE), 2);

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
    slPoints: UNIFIED_SL_POINTS,
    slPips: UNIFIED_SL_POINTS / POINTS_PER_PIP,
    zone: {
      type: side,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
      points: refinedZone.points,
      pips: refinedZone.pips,
    },
    setup: setupType,
    reason,
    locked: true,
  };
}

// =========================================================
// 8. MAIN HANDLER (Vercel Serverless Function)
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

    // Parallel fetch H4, H1, M15, M5
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

    // Multi-timeframe structures
    const h4Struct = analyzeStructure(h4Candles);
    const h1Struct = analyzeStructure(h1Candles);
    const m15Struct = analyzeStructure(m15Candles);
    const m5Swings = getSwings(m5Candles, 2, 2);
    const m15ATR = calculateATR(m15Candles, 14);
    const h1ATR = calculateATR(h1Candles, 14);

    // Build Scalping & Intraday Sides
    const scalpBuy = buildScalpSide("BUY", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR);
    const scalpSell = buildScalpSide("SELL", currentPrice, h1Struct, m15Struct, m5Swings, m15ATR);
    const intraBuy = buildIntradaySide("BUY", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR);
    const intraSell = buildIntradaySide("SELL", currentPrice, h4Struct, h1Struct, m15Struct, m5Swings, h1ATR);

    // Dominant Setups
    const primaryScalp = scalpBuy.score >= scalpSell.score ? scalpBuy : scalpSell;
    const primaryIntra = intraBuy.score >= intraSell.score ? intraBuy : intraSell;
    const bestSetup = primaryScalp.score >= primaryIntra.score ? primaryScalp : primaryIntra;

    const puncaPrice = bestSetup.zone.anchor;
    const puncaSource = `${m15Struct.isSideway ? "M15 Range" : "M15 S/R"} (${bestSetup.setup})`;

    const calculatedRisk = round(Math.abs(bestSetup.entry - bestSetup.sl), 2);
    const maxAllowedRisk = round(UNIFIED_SL_POINTS * POINT_VALUE, 2); // $3.00

    // Output JSON Payload (Kekal 100% serasi dengan HTML sedia ada)
    const responsePayload = {
      status: "success",
      engine: {
        name: "SINNCI MARKET ENGINE PRO",
        version: "PRO-3.0",
        mode: "ACTIVE SCALPING / SELECTIVE INTRADAY",
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
        M5: m5Swings.highs.length ? "BULLISH" : "NEUTRAL",
      },
      structure: {
        H4: h4Struct.structure,
        H1: h1Struct.structure,
        M15: m15Struct.structure,
      },
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
