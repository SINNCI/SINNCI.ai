/**
 * ============================================================================
 * SINNCI AI - MARKET ANALYSIS & ENTRY-ZONE MAPPING ENGINE (PRO-3.0)
 * Asset: XAUUSD (Gold)
 * File: api/analyze.js
 * Deployment: Vercel Serverless Function
 * ============================================================================
 */

import crypto from "crypto";

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const SYMBOL = "XAUUSD";
const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com/time_series";

// Scalping Zone Width Parameters (in Gold points, e.g., 25 - 35 points = $2.5 - $3.5)
const SCALP_ZONE_TARGET_MIN = 20.0;
const SCALP_ZONE_TARGET_MAX = 35.0;

// Scalping TP Targets (in points: 600 points = $6.0, 1200 points = $12.0)
const SCALP_TP1_POINTS = 600;
const SCALP_TP2_POINTS = 1200;

// Intraday Fibonacci Retracement Levels ONLY (No 0.618, 0.705, 0.786)
const FIB_LEVELS = [0.382, 0.5];

// ==========================================
// 2. HELPER FUNCTIONS & MATH
// ==========================================
function roundPrice(val, decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return 0;
  return Number(Math.round(Number(val) + "e" + decimals) + "e-" + decimals);
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 25.0; // Fallback default normal Gold ATR points
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / period;
}

// Generate Deterministic Setup Hash to LOCK Zone across serverless instances
function generateSetupId(tf, direction, setupType, anchorPrice) {
  const roundedAnchor = Math.round(anchorPrice * 2) / 2; // Stabilize to nearest 0.5 step
  const rawKey = `${tf}_${direction}_${setupType}_${roundedAnchor}`;
  return crypto.createHash("md5").update(rawKey).digest("hex").slice(0, 10);
}

// ==========================================
// 3. MARKET DATA FETCHER (Twelve Data)
// ==========================================
async function fetchTimeframeCandles(symbol, interval, outputsize, apiKey) {
  const url = `${TWELVE_DATA_BASE_URL}?symbol=${encodeURIComponent(
    symbol
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data HTTP error: ${res.status} (${res.statusText})`);
  }

  const data = await res.json();
  if (data.status === "error" || !data.values || !Array.isArray(data.values)) {
    throw new Error(data.message || `Failed to fetch ${interval} data from Twelve Data.`);
  }

  // Convert & sort chronologically: index 0 = oldest, index length-1 = most recent
  return data.values
    .map((c) => ({
      datetime: c.datetime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume || 0),
    }))
    .reverse();
}

// ==========================================
// 4. MARKET STRUCTURE ENGINE (HH, HL, LH, LL)
// ==========================================
function identifySwings(candles, left = 2, right = 2) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = left; i < candles.length - right; i++) {
    const currentHigh = candles[i].high;
    const currentLow = candles[i].low;

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= currentHigh) isHigh = false;
      if (candles[i - j].low <= currentLow) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > currentHigh) isHigh = false;
      if (candles[i + j].low < currentLow) isLow = false;
    }

    if (isHigh) {
      swingHighs.push({
        index: i,
        price: currentHigh,
        candle: candles[i],
        time: candles[i].datetime,
      });
    }
    if (isLow) {
      swingLows.push({
        index: i,
        price: currentLow,
        candle: candles[i],
        time: candles[i].datetime,
      });
    }
  }

  return { swingHighs, swingLows };
}

