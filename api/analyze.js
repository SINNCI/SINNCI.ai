export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        status: "error",
        error: "API key not configured"
      });
    }

    const SYMBOL = "XAU/USD";
    const PRICE_SYMBOL = "XAUUSD";

    // =========================================================
    // SINNCI MARKET ENGINE PRO 2.0
    // CMP-FIRST SCALPING / SELECTIVE INTRADAY
    // =========================================================

    const POINT = 0.01;

    // FIXED RISK MODEL
    const SCALP_SL_POINTS = 500;
    const SCALP_TP1_POINTS = 600;
    const SCALP_TP2_POINTS = 1200;

    const INTRA_SL_POINTS = 500;
    const INTRA_TP1_POINTS = 1600;
    const INTRA_TP2_POINTS = 2500;

    // =========================================================
    // CACHE
    // =========================================================

    const now = Date.now();

    if (!globalThis.__SINNCI_PRO_CACHE) {
      globalThis.__SINNCI_PRO_CACHE = {
        data: null,
        timestamp: 0
      };
    }

    if (
      globalThis.__SINNCI_PRO_CACHE.data &&
      now - globalThis.__SINNCI_PRO_CACHE.timestamp < 60000
    ) {
      return res.status(200).json(
        globalThis.__SINNCI_PRO_CACHE.data
      );
    }

    // =========================================================
    // HELPERS
    // =========================================================

    const safeNum = (v, fallback = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    const round = (v, d = 2) => {
      const p = Math.pow(10, d);
      return Math.round(v * p) / p;
    };

    const clamp = (v, min, max) =>
      Math.max(min, Math.min(max, v));

    const pointsToPrice = points =>
      points * POINT;

    const priceToPoints = price =>
      price / POINT;

    const avg = arr => {
      const a = arr.filter(Number.isFinite);

      if (!a.length) return 0;

      return a.reduce(
        (sum, value) => sum + value,
        0
      ) / a.length;
    };

    const candleBody = c =>
      Math.abs(
        safeNum(c.close) -
        safeNum(c.open)
      );

    const candleRange = c =>
      Math.max(
        0.0001,
        safeNum(c.high) -
        safeNum(c.low)
      );

    const upperWick = c =>
      safeNum(c.high) -
      Math.max(
        safeNum(c.open),
        safeNum(c.close)
      );

    const lowerWick = c =>
      Math.min(
        safeNum(c.open),
        safeNum(c.close)
      ) -
      safeNum(c.low);

    const bullish = c =>
      safeNum(c.close) >
      safeNum(c.open);

    const bearish = c =>
      safeNum(c.close) <
      safeNum(c.open);

    const bodyRatio = c =>
      candleBody(c) /
      candleRange(c);

    const distancePoints = (a, b) =>
      priceToPoints(
        Math.abs(a - b)
      );

    // =========================================================
    // TWELVE DATA
    // =========================================================

    async function getCandles(
      interval,
      outputsize = 100
    ) {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(SYMBOL)}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${encodeURIComponent(API_KEY)}`;

      const response =
        await fetch(url);

      const text =
        await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          `Invalid Twelve Data response for ${interval}`
        );
      }

      if (
        data.status === "error" ||
        data.code ||
        !Array.isArray(data.values)
      ) {
        throw new Error(
          data.message ||
          `No candle data for ${interval}`
        );
      }

      return data.values
        .map(c => ({
          datetime: c.datetime,
          open: safeNum(c.open),
          high: safeNum(c.high),
          low: safeNum(c.low),
          close: safeNum(c.close)
        }))
        .filter(c =>
          c.open &&
          c.high &&
          c.low &&
          c.close
        )
        .reverse();
    }

    // =========================================================
    // FETCH MTF
    // =========================================================

    const [
      H4,
      H1,
      M15,
      M5
    ] = await Promise.all([
      getCandles("4h", 100),
      getCandles("1h", 100),
      getCandles("15min", 100),
      getCandles("5min", 120)
    ]);

    if (
      H4.length < 20 ||
      H1.length < 20 ||
      M15.length < 20 ||
      M5.length < 30
    ) {
      throw new Error(
        "Not enough market data"
      );
    }

    // =========================================================
    // ATR
    // =========================================================

    function calculateATR(
      candles,
      period = 14
    ) {
      if (
        candles.length <
        period + 1
      ) {
        return 0;
      }

      const trs = [];

      for (
        let i =
          candles.length - period;
        i < candles.length;
        i++
      ) {
        const c = candles[i];
        const prev = candles[i - 1];

        if (!prev) continue;

        const tr =
          Math.max(
            c.high - c.low,
            Math.abs(
              c.high - prev.close
            ),
            Math.abs(
              c.low - prev.close
            )
          );

        trs.push(tr);
      }

      return avg(trs);
    }

    const atr = {
      H4: calculateATR(H4),
      H1: calculateATR(H1),
      M15: calculateATR(M15),
      M5: calculateATR(M5)
    };

    // =========================================================
    // SWING POINTS
    // =========================================================

    function getSwingPoints(
      candles,
      left = 2,
      right = 2
    ) {
      const highs = [];
      const lows = [];

      for (
        let i = left;
        i <
        candles.length - right;
        i++
      ) {
        const c = candles[i];

        let isHigh = true;
        let isLow = true;

        for (
          let j = 1;
          j <= left;
          j++
        ) {
          if (
            candles[i - j].high >=
              c.high
          ) {
            isHigh = false;
          }

          if (
            candles[i - j].low <=
              c.low
          ) {
            isLow = false;
          }
        }

        for (
          let j = 1;
          j <= right;
          j++
        ) {
          if (
            candles[i + j].high >=
              c.high
          ) {
            isHigh = false;
          }

          if (
            candles[i + j].low <=
              c.low
          ) {
            isLow = false;
          }
        }

        if (isHigh) {
          highs.push({
            index: i,
            price: c.high,
            datetime: c.datetime
          });
        }

        if (isLow) {
          lows.push({
            index: i,
            price: c.low,
            datetime: c.datetime
          });
        }
      }

      return {
        highs,
        lows
      };
    }

    // =========================================================
    // STRUCTURE
    // =========================================================

    function getStructure(
      candles
    ) {
      const swings =
        getSwingPoints(candles);

      const highs =
        swings.highs.slice(-5);

      const lows =
        swings.lows.slice(-5);

      let direction =
        "NEUTRAL";

      if (
        highs.length >= 2 &&
        lows.length >= 2
      ) {
        const h1 =
          highs[highs.length - 2]
            .price;

        const h2 =
          highs[highs.length - 1]
            .price;

        const l1 =
          lows[lows.length - 2]
            .price;

        const l2 =
          lows[lows.length - 1]
            .price;

        if (
          h2 > h1 &&
          l2 > l1
        ) {
          direction =
            "BULLISH";
        }

        if (
          h2 < h1 &&
          l2 < l1
        ) {
          direction =
            "BEARISH";
        }
      }

      return {
        direction,
        highs,
        lows,

        latestHigh:
          highs.length
            ? highs[highs.length - 1]
                .price
            : null,

        previousHigh:
          highs.length >= 2
            ? highs[highs.length - 2]
                .price
            : null,

        latestLow:
          lows.length
            ? lows[lows.length - 1]
                .price
            : null,

        previousLow:
          lows.length >= 2
            ? lows[lows.length - 2]
                .price
            : null
      };
    }

    const structureH4 =
      getStructure(H4);

    const structureH1 =
      getStructure(H1);

    const structureM15 =
      getStructure(M15);

    const structureM5 =
      getStructure(M5);

    // =========================================================
    // DIRECTION
    // =========================================================

    function getDirection(
      candles
    ) {
      const s =
        getStructure(candles);

      if (
        s.direction !==
        "NEUTRAL"
      ) {
        return s.direction;
      }

      const recent =
        candles.slice(-10);

      const bull =
        recent.filter(
          bullish
        ).length;

      const bear =
        recent.filter(
          bearish
        ).length;

      if (
        bull >= bear + 2
      ) {
        return "BULLISH";
      }

      if (
        bear >= bull + 2
      ) {
        return "BEARISH";
      }

      return "NEUTRAL";
    }

    const direction = {
      H4: getDirection(H4),
      H1: getDirection(H1),
      M15: getDirection(M15),
      M5: getDirection(M5)
    };

    // =========================================================
    // CURRENT PRICE
    // =========================================================

    const currentPrice =
      safeNum(
        M5[M5.length - 1].close
      );

    // =========================================================
    // CANDLE ZONE
    // =========================================================

    function candleZone(
      c,
      type,
      source
    ) {
      const bodyHigh =
        Math.max(
          c.open,
          c.close
        );

      const bodyLow =
        Math.min(
          c.open,
          c.close
        );

      return {
        type,
        source,

        high: round(
          c.high,
          2
        ),

        low: round(
          c.low,
          2
        ),

        bodyHigh: round(
          bodyHigh,
          2
        ),

        bodyLow: round(
          bodyLow,
          2
        ),

        midpoint: round(
          (c.high + c.low) / 2,
          2
        ),

        datetime:
          c.datetime,

        range: round(
          c.high - c.low,
          2
        ),

        body: round(
          candleBody(c),
          2
        ),

        upperWick: round(
          upperWick(c),
          2
        ),

        lowerWick: round(
          lowerWick(c),
          2
        )
      };
    }

    // =========================================================
    // BUILD SMART ZONES
    // =========================================================

    function buildZones(
      candles,
      source
    ) {
      const zones = [];

      const start =
        Math.max(
          2,
          candles.length - 40
        );

      for (
        let i = start;
        i < candles.length - 1;
        i++
      ) {
        const c =
          candles[i];

        const next =
          candles[i + 1];

        const range =
          candleRange(c);

        const body =
          candleBody(c);

        if (
          range <= 0
        ) {
          continue;
        }

        const bodyPct =
          body / range;

        const displacement =
          Math.abs(
            next.close -
            c.close
          );

        let type = null;

        if (
          bullish(c) &&
          bodyPct >= 0.40
        ) {
          type = "DEMAND";
        }

        if (
          bearish(c) &&
          bodyPct >= 0.40
        ) {
          type = "SUPPLY";
        }

        if (
          displacement >
          Math.max(
            safeNum(
              atr[source]
            ) * 0.40,
            POINT * 30
          )
        ) {
          type =
            bullish(c)
              ? "DEMAND"
              : "SUPPLY";
        }

        if (!type) {
          continue;
        }

        const zone =
          candleZone(
            c,
            type,
            source
          );

        // Touch count
        let touches = 0;

        for (
          let j = i + 1;
          j < candles.length;
          j++
        ) {
          if (
            candles[j].high >=
              zone.low &&
            candles[j].low <=
              zone.high
          ) {
            touches++;
          }
        }

        zone.touches =
          touches;

        zone.fresh =
          touches <= 1;

        zone.firstTouch =
          touches === 1;

        zone.displacement =
          displacement;

        zones.push(zone);
      }

      return zones;
    }

    const zonesH1 =
      buildZones(H1, "H1");

    const zonesM15 =
      buildZones(M15, "M15");

    const zonesM5 =
      buildZones(M5, "M5");

    const allZones = [
      ...zonesH1,
      ...zonesM15,
      ...zonesM5
    ];

    // =========================================================
    // ZONE QUALITY
    // =========================================================

    function zoneQuality(
      zone
    ) {
      let score = 0;

      if (
        zone.source === "H1"
      ) {
        score += 32;
      }

      if (
        zone.source === "M15"
      ) {
        score += 25;
      }

      if (
        zone.source === "M5"
      ) {
        score += 15;
      }

      const dist =
        distancePoints(
          currentPrice,
          zone.midpoint
        );

      if (
        dist <= 50
      ) {
        score += 25;
      } else if (
        dist <= 100
      ) {
        score += 21;
      } else if (
        dist <= 180
      ) {
        score += 15;
      } else if (
        dist <= 300
      ) {
        score += 8;
      } else if (
        dist <= 500
      ) {
        score += 3;
      }

      if (
        zone.fresh
      ) {
        score += 8;
      }

      if (
        zone.firstTouch
      ) {
        score += 5;
      }

      if (
        zone.body >
        POINT * 25
      ) {
        score += 6;
      }

      if (
        zone.displacement >
        POINT * 40
      ) {
        score += 5;
      }

      if (
        zone.touches >= 4
      ) {
        score -= 10;
      }

      return clamp(
        Math.round(score),
        0,
        100
      );
    }

    allZones.forEach(
      z => {
        z.quality =
          zoneQuality(z);
      }
    );

    // =========================================================
    // NEAREST SUPPORT / RESISTANCE
    // =========================================================

    function nearestLevels(
      candles
    ) {
      const swings =
        getSwingPoints(candles);

      const supports =
        swings.lows
          .map(x => x.price)
          .filter(
            x =>
              x < currentPrice
          );

      const resistances =
        swings.highs
          .map(x => x.price)
          .filter(
            x =>
              x > currentPrice
          );

      supports.sort(
        (a, b) =>
          Math.abs(
            currentPrice - a
          ) -
          Math.abs(
            currentPrice - b
          )
      );

      resistances.sort(
        (a, b) =>
          Math.abs(
            currentPrice - a
          ) -
          Math.abs(
            currentPrice - b
          )
      );

      return {
        support:
          supports.length
            ? supports[0]
            : null,

        resistance:
          resistances.length
            ? resistances[0]
            : null
      };
    }

    const levelsM15 =
      nearestLevels(M15);

    const levelsM5 =
      nearestLevels(M5);

    // =========================================================
    // M15 CANDLE STATUS
    // =========================================================

    const m15Current =
      M15[M15.length - 1];

    const m15Closed =
      M15[M15.length - 2];

    // =========================================================
    // M15 BREAK
    // FORMING CANDLE NEVER CONFIRMED
    // =========================================================

    function detectM15Break() {
      const range =
        M15.slice(-22, -2);

      const rangeHigh =
        Math.max(
          ...range.map(
            c => c.high
          )
        );

      const rangeLow =
        Math.min(
          ...range.map(
            c => c.low
          )
        );

      if (
        m15Closed.close >
        rangeHigh
      ) {
        return {
          type:
            "BULLISH_BREAK",
          confirmed: true,
          level:
            round(
              rangeHigh,
              2
            )
        };
      }

      if (
        m15Closed.close <
        rangeLow
      ) {
        return {
          type:
            "BEARISH_BREAK",
          confirmed: true,
          level:
            round(
              rangeLow,
              2
            )
        };
      }

      if (
        m15Current.close >
        rangeHigh
      ) {
        return {
          type:
            "BULLISH_BREAK_FORMING",
          confirmed: false,
          level:
            round(
              rangeHigh,
              2
            )
        };
      }

      if (
        m15Current.close <
        rangeLow
      ) {
        return {
          type:
            "BEARISH_BREAK_FORMING",
          confirmed: false,
          level:
            round(
              rangeLow,
              2
            )
        };
      }

      return {
        type: "NONE",
        confirmed: false,
        level: null
      };
    }

    const m15Break =
      detectM15Break();

    // =========================================================
    // FLIP SBR / RBS
    // =========================================================

    function detectFlip() {
      const result = {
        bullish: null,
        bearish: null
      };

      if (
        structureM15.latestHigh &&
        m15Closed.close >
          structureM15.latestHigh
      ) {
        result.bullish = {
          role: "RBS",
          level:
            round(
              structureM15.latestHigh,
              2
            ),
          status:
            "SUPPORT_AFTER_BREAK"
        };
      }

      if (
        structureM15.latestLow &&
        m15Closed.close <
          structureM15.latestLow
      ) {
        result.bearish = {
          role: "SBR",
          level:
            round(
              structureM15.latestLow,
              2
            ),
          status:
            "RESISTANCE_AFTER_BREAK"
        };
      }

      return result;
    }

    const flip =
      detectFlip();

    // =========================================================
    // LIQUIDITY SWEEP
    // =========================================================

    function detectLiquiditySweep(
      candles
    ) {
      if (
        candles.length < 8
      ) {
        return {
          bullish: false,
          bearish: false,
          level: null
        };
      }

      const last =
        candles[candles.length - 1];

      const previous =
        candles.slice(-7, -1);

      const previousLow =
        Math.min(
          ...previous.map(
            c => c.low
          )
        );

      const previousHigh =
        Math.max(
          ...previous.map(
            c => c.high
          )
        );

      const bullishSweep =
        last.low <
          previousLow &&
        last.close >
          previousLow &&
        lowerWick(last) >=
          Math.max(
            candleBody(last) * 0.8,
            POINT * 5
          );

      const bearishSweep =
        last.high >
          previousHigh &&
        last.close <
          previousHigh &&
        upperWick(last) >=
          Math.max(
            candleBody(last) * 0.8,
            POINT * 5
          );

      return {
        bullish:
          bullishSweep,

        bearish:
          bearishSweep,

        level:
          bullishSweep
            ? round(
                previousLow,
                2
              )
            : bearishSweep
            ? round(
                previousHigh,
                2
              )
            : null
      };
    }

    const liquidityM5 =
      detectLiquiditySweep(M5);

    const liquidityM15 =
      detectLiquiditySweep(M15);

    // =========================================================
    // DOUBLE TOP / BOTTOM
    // =========================================================

    function detectDouble(
      candles
    ) {
      const s =
        getSwingPoints(candles);

      const tolerance =
        Math.max(
          POINT * 35,
          atr.M5 * 0.35
        );

      if (
        s.highs.length >= 2
      ) {
        const h1 =
          s.highs[
            s.highs.length - 2
          ].price;

        const h2 =
          s.highs[
            s.highs.length - 1
          ].price;

        if (
          Math.abs(h1 - h2) <=
          tolerance
        ) {
          return {
            type:
              "DOUBLE_TOP",
            level:
              round(
                Math.max(h1, h2),
                2
              )
          };
        }
      }

      if (
        s.lows.length >= 2
      ) {
        const l1 =
          s.lows[
            s.lows.length - 2
          ].price;

        const l2 =
          s.lows[
            s.lows.length - 1
          ].price;

        if (
          Math.abs(l1 - l2) <=
          tolerance
        ) {
          return {
            type:
              "DOUBLE_BOTTOM",
            level:
              round(
                Math.min(l1, l2),
                2
              )
          };
        }
      }

      return {
        type: "NONE",
        level: null
      };
    }

    const doubleM5 =
      detectDouble(M5);

    // =========================================================
    // QUASIMODO
    // =========================================================

    function detectQM(
      candles
    ) {
      const s =
        getSwingPoints(candles);

      if (
        s.highs.length >= 3 &&
        s.lows.length >= 3
      ) {
        const h1 =
          s.highs[
            s.highs.length - 3
          ].price;

        const h2 =
          s.highs[
            s.highs.length - 2
          ].price;

        const h3 =
          s.highs[
            s.highs.length - 1
          ].price;

        const l1 =
          s.lows[
            s.lows.length - 3
          ].price;

        const l2 =
          s.lows[
            s.lows.length - 2
          ].price;

        const l3 =
          s.lows[
            s.lows.length - 1
          ].price;

        // QM SELL
        if (
          h2 > h1 &&
          h2 > h3 &&
          l2 < l1
        ) {
          return {
            type:
              "QM_SELL",
            level:
              round(
                h3,
                2
              )
          };
        }

        // QM BUY
        if (
          l2 < l1 &&
          l2 < l3 &&
          h2 > h1
        ) {
          return {
            type:
              "QM_BUY",
            level:
              round(
                l3,
                2
              )
          };
        }
      }

      return {
        type: "NONE",
        level: null
      };
    }

    const qmM5 =
      detectQM(M5);

    // =========================================================
    // M5 TRIGGERS
    // =========================================================

    function detectM5Trigger() {
      const last =
        M5[M5.length - 1];

      const prev =
        M5[M5.length - 2];

      const prev2 =
        M5[M5.length - 3];

      const buy = [];
      const sell = [];

      // Bullish engulfing
      if (
        bearish(prev) &&
        bullish(last) &&
        last.close >=
          prev.open &&
        last.open <=
          prev.close
      ) {
        buy.push(
          "BULLISH_ENGULFING"
        );
      }

      // Bearish engulfing
      if (
        bullish(prev) &&
        bearish(last) &&
        last.close <=
          prev.open &&
        last.open >=
          prev.close
      ) {
        sell.push(
          "BEARISH_ENGULFING"
        );
      }

      // Bullish rejection
      if (
        lowerWick(last) >
          candleBody(last) * 1.15 &&
        last.close >
          last.low +
          candleRange(last) *
            0.55
      ) {
        buy.push(
          "BULLISH_REJECTION"
        );
      }

      // Bearish rejection
      if (
        upperWick(last) >
          candleBody(last) * 1.15 &&
        last.close <
          last.low +
          candleRange(last) *
            0.45
      ) {
        sell.push(
          "BEARISH_REJECTION"
        );
      }

      // Bullish displacement
      if (
        bullish(last) &&
        bodyRatio(last) >=
          0.62 &&
        last.close >
          last.low +
          candleRange(last) *
            0.72
      ) {
        buy.push(
          "BULLISH_DISPLACEMENT"
        );
      }

      // Bearish displacement
      if (
        bearish(last) &&
        bodyRatio(last) >=
          0.62 &&
        last.close <
          last.low +
          candleRange(last) *
            0.28
      ) {
        sell.push(
          "BEARISH_DISPLACEMENT"
        );
      }

      // Micro BOS
      if (
        prev2 &&
        last.close >
          prev2.high
      ) {
        buy.push(
          "M5_STRUCTURE_SHIFT"
        );
      }

      if (
        prev2 &&
        last.close <
          prev2.low
      ) {
        sell.push(
          "M5_STRUCTURE_SHIFT"
        );
      }

      return {
        buy,
        sell,

        strongest:
          buy.length > sell.length
            ? "BUY"
            : sell.length > buy.length
            ? "SELL"
            : "NEUTRAL"
      };
    }

    const m5Trigger =
      detectM5Trigger();

    // =========================================================
    // CMP MARKET MAP
    // =========================================================

    function getCmpLocation() {
      let nearestZone = null;
      let minDistance =
        Infinity;

      for (
        const z of allZones
      ) {
        const inside =
          currentPrice >= z.low &&
          currentPrice <= z.high;

        const distance =
          inside
            ? 0
            : Math.min(
                Math.abs(
                  currentPrice -
                    z.low
                ),
                Math.abs(
                  currentPrice -
                    z.high
                )
              );

        if (
          distance <
          minDistance
        ) {
          minDistance =
            distance;

          nearestZone = {
            ...z,
            inside
          };
        }
      }

      if (!nearestZone) {
        return {
          state:
            "NO_ZONE",
          zone: null,
          distancePoints:
            null
        };
      }

      const dp =
        priceToPoints(
          minDistance
        );

      let state =
        "FAR_FROM_ZONE";

      if (
        nearestZone.inside
      ) {
        state =
          "INSIDE_ZONE";
      } else if (
        dp <= 50
      ) {
        state =
          "APPROACHING_ZONE";
      } else if (
        dp <= 120
      ) {
        state =
          "NEAR_ZONE";
      }

      return {
        state,
        zone:
          nearestZone,
        distancePoints:
          round(dp, 0)
      };
    }

    const cmpLocation =
      getCmpLocation();

    // =========================================================
    // ZONE DIRECTION
    // =========================================================

    function zoneDirection(
      zone
    ) {
      if (!zone) {
        return "NEUTRAL";
      }

      if (
        zone.type ===
        "DEMAND"
      ) {
        return "BUY";
      }

      if (
        zone.type ===
        "SUPPLY"
      ) {
        return "SELL";
      }

      return "NEUTRAL";
    }

    const zoneDir =
      zoneDirection(
        cmpLocation.zone
      );

    // =========================================================
    // CMP REACTION
    // =========================================================

    function getCmpReaction() {
      const last =
        M5[M5.length - 1];

      if (
        !cmpLocation.zone
      ) {
        return "NO_ZONE";
      }

      const zone =
        cmpLocation.zone;

      if (
        zone.type ===
        "DEMAND"
      ) {
        if (
          liquidityM5.bullish
        ) {
          return "LIQUIDITY_SWEEP_BUY";
        }

        if (
          bullish(last)
        ) {
          return "REJECTING_DEMAND";
        }

        if (
          last.low <
          zone.low
        ) {
          return "BREAKING_DEMAND";
        }

        return "TESTING_DEMAND";
      }

      if (
        zone.type ===
        "SUPPLY"
      ) {
        if (
          liquidityM5.bearish
        ) {
          return "LIQUIDITY_SWEEP_SELL";
        }

        if (
          bearish(last)
        ) {
          return "REJECTING_SUPPLY";
        }

        if (
          last.high >
          zone.high
        ) {
          return "BREAKING_SUPPLY";
        }

        return "TESTING_SUPPLY";
      }

      return "NEUTRAL";
    }

    const reaction =
      getCmpReaction();

    // =========================================================
    // M15 SUPPORT / RESISTANCE TEST
    // =========================================================

    function getM15Test() {
      return {
        support:
          levelsM15.support &&
          distancePoints(
            currentPrice,
            levelsM15.support
          ) <= 80,

        resistance:
          levelsM15.resistance &&
          distancePoints(
            currentPrice,
            levelsM15.resistance
          ) <= 80
      };
    }

    const m15Test =
      getM15Test();

    // =========================================================
    // EARLY M5 BREAK
    // =========================================================

    function detectEarlyBreak() {
      const last =
        M5[M5.length - 1];

      return {
        bullish:
          !!(
            levelsM15.resistance &&
            last.close >
              levelsM15.resistance
          ),

        bearish:
          !!(
            levelsM15.support &&
            last.close <
              levelsM15.support
          ),

        support:
          levelsM15.support,

        resistance:
          levelsM15.resistance
      };
    }

    const earlyBreak =
      detectEarlyBreak();

    // =========================================================
    // MARKET REGIME
    // =========================================================

    function detectRegime() {
      const dirs = [
        direction.H4,
        direction.H1,
        direction.M15,
        direction.M5
      ];

      const bullCount =
        dirs.filter(
          x => x === "BULLISH"
        ).length;

      const bearCount =
        dirs.filter(
          x => x === "BEARISH"
        ).length;

      if (
        m15Break.confirmed
      ) {
        return (
          m15Break.type ===
          "BULLISH_BREAK"
            ? "BREAKOUT_BULLISH"
            : "BREAKOUT_BEARISH"
        );
      }

      if (
        bullCount >= 3
      ) {
        return "TRENDING_BULLISH";
      }

      if (
        bearCount >= 3
      ) {
        return "TRENDING_BEARISH";
      }

      if (
        liquidityM5.bullish ||
        liquidityM15.bullish
      ) {
        return "REVERSAL_BULLISH";
      }

      if (
        liquidityM5.bearish ||
        liquidityM15.bearish
      ) {
        return "REVERSAL_BEARISH";
      }

      const recentRanges =
        M5.slice(-15).map(
          c =>
            c.high -
            c.low
        );

      const avgRange =
        avg(recentRanges);

      if (
        avgRange >
        atr.M5 * 1.35
      ) {
        return "HIGH_VOLATILITY";
      }

      return "RANGING";
    }

    const marketRegime =
      detectRegime();

    // =========================================================
    // SCALPING ENGINE
    // CMP-FIRST
    // =========================================================

    function scalpSide(
      side
    ) {
      let context = 0;
      let location = 0;
      let trigger = 0;
      let pattern = 0;
      let quality = 0;

      const reasons = [];

      const wanted =
        side === "BUY"
          ? "BULLISH"
          : "BEARISH";

      // -------------------------------------------------------
      // H1 CONTEXT
      // -------------------------------------------------------

      if (
        direction.H1 ===
        wanted
      ) {
        context += 20;

        reasons.push(
          `H1 ${side} bias`
        );
      } else if (
        direction.H1 ===
        "NEUTRAL"
      ) {
        context += 8;
      } else {
        // Countertrend scalp is allowed,
        // but receives no context bonus.
        reasons.push(
          "countertrend scalp"
        );
      }

      // -------------------------------------------------------
      // M15
      // -------------------------------------------------------

      if (
        direction.M15 ===
        wanted
      ) {
        context += 15;

        reasons.push(
          `M15 ${side} structure`
        );
      }

      // -------------------------------------------------------
      // CMP ZONE
      // -------------------------------------------------------

      if (
        zoneDir === side
      ) {
        location += 25;

        reasons.push(
          `${side} zone at CMP`
        );
      }

      if (
        cmpLocation.state ===
        "INSIDE_ZONE" &&
        zoneDir === side
      ) {
        location += 12;
      }

      if (
        cmpLocation.state ===
        "APPROACHING_ZONE" &&
        zoneDir === side
      ) {
        location += 8;
      }

      if (
        cmpLocation.state ===
        "NEAR_ZONE" &&
        zoneDir === side
      ) {
        location += 5;
      }

      // -------------------------------------------------------
      // M5 TRIGGER
      // -------------------------------------------------------

      const sideTriggers =
        side === "BUY"
          ? m5Trigger.buy
          : m5Trigger.sell;

      if (
        sideTriggers.length
      ) {
        trigger += clamp(
          sideTriggers.length *
            13,
          0,
          39
        );

        reasons.push(
          ...sideTriggers
        );
      }

      // -------------------------------------------------------
      // LIQUIDITY
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        liquidityM5.bullish
      ) {
        trigger += 18;

        reasons.push(
          "M5 bullish liquidity sweep"
        );
      }

      if (
        side === "SELL" &&
        liquidityM5.bearish
      ) {
        trigger += 18;

        reasons.push(
          "M5 bearish liquidity sweep"
        );
      }

      // -------------------------------------------------------
      // DOUBLE
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        doubleM5.type ===
        "DOUBLE_BOTTOM"
      ) {
        pattern += 14;

        reasons.push(
          "M5 double bottom"
        );
      }

      if (
        side === "SELL" &&
        doubleM5.type ===
        "DOUBLE_TOP"
      ) {
        pattern += 14;

        reasons.push(
          "M5 double top"
        );
      }

      // -------------------------------------------------------
      // QM
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        qmM5.type ===
        "QM_BUY"
      ) {
        pattern += 14;

        reasons.push(
          "QM buy structure"
        );
      }

      if (
        side === "SELL" &&
        qmM5.type ===
        "QM_SELL"
      ) {
        pattern += 14;

        reasons.push(
          "QM sell structure"
        );
      }

      // -------------------------------------------------------
      // CMP REACTION
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        (
          reaction ===
            "REJECTING_DEMAND" ||
          reaction ===
            "LIQUIDITY_SWEEP_BUY"
        )
      ) {
        trigger += 14;

        reasons.push(
          "CMP bullish reaction"
        );
      }

      if (
        side === "SELL" &&
        (
          reaction ===
            "REJECTING_SUPPLY" ||
          reaction ===
            "LIQUIDITY_SWEEP_SELL"
        )
      ) {
        trigger += 14;

        reasons.push(
          "CMP bearish reaction"
        );
      }

      // -------------------------------------------------------
      // BREAKOUT
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        m15Break.type ===
        "BULLISH_BREAK"
      ) {
        trigger += 12;

        reasons.push(
          "M15 bullish breakout"
        );
      }

      if (
        side === "SELL" &&
        m15Break.type ===
        "BEARISH_BREAK"
      ) {
        trigger += 12;

        reasons.push(
          "M15 bearish breakout"
        );
      }

      // -------------------------------------------------------
      // FORMING BREAK
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        m15Break.type ===
        "BULLISH_BREAK_FORMING"
      ) {
        trigger += 5;

        reasons.push(
          "M15 bullish break forming"
        );
      }

      if (
        side === "SELL" &&
        m15Break.type ===
        "BEARISH_BREAK_FORMING"
      ) {
        trigger += 5;

        reasons.push(
          "M15 bearish break forming"
        );
      }

      // -------------------------------------------------------
      // EARLY BREAK
      // -------------------------------------------------------

      if (
        side === "SELL" &&
        earlyBreak.bearish
      ) {
        pattern += 8;

        reasons.push(
          "M5 broke support early"
        );
      }

      if (
        side === "BUY" &&
        earlyBreak.bullish
      ) {
        pattern += 8;

        reasons.push(
          "M5 broke resistance early"
        );
      }

      // -------------------------------------------------------
      // FLIP
      // -------------------------------------------------------

      if (
        side === "SELL" &&
        flip.bearish
      ) {
        location += 10;

        reasons.push(
          "M15 SBR flip"
        );
      }

      if (
        side === "BUY" &&
        flip.bullish
      ) {
        location += 10;

        reasons.push(
          "M15 RBS flip"
        );
      }

      // -------------------------------------------------------
      // TREND CONTINUATION
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        marketRegime ===
        "TRENDING_BULLISH"
      ) {
        context += 10;

        reasons.push(
          "bullish continuation"
        );
      }

      if (
        side === "SELL" &&
        marketRegime ===
        "TRENDING_BEARISH"
      ) {
        context += 10;

        reasons.push(
          "bearish continuation"
        );
      }

      // -------------------------------------------------------
      // REVERSAL
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        marketRegime ===
        "REVERSAL_BULLISH"
      ) {
        trigger += 15;

        reasons.push(
          "bullish reversal"
        );
      }

      if (
        side === "SELL" &&
        marketRegime ===
        "REVERSAL_BEARISH"
      ) {
        trigger += 15;

        reasons.push(
          "bearish reversal"
        );
      }

      // -------------------------------------------------------
      // ZONE QUALITY
      // -------------------------------------------------------

      if (
        cmpLocation.zone &&
        zoneDir === side
      ) {
        quality =
          Math.round(
            cmpLocation.zone.quality *
            0.25
          );
      }

      // -------------------------------------------------------
      // FINAL SCORE
      // -------------------------------------------------------

      const total =
        clamp(
          Math.round(
            context +
            location +
            trigger +
            pattern +
            quality
          ),
          0,
          100
        );

      // -------------------------------------------------------
      // SIGNAL CONDITIONS
      // -------------------------------------------------------

      const hasLocation =
        zoneDir === side;

      const hasTrigger =
        sideTriggers.length > 0 ||
        (
          side === "BUY" &&
          liquidityM5.bullish
        ) ||
        (
          side === "SELL" &&
          liquidityM5.bearish
        ) ||
        (
          side === "BUY" &&
          doubleM5.type ===
            "DOUBLE_BOTTOM"
        ) ||
        (
          side === "SELL" &&
          doubleM5.type ===
            "DOUBLE_TOP"
        ) ||
        (
          side === "BUY" &&
          qmM5.type ===
            "QM_BUY"
        ) ||
        (
          side === "SELL" &&
          qmM5.type ===
            "QM_SELL"
        );

      let status =
        "WATCH";

      // Active opportunity
      if (
        total >= 30 &&
        (
          hasLocation ||
          hasTrigger
        )
      ) {
        status =
          "SETUP";
      }

      // Ready
      if (
        total >= 40 &&
        hasLocation &&
        hasTrigger
      ) {
        status =
          "READY";
      }

      // Confirmed signal
      if (
        total >= 48 &&
        (
          (
            hasLocation &&
            hasTrigger
          ) ||
          (
            marketRegime ===
            (
              side === "BUY"
                ? "TRENDING_BULLISH"
                : "TRENDING_BEARISH"
            ) &&
            hasTrigger &&
            context >= 20
          )
        )
      ) {
        status =
          "SIGNAL";
      }

      return {
        side,
        status,
        score: total,

        contextScore:
          clamp(
            context,
            0,
            100
          ),

        locationScore:
          clamp(
            location,
            0,
            100
          ),

        triggerScore:
          clamp(
            trigger,
            0,
            100
          ),

        patternScore:
          clamp(
            pattern,
            0,
            100
          ),

        qualityScore:
          clamp(
            quality,
            0,
            100
          ),

        reasons: [
          ...new Set(
            reasons
          )
        ].slice(0, 12)
      };
    }

    const scalpBuy =
      scalpSide("BUY");

    const scalpSell =
      scalpSide("SELL");

    // =========================================================
    // INTRADAY ENGINE
    // =========================================================

    function intradaySide(
      side
    ) {
      let score = 0;

      const reasons = [];

      const wanted =
        side === "BUY"
          ? "BULLISH"
          : "BEARISH";

      if (
        direction.H4 ===
        wanted
      ) {
        score += 30;

        reasons.push(
          `H4 ${side} bias`
        );
      }

      if (
        direction.H1 ===
        wanted
      ) {
        score += 25;

        reasons.push(
          `H1 ${side} bias`
        );
      }

      if (
        direction.M15 ===
        wanted
      ) {
        score += 20;

        reasons.push(
          `M15 ${side} structure`
        );
      }

      if (
        zoneDir === side
      ) {
        score += 15;

        reasons.push(
          `${side} MTF zone`
        );
      }

      if (
        cmpLocation.state ===
        "INSIDE_ZONE" &&
        zoneDir === side
      ) {
        score += 5;

        reasons.push(
          "CMP inside MTF zone"
        );
      }

      if (
        side === "BUY" &&
        m5Trigger.buy.length
      ) {
        score += 12;

        reasons.push(
          "M5 bullish confirmation"
        );
      }

      if (
        side === "SELL" &&
        m5Trigger.sell.length
      ) {
        score += 12;

        reasons.push(
          "M5 bearish confirmation"
        );
      }

      if (
        side === "BUY" &&
        liquidityM15.bullish
      ) {
        score += 8;

        reasons.push(
          "M15 bullish liquidity sweep"
        );
      }

      if (
        side === "SELL" &&
        liquidityM15.bearish
      ) {
        score += 8;

        reasons.push(
          "M15 bearish liquidity sweep"
        );
      }

      if (
        side === "BUY" &&
        m15Break.confirmed &&
        m15Break.type ===
          "BULLISH_BREAK"
      ) {
        score += 8;

        reasons.push(
          "M15 confirmed bullish breakout"
        );
      }

      if (
        side === "SELL" &&
        m15Break.confirmed &&
        m15Break.type ===
          "BEARISH_BREAK"
      ) {
        score += 8;

        reasons.push(
          "M15 confirmed bearish breakout"
        );
      }

      score =
        clamp(
          score,
          0,
          100
        );

      let status =
        "WAIT";

      if (
        score >= 45
      ) {
        status =
          "SETUP";
      }

      if (
        score >= 58 &&
        direction.H4 === wanted &&
        direction.H1 === wanted
      ) {
        status =
          "READY";
      }

      if (
        score >= 65 &&
        direction.H4 === wanted &&
        direction.H1 === wanted &&
        direction.M15 === wanted &&
        (
          side === "BUY"
            ? m5Trigger.buy.length
            : m5Trigger.sell.length
        )
      ) {
        status =
          "SIGNAL";
      }

      return {
        side,
        status,
        score,

        reasons: [
          ...new Set(
            reasons
          )
        ].slice(0, 12)
      };
    }

    const intraBuy =
      intradaySide("BUY");

    const intraSell =
      intradaySide("SELL");

    // =========================================================
    // TRADE PLAN
    // =========================================================

    function buildTradePlan(
      side,
      mode,
      score,
      status
    ) {
      if (!side) {
        return null;
      }

      const isScalp =
        mode ===
        "SCALPING";

      const slPoints =
        isScalp
          ? SCALP_SL_POINTS
          : INTRA_SL_POINTS;

      const tp1Points =
        isScalp
          ? SCALP_TP1_POINTS
          : INTRA_TP1_POINTS;

      const tp2Points =
        isScalp
          ? SCALP_TP2_POINTS
          : INTRA_TP2_POINTS;

      const entry =
        round(
          currentPrice,
          2
        );

      const sl =
        side === "BUY"
          ? round(
              entry -
                pointsToPrice(
                  slPoints
                ),
              2
            )
          : round(
              entry +
                pointsToPrice(
                  slPoints
                ),
              2
            );

      const tp1 =
        side === "BUY"
          ? round(
              entry +
                pointsToPrice(
                  tp1Points
                ),
              2
            )
          : round(
              entry -
                pointsToPrice(
                  tp1Points
                ),
              2
            );

      const tp2 =
        side === "BUY"
          ? round(
              entry +
                pointsToPrice(
                  tp2Points
                ),
              2
            )
          : round(
              entry -
                pointsToPrice(
                  tp2Points
                ),
              2
            );

      return {
        direction:
          side,

        mode,

        status:
          status || "SIGNAL",

        entry,

        sl,

        tp1,

        tp2,

        slPoints,
        tp1Points,
        tp2Points,

        slPips:
          slPoints / 10,

        tp1Pips:
          tp1Points / 10,

        tp2Pips:
          tp2Points / 10
      };
    }

    // =========================================================
    // MODE-SPECIFIC PLANS
    // =========================================================

    const scalpBuyPlan =
      scalpBuy.status ===
      "SIGNAL"
        ? buildTradePlan(
            "BUY",
            "SCALPING",
            scalpBuy.score,
            "SIGNAL"
          )
        : null;

    const scalpSellPlan =
      scalpSell.status ===
      "SIGNAL"
        ? buildTradePlan(
            "SELL",
            "SCALPING",
            scalpSell.score,
            "SIGNAL"
          )
        : null;

    const intraBuyPlan =
      intraBuy.status ===
      "SIGNAL"
        ? buildTradePlan(
            "BUY",
            "INTRADAY",
            intraBuy.score,
            "SIGNAL"
          )
        : null;

    const intraSellPlan =
      intraSell.status ===
      "SIGNAL"
        ? buildTradePlan(
            "SELL",
            "INTRADAY",
            intraSell.score,
            "SIGNAL"
          )
        : null;

    // =========================================================
    // SMART WAIT
    // =========================================================

    function waitReason(
      side,
      mode,
      candidate
    ) {
      const wanted =
        side === "BUY"
          ? "BULLISH"
          : "BEARISH";

      if (
        mode === "SCALPING"
      ) {
        if (
          side === "SELL" &&
          m15Test.support &&
          earlyBreak.bearish
        ) {
          return (
            "M15 SUPPORT UNDER TEST — " +
            "M5 BROKE SUPPORT EARLY — " +
            "WAITING FOR RETEST"
          );
        }

        if (
          side === "BUY" &&
          m15Test.resistance &&
          earlyBreak.bullish
        ) {
          return (
            "M15 RESISTANCE UNDER TEST — " +
            "M5 BROKE RESISTANCE EARLY — " +
            "WAITING FOR RETEST"
          );
        }

        if (
          m15Break.type.includes(
            "FORMING"
          )
        ) {
          return (
            "M15 CANDLE NOT CLOSED — " +
            "WAITING FOR CONFIRMATION"
          );
        }

        if (
          cmpLocation.state ===
          "FAR_FROM_ZONE"
        ) {
          return (
            "ZONE TOO FAR FROM CMP"
          );
        }

        if (
          cmpLocation.state ===
          "APPROACHING_ZONE"
        ) {
          return (
            `WAITING FOR CMP TO ENTER ${zoneDir} ZONE`
          );
        }

        if (
          cmpLocation.state ===
          "INSIDE_ZONE"
        ) {
          const hasTrigger =
            side === "BUY"
              ? m5Trigger.buy.length
              : m5Trigger.sell.length;

          if (!hasTrigger) {
            return (
              `WAITING FOR M5 ${side} CONFIRMATION`
            );
          }
        }

        if (
          m15Break.confirmed
        ) {
          return (
            "WAITING FOR RETEST"
          );
        }

        if (
          candidate.score >= 30
        ) {
          return (
            `SCALPING SETUP DEVELOPING — WAITING FOR ${side} TRIGGER`
          );
        }

        return (
          `WAITING FOR ${side} SCALPING SETUP`
        );
      }

      // INTRADAY

      if (
        direction.H4 !== wanted
      ) {
        return (
          "WAITING FOR H4 ALIGNMENT"
        );
      }

      if (
        direction.H1 !== wanted
      ) {
        return (
          "WAITING FOR H1 ALIGNMENT"
        );
      }

      if (
        direction.M15 !== wanted
      ) {
        return (
          "WAITING FOR M15 ALIGNMENT"
        );
      }

      if (
        zoneDir !== side
      ) {
        return (
          `WAITING FOR ${side} M15 ZONE`
        );
      }

      return (
        `WAITING FOR M5 ${side} CONFIRMATION`
      );
    }

    // =========================================================
    // NARRATIVE
    // =========================================================

    function narrative(
      side,
      mode
    ) {
      const parts = [];

      parts.push(
        `H1 ${direction.H1.toLowerCase()}`
      );

      parts.push(
        `M15 ${direction.M15.toLowerCase()}`
      );

      if (
        cmpLocation.zone
      ) {
        parts.push(
          `CMP ${cmpLocation.state.toLowerCase()} ${cmpLocation.zone.type.toLowerCase()}`
        );
      }

      if (
        m15Break.type !==
        "NONE"
      ) {
        parts.push(
          m15Break.type
        );
      }

      if (
        side === "BUY" &&
        m5Trigger.buy.length
      ) {
        parts.push(
          `M5 ${m5Trigger.buy[0]}`
        );
      }

      if (
        side === "SELL" &&
        m5Trigger.sell.length
      ) {
        parts.push(
          `M5 ${m5Trigger.sell[0]}`
        );
      }

      parts.push(
        `${mode} ${side}`
      );

      return parts.join(
        " → "
      );
    }

    // =========================================================
    // PRIMARY CONFIRMED SIGNAL
    // =========================================================

    let primarySetup = null;

    if (
      scalpBuyPlan &&
      scalpSellPlan
    ) {
      const chosen =
        scalpBuy.score >=
        scalpSell.score
          ? scalpBuyPlan
          : scalpSellPlan;

      const source =
        chosen.direction ===
        "BUY"
          ? scalpBuy
          : scalpSell;

      primarySetup = {
        ...chosen,

        score:
          source.score,

        reasons:
          source.reasons,

        narrative:
          narrative(
            chosen.direction,
            "SCALPING"
          )
      };
    } else if (
      scalpBuyPlan
    ) {
      primarySetup = {
        ...scalpBuyPlan,

        score:
          scalpBuy.score,

        reasons:
          scalpBuy.reasons,

        narrative:
          narrative(
            "BUY",
            "SCALPING"
          )
      };
    } else if (
      scalpSellPlan
    ) {
      primarySetup = {
        ...scalpSellPlan,

        score:
          scalpSell.score,

        reasons:
          scalpSell.reasons,

        narrative:
          narrative(
            "SELL",
            "SCALPING"
          )
      };
    } else if (
      intraBuyPlan &&
      intraSellPlan
    ) {
      const chosen =
        intraBuy.score >=
        intraSell.score
          ? intraBuyPlan
          : intraSellPlan;

      const source =
        chosen.direction ===
        "BUY"
          ? intraBuy
          : intraSell;

      primarySetup = {
        ...chosen,

        score:
          source.score,

        reasons:
          source.reasons,

        narrative:
          narrative(
            chosen.direction,
            "INTRADAY"
          )
      };
    } else if (
      intraBuyPlan
    ) {
      primarySetup = {
        ...intraBuyPlan,

        score:
          intraBuy.score,

        reasons:
          intraBuy.reasons,

        narrative:
          narrative(
            "BUY",
            "INTRADAY"
          )
      };
    } else if (
      intraSellPlan
    ) {
      primarySetup = {
        ...intraSellPlan,

        score:
          intraSell.score,

        reasons:
          intraSell.reasons,

        narrative:
          narrative(
            "SELL",
            "INTRADAY"
          )
      };
    }

    // =========================================================
    // SIGNAL COUNTERS
    // =========================================================

    const scalpSignals = [
      scalpBuy,
      scalpSell
    ].filter(
      x =>
        x.status ===
        "SIGNAL"
    );

    const scalpSetups = [
      scalpBuy,
      scalpSell
    ].filter(
      x =>
        x.status ===
          "SETUP" ||
        x.status ===
          "READY" ||
        x.status ===
          "SIGNAL"
    );

    const intradaySignals = [
      intraBuy,
      intraSell
    ].filter(
      x =>
        x.status ===
        "SIGNAL"
    );

    // =========================================================
    // SESSION
    // =========================================================

    const utcHour =
      new Date().getUTCHours();

    let session =
      "QUIET";

    if (
      utcHour >= 0 &&
      utcHour < 7
    ) {
      session =
        "ASIA";
    } else if (
      utcHour >= 7 &&
      utcHour < 13
    ) {
      session =
        "LONDON";
    } else if (
      utcHour >= 13 &&
      utcHour < 21
    ) {
      session =
        "NEW_YORK";
    }

    // =========================================================
    // IMPORTANT COMPATIBILITY LAYER
    // =========================================================

    const confirmedPrimary =
      primarySetup &&
      primarySetup.status ===
        "SIGNAL"
        ? primarySetup
        : null;

    // =========================================================
    // FINAL RESPONSE
    // =========================================================

    const output = {
      status: "success",

      // -------------------------------------------------------
      // FRONTEND COMPATIBILITY
      // -------------------------------------------------------

      signal:
        confirmedPrimary
          ? `${confirmedPrimary.direction} SIGNAL`
          : "WAIT",

      signalDirection:
        confirmedPrimary
          ? confirmedPrimary.direction
          : "NONE",

      signalMode:
        confirmedPrimary
          ? confirmedPrimary.mode
          : "NONE",

      signalEntry:
        confirmedPrimary
          ? confirmedPrimary.entry
          : null,

      signalSL:
        confirmedPrimary
          ? confirmedPrimary.sl
          : null,

      signalTP1:
        confirmedPrimary
          ? confirmedPrimary.tp1
          : null,

      signalTP2:
        confirmedPrimary
          ? confirmedPrimary.tp2
          : null,

      // -------------------------------------------------------
      // ENGINE
      // -------------------------------------------------------

      engine: {
        name:
          "SINNCI MARKET ENGINE PRO",

        version:
          "PRO-2.0",

        mode:
          "CMP-FIRST MULTI-TF",

        timeframeFlow:
          "H4 → H1 → M15 → CMP → M5",

        signalStyle:
          "ACTIVE SCALPING / SELECTIVE INTRADAY"
      },

      // -------------------------------------------------------
      // MARKET
      // -------------------------------------------------------

      market: {
        symbol:
          PRICE_SYMBOL,

        price:
          round(
            currentPrice,
            2
          ),

        regime:
          marketRegime,

        session
      },

      // -------------------------------------------------------
      // DIRECTION
      // -------------------------------------------------------

      direction: {
        H4:
          direction.H4,

        H1:
          direction.H1,

        M15:
          direction.M15,

        M5:
          direction.M5
      },

      // -------------------------------------------------------
      // STRUCTURE
      // -------------------------------------------------------

      structure: {
        H4:
          structureH4.direction,

        H1:
          structureH1.direction,

        M15:
          structureM15.direction,

        M5:
          structureM5.direction
      },

      // -------------------------------------------------------
      // LEVELS
      // -------------------------------------------------------

      levels: {
        M15Support:
          levelsM15.support
            ? round(
                levelsM15.support,
                2
              )
            : null,

        M15Resistance:
          levelsM15.resistance
            ? round(
                levelsM15.resistance,
                2
              )
            : null,

        M5Support:
          levelsM5.support
            ? round(
                levelsM5.support,
                2
              )
            : null,

        M5Resistance:
          levelsM5.resistance
            ? round(
                levelsM5.resistance,
                2
              )
            : null
      },

      // -------------------------------------------------------
      // CMP
      // -------------------------------------------------------

      cmp: {
        state:
          cmpLocation.state,

        reaction,

        zone:
          cmpLocation.zone
            ? {
                type:
                  cmpLocation.zone.type,

                source:
                  cmpLocation.zone.source,

                high:
                  cmpLocation.zone.high,

                low:
                  cmpLocation.zone.low,

                bodyHigh:
                  cmpLocation.zone.bodyHigh,

                bodyLow:
                  cmpLocation.zone.bodyLow,

                quality:
                  cmpLocation.zone.quality,

                fresh:
                  cmpLocation.zone.fresh,

                firstTouch:
                  cmpLocation.zone.firstTouch,

                touches:
                  cmpLocation.zone.touches
              }
            : null,

        distancePoints:
          cmpLocation.distancePoints
      },

      // -------------------------------------------------------
      // BREAKOUT / FLIP
      // -------------------------------------------------------

      breakout: {
        M15:
          m15Break,

        M5EarlyBreak:
          earlyBreak,

        flip
      },

      // -------------------------------------------------------
      // PATTERNS
      // -------------------------------------------------------

      patterns: {
        liquidityM5,
        liquidityM15,
        doubleM5,
        qmM5
      },

      // -------------------------------------------------------
      // CONFIRMATION
      // -------------------------------------------------------

      confirmation: {
        M5Buy:
          m5Trigger.buy,

        M5Sell:
          m5Trigger.sell,

        strongest:
          m5Trigger.strongest
      },

      // =======================================================
      // SCALPING
      // =======================================================

      scalping: {
        buy: {
          ...scalpBuy,

          wait:
            scalpBuy.status ===
            "SIGNAL"
              ? null
              : waitReason(
                  "BUY",
                  "SCALPING",
                  scalpBuy
                ),

          plan:
            scalpBuyPlan
        },

        sell: {
          ...scalpSell,

          wait:
            scalpSell.status ===
            "SIGNAL"
              ? null
              : waitReason(
                  "SELL",
                  "SCALPING",
                  scalpSell
                ),

          plan:
            scalpSellPlan
        },

        // Easy frontend access
        signal:
          scalpBuyPlan ||
          scalpSellPlan ||
          null,

        activeSetups:
          scalpSetups.length,

        activeSignals:
          scalpSignals.length,

        fixedRisk: {
          SL:
            "500 points / 50 pips",

          TP1:
            "600 points / 60 pips",

          TP2:
            "1200 points / 120 pips"
        }
      },

      // =======================================================
      // INTRADAY
      // =======================================================

      intraday: {
        buy: {
          ...intraBuy,

          wait:
            intraBuy.status ===
            "SIGNAL"
              ? null
              : waitReason(
                  "BUY",
                  "INTRADAY",
                  intraBuy
                ),

          plan:
            intraBuyPlan
        },

        sell: {
          ...intraSell,

          wait:
            intraSell.status ===
            "SIGNAL"
              ? null
              : waitReason(
                  "SELL",
                  "INTRADAY",
                  intraSell
                ),

          plan:
            intraSellPlan
        },

        // Easy frontend access
        signal:
          intraBuyPlan ||
          intraSellPlan ||
          null,

        activeSignals:
          intradaySignals.length,

        fixedRisk: {
          SL:
            "500 points / 50 pips",

          TP1:
            "1600 points / 160 pips",

          TP2:
            "2500 points / 250 pips"
        }
      },

      // -------------------------------------------------------
      // PRIMARY SETUP
      // -------------------------------------------------------

      primarySetup,

      // -------------------------------------------------------
      // NEXT ACTION
      // -------------------------------------------------------

      nextAction:
        confirmedPrimary
          ? `EXECUTE ${confirmedPrimary.mode} ${confirmedPrimary.direction} PLAN`
          : (
              scalpBuy.status ===
              "READY"
                ? "WAITING FOR SCALPING BUY TRIGGER"
                : scalpSell.status ===
                  "READY"
                ? "WAITING FOR SCALPING SELL TRIGGER"
                : "WAITING FOR NEXT VALID SETUP"
            ),

      // -------------------------------------------------------
      // CANDLE STATUS
      // -------------------------------------------------------

      candleStatus: {
        M15Current:
          "FORMING",

        M15Closed:
          m15Closed.datetime,

        M5Current:
          M5[
            M5.length - 1
          ].datetime
      },

      // -------------------------------------------------------
      // ATR
      // -------------------------------------------------------

      atr: {
        H4:
          round(
            atr.H4,
            2
          ),

        H1:
          round(
            atr.H1,
            2
          ),

        M15:
          round(
            atr.M15,
            2
          ),

        M5:
          round(
            atr.M5,
            2
          )
      },

      // -------------------------------------------------------
      // CANDLES
      // -------------------------------------------------------

      candles: {
        H4:
          H4.length,

        H1:
          H1.length,

        M15:
          M15.length,

        M5:
          M5.length
      },

      generatedAt:
        new Date().toISOString()
    };

    // =========================================================
    // CACHE
    // =========================================================

    globalThis.__SINNCI_PRO_CACHE = {
      data: output,
      timestamp:
        Date.now()
    };

    return res.status(200).json(
      output
    );

  } catch (error) {
    console.error(
      "SINNCI ENGINE ERROR:",
      error
    );

    return res.status(500).json({
      status: "error",

      engine:
        "SINNCI MARKET ENGINE PRO",

      error:
        error?.message ||
        "Market analysis failed"
    });
  }
      }
