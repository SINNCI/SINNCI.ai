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
    // SINNCI MARKET ENGINE PRO
    // H4 → H1 → M15 → CMP → M5
    // NO M30
    // =========================================================

    const POINT = 0.01;

    const SCALP_SIGNAL_SCORE = 65;
    const INTRA_SIGNAL_SCORE = 90;

    // Fixed risk model
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

    const pointsToPrice = points =>
      points * POINT;

    const priceToPoints = price =>
      price / POINT;

    const avg = arr => {
      const a = arr.filter(Number.isFinite);

      if (!a.length) return 0;

      return (
        a.reduce((x, y) => x + y, 0) /
        a.length
      );
    };

    const clamp = (v, min, max) =>
      Math.max(
        min,
        Math.min(max, v)
      );

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
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
        .reverse();
    }

    // =========================================================
    // FETCH MTF
    // ONLY 4 REQUESTS
    // H4 / H1 / M15 / M5
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
        const c =
          candles[i];

        const prev =
          candles[i - 1];

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
    // SWINGS
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
        i < candles.length - right;
        i++
      ) {
        const c =
          candles[i];

        let isHigh = true;
        let isLow = true;

        for (
          let j = 1;
          j <= left;
          j++
        ) {
          if (
            candles[i - j].high >= c.high
          ) {
            isHigh = false;
          }

          if (
            candles[i - j].low <= c.low
          ) {
            isLow = false;
          }
        }

        if (isHigh) {
          for (
            let j = 1;
            j <= right;
            j++
          ) {
            if (
              candles[i + j].high >= c.high
            ) {
              isHigh = false;
              break;
            }
          }
        }

        if (isLow) {
          for (
            let j = 1;
            j <= right;
            j++
          ) {
            if (
              candles[i + j].low <= c.low
            ) {
              isLow = false;
              break;
            }
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

    function structure(candles) {
      const swings =
        getSwingPoints(candles);

      const highs =
        swings.highs.slice(-4);

      const lows =
        swings.lows.slice(-4);

      let direction =
        "NEUTRAL";

      if (
        highs.length >= 2 &&
        lows.length >= 2
      ) {
        const h1 =
          highs[highs.length - 2].price;

        const h2 =
          highs[highs.length - 1].price;

        const l1 =
          lows[lows.length - 2].price;

        const l2 =
          lows[lows.length - 1].price;

        if (
          h2 > h1 &&
          l2 > l1
        ) {
          direction = "BULLISH";
        }

        if (
          h2 < h1 &&
          l2 < l1
        ) {
          direction = "BEARISH";
        }
      }

      return {
        direction,
        highs,
        lows,

        latestHigh:
          highs.length
            ? highs[highs.length - 1].price
            : null,

        previousHigh:
          highs.length >= 2
            ? highs[highs.length - 2].price
            : null,

        latestLow:
          lows.length
            ? lows[lows.length - 1].price
            : null,

        previousLow:
          lows.length >= 2
            ? lows[lows.length - 2].price
            : null
      };
    }

    const structureH4 =
      structure(H4);

    const structureH1 =
      structure(H1);

    const structureM15 =
      structure(M15);

    const structureM5 =
      structure(M5);

    // =========================================================
    // DIRECTION
    // =========================================================

    function getDirection(candles) {
      const s =
        structure(candles);

      if (
        s.direction !==
        "NEUTRAL"
      ) {
        return s.direction;
      }

      const recent =
        candles.slice(-8);

      const bull =
        recent.filter(
          bullish
        ).length;

      const bear =
        recent.filter(
          bearish
        ).length;

      if (
        bull > bear + 1
      ) {
        return "BULLISH";
      }

      if (
        bear > bull + 1
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
    // ZONE BUILDER
    // =========================================================

    function candleZone(
      c,
      type,
      source,
      index
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
        index,

        high:
          round(c.high, 2),

        low:
          round(c.low, 2),

        bodyHigh:
          round(bodyHigh, 2),

        bodyLow:
          round(bodyLow, 2),

        midpoint:
          round(
            (c.high + c.low) / 2,
            2
          ),

        datetime:
          c.datetime,

        range:
          round(
            c.high - c.low,
            2
          ),

        body:
          round(
            candleBody(c),
            2
          )
      };
    }

    // =========================================================
    // FIND ZONES
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

        const body =
          candleBody(c);

        const range =
          candleRange(c);

        if (
          range <= 0
        ) continue;

        const displacement =
          Math.abs(
            next.close -
            c.close
          );

        if (
          bullish(c) &&
          body / range >= 0.45
        ) {
          zones.push(
            candleZone(
              c,
              "DEMAND",
              source,
              i
            )
          );
        }

        if (
          bearish(c) &&
          body / range >= 0.45
        ) {
          zones.push(
            candleZone(
              c,
              "SUPPLY",
              source,
              i
            )
          );
        }

        if (
          displacement >
          Math.max(
            atr[source] * 0.45,
            POINT * 40
          )
        ) {
          zones.push(
            candleZone(
              c,
              bullish(c)
                ? "DEMAND"
                : "SUPPLY",
              source,
              i
            )
          );
        }
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

    function zoneQuality(zone) {
      let score = 0;

      if (
        zone.source === "H1"
      ) {
        score += 30;
      }

      if (
        zone.source === "M15"
      ) {
        score += 24;
      }

      if (
        zone.source === "M5"
      ) {
        score += 14;
      }

      const distance =
        Math.abs(
          currentPrice -
          zone.midpoint
        );

      const distancePoints =
        priceToPoints(distance);

      if (
        distancePoints <= 80
      ) {
        score += 25;
      } else if (
        distancePoints <= 160
      ) {
        score += 18;
      } else if (
        distancePoints <= 300
      ) {
        score += 10;
      } else if (
        distancePoints <= 500
      ) {
        score += 4;
      }

      if (
        zone.body >
        POINT * 25
      ) {
        score += 8;
      }

      if (
        zone.range >
        POINT * 40
      ) {
        score += 5;
      }

      return clamp(
        Math.round(score),
        0,
        100
      );
    }

    allZones.forEach(z => {
      z.quality =
        zoneQuality(z);
    });

    // =========================================================
    // SUPPORT / RESISTANCE
    // =========================================================

    function nearestLevels(candles) {
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
          Math.abs(currentPrice - a) -
          Math.abs(currentPrice - b)
      );

      resistances.sort(
        (a, b) =>
          Math.abs(currentPrice - a) -
          Math.abs(currentPrice - b)
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
    // M15 CANDLES
    // =========================================================

    const m15Current =
      M15[M15.length - 1];

    const m15Closed =
      M15[M15.length - 2];

    const m15Before =
      M15[M15.length - 3];

    // =========================================================
    // M15 BREAK
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

      const closed =
        m15Closed.close;

      if (
        closed > rangeHigh
      ) {
        return {
          type: "BULLISH_BREAK",
          confirmed: true,
          level: rangeHigh
        };
      }

      if (
        closed < rangeLow
      ) {
        return {
          type: "BEARISH_BREAK",
          confirmed: true,
          level: rangeLow
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
          level: rangeHigh
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
          level: rangeLow
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
    // FLIP ZONE
    // =========================================================

    function detectFlip() {
      const result = {
        bullish: null,
        bearish: null
      };

      const s =
        structureM15;

      if (
        s.latestHigh &&
        m15Closed.close >
        s.latestHigh
      ) {
        result.bullish = {
          role: "RBS",
          level: s.latestHigh,
          status:
            "SUPPORT_AFTER_BREAK"
        };
      }

      if (
        s.latestLow &&
        m15Closed.close <
        s.latestLow
      ) {
        result.bearish = {
          role: "SBR",
          level: s.latestLow,
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
        last.low < previousLow &&
        last.close > previousLow &&
        lowerWick(last) >
          candleBody(last) * 0.8;

      const bearishSweep =
        last.high > previousHigh &&
        last.close < previousHigh &&
        upperWick(last) >
          candleBody(last) * 0.8;

      return {
        bullish:
          bullishSweep,

        bearish:
          bearishSweep,

        level:
          bullishSweep
            ? previousLow
            : bearishSweep
            ? previousHigh
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

    function detectDouble(candles) {
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
            type: "DOUBLE_TOP",
            level:
              Math.max(h1, h2)
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
              Math.min(l1, l2)
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

    function detectQM(candles) {
      const s =
        getSwingPoints(candles);

      if (
        s.highs.length >= 3 &&
        s.lows.length >= 2
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
            s.lows.length - 2
          ].price;

        const l2 =
          s.lows[
            s.lows.length - 1
          ].price;

        if (
          h2 > h1 &&
          h2 > h3 &&
          l2 < l1
        ) {
          return {
            type: "QM_SELL",
            level: h3
          };
        }

        if (
          h2 < h1 &&
          h2 < h3 &&
          l2 > l1
        ) {
          return {
            type: "QM_BUY",
            level: l2
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

    const qmM15 =
      detectQM(M15);

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
        last.close >= prev.open &&
        last.open <= prev.close
      ) {
        buy.push(
          "BULLISH_ENGULFING"
        );
      }

      // Bearish engulfing
      if (
        bullish(prev) &&
        bearish(last) &&
        last.close <= prev.open &&
        last.open >= prev.close
      ) {
        sell.push(
          "BEARISH_ENGULFING"
        );
      }

      // Bullish rejection
      if (
        lowerWick(last) >
          candleBody(last) * 1.2 &&
        last.close >
          last.low +
          candleRange(last) * 0.55
      ) {
        buy.push(
          "BULLISH_REJECTION"
        );
      }

      // Bearish rejection
      if (
        upperWick(last) >
          candleBody(last) * 1.2 &&
        last.close <
          last.low +
          candleRange(last) * 0.45
      ) {
        sell.push(
          "BEARISH_REJECTION"
        );
      }

      // Bullish displacement
      if (
        bullish(last) &&
        bodyRatio(last) >= 0.65 &&
        last.close >
          last.low +
          candleRange(last) * 0.75
      ) {
        buy.push(
          "BULLISH_DISPLACEMENT"
        );
      }

      // Bearish displacement
      if (
        bearish(last) &&
        bodyRatio(last) >= 0.65 &&
        last.close <
          last.low +
          candleRange(last) * 0.25
      ) {
        sell.push(
          "BEARISH_DISPLACEMENT"
        );
      }

      // M5 structure shift
      if (
        prev2 &&
        last.close > prev2.high
      ) {
        buy.push(
          "M5_STRUCTURE_SHIFT"
        );
      }

      if (
        prev2 &&
        last.close < prev2.low
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
    // CMP LOCATION
    // =========================================================

    function getCmpLocation() {
      let nearestZone = null;
      let minDistance = Infinity;

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
                  currentPrice - z.low
                ),
                Math.abs(
                  currentPrice - z.high
                )
              );

        if (
          distance < minDistance
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
          state: "NO_ZONE",
          zone: null,
          distancePoints: null
        };
      }

      const distancePoints =
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
        distancePoints <= 50
      ) {
        state =
          "APPROACHING_ZONE";
      } else if (
        distancePoints <= 120
      ) {
        state =
          "NEAR_ZONE";
      }

      return {
        state,
        zone: nearestZone,
        distancePoints:
          round(
            distancePoints,
            0
          )
      };
    }

    const cmpLocation =
      getCmpLocation();

    // =========================================================
    // FRESH ZONE
    // =========================================================

    function detectFreshZone(zone) {
      if (!zone) {
        return {
          fresh: false,
          firstTouch: false,
          touches: 0
        };
      }

      const sourceCandles =
        zone.source === "H1"
          ? H1
          : zone.source === "M15"
          ? M15
          : M5;

      const createdIndex =
        sourceCandles.findIndex(
          c =>
            c.datetime ===
            zone.datetime
        );

      if (
        createdIndex < 0
      ) {
        return {
          fresh: false,
          firstTouch: false,
          touches: 0
        };
      }

      let touches = 0;

      for (
        let i = createdIndex + 1;
        i < sourceCandles.length - 1;
        i++
      ) {
        const c =
          sourceCandles[i];

        if (
          c.high >= zone.low &&
          c.low <= zone.high
        ) {
          touches++;
        }
      }

      return {
        fresh:
          touches === 0,

        firstTouch:
          touches <= 1,

        touches
      };
    }

    const freshZone =
      detectFreshZone(
        cmpLocation.zone
      );

    // =========================================================
    // FIBONACCI
    // ONLY 0.382 / 0.500
    // =========================================================

    function detectFibonacci(
      candles
    ) {
      const s =
        getSwingPoints(candles);

      if (
        s.highs.length < 2 ||
        s.lows.length < 2
      ) {
        return {
          buy: false,
          sell: false,
          near382: false,
          near500: false,
          fib382: null,
          fib500: null
        };
      }

      const recentHigh =
        s.highs[
          s.highs.length - 1
        ];

      const recentLow =
        s.lows[
          s.lows.length - 1
        ];

      const high =
        recentHigh.price;

      const low =
        recentLow.price;

      const range =
        Math.abs(
          high - low
        );

      if (
        range <= 0
      ) {
        return {
          buy: false,
          sell: false,
          near382: false,
          near500: false,
          fib382: null,
          fib500: null
        };
      }

      const fib382 =
        low +
        range * 0.382;

      const fib500 =
        low +
        range * 0.500;

      const tolerance =
        Math.max(
          POINT * 35,
          atr.M5 * 0.25
        );

      const near382 =
        Math.abs(
          currentPrice -
          fib382
        ) <= tolerance;

      const near500 =
        Math.abs(
          currentPrice -
          fib500
        ) <= tolerance;

      const bullishSwing =
        recentLow.index <
        recentHigh.index;

      const bearishSwing =
        recentHigh.index <
        recentLow.index;

      return {
        buy:
          bullishSwing &&
          (
            near382 ||
            near500
          ),

        sell:
          bearishSwing &&
          (
            near382 ||
            near500
          ),

        near382,
        near500,

        fib382:
          round(
            fib382,
            2
          ),

        fib500:
          round(
            fib500,
            2
          )
      };
    }

    const fibonacciM15 =
      detectFibonacci(M15);

    const fibonacciM5 =
      detectFibonacci(M5);

    // =========================================================
    // BOS
    // =========================================================

    function detectBOS(candles) {
      const s =
        structure(candles);

      const last =
        candles[candles.length - 1];

      return {
        bullish:
          !!s.latestHigh &&
          last.close >
          s.latestHigh,

        bearish:
          !!s.latestLow &&
          last.close <
          s.latestLow,

        bullishLevel:
          s.latestHigh,

        bearishLevel:
          s.latestLow
      };
    }

    const bosM5 =
      detectBOS(M5);

    const bosM15 =
      detectBOS(M15);

    // =========================================================
    // CHoCH
    // =========================================================

    function detectCHoCH(candles) {
      const s =
        getSwingPoints(candles);

      if (
        s.highs.length < 3 ||
        s.lows.length < 3
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

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

      return {
        bullish:
          h2 < h1 &&
          l2 < l1 &&
          h3 > h2,

        bearish:
          h2 > h1 &&
          l2 > l1 &&
          l3 < l2
      };
    }

    const chochM5 =
      detectCHoCH(M5);

    const chochM15 =
      detectCHoCH(M15);

    // =========================================================
    // BREAK + RETEST
    // =========================================================

    function detectBreakRetest(
      candles
    ) {
      if (
        candles.length < 8
      ) {
        return {
          bullish: false,
          bearish: false,
          bullishLevel: null,
          bearishLevel: null
        };
      }

      const last =
        candles[candles.length - 1];

      const prev =
        candles[candles.length - 2];

      const range =
        candles.slice(-8, -2);

      const high =
        Math.max(
          ...range.map(
            c => c.high
          )
        );

      const low =
        Math.min(
          ...range.map(
            c => c.low
          )
        );

      return {
        bullish:
          prev.close > high &&
          last.low <= high &&
          last.close > high,

        bearish:
          prev.close < low &&
          last.high >= low &&
          last.close < low,

        bullishLevel: high,
        bearishLevel: low
      };
    }

    const breakRetestM5 =
      detectBreakRetest(M5);

    const breakRetestM15 =
      detectBreakRetest(M15);

    // =========================================================
    // TRENDLINE BREAK / RETEST
    // =========================================================

    function detectTrendlineRetest(
      candles
    ) {
      const s =
        getSwingPoints(candles);

      if (
        s.highs.length < 2 ||
        s.lows.length < 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const last =
        candles[candles.length - 1];

      const h1 =
        s.highs[
          s.highs.length - 2
        ];

      const h2 =
        s.highs[
          s.highs.length - 1
        ];

      const l1 =
        s.lows[
          s.lows.length - 2
        ];

      const l2 =
        s.lows[
          s.lows.length - 1
        ];

      const bullishSlope =
        l2.price > l1.price;

      const bearishSlope =
        h2.price < h1.price;

      const bullish =
        bullishSlope &&
        last.close > l2.price;

      const bearish =
        bearishSlope &&
        last.close < h2.price;

      return {
        bullish,
        bearish
      };
    }

    const trendlineM5 =
      detectTrendlineRetest(M5);

    const trendlineM15 =
      detectTrendlineRetest(M15);

    // =========================================================
    // RBR / DBD / RBD / DBR
    // =========================================================

    function detectBasePattern(
      candles
    ) {
      if (
        candles.length < 6
      ) {
        return {
          bullish: false,
          bearish: false,
          type: "NONE"
        };
      }

      const a =
        candles[candles.length - 5];

      const b =
        candles[candles.length - 4];

      const c =
        candles[candles.length - 3];

      const d =
        candles[candles.length - 2];

      const e =
        candles[candles.length - 1];

      const avgBody =
        avg(
          candles
            .slice(-10)
            .map(
              x => candleBody(x)
            )
        );

      const smallBase =
        candleBody(b) <=
          avgBody * 0.8 &&
        candleBody(c) <=
          avgBody * 0.8 &&
        candleBody(d) <=
          avgBody * 0.9;

      const bullishImpulse =
        candleBody(e) >=
          avgBody * 1.15 &&
        bullish(e);

      const bearishImpulse =
        candleBody(e) >=
          avgBody * 1.15 &&
        bearish(e);

      // RBR
      if (
        bullish(a) &&
        smallBase &&
        bullishImpulse
      ) {
        return {
          bullish: true,
          bearish: false,
          type: "RBR"
        };
      }

      // DBD
      if (
        bearish(a) &&
        smallBase &&
        bearishImpulse
      ) {
        return {
          bullish: false,
          bearish: true,
          type: "DBD"
        };
      }

      // RBD
      if (
        bullish(a) &&
        smallBase &&
        bearishImpulse
      ) {
        return {
          bullish: false,
          bearish: true,
          type: "RBD"
        };
      }

      // DBR
      if (
        bearish(a) &&
        smallBase &&
        bullishImpulse
      ) {
        return {
          bullish: true,
          bearish: false,
          type: "DBR"
        };
      }

      return {
        bullish: false,
        bearish: false,
        type: "NONE"
      };
    }

    const baseM5 =
      detectBasePattern(M5);

    const baseM15 =
      detectBasePattern(M15);

    // =========================================================
    // CMP REACTION
    // =========================================================

    function cmpReaction() {
      const last =
        M5[M5.length - 1];

      if (
        cmpLocation.state ===
        "NO_ZONE"
      ) {
        return "NO_ZONE";
      }

      if (
        cmpLocation.zone.type ===
        "DEMAND"
      ) {
        if (
          bullish(last)
        ) {
          return "REJECTING_DEMAND";
        }

        if (
          last.low <
          cmpLocation.zone.low
        ) {
          return "BREAKING_DEMAND";
        }

        return "TESTING_DEMAND";
      }

      if (
        cmpLocation.zone.type ===
        "SUPPLY"
      ) {
        if (
          bearish(last)
        ) {
          return "REJECTING_SUPPLY";
        }

        if (
          last.high >
          cmpLocation.zone.high
        ) {
          return "BREAKING_SUPPLY";
        }

        return "TESTING_SUPPLY";
      }

      return "NEUTRAL";
    }

    const reaction =
      cmpReaction();

    // =========================================================
    // EARLY M5 BREAK
    // =========================================================

    function detectEarlyM5Break() {
      const last =
        M5[M5.length - 1];

      const support =
        levelsM15.support;

      const resistance =
        levelsM15.resistance;

      const result = {
        bullish: false,
        bearish: false,
        support,
        resistance
      };

      if (
        support &&
        last.close < support
      ) {
        result.bearish = true;
      }

      if (
        resistance &&
        last.close > resistance
      ) {
        result.bullish = true;
      }

      return result;
    }

    const earlyBreak =
      detectEarlyM5Break();

    // =========================================================
    // M15 TEST
    // =========================================================

    function m15TestStatus() {
      const result = {
        support: false,
        resistance: false
      };

      if (
        levelsM15.support &&
        Math.abs(
          currentPrice -
          levelsM15.support
        ) <= POINT * 80
      ) {
        result.support = true;
      }

      if (
        levelsM15.resistance &&
        Math.abs(
          currentPrice -
          levelsM15.resistance
        ) <= POINT * 80
      ) {
        result.resistance = true;
      }

      return result;
    }

    const m15Test =
      m15TestStatus();

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

      const bullishCount =
        dirs.filter(
          x => x === "BULLISH"
        ).length;

      const bearishCount =
        dirs.filter(
          x => x === "BEARISH"
        ).length;

      const recentRanges =
        M5.slice(-15).map(
          c =>
            c.high -
            c.low
        );

      const avgRange =
        avg(recentRanges);

      const volatilityRatio =
        avgRange > 0
          ? atr.M5 / avgRange
          : 1;

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
        bullishCount >= 3
      ) {
        return "TRENDING_BULLISH";
      }

      if (
        bearishCount >= 3
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

      if (
        volatilityRatio > 1.35
      ) {
        return "HIGH_VOLATILITY";
      }

      return "RANGING";
    }

    const marketRegime =
      detectRegime();

    // =========================================================
    // ZONE DIRECTION
    // =========================================================

    function zoneDirection(zone) {
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
    // SCALPING ENGINE
    // ACTIVE / MULTI-TECHNIQUE
    // SIGNAL = 65+
    // =========================================================

    function scalpSide(side) {
      let score = 0;

      const reasons = [];

      const wanted =
        side === "BUY"
          ? "BULLISH"
          : "BEARISH";

      const isBuy =
        side === "BUY";

      // -------------------------------------------------------
      // H1 BIAS
      // -------------------------------------------------------

      if (
        direction.H1 === wanted
      ) {
        score += 15;

        reasons.push(
          `H1 ${side} bias`
        );
      }

      // -------------------------------------------------------
      // M15 STRUCTURE
      // -------------------------------------------------------

      if (
        direction.M15 === wanted
      ) {
        score += 15;

        reasons.push(
          `M15 ${side} structure`
        );
      }

      // -------------------------------------------------------
      // SUPPLY / DEMAND
      // -------------------------------------------------------

      if (
        zoneDir === side
      ) {
        score += 10;

        reasons.push(
          `${side} supply-demand zone`
        );
      }

      if (
        cmpLocation.state ===
        "INSIDE_ZONE"
      ) {
        score += 8;

        reasons.push(
          "CMP inside zone"
        );
      }

      // -------------------------------------------------------
      // FRESH / FIRST TOUCH
      // -------------------------------------------------------

      if (
        zoneDir === side &&
        freshZone.fresh
      ) {
        score += 5;

        reasons.push(
          "Fresh zone"
        );
      }

      if (
        zoneDir === side &&
        freshZone.firstTouch
      ) {
        score += 4;

        reasons.push(
          "First touch"
        );
      }

      // -------------------------------------------------------
      // FIBONACCI
      // ONLY 0.382 / 0.500
      // -------------------------------------------------------

      const fibAligned =
        isBuy
          ? (
              fibonacciM15.buy ||
              fibonacciM5.buy
            )
          : (
              fibonacciM15.sell ||
              fibonacciM5.sell
            );

      if (fibAligned) {
        score += 8;

        reasons.push(
          "Fibonacci 0.382 / 0.500"
        );
      }

      // -------------------------------------------------------
      // FIBO + ZONE CONFLUENCE
      // -------------------------------------------------------

      if (
        fibAligned &&
        zoneDir === side
      ) {
        score += 5;

        reasons.push(
          "Fibonacci + SNR confluence"
        );
      }

      // -------------------------------------------------------
      // BOS
      // -------------------------------------------------------

      if (
        isBuy &&
        (
          bosM5.bullish ||
          bosM15.bullish
        )
      ) {
        score += 5;

        reasons.push(
          "Bullish BOS"
        );
      }

      if (
        !isBuy &&
        (
          bosM5.bearish ||
          bosM15.bearish
        )
      ) {
        score += 5;

        reasons.push(
          "Bearish BOS"
        );
      }

      // -------------------------------------------------------
      // CHoCH
      // -------------------------------------------------------

      if (
        isBuy &&
        (
          chochM5.bullish ||
          chochM15.bullish
        )
      ) {
        score += 5;

        reasons.push(
          "Bullish CHoCH"
        );
      }

      if (
        !isBuy &&
        (
          chochM5.bearish ||
          chochM15.bearish
        )
      ) {
        score += 5;

        reasons.push(
          "Bearish CHoCH"
        );
      }

      // -------------------------------------------------------
      // LIQUIDITY SWEEP
      // -------------------------------------------------------

      if (
        isBuy &&
        liquidityM5.bullish
      ) {
        score += 5;

        reasons.push(
          "M5 bullish liquidity sweep"
        );
      }

      if (
        !isBuy &&
        liquidityM5.bearish
      ) {
        score += 5;

        reasons.push(
          "M5 bearish liquidity sweep"
        );
      }

      // -------------------------------------------------------
      // DOUBLE TOP / BOTTOM
      // -------------------------------------------------------

      if (
        isBuy &&
        doubleM5.type ===
        "DOUBLE_BOTTOM"
      ) {
        score += 8;

        reasons.push(
          "M5 double bottom"
        );
      }

      if (
        !isBuy &&
        doubleM5.type ===
        "DOUBLE_TOP"
      ) {
        score += 8;

        reasons.push(
          "M5 double top"
        );
      }

      // -------------------------------------------------------
      // QUASIMODO
      // -------------------------------------------------------

      const qmAligned =
        isBuy
          ? (
              qmM5.type === "QM_BUY" ||
              qmM15.type === "QM_BUY"
            )
          : (
              qmM5.type === "QM_SELL" ||
              qmM15.type === "QM_SELL"
            );

      if (qmAligned) {
        score += 5;

        reasons.push(
          `QM ${side}`
        );
      }

      // -------------------------------------------------------
      // TRENDLINE BREAK / RETEST
      // -------------------------------------------------------

      if (
        isBuy &&
        (
          trendlineM5.bullish ||
          trendlineM15.bullish
        )
      ) {
        score += 10;

        reasons.push(
          "Bullish trendline break/retest"
        );
      }

      if (
        !isBuy &&
        (
          trendlineM5.bearish ||
          trendlineM15.bearish
        )
      ) {
        score += 10;

        reasons.push(
          "Bearish trendline break/retest"
        );
      }

      // -------------------------------------------------------
      // BREAK + RETEST
      // -------------------------------------------------------

      if (
        isBuy &&
        (
          breakRetestM5.bullish ||
          breakRetestM15.bullish
        )
      ) {
        score += 7;

        reasons.push(
          "Bullish breakout + retest"
        );
      }

      if (
        !isBuy &&
        (
          breakRetestM5.bearish ||
          breakRetestM15.bearish
        )
      ) {
        score += 7;

        reasons.push(
          "Bearish breakout + retest"
        );
      }

      // -------------------------------------------------------
      // RBR / DBD / RBD / DBR
      // -------------------------------------------------------

      const baseAligned =
        isBuy
          ? (
              baseM5.bullish ||
              baseM15.bullish
            )
          : (
              baseM5.bearish ||
              baseM15.bearish
            );

      if (baseAligned) {
        score += 5;

        const baseType =
          isBuy
            ? (
                baseM5.bullish
                  ? baseM5.type
                  : baseM15.type
              )
            : (
                baseM5.bearish
                  ? baseM5.type
                  : baseM15.type
              );

        reasons.push(
          `${baseType} base pattern`
        );
      }

      // -------------------------------------------------------
      // M5 ENGULFING
      // -------------------------------------------------------

      const engulfing =
        isBuy
          ? m5Trigger.buy.includes(
              "BULLISH_ENGULFING"
            )
          : m5Trigger.sell.includes(
              "BEARISH_ENGULFING"
            );

      if (engulfing) {
        score += 10;

        reasons.push(
          `${side} engulfing`
        );
      }

      // -------------------------------------------------------
      // M5 REJECTION
      // -------------------------------------------------------

      const rejection =
        isBuy
          ? m5Trigger.buy.includes(
              "BULLISH_REJECTION"
            )
          : m5Trigger.sell.includes(
              "BEARISH_REJECTION"
            );

      if (rejection) {
        score += 8;

        reasons.push(
          `${side} rejection`
        );
      }

      // -------------------------------------------------------
      // M5 DISPLACEMENT
      // -------------------------------------------------------

      const displacement =
        isBuy
          ? m5Trigger.buy.includes(
              "BULLISH_DISPLACEMENT"
            )
          : m5Trigger.sell.includes(
              "BEARISH_DISPLACEMENT"
            );

      if (displacement) {
        score += 10;

        reasons.push(
          `${side} displacement`
        );
      }

      // -------------------------------------------------------
      // M5 STRUCTURE SHIFT
      // -------------------------------------------------------

      const structureShift =
        isBuy
          ? m5Trigger.buy.includes(
              "M5_STRUCTURE_SHIFT"
            )
          : m5Trigger.sell.includes(
              "M5_STRUCTURE_SHIFT"
            );

      if (structureShift) {
        score += 7;

        reasons.push(
          `M5 ${side} structure shift`
        );
      }

      // -------------------------------------------------------
      // CMP REACTION
      // -------------------------------------------------------

      if (
        isBuy &&
        reaction ===
        "REJECTING_DEMAND"
      ) {
        score += 5;

        reasons.push(
          "CMP rejecting demand"
        );
      }

      if (
        !isBuy &&
        reaction ===
        "REJECTING_SUPPLY"
      ) {
        score += 5;

        reasons.push(
          "CMP rejecting supply"
        );
      }

      // -------------------------------------------------------
      // TREND ENVIRONMENT
      // -------------------------------------------------------

      if (
        isBuy &&
        (
          marketRegime ===
          "TRENDING_BULLISH" ||
          marketRegime ===
          "BREAKOUT_BULLISH"
        )
      ) {
        score += 5;

        reasons.push(
          "Bullish trend environment"
        );
      }

      if (
        !isBuy &&
        (
          marketRegime ===
          "TRENDING_BEARISH" ||
          marketRegime ===
          "BREAKOUT_BEARISH"
        )
      ) {
        score += 5;

        reasons.push(
          "Bearish trend environment"
        );
      }

      // -------------------------------------------------------
      // REVERSAL
      // -------------------------------------------------------

      if (
        isBuy &&
        marketRegime ===
        "REVERSAL_BULLISH"
      ) {
        score += 5;

        reasons.push(
          "Bullish reversal"
        );
      }

      if (
        !isBuy &&
        marketRegime ===
        "REVERSAL_BEARISH"
      ) {
        score += 5;

        reasons.push(
          "Bearish reversal"
        );
      }

      // =======================================================
      // CAP SCORE
      // =======================================================

      score =
        clamp(
          Math.round(score),
          0,
          100
        );

      // =======================================================
      // CONFIRMATION
      // =======================================================

      const hasM5Trigger =
        isBuy
          ? m5Trigger.buy.length > 0
          : m5Trigger.sell.length > 0;

      const hasLiquidity =
        isBuy
          ? liquidityM5.bullish
          : liquidityM5.bearish;

      const hasPattern =
        isBuy
          ? (
              doubleM5.type ===
              "DOUBLE_BOTTOM" ||
              qmM5.type ===
              "QM_BUY"
            )
          : (
              doubleM5.type ===
              "DOUBLE_TOP" ||
              qmM5.type ===
              "QM_SELL"
            );

      const hasStructure =
        isBuy
          ? (
              bosM5.bullish ||
              chochM5.bullish ||
              breakRetestM5.bullish
            )
          : (
              bosM5.bearish ||
              chochM5.bearish ||
              breakRetestM5.bearish
            );

      const hasConfirmation =
        hasM5Trigger ||
        hasLiquidity ||
        hasPattern ||
        hasStructure;

      const hasLocation =
        zoneDir === side ||
        cmpLocation.state ===
        "INSIDE_ZONE" ||
        cmpLocation.state ===
        "NEAR_ZONE";

      // =======================================================
      // STATUS
      // =======================================================

      let status =
        "WAIT";

      if (
        score >= 30 &&
        (
          hasLocation ||
          hasConfirmation
        )
      ) {
        status = "SETUP";
      }

      if (
        score >= 45 &&
        hasLocation &&
        hasConfirmation
      ) {
        status = "READY";
      }

      // SCALPING SIGNAL 65+
      if (
        score >= SCALP_SIGNAL_SCORE &&
        hasConfirmation &&
        (
          hasLocation ||
          direction.H1 === wanted ||
          direction.M15 === wanted
        )
      ) {
        status = "SIGNAL";
      }

      return {
        side,
        status,
        score,

        contextScore:
          (
            direction.H1 === wanted
              ? 15
              : 0
          ) +
          (
            direction.M15 === wanted
              ? 15
              : 0
          ),

        locationScore:
          (
            zoneDir === side
              ? 10
              : 0
          ) +
          (
            cmpLocation.state ===
            "INSIDE_ZONE"
              ? 8
              : 0
          ),

        triggerScore:
          (
            engulfing
              ? 10
              : 0
          ) +
          (
            rejection
              ? 8
              : 0
          ) +
          (
            displacement
              ? 10
              : 0
          ) +
          (
            hasLiquidity
              ? 5
              : 0
          ),

        patternScore:
          (
            hasPattern
              ? 8
              : 0
          ) +
          (
            baseAligned
              ? 5
              : 0
          ),

        qualityScore:
          (
            freshZone.fresh &&
            zoneDir === side
          )
            ? 5
            : 0,

        m5Confirmed:
          hasM5Trigger,

        reasons: [
          ...new Set(reasons)
        ].slice(0, 12)
      };
    }

    const scalpBuy =
      scalpSide("BUY");

    const scalpSell =
      scalpSide("SELL");

    // =========================================================
    // INTRADAY ENGINE
    // SELECTIVE MULTI-TECHNIQUE
    // SIGNAL = 90+
    // =========================================================

    function intradaySide(side) {
      let score = 0;

      const reasons = [];

      const wanted =
        side === "BUY"
          ? "BULLISH"
          : "BEARISH";

      const isBuy =
        side === "BUY";

      // -------------------------------------------------------
      // H4
      // -------------------------------------------------------

      if (
        direction.H4 === wanted
      ) {
        score += 20;

        reasons.push(
          `H4 ${side} bias`
        );
      }

      // -------------------------------------------------------
      // H1
      // -------------------------------------------------------

      if (
        direction.H1 === wanted
      ) {
        score += 20;

        reasons.push(
          `H1 ${side} bias`
        );
      }

      // -------------------------------------------------------
      // M15
      // -------------------------------------------------------

      if (
        direction.M15 === wanted
      ) {
        score += 15;

        reasons.push(
          `M15 ${side} structure`
        );
      }

      // -------------------------------------------------------
      // SNR / SUPPLY DEMAND
      // -------------------------------------------------------

      if (
        zoneDir === side
      ) {
        score += 10;

        reasons.push(
          `${side} MTF zone`
        );
      }

      if (
        cmpLocation.state ===
        "INSIDE_ZONE"
      ) {
        score += 5;

        reasons.push(
          "CMP inside zone"
        );
      }

      // -------------------------------------------------------
      // FRESH ZONE
      // -------------------------------------------------------

      if (
        zoneDir === side &&
        freshZone.fresh
      ) {
        score += 5;

        reasons.push(
          "Fresh zone"
        );
      }

      // -------------------------------------------------------
      // FIBONACCI
      // -------------------------------------------------------

      const fibAligned =
        isBuy
          ? (
              fibonacciM15.buy ||
              fibonacciM5.buy
            )
          : (
              fibonacciM15.sell ||
              fibonacciM5.sell
            );

      if (fibAligned) {
        score += 8;

        reasons.push(
          "Fibonacci 0.382 / 0.500"
        );
      }

      // -------------------------------------------------------
      // FIBO + SNR
      // -------------------------------------------------------

      if (
        fibAligned &&
        zoneDir === side
      ) {
        score += 5;

        reasons.push(
          "Fibonacci + SNR confluence"
        );
      }

      // -------------------------------------------------------
      // BOS
      // -------------------------------------------------------

      const bosAligned =
        isBuy
          ? (
              bosM15.bullish ||
              bosM5.bullish
            )
          : (
              bosM15.bearish ||
              bosM5.bearish
            );

      if (bosAligned) {
        score += 5;

        reasons.push(
          `${side} BOS`
        );
      }

      // -------------------------------------------------------
      // CHoCH
      // -------------------------------------------------------

      const chochAligned =
        isBuy
          ? (
              chochM15.bullish ||
              chochM5.bullish
            )
          : (
              chochM15.bearish ||
              chochM5.bearish
            );

      if (chochAligned) {
        score += 5;

        reasons.push(
          `${side} CHoCH`
        );
      }

      // -------------------------------------------------------
      // LIQUIDITY
      // -------------------------------------------------------

      const liquidityAligned =
        isBuy
          ? (
              liquidityM15.bullish ||
              liquidityM5.bullish
            )
          : (
              liquidityM15.bearish ||
              liquidityM5.bearish
            );

      if (liquidityAligned) {
        score += 5;

        reasons.push(
          `${side} liquidity sweep`
        );
      }

      // -------------------------------------------------------
      // TRENDLINE
      // -------------------------------------------------------

      const trendlineAligned =
        isBuy
          ? (
              trendlineM15.bullish ||
              trendlineM5.bullish
            )
          : (
              trendlineM15.bearish ||
              trendlineM5.bearish
            );

      if (trendlineAligned) {
        score += 5;

        reasons.push(
          `${side} trendline break/retest`
        );
      }

      // -------------------------------------------------------
      // BREAK + RETEST
      // -------------------------------------------------------

      const breakRetestAligned =
        isBuy
          ? (
              breakRetestM15.bullish ||
              breakRetestM5.bullish
            )
          : (
              breakRetestM15.bearish ||
              breakRetestM5.bearish
            );

      if (breakRetestAligned) {
        score += 5;

        reasons.push(
          `${side} breakout + retest`
        );
      }

      // -------------------------------------------------------
      // QM
      // -------------------------------------------------------

      const qmAligned =
        isBuy
          ? (
              qmM15.type === "QM_BUY" ||
              qmM5.type === "QM_BUY"
            )
          : (
              qmM15.type === "QM_SELL" ||
              qmM5.type === "QM_SELL"
            );

      if (qmAligned) {
        score += 5;

        reasons.push(
          `QM ${side}`
        );
      }

      // -------------------------------------------------------
      // BASE PATTERN
      // -------------------------------------------------------

      const baseAligned =
        isBuy
          ? (
              baseM15.bullish ||
              baseM5.bullish
            )
          : (
              baseM15.bearish ||
              baseM5.bearish
            );

      if (baseAligned) {
        score += 5;

        reasons.push(
          `${side} base pattern`
        );
      }

      // -------------------------------------------------------
      // M5 ENGULFING
      // -------------------------------------------------------

      const engulfing =
        isBuy
          ? m5Trigger.buy.includes(
              "BULLISH_ENGULFING"
            )
          : m5Trigger.sell.includes(
              "BEARISH_ENGULFING"
            );

      if (engulfing) {
        score += 7;

        reasons.push(
          `${side} engulfing`
        );
      }

      // -------------------------------------------------------
      // M5 REJECTION
      // -------------------------------------------------------

      const rejection =
        isBuy
          ? m5Trigger.buy.includes(
              "BULLISH_REJECTION"
            )
          : m5Trigger.sell.includes(
              "BEARISH_REJECTION"
            );

      if (rejection) {
        score += 6;

        reasons.push(
          `${side} rejection`
        );
      }

      // -------------------------------------------------------
      // M5 DISPLACEMENT
      // -------------------------------------------------------

      const displacement =
        isBuy
          ? m5Trigger.buy.includes(
              "BULLISH_DISPLACEMENT"
            )
          : m5Trigger.sell.includes(
              "BEARISH_DISPLACEMENT"
            );

      if (displacement) {
        score += 8;

        reasons.push(
          `${side} displacement`
        );
      }

      // -------------------------------------------------------
      // DOUBLE TOP / BOTTOM
      // -------------------------------------------------------

      const doubleAligned =
        isBuy
          ? doubleM5.type ===
            "DOUBLE_BOTTOM"
          : doubleM5.type ===
            "DOUBLE_TOP";

      if (doubleAligned) {
        score += 5;

        reasons.push(
          `${side} double pattern`
        );
      }

      // -------------------------------------------------------
      // M5 STRUCTURE SHIFT
      // -------------------------------------------------------

      const structureShift =
        isBuy
          ? m5Trigger.buy.includes(
              "M5_STRUCTURE_SHIFT"
            )
          : m5Trigger.sell.includes(
              "M5_STRUCTURE_SHIFT"
            );

      if (structureShift) {
        score += 5;

        reasons.push(
          `M5 ${side} structure shift`
        );
      }

      // -------------------------------------------------------
      // TOTAL
      // -------------------------------------------------------

      score =
        clamp(
          Math.round(score),
          0,
          100
        );

      // =======================================================
      // STATUS
      // =======================================================

      let status =
        "WAIT";

      if (
        score >= 45
      ) {
        status =
          "SETUP";
      }

      if (
        score >= 65 &&
        direction.H4 === wanted &&
        direction.H1 === wanted
      ) {
        status =
          "READY";
      }

      const intradayConfirmation =
        engulfing ||
        rejection ||
        displacement ||
        liquidityAligned ||
        bosAligned ||
        chochAligned ||
        breakRetestAligned ||
        qmAligned;

      // INTRADAY SIGNAL 90+
      if (
        score >= INTRA_SIGNAL_SCORE &&
        direction.H4 === wanted &&
        direction.H1 === wanted &&
        direction.M15 === wanted &&
        intradayConfirmation
      ) {
        status =
          "SIGNAL";
      }

      return {
        side,
        status,
        score,

        reasons: [
          ...new Set(reasons)
        ].slice(0, 12),

        m5Confirmed:
          engulfing ||
          rejection ||
          displacement ||
          structureShift
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
      score
    ) {
      if (!side) {
        return null;
      }

      const isScalp =
        mode === "SCALPING";

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

      const signalThreshold =
        isScalp
          ? SCALP_SIGNAL_SCORE
          : INTRA_SIGNAL_SCORE;

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
        direction: side,
        mode,

        status:
          score >= signalThreshold
            ? "SIGNAL"
            : "SETUP",

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
    // CANDIDATES
    // =========================================================

    const scalpCandidate =
      scalpBuy.score >= scalpSell.score
        ? scalpBuy
        : scalpSell;

    const intraCandidate =
      intraBuy.score >= intraSell.score
        ? intraBuy
        : intraSell;

    // =========================================================
    // PLANS
    // =========================================================

    const scalpingPlan =
      scalpCandidate.status ===
      "SIGNAL"
        ? buildTradePlan(
            scalpCandidate.side,
            "SCALPING",
            scalpCandidate.score
          )
        : null;

    const intradayPlan =
      intraCandidate.status ===
      "SIGNAL"
        ? buildTradePlan(
            intraCandidate.side,
            "INTRADAY",
            intraCandidate.score
          )
        : null;

    // =========================================================
    // SMART WAIT
    // =========================================================

    function waitReason(
      side,
      mode
    ) {
      const wanted =
        side === "BUY"
          ? "BULLISH"
          : "BEARISH";

      if (
        mode === "SCALPING"
      ) {
        if (
          m15Test.support &&
          earlyBreak.bearish
        ) {
          return (
            "M15 SUPPORT UNDER TEST — " +
            "M5 BROKE SUPPORT EARLY"
          );
        }

        if (
          m15Test.resistance &&
          earlyBreak.bullish
        ) {
          return (
            "M15 RESISTANCE UNDER TEST — " +
            "M5 BROKE RESISTANCE EARLY"
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
            "INSIDE_ZONE" &&
          !(
            side === "BUY"
              ? m5Trigger.buy.length
              : m5Trigger.sell.length
          )
        ) {
          return (
            `WAITING FOR M5 ${side} CONFIRMATION`
          );
        }

        if (
          m15Break.confirmed
        ) {
          return (
            "WAITING FOR RETEST"
          );
        }

        return (
          `WAITING FOR ${side} SCALPING TRIGGER`
        );
      }

      // =======================================================
      // INTRADAY WAIT
      // =======================================================

      if (
        direction.H4 !== wanted
      ) {
        return (
          `WAITING FOR H4 ${side} ALIGNMENT`
        );
      }

      if (
        direction.H1 !== wanted
      ) {
        return (
          `WAITING FOR H1 ${side} ALIGNMENT`
        );
      }

      if (
        direction.M15 !== wanted
      ) {
        return (
          `WAITING FOR M15 ${side} ALIGNMENT`
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
        `WAITING FOR STRONGER ${side} CONFLUENCE`
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
        `H4 ${direction.H4.toLowerCase()}`
      );

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
    // PRIMARY SETUP
    // MAIN SIGNAL = STRONGEST VALID SIGNAL
    // DOES NOT CHANGE SCALPING / INTRADAY
    // =========================================================

    const primaryCandidates = [];

    if (
      scalpingPlan
    ) {
      primaryCandidates.push({
        ...scalpingPlan,

        score:
          scalpCandidate.score,

        reasons:
          scalpCandidate.reasons,

        narrative:
          narrative(
            scalpCandidate.side,
            "SCALPING"
          )
      });
    }

    if (
      intradayPlan
    ) {
      primaryCandidates.push({
        ...intradayPlan,

        score:
          intraCandidate.score,

        reasons:
          intraCandidate.reasons,

        narrative:
          narrative(
            intraCandidate.side,
            "INTRADAY"
          )
      });
    }

    primaryCandidates.sort(
      (a, b) => {
        if (
          b.score !== a.score
        ) {
          return b.score - a.score;
        }

        // Tie → prefer scalping
        if (
          a.mode === "SCALPING"
        ) {
          return -1;
        }

        return 1;
      }
    );

    const primarySetup =
      primaryCandidates.length
        ? primaryCandidates[0]
        : null;

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
        x.status === "SETUP" ||
        x.status === "READY" ||
        x.status === "SIGNAL"
    );

    const intraSignals = [
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
    // FINAL RESPONSE
    // =========================================================

    const output = {
      status: "success",

      engine: {
        name:
          "SINNCI MARKET ENGINE PRO",

        version:
          "PRO-3.0",

        mode:
          "ACTIVE SCALPING / SELECTIVE INTRADAY",

        timeframeFlow:
          "H4 → H1 → M15 → CMP → M5",

        signalStyle:
          "MULTI-TECHNIQUE",

        dataRequests:
          "H4 + H1 + M15 + M5"
      },

      thresholds: {
        scalpingSignal:
          SCALP_SIGNAL_SCORE,

        intradaySignal:
          INTRA_SIGNAL_SCORE,

        fibonacci:
          [
            "0.382",
            "0.500"
          ]
      },

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
                  freshZone.fresh,

                firstTouch:
                  freshZone.firstTouch,

                touches:
                  freshZone.touches
              }
            : null,

        distancePoints:
          cmpLocation.distancePoints
      },

      fibonacci: {
        M15:
          fibonacciM15,

        M5:
          fibonacciM5,

        allowedLevels: [
          0.382,
          0.500
        ]
      },

      breakout: {
        M15:
          m15Break,

        M5EarlyBreak:
          earlyBreak,

        flip,

        breakRetestM15:
          breakRetestM15,

        breakRetestM5:
          breakRetestM5
      },

      structureTechniques: {
        bosM15,
        bosM5,

        chochM15,
        chochM5,

        trendlineM15,
        trendlineM5
      },

      patterns: {
        liquidityM5,
        liquidityM15,

        doubleM5,

        qmM5,
        qmM15,

        baseM5,
        baseM15
      },

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
                  "SCALPING"
                )
        },

        sell: {
          ...scalpSell,

          wait:
            scalpSell.status ===
            "SIGNAL"
              ? null
              : waitReason(
                  "SELL",
                  "SCALPING"
                )
        },

        activeSetups:
          scalpSetups.length,

        activeSignals:
          scalpSignals.length,

        plan:
          scalpingPlan,

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
                  "INTRADAY"
                )
        },

        sell: {
          ...intraSell,

          wait:
            intraSell.status ===
            "SIGNAL"
              ? null
              : waitReason(
                  "SELL",
                  "INTRADAY"
                )
        },

        activeSignals:
          intraSignals.length,

        plan:
          intradayPlan,

        fixedRisk: {
          SL:
            "500 points / 50 pips",

          TP1:
            "1600 points / 160 pips",

          TP2:
            "2500 points / 250 pips"
        }
      },

      // =======================================================
      // MAIN SIGNAL
      // =======================================================

      primarySetup,

      // =======================================================
      // CANDLE STATUS
      // =======================================================

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

      // =======================================================
      // ATR
      // =======================================================

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

      // =======================================================
      // CANDLE COUNT
      // =======================================================

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
    // SAVE CACHE
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
