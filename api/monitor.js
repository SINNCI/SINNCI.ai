/**
 * SINNCI AI — LIVE SETUP MONITOR
 * File: api/monitor.js
 * Version: 2.4.0
 *
 * Source of truth:
 * - /api/analyze
 *
 * Rules:
 * - Mirror setup status from analyze.js.
 * - Do not require zone.status === IN_ZONE.
 * - Do not add independent M5 confirmation.
 * - Preserve original Analyze setup objects.
 * - Never reactivate a setup with a terminal status.
 * - Analysis only; no trade execution.
 * - Does not update Supabase SL/TP statuses.
 */

const TERMINAL_STATUSES = new Set([
  "TP_HIT",
  "FAILED_SL_HIT",
  "SL_HIT",
  "CANCELLED",
  "EXPIRED",
  "CLOSED"
]);

function sendError(
  res,
  statusCode,
  code,
  message,
  details = null
) {
  return res.status(statusCode).json({
    success: false,
    status: "error",
    code,
    error: message,
    details,
    source: "SINNCI Monitor",
    timestamp: new Date().toISOString()
  });
}

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function getAnalysisStatus(setup) {
  // Follow Analyze's own setup status.
  return normalizeStatus(setup?.status);
}

function getSetupId(setup) {
  return (
    setup?.signalLock?.setupId ??
    setup?.setupId ??
    setup?.id ??
    null
  );
}

function getTerminalStatusFromSetup(setup) {
  const status = normalizeStatus(
    setup?.signalLock?.terminalStatus
  );

  return TERMINAL_STATUSES.has(status)
    ? status
    : null;
}

/**
 * Search Analyze's terminal records for the same setup ID.
 *
 * This prevents an old TP_HIT/SL_HIT setup from being
 * treated as a new active setup when Analyze accidentally
 * returns READY for the same ID.
 */
function findTerminalRecord(data, mode, setup) {
  const setupId = getSetupId(setup);

  if (!setupId) {
    return null;
  }

  const sources = [
    data?.terminalStatus?.[mode],
    data?.terminalHistory?.[mode]
  ];

  for (const records of sources) {
    if (!Array.isArray(records)) {
      continue;
    }

    for (const record of records) {
      if (!isObject(record)) {
        continue;
      }

      if (
        String(record.setupId ?? "") !==
        String(setupId)
      ) {
        continue;
      }

      const terminalStatus = normalizeStatus(
        record.status
      );

      if (
        TERMINAL_STATUSES.has(terminalStatus)
      ) {
        return {
          setupId,
          status: terminalStatus,
          timestamp:
            record.timestamp ??
            record.terminalAt ??
            null,
          source: "ANALYZE_TERMINAL_HISTORY"
        };
      }
    }
  }

  return null;
}

/**
 * A terminal signalLock takes precedence over a READY
 * status for the same setup.
 *
 * Analyze's status is still returned unchanged in setups.
 * This function only determines whether that setup can
 * be considered active by Monitor.
 */
