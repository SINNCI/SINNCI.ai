// ============================================================
// SINNCI AI
// MARKET ANALYSIS ENGINE PRO
// XAUUSD / GOLD
//
// NOT AUTOMATED TRADING
// MARKET ANALYSIS + SIGNAL / ENTRY-ZONE MAPPING ONLY
//
// Vercel Serverless Function
// api/analyze.js
// ============================================================

const SYMBOL = "XAU/USD";

const ENGINE_NAME = "SINNCI MARKET ENGINE PRO";
const ENGINE_VERSION = "PRO-3.0";

// Gold price convention used by SINNCI:
// 1 point = 0.01 price
const POINT_SIZE = 0.01;

// ------------------------------------------------------------
// TARGETS
// ------------------------------------------------------------

const SCALP_TP1_POINTS = 600;
const SCALP_TP2_POINTS = 1200;

const INTRADAY_TP1_POINTS = 150;
const INTRADAY_TP2_POINTS = 230;

// ------------------------------------------------------------
// ZONE SIZE
// 25–35 points = 0.25–0.35 price
// ------------------------------------------------------------

const NORMAL_ZONE_POINTS = 25;
const FAST_ZONE_POINTS = 35;

// ------------------------------------------------------------
// GENERAL HELPERS
// ------------------------------------------------------------

function roundPrice(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr || !arr.length) return 0;

  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);

  return a.length % 2
    ? a[mid]
    : (a[mid - 1] + a[mid]) / 2;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampIndex(index, min, max) {
  return Math.max(min, Math.min(max, index));
}

// Deterministic hash.
// IMPORTANT:
// No Math.random()
// No Date.now()
// No random setup ID.
//
// Same structural setup => same setupId.
function deterministicHash(input) {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return ("00000000" + (hash >>> 0).toString(16)).slice(-8);
}

function getSetupId({
  direction,
  setup,
  timeframe,
  zoneLow,
  zoneHigh,
  anchorTime,
  structureTime
}) {
  const raw = [
    direction,
    setup,
    timeframe,
    roundPrice(zoneLow),
    roundPrice(zoneHigh),
    anchorTime || "",
    structureTime || ""
  ].join("|");

  return `SINNCI-${deterministicHash(raw)}`;
}

// ============================================================
// MARKET DATA
// ============================================================

async function fetchTimeSeries(interval, outputsize, apiKey) {
  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Twelve Data network error for ${interval}: ${error.message}`
    );
  }

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Twelve Data returned non-JSON response for ${interval}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}: ${
        data?.message || "Unknown API error"
      }`
    );
  }

  if (data?.status === "error") {
    throw new Error(
      `Twelve Data ${interval}: ${
        data?.message || "Unknown API error"
      }`
    );
  }

  if (!Array.isArray(data?.values) || data.values.length < 20) {
    throw new Error(
      `Insufficient ${interval} market data`
    );
  }

  return normalizeCandles(data.values);
}

function normalizeCandles(values) {
  const candles = values
    .map((v) => ({
      datetime: String(v.datetime || ""),
      timestamp: parseTimestamp(v.datetime),
      open: safeNumber(v.open),
      high: safeNumber(v.high),
      low: safeNumber(v.low),
      close: safeNumber(v.close),
      volume: safeNumber(v.volume)
    }))
    .filter(
      (c) =>
        c.timestamp &&
        c.open !== null &&
        c.high !== null &&
        c.low !== null &&
        c.close !== null &&
        c.high >= c.low
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  return candles;
}

function parseTimestamp(value) {
  if (!value) return 0;

  const direct = Date.parse(value);

  if (Number.isFinite(direct)) {
    return direct;
  }

  const normalized = String(value).replace(" ", "T");
  const secondTry = Date.parse(`${normalized}Z`);

  return Number.isFinite(secondTry) ? secondTry : 0;
}

// ============================================================
// CLOSED CANDLES
//
// Structure must not jump around because the currently forming
// candle changes every request.
//
// Therefore structure calculations use closed candles.
// Current price can still use the latest available M5 close.
// ============================================================

function getClosedCandles(candles) {
  if (!candles || candles.length < 5) {
    return candles || [];
  }

  // Twelve Data normally returns the newest candle first.
  // After normalization ascending, last candle is latest.
  //
  // We remove latest candle from structure calculations
  // to reduce repaint-like behaviour.
  return candles.slice(0, -1);
}

// ============================================================
// ATR
// ============================================================

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return 0;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  return average(recent);
}

// ============================================================
// MARKET STRUCTURE
// HH / HL / LH / LL
// ============================================================

function detectSwings(candles, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  if (!candles || candles.length < left + right + 5) {
    return { highs, lows };
  }

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const c = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;

      if (candles[j].high >= c.high) {
        isHigh = false;
      }

      if (candles[j].low <= c.low) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: c.high,
        timestamp: c.timestamp,
        datetime: c.datetime
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: c.low,
        timestamp: c.timestamp,
        datetime: c.datetime
      });
    }
  }

  return { highs, lows };
}

function classifyStructure(swings) {
  const highs = swings.highs || [];
  const lows = swings.lows || [];

  let highRelation = null;
  let lowRelation = null;

  if (highs.length >= 2) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];

    highRelation =
      h2.price > h1.price
        ? "HH"
        : h2.price < h1.price
        ? "LH"
        : "EQ";
  }

  if (lows.length >= 2) {
    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];

    lowRelation =
      l2.price > l1.price
        ? "HL"
        : l2.price < l1.price
        ? "LL"
        : "EQ";
  }

  let direction = "NEUTRAL";
  let label = "NEUTRAL";

  if (
    highRelation === "HH" &&
    lowRelation === "HL"
  ) {
    direction = "BULLISH";
    label = "HH_HL";
  } else if (
    highRelation === "LH" &&
    lowRelation === "LL"
  ) {
    direction = "BEARISH";
    label = "LH_LL";
  } else if (
    highRelation === "HH" ||
    lowRelation === "HL"
  ) {
    direction = "BULLISH";
    label = highRelation || lowRelation || "BULLISH";
  } else if (
    highRelation === "LH" ||
    lowRelation === "LL"
  ) {
    direction = "BEARISH";
    label = highRelation || lowRelation || "BEARISH";
  }

  return {
    direction,
    label,
    highRelation,
    lowRelation,
    lastHigh:
      highs.length
        ? highs[highs.length - 1]
        : null,
    previousHigh:
      highs.length >= 2
        ? highs[highs.length - 2]
        : null,
    lastLow:
      lows.length
        ? lows[lows.length - 1]
        : null,
    previousLow:
      lows.length >= 2
        ? lows[lows.length - 2]
        : null
  };
}

// ============================================================
// SUPPORT / RESISTANCE
// ============================================================

function clusterLevels(points, tolerance) {
  if (!points || !points.length) return [];

  const sorted = [...points].sort(
    (a, b) => a.price - b.price
  );

  const clusters = [];

  for (const point of sorted) {
    let target = null;

    for (const cluster of clusters) {
      if (
        Math.abs(
          point.price - cluster.center
        ) <= tolerance
      ) {
        target = cluster;
        break;
      }
    }

    if (!target) {
      clusters.push({
        center: point.price,
        points: [point]
      });
    } else {
      target.points.push(point);

      target.center = average(
        target.points.map((p) => p.price)
      );
    }
  }

  return clusters
    .map((cluster) => {
      const timestamps = cluster.points
        .map((p) => p.timestamp)
        .sort((a, b) => b - a);

      const latest = timestamps[0] || 0;

      return {
        level: roundPrice(cluster.center),
        touches: cluster.points.length,
        latestTimestamp: latest,
        latestDatetime:
          cluster.points.find(
            (p) => p.timestamp === latest
          )?.datetime || null,
        points: cluster.points
      };
    })
    .sort((a, b) => {
      if (b.touches !== a.touches) {
        return b.touches - a.touches;
      }

      return b.latestTimestamp - a.latestTimestamp;
    });
}

