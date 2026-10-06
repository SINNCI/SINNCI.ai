export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "API key not configured"
      });
    }

    // =========================================================
    // 1. TIMEFRAMES
    // =========================================================

    const timeframes = {
      H4: "4h",
      H1: "1h",
      M30: "30min",
      M15: "15min",
      M5: "5min"
    };

    const market = {};

    // 120 candles supaya AI boleh tengok harga lama
    const OUTPUT_SIZE = 120;

    for (const [name, interval] of Object.entries(timeframes)) {
      const url =
        "https://api.twelvedata.com/time_series" +
        "?symbol=XAU/USD" +
        "&interval=" + interval +
        "&outputsize=" + OUTPUT_SIZE +
        "&apikey=" + API_KEY;

      const response = await fetch(url);
      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({
          error: "Market data service returned an invalid response"
        });
      }

      if (data.status === "error" || !data.values) {
        return res.status(503).json({
          error: data.message || "Market data unavailable"
        });
      }

      market[name] = data.values
        .map(c => ({
          datetime: c.datetime,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        }))
        .filter(c =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        );
    }

    // =========================================================
    // 2. BASIC HELPERS
    // =========================================================

    function roundPrice(price) {
      return Number(price.toFixed(2));
    }

    function average(values) {
      if (!values.length) return 0;
      return values.reduce((a, b) => a + b, 0) / values.length;
    }

    function candleRange(c) {
      return c.high - c.low;
    }

    function bodySize(c) {
      return Math.abs(c.close - c.open);
    }

    function bullish(c) {
      return c.close > c.open;
    }

    function bearish(c) {
      return c.close < c.open;
    }

    function midpoint(zone) {
      return (zone.low + zone.high) / 2;
    }

    // =========================================================
    // 3. SWING POINTS
    // =========================================================

    function findSwingHighs(candles) {
      const swings = [];

      for (let i = 3; i < candles.length - 3; i++) {
        const c = candles[i];

        if (
          c.high > candles[i - 1].high &&
          c.high > candles[i - 2].high &&
          c.high > candles[i - 3].high &&
          c.high > candles[i + 1].high &&
          c.high > candles[i + 2].high &&
          c.high > candles[i + 3].high
        ) {
          swings.push({
            index: i,
            price: c.high
          });
        }
      }

      return swings;
    }

    function findSwingLows(candles) {
      const swings = [];

      for (let i = 3; i < candles.length - 3; i++) {
        const c = candles[i];

        if (
          c.low < candles[i - 1].low &&
          c.low < candles[i - 2].low &&
          c.low < candles[i - 3].low &&
          c.low < candles[i + 1].low &&
          c.low < candles[i + 2].low &&
          c.low < candles[i + 3].low
        ) {
          swings.push({
            index: i,
            price: c.low
          });
        }
      }

      return swings;
    }

    // =========================================================
    // 4. DIRECTION
    // =========================================================

    function getDirection(candles) {
      if (!candles || candles.length < 30) {
        return "WAIT";
      }

      const highs = findSwingHighs(candles);
      const lows = findSwingLows(candles);

      if (highs.length < 2 || lows.length < 2) {
        return "WAIT";
      }

      const h1 = highs[highs.length - 1].price;
      const h2 = highs[highs.length - 2].price;

      const l1 = lows[lows.length - 1].price;
      const l2 = lows[lows.length - 2].price;

      const higherHigh = h1 > h2;
      const higherLow = l1 > l2;

      const lowerHigh = h1 < h2;
      const lowerLow = l1 < l2;

      if (higherHigh && higherLow) {
        return "BULLISH";
      }

      if (lowerHigh && lowerLow) {
        return "BEARISH";
      }

      return "SIDEWAYS";
    }

    const directions = {
      H4: getDirection(market.H4),
      H1: getDirection(market.H1),
      M30: getDirection(market.M30),
      M15: getDirection(market.M15),
      M5: getDirection(market.M5)
    };

    // =========================================================
    // 5. SUPPORT / RESISTANCE
    // =========================================================

    function findZones(candles) {
      const highs = findSwingHighs(candles);
      const lows = findSwingLows(candles);

      const zones = [];

      // Resistance from old swing highs
      highs.forEach(s => {
        const c = candles[s.index];

        const range = candleRange(c);

        zones.push({
          type: "RESISTANCE",
          low: c.high - Math.max(range * 0.35, 0.5),
          high: c.high,
          index: s.index,
          score: 2,
          source: "OLD SWING HIGH"
        });
      });

      // Support from old swing lows
      lows.forEach(s => {
        const c = candles[s.index];

        const range = candleRange(c);

        zones.push({
          type: "SUPPORT",
          low: c.low,
          high: c.low + Math.max(range * 0.35, 0.5),
          index: s.index,
          score: 2,
          source: "OLD SWING LOW"
        });
      });

      return zones;
    }

    // =========================================================
    // 6. DBD / RBR
    // =========================================================

    function findPatterns(candles) {
      const patterns = [];

      for (let i = 3; i < candles.length - 2; i++) {
        const a = candles[i + 2];
        const b = candles[i + 1];
        const c = candles[i];

        if (!a || !b || !c) continue;

        const aBear = bearish(a);
        const cBear = bearish(c);

        const aBull = bullish(a);
        const cBull = bullish(c);

        const baseRange = candleRange(b);

        const firstRange = candleRange(a);
        const secondRange = candleRange(c);

        // -------------------------
        // DBD = Drop Base Drop
        // -------------------------

        if (
          aBear &&
          cBear &&
          baseRange < firstRange &&
          baseRange < secondRange &&
          bodySize(a) > baseRange * 0.45 &&
          bodySize(c) > secondRange * 0.45
        ) {
          patterns.push({
            type: "DBD",
            direction: "SELL",
            low: b.low,
            high: b.high,
            index: i + 1,
            score: 5,
            source: "DROP BASE DROP"
          });
        }

        // -------------------------
        // RBR = Rally Base Rally
        // -------------------------

        if (
          aBull &&
          cBull &&
          baseRange < firstRange &&
          baseRange < secondRange &&
          bodySize(a) > baseRange * 0.45 &&
          bodySize(c) > secondRange * 0.45
        ) {
          patterns.push({
            type: "RBR",
            direction: "BUY",
            low: b.low,
            high: b.high,
            index: i + 1,
            score: 5,
            source: "RALLY BASE RALLY"
          });
        }
      }

      return patterns;
    }

    // =========================================================
    // 7. BREAKOUT / CHANGE OF ROLE
    // =========================================================

    function findBreakouts(candles, zones) {
      const results = [];

      zones.forEach(zone => {
        for (let i = zone.index - 1; i >= 0; i--) {
          const c = candles[i];

          if (!c) continue;

          // Resistance broken upwards
          if (
            zone.type === "RESISTANCE" &&
            c.close > zone.high
          ) {
            results.push({
              type: "RESISTANCE_BROKEN",
              oldType: "RESISTANCE",
              newType: "SUPPORT",
              low: zone.low,
              high: zone.high,
              index: i,
              score: 4,
              source: "RESISTANCE BECOME SUPPORT"
            });

            break;
          }

          // Support broken downwards
          if (
            zone.type === "SUPPORT" &&
            c.close < zone.low
          ) {
            results.push({
              type: "SUPPORT_BROKEN",
              oldType: "SUPPORT",
              newType: "RESISTANCE",
              low: zone.low,
              high: zone.high,
              index: i,
              score: 4,
              source: "SUPPORT BECOME RESISTANCE"
            });

            break;
          }
        }
      });

      return results;
    }

    // =========================================================
    // 8. BUILD ALL HISTORICAL ZONES
    // =========================================================

    const analysis = {};

    for (const [tf, candles] of Object.entries(market)) {
      const srZones = findZones(candles);
      const patterns = findPatterns(candles);
      const breakouts = findBreakouts(candles, srZones);

      analysis[tf] = {
        zones: srZones,
        patterns,
        breakouts
      };
    }

    // =========================================================
    // 9. COMBINE / MERGE CONFLUENCE
    // =========================================================

    const allZones = [];

    for (const [tf, data] of Object.entries(analysis)) {
      data.zones.forEach(z => {
        allZones.push({
          ...z,
          timeframe: tf
        });
      });

      data.patterns.forEach(p => {
        allZones.push({
          ...p,
          timeframe: tf
        });
      });

      data.breakouts.forEach(b => {
        allZones.push({
          ...b,
          timeframe: tf
        });
      });
    }

    // =========================================================
    // 10. ADD TF WEIGHT
    // =========================================================

    const tfWeight = {
      H4: 5,
      H1: 4,
      M30: 3,
      M15: 2,
      M5: 1
    };

    allZones.forEach(zone => {
      zone.score =
        (zone.score || 0) +
        (tfWeight[zone.timeframe] || 0);
    });

    // =========================================================
    // 11. MERGE NEARBY ZONES
    // =========================================================

    function mergeZones(zones) {
      const sorted = [...zones].sort(
        (a, b) => midpoint(a) - midpoint(b)
      );

      const merged = [];

      for (const zone of sorted) {
        const existing = merged.find(m => {
          const distance =
            Math.abs(midpoint(m) - midpoint(zone));

          const tolerance = Math.max(
            (m.high - m.low) * 1.5,
            1.5
          );

          return (
            m.type === zone.type &&
            distance <= tolerance
          );
        });

        if (existing) {
          existing.low = Math.min(existing.low, zone.low);
          existing.high = Math.max(existing.high, zone.high);
          existing.score += zone.score;
          existing.timeframes.push(zone.timeframe);

          if (!existing.sources.includes(zone.source)) {
            existing.sources.push(zone.source);
          }
        } else {
          merged.push({
            type: zone.type || zone.newType,
            low: zone.low,
            high: zone.high,
            score: zone.score,
            timeframes: [zone.timeframe],
            sources: [zone.source || zone.type]
          });
        }
      }

      return merged;
    }

    const mergedZones = mergeZones(allZones);

    // =========================================================
    // 12. CURRENT PRICE
    // =========================================================

    const currentPrice =
      Number(market.M5[0].close);

    // =========================================================
    // 13. DETERMINE MAJOR DIRECTION
    // =========================================================

    let majorDirection = "SIDEWAYS";

    if (
      directions.H4 === "BULLISH" &&
      directions.H1 === "BULLISH"
    ) {
      majorDirection = "BULLISH";
    }

    if (
      directions.H4 === "BEARISH" &&
      directions.H1 === "BEARISH"
    ) {
      majorDirection = "BEARISH";
    }

    // Kalau H4/H1 bercanggah,
    // jangan paksa BUY/SELL
    if (
      directions.H4 !== directions.H1 &&
      directions.H4 !== "WAIT" &&
      directions.H1 !== "WAIT"
    ) {
      majorDirection = "SIDEWAYS";
    }

    // =========================================================
    // 14. SIDEWAY RANGE
    // =========================================================

    const recentH1 = market.H1.slice(0, 60);

    const rangeHigh = Math.max(
      ...recentH1.map(c => c.high)
    );

    const rangeLow = Math.min(
      ...recentH1.map(c => c.low)
    );

    const rangeSize = rangeHigh - rangeLow;

    const rangePosition =
      rangeSize > 0
        ? (currentPrice - rangeLow) / rangeSize
        : 0.5;

    const middleRange =
      rangePosition > 0.35 &&
      rangePosition < 0.65;

    // =========================================================
    // 15. FIND BEST BUY / SELL PUNCA
    // =========================================================

    function bestZone(type) {
      const candidates = mergedZones
        .filter(z => z.type === type)
        .sort((a, b) => b.score - a.score);

      if (!candidates.length) return null;

      return candidates[0];
    }

    const bestSupport = bestZone("SUPPORT");
    const bestResistance = bestZone("RESISTANCE");

    // =========================================================
    // 16. FIND PATTERN PUNCA
    // =========================================================

    const buyPatterns = mergedZones
      .filter(z =>
        z.sources.some(s =>
          String(s).includes("RALLY BASE RALLY")
        )
      )
      .sort((a, b) => b.score - a.score);

    const sellPatterns = mergedZones
      .filter(z =>
        z.sources.some(s =>
          String(s).includes("DROP BASE DROP")
        )
      )
      .sort((a, b) => b.score - a.score);

    const buyPunca =
      buyPatterns[0] || bestSupport;

    const sellPunca =
      sellPatterns[0] || bestResistance;

    // =========================================================
    // 17. CHECK PRICE NEAR ZONE
    // =========================================================

    function priceNearZone(price, zone) {
      if (!zone) return false;

      const buffer =
        Math.max(
          (zone.high - zone.low) * 0.8,
          1.5
        );

      return (
        price >= zone.low - buffer &&
        price <= zone.high + buffer
      );
    }

    const nearBuyPunca =
      priceNearZone(currentPrice, buyPunca);

    const nearSellPunca =
      priceNearZone(currentPrice, sellPunca);

    // =========================================================
    // 18. FINAL SIGNAL
    // =========================================================

    let signal = "WAIT";
    let entryZone = null;
    let selectedPunca = null;
    let reason = "";

    // ---------------------------------------------------------
    // BULLISH MARKET
    // ---------------------------------------------------------

    if (majorDirection === "BULLISH") {
      if (nearBuyPunca && buyPunca) {
        signal = "BUY";
        selectedPunca = buyPunca;

        entryZone = {
          low: roundPrice(buyPunca.low),
          high: roundPrice(buyPunca.high)
        };

        reason =
          "H4/H1 bullish. Current price is near a historical BUY punca with SNR/RBR confluence.";
      } else {
        signal = "WAIT";
        selectedPunca = buyPunca;

        reason =
          "H4/H1 bullish, but current price has not reached the historical BUY punca. Wait for price to return to the zone.";
      }
    }

    // ---------------------------------------------------------
    // BEARISH MARKET
    // ---------------------------------------------------------

    if (majorDirection === "BEARISH") {
      if (nearSellPunca && sellPunca) {
        signal = "SELL";
        selectedPunca = sellPunca;

        entryZone = {
          low: roundPrice(sellPunca.low),
          high: roundPrice(sellPunca.high)
        };

        reason =
          "H4/H1 bearish. Current price is near a historical SELL punca with SNR/DBD confluence.";
      } else {
        signal = "WAIT";
        selectedPunca = sellPunca;

        reason =
          "H4/H1 bearish, but current price has not reached the historical SELL punca. Wait for price to return to the zone.";
      }
    }

    // ---------------------------------------------------------
    // SIDEWAYS
    // ---------------------------------------------------------

    if (majorDirection === "SIDEWAYS") {
      if (middleRange) {
        signal = "WAIT";

        reason =
          "Market is sideways and current price is in the middle of the range. No entry because the middle of the range is high risk.";
      } else if (
        rangePosition <= 0.35 &&
        bestSupport
      ) {
        signal = nearBuyPunca ? "BUY" : "WAIT";

        selectedPunca = buyPunca;

        if (nearBuyPunca) {
          entryZone = {
            low: roundPrice(buyPunca.low),
            high: roundPrice(buyPunca.high)
          };
        }

        reason =
          "Sideways market. Price is near the lower range/support area. Look for BUY at the valid support punca.";
      } else if (
        rangePosition >= 0.65 &&
        bestResistance
      ) {
        signal = nearSellPunca ? "SELL" : "WAIT";

        selectedPunca = sellPunca;

        if (nearSellPunca) {
          entryZone = {
            low: roundPrice(sellPunca.low),
            high: roundPrice(sellPunca.high)
          };
        }

        reason =
          "Sideways market. Price is near the upper range/resistance area. Look for SELL at the valid resistance punca.";
      } else {
        signal = "WAIT";

        reason =
          "Sideways market. Wait for price to reach support low or resistance high.";
      }
    }

    // =========================================================
    // 19. SL / TP
    // =========================================================

    let entry = null;
    let sl = null;
    let tp1 = null;
    let tp2 = null;

    if (entryZone) {
      entry = roundPrice(
        (entryZone.low + entryZone.high) / 2
      );

      if (signal === "BUY") {
        sl = roundPrice(entryZone.low - 3);
        tp1 = roundPrice(entry + 6);
        tp2 = roundPrice(entry + 12);
      }

      if (signal === "SELL") {
        sl = roundPrice(entryZone.high + 3);
        tp1 = roundPrice(entry - 6);
        tp2 = roundPrice(entry - 12);
      }
    }

    // =========================================================
    // 20. FINAL RESPONSE
    // =========================================================

    return res.status(200).json({
      symbol: "XAUUSD",

      price: roundPrice(currentPrice),

      signal: signal,

      major_direction: majorDirection,

      direction: directions,

      market_structure: {
        H4: directions.H4,
        H1: directions.H1,
        M30: directions.M30,
        M15: directions.M15,
        M5: directions.M5
      },

      range: {
        high: roundPrice(rangeHigh),
        low: roundPrice(rangeLow),
        position_percent: Number(
          (rangePosition * 100).toFixed(1)
        ),
        middle_range: middleRange
      },

      punca: selectedPunca
        ? {
            low: roundPrice(selectedPunca.low),
            high: roundPrice(selectedPunca.high),
            score: selectedPunca.score,
            timeframes: [
              ...new Set(selectedPunca.timeframes)
            ],
            sources: [
              ...new Set(selectedPunca.sources)
            ]
          }
        : null,

      entry_zone: entryZone,

      entry: entry,
      sl: sl,
      tp1: tp1,
      tp2: tp2,

      best_support: bestSupport
        ? {
            low: roundPrice(bestSupport.low),
            high: roundPrice(bestSupport.high),
            score: bestSupport.score,
            timeframes: [
              ...new Set(bestSupport.timeframes)
            ]
          }
        : null,

      best_resistance: bestResistance
        ? {
            low: roundPrice(bestResistance.low),
            high: roundPrice(bestResistance.high),
            score: bestResistance.score,
            timeframes: [
              ...new Set(bestResistance.timeframes)
            ]
          }
        : null,

      reason: reason,

      market_status:
        "Historical multi-timeframe SNR + DBD/RBR + breakout analysis",

      note:
        "SINNCI AI: H4/H1 direction first, historical punca second, current price mainly for entry timing."
    });

  } catch (error) {
    console.error("SINNCI AI ERROR:", error);

    return res.status(500).json({
      error: "SINNCI AI analysis temporarily unavailable"
    });
  }
        }
