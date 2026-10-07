export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        status: "error",
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
      // GET CANDLES
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
      // GET ALL TIMEFRAMES
      // =========================
      const [h4, h1, m15, m5] =
        await Promise.all([
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
      // ROUND
      // =========================
      function roundPrice(value) {
        if (
          value === null ||
          value === undefined ||
          !Number.isFinite(Number(value))
        ) {
          return null;
        }

        return Number(
          Number(value).toFixed(2)
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

          const tr =
            Math.max(
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
          ) /
          recent.length
        );
      }

      // =========================
      // SWINGS
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
      // STRUCTURE
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
        } else if (bearish >= 2) {
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

        if (
          last > midpoint
        ) {
          return "BULLISH";
        }

        if (
          last < midpoint
        ) {
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

        return [
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
        ].slice(-30);
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
      // BREAKOUT / RETEST
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
            bearishRetest: false,
            rangeHigh: null,
            rangeLow: null
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
      // BEST PUNCA
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
        ).format(
          new Date()
        );
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

        if (
          start < end
        ) {
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

      // =========================
      // SESSION
      // =========================
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
      // DIRECTIONS
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
      // STRUCTURES
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
        ...findHistoricalLevels(
          h4
        ),

        ...findHistoricalLevels(
          h1
        ),

        ...findHistoricalLevels(
          m15
        )
      ];

      const levels =
        mergeLevels(
          allLevels
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
      // BREAKOUT
      // =========================
      const breakout =
        detectBreakoutRetest(
          m15
        );

      // =========================
      // CONFIRMATION
      // =========================
      const confirmation =
        getM5Confirmation(
          m5
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

      const atr =
        Math.max(
          atrH1,
          atrM15,
          atrM5
        );

      // =========================
      // BASE SCORE
      // =========================
      let buyScore = 0;
      let sellScore = 0;

      if (
        h4Direction ===
        "BULLISH"
      ) {
        buyScore += 30;
      }

      if (
        h4Direction ===
        "BEARISH"
      ) {
        sellScore += 30;
      }

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

      if (
        m15Direction ===
        "BULLISH"
      ) {
        buyScore += 15;
      }

      if (
        m15Direction ===
        "BEARISH"
      ) {
        sellScore += 15;
      }

      if (buyPunca) {
        buyScore += 15;
      }

      if (sellPunca) {
        sellScore += 15;
      }

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
      // SETUP SCORE
      // =========================
      let scalpingBuyScore = 0;
      let scalpingSellScore = 0;

      let intradayBuyScore = 0;
      let intradaySellScore = 0;

      // -------------------------
      // SCALPING
      // H1 → M15 → M5
      // -------------------------
      if (
        h1Direction ===
        "BULLISH"
      ) {
        scalpingBuyScore += 35;
      }

      if (
        h1Direction ===
        "BEARISH"
      ) {
        scalpingSellScore += 35;
      }

      if (
        m15Direction ===
        "BULLISH"
      ) {
        scalpingBuyScore += 30;
      }

      if (
        m15Direction ===
        "BEARISH"
      ) {
        scalpingSellScore += 30;
      }

      if (buyPunca) {
        scalpingBuyScore += 15;
      }

      if (sellPunca) {
        scalpingSellScore += 15;
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

      // -------------------------
      // INTRADAY
      // H4 → H1 → M15 → M5
      // -------------------------
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
      // SL BUILDER
      // =========================
      function buildTradePlan(
        direction,
        type
      ) {
        const isScalping =
          type === "SCALPING";

        const punca =
          direction === "BUY"
            ? buyPunca
            : sellPunca;

        const structure =
          direction === "BUY"
            ? (
                isScalping
                  ? m15Structure
                  : h1Structure
              )
            : (
                isScalping
                  ? m15Structure
                  : h1Structure
              );

        const swingHighs =
          structure.swingHighs ||
          [];

        const swingLows =
          structure.swingLows ||
          [];

        let sl = null;

        // =====================
        // BUY SL
        // =====================
        if (
          direction === "BUY"
        ) {
          const candidates =
            [];

          if (punca) {
            candidates.push(
              punca.price
            );
          }

          if (
            swingLows.length
          ) {
            candidates.push(
              Math.min(
                ...swingLows
              )
            );
          }

          const atrBuffer =
            isScalping
              ? Math.max(
                  atrM5 * 0.35,
                  0.80
                )
              : Math.max(
                  atrM15 * 0.30,
                  1.20
                );

          if (
            candidates.length
          ) {
            const support =
              Math.min(
                ...candidates
              );

            sl =
              support -
              atrBuffer;
          } else {
            sl =
              currentPrice -
              (
                isScalping
                  ? Math.max(
                      atrM5 * 1.5,
                      2.5
                    )
                  : Math.max(
                      atrM15 * 1.5,
                      5
                    )
              );
          }

          // SL mesti bawah Entry
          if (
            sl >= currentPrice
          ) {
            sl =
              currentPrice -
              (
                isScalping
                  ? Math.max(
                      atrM5 * 1.5,
                      2.5
                    )
                  : Math.max(
                      atrM15 * 1.5,
                      5
                    )
              );
          }
        }

        // =====================
        // SELL SL
        // =====================
        if (
          direction === "SELL"
        ) {
          const candidates =
            [];

          if (punca) {
            candidates.push(
              punca.price
            );
          }

          if (
            swingHighs.length
          ) {
            candidates.push(
              Math.max(
                ...swingHighs
              )
            );
          }

          const atrBuffer =
            isScalping
              ? Math.max(
                  atrM5 * 0.35,
                  0.80
                )
              : Math.max(
                  atrM15 * 0.30,
                  1.20
                );

          if (
            candidates.length
          ) {
            const resistance =
              Math.max(
                ...candidates
              );

            sl =
              resistance +
              atrBuffer;
          } else {
            sl =
              currentPrice +
              (
                isScalping
                  ? Math.max(
                      atrM5 * 1.5,
                      2.5
                    )
                  : Math.max(
                      atrM15 * 1.5,
                      5
                    )
              );
          }

          // SL mesti atas Entry
          if (
            sl <= currentPrice
          ) {
            sl =
              currentPrice +
              (
                isScalping
                  ? Math.max(
                      atrM5 * 1.5,
                      2.5
                    )
                  : Math.max(
                      atrM15 * 1.5,
                      5
                    )
              );
          }
        }

        const risk =
          Math.abs(
            sl -
            currentPrice
          );

        // =====================
        // VALID SL
        // =====================
        const minRisk =
          isScalping
            ? 1.5
            : 3;

        const maxRisk =
          isScalping
            ? Math.max(
                atrM15 * 2.5,
                8
              )
            : Math.max(
                atrH1 * 2.5,
                20
              );

        if (
          !Number.isFinite(risk) ||
          risk <= 0
        ) {
          return null;
        }

        // Kalau SL terlalu jauh,
        // setup tidak dikeluarkan.
        if (
          risk > maxRisk
        ) {
          return null;
        }

        // Minimum SL distance
        if (
          risk < minRisk
        ) {
          if (
            direction ===
            "BUY"
          ) {
            sl =
              currentPrice -
              minRisk;
          } else {
            sl =
              currentPrice +
              minRisk;
          }
        }

        const finalRisk =
          Math.abs(
            sl -
            currentPrice
          );

        // =====================
        // TP PIPS
        // XAUUSD 0.01 = 1 pip
        // =====================
        const tp1Pips =
          isScalping
            ? 60
            : 150;

        const tp2Pips =
          isScalping
            ? 120
            : 230;

        const tp1Distance =
          tp1Pips * 0.01;

        const tp2Distance =
          tp2Pips * 0.01;

        let tp1;
        let tp2;

        if (
          direction ===
          "BUY"
        ) {
          tp1 =
            currentPrice +
            tp1Distance;

          tp2 =
            currentPrice +
            tp2Distance;
        } else {
          tp1 =
            currentPrice -
            tp1Distance;

          tp2 =
            currentPrice -
            tp2Distance;
        }

        return {
          direction,
          entry:
            roundPrice(
              currentPrice
            ),

          sl:
            roundPrice(sl),

          tp1:
            roundPrice(tp1),

          tp2:
            roundPrice(tp2),

          risk:
            roundPrice(
              finalRisk
            ),

          tp1Pips,
          tp2Pips
        };
      }

      // =========================
      // BUILD SETUP
      // =========================
      function buildSetup(
        type,
        direction,
        score
      ) {
        const plan =
          buildTradePlan(
            direction,
            type
          );

        if (!plan) {
          return null;
        }

        const confirmed =
          confirmation.direction ===
          direction;

        const status =
          confirmed
            ? "SIGNAL"
            : "SETUP";

        let reason;

        if (
          confirmed
        ) {
          reason =
            confirmation.reason;
        } else {
          reason =
            direction === "SELL"
              ? "Bearish structure detected. Waiting for M5 confirmation."
              : "Bullish structure detected. Waiting for M5 confirmation.";
        }

        return {
          type,
          signalType: type,

          status,

          direction,

          score,

          entry:
            plan.entry,

          sl:
            plan.sl,

          tp1:
            plan.tp1,

          tp2:
            plan.tp2,

          risk:
            plan.risk,

          tp1Pips:
            plan.tp1Pips,

          tp2Pips:
            plan.tp2Pips,

          reason,

          confirmation:
            confirmed,

          confirmationReason:
            confirmation.reason
        };
      }

      // =========================
      // DETERMINE SETUPS
      // =========================
      let scalping = null;
      let intraday = null;

      // SCALPING BUY
      if (
        scalpingBuyScore >= 45 &&
        h1Direction !==
          "BEARISH" &&
        m15Direction !==
          "BEARISH"
      ) {
        scalping =
          buildSetup(
            "SCALPING",
            "BUY",
            scalpingBuyScore
          );
      }

      // SCALPING SELL
      if (
        scalpingSellScore >= 45 &&
        h1Direction !==
          "BULLISH" &&
        m15Direction !==
          "BULLISH" &&
        scalpingSellScore >
          scalpingBuyScore
      ) {
        scalping =
          buildSetup(
            "SCALPING",
            "SELL",
            scalpingSellScore
          );
      }

      // INTRADAY BUY
      if (
        intradayBuyScore >= 50 &&
        h4Direction !==
          "BEARISH" &&
        h1Direction !==
          "BEARISH" &&
        m15Direction !==
          "BEARISH"
      ) {
        intraday =
          buildSetup(
            "INTRADAY",
            "BUY",
            intradayBuyScore
          );
      }

      // INTRADAY SELL
      if (
        intradaySellScore >= 50 &&
        h4Direction !==
          "BULLISH" &&
        h1Direction !==
          "BULLISH" &&
        intradaySellScore >
          intradayBuyScore
      ) {
        intraday =
          buildSetup(
            "INTRADAY",
            "SELL",
            intradaySellScore
          );
      }

      // =========================
      // PRIMARY SETUP
      // =========================
      const availableSetups =
        [
          scalping,
          intraday
        ].filter(Boolean);

      const confirmedSetups =
        availableSetups.filter(
          setup =>
            setup.status ===
            "SIGNAL"
        );

      const setupCandidates =
        confirmedSetups.length
          ? confirmedSetups
          : availableSetups;

      setupCandidates.sort(
        (a, b) =>
          Number(b.score || 0) -
          Number(a.score || 0)
      );

      const primarySetup =
        setupCandidates[0] ||
        null;

      // =========================
      // MAIN SIGNAL
      // =========================
      let signal = "WAIT";
      let entry = null;
      let sl = null;
      let tp1 = null;
      let tp2 = null;
      let punca = null;
      let risk = null;

      if (
        primarySetup
      ) {
        signal =
          primarySetup.direction;

        entry =
          primarySetup.entry;

        sl =
          primarySetup.sl;

        tp1 =
          primarySetup.tp1;

        tp2 =
          primarySetup.tp2;

        risk =
          primarySetup.risk;

        punca =
          primarySetup.direction ===
          "BUY"
            ? buyPunca
            : sellPunca;
      } else {

        // Fallback hanya jika
        // memang ada confirmation
        const confirmedDirection =
          confirmation.direction;

        if (
          confirmedDirection ===
          "BUY" &&
          buyScore >= 60
        ) {
          const plan =
            buildTradePlan(
              "BUY",
              "INTRADAY"
            );

          if (plan) {
            signal = "BUY";
            entry =
              plan.entry;
            sl =
              plan.sl;
            tp1 =
              plan.tp1;
            tp2 =
              plan.tp2;
            risk =
              plan.risk;
            punca =
              buyPunca;
          }
        }

        if (
          confirmedDirection ===
          "SELL" &&
          sellScore >= 60
        ) {
          const plan =
            buildTradePlan(
              "SELL",
              "INTRADAY"
            );

          if (plan) {
            signal = "SELL";
            entry =
              plan.entry;
            sl =
              plan.sl;
            tp1 =
              plan.tp1;
            tp2 =
              plan.tp2;
            risk =
              plan.risk;
            punca =
              sellPunca;
          }
        }
      }

      // =========================
      // WAIT REASON
      // =========================
      let waitReason =
        null;

      if (
        signal === "WAIT"
      ) {
        if (
          sellScore >
          buyScore
        ) {
          waitReason =
            "Bearish bias detected but no valid trade plan.";
        } else if (
          buyScore >
          sellScore
        ) {
          waitReason =
            "Bullish bias detected but no valid trade plan.";
        } else {
          waitReason =
            "No valid scalping or intraday setup.";
        }
      }

      // =========================
      // RESULT
      // =========================
      const result = {
        status: "success",

        symbol: "XAUUSD",

        signal,

        signalStatus:
          primarySetup
            ? primarySetup.status
            : "WAIT",

        signalType:
          primarySetup
            ? primarySetup.type
            : null,

        currentPrice:
          roundPrice(
            currentPrice
          ),

        session,

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

        structure: {
          H4:
            h4Structure,

          H1:
            h1Structure,

          M15:
            m15Structure
        },

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

        confirmation,

        punca,

        scores: {
          BUY:
            buyScore,

          SELL:
            sellScore,

          scalpingBuy:
            scalpingBuyScore,

          scalpingSell:
            scalpingSellScore,

          intradayBuy:
            intradayBuyScore,

          intradaySell:
            intradaySellScore
        },

        entry:
          roundPrice(entry),

        sl:
          roundPrice(sl),

        SL:
          roundPrice(sl),

        tp1:
          roundPrice(tp1),

        TP1:
          roundPrice(tp1),

        tp2:
          roundPrice(tp2),

        TP2:
          roundPrice(tp2),

        risk:
          roundPrice(risk),

        maxAllowedRisk:
          primarySetup
            ? primarySetup.type ===
              "SCALPING"
              ? roundPrice(
                  Math.max(
                    atrM15 * 2.5,
                    8
                  )
                )
              : roundPrice(
                  Math.max(
                    atrH1 * 2.5,
                    20
                  )
                )
            : null,

        waitReason,

        // =====================
        // SCALPING
        // =====================
        scalping,

        // =====================
        // INTRADAY
        // =====================
        intraday,

        // =====================
        // PRIMARY SETUP
        // =====================
        primarySetup,

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

        engine: {
          timeframes: [
            "H4",
            "H1",
            "M15",
            "M5"
          ],

          sessions: [
            "ASIA / TOKYO",
            "LONDON",
            "NEW YORK",
            "LONDON + NEW YORK OVERLAP"
          ],

          data: "OHLC",

          method:
            "Market Structure + S/R + Breakout Retest + Scalping + Intraday Setup Engine + M5 Confirmation"
        },

        cached: false,

        timestamp:
          new Date().toISOString()
      };

      // =========================
      // CACHE
      // =========================
      globalThis.sinnciAnalysisCache = {
        data: result,
        time: Date.now()
      };

      return res
        .status(200)
        .json(result);

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