function findSupportResistance(
  candles,
  swings,
  atr
) {
  const tolerance = clamp(
    atr > 0 ? atr * 0.18 : 0.35,
    0.18,
    0.55
  );

  const supportPoints = [];
  const resistancePoints = [];

  for (const low of swings.lows) {
    supportPoints.push({
      price: low.price,
      timestamp: low.timestamp,
      datetime: low.datetime,
      type: "SWING_LOW"
    });
  }

  for (const high of swings.highs) {
    resistancePoints.push({
      price: high.price,
      timestamp: high.timestamp,
      datetime: high.datetime,
      type: "SWING_HIGH"
    });
  }

  // Recent consolidation boundaries.
  const recent = candles.slice(-30);

  if (recent.length >= 10) {
    const recentHigh = Math.max(
      ...recent.map((c) => c.high)
    );

    const recentLow = Math.min(
      ...recent.map((c) => c.low)
    );

    const highCandle = recent.reduce(
      (best, c) =>
        c.high >= best.high ? c : best,
      recent[0]
    );

    const lowCandle = recent.reduce(
      (best, c) =>
        c.low <= best.low ? c : best,
      recent[0]
    );

    resistancePoints.push({
      price: recentHigh,
      timestamp: highCandle.timestamp,
      datetime: highCandle.datetime,
      type: "CONSOLIDATION_HIGH"
    });

    supportPoints.push({
      price: recentLow,
      timestamp: lowCandle.timestamp,
      datetime: lowCandle.datetime,
      type: "CONSOLIDATION_LOW"
    });
  }

  const supports = clusterLevels(
    supportPoints,
    tolerance
  );

  const resistances = clusterLevels(
    resistancePoints,
    tolerance
  );

  return {
    supports,
    resistances,
    tolerance
  };
}

// ============================================================
// RANGE DETECTION
// ============================================================

function detectRange(candles, atr, structure) {
  if (!candles || candles.length < 20) {
    return {
      ranging: false,
      low: null,
      high: null,
      width: null
    };
  }

  const recent = candles.slice(-20);

  const high = Math.max(
    ...recent.map((c) => c.high)
  );

  const low = Math.min(
    ...recent.map((c) => c.low)
  );

  const width = high - low;

  // Range should be meaningful but not simply one tiny candle.
  const rangeThreshold =
    atr > 0 ? atr * 3.8 : 5;

  const ranging =
    width <= rangeThreshold &&
    structure.direction === "NEUTRAL";

  return {
    ranging,
    low: roundPrice(low),
    high: roundPrice(high),
    width: roundPrice(width)
  };
}

// ============================================================
// VOLATILITY / ADAPTIVE ZONE
// ============================================================

function getZoneWidthPoints(atr, m5Atr = 0) {
  const combined =
    atr > 0 && m5Atr > 0
      ? (atr + m5Atr * 3) / 4
      : atr || m5Atr || 0;

  // Normal gold volatility:
  // 25 points
  //
  // Fast gold:
  // 30–35 points
  //
  // Never exceed 35.
  if (combined >= 2.8) {
    return FAST_ZONE_POINTS;
  }

  if (combined >= 1.8) {
    return 30;
  }

  return NORMAL_ZONE_POINTS;
}

function makeZone(center, direction, widthPoints) {
  const width = widthPoints * POINT_SIZE;

  let low;
  let high;

  if (direction === "BUY") {
    low = center - width / 2;
    high = center + width / 2;
  } else {
    low = center - width / 2;
    high = center + width / 2;
  }

  return {
    type: direction,
    low: roundPrice(low),
    high: roundPrice(high),
    widthPoints
  };
}

// ============================================================
// M5 REFINEMENT
// ============================================================

function refineZoneWithM5(
  baseZone,
  m5Candles,
  direction,
  m5Swings
) {
  if (!baseZone || !m5Candles?.length) {
    return baseZone;
  }

  const tolerance = 0.20;

  const relevant =
    direction === "BUY"
      ? m5Swings.lows
      : m5Swings.highs;

  const candidates = relevant.filter(
    (s) =>
      s.price >= baseZone.low - tolerance &&
      s.price <= baseZone.high + tolerance
  );

  if (!candidates.length) {
    return baseZone;
  }

  // Choose the most recent relevant structural point.
  const anchor = candidates
    .sort(
      (a, b) => b.timestamp - a.timestamp
    )[0];

  const width =
    baseZone.widthPoints * POINT_SIZE;

  const center = anchor.price;

  let low = center - width / 2;
  let high = center + width / 2;

  // Never allow M5 refinement to become too small.
  const minimumWidth =
    NORMAL_ZONE_POINTS * POINT_SIZE;

  if (high - low < minimumWidth) {
    low =
      center -
      minimumWidth / 2;

    high =
      center +
      minimumWidth / 2;
  }

  return {
    ...baseZone,
    low: roundPrice(low),
    high: roundPrice(high),
    refinementAnchor: {
      price: roundPrice(anchor.price),
      timestamp: anchor.timestamp,
      datetime: anchor.datetime
    }
  };
}

// ============================================================
// BREAKOUT / RETEST DETECTION
// ============================================================

function detectBreakoutRetest(
  candles,
  sr,
  direction
) {
  if (!candles || candles.length < 15) {
    return null;
  }

  const recent = candles.slice(-12);

  if (
    direction === "BUY" &&
    sr.resistances.length
  ) {
    const resistance =
      sr.resistances
        .slice()
        .sort(
          (a, b) =>
            b.latestTimestamp -
            a.latestTimestamp
        )
        .find((r) => r.touches >= 1);

    if (!resistance) return null;

    const level = resistance.level;

    const breakout = recent.find(
      (c) => c.close > level + 0.05
    );

    if (!breakout) return null;

    const after = recent.filter(
      (c) =>
        c.timestamp >= breakout.timestamp
    );

    const retest = after.find(
      (c) =>
        c.low <= level + 0.12 &&
        c.low >= level - 0.35 &&
        c.close >= level
    );

    if (!retest) return null;

    return {
      direction: "BUY",
      type: "BREAKOUT_RETEST",
      level,
      anchorTimestamp: resistance.latestTimestamp,
      breakoutTimestamp: breakout.timestamp,
      retestTimestamp: retest.timestamp
    };
  }

  if (
    direction === "SELL" &&
    sr.supports.length
  ) {
    const support =
      sr.supports
        .slice()
        .sort(
          (a, b) =>
            b.latestTimestamp -
            a.latestTimestamp
        )
        .find((s) => s.touches >= 1);

    if (!support) return null;

    const level = support.level;

    const breakout = recent.find(
      (c) => c.close < level - 0.05
    );

    if (!breakout) return null;

    const after = recent.filter(
      (c) =>
        c.timestamp >= breakout.timestamp
    );

    const retest = after.find(
      (c) =>
        c.high >= level - 0.12 &&
        c.high <= level + 0.35 &&
        c.close <= level
    );

    if (!retest) return null;

    return {
      direction: "SELL",
      type: "BREAKOUT_RETEST",
      level,
      anchorTimestamp: support.latestTimestamp,
      breakoutTimestamp: breakout.timestamp,
      retestTimestamp: retest.timestamp
    };
  }

  return null;
}

// ============================================================
// PULLBACK DETECTION
// ============================================================

function findTrendContinuationLevel(
  sr,
  direction,
  price
) {
  if (direction === "BUY") {
    const candidates = sr.supports
      .filter((s) => s.level <= price + 2)
      .sort((a, b) => {
        const da = Math.abs(price - a.level);
        const db = Math.abs(price - b.level);

        if (da !== db) {
          return da - db;
        }

        return b.touches - a.touches;
      });

    return candidates[0] || null;
  }

  if (direction === "SELL") {
    const candidates = sr.resistances
      .filter((r) => r.level >= price - 2)
      .sort((a, b) => {
        const da = Math.abs(price - a.level);
        const db = Math.abs(price - b.level);

        if (da !== db) {
          return da - db;
        }

        return b.touches - a.touches;
      });

    return candidates[0] || null;
  }

  return null;
}

