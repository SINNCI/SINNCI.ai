export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY tidak dijumpai"
      });
    }

    const response = await fetch(
      `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${API_KEY}`
    );

    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(500).json({
        error: data.message || "Twelve Data price error",
        details: data
      });
    }

    const price = Number(data.price);

    if (!Number.isFinite(price)) {
      return res.status(500).json({
        error: "Harga XAUUSD tidak valid",
        details: data
      });
    }

    return res.status(200).json({
      symbol: "XAUUSD",
      price: price,
      source: "Twelve Data"
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message || "Server error"
    });
  }
}