function evaluateMarketStructure(candles) {
  const { swingHighs, swingLows } = identifySwings(candles, 2, 2);

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return {
      direction: "NEUTRAL",
      structure: "CONSOLIDATION",
      swingHighs,
      swingLows,
      keyResistance: candles[candles.length - 1].high,
      keySupport: candles[candles.length - 1].low,
      isSideway: true,
    };
  }

  const recentH1 = swingHighs[swingHighs.length - 1];
  const prevH2 = swingHighs[swingHighs.length - 2];
  const recentL1 = swingLows[swingLows.length - 1];
  const prevL2 = swingLows[swingLows.length - 2];

  let direction = "NEUTRAL";
  let structure = "UNDEFINED";

  const isHigherHigh = recentH1.price > prevH2.price;
  const isHigherLow = recentL1.price > prevL2.price;
  const isLowerHigh = recentH1.price < prevH2.price;
  const isLowerLow = recentL1.price < prevL2.price;

  if (isHigherHigh && isHigherLow) {
    direction = "BULLISH";
    structure = "HH_HL";
  } else if (isLowerHigh && isLowerLow) {
    direction = "BEARISH";
    structure = "LH_LL";
  } else if (isHigherHigh && isLowerLow) {
    direction = "EXPANDING_RANGE";
    structure = "RANGE";
  } else {
    direction = "RANGING";
    structure = "RANGE";
  }

  // Calculate Range Boundaries
  const lastNHighs = swingHighs.slice(-3).map((s) => s.price);
  const lastNLows = swingLows.slice(-3).map((s) => s.price);
  const keyResistance = Math.max(...lastNHighs);
  const keySupport = Math.min(...lastNLows);

  const rangeSpan = keyResistance - keySupport;
  const isSideway = structure === "RANGE" || rangeSpan <= 80; // Gold consolidation threshold

  return {
    direction,
    structure,
    swingHighs,
    swingLows,
    recentH1,
    prevH2,
    recentL1,
    prevL2,
    keyResistance,
    keySupport,
    isSideway,
  };
}

// ==========================================
// 5. ZONE ENGINE & DETERMINISTIC LOCKING
// ==========================================
function buildZone(basePrice, direction, volatilityPoints = 25) {
  // Constrain zone width strictly within 20 - 35 points (Gold points)
  const zoneWidth = Math.min(
    Math.max(volatilityPoints * 0.4, SCALP_ZONE_TARGET_MIN),
    SCALP_ZONE_TARGET_MAX
  );

  let low, high;
  if (direction === "BUY") {
    high = basePrice;
    low = basePrice - zoneWidth;
  } else {
    low = basePrice;
    high = basePrice + zoneWidth;
  }

  return {
    type: direction,
    low: roundPrice(low, 2),
    high: roundPrice(high, 2),
    width: roundPrice(high - low, 2),
    anchor: roundPrice(basePrice, 2),
  };
}

// Refine M15 zone using M5 local reaction structures
function refineZoneWithM5(m15Zone, m5Swings) {
  if (!m15Zone) return null;

  if (m15Zone.type === "BUY") {
    const validM5Lows = m5Swings.swingLows.filter(
      (s) => s.price >= m15Zone.low - 5 && s.price <= m15Zone.high + 5
    );
    if (validM5Lows.length > 0) {
      const bestM5Anchor = validM5Lows[validM5Lows.length - 1].price;
      const refinedLow = Math.max(m15Zone.low, bestM5Anchor - 12);
      const refinedHigh = Math.min(m15Zone.high, bestM5Anchor + 12);
      if (refinedHigh - refinedLow >= 18) {
        return {
          type: "BUY",
          low: roundPrice(refinedLow, 2),
          high: roundPrice(refinedHigh, 2),
          width: roundPrice(refinedHigh - refinedLow, 2),
          anchor: roundPrice(bestM5Anchor, 2),
        };
      }
    }
  } else if (m15Zone.type === "SELL") {
    const validM5Highs = m5Swings.swingHighs.filter(
      (s) => s.price >= m15Zone.low - 5 && s.price <= m15Zone.high + 5
    );
    if (validM5Highs.length > 0) {
      const bestM5Anchor = validM5Highs[validM5Highs.length - 1].price;
      const refinedLow = Math.max(m15Zone.low, bestM5Anchor - 12);
      const refinedHigh = Math.min(m15Zone.high, bestM5Anchor + 12);
      if (refinedHigh - refinedLow >= 18) {
        return {
          type: "SELL",
          low: roundPrice(refinedLow, 2),
          high: roundPrice(refinedHigh, 2),
          width: roundPrice(refinedHigh - refinedLow, 2),
          anchor: roundPrice(bestM5Anchor, 2),
        };
      }
    }
  }

  return m15Zone;
}