// ============================================================
// RANGE SETUP
//
// SIDEWAY DOES NOT AUTOMATICALLY MEAN WAIT BREAKOUT.
//
// If M15 is ranging:
// H1 context
// +
// range boundary
// +
// M5 refinement
// = setup candidate
// ============================================================

function findRangeSetup(
  m15Range,
  m15SR,
  h1Direction,
  price
) {
  if (!m15Range?.ranging) {
    return null;
  }

  const supportCandidates =
    m15SR.supports.filter(
      (s) =>
        s.level >=
          m15Range.low - 0.35 &&
        s.level <=
          m15Range.low + 0.55
    );

  const resistanceCandidates =
    m15SR.resistances.filter(
      (r) =>
        r.level <=
          m15Range.high + 0.35 &&
        r.level >=
          m15Range.high - 0.55
    );

  const support =
    supportCandidates.sort(
      (a, b) =>
        b.touches - a.touches
    )[0] || null;

  const resistance =
    resistanceCandidates.sort(
      (a, b) =>
        b.touches - a.touches
    )[0] || null;

  // Higher-TF bullish:
  // prioritize lower range / support.
  if (
    h1Direction === "BULLISH" &&
    support
  ) {
    return {
      direction: "BUY",
      type: "RANGE_SUPPORT",
      level: support.level,
      anchorTimestamp:
        support.latestTimestamp,
      touches: support.touches
    };
  }

  // Higher-TF bearish:
  // prioritize upper range / resistance.
  if (
    h1Direction === "BEARISH" &&
    resistance
  ) {
    return {
      direction: "SELL",
      type: "RANGE_RESISTANCE",
      level: resistance.level,
      anchorTimestamp:
        resistance.latestTimestamp,
      touches: resistance.touches
    };
  }

  // Neutral H1:
  // only use range if the structure is strong.
  if (
    h1Direction === "NEUTRAL"
  ) {
    if (
      support &&
      resistance
    ) {
      const distSupport =
        Math.abs(price - support.level);

      const distResistance =
        Math.abs(
          price - resistance.level
        );

      if (
        distSupport <=
        distResistance
      ) {
        return {
          direction: "BUY",
          type: "RANGE_SUPPORT",
          level: support.level,
          anchorTimestamp:
            support.latestTimestamp,
          touches: support.touches
        };
      }

      return {
        direction: "SELL",
        type: "RANGE_RESISTANCE",
        level: resistance.level,
        anchorTimestamp:
          resistance.latestTimestamp,
        touches: resistance.touches
      };
    }
  }

  return null;
}

// ============================================================
// QM-STYLE STRUCTURE
//
// This is intentionally conservative.
// It only labels QM when the swing sequence is clear.
// ============================================================

function detectQM(
  swings,
  direction
) {
  const highs = swings.highs || [];
  const lows = swings.lows || [];

  if (
    highs.length < 3 ||
    lows.length < 3
  ) {
    return null;
  }

  const h1 = highs[highs.length - 3];
  const h2 = highs[highs.length - 2];
  const h3 = highs[highs.length - 1];

  const l1 = lows[lows.length - 3];
  const l2 = lows[lows.length - 2];
  const l3 = lows[lows.length - 1];

  if (direction === "BUY") {
    // QM-like bullish sequence:
    // lower low -> break of prior high -> higher pullback.
    if (
      l2.price < l1.price &&
      h3.price > h2.price &&
      l3.price > l2.price
    ) {
      return {
        type: "QM_BUY",
        level: l3.price,
        timestamp: l3.timestamp
      };
    }
  }

  if (direction === "SELL") {
    // QM-like bearish sequence:
    // higher high -> break of prior low -> lower pullback.
    if (
      h2.price > h1.price &&
      l3.price < l2.price &&
      h3.price < h2.price
    ) {
      return {
        type: "QM_SELL",
        level: h3.price,
        timestamp: h3.timestamp
      };
    }
  }

  return null;
}

// ============================================================
// TRENDLINE-STYLE REACTION
//
// This does not force a trendline trade.
// It only gives additional setup context.
// ============================================================

function detectTrendlineContext(
  swings,
  direction,
  price
) {
  if (direction === "BUY") {
    const lows = swings.lows || [];

    if (lows.length >= 3) {
      const a = lows[lows.length - 3];
      const b = lows[lows.length - 2];
      const c = lows[lows.length - 1];

      const rising =
        b.price > a.price &&
        c.price > b.price;

      if (rising) {
        return {
          valid: true,
          type: "RISING_TRENDLINE",
          level: c.price,
          timestamp: c.timestamp
        };
      }
    }
  }

  if (direction === "SELL") {
    const highs = swings.highs || [];

    if (highs.length >= 3) {
      const a = highs[highs.length - 3];
      const b = highs[highs.length - 2];
      const c = highs[highs.length - 1];

      const falling =
        b.price < a.price &&
        c.price < b.price;

      if (falling) {
        return {
          valid: true,
          type: "FALLING_TRENDLINE",
          level: c.price,
          timestamp: c.timestamp
        };
      }
    }
  }

  return null;
}

// ============================================================
// ZONE INVALIDATION
//
// SCORE DOES NOT INVALIDATE ZONE.
//
// Only structural failure does.
// ============================================================

function isZoneStructurallyValid(
  direction,
  zone,
  m15Candles,
  m15Structure
) {
  if (!zone || !m15Candles?.length) {
    return false;
  }

  const last = m15Candles[m15Candles.length - 1];

  const buffer = 0.10;

  if (direction === "BUY") {
    // Clear bearish break through the entire support zone.
    if (
      last.close <
      zone.low - buffer
    ) {
      return false;
    }

    // Strong LL context against support.
    if (
      m15Structure.direction === "BEARISH" &&
      last.close <
        zone.low - buffer
    ) {
      return false;
    }
  }

  if (direction === "SELL") {
    // Clear bullish break through the entire resistance zone.
    if (
      last.close >
      zone.high + buffer
    ) {
      return false;
    }

    if (
      m15Structure.direction === "BULLISH" &&
      last.close >
        zone.high + buffer
    ) {
      return false;
    }
  }

  return true;
}

// ============================================================
// STATUS
// ============================================================

function calculateStatus(
  price,
  zone,
  direction
) {
  if (!zone) {
    return "WATCH";
  }

  if (
    price >= zone.low &&
    price <= zone.high
  ) {
    return "READY";
  }

  const zoneWidth =
    zone.high - zone.low;

  const approachDistance =
    Math.max(
      zoneWidth * 1.5,
      0.35
    );

  if (direction === "BUY") {
    const distance =
      zone.low - price;

    if (
      distance >= 0 &&
      distance <= approachDistance
    ) {
      return "APPROACHING";
    }

    return "WATCH";
  }

  if (direction === "SELL") {
    const distance =
      price - zone.high;

    if (
      distance >= 0 &&
      distance <= approachDistance
    ) {
      return "APPROACHING";
    }

    return "WATCH";
  }

  return "WATCH";
}

// ============================================================
// SCORE
//
// Score describes QUALITY.
// It does not create/delete the setup.
// ============================================================

