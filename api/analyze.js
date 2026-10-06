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
    // 2. HELPERS
    // =========================================================

    function roundPrice(price) {
      return Number(price.toFixed(2));
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
    // 3. SWINGS
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

      if (h1 > h2 && l1 > l2) {
        return "BULLISH";
      }

      if (h1 < h2 && l1 < l2) {
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
    // 5. HISTORICAL SNR
    // =========================================================

    function findZones(candles) {
      const highs = findSwingHighs(candles);
      const lows = findSwingLows(candles);

      const zones = [];

      highs.forEach(s => {
        const c = candles[s.index];
        const range = candleRange(c);

        zones.push({
          type: "RESISTANCE",
          low: c.high - Math.max(range * 0.35, 0.5),
          high: c.high,
          index: s.index,
          score: 3,
          source: "OLD SWING HIGH"
        });
      });

      lows.forEach(s => {
        const c = candles[s.index];
        const range = candleRange(c);

        zones.push({
          type: "SUPPORT",
          low: c.low,
          high: c.low + Math.max(range * 0.35, 0.5),
          index: s.index,
          score: 3,
          source: "OLD SWING LOW"
        });
      });

      return zones;
    }

    // =========================================================
    // 6. RBR / DBD
    // =========================================================

    function findPatterns(candles) {
      const patterns = [];

      for (let i = 3; i < candles.length - 2; i++) {
        const a = candles[i + 2];
        const b = candles[i + 1];
        const c = candles[i];

        if (!a || !b || !c) continue;

        const aRange = candleRange(a);
        const bRange = candleRange(b);
        const cRange = candleRange(c);

        // DBD
        if (
          bearish(a) &&
          bearish(c) &&
          bRange < aRange &&
          bRange < cRange &&
          bodySize(a) > aRange * 0.45 &&
          bodySize(c) > cRange * 0.45
        ) {
          patterns.push({
            type: "SELL",
            low: b.low,
            high: b.high,
            index: i + 1,
            score: 7,
            source: "DROP BASE DROP"
          });
        }

        // RBR
        if (
          bullish(a) &&
          bullish(c) &&
          bRange < aRange &&
          bRange < cRange &&
          bodySize(a) > aRange * 0.45 &&
          bodySize(c) > cRange * 0.45
        ) {
          patterns.push({
            type: "BUY",
            low: b.low,
            high: b.high,
            index: i + 1,
            score: 7,
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

          if (
            zone.type === "RESISTANCE" &&
            c.close > zone.high
          ) {
            results.push({
              type: "SUPPORT",
              low: zone.low,
              high: zone.high,
              index: i,
              score: 5,
              source: "RESISTANCE BECOME SUPPORT"
            });

            break;
          }

          if (
            zone.type === "SUPPORT" &&
            c.close < zone.low
          ) {
            results.push({
              type: "RESISTANCE",
              low: zone.low,
              high: zone.high,
              index: i,
              score: 5,
              source: "SUPPORT BECOME RESISTANCE"
            });

            break;
          }
        }
      });

      return results;
    }

    // =========================================================
    // 8. BUILD HISTORICAL ANALYSIS
    // =========================================================

    const analysis = {};

    for (const [tf, candles] of Object.entries(market)) {
      const zones = findZones(candles);
      const patterns = findPatterns(candles);
      const breakouts = findBreakouts(candles, zones);

      analysis[tf] = {
        zones,
        patterns,
        breakouts
      };
    }

    // =========================================================
    // 9. COLLECT ALL ZONES
    // =========================================================

    const tfWeight = {
      H4: 5,
      H1: 4,
      M30: 3,
      M15: 2,
      M5: 1
    };

    const allZones = [];

    for (const [tf, data] of Object.entries(analysis)) {
      data.zones.forEach(z => {
        allZones.push({
          ...z,
          timeframe: tf,
          score: z.score + tfWeight[tf]
        });
      });

      data.patterns.forEach(p => {
        allZones.push({
          ...p,
          timeframe: tf,
          score: p.score + tfWeight[tf]
        });
      });

      data.breakouts.forEach(b => {
        allZones.push({
          ...b,
          timeframe: tf,
          score: b.score + tfWeight[tf]
        });
      });
    }

    // =========================================================
    // 10. MERGE NEARBY ZONES
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
          existing.low = Math.min(
            existing.low,
            zone.low
          );

          existing.high = Math.max(
            existing.high,
            zone.high
          );

          existing.score += zone.score;

          existing.timeframes.push(
            zone.timeframe
          );

          if (
            zone.source &&
            !existing.sources.includes(zone.source)
          ) {
            existing.sources.push(zone.source);
          }
        } else {
          merged.push({
            type: zone.type,
            low: zone.low,
            high: zone.high,
            score: zone.score,
            timeframes: [zone.timeframe],
            sources: [
              zone.source || zone.type
            ]
          });
        }
      }

      return merged;
    }

    const mergedZones = mergeZones(allZones);

    // =========================================================
    // 11. CURRENT PRICE
    // =========================================================

    const currentPrice =
      Number(market.M5[0].close);

    // =========================================================
    // 12. MAJOR DIRECTION
    //
    // H4 = MAIN ANCHOR
    // H1 = CONFIRM / CONSOLIDATION
    // =========================================================

    let majorDirection = "SIDEWAYS";
    let directionReason = "";

    if (
      directions.H4 === "BEARISH" &&
      (
        directions.H1 === "BEARISH" ||
        directions.H1 === "SIDEWAYS"
      )
    ) {
      majorDirection = "BEARISH";

      directionReason =
        "H4 bearish. H1 is bearish/sideways, so the higher-timeframe bias remains bearish.";
    }

    else if (
      directions.H4 === "BULLISH" &&
      (
        directions.H1 === "BULLISH" ||
        directions.H1 === "SIDEWAYS"
      )
    ) {
      majorDirection = "BULLISH";

      directionReason =
        "H4 bullish. H1 is bullish/sideways, so the higher-timeframe bias remains bullish.";
    }

    else if (
      directions.H4 === "BEARISH" &&
      directions.H1 === "BULLISH"
    ) {
      majorDirection = "SIDEWAYS";

      directionReason =
        "H4 bearish but H1 bullish. Higher-timeframe conflict, so SINNCI will not force BUY or SELL.";
    }

    else if (
      directions.H4 === "BULLISH" &&
      directions.H1 === "BEARISH"
    ) {
      majorDirection = "SIDEWAYS";

      directionReason =
        "H4 bullish but H1 bearish. Higher-timeframe conflict, so SINNCI will not force BUY or SELL.";
    }

    // =========================================================
    // 13. H1 RANGE
    // =========================================================

    const recentH1 = market.H1.slice(0, 60);

    const rangeHigh = Math.max(
      ...recentH1.map(c => c.high)
    );

    const rangeLow = Math.min(
      ...recentH1.map(c => c.low)
    );

    const rangeSize =
      rangeHigh - rangeLow;

    const rangePosition =
      rangeSize > 0
        ? (currentPrice - rangeLow) / rangeSize
        : 0.5;

    const middleRange =
      rangePosition > 0.35 &&
      rangePosition < 0.65;

    // =========================================================
    // 14. BEST ZONES
    // =========================================================

    function bestZone(type) {
      const candidates = mergedZones
        .filter(z => z.type === type)
        .sort((a, b) => b.score - a.score);

      return candidates.length
        ? candidates[0]
        : null;
    }

    const bestSupport =
      bestZone("SUPPORT");

    const bestResistance =
      bestZone("RESISTANCE");

    // =========================================================
    // 15. DIRECTIONAL PUNCA
    // =========================================================

    function bestPunca(type, direction) {
      const candidates = mergedZones
        .filter(z => {
          if (z.type !== type) return false;

          if (direction === "BUY") {
            return z.sources.some(s =>
              String(s).includes("RALLY BASE RALLY") ||
              String(s).includes("OLD SWING LOW") ||
              String(s).includes("RESISTANCE BECOME SUPPORT")
            );
          }

          if (direction === "SELL") {
            return z.sources.some(s =>
              String(s).includes("DROP BASE DROP") ||
              String(s).includes("OLD SWING HIGH") ||
              String(s).includes("SUPPORT BECOME RESISTANCE")
            );
          }

          return false;
        })
        .sort((a, b) => b.score - a.score);

      return candidates.length
        ? candidates[0]
        : null;
    }

    const buyPunca =
      bestPunca("SUPPORT", "BUY") ||
      bestSupport;

    const sellPunca =
      bestPunca("RESISTANCE", "SELL") ||
      bestResistance;

    // =========================================================
    // 16. PRICE NEAR PUNCA
    // =========================================================

    function priceNearZone(price, zone) {
      if (!zone) return false;

      const zoneSize =
        Math.max(zone.high - zone.low, 0.5);

      const buffer =
        Math.max(zoneSize * 0.5, 1.0);

      return (
        price >= zone.low - buffer &&
        price <= zone.high + buffer
      );
    }

    const nearBuyPunca =
      priceNearZone(
        currentPrice,
        buyPunca
      );

    const nearSellPunca =
      priceNearZone(
        currentPrice,
        sellPunca
      );

    // =========================================================
    // 17. FINAL SIGNAL
    // =========================================================

    let signal = "WAIT";
    let entryZone = null;
    let selectedPunca = null;
    let reason = directionReason;

    // =========================================================
    // BEARISH
    // =========================================================

    if (majorDirection === "BEARISH") {
      selectedPunca = sellPunca;

      if (
        sellPunca &&
        nearSellPunca
      ) {
        signal = "SELL";

        entryZone = {
          low: roundPrice(
            sellPunca.low
          ),
          high: roundPrice(
            sellPunca.high
          )
        };

        reason =
          directionReason +
          " Price is now at the historical SELL punca. Wait for bearish confirmation before entry.";
      } else {
        signal = "WAIT";

        reason =
          directionReason +
          " Price has not reached the historical SELL punca. Do not chase price. Wait for price to return to the resistance/supply area.";
      }
    }

    // =========================================================
    // BULLISH
    // =========================================================

    if (majorDirection === "BULLISH") {
      selectedPunca = buyPunca;

      if (
        buyPunca &&
        nearBuyPunca
      ) {
        signal = "BUY";

        entryZone = {
          low: roundPrice(
            buyPunca.low
          ),
          high: roundPrice(
            buyPunca.high
          )
        };

        reason =
          directionReason +
          " Price is now at the historical BUY punca. Wait for bullish confirmation before entry.";
      } else {
        signal = "WAIT";

        reason =
          directionReason +
          " Price has not reached the historical BUY punca. Do not chase price. Wait for price to return to the support/demand area.";
      }
    }

    // =========================================================
    // TRUE SIDEWAYS / CONFLICT
    // =========================================================

    if (majorDirection === "SIDEWAYS") {
      selectedPunca = null;

      if (middleRange) {
        signal = "WAIT";

        reason =
          directionReason +
          " Current price is in the middle of the range. No trade.";
      }

      else if (
        rangePosition <= 0.35 &&
        buyPunca &&
        nearBuyPunca
      ) {
        signal = "BUY";
        selectedPunca = buyPunca;

        entryZone = {
          low: roundPrice(
            buyPunca.low
          ),
          high: roundPrice(
            buyPunca.high
          )
        };

        reason =
          directionReason +
          " Price is at the lower range and near a valid historical BUY punca.";
      }

      else if (
        rangePosition >= 0.65 &&
        sellPunca &&
        nearSellPunca
      ) {
        signal = "SELL";
        selectedPunca = sellPunca;

        entryZone = {
          low: roundPrice(
            sellPunca.low
          ),
          high: roundPrice(
            sellPunca.high
          )
        };

        reason =
          directionReason +
          " Price is at the upper range and near a valid historical SELL punca.";
      }

      else {
        signal = "WAIT";

        reason =
          directionReason +
          " Wait for price to reach a valid support or resistance punca.";
      }
    }

    // =========================================================
    // 18. SL / TP
    // =========================================================

    let entry = null;
    let sl = null;
    let tp1 = null;
    let tp2 = null;

    if (entryZone) {
      entry = roundPrice(
        (entryZone.low +
          entryZone.high) / 2
      );

      const zoneSize =
        Math.max(
          entryZone.high -
          entryZone.low,
          1
        );

      const slBuffer =
        Math.max(
          zoneSize * 0.75,
          2
        );

      if (signal === "BUY") {
        sl = roundPrice(
          entryZone.low - slBuffer
        );

        tp1 = roundPrice(
          entry + zoneSize * 2
        );

        tp2 = roundPrice(
          entry + zoneSize * 4
        );
      }

      if (signal === "SELL") {
        sl = roundPrice(
          entryZone.high + slBuffer
        );

        tp1 = roundPrice(
          entry - zoneSize * 2
        );

        tp2 = roundPrice(
          entry - zoneSize * 4
        );
      }
    }

    // =========================================================
    // 19. RESPONSE
    // =========================================================

    return res.status(200).json({
      symbol: "XAUUSD",

      price:
        roundPrice(currentPrice),

      signal,

      major_direction:
        majorDirection,

      direction:
        directions,

      market_structure: {
        H4: directions.H4,
        H1: directions.H1,
        M30: directions.M30,
        M15: directions.M15,
        M5: directions.M5
      },

      range: {
        high:
          roundPrice(rangeHigh),

        low:
          roundPrice(rangeLow),

        position_percent:
          Number(
            (
              rangePosition * 100
            ).toFixed(1)
          ),

        middle_range:
          middleRange
      },

      punca: selectedPunca
        ? {
            low:
              roundPrice(
                selectedPunca.low
              ),

            high:
              roundPrice(
                selectedPunca.high
              ),

            score:
              selectedPunca.score,

            timeframes: [
              ...new Set(
                selectedPunca.timeframes
              )
            ],

            sources: [
              ...new Set(
                selectedPunca.sources
              )
            ]
          }
        : null,

      entry_zone:
        entryZone,

      entry,
      sl,
      tp1,
      tp2,

      best_support:
        bestSupport
          ? {
              low:
                roundPrice(
                  bestSupport.low
                ),

              high:
                roundPrice(
                  bestSupport.high
                ),

              score:
                bestSupport.score,

              timeframes: [
                ...new Set(
                  bestSupport.timeframes
                )
              ]
            }
          : null,

      best_resistance:
        bestResistance
          ? {
              low:
                roundPrice(
                  bestResistance.low
                ),

              high:
                roundPrice(
                  bestResistance.high
                ),

              score:
                bestResistance.score,

              timeframes: [
                ...new Set(
                  bestResistance.timeframes
                )
              ]
            }
          : null,

      reason,

      market_status:
        "SINNCI Historical SNR + Punca + DBD/RBR + Breakout Analysis",

      note:
        "H4 is the main direction anchor. H1 confirms or consolidates. Historical punca is prioritized before current price. Current price is mainly used for timing."
    });

  } catch (error) {
    console.error(
      "SINNCI AI ERROR:",
      error
    );

    return res.status(500).json({
      error:
        "SINNCI AI analysis temporarily unavailable"
    });
  }
}
