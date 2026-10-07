export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "API key not configured"
      });
    }

    // =========================
    // CACHE
    // =========================
    const CACHE_TTL = 90 * 1000;

    if (!globalThis.sinnciAnalysisCache) {
      globalThis.sinnciAnalysisCache = {
        data: null,
        time: 0
      };
    }

    if (
      globalThis.sinnciAnalysisCache.data &&
      Date.now() - globalThis.sinnciAnalysisCache.time < CACHE_TTL
    ) {
      return res.status(200).json({
        ...globalThis.sinnciAnalysisCache.data,
        cached: true
      });
    }

    // =========================
    // LOCK
    // =========================
    if (globalThis.sinnciAnalysisLock) {
      return await globalThis.sinnciAnalysisLock;
    }

    globalThis.sinnciAnalysisLock = (async () => {

      // =========================
      // TIMEFRAMES
      // =========================
      const TF = {
        H4: "4h",
        H1: "1h",
        M15: "15min",
        M5: "5min"
      };

      // =========================
      // GET OHLC DATA
      // =========================
      async function getCandles(interval) {
        const url =
          `https://api.twelvedata.com/time_series` +
          `?symbol=XAU/USD` +
          `&interval=${interval}` +
          `&outputsize=80` +
          `&apikey=${API_KEY}`;

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(
            `Twelve Data HTTP ${response.status}`
          );
        }

        const data = await response.json();

        if (data.status === "error") {
          throw new Error(
            data.message || "Twelve Data error"
          );
        }

        if (
          !data.values ||
          !Array.isArray(data.values)
        ) {
          throw new Error(
            "No candle data received"
          );
        }

        return data.values
          .reverse()
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

      // =========================
      // FETCH ALL TF IN PARALLEL
      // =========================
      const [h4, h1, m15, m5] = await Promise.all([
        getCandles(TF.H4),
        getCandles(TF.H1),
        getCandles(TF.M15),
        getCandles(TF.M5)
      ]);

      if (
        h4.length < 30 ||
        h1.length < 30 ||
        m15.length < 30 ||
        m5.length < 30
      ) {
        throw new Error(
          "Insufficient candle data"
        );
      }

      // =========================
      // ATR
      // =========================
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
          let i = 1;
          i < candles.length;
          i++
        ) {
          const current =
            candles[i];

          const previous =
            candles[i - 1];

          const tr = Math.max(
            current.high -
              current.low,

            Math.abs(
              current.high -
              previous.close
            ),

            Math.abs(
              current.low -
              previous.close
            )
          );

          trs.push(tr);
        }

        const recent =
          trs.slice(-period);

        return (
          recent.reduce(
            (sum, value) =>
              sum + value,
            0
          ) / recent.length
        );
      }

      // =========================
      // SWING HIGH / LOW
      // =========================
      function findSwings(
        candles,
        strength = 2
      ) {
        const highs = [];
        const lows = [];

        for (
          let i = strength;
          i <
          candles.length - strength;
          i++
        ) {
          const current =
            candles[i];

          let swingHigh = true;
          let swingLow = true;

          for (
            let j = 1;
            j <= strength;
            j++
          ) {
            if (
              current.high <=
                candles[i - j].high ||
              current.high <=
                candles[i + j].high
            ) {
              swingHigh = false;
            }

            if (
              current.low >=
                candles[i - j].low ||
              current.low >=
                candles[i + j].low
            ) {
              swingLow = false;
            }
          }

          if (swingHigh) {
            highs.push({
              index: i,
              price: current.high,
              type: "HIGH"
            });
          }

          if (swingLow) {
            lows.push({
              index: i,
              price: current.low,
              type: "LOW"
            });
          }
        }

        return {
          highs,
          lows
        };
      }

      // =========================
      // MARKET STRUCTURE
      // =========================
      function getStructure(
        candles
      ) {
        const swings =
          findSwings(
            candles,
            2
          );

        const highs =
          swings.highs.slice(-4);

        const lows =
          swings.lows.slice(-4);

        let bullish = 0;
        let bearish = 0;

        if (highs.length >= 2) {
          const h1 =
            highs[
              highs.length - 2
            ].price;

          const h2 =
            highs[
              highs.length - 1
            ].price;

          if (h2 > h1) {
            bullish++;
          }

          if (h2 < h1) {
            bearish++;
          }
        }

        if (lows.length >= 2) {
          const l1 =
            lows[
              lows.length - 2
            ].price;

          const l2 =
            lows[
              lows.length - 1
            ].price;

          if (l2 > l1) {
            bullish++;
          }

          if (l2 < l1) {
            bearish++;
          }
        }

        let direction =
          "NEUTRAL";

        let pattern =
          "MIXED";

        if (bullish >= 2) {
          direction =
            "BULLISH";

          pattern =
            "HH_HL";
        } else if (
          bearish >= 2
        ) {
          direction =
            "BEARISH";

          pattern =
            "LH_LL";
        } else if (
          bullish > bearish
        ) {
          direction =
            "BULLISH";

          pattern =
            "PARTIAL_BULLISH";
        } else if (
          bearish > bullish
        ) {
          direction =
            "BEARISH";

          pattern =
            "PARTIAL_BEARISH";
        }

        return {
          direction,
          pattern,

          swingHighs:
            highs.map(
              x => x.price
            ),

          swingLows:
            lows.map(
              x => x.price
            )
        };
      }

      // =========================
      // DIRECTION
      // =========================
      function getDirection(
        candles
      ) {
        const structure =
          getStructure(
            candles
          );

        const recent =
          candles.slice(-12);

        const high =
          Math.max(
            ...recent.map(
              c => c.high
            )
          );

        const low =
          Math.min(
            ...recent.map(
              c => c.low
            )
          );

        const last =
          candles[
            candles.length - 1
          ].close;

        const midpoint =
          (high + low) / 2;

        if (
          structure.direction ===
            "BULLISH" &&
          last >= midpoint
        ) {
          return "BULLISH";
        }

        if (
          structure.direction ===
            "BEARISH" &&
          last <= midpoint
        ) {
          return "BEARISH";
        }

        if (last > midpoint) {
          return "BULLISH";
        }

        if (last < midpoint) {
          return "BEARISH";
        }

        return "NEUTRAL";
      }

      // =========================
      // HISTORICAL LEVELS
      // =========================
      function findHistoricalLevels(
        candles
      ) {
        const swings =
          findSwings(
            candles,
            2
          );

        const levels = [
          ...swings.highs.map(
            x => ({
              price: x.price,
              type: "RESISTANCE"
            })
          ),

          ...swings.lows.map(
            x => ({
              price: x.price,
              type: "SUPPORT"
            })
          )
        ];

        return levels.slice(-30);
      }

      // =========================
      // MERGE LEVELS
      // =========================
      function mergeLevels(
        levels,
        tolerance = 2.5
      ) {
        const sorted =
          [...levels].sort(
            (a, b) =>
              a.price - b.price
          );

        const merged = [];

        for (
          const level of sorted
        ) {
          const existing =
            merged.find(
              x =>
                Math.abs(
                  x.price -
                    level.price
                ) <= tolerance
            );

          if (existing) {
            existing.price =
              (
                existing.price +
                level.price
              ) / 2;

            existing.touches++;
          } else {
            merged.push({
              price:
                level.price,

              type:
                level.type,

              touches: 1
            });
          }
        }

        return merged;
      }

      // =========================
      // BREAKOUT + RETEST
      // =========================
      function detectBreakoutRetest(
        candles
      ) {
        if (
          candles.length < 20
        ) {
          return {
            bullishBreakout: false,
            bearishBreakout: false,
            bullishRetest: false,
            bearishRetest: false
          };
        }

        const recent =
          candles.slice(
            -15,
            -3
          );

        const rangeHigh =
          Math.max(
            ...recent.map(
              c => c.high
            )
          );

        const rangeLow =
          Math.min(
            ...recent.map(
              c => c.low
            )
          );

        const last =
          candles[
            candles.length - 1
          ];

        const previous =
          candles[
            candles.length - 2
          ];

        const bullishBreakout =
          previous.close <=
            rangeHigh &&
          last.close >
            rangeHigh;

        const bearishBreakout =
          previous.close >=
            rangeLow &&
          last.close <
            rangeLow;

        const bullishRetest =
          last.low <=
            rangeHigh &&
          last.close >
            rangeHigh;

        const bearishRetest =
          last.high >=
            rangeLow &&
          last.close <
            rangeLow;

        return {
          bullishBreakout,
          bearishBreakout,
          bullishRetest,
          bearishRetest,
          rangeHigh,
          rangeLow
        };
      }

      // =========================
      // BEST PUNCA / ZONE
      // =========================
      function findBestPunca(
        levels,
        currentPrice,
        side
      ) {
        const suitable =
          levels.filter(
            level => {
              if (
                side === "BUY"
              ) {
                return (
                  level.price <=
                  currentPrice
                );
              }

              if (
                side === "SELL"
              ) {
                return (
                  level.price >=
                  currentPrice
                );
              }

              return true;
            }
          );

        if (
          !suitable.length
        ) {
          return null;
        }

        suitable.sort(
          (a, b) =>
            Math.abs(
              a.price -
                currentPrice
            ) -
            Math.abs(
              b.price -
                currentPrice
            )
        );

        const best =
          suitable[0];

        const distance =
          Math.abs(
            best.price -
              currentPrice
          );

        // Wider than old 80
        // to allow more setups
        if (
          distance > 120
        ) {
          return null;
        }

        return {
          price:
            best.price,

          type:
            best.type,

          distance
        };
      }

      // =========================
      // M5 CONFIRMATION
      // =========================
      function getM5Confirmation(
        candles
      ) {
        const last =
          candles[
            candles.length - 1
          ];

        const previous =
          candles[
            candles.length - 2
          ];

        const body =
          Math.abs(
            last.close -
              last.open
          );

        const range =
          last.high -
          last.low;

        const upperWick =
          last.high -
          Math.max(
            last.open,
            last.close
          );

        const lowerWick =
          Math.min(
            last.open,
            last.close
          ) -
          last.low;

        const bullishEngulfing =
          previous.close <
            previous.open &&
          last.close >
            last.open &&
          last.open <=
            previous.close &&
          last.close >=
            previous.open;

        const bearishEngulfing =
          previous.close >
            previous.open &&
          last.close <
            last.open &&
          last.open >=
            previous.close &&
          last.close <=
            previous.open;

        const bullishRejection =
          lowerWick >
            body * 1.5 &&
          last.close >
            last.open;

        const bearishRejection =
          upperWick >
            body * 1.5 &&
          last.close <
            last.open;

        const strongBullish =
          range > 0 &&
          body / range >=
            0.65 &&
          last.close >
            last.open;

        const strongBearish =
          range > 0 &&
          body / range >=
            0.65 &&
          last.close <
            last.open;

        let direction =
          "NONE";

        let reason =
          "NO_CONFIRMATION";

        if (
          bullishEngulfing ||
          bullishRejection ||
          strongBullish
        ) {
          direction =
            "BUY";

          if (
            bullishEngulfing
          ) {
            reason =
              "BULLISH_ENGULFING";
          } else if (
            bullishRejection
          ) {
            reason =
              "BULLISH_REJECTION";
          } else {
            reason =
              "STRONG_BULLISH_CANDLE";
          }
        }

        if (
          bearishEngulfing ||
          bearishRejection ||
          strongBearish
        ) {
          direction =
            "SELL";

          if (
            bearishEngulfing
          ) {
            reason =
              "BEARISH_ENGULFING";
          } else if (
            bearishRejection
          ) {
            reason =
              "BEARISH_REJECTION";
          } else {
            reason =
              "STRONG_BEARISH_CANDLE";
          }
        }

        return {
          direction,
          reason,

          bullishEngulfing,
          bearishEngulfing,

          bullishRejection,
          bearishRejection,

          strongBullish,
          strongBearish
        };
      }

      // =========================
      // SESSION ENGINE
      // =========================
      function getLocalTime(
        timeZone
      ) {
        return new Intl.DateTimeFormat(
          "en-GB",
          {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          }
        ).format(new Date());
      }

      function getLocalMinutes(
        timeZone
      ) {
        const parts =
          new Intl.DateTimeFormat(
            "en-GB",
            {
              timeZone,
              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            }
          ).formatToParts(
            new Date()
          );

        const hour =
          Number(
            parts.find(
              p =>
                p.type ===
                "hour"
            )?.value
          );

        const minute =
          Number(
            parts.find(
              p =>
                p.type ===
                "minute"
            )?.value
          );

        return (
          hour * 60 +
          minute
        );
      }

      function isWithinSession(
        timeZone,
        startHour,
        endHour
      ) {
        const minutes =
          getLocalMinutes(
            timeZone
          );

        const start =
          startHour * 60;

        const end =
          endHour * 60;

        if (start < end) {
          return (
            minutes >= start &&
            minutes < end
          );
        }

        return (
          minutes >= start ||
          minutes < end
        );
      }

      function getForexSessions() {
        const now =
          new Date();

        const asiaOpen =
          isWithinSession(
            "Asia/Tokyo",
            9,
            18
          );

        const londonOpen =
          isWithinSession(
            "Europe/London",
            8,
            17
          );

        const newYorkOpen =
          isWithinSession(
            "America/New_York",
            8,
            17
          );

        const londonNYOverlap =
          londonOpen &&
          newYorkOpen;

        const malaysiaTime =
          new Intl.DateTimeFormat(
            "en-GB",
            {
              timeZone:
                "Asia/Kuala_Lumpur",
              dateStyle:
                "short",
              timeStyle:
                "medium",
              hour12: false
            }
          ).format(now);

        let activity =
          "LOW";

        let activeSession =
          "NONE";

        if (
          londonNYOverlap
        ) {
          activity =
            "VERY_HIGH";

          activeSession =
            "LONDON + NEW YORK";
        } else if (
          londonOpen
        ) {
          activity =
            "HIGH";

          activeSession =
            "LONDON";
        } else if (
          newYorkOpen
        ) {
          activity =
            "HIGH";

          activeSession =
            "NEW YORK";
        } else if (
          asiaOpen
        ) {
          activity =
            "MODERATE";

          activeSession =
            "ASIA / TOKYO";
        }

        return {
          timezone:
            "Asia/Kuala_Lumpur",

          malaysiaTime,

          Asia: {
            status:
              asiaOpen
                ? "OPEN"
                : "CLOSED",

            localTime:
              getLocalTime(
                "Asia/Tokyo"
              )
          },

          London: {
            status:
              londonOpen
                ? "OPEN"
                : "CLOSED",

            localTime:
              getLocalTime(
                "Europe/London"
              )
          },

          NewYork: {
            status:
              newYorkOpen
                ? "OPEN"
                : "CLOSED",

            localTime:
              getLocalTime(
                "America/New_York"
              )
          },

          LondonNewYorkOverlap: {
            status:
              londonNYOverlap
                ? "ACTIVE"
                : "INACTIVE"
          },

          activeSession,
          activity
        };
      }

      const session =
        getForexSessions();

      // =========================
      // CURRENT PRICE
      // =========================
      const currentPrice =
        m5[
          m5.length - 1
        ].close;

      // =========================
      // DIRECTION
      // =========================
      const h4Direction =
        getDirection(h4);

      const h1Direction =
        getDirection(h1);

      const m15Direction =
        getDirection(m15);

      const m5Direction =
        getDirection(m5);

      // =========================
      // STRUCTURE
      // =========================
      const h4Structure =
        getStructure(h4);

      const h1Structure =
        getStructure(h1);

      const m15Structure =
        getStructure(m15);

      // =========================
      // LEVELS
      // =========================
      const allLevels = [
        ...findHistoricalLevels(h4),
        ...findHistoricalLevels(h1),
        ...findHistoricalLevels(m15)
      ];

      const levels =
        mergeLevels(
          allLevels
        );

      // =========================
      // CONFIRMATION
      // =========================
      const confirmation =
        getM5Confirmation(
          m5
        );

      // =========================
      // BREAKOUT
      // =========================
      const breakout =
        detectBreakoutRetest(
          m15
        );

      // =========================
      // PUNCA
      // =========================
      const buyPunca =
        findBestPunca(
          levels,
          currentPrice,
          "BUY"
        );

      const sellPunca =
        findBestPunca(
          levels,
          currentPrice,
          "SELL"
        );

      // =========================
      // ATR
      // =========================
      const atrH4 =
        calculateATR(h4);

      const atrH1 =
        calculateATR(h1);

      const atrM15 =
        calculateATR(m15);

      const atrM5 =
        calculateATR(m5);

      // =========================
      // BASE SCORE
      // =========================
      let buyScore = 0;
      let sellScore = 0;

      // H4
      if (
        h4Direction ===
        "BULLISH"
      ) {
        buyScore += 20;
      }

      if (
        h4Direction ===
        "BEARISH"
      ) {
        sellScore += 20;
      }

      // H1
      if (
        h1Direction ===
        "BULLISH"
      ) {
        buyScore += 25;
      }

      if (
        h1Direction ===
        "BEARISH"
      ) {
        sellScore += 25;
      }

      // M15
      if (
        m15Direction ===
        "BULLISH"
      ) {
        buyScore += 20;
      }

      if (
        m15Direction ===
        "BEARISH"
      ) {
        sellScore += 20;
      }

      // M5
      if (
        m5Direction ===
        "BULLISH"
      ) {
        buyScore += 10;
      }

      if (
        m5Direction ===
        "BEARISH"
      ) {
        sellScore += 10;
      }

      // PUNCA
      if (buyPunca) {
        buyScore += 10;
      }

      if (sellPunca) {
        sellScore += 10;
      }

      // BREAKOUT
      if (
        breakout.bullishBreakout ||
        breakout.bullishRetest
      ) {
        buyScore += 10;
      }

      if (
        breakout.bearishBreakout ||
        breakout.bearishRetest
      ) {
        sellScore += 10;
      }

      // CONFIRMATION
      if (
        confirmation.direction ===
        "BUY"
      ) {
        buyScore += 15;
      }

      if (
        confirmation.direction ===
        "SELL"
      ) {
        sellScore += 15;
      }

      // =========================
      // SCALPING SCORE
      // H1 + M15 + M5
      // =========================
      let scalpingBuyScore = 0;
      let scalpingSellScore = 0;

      if (
        h1Direction ===
        "BULLISH"
      ) {
        scalpingBuyScore += 30;
      }

      if (
        h1Direction ===
        "BEARISH"
      ) {
        scalpingSellScore += 30;
      }

      if (
        m15Direction ===
        "BULLISH"
      ) {
        scalpingBuyScore += 25;
      }

      if (
        m15Direction ===
        "BEARISH"
      ) {
        scalpingSellScore += 25;
      }

      if (
        m5Direction ===
        "BULLISH"
      ) {
        scalpingBuyScore += 15;
      }

      if (
        m5Direction ===
        "BEARISH"
      ) {
        scalpingSellScore += 15;
      }

      if (buyPunca) {
        scalpingBuyScore += 10;
      }

      if (sellPunca) {
        scalpingSellScore += 10;
      }

      if (
        breakout.bullishBreakout ||
        breakout.bullishRetest
      ) {
        scalpingBuyScore += 10;
      }

      if (
        breakout.bearishBreakout ||
        breakout.bearishRetest
      ) {
        scalpingSellScore += 10;
      }

      if (
        confirmation.direction ===
        "BUY"
      ) {
        scalpingBuyScore += 15;
      }

      if (
        confirmation.direction ===
        "SELL"
      ) {
        scalpingSellScore += 15;
      }

      // =========================
      // INTRADAY SCORE
      // H4 + H1 + M15 + M5
      // =========================
      let intradayBuyScore = 0;
      let intradaySellScore = 0;

      if (
        h4Direction ===
        "BULLISH"
      ) {
        intradayBuyScore += 30;
      }

      if (
        h4Direction ===
        "BEARISH"
      ) {
        intradaySellScore += 30;
      }

      if (
        h1Direction ===
        "BULLISH"
      ) {
        intradayBuyScore += 25;
      }

      if (
        h1Direction ===
        "BEARISH"
      ) {
        intradaySellScore += 25;
      }

      if (
        m15Direction ===
        "BULLISH"
      ) {
        intradayBuyScore += 20;
      }

      if (
        m15Direction ===
        "BEARISH"
      ) {
        intradaySellScore += 20;
      }

      if (
        m5Direction ===
        "BULLISH"
      ) {
        intradayBuyScore += 10;
      }

      if (
        m5Direction ===
        "BEARISH"
      ) {
        intradaySellScore += 10;
      }

      if (buyPunca) {
        intradayBuyScore += 10;
      }

      if (sellPunca) {
        intradaySellScore += 10;
      }

      if (
        breakout.bullishBreakout ||
        breakout.bullishRetest
      ) {
        intradayBuyScore += 10;
      }

      if (
        breakout.bearishBreakout ||
        breakout.bearishRetest
      ) {
        intradaySellScore += 10;
      }

      if (
        confirmation.direction ===
        "BUY"
      ) {
        intradayBuyScore += 15;
      }

      if (
        confirmation.direction ===
        "SELL"
      ) {
        intradaySellScore += 15;
      }

      // =========================
      // SETUP DIRECTION
      // =========================
      let scalpingDirection =
        "WAIT";

      if (
        scalpingBuyScore >= 45 &&
        scalpingBuyScore >
          scalpingSellScore
      ) {
        scalpingDirection =
          "BUY";
      }

      if (
        scalpingSellScore >= 45 &&
        scalpingSellScore >
          scalpingBuyScore
      ) {
        scalpingDirection =
          "SELL";
      }

      let intradayDirection =
        "WAIT";

      if (
        intradayBuyScore >= 50 &&
        intradayBuyScore >
          intradaySellScore
      ) {
        intradayDirection =
          "BUY";
      }

      if (
        intradaySellScore >= 50 &&
        intradaySellScore >
          intradayBuyScore
      ) {
        intradayDirection =
          "SELL";
      }

      // =========================
      // SETUP OBJECTS
      // =========================
      const pipSize =
        0.01;

      function buildSetup(
        type,
        direction
      ) {
        if (
          direction !== "BUY" &&
          direction !== "SELL"
        ) {
          return {
            type,
            status: "WAIT",
            direction: "WAIT",
            entry: null,
            SL: null,
            TP1: null,
            TP2: null,
            score: 0
          };
        }

        const isScalping =
          type ===
          "SCALPING";

        const selectedPunca =
          direction === "BUY"
            ? buyPunca
            : sellPunca;

        const selectedScore =
          isScalping
            ? direction === "BUY"
              ? scalpingBuyScore
              : scalpingSellScore
            : direction === "BUY"
              ? intradayBuyScore
              : intradaySellScore;

        const selectedATR =
          isScalping
            ? Math.max(
                atrM15,
                atrM5
              )
            : Math.max(
                atrH1,
                atrM15
              );

        const entry =
          currentPrice;

        // Dynamic SL
        const minimumRisk =
          isScalping
            ? 35 * pipSize
            : 80 * pipSize;

        const atrRisk =
          selectedATR > 0
            ? selectedATR *
              (isScalping
                ? 0.7
                : 0.9)
            : minimumRisk;

        const zoneRisk =
          selectedPunca
            ? Math.abs(
                entry -
                  selectedPunca.price
              ) * 0.5
            : 0;

        const risk = Math.max(
          minimumRisk,
          atrRisk,
          zoneRisk
        );

        let sl;
        let tp1;
        let tp2;

        if (
          direction === "BUY"
        ) {
          sl =
            entry - risk;

          tp1 =
            entry +
            (isScalping
              ? 60 * pipSize
              : 150 * pipSize);

          tp2 =
            entry +
            (isScalping
              ? 120 * pipSize
              : 230 * pipSize);
        } else {
          sl =
            entry + risk;

          tp1 =
            entry -
            (isScalping
              ? 60 * pipSize
              : 150 * pipSize);

          tp2 =
            entry -
            (isScalping
              ? 120 * pipSize
              : 230 * pipSize);
        }

        const confirmed =
          confirmation.direction ===
          direction;

        return {
          type,

          status:
            confirmed
              ? "SIGNAL"
              : "SETUP",

          direction,

          entry:
            roundPrice(entry),

          SL:
            roundPrice(sl),

          TP1:
            roundPrice(tp1),

          TP2:
            roundPrice(tp2),

          risk:
            roundPrice(risk),

          score:
            selectedScore,

          confirmation:
            confirmed,

          confirmationReason:
            confirmation.reason,

          punca:
            selectedPunca,

          timeframe:
            isScalping
              ? "H1 → M15 → M5"
              : "H4 → H1 → M15 → M5",

          target:
            isScalping
              ? "60 / 120 pips"
              : "150 / 230 pips"
        };
      }

      // =========================
      // BUILD SETUPS
      // =========================
      const scalpingSetup =
        buildSetup(
          "SCALPING",
          scalpingDirection
        );

      const intradaySetup =
        buildSetup(
          "INTRADAY",
          intradayDirection
        );

      // =========================
      // PRIMARY SIGNAL
      // =========================
      let signal =
        "WAIT";

      let signalType =
        "NONE";

      let primarySetup =
        null;

      const scalpingSignal =
        scalpingSetup.status ===
        "SIGNAL";

      const intradaySignal =
        intradaySetup.status ===
        "SIGNAL";

      if (
        scalpingSignal &&
        intradaySignal
      ) {
        if (
          scalpingSetup.score >=
          intradaySetup.score
        ) {
          primarySetup =
            scalpingSetup;
        } else {
          primarySetup =
            intradaySetup;
        }
      } else if (
        scalpingSignal
      ) {
        primarySetup =
          scalpingSetup;
      } else if (
        intradaySignal
      ) {
        primarySetup =
          intradaySetup;
      }

      if (primarySetup) {
        signal =
          primarySetup.direction;

        signalType =
          primarySetup.type;
      }

      // =========================
      // FALLBACK SETUP
      // =========================
      if (
        signal === "WAIT"
      ) {
        if (
          scalpingSetup.status ===
          "SETUP"
        ) {
          primarySetup =
            scalpingSetup;
        } else if (
          intradaySetup.status ===
          "SETUP"
        ) {
          primarySetup =
            intradaySetup;
        }
      }

      // =========================
      // ROUND PRICE
      // =========================
      function roundPrice(
        value
      ) {
        if (
          value === null ||
          value === undefined
        ) {
          return null;
        }

        return Number(
          value.toFixed(2)
        );
      }

      // =========================
      // RESULT
      // =========================
      const result = {
        status:
          "success",

        symbol:
          "XAUUSD",

        signal,

        signalType,

        currentPrice:
          roundPrice(
            currentPrice
          ),

        // =========================
        // SESSION
        // =========================
        session,

        // =========================
        // DIRECTION
        // =========================
        direction: {
          H4:
            h4Direction,

          H1:
            h1Direction,

          M15:
            m15Direction,

          M5:
            m5Direction
        },

        // =========================
        // STRUCTURE
        // =========================
        structure: {
          H4:
            h4Structure,

          H1:
            h1Structure,

          M15:
            m15Structure
        },

        // =========================
        // BREAKOUT
        // =========================
        breakout: {
          bullishBreakout:
            breakout.bullishBreakout,

          bearishBreakout:
            breakout.bearishBreakout,

          bullishRetest:
            breakout.bullishRetest,

          bearishRetest:
            breakout.bearishRetest,

          rangeHigh:
            roundPrice(
              breakout.rangeHigh
            ),

          rangeLow:
            roundPrice(
              breakout.rangeLow
            )
        },

        // =========================
        // CONFIRMATION
        // =========================
        confirmation,

        // =========================
        // PUNCA
        // =========================
        punca:
          primarySetup?.punca ||
          null,

        // =========================
        // ALL SCORES
        // =========================
        scores: {
          BUY:
            buyScore,

          SELL:
            sellScore,

          SCALPING_BUY:
            scalpingBuyScore,

          SCALPING_SELL:
            scalpingSellScore,

          INTRADAY_BUY:
            intradayBuyScore,

          INTRADAY_SELL:
            intradaySellScore
        },

        // =========================
        // PRIMARY ENTRY
        // =========================
        entry:
          primarySetup?.entry ||
          null,

        SL:
          primarySetup?.SL ||
          null,

        TP1:
          primarySetup?.TP1 ||
          null,

        TP2:
          primarySetup?.TP2 ||
          null,

        risk:
          primarySetup?.risk ||
          null,

        // =========================
        // SCALPING
        // =========================
        scalping:
          scalpingSetup,

        // =========================
        // INTRADAY
        // =========================
        intraday:
          intradaySetup,

        // =========================
        // ATR
        // =========================
        ATR: {
          H4:
            roundPrice(
              atrH4
            ),

          H1:
            roundPrice(
              atrH1
            ),

          M15:
            roundPrice(
              atrM15
            ),

          M5:
            roundPrice(
              atrM5
            )
        },

        // =========================
        // CANDLES
        // =========================
        candles: {
          H4:
            h4.length,

          H1:
            h1.length,

          M15:
            m15.length,

          M5:
            m5.length
        },

        // =========================
        // ENGINE
        // =========================
        engine: {
          timeframes: [
            "H4",
            "H1",
            "M15",
            "M5"
          ],

          setups: [
            "SCALPING",
            "INTRADAY"
          ],

          scalping:
            "H1 + M15 + M5",

          intraday:
            "H4 + H1 + M15 + M5",

          sessions: [
            "ASIA / TOKYO",
            "LONDON",
            "NEW YORK",
            "LONDON + NEW YORK OVERLAP"
          ],

          data:
            "OHLC",

          method:
            "Market Structure + S/R + Breakout Retest + M5 Confirmation + Scalping + Intraday Setup Engine"
        },

        cached:
          false,

        timestamp:
          new Date().toISOString()
      };

      // =========================
      // SAVE CACHE
      // =========================
      globalThis.sinnciAnalysisCache = {
        data: result,
        time: Date.now()
      };

      return res.status(200).json(
        result
      );

    })();

    try {
      return await globalThis.sinnciAnalysisLock;
    } finally {
      globalThis.sinnciAnalysisLock =
        null;
    }

  } catch (error) {
    console.error(
      "SINNCI ANALYZE ERROR:",
      error
    );

    return res.status(500).json({
      status: "error",
      error:
        error.message ||
        "Analysis failed"
    });
  }
    }
