/**

* SINNCI AI — MONITOR API
* File: api/monitor.js
* Purpose: Monitor an existing XAUUSD setup.
* Analysis only. No automated trade execution.
  */

const POINT_VALUE = 0.01;

function num(value) {
const result = Number(value);
return Number.isFinite(result) ? result : null;
}

function jsonError(res, statusCode, code, message) {
return res.status(statusCode).json({
success: false,
status: "error",
code,
error: message,
source: "SINNCI Monitor"
});
}

export default async function handler(req, res) {
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");

if (req.method === "OPTIONS") {
return res.status(200).end();
}

if (req.method !== "GET" && req.method !== "POST") {
return jsonError(
res,
405,
"METHOD_NOT_ALLOWED",
"Gunakan GET atau POST."
);
}

try {
let body = req.body || {};

if (typeof body === "string") {
  try {
    body = JSON.parse(body);
  } catch {
    return jsonError(
      res,
      400,
      "INVALID_JSON",
      "Body JSON tidak sah."
    );
  }
}

const params = req.method === "GET"
  ? (req.query || {})
  : body;

const setupId = params.setupId;
const direction = String(
  params.direction || params.side || ""
).toUpperCase();

const zone = params.zone || {};

const low = num(zone.low ?? params.zoneLow);
const high = num(zone.high ?? params.zoneHigh);
const price = num(params.price);

if (!setupId) {
  return jsonError(
    res,
    400,
    "MISSING_SETUP_ID",
    "setupId diperlukan daripada setup SINNCI AI."
  );
}

if (direction !== "BUY" && direction !== "SELL") {
  return jsonError(
    res,
    400,
    "INVALID_DIRECTION",
    "Direction mesti BUY atau SELL."
  );
}

if (
  low === null ||
  high === null ||
  low >= high
) {
  return jsonError(
    res,
    400,
    "INVALID_ZONE",
    "Zon mesti mempunyai nilai low dan high yang sah."
  );
}

if (price === null || price <= 0) {
  return jsonError(
    res,
    400,
    "MISSING_PRICE",
    "Harga semasa yang sah diperlukan. Monitor tidak mereka harga."
  );
}

let zoneStatus = "WATCH";

if (direction === "BUY") {
  if (price < low) {
    zoneStatus = "BELOW_ZONE";
  } else if (price <= high) {
    zoneStatus = "IN_ZONE";
  } else {
    zoneStatus = "ABOVE_ZONE";
  }
} else {
  if (price > high) {
    zoneStatus = "ABOVE_ZONE";
  } else if (price >= low) {
    zoneStatus = "IN_ZONE";
  } else {
    zoneStatus = "BELOW_ZONE";
  }
}

return res.status(200).json({
  success: true,
  status: "success",
  engine: "SINNCI MONITOR",
  version: "1.0",
  symbol: "XAUUSD",
  setupId,
  direction,
  price,
  zone: {
    low,
    high,
    locked: false,
    status: zoneStatus
  },
  entryStatus: "WAIT",
  confirmation: {
    m5: "NOT_CHECKED",
    m1: "NOT_CHECKED"
  },
  note: "Monitor asas sahaja. Zone belum persistent dan M5/M1 belum disahkan menggunakan candle sebenar.",
  pointValue: POINT_VALUE,
  timestamp: new Date().toISOString()
});

} catch (error) {
return jsonError(
res,
500,
"MONITOR_INTERNAL_ERROR",
error.message || "Monitor gagal diproses."
);
}
}