function scoreSetup({
  direction,
  setupType,
  h1Direction,
  m15Direction,
  m5Direction,
  touches,
  price,
  zone,
  opposingDistance,
  isRange,
  isBreakoutRetest,
  isQM,
  trendline
}) {
  let score = 50;

  // Higher-TF alignment.
  if (
    direction === "BUY" &&
    h1Direction === "BULLISH"
  ) {
    score += 14;
  }

  if (
    direction === "SELL" &&
    h1Direction === "BEARISH"
  ) {
    score += 14;
  }

  // M15 setup alignment.
  if (
    direction === "BUY" &&
    m15Direction === "BULLISH"
  ) {
    score += 10;
  }

  if (
    direction === "SELL" &&
    m15Direction === "BEARISH"
  ) {
    score += 10;
  }

  // M5 refinement.
  if (
    direction === "BUY" &&
    m5Direction === "BULLISH"
  ) {
    score += 5;
  }

  if (
    direction === "SELL" &&
    m5Direction === "BEARISH"
  ) {
    score += 5;
  }

  // Repeated reaction.
  score += clamp(
    (touches || 0) * 2,
    0,
    10
  );

  // Range setup is valid, not automatically weak.
  if (isRange) {
    score += 5;
  }

  if (isBreakoutRetest) {
    score += 7;
  }

  if (isQM) {
    score += 6;
  }

  if (trendline) {
    score += 3;
  }

  // Price proximity.
  if (zone) {
    const distance =
      direction === "BUY"
        ? Math.max(
            0,
            zone.low - price
          )
        : Math.max(
            0,
            price - zone.high
          );

    if (distance <= 0.20) {
      score += 5;
    } else if (distance <= 0.50) {
      score += 3;
    }
  }

  // Room to opposing structure.
  if (
    Number.isFinite(opposingDistance)
  ) {
    if (opposingDistance >= 2.5) {
      score += 7;
    } else if (
      opposingDistance >= 1.5
    ) {
      score += 4;
    } else if (
      opposingDistance < 0.9
    ) {
      score -= 12;
    }
  }

  return Math.round(
    clamp(score, 0, 100)
  );
}

function scoreLabel(score) {
  if (score >= 90) {
    return "VERY STRONG";
  }

  if (score >= 80) {
    return "STRONG";
  }

  if (score >= 70) {
    return "VALID";
  }

  return "WEAK / WATCH";
}

// ============================================================
// OPPOSING STRUCTURE / TARGET ROOM
// ============================================================

function getOpposingLevel(
  direction,
  price,
  sr
) {
  if (direction === "BUY") {
    const candidates =
      sr.resistances
        .map((r) => r.level)
        .filter((level) => level > price)
        .sort((a, b) => a - b);

    return candidates[0] ?? null;
  }

  if (direction === "SELL") {
    const candidates =
      sr.supports
        .map((s) => s.level)
        .filter((level) => level < price)
        .sort((a, b) => b - a);

    return candidates[0] ?? null;
  }

  return null;
}

function hasTargetRoom(
  direction,
  zone,
  sr,
  tp1Points,
  tp2Points
) {
  if (!zone) {
    return {
      valid: false,
      opposingLevel: null,
      opposingDistance: null
    };
  }

  const entry =
    (zone.low + zone.high) / 2;

  const opposing =
    getOpposingLevel(
      direction,
      entry,
      sr
    );

  const opposingDistance =
    opposing === null
      ? Infinity
      : Math.abs(
          opposing - entry
        );

  const tp1Distance =
    tp1Points * POINT_SIZE;

  const tp2Distance =
    tp2Points * POINT_SIZE;

  // TP1 should have reasonable space.
  // TP2 can be beyond a nearby structure only
  // if there is still enough room.
  const valid =
    opposing === null ||
    opposingDistance >=
      tp1Distance * 0.90;

  return {
    valid,
    opposingLevel:
      opposing === null
        ? null
        : roundPrice(opposing),
    opposingDistance:
      opposing === null
        ? null
        : roundPrice(opposingDistance),
    tp1Distance,
    tp2Distance
  };
}

// ============================================================
// PLAN
// ============================================================

function buildTradePlan({
  direction,
  zone,
  tp1Points,
  tp2Points,
  opposingLevel
}) {
  if (!zone) {
    return {
      entry: null,
      sl: null,
      tp1: null,
      tp2: null
    };
  }

  const entry = roundPrice(
    (zone.low + zone.high) / 2
  );

  // SL buffer is structural, not arbitrary micro-SL.
  const zoneWidth =
    zone.high - zone.low;

  const slBuffer = clamp(
    zoneWidth * 0.75,
    0.18,
    0.45
  );

  let sl;

  if (direction === "BUY") {
    sl = roundPrice(
      zone.low - slBuffer
    );
  } else {
    sl = roundPrice(
      zone.high + slBuffer
    );
  }

  let tp1;
  let tp2;

  if (direction === "BUY") {
    tp1 = roundPrice(
      entry +
        tp1Points * POINT_SIZE
    );

    tp2 = roundPrice(
      entry +
        tp2Points * POINT_SIZE
    );
  } else {
    tp1 = roundPrice(
      entry -
        tp1Points * POINT_SIZE
    );

    tp2 = roundPrice(
      entry -
        tp2Points * POINT_SIZE
    );
  }

  return {
    entry,
    sl,
    tp1,
    tp2,
    opposingLevel,
    tp1Points,
    tp2Points
  };
}

// ============================================================
// CANDIDATE BUILDER
// ============================================================

function buildCandidate({
  direction,
  setupType,
  level,
  anchorTimestamp,
  anchorDatetime,
  timeframe,
  zoneWidthPoints,
  h1Structure,
  m15Structure,
  m5Structure,
  m15Candles,
  m5Candles,
  m15SR,
  price,
  touches = 0,
  reasonParts = [],
  isRange = false,
  isBreakoutRetest = false,
  isQM = false,
  trendline = false,
  targetPoints
}) {
  if (!Number.isFinite(level)) {
    return null;
  }

  let zone = makeZone(
    level,
    direction,
    zoneWidthPoints
  );

  // M5 only refines the M15 structural area.
  const m5Swings =
    detectSwings(
      m5Candles,
      2,
      2
    );

  zone = refineZoneWithM5(
    zone,
    m5Candles,
    direction,
    m5Swings
  );

  if (
    !isZoneStructurallyValid(
      direction,
      zone,
      m15Candles,
      m15Structure
    )
  ) {
    return null;
  }

  const room = hasTargetRoom(
    direction,
    zone,
    m15SR,
    targetPoints.tp1,
    targetPoints.tp2
  );

  if (!room.valid) {
    return null;
  }

  const score = scoreSetup({
    direction,
    setupType,
    h1Direction:
      h1Structure.direction,
    m15Direction:
      m15Structure.direction,
    m5Direction:
      m5Structure.direction,
    touches,
    price,
    zone,
    opposingDistance:
      room.opposingDistance,
    isRange,
    isBreakoutRetest,
    isQM,
    trendline
  });

  const status =
    calculateStatus(
      price,
      zone,
      direction
    );

  const structureTime =
    m15Structure.lastHigh?.datetime ||
    m15Structure.lastLow?.datetime ||
    "";

  const setupId =
    getSetupId({
      direction,
      setup: setupType,
      timeframe,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      anchorTime:
        anchorDatetime ||
        String(anchorTimestamp || ""),
      structureTime
    });

  const plan =
    buildTradePlan({
      direction,
      zone,
      tp1Points:
        targetPoints.tp1,
      tp2Points:
        targetPoints.tp2,
      opposingLevel:
        room.opposingLevel
    });

  return {
    setupId,
    signal: direction,
    direction:
      direction === "BUY"
        ? "BULLISH"
        : "BEARISH",
    structure:
      m15Structure.label,
    zone: {
      type: direction,
      low: zone.low,
      high: zone.high,
      widthPoints:
        zone.widthPoints
    },
    setup: setupType,
    status,
    score,
    scoreLabel:
      scoreLabel(score),
    locked: true,
    invalidation: {
      type: "STRUCTURAL",
      rule:
        direction === "BUY"
          ? "M15 support structure must remain valid"
          : "M15 resistance structure must remain valid"
    },
    plan,
    entry: plan.entry,
    sl: plan.sl,
    tp1: plan.tp1,
    tp2: plan.tp2,
    tp1Points:
      targetPoints.tp1,
    tp2Points:
      targetPoints.tp2,
    opposingLevel:
      room.opposingLevel,
    reason:
      reasonParts.length
        ? reasonParts.join(", ")
        : "Structural S/R setup",
    anchor: {
      timeframe,
      timestamp:
        anchorTimestamp || null,
      datetime:
        anchorDatetime || null
    }
  };
}