function evaluateSetup(data, mode, setup) {
  if (!isObject(setup)) {
    return {
      analysisStatus: "INVALID",
      analysisReady: false,
      active: false,
      terminal: false,
      terminalStatus: null,
      reason: "INVALID_SETUP_DATA",
      zoneStatus: null,
      zoneDistance: null,
      setupId: null
    };
  }

  const analysisStatus = getAnalysisStatus(setup);
  const setupId = getSetupId(setup);

  const lockTerminalStatus =
    getTerminalStatusFromSetup(setup);

  const historyTerminal =
    findTerminalRecord(data, mode, setup);

  const terminalStatus =
    lockTerminalStatus ??
    historyTerminal?.status ??
    null;

  const terminal = Boolean(terminalStatus);

  const analysisReady =
    analysisStatus === "READY";

  const active =
    analysisReady && !terminal;

  let reason = null;

  if (terminal) {
    reason = `TERMINAL_${terminalStatus}`;
  } else if (!analysisReady) {
    reason =
      setup?.reason ??
      `ANALYZE_STATUS_${analysisStatus || "UNKNOWN"}`;
  }

  return {
    analysisStatus,
    analysisReady,
    active,
    terminal,
    terminalStatus,
    reason,
    zoneStatus:
      setup?.zone?.status ??
      setup?.zoneStatus ??
      null,
    zoneDistance:
      setup?.zone?.distance ?? null,
    setupId,
    terminalAt:
      setup?.signalLock?.terminalAt ??
      historyTerminal?.timestamp ??
      null,
    terminalSource: lockTerminalStatus
      ? "ANALYZE_SIGNAL_LOCK"
      : historyTerminal?.source ?? null
  };
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, max-age=0, must-revalidate"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");

    return sendError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan GET untuk mendapatkan status monitor."
    );
  }

  const requestedType = String(
    req.query?.type || "both"
  ).toLowerCase();

  const allowedTypes = [
    "both",
    "scalping",
    "intraday"
  ];

  if (!allowedTypes.includes(requestedType)) {
    return sendError(
      res,
      400,
      "INVALID_TYPE",
      "type mesti both, scalping atau intraday."
    );
  }

  const host = req.headers.host;

  if (!host) {
    return sendError(
      res,
      500,
      "MISSING_HOST",
      "Host request tidak tersedia."
    );
  }

  const forwardedProto = String(
    req.headers["x-forwarded-proto"] || ""
  )
    .split(",")[0]
    .trim();

  const protocol =
    forwardedProto === "http" ||
    forwardedProto === "https"
      ? forwardedProto
      : "https";

  const analyzeUrl = new URL(
    "/api/analyze",
    `${protocol}://${host}`
  ).toString();

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 20000);

  let response;
  let data;

  try {
    try {
      response = await fetch(analyzeUrl, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal,
        cache: "no-store"
      });

      const responseText = await response.text();

      try {
        data = JSON.parse(responseText);
      } catch {
        return sendError(
          res,
          502,
          "INVALID_ANALYZE_JSON",
          "API Analyze tidak memulangkan JSON yang sah.",
          {
            httpStatus: response.status,
            responsePreview: responseText.slice(0, 300)
          }
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    if (
      !response.ok ||
      data?.success !== true
    ) {
      return sendError(
        res,
        502,
        "ANALYZE_API_FAILED",
        "Monitor tidak dapat mendapatkan analisis sebenar.",
        {
          httpStatus: response.status,
          analyzeResponse: data
        }
      );
    }

    /*
     * Copy references to the actual Analyze setup objects.
     * Do not generate new signals or change setup fields.
     */
    const selectedSetups = {};

    if (
      requestedType === "both" ||
      requestedType === "scalping"
    ) {
      if (isObject(data.scalping)) {
        selectedSetups.scalping = data.scalping;
      }
    }

    if (
      requestedType === "both" ||
      requestedType === "intraday"
    ) {
      if (isObject(data.intraday)) {
        selectedSetups.intraday = data.intraday;
      }
    }

    /*
     * Readiness follows Analyze's status.
     * The only additional exclusion is a terminal setup
     * with the same setup ID.
     *
     * WATCH, zone distance and M5 confirmation are not
     * independent rejection conditions here.
     */
    const evaluatedSetups = Object.entries(
      selectedSetups
    ).map(([type, setup]) => ({
      type,
      setup,
      evaluation: evaluateSetup(
        data,
        type,
        setup
      )
    }));

    const activeReadySetups =
      evaluatedSetups.filter(
        item => item.evaluation.active
      );

    const analysisReadySetups =
      evaluatedSetups.filter(
        item => item.evaluation.analysisReady
      );

    const terminalConflicts =
      evaluatedSetups.filter(
        item =>
          item.evaluation.analysisReady &&
          item.evaluation.terminal
      );

    /*
     * Select the highest-scoring active READY setup.
     * A terminal setup cannot become bestSetup.
     */
    const bestSetup = activeReadySetups.length
      ? activeReadySetups.reduce(
          (best, current) => {
            const currentScore = Number(
              current.setup.score ?? 0
            );

            const bestScore = Number(
              best.setup.score ?? 0
            );

            return currentScore > bestScore
              ? current
              : best;
          }
        )
      : null;

    /*
     * Readiness metadata is separate from the original
     * Analyze setup objects.
     */
    const setupReadiness = {};

    for (const item of evaluatedSetups) {
      const evaluation = item.evaluation;

      setupReadiness[item.type] = {
        // Literal status returned by Analyze.
        analysisStatus: evaluation.analysisStatus,

        // Mirrors Analyze's READY status.
        ready: evaluation.analysisReady,

        // READY and not terminal.
        active: evaluation.active,

        terminal: evaluation.terminal,
        terminalStatus: evaluation.terminalStatus,

        reason: evaluation.reason,

        setupId: evaluation.setupId,
        zoneStatus: evaluation.zoneStatus,
        zoneDistance: evaluation.zoneDistance,

        terminalAt: evaluation.terminalAt,
        terminalSource: evaluation.terminalSource
      };
    }

    let summaryMessage;

    if (activeReadySetups.length > 0) {
      summaryMessage =
        "Terdapat setup READY yang aktif mengikut Analyze.";
    } else if (terminalConflicts.length > 0) {
      summaryMessage =
        "Analyze memulangkan READY untuk setup yang telah tamat. " +
        "Setup dikekalkan dalam data analisis tetapi tidak dianggap aktif.";
    } else if (analysisReadySetups.length > 0) {
      summaryMessage =
        "Analyze memulangkan READY, tetapi tiada setup aktif yang layak dipilih.";
    } else {
      summaryMessage =
        "Tiada setup berstatus READY dalam Analyze.";
    }

    return res.status(200).json({
      success: true,
      status: "success",
      engine: "SINNCI LIVE MONITOR",
      version: "2.4.0",

      symbol: data.symbol || "XAU/USD",
      source: data.source || "SINNCI AI",

      analysisOnly: true,
      automatedTrading: false,

      market: data.market ?? null,
      cmp: data.cmp ?? null,

      // Original setup objects from Analyze.
      setups: selectedSetups,

      // Monitor's separate status metadata.
      setupReadiness,

      // Only a READY setup without terminal status.
      bestSetup: bestSetup
        ? {
            type: bestSetup.type,
            ...bestSetup.setup
          }
        : null,

      summary: {
        ready: activeReadySetups.length > 0,

        // Active setups eligible for bestSetup.
        readyCount: activeReadySetups.length,

        // READY according to Analyze, including
        // terminal conflicts.
        analysisReadyCount:
          analysisReadySetups.length,

        terminalConflictCount:
          terminalConflicts.length,

        checkedCount:
          evaluatedSetups.length,

        message: summaryMessage,

        note:
          "Status, arah, skor, zon dan pelan setup dibaca " +
          "daripada analyze.js. Monitor tidak mewajibkan " +
          "zone.status IN_ZONE atau confirmation M5. " +
          "Setup terminal tidak dianggap aktif. " +
          "Monitor tidak melaksanakan trade dan tidak " +
          "mengemas kini status SL/TP dalam Supabase."
      },

      signalLock: data.signalLock ?? null,

      terminalStatus:
        data.terminalStatus ?? null,

      terminalHistory:
        data.terminalHistory ?? null,

      terminalHistoryError:
        data.terminalHistoryError ?? null,

      dataQuality:
        data.dataQuality ?? null,

      // Keep Analyze's timestamp for reference and
      // a separate timestamp for this Monitor response.
      analyzeTimestamp:
        data.timestamp ?? null,

      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const isTimeout =
      error?.name === "AbortError";

    return sendError(
      res,
      502,
      isTimeout
        ? "ANALYZE_TIMEOUT"
        : "MONITOR_INTERNAL_ERROR",
      isTimeout
        ? "Permintaan analisis mengambil masa terlalu lama."
        : "Monitor gagal mendapatkan analisis.",
      {
        message: error?.message || null
      }
    );
  }
}
