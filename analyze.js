export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "Twelve Data API key not configured"
      });
    }

    const timeframes = {
      H4: "4h",
      H1: "1h",
      M30: "30min",
      M15: "15min",
      M5: "5min"
    };

    const market = {};

    for (const [name, interval] of Object.entries(timeframes)) {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=XAU/USD` +
        `&interval=${interval}` +
        `&outputsize=50` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status === "error") {
        return res.status(500).json({
          error: data.message
        });
      }

      market[name] = data.values;
    }

    function direction(candles) {
      const recent = candles.slice(0, 10);

      const newest = Number(recent[0].close);
      const oldest = Number(recent[9].close);

      if (newest > oldest) return "BULLISH";
      if (newest < oldest) return "BEARISH";

      return "SIDEWAYS";
    }

    const directionResult = {
      H4: direction(market.H4),
      H1: direction(market.H1),
      M30: direction(market.M30),
      M15: direction(market.M15),
      M5: direction(market.M5)
    };

    let bullish = 0;
    let bearish = 0;

    Object.values(directionResult).forEach(dir => {
      if (dir === "BULLISH") bullish++;
      if (dir === "BEARISH") bearish++;
    });

    let signal = "WAIT";

    if (bullish >= 4) {
      signal = "BUY";
    } else if (bearish >= 4) {
      signal = "SELL";
    }

    const price = Number(market.M5[0].close);

    let entry = price;
    let sl;
    let tp1;
    let tp2;

    if (signal === "BUY") {
      sl = price - 3;
      tp1 = price + 6;
      tp2 = price + 12;
    }

    if (signal === "SELL") {
      sl = price + 3;
      tp1 = price - 6;
      tp2 = price - 12;
    }

    return res.status(200).json({
      symbol: "XAUUSD",
      price,
      signal,
      direction: directionResult,
      entry,
      sl,
      tp1,
      tp2,
      note: "SINNCI AI technical analysis"
    });

  } catch (error) {
    return res.status(500).json({
      error: "Analysis server error"
    });
  }
}