// ============================================================
// SELECT BEST CANDIDATE
//
// We do NOT simply select highest score.
// Structural priority comes first.
// ============================================================

function candidatePriority(candidate, price) {
  if (!candidate) return -Infinity;

  let priority = 0;

  if (
    candidate.status === "READY"
  ) {
    priority += 30;
  } else if (
    candidate.status === "APPROACHING"
  ) {
    priority += 20;
  } else {
    priority += 10;
  }

  priority +=
    candidate.score * 0.5;

  if (
    candidate.setup ===
    "RANGE_SUPPORT" ||
    candidate.setup ===
    "RANGE_RESISTANCE"
  ) {
    priority += 8;
  }

  if (
    candidate.setup ===
    "BREAKOUT_RETEST"
  ) {
    priority += 10;
  }

  if (
    candidate.setup ===
    "QM_BUY" ||
    candidate.setup ===
    "QM_SELL"
  ) {
    priority += 6;
  }

  const zoneDistance =
    candidate.signal === "BUY"
      ? Math.max(
          0,
          candidate.zone.low -
            price
        )
      : Math.max(
          0,
          price -
            candidate.zone.high
        );

  priority -=
    Math.min(zoneDistance, 5) *
    1.5;

  return priority;
}

function chooseCandidate(
  candidates,
  price
) {
  const valid =
    candidates.filter(Boolean);

  if (!valid.length) {
    return null;
  }

  return valid.sort(
    (a, b) =>
      candidatePriority(
        b,
        price
      ) -
      candidatePriority(
        a,
        price
      )
  )[0];
}

// ============================================================
// INTRADAY FIBONACCI
//
// ONLY:
// 0.382
// 0.5
//
// NEVER:
// 0.618
// 0.705
// 0.786
// ============================================================

function findIntradayFibZone(
  h1Structure,
  h1Swings,
  direction
) {
  if (
    !h1Swings?.highs?.length ||
    !h1Swings?.lows?.length
  ) {
    return null;
  }

  const lastHigh =
    h1Swings.highs[
      h1Swings.highs.length - 1
    ];

  const lastLow =
    h1Swings.lows[
      h1Swings.lows.length - 1
    ];

  if (
    direction === "BUY" &&
    h1Structure.direction ===
      "BULLISH"
  ) {
    const range =
      lastHigh.price -
      lastLow.price;

    if (range <= 0) return null;

    const fib382 =
      lastHigh.price -
      range * 0.382;

    const fib500 =
      lastHigh.price -
      range * 0.5;

    return {
      low:
        Math.min(
          fib382,
          fib500
        ),
      high:
        Math.max(
          fib382,
          fib500
        ),
      anchorTimestamp:
        lastHigh.timestamp,
      anchorDatetime:
        lastHigh.datetime,
      label:
        "INTRADAY_FIB_0.382_0.5"
    };
  }

  if (
    direction === "SELL" &&
    h1Structure.direction ===
      "BEARISH"
  ) {
    const range =
      lastHigh.price -
      lastLow.price;

    if (range <= 0) return null;

    const fib382 =
      lastLow.price +
      range * 0.382;

    const fib500 =
      lastLow.price +
      range * 0.5;

    return {
      low:
        Math.min(
          fib382,
          fib500
        ),
      high:
        Math.max(
          fib382,
          fib500
        ),
      anchorTimestamp:
        lastLow.timestamp,
      anchorDatetime:
        lastLow.datetime,
      label:
        "INTRADAY_FIB_0.382_0.5"
    };
  }

  return null;
}

// ============================================================
// SCALPING ENGINE
// H1 -> M15 -> M5
//
// NO H4
// NO M1
// NO FIBONACCI
// ============================================================