// Evaluate Signal Proximity Status
function evaluateZoneStatus(cmp, zone, invalidationLevel) {
  if (!zone) return "NO_SETUP";

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
// 6. SCALPING ENGINE (H1 -> M15 -> M5)
// ==========================================
function analyzeScalping(cmp, h1Struct, m15Struct, m5Swings, m15ATR) {
  let signal = "NEUTRAL";
  let setupType = "MONITORING";
  let baseAnchor = 0;
  let invalidationLevel = 0;
  let reason = "";

  const h1Direction = h1Struct.direction;
  const m15IsSideway = m15Struct.isSideway;

  // QM Detection on M15
  let m15BullishQM = false;
  let m15BearishQM = false;

  if (m15Struct.swingLows.length >= 2 && m15Struct.swingHighs.length >= 2) {
    const l1 = m15Struct.swingLows[m15Struct.swingLows.length - 1];
    const l2 = m15Struct.swingLows[m15Struct.swingLows.length - 2];
    const h1 = m15Struct.swingHighs[m15Struct.swingHighs.length - 1];
    const h2 = m15Struct.swingHighs[m15Struct.swingHighs.length - 2];

    // Bullish QM: Lower Low followed by Higher High (breakout above previous high)
    if (l1.price < l2.price && h1.price > h2.price) {
      m15BullishQM = true;
    }
    // Bearish QM: Higher High followed by Lower Low
    if (h1.price > h2.price && l1.price < l2.price) {
      m15BearishQM = true;
    }
  }

  // --- LOGIC 1: SIDEWAY / RANGE M15 (DO NOT WAIT FOR BREAKOUT) ---
  if (m15IsSideway) {
    if (h1Direction === "BULLISH") {
      signal = "BUY";
      setupType = "RANGE_SUPPORT";
      baseAnchor = m15Struct.keySupport;
      invalidationLevel = baseAnchor - 35;
      reason = "H1 bullish context with M15 range support & continuation bias";
    } else if (h1Direction === "BEARISH") {
      signal = "SELL";
      setupType = "RANGE_RESISTANCE";
      baseAnchor = m15Struct.keyResistance;
      invalidationLevel = baseAnchor + 35;
      reason = "H1 bearish context with M15 range resistance & sell rejection bias";
    } else {
      // Neutral H1: Determine location within M15 range
      const midPoint = (m15Struct.keyResistance + m15Struct.keySupport) / 2;
      if (cmp <= midPoint) {
        signal = "BUY";
        setupType = "RANGE_SUPPORT";
        baseAnchor = m15Struct.keySupport;
        invalidationLevel = baseAnchor - 35;
        reason = "M15 defined range trading, price situated at lower range support";
      } else {
        signal = "SELL";
        setupType = "RANGE_RESISTANCE";
        baseAnchor = m15Struct.keyResistance;
        invalidationLevel = baseAnchor + 35;
        reason = "M15 defined range trading, price situated at upper range resistance";
      }
    }
  }
  // --- LOGIC 2: QM (QUASIMODO) SETUP ---
  else if (m15BullishQM && (h1Direction === "BULLISH" || h1Direction === "NEUTRAL")) {
    signal = "BUY";
    setupType = "QM_LEVEL";
    baseAnchor = m15Struct.prevL2 ? m15Struct.prevL2.price : m15Struct.keySupport;
    invalidationLevel = m15Struct.recentL1.price - 20;
    reason = "M15 Bullish QM structure identified with higher high expansion";
  } else if (m15BearishQM && (h1Direction === "BEARISH" || h1Direction === "NEUTRAL")) {
    signal = "SELL";
    setupType = "QM_LEVEL";
    baseAnchor = m15Struct.prevH2 ? m15Struct.prevH2.price : m15Struct.keyResistance;
    invalidationLevel = m15Struct.recentH1.price + 20;
    reason = "M15 Bearish QM structure identified with lower low breakdown";
  }
  // --- LOGIC 3: TREND CONTINUATION & PULLBACK / RETEST ---
  else if (m15Struct.direction === "BULLISH" && h1Direction !== "BEARISH") {
    signal = "BUY";
    // Check if broken resistance becomes support (RBS)
    if (m15Struct.prevH2 && cmp >= m15Struct.prevH2.price) {
      setupType = "BREAKOUT_RETEST";
      baseAnchor = m15Struct.prevH2.price;
      invalidationLevel = m15Struct.recentL1 ? m15Struct.recentL1.price : baseAnchor - 30;
      reason = "Bullish structure breakout pullback to previous resistance (RBS)";
    } else {
      setupType = "TREND_CONTINUATION";
      baseAnchor = m15Struct.recentL1 ? m15Struct.recentL1.price : m15Struct.keySupport;
      invalidationLevel = baseAnchor - 30;
      reason = "M15 HH/HL trend continuation supported by H1 bullish alignment";
    }
  } else if (m15Struct.direction === "BEARISH" && h1Direction !== "BULLISH") {
    signal = "SELL";
    // Check if broken support becomes resistance (SBR)
    if (m15Struct.prevL2 && cmp <= m15Struct.prevL2.price) {
      setupType = "BREAKOUT_RETEST";
      baseAnchor = m15Struct.prevL2.price;
      invalidationLevel = m15Struct.recentH1 ? m15Struct.recentH1.price : baseAnchor + 30;
      reason = "Bearish structure breakdown pullback to previous support (SBR)";
    } else {
      setupType = "TREND_CONTINUATION";
      baseAnchor = m15Struct.recentH1 ? m15Struct.recentH1.price : m15Struct.keyResistance;
      invalidationLevel = baseAnchor + 30;
      reason = "M15 LH/LL trend continuation supported by H1 bearish alignment";
    }
  } else {
    // Fallback: Default to higher timeframe bias if available
    signal = h1Direction === "BULLISH" ? "BUY" : "SELL";
    setupType = "SR_CONTINUATION";
    baseAnchor = signal === "BUY" ? m15Struct.keySupport : m15Struct.keyResistance;
    invalidationLevel = signal === "BUY" ? baseAnchor - 35 : baseAnchor + 35;
    reason = "Setup aligned with H1 dominant directional context and M15 levels";
  }

  // Zone Generation & M5 Refinement
  const initialZone = buildZone(baseAnchor, signal, m15ATR);
  const refinedZone = refineZoneWithM5(initialZone, m5Swings);

  // Status Check
  const status = evaluateZoneStatus(cmp, refinedZone, invalidationLevel);

  // Targets (Points based calculation with structural clearance)
  let tp1, tp2, sl;
  if (signal === "BUY") {
    tp1 = roundPrice(refinedZone.high + SCALP_TP1_POINTS / 100, 2);
    tp2 = roundPrice(refinedZone.high + SCALP_TP2_POINTS / 100, 2);
    sl = roundPrice(invalidationLevel, 2);
  } else {
    tp1 = roundPrice(refinedZone.low - SCALP_TP1_POINTS / 100, 2);
    tp2 = roundPrice(refinedZone.low - SCALP_TP2_POINTS / 100, 2);
    sl = roundPrice(invalidationLevel, 2);
  }

  // Quality Scoring (70 - 100, purely reflects quality without deleting zone)
  let score = 75;
  if (h1Direction === m15Struct.direction && h1Direction !== "NEUTRAL") score += 12;
  if (setupType === "BREAKOUT_RETEST" || setupType === "QM_LEVEL") score += 8;
  if (status === "READY" || status === "APPROACHING") score += 5;
  score = Math.min(score, 98);

  const setupId = generateSetupId("SCALP", signal, setupType, refinedZone.anchor);

  return {
    setupId,
    signal,
    direction: m15Struct.direction,
    structure: m15Struct.structure,
    zone: {
      type: refinedZone.type,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
    },
    setup: setupType,
    status,
    score,
    entry: roundPrice((refinedZone.low + refinedZone.high) / 2, 2),
    sl,
    tp1,
    tp2,
    tp1_points: SCALP_TP1_POINTS,
    tp2_points: SCALP_TP2_POINTS,
    locked: true,
    reason,
  };
}

// ==========================================
// 7. INTRADAY ENGINE (H4 -> H1 -> M15 -> M5)
// ==========================================
function analyzeIntraday(cmp, h4Struct, h1Struct, m15Struct, m5Swings) {
  let signal = "NEUTRAL";
  let setupType = "SR_LEVEL";
  let anchorPrice = 0;
  let reason = "";

  const h4Direction = h4Struct.direction;
  const h1Direction = h1Struct.direction;

  if (h4Direction === "BULLISH" || (h4Direction === "NEUTRAL" && h1Direction === "BULLISH")) {
    signal = "BUY";
    // Check Fibonacci retracement (0.382 / 0.5 ONLY)
    if (h1Struct.recentH1 && h1Struct.recentL1 && h1Struct.recentH1.price > h1Struct.recentL1.price) {
      const swingRange = h1Struct.recentH1.price - h1Struct.recentL1.price;
      const fib50 = h1Struct.recentH1.price - swingRange * 0.5;
      anchorPrice = fib50;
      setupType = "PULLBACK_FIB_50";
      reason = "H4/H1 Bullish alignment with 50.0% structural Fibonacci pullback";
    } else {
      anchorPrice = h1Struct.keySupport;
      setupType = "PULLBACK_SUPPORT";
      reason = "H4/H1 Bullish structure holding above major demand support";
    }
  } else if (h4Direction === "BEARISH" || (h4Direction === "NEUTRAL" && h1Direction === "BEARISH")) {
    signal = "SELL";
    if (h1Struct.recentH1 && h1Struct.recentL1 && h1Struct.recentH1.price > h1Struct.recentL1.price) {
      const swingRange = h1Struct.recentH1.price - h1Struct.recentL1.price;
      const fib382 = h1Struct.recentL1.price + swingRange * 0.382;
      anchorPrice = fib382;
      setupType = "PULLBACK_FIB_382";
      reason = "H4/H1 Bearish alignment with 38.2% structural Fibonacci pullback";
    } else {
      anchorPrice = h1Struct.keyResistance;
      setupType = "PULLBACK_RESISTANCE";
      reason = "H4/H1 Bearish structure rejection at key higher-timeframe resistance";
    }
  } else {
    signal = cmp < (h4Struct.keyResistance + h4Struct.keySupport) / 2 ? "BUY" : "SELL";
    anchorPrice = signal === "BUY" ? h4Struct.keySupport : h4Struct.keyResistance;
    setupType = "H4_RANGE_BOUNDARY";
    reason = "Intraday consolidation inside major H4 market boundaries";
  }

  const initialZone = buildZone(anchorPrice, signal, 30.0);
  const refinedZone = refineZoneWithM5(initialZone, m5Swings);
  const invalidationLevel = signal === "BUY" ? refinedZone.low - 50 : refinedZone.high + 50;
  const status = evaluateZoneStatus(cmp, refinedZone, invalidationLevel);

  let tp1, tp2, sl;
  if (signal === "BUY") {
    tp1 = roundPrice(refinedZone.high + 10.0, 2); // 1000 points
    tp2 = roundPrice(refinedZone.high + 25.0, 2); // 2500 points
    sl = roundPrice(invalidationLevel, 2);
  } else {
    tp1 = roundPrice(refinedZone.low - 10.0, 2);
    tp2 = roundPrice(refinedZone.low - 25.0, 2);
    sl = roundPrice(invalidationLevel, 2);
  }

  let score = 78;
  if (h4Direction === h1Direction && h4Direction !== "NEUTRAL") score += 10;
  if (setupType.includes("FIB")) score += 6;
  score = Math.min(score, 95);

  const setupId = generateSetupId("INTRADAY", signal, setupType, refinedZone.anchor);

  return {
    setupId,
    signal,
    direction: h4Struct.direction,
    zone: {
      type: refinedZone.type,
      low: refinedZone.low,
      high: refinedZone.high,
      anchor: refinedZone.anchor,
    },
    setup: setupType,
    status,
    score,
    entry: roundPrice((refinedZone.low + refinedZone.high) / 2, 2),
    sl,
    tp1,
    tp2,
    locked: true,
    reason,
  };
}

// ==========================================
// 8. MAIN VERCEL HANDLER EXPORT
// ==========================================
export default async function handler(req, res) {
  // CORS configuration
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
        message: "TWELVE_DATA_API_KEY is not defined in environment variables.",
      });
    }

    // Parallel fetch for H4, H1, M15, M5 (Strictly NO M1)
    const [h4Candles, h1Candles, m15Candles, m5Candles] = await Promise.all([
      fetchTimeframeCandles(SYMBOL, "4h", 40, apiKey),
      fetchTimeframeCandles(SYMBOL, "1h", 45, apiKey),
      fetchTimeframeCandles(SYMBOL, "15min", 50, apiKey),
      fetchTimeframeCandles(SYMBOL, "5min", 50, apiKey),
    ]);

    if (!m5Candles || m5Candles.length === 0) {
      return res.status(502).json({
        status: "error",
        message: "Insufficient market candles received from data feed.",
      });
    }

    // Live Current Market Price (CMP) from the most recent M5 candle close
    const cmp = roundPrice(m5Candles[m5Candles.length - 1].close, 2);

    // Analyze Higher & Lower Timeframe Structures
    const h4Struct = evaluateMarketStructure(h4Candles);
    const h1Struct = evaluateMarketStructure(h1Candles);
    const m15Struct = evaluateMarketStructure(m15Candles);
    const m5Swings = identifySwings(m5Candles, 2, 2);
    const m15ATR = calculateATR(m15Candles, 14);

    // Run Engine Analysis
    const scalpingResult = analyzeScalping(cmp, h1Struct, m15Struct, m5Swings, m15ATR);
    const intradayResult = analyzeIntraday(cmp, h4Struct, h1Struct, m15Struct, m5Swings);

    // Response construction (maintains backward compatibility with frontends)
    const responsePayload = {
      status: "success",
      timestamp: new Date().toISOString(),
      engine: {
        name: "SINNCI MARKET ENGINE PRO",
        version: "PRO-3.0",
        mode: "ACTIVE SCALPING / SELECTIVE INTRADAY",
      },
      market: {
        symbol: SYMBOL,
        price: cmp,
        volatility_atr: roundPrice(m15ATR, 2),
      },
      timeframes: {
        h4: { direction: h4Struct.direction, structure: h4Struct.structure },
        h1: { direction: h1Struct.direction, structure: h1Struct.structure },
        m15: {
          direction: m15Struct.direction,
          structure: m15Struct.structure,
          isSideway: m15Struct.isSideway,
          support: roundPrice(m15Struct.keySupport, 2),
          resistance: roundPrice(m15Struct.keyResistance, 2),
        },
      },
      scalping: scalpingResult,
      intraday: intradayResult,

      // Direct compatibility properties for legacy UI widgets
      signal: scalpingResult.signal,
      zone: scalpingResult.zone,
      score: scalpingResult.score,
      status: scalpingResult.status,
      entry: scalpingResult.entry,
      sl: scalpingResult.sl,
      tp1: scalpingResult.tp1,
      tp2: scalpingResult.tp2,
      plan: `${scalpingResult.signal} XAUUSD at [${scalpingResult.zone.low} - ${scalpingResult.zone.high}] | Status: ${scalpingResult.status}`,
    };

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error("SINNCI ENGINE ERROR:", error);
    return res.status(500).json({
      status: "error",
      message: error.message || "An unexpected error occurred in market analysis engine.",
    });
  }
}
