export default async function handler(req, res) {
  try {
    const response = await fetch(
      `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${process.env.TWELVE_DATA_API_KEY}`
    );

    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(500).json({
        error: data.message || "Failed to get XAUUSD price"
      });
    }

    return res.status(200).json({
      symbol: "XAUUSD",
      price: Number(data.price),
      source: "Twelve Data"
    });

  } catch (error) {
    return res.status(500).json({
      error: "Server error"
    });
  }
}