function analyzeScalping({
  price,
  h1Candles,
  m15Candles,
  m5Candles
}) {
  const h1Swings =
    detectSwings(
      h1Candles,
      2,
      2
    );

  const m15Swings =
    detectSwings(
      m15Candles,
      2,
      2
    );

  const m5Swings =
    detectSwings(
      m5Candles,
      2,
      2
    );

  const h1Structure =
    classifyStructure(
      h1Swings
    );

  const m15Structure =
    classifyStructure(
      m15Swings
    );

  const m5Structure =
    classifyStructure(
      m5Swings
    );

  const h1ATR =
    calculateATR(
      h1Candles,
      14
    );

  const m15ATR =
    calculateATR(
      m15Candles,
      14
    );

  const m5ATR =
    calculateATR(
      m5Candles,
      14
    );

  const m15SR =
    findSupportResistance(
      m15Candles,
      m15Swings,
      m15ATR
    );

  const m15Range =
    detectRange(
      m15Candles,
      m15ATR,
      m15Structure
    );

  const zoneWidthPoints =
    getZoneWidthPoints(
      m15ATR,
      m5ATR
    );

  const candidates = [];

  // ----------------------------------------------------------
  // 1. RANGE SUPPORT / RESISTANCE
  // ----------------------------------------------------------

  const rangeSetup =
    findRangeSetup(
      m15Range,
      m15SR,
      h1Structure.direction,
      price
    );

  if (rangeSetup) {
    candidates.push(
      buildCandidate({
        direction:
          rangeSetup.direction,
        setupType:
          rangeSetup.type,
        level:
          rangeSetup.level,
        anchorTimestamp:
          rangeSetup.anchorTimestamp,
        anchorDatetime:
          null,
        timeframe: "M15",
        zoneWidthPoints,
        h1Structure,
        m15Structure,
        m5Structure,
        m15Candles,
        m5Candles,
        m15SR,
        price,
        touches:
          rangeSetup.touches,
        reasonParts: [
          h1Structure.direction ===
          "BULLISH"
            ? "H1 bullish context"
            : h1Structure.direction ===
              "BEARISH"
            ? "H1 bearish context"
            : "H1 neutral context",
          "M15 range boundary",
          "M5 refined support/resistance"
        ],
        isRange: true,
        targetPoints: {
          tp1: SCALP_TP1_POINTS,
          tp2: SCALP_TP2_POINTS
        }
      })
    );
  }

  // ----------------------------------------------------------
  // 2. TREND CONTINUATION
  // ----------------------------------------------------------

  if (
    h1Structure.direction !==
      "NEUTRAL"
  ) {
    const continuationLevel =
      findTrendContinuationLevel(
        m15SR,
        h1Structure.direction ===
          "BULLISH"
          ? "BUY"
          : "SELL",
        price
      );

    if (continuationLevel) {
      const direction =
        h1Structure.direction ===
        "BULLISH"
          ? "BUY"
          : "SELL";

      candidates.push(
        buildCandidate({
          direction,
          setupType:
            "TREND_CONTINUATION",
          level:
            continuationLevel.level,
          anchorTimestamp:
            continuationLevel.latestTimestamp,
          anchorDatetime:
            continuationLevel.latestDatetime,
          timeframe: "M15",
          zoneWidthPoints,
          h1Structure,
          m15Structure,
          m5Structure,
          m15Candles,
          m5Candles,
          m15SR,
          price,
          touches:
            continuationLevel.touches,
          reasonParts: [
            `H1 ${h1Structure.direction.toLowerCase()} context`,
            "M15 structural support/resistance",
            "M5 entry refinement"
          ],
          targetPoints: {
            tp1: SCALP_TP1_POINTS,
            tp2: SCALP_TP2_POINTS
          }
        })
      );
    }
  }

  // ----------------------------------------------------------
  // 3. BREAKOUT -> PULLBACK -> RETEST
  // ----------------------------------------------------------

  const breakoutBuy =
    detectBreakoutRetest(
      m15Candles,
      m15SR,
      "BUY"
    );

  const breakoutSell =
    detectBreakoutRetest(
      m15Candles,
      m15SR,
      "SELL"
    );

  for (
    const breakout of [
      breakoutBuy,
      breakoutSell
    ]
  ) {
    if (!breakout) continue;

    candidates.push(
      buildCandidate({
        direction:
          breakout.direction,
        setupType:
          breakout.type,
        level:
          breakout.level,
        anchorTimestamp:
          breakout.anchorTimestamp,
        anchorDatetime: null,
        timeframe: "M15",
        zoneWidthPoints,
        h1Structure,
        m15Structure,
        m5Structure,
        m15Candles,
        m5Candles,
        m15SR,
        price,
        touches: 2,
        reasonParts: [
          "M15 breakout detected",
          "Pullback completed",
          "Retest structure mapped",
          "M5 refinement"
        ],
        isBreakoutRetest: true,
        targetPoints: {
          tp1: SCALP_TP1_POINTS,
          tp2: SCALP_TP2_POINTS
        }
      })
    );
  }

  // ----------------------------------------------------------
  // 4. QM
  // ----------------------------------------------------------

  const qmBuy =
    detectQM(
      m15Swings,
      "BUY"
    );

  const qmSell =
    detectQM(
      m15Swings,
      "SELL"
    );

  if (qmBuy) {
    candidates.push(
      buildCandidate({
        direction: "BUY",
        setupType: "QM_BUY",
        level: qmBuy.level,
        anchorTimestamp:
          qmBuy.timestamp,
        anchorDatetime: null,
        timeframe: "M15",
        zoneWidthPoints,
        h1Structure,
        m15Structure,
        m5Structure,
        m15Candles,
        m5Candles,
        m15SR,
        price,
        touches: 2,
        reasonParts: [
          "M15 QM-style structure",
          "Higher-TF context evaluated",
          "M5 refinement"
        ],
        isQM: true,
        targetPoints: {
          tp1: SCALP_TP1_POINTS,
          tp2: SCALP_TP2_POINTS
        }
      })
    );
  }

  if (qmSell) {
    candidates.push(
      buildCandidate({
        direction: "SELL",
        setupType: "QM_SELL",
        level: qmSell.level,
        anchorTimestamp:
          qmSell.timestamp,
        anchorDatetime: null,
        timeframe: "M15",
        zoneWidthPoints,
        h1Structure,
        m15Structure,
        m5Structure,
        m15Candles,
        m5Candles,
        m15SR,
        price,
        touches: 2,
        reasonParts: [
          "M15 QM-style structure",
          "Higher-TF context evaluated",
          "M5 refinement"
        ],
        isQM: true,
        targetPoints: {
          tp1: SCALP_TP1_POINTS,
          tp2: SCALP_TP2_POINTS
        }
      })
    );
  }

  // ----------------------------------------------------------
  // 5. TRENDLINE CONTEXT
  // ----------------------------------------------------------

  const trendBuy =
    detectTrendlineContext(
      m15Swings,
      "BUY",
      price
    );

  const trendSell =
    detectTrendlineContext(
      m15Swings,
      "SELL",
      price
    );

  if (trendBuy) {
    candidates.push(
      buildCandidate({
        direction: "BUY",
        setupType:
          "TRENDLINE_RETEST",
        level: trendBuy.level,
        anchorTimestamp:
          trendBuy.timestamp,
        anchorDatetime: null,
        timeframe: "M15",
        zoneWidthPoints,
        h1Structure,
        m15Structure,
        m5Structure,
        m15Candles,
        m5Candles,
        m15SR,
        price,
        touches: 2,
        reasonParts: [
          "Rising M15 trendline context",
          "Structural support",
          "M5 refinement"
        ],
        trendline: true,
        targetPoints: {
          tp1: SCALP_TP1_POINTS,
          tp2: SCALP_TP2_POINTS
        }
      })
    );
  }

  if (trendSell) {
    candidates.push(
      buildCandidate({
        direction: "SELL",
        setupType:
          "TRENDLINE_RETEST",
        level: trendSell.level,
        anchorTimestamp:
          trendSell.timestamp,
        anchorDatetime: null,
        timeframe: "M15",
        zoneWidthPoints,
        h1Structure,
        m15Structure,
        m5Structure,
        m15Candles,
        m5Candles,
        m15SR,
        price,
        touches: 2,
        reasonParts: [
          "Falling M15 trendline context",
          "Structural resistance",
          "M5 refinement"
        ],
        trendline: true,
        targetPoints: {
          tp1: SCALP_TP1_POINTS,
          tp2: SCALP_TP2_POINTS
        }
      })
    );
  }

  const selected =
    chooseCandidate(
      candidates,
      price
    );

  // ----------------------------------------------------------
  // NO VALID STRUCTURAL SETUP
  // ----------------------------------------------------------

  if (!selected) {
    return {
      signal: "WATCH",
      direction:
        h1Structure.direction,
      structure:
        m15Structure.label,
      zone: null,
      setup: "NO_VALID_SETUP",
      status: "WATCH",
      score: 0,
      scoreLabel: "WEAK / WATCH",
      locked: false,
      plan: {
        entry: null,
        sl: null,
        tp1: null,
        tp2: null
      },
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      reason:
        "No structurally valid M15 setup with sufficient target room",
      diagnostics: {
        h1: h1Structure,
        m15: m15Structure,
        m5: m5Structure,
        range: m15Range,
        zoneWidthPoints
      }
    };
  }

  return {
    ...selected,
    diagnostics: {
      h1: {
        direction:
          h1Structure.direction,
        structure:
          h1Structure.label
      },
      m15: {
        direction:
          m15Structure.direction,
        structure:
          m15Structure.label
      },
      m5: {
        direction:
          m5Structure.direction,
        structure:
          m5Structure.label
      },
      range: m15Range,
      zoneWidthPoints
    }
  };
}

// ============================================================
// INTRADAY ENGINE
//
// H4 -> H1 -> M15 -> M5
//
// Fibonacci:
// ONLY 0.382 / 0.5
// ============================================================

