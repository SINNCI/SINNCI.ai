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
    // ACTIVE SCALPING / SELECTIVE INTRADAY
    // =========================================================

    const POINT = 0.01;

    // Fixed risk model
    const SCALP_SL_POINTS = 500;
    const SCALP_TP1_POINTS = 600;
    const SCALP_TP2_POINTS = 1200;

    const INTRA_SL_POINTS = 500;
    const INTRA_TP1_POINTS = 1600;
    const INTRA_TP2_POINTS = 2500;

    // ---------------------------------------------------------
    // CACHE
    // ---------------------------------------------------------

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

    const pointsToPrice = (points) =>
      points * POINT;

    const priceToPoints = (price) =>
      price / POINT;

    const avg = (arr) => {
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

    const candleBody = (c) =>
      Math.abs(
        safeNum(c.close) -
        safeNum(c.open)
      );

    const candleRange = (c) =>
      Math.max(
        0.0001,
        safeNum(c.high) -
        safeNum(c.low)
      );

    const upperWick = (c) =>
      safeNum(c.high) -
      Math.max(
        safeNum(c.open),
        safeNum(c.close)
      );

    const lowerWick = (c) =>
      Math.min(
        safeNum(c.open),
        safeNum(c.close)
      ) -
      safeNum(c.low);

    const bullish = (c) =>
      safeNum(c.close) >
      safeNum(c.open);

    const bearish = (c) =>
      safeNum(c.close) <
      safeNum(c.open);

    const bodyRatio = (c) =>
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
        i <
        candles.length - right;
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
            candles[i - j].high >=
              c.high ||
            candles[i - j].low <=
              c.low
          ) {
            isHigh = false;
            isLow = false;
            break;
          }
        }

        if (isHigh) {
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
              candles[i + j].low <=
              c.low
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
          highs[
            highs.length - 2
          ].price;

        const h2 =
          highs[
            highs.length - 1
          ].price;

        const l1 =
          lows[
            lows.length - 2
          ].price;

        const l2 =
          lows[
            lows.length - 1
          ].price;

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
            ? highs[
                highs.length - 1
              ].price
            : null,

        previousHigh:
          highs.length >= 2
            ? highs[
                highs.length - 2
              ].price
            : null,

        latestLow:
          lows.length
            ? lows[
                lows.length - 1
              ].price
            : null,

        previousLow:
          lows.length >= 2
            ? lows[
                lows.length - 2
              ].price
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

    function getDirection(
      candles
    ) {
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
        M5[
          M5.length - 1
        ].close
      );

    // =========================================================
    // ZONE BUILDER
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
        high: round(c.high, 2),
        low: round(c.low, 2),
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
          candles.length - 35
        );

      for (
        let i = start;
        i <
        candles.length - 1;
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
          body / range >=
            0.45
        ) {
          zones.push(
            candleZone(
              c,
              "DEMAND",
              source
            )
          );
        }

        if (
          bearish(c) &&
          body / range >=
            0.45
        ) {
          zones.push(
            candleZone(
              c,
              "SUPPLY",
              source
            )
          );
        }

        if (
          displacement >
          Math.max(
            atr[source] *
              0.45,
            POINT * 40
          )
        ) {
          zones.push(
            candleZone(
              c,
              bullish(c)
                ? "DEMAND"
                : "SUPPLY",
              source
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

    function zoneQuality(
      zone
    ) {
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
        priceToPoints(
          distance
        );

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

    allZones.forEach(
      z => {
        z.quality =
          zoneQuality(z);
      }
    );

    // =========================================================
    // SUPPORT / RESISTANCE
    // =========================================================

    function nearestLevels(
      candles
    ) {
      const swings =
        getSwingPoints(
          candles
        );

      const supports =
        swings.lows
          .map(x => x.price)
          .filter(
            x =>
              x <
              currentPrice
          );

      const resistances =
        swings.highs
          .map(x => x.price)
          .filter(
            x =>
              x >
              currentPrice
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
    // M15 CANDLES
    // =========================================================

    const m15Current =
      M15[
        M15.length - 1
      ];

    const m15Closed =
      M15[
        M15.length - 2
      ];

    const m15Before =
      M15[
        M15.length - 3
      ];

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
          type:
            "BULLISH_BREAK",
          confirmed: true,
          level: rangeHigh
        };
      }

      if (
        closed < rangeLow
      ) {
        return {
          type:
            "BEARISH_BREAK",
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
          level:
            s.latestHigh,
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
          level:
            s.latestLow,
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
        candles[
          candles.length - 1
        ];

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
        lowerWick(last) >
          candleBody(last) *
            0.8;

      const bearishSweep =
        last.high >
          previousHigh &&
        last.close <
          previousHigh &&
        upperWick(last) >
          candleBody(last) *
            0.8;

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

    function detectDouble(
      candles
    ) {
      const s =
        getSwingPoints(
          candles
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

        const tolerance =
          Math.max(
            POINT * 35,
            atr.M5 * 0.35
          );

        if (
          Math.abs(
            h1 - h2
          ) <= tolerance
        ) {
          return {
            type:
              "DOUBLE_TOP",
            level:
              Math.max(
                h1,
                h2
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

        const tolerance =
          Math.max(
            POINT * 35,
            atr.M5 * 0.35
          );

        if (
          Math.abs(
            l1 - l2
          ) <= tolerance
        ) {
          return {
            type:
              "DOUBLE_BOTTOM",
            level:
              Math.min(
                l1,
                l2
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

    function l3Safe(
      lows
    ) {
      if (!lows.length) {
        return null;
      }

      return lows[
        lows.length - 1
      ].price;
    }

    function detectQM(
      candles
    ) {
      const s =
        getSwingPoints(
          candles
        );

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
            type:
              "QM_SELL",
            level: h3
          };
        }

        if (
          h2 < h1 &&
          h2 < h3 &&
          l2 > l1
        ) {
          return {
            type:
              "QM_BUY",
            level:
              l3Safe(s.lows)
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
        M5[
          M5.length - 1
        ];

      const prev =
        M5[
          M5.length - 2
        ];

      const prev2 =
        M5[
          M5.length - 3
        ];

      let buy = [];
      let sell = [];

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
          candleBody(last) *
            1.2 &&
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
          candleBody(last) *
            1.2 &&
        last.close <
          last.low +
          candleRange(last) *
            0.45
      ) {
        sell.push(
          "BEARISH_REJECTION"
        );
      }

      // Strong bullish candle
      if (
        bullish(last) &&
        bodyRatio(last) >=
          0.65 &&
        last.close >
          last.low +
          candleRange(last) *
            0.75
      ) {
        buy.push(
          "BULLISH_DISPLACEMENT"
        );
      }

      // Strong bearish candle
      if (
        bearish(last) &&
        bodyRatio(last) >=
          0.65 &&
        last.close <
          last.low +
          candleRange(last) *
            0.25
      ) {
        sell.push(
          "BEARISH_DISPLACEMENT"
        );
      }

      // Micro structure shift
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
          buy.length >
          sell.length
            ? "BUY"
            : sell.length >
              buy.length
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
      let nearestZone =
        null;

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
        zone:
          nearestZone,
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
    // CMP REACTION
    // =========================================================

    function cmpReaction() {
      const last =
        M5[
          M5.length - 1
        ];

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
        M5[
          M5.length - 1
        ];

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
        last.close <
          support
      ) {
        result.bearish =
          true;
      }

      if (
        resistance &&
        last.close >
          resistance
      ) {
        result.bullish =
          true;
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
        ) <=
          POINT * 80
      ) {
        result.support =
          true;
      }

      if (
        levelsM15.resistance &&
        Math.abs(
          currentPrice -
            levelsM15.resistance
        ) <=
          POINT * 80
      ) {
        result.resistance =
          true;
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
          x =>
            x === "BULLISH"
        ).length;

      const bearishCount =
        dirs.filter(
          x =>
            x === "BEARISH"
        ).length;

      const atrNow =
        atr.M5;

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
          ? atrNow /
            avgRange
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
    // SCALPING ENGINE
    // ACTIVE MODE
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
        context += 7;
      }

      // -------------------------------------------------------
      // M15 CONTEXT
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
      // CMP LOCATION
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
        "INSIDE_ZONE"
      ) {
        location += 10;
      }

      if (
        cmpLocation.state ===
          "APPROACHING_ZONE" &&
        zoneDir === side
      ) {
        location += 7;

        reasons.push(
          `${side} zone approaching`
        );
      }

      if (
        cmpLocation.state ===
        "NEAR_ZONE" &&
        zoneDir === side
      ) {
        location += 5;

        reasons.push(
          `${side} zone nearby`
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
        pattern += 15;

        reasons.push(
          "M5 double bottom"
        );
      }

      if (
        side === "SELL" &&
        doubleM5.type ===
          "DOUBLE_TOP"
      ) {
        pattern += 15;

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
        pattern += 15;

        reasons.push(
          "QM buy structure"
        );
      }

      if (
        side === "SELL" &&
        qmM5.type ===
          "QM_SELL"
      ) {
        pattern += 15;

        reasons.push(
          "QM sell structure"
        );
      }

      // -------------------------------------------------------
      // M5 TRIGGER
      // -------------------------------------------------------

      const sideTriggers =
        side === "BUY"
          ? m5Trigger.buy
          : m5Trigger.sell;

      const hasM5Trigger =
        sideTriggers.length >
        0;

      if (
        hasM5Trigger
      ) {
        trigger += Math.min(
          35,
          sideTriggers.length *
            12
        );

        reasons.push(
          ...sideTriggers
        );

        reasons.push(
          `M5 ${side} confirmation aligned`
        );
      }

      // -------------------------------------------------------
      // REJECTION
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        reaction ===
          "REJECTING_DEMAND"
      ) {
        trigger += 12;

        reasons.push(
          "CMP rejecting demand"
        );
      }

      if (
        side === "SELL" &&
        reaction ===
          "REJECTING_SUPPLY"
      ) {
        trigger += 12;

        reasons.push(
          "CMP rejecting supply"
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
      // EARLY M5 BREAK
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
      // TREND CONTINUATION
      // -------------------------------------------------------

      if (
        side === "BUY" &&
        (
          marketRegime ===
            "TRENDING_BULLISH" ||
          marketRegime ===
            "BREAKOUT_BULLISH"
        )
      ) {
        context += 10;

        reasons.push(
          "bullish continuation environment"
        );
      }

      if (
        side === "SELL" &&
        (
          marketRegime ===
            "TRENDING_BEARISH" ||
          marketRegime ===
            "BREAKOUT_BEARISH"
        )
      ) {
        context += 10;

        reasons.push(
          "bearish continuation environment"
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
          "bullish reversal condition"
        );
      }

      if (
        side === "SELL" &&
        marketRegime ===
          "REVERSAL_BEARISH"
      ) {
        trigger += 15;

        reasons.push(
          "bearish reversal condition"
        );
      }

      // -------------------------------------------------------
      // MOMENTUM
      // -------------------------------------------------------

      const lastM5 =
        M5[
          M5.length - 1
        ];

      const momentumBull =
        bullish(lastM5) &&
        bodyRatio(lastM5) >=
          0.45;

      const momentumBear =
        bearish(lastM5) &&
        bodyRatio(lastM5) >=
          0.45;

      if (
        side === "BUY" &&
        momentumBull
      ) {
        trigger += 6;

        reasons.push(
          "M5 bullish momentum"
        );
      }

      if (
        side === "SELL" &&
        momentumBear
      ) {
        trigger += 6;

        reasons.push(
          "M5 bearish momentum"
        );
      }

      // -------------------------------------------------------
      // TOTAL SCORE
      // -------------------------------------------------------

      const total =
        clamp(
          context +
          location +
          trigger +
          pattern +
          quality,
          0,
          100
        );

      // =======================================================
      // ACTIVE SCALP STATUS
      // =======================================================

      let status = "WAIT";

      const hasLocation =
        zoneDir === side ||
        cmpLocation.state ===
          "INSIDE_ZONE" ||
        (
          cmpLocation.state ===
            "APPROACHING_ZONE" &&
          zoneDir === side
        ) ||
        (
          cmpLocation.state ===
            "NEAR_ZONE" &&
          zoneDir === side
        );

      const hasLiquidityConfirmation =
        (
          side === "BUY" &&
          liquidityM5.bullish
        ) ||
        (
          side === "SELL" &&
          liquidityM5.bearish
        );

      const hasPatternConfirmation =
        (
          side === "BUY" &&
          (
            doubleM5.type ===
              "DOUBLE_BOTTOM" ||
            qmM5.type ===
              "QM_BUY"
          )
        ) ||
        (
          side === "SELL" &&
          (
            doubleM5.type ===
              "DOUBLE_TOP" ||
            qmM5.type ===
              "QM_SELL"
          )
        );

      const hasConfirmation =
        hasM5Trigger ||
        hasLiquidityConfirmation ||
        hasPatternConfirmation;

      const trendAligned =
        marketRegime ===
          (
            side === "BUY"
              ? "TRENDING_BULLISH"
              : "TRENDING_BEARISH"
          ) ||
        marketRegime ===
          (
            side === "BUY"
              ? "BREAKOUT_BULLISH"
              : "BREAKOUT_BEARISH"
          );

      // -------------------------------------------------------
      // SETUP
      // -------------------------------------------------------

      if (
        total >= 28 &&
        (
          hasLocation ||
          hasConfirmation ||
          trendAligned
        )
      ) {
        status = "SETUP";
      }

      // -------------------------------------------------------
      // READY
      // -------------------------------------------------------

      if (
        total >= 38 &&
        (
          (
            hasLocation &&
            hasConfirmation
          ) ||
          (
            trendAligned &&
            context >= 20
          )
        )
      ) {
        status = "READY";
      }

      // -------------------------------------------------------
      // SIGNAL ROUTE 1
      // M5 confirmation
      // -------------------------------------------------------

      if (
        total >= 45 &&
        hasM5Trigger &&
        (
          hasLocation ||
          context >= 20
        )
      ) {
        status = "SIGNAL";
      }

      // -------------------------------------------------------
      // SIGNAL ROUTE 2
      // TREND + MOMENTUM
      // -------------------------------------------------------

      if (
        total >= 48 &&
        trendAligned &&
        (
          hasM5Trigger ||
          momentumBull ||
          momentumBear ||
          hasLiquidityConfirmation
        ) &&
        context >= 20
      ) {
        status = "SIGNAL";
      }

      // -------------------------------------------------------
      // SIGNAL ROUTE 3
      // STRONG ZONE + CONFIRMATION
      // -------------------------------------------------------

      if (
        total >= 45 &&
        hasLocation &&
        hasConfirmation
      ) {
        status = "SIGNAL";
      }

      // -------------------------------------------------------
      // SIGNAL ROUTE 4
      // STRONG REVERSAL
      // -------------------------------------------------------

      if (
        total >= 50 &&
        (
          (
            side === "BUY" &&
            marketRegime ===
              "REVERSAL_BULLISH"
          ) ||
          (
            side === "SELL" &&
            marketRegime ===
              "REVERSAL_BEARISH"
          )
        ) &&
        (
          hasM5Trigger ||
          hasLiquidityConfirmation ||
          hasPatternConfirmation
        )
      ) {
        status = "SIGNAL";
      }

      return {
        side,
        status,
        score: total,
        contextScore: context,
        locationScore: location,
        triggerScore: trigger,
        patternScore: pattern,
        qualityScore: quality,

        m5Confirmed:
          hasM5Trigger,

        reasons: [
          ...new Set(
            reasons
          )
        ].slice(0, 10)
      };
    }

    const scalpBuy =
      scalpSide("BUY");

    const scalpSell =
      scalpSide("SELL");

    // =========================================================
    // INTRADAY ENGINE
    // SELECTIVE - UNCHANGED
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
        direction.H4 ===
          wanted &&
        direction.H1 ===
          wanted
      ) {
        status =
          "READY";
      }

      if (
        score >= 65 &&
        direction.H4 ===
          wanted &&
        direction.H1 ===
          wanted &&
        direction.M15 ===
          wanted &&
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
        ].slice(0, 10)
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
          score >=
          (
            isScalp
              ? 45
              : 65
          )
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
      scalpBuy.score >=
      scalpSell.score
        ? scalpBuy
        : scalpSell;

    const intraCandidate =
      intraBuy.score >=
      intraSell.score
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
      if (
        mode === "SCALPING"
      ) {
        if (
          m15Test.support &&
          earlyBreak.bearish
        ) {
          return "M15 SUPPORT UNDER TEST — M5 BROKE SUPPORT EARLY";
        }

        if (
          m15Test.resistance &&
          earlyBreak.bullish
        ) {
          return "M15 RESISTANCE UNDER TEST — M5 BROKE RESISTANCE EARLY";
        }

        if (
          m15Break.type.includes(
            "FORMING"
          )
        ) {
          return "M15 CANDLE NOT CLOSED — WAITING FOR CONFIRMATION";
        }

        if (
          cmpLocation.state ===
          "FAR_FROM_ZONE"
        ) {
          return "ZONE TOO FAR FROM CMP";
        }

        if (
          cmpLocation.state ===
          "APPROACHING_ZONE"
        ) {
          return `WAITING FOR CMP TO ENTER ${zoneDir} ZONE`;
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
          return `WAITING FOR M5 ${side} CONFIRMATION`;
        }

        if (
          m15Break.confirmed
        ) {
          return "WAITING FOR RETEST";
        }

        return `WAITING FOR ${side} SCALPING TRIGGER`;
      }

      // Intraday
      if (
        direction.H4 !==
        (
          side === "BUY"
            ? "BULLISH"
            : "BEARISH"
        )
      ) {
        return "WAITING FOR H4 ALIGNMENT";
      }

      if (
        direction.H1 !==
        (
          side === "BUY"
            ? "BULLISH"
            : "BEARISH"
        )
      ) {
        return "WAITING FOR H1 ALIGNMENT";
      }

      if (
        zoneDir !== side
      ) {
        return `WAITING FOR ${side} M15 ZONE`;
      }

      return `WAITING FOR M5 ${side} CONFIRMATION`;
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
    // PRIMARY SETUP
    // =========================================================

    let primarySetup =
      null;

    if (
      scalpingPlan
    ) {
      primarySetup = {
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
      };
    } else if (
      intradayPlan
    ) {
      primarySetup = {
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
      };
    }

    // =========================================================
    // SIGNAL COUNTER
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
          "PRO-2.0",

        mode:
          "ACTIVE SCALPING / SELECTIVE INTRADAY",

        timeframeFlow:
          "H4 → H1 → M15 → CMP → M5",

        signalStyle:
          "ACTIVE SCALPING / SELECTIVE INTRADAY"
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
                  cmpLocation.zone.quality
              }
            : null,

        distancePoints:
          cmpLocation.distancePoints
      },

      breakout: {
        M15:
          m15Break,

        M5EarlyBreak:
          earlyBreak,

        flip
      },

      patterns: {
        liquidityM5,
        liquidityM15,
        doubleM5,
        qmM5
      },

      confirmation: {
        M5Buy:
          m5Trigger.buy,

        M5Sell:
          m5Trigger.sell,

        strongest:
          m5Trigger.strongest
      },

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

      primarySetup,

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