function analyzeIntraday({
  price,
  h4Candles,
  h1Candles,
  m15Candles,
  m5Candles
}) {
  const h4Swings =
    detectSwings(
      h4Candles,
      2,
      2
    );

  const h1Swings =
    detectSwings(
      h1Candles,
      2,
      2
    );

  const m15Swings =
    detectSwings(
      m15Candles,
      2,
      2
    );

  const m5Swings =
    detectSwings(
      m5Candles,
      2,
      2
    );

  const h4Structure =
    classifyStructure(
      h4Swings
    );

  const h1Structure =
    classifyStructure(
      h1Swings
    );

  const m15Structure =
    classifyStructure(
      m15Swings
    );

  const m5Structure =
    classifyStructure(
      m5Swings
    );

  const h4ATR =
    calculateATR(
      h4Candles,
      14
    );

  const h1ATR =
    calculateATR(
      h1Candles,
      14
    );

  const m15ATR =
    calculateATR(
      m15Candles,
      14
    );

  const m5ATR =
    calculateATR(
      m5Candles,
      14
    );

  const h1SR =
    findSupportResistance(
      h1Candles,
      h1Swings,
      h1ATR
    );

  const m15SR =
    findSupportResistance(
      m15Candles,
      m15Swings,
      m15ATR
    );

  const candidates = [];

  // ----------------------------------------------------------
  // H4 + H1 DIRECTION
  // ----------------------------------------------------------

  let preferredDirection =
    h1Structure.direction;

  if (
    h4Structure.direction !==
      "NEUTRAL" &&
    h1Structure.direction !==
      "NEUTRAL" &&
    h4Structure.direction ===
      h1Structure.direction
  ) {
    preferredDirection =
      h4Structure.direction;
  }

  // ----------------------------------------------------------
  // H1 PULLBACK / STRUCTURAL S/R
  // ----------------------------------------------------------

  if (
    preferredDirection ===
      "BULLISH" ||
    preferredDirection ===
      "BEARISH"
  ) {
    const direction =
      preferredDirection ===
      "BULLISH"
        ? "BUY"
        : "SELL";

    const level =
      findTrendContinuationLevel(
        m15SR,
        direction,
        price
      );

    if (level) {
      const zone =
        makeZone(
          level.level,
          direction,
          30
        );

      const refined =
        refineZoneWithM5(
          zone,
          m5Candles,
          direction,
          m5Swings
        );

      const room =
        hasTargetRoom(
          direction,
          refined,
          h1SR,
          INTRADAY_TP1_POINTS,
          INTRADAY_TP2_POINTS
        );

      if (room.valid) {
        const fib =
          findIntradayFibZone(
            h1Structure,
            h1Swings,
            direction
          );

        let fibBonus = 0;
        let fibReason = "";

        if (fib) {
          const overlaps =
            refined.low <=
              fib.high &&
            refined.high >=
              fib.low;

          if (overlaps) {
            fibBonus = 8;
            fibReason =
              "H1 Fibonacci 0.382/0.5 overlap";
          }
        }

        let score = 50;

        if (
          h4Structure.direction ===
          preferredDirection
        ) {
          score += 15;
        }

        if (
          h1Structure.direction ===
          preferredDirection
        ) {
          score += 12;
        }

        if (
          m15Structure.direction ===
          preferredDirection
        ) {
          score += 8;
        }

        if (
          m5Structure.direction ===
          preferredDirection
        ) {
          score += 4;
        }

        score += clamp(
          level.touches * 2,
          0,
          8
        );

        score += fibBonus;

        if (
          room.opposingDistance !==
            null &&
          room.opposingDistance >= 2
        ) {
          score += 5;
        }

        score = Math.round(
          clamp(score, 0, 100)
        );

        const status =
          calculateStatus(
            price,
            refined,
            direction
          );

        const setupId =
          getSetupId({
            direction,
            setup:
              "PULLBACK_RESISTANCE",
            timeframe: "M15",
            zoneLow: refined.low,
            zoneHigh: refined.high,
            anchorTime:
              level.latestDatetime ||
              String(
                level.latestTimestamp
              ),
            structureTime:
              h1Structure.lastHigh
                ?.datetime ||
              h1Structure.lastLow
                ?.datetime ||
              ""
          });

        const plan =
          buildTradePlan({
            direction,
            zone: refined,
            tp1Points:
              INTRADAY_TP1_POINTS,
            tp2Points:
              INTRADAY_TP2_POINTS,
            opposingLevel:
              room.opposingLevel
          });

        candidates.push({
          setupId,
          signal: direction,
          direction:
            direction === "BUY"
              ? "BULLISH"
              : "BEARISH",
          structure:
            h1Structure.label,
          zone: {
            type: direction,
            low: refined.low,
            high: refined.high,
            widthPoints:
              refined.widthPoints
          },
          setup:
            direction === "BUY"
              ? "PULLBACK_SUPPORT"
              : "PULLBACK_RESISTANCE",
          status,
          score,
          scoreLabel:
            scoreLabel(score),
          locked: true,
          plan,
          entry: plan.entry,
          sl: plan.sl,
          tp1: plan.tp1,
          tp2: plan.tp2,
          tp1Points:
            INTRADAY_TP1_POINTS,
          tp2Points:
            INTRADAY_TP2_POINTS,
          reason: [
            `H4 ${h4Structure.direction.toLowerCase()} context`,
            `H1 ${h1Structure.direction.toLowerCase()} structure`,
            "M15 structural pullback",
            "M5 entry refinement",
            fibReason
          ]
            .filter(Boolean)
            .join(", ")
        });
      }
    }
  }

  // ----------------------------------------------------------
  // H1 BREAKOUT / RETEST
  // ----------------------------------------------------------

  const breakoutBuy =
    detectBreakoutRetest(
      h1Candles,
      h1SR,
      "BUY"
    );

  const breakoutSell =
    detectBreakoutRetest(
      h1Candles,
      h1SR,
      "SELL"
    );

  for (
    const breakout of [
      breakoutBuy,
      breakoutSell
    ]
  ) {
    if (!breakout) continue;

    const direction =
      breakout.direction;

    const zone =
      makeZone(
        breakout.level,
        direction,
        30
      );

    const refined =
      refineZoneWithM5(
        zone,
        m5Candles,
        direction,
        m5Swings
      );

    const room =
      hasTargetRoom(
        direction,
        refined,
        h1SR,
        INTRADAY_TP1_POINTS,
        INTRADAY_TP2_POINTS
      );

    if (!room.valid) continue;

    let score = 55;

    if (
      h4Structure.direction ===
      (direction === "BUY"
        ? "BULLISH"
        : "BEARISH")
    ) {
      score += 15;
    }

    if (
      h1Structure.direction ===
      (direction === "BUY"
        ? "BULLISH"
        : "BEARISH")
    ) {
      score += 12;
    }

    if (
      m15Structure.direction ===
      (direction === "BUY"
        ? "BULLISH"
        : "BEARISH")
    ) {
      score += 8;
    }

    score = Math.round(
      clamp(score, 0, 100)
    );

    const status =
      calculateStatus(
        price,
        refined,
        direction
      );

    const plan =
      buildTradePlan({
        direction,
        zone: refined,
        tp1Points:
          INTRADAY_TP1_POINTS,
        tp2Points:
          INTRADAY_TP2_POINTS,
        opposingLevel:
          room.opposingLevel
      });

    candidates.push({
      setupId:
        getSetupId({
          direction,
          setup:
            "BREAKOUT_RETEST",
          timeframe: "H1",
          zoneLow: refined.low,
          zoneHigh: refined.high,
          anchorTime:
            String(
              breakout.anchorTimestamp
            ),
          structureTime:
            h1Structure.lastHigh
              ?.datetime ||
            h1Structure.lastLow
              ?.datetime ||
            ""
        }),
      signal: direction,
      direction:
        direction === "BUY"
          ? "BULLISH"
          : "BEARISH",
      structure:
        h1Structure.label,
      zone: {
        type: direction,
        low: refined.low,
        high: refined.high,
        widthPoints:
          refined.widthPoints
      },
      setup:
        "BREAKOUT_RETEST",
      status,
      score,
      scoreLabel:
        scoreLabel(score),
      locked: true,
      plan,
      entry: plan.entry,
      sl: plan.sl,
      tp1: plan.tp1,
      tp2: plan.tp2,
      tp1Points:
        INTRADAY_TP1_POINTS,
      tp2Points:
        INTRADAY_TP2_POINTS,
      reason:
        "H1 breakout, pullback and retest with M15/M5 refinement"
    });
  }

  // ----------------------------------------------------------
  // SELECT INTRADAY
  // ----------------------------------------------------------

  if (!candidates.length) {
    return {
      signal: "WATCH",
      direction:
        preferredDirection,
      structure:
        h1Structure.label,
      zone: null,
      setup: "NO_VALID_SETUP",
      status: "WATCH",
      score: 0,
      scoreLabel: "WEAK / WATCH",
      locked: false,
      plan: {
        entry: null,
        sl: null,
        tp1: null,
        tp2: null
      },
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      reason:
        "No structurally valid intraday setup with sufficient target room"
    };
  }

  return candidates.sort(
    (a, b) => {
      const statusWeight = {
        READY: 30,
        APPROACHING: 20,
        WATCH: 10
      };

      return (
        (statusWeight[b.status] || 0) +
        b.score * 0.5 -
        ((statusWeight[a.status] || 0) +
          a.score * 0.5)
      );
    }
  )[0];
}

// ============================================================
// API ERROR FORMAT
// ============================================================

function apiError(
  res,
  statusCode,
  code,
  message,
  details = null
) {
  return res.status(statusCode).json({
    status: "error",
    engine: {
      name: ENGINE_NAME,
      version: ENGINE_VERSION
    },
    error: {
      code,
      message,
      details
    }
  });
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(
  req,
  res
) {
  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (
    req.method !== "GET" &&
    req.method !== "POST"
  ) {
    return apiError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Only GET and POST are supported."
    );
  }

  // ----------------------------------------------------------
  // API KEY
  // ----------------------------------------------------------

  const apiKey =
    process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return apiError(
      res,
      500,
      "MISSING_API_KEY",
      "TWELVE_DATA_API_KEY is not configured in Vercel environment variables."
    );
  }

  // ----------------------------------------------------------
  // MARKET DATA
  //
  // 4 API requests:
  // H4
  // H1
  // M15
  // M5
  //
  // H1/M15/M5 are shared by both engines.
  // ----------------------------------------------------------

  try {
    const [
      h4Candles,
      h1Candles,
      m15Candles,
      m5Candles
    ] = await Promise.all([
      fetchTimeSeries(
        "4h",
        180,
        apiKey
      ),
      fetchTimeSeries(
        "1h",
        220,
        apiKey
      ),
      fetchTimeSeries(
        "15min",
        260,
        apiKey
      ),
      fetchTimeSeries(
        "5min",
        300,
        apiKey
      )
    ]);

    // --------------------------------------------------------
    // VALIDATE DATA
    // --------------------------------------------------------

    if (
      h4Candles.length < 30 ||
      h1Candles.length < 30 ||
      m15Candles.length < 30 ||
      m5Candles.length < 30
    ) {
      return apiError(
        res,
        503,
        "INSUFFICIENT_MARKET_DATA",
        "Not enough candles were returned by Twelve Data."
      );
    }

    // --------------------------------------------------------
    // CURRENT PRICE
    //
    // Latest M5 close is used.
    // We do not fabricate price.
    // --------------------------------------------------------

    const latestM5 =
      m5Candles[
        m5Candles.length - 1
      ];

    const previousM5 =
      m5Candles[
        m5Candles.length - 2
      ];

    const price =
      roundPrice(
        latestM5.close
      );

    if (!Number.isFinite(price)) {
      return apiError(
        res,
        503,
        "PRICE_UNAVAILABLE",
        "Latest XAUUSD price is unavailable."
      );
    }

    // --------------------------------------------------------
    // CLOSED CANDLES FOR STRUCTURE
    // --------------------------------------------------------

    const h4Closed =
      getClosedCandles(
        h4Candles
      );

    const h1Closed =
      getClosedCandles(
        h1Candles
      );

    const m15Closed =
      getClosedCandles(
        m15Candles
      );

    const m5Closed =
      getClosedCandles(
        m5Candles
      );

    // --------------------------------------------------------
    // SCALPING
    // H1 -> M15 -> M5
    // --------------------------------------------------------

    const scalping =
      analyzeScalping({
        price,
        h1Candles: h1Closed,
        m15Candles: m15Closed,
        m5Candles: m5Closed
      });

    // --------------------------------------------------------
    // INTRADAY
    // H4 -> H1 -> M15 -> M5
    // --------------------------------------------------------

    const intraday =
      analyzeIntraday({
        price,
        h4Candles: h4Closed,
        h1Candles: h1Closed,
        m15Candles: m15Closed,
        m5Candles: m5Closed
      });

    // --------------------------------------------------------
    // STRUCTURE SNAPSHOT
    // --------------------------------------------------------

    const h4Structure =
      classifyStructure(
        detectSwings(
          h4Closed,
          2,
          2
        )
      );

    const h1Structure =
      classifyStructure(
        detectSwings(
          h1Closed,
          2,
          2
        )
      );

    const m15Structure =
      classifyStructure(
        detectSwings(
          m15Closed,
          2,
          2
        )
      );

    const m5Structure =
      classifyStructure(
        detectSwings(
          m5Closed,
          2,
          2
        )
      );

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res.status(200).json({
      status: "success",

      engine: {
        name: ENGINE_NAME,
        version: ENGINE_VERSION,
        mode:
          "ACTIVE SCALPING / SELECTIVE INTRADAY",
        execution: false,
        analysisOnly: true
      },

      market: {
        symbol: "XAUUSD",
        source: "Twelve Data",
        price,
        previousPrice:
          roundPrice(
            previousM5.close
          ),
        candle:
          latestM5.datetime
      },

      multiTimeframe: {
        h4: {
          direction:
            h4Structure.direction,
          structure:
            h4Structure.label
        },

        h1: {
          direction:
            h1Structure.direction,
          structure:
            h1Structure.label
        },

        m15: {
          direction:
            m15Structure.direction,
          structure:
            m15Structure.label
        },

        m5: {
          direction:
            m5Structure.direction,
          structure:
            m5Structure.label
        }
      },

      scalping: {
        ...scalping,

        targets: {
          tp1Points:
            SCALP_TP1_POINTS,
          tp2Points:
            SCALP_TP2_POINTS
        },

        timeframe: {
          context: "H1",
          setup: "M15",
          refinement: "M5"
        }
      },

      intraday: {
        ...intraday,

        targets: {
          tp1Points:
            INTRADAY_TP1_POINTS,
          tp2Points:
            INTRADAY_TP2_POINTS
        },

        timeframe: {
          context: "H4",
          structure: "H1",
          setup: "M15",
          refinement: "M5"
        },

        fibonacci: {
          enabled: true,
          allowed: [
            0.382,
            0.5
          ],
          forbidden: [
            0.618,
            0.705,
            0.786
          ]
        }
      },

      // ------------------------------------------------------
      // SIMPLE COMPATIBILITY OBJECT
      //
      // Existing HTML can read:
      // signal
      // zone
      // score
      // status
      // plan
      // entry
      // sl
      // tp1
      // tp2
      //
      // Default = scalping because SINNCI is currently
      // designed to be active for scalping.
      // ------------------------------------------------------

      signal:
        scalping.signal,

      direction:
        scalping.direction,

      structure:
        scalping.structure,

      zone:
        scalping.zone,

      setup:
        scalping.setup,

      score:
        scalping.score,

      scoreLabel:
        scalping.scoreLabel,

      status:
        scalping.status,

      locked:
        scalping.locked,

      reason:
        scalping.reason,

      plan:
        scalping.plan,

      entry:
        scalping.entry,

      sl:
        scalping.sl,

      tp1:
        scalping.tp1,

      tp2:
        scalping.tp2,

      setupId:
        scalping.setupId || null
    });
  } catch (error) {
    // --------------------------------------------------------
    // ERROR HANDLING
    //
    // Important:
    // Never fabricate candles.
    // Never fabricate price.
    // Never return fake signal after API failure.
    // --------------------------------------------------------

    const message =
      error?.message ||
      "Unknown market-data error";

    const lower =
      message.toLowerCase();

    let code =
      "MARKET_DATA_ERROR";

    let statusCode = 502;

    if (
      lower.includes("quota") ||
      lower.includes("credit") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      code = "TWELVE_DATA_QUOTA";
      statusCode = 429;
    }

    if (
      lower.includes("invalid symbol")
    ) {
      code = "INVALID_SYMBOL";
      statusCode = 400;
    }

    if (
      lower.includes("non-json")
    ) {
      code = "INVALID_API_RESPONSE";
      statusCode = 502;
    }

    return apiError(
      res,
      statusCode,
      code,
      message
    );
  }
    }
