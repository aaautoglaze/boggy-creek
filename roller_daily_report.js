#!/usr/bin/env node
/**
 * Boggy Creek Airboats — Daily Roller Report
 *
 * Pulls yesterday's data from Roller API, formats a text report,
 * and sends via gog CLI to Chris Park + team.
 *
 * Usage:
 *   node roller_daily_report.js              # live data, send email
 *   node roller_daily_report.js --test       # sample data, send email
 *   node roller_daily_report.js --dry-run    # live data, print only
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Config ──────────────────────────────────────────────────────────────────

const ROLLER_BASE = "https://roller.app";
const ROLLER_COOKIE_PATH =
  process.env.ROLLER_COOKIE_PATH ||
  path.join(process.env.HOME || "/root", ".roller_cookie");

const GOG_ACCOUNT = "allen@clearpathapps.ai";
const TO = "chrispark@bcairboats.com";
const CC = "skirscht@bcairboats.com,allen@clearpathapps.ai";

const MEMORY_DIR = "/data/.openclaw/workspace/memory";
const MEMORY_FILE = path.join(MEMORY_DIR, "roller_last_report.json");

// ── Date helpers ────────────────────────────────────────────────────────────

function getYesterday() {
  const d = new Date(Date.now() - 86400000);
  return d;
}

function fmtDate(d) {
  // YYYY-MM-DD
  return d.toISOString().split("T")[0];
}

function fmtDateDisplay(d) {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function fmtMoney(n) {
  return "$" + Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtMoneyWhole(n) {
  return "$" + Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

function rollerGet(urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, ROLLER_BASE);
    const mod = url.protocol === "https:" ? https : http;

    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        "User-Agent": "BCA-DailyReport/1.0",
      },
    };

    const req = mod.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} on ${url.pathname}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`JSON parse error on ${url.pathname}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout on ${url.pathname}`)); });
    req.end();
  });
}

// ── Load Roller cookie ──────────────────────────────────────────────────────

function loadCookie() {
  // Try file first
  if (fs.existsSync(ROLLER_COOKIE_PATH)) {
    return fs.readFileSync(ROLLER_COOKIE_PATH, "utf8").trim();
  }
  // Try env
  if (process.env.ROLLER_COOKIE) {
    return process.env.ROLLER_COOKIE.trim();
  }
  return null;
}

// ── Data fetchers ───────────────────────────────────────────────────────────

async function fetchVenueSummary(date, cookie) {
  return rollerGet(`/api/venue/dashboard/venue-summary?date=${date}&Cell=a`, cookie);
}

async function fetchBookedGuests(date, cookie) {
  return rollerGet(`/api/venue/dashboard/booked-guests-summary?date=${date}&Cell=a`, cookie);
}

async function fetchProductSalesAll(cookie) {
  // Grid 110663 — Product Sales. Paginated, loop all pages.
  const allRows = [];
  let page = 1;
  while (true) {
    const data = await rollerGet(
      `/api/venue/reports/grid/110663/data?Cell=a&page=${page}&pageSize=100`,
      cookie
    );
    const rows = data.data || data.rows || data || [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    allRows.push(...rows);
    // Check if there are more pages
    const totalPages = data.totalPages || data.meta?.totalPages;
    if (totalPages && page >= totalPages) break;
    if (rows.length < 100) break; // last page
    page++;
  }
  return allRows;
}

async function fetchTransactions(cookie) {
  // Grid 110690 — Transactions. Page 1, we'll sort client-side by grandTotal.
  const data = await rollerGet(
    `/api/venue/reports/grid/110690/data?Cell=a&page=1&pageSize=50`,
    cookie
  );
  return data.data || data.rows || data || [];
}

async function fetchNotifications(cookie) {
  return rollerGet(`/api/activity-center/notifications/list`, cookie);
}

// ── Revenue stream grouping ─────────────────────────────────────────────────

const GL_CODE_MAP = {
  "Airboat Revenue":    { emoji: "🚤", label: "Airboat Tours" },
  "Attraction Revenue": { emoji: "🐄", label: "Mini Moo Land" },
  "Retail Revenue":     { emoji: "💎", label: "Gem Mining" },
  "Food & Beverage":    { emoji: "🍺", label: "Tiki Bar/Food" },
  "Food Truck":         { emoji: "🍔", label: "Food Truck" },
  "Retail":             { emoji: "🛍️", label: "Gift Shop" },
  "Gratuity":           { emoji: "💰", label: "Tips" },
  "Groups":             { emoji: "🎀", label: "Groups/Catering" },
};

function groupProductSales(rows) {
  const streams = {};
  for (const [key, meta] of Object.entries(GL_CODE_MAP)) {
    streams[key] = { ...meta, sales: 0, tickets: 0 };
  }
  // "Other" catch-all
  streams["_other"] = { emoji: "📦", label: "Other", sales: 0, tickets: 0 };

  for (const row of rows) {
    const glCode = row.glCodeName || row.gl_code_name || row.glCode || "";
    const totalSales = Number(row.totalSales || row.total_sales || row.amount || 0);
    const qty = Number(row.quantity || row.qty || row.ticketCount || 0);

    let matched = false;
    for (const [key, stream] of Object.entries(streams)) {
      if (key === "_other") continue;
      if (glCode === key || glCode.toLowerCase().includes(key.toLowerCase())) {
        stream.sales += totalSales;
        stream.tickets += qty;
        matched = true;
        break;
      }
    }
    if (!matched) {
      streams["_other"].sales += totalSales;
      streams["_other"].tickets += qty;
    }
  }
  return streams;
}

// ── Sample data for --test ──────────────────────────────────────────────────

function getSampleData() {
  const yesterday = getYesterday();
  return {
    date: fmtDate(yesterday),
    dateDisplay: fmtDateDisplay(yesterday),
    guestsBooked: 448,
    grossSales: 35929.0,
    fundsReceived: 5170.0,
    transactions: 127,
    checkins: 84,
    streams: {
      "Airboat Revenue":    { emoji: "🚤", label: "Airboat Tours", sales: 22450, tickets: 312 },
      "Attraction Revenue": { emoji: "🐄", label: "Mini Moo Land", sales: 3200, tickets: 89 },
      "Retail Revenue":     { emoji: "💎", label: "Gem Mining", sales: 1850, tickets: 45 },
      "Food & Beverage":    { emoji: "🍺", label: "Tiki Bar/Food", sales: 4120, tickets: 0 },
      "Food Truck":         { emoji: "🍔", label: "Food Truck", sales: 1890, tickets: 0 },
      "Retail":             { emoji: "🛍️", label: "Gift Shop", sales: 1280, tickets: 0 },
      "Gratuity":           { emoji: "💰", label: "Tips", sales: 639, tickets: 0 },
      "Groups":             { emoji: "🎀", label: "Groups/Catering", sales: 500, tickets: 0 },
    },
    topBookings: [
      { name: "Smith Family (6)", total: 420.00, payment: "Credit Card" },
      { name: "Johnson Group (12)", total: 840.00, payment: "Credit Card" },
      { name: "TripAdvisor — Garcia (4)", total: 280.00, payment: "OTA Prepaid" },
      { name: "Walk-in (2)", total: 140.00, payment: "Cash" },
      { name: "GetYourGuide — Lee (3)", total: 210.00, payment: "OTA Prepaid" },
    ],
    alerts: [],
    gxScore: 86,
  };
}

// ── Fetch live data ─────────────────────────────────────────────────────────

async function fetchLiveData(cookie) {
  const yesterday = getYesterday();
  const date = fmtDate(yesterday);

  console.log(`Fetching Roller data for ${date}...`);

  // Fetch all endpoints in parallel
  const [venueSummary, bookedGuests, productRows, transactionRows, notifications] =
    await Promise.all([
      fetchVenueSummary(date, cookie).catch((e) => { console.error("venue-summary:", e.message); return {}; }),
      fetchBookedGuests(date, cookie).catch((e) => { console.error("booked-guests:", e.message); return {}; }),
      fetchProductSalesAll(cookie).catch((e) => { console.error("product-sales:", e.message); return []; }),
      fetchTransactions(cookie).catch((e) => { console.error("transactions:", e.message); return []; }),
      fetchNotifications(cookie).catch((e) => { console.error("notifications:", e.message); return {}; }),
    ]);

  // Group product sales by GL code
  const streams = groupProductSales(productRows);

  // Gross Sales = sum of all totalSales from product grid (NOT venue-summary Revenue)
  const grossSales = Object.values(streams).reduce((sum, s) => sum + s.sales, 0);

  // Top 5 bookings sorted by grandTotal
  const topBookings = transactionRows
    .sort((a, b) => Number(b.grandTotal || 0) - Number(a.grandTotal || 0))
    .slice(0, 5)
    .map((t) => ({
      name: t.bookingName || t.booking_name || t.customerName || "Unknown",
      total: Number(t.grandTotal || t.grand_total || 0),
      payment: t.paymentType || t.payment_type || "N/A",
    }));

  // Alerts — new notifications
  const alertList = (notifications.data || notifications || []);
  const alerts = Array.isArray(alertList)
    ? alertList.filter((n) => n.isNew || n.is_new)
    : [];

  return {
    date,
    dateDisplay: fmtDateDisplay(yesterday),
    guestsBooked: Number(venueSummary.bookedGuests || bookedGuests.total || bookedGuests.count || 0),
    grossSales,
    fundsReceived: Number(venueSummary.fundsReceived || venueSummary.funds_received || 0),
    transactions: transactionRows.length,
    checkins: Number(venueSummary.checkins || venueSummary.checkIns || bookedGuests.checkins || 0),
    streams,
    topBookings,
    alerts,
    gxScore: Number(venueSummary.gxScore || venueSummary.gx_score || 0) || null,
  };
}

// ── Format report ───────────────────────────────────────────────────────────

function formatReport(data) {
  const lines = [];
  const hr = "─────────────────────";

  lines.push(`🐊 BOGGY CREEK DAILY REPORT — ${data.dateDisplay.toUpperCase()}`);
  lines.push("");
  lines.push("📊 YESTERDAY'S NUMBERS");
  lines.push(`Guests Booked: ${fmtNum(data.guestsBooked)}`);
  lines.push(`Gross Sales: ${fmtMoney(data.grossSales)}`);
  lines.push(`Funds Received: ${fmtMoney(data.fundsReceived)}`);
  lines.push(`Transactions: ${fmtNum(data.transactions)}`);
  lines.push(`Check-ins: ${fmtNum(data.checkins)}`);
  lines.push("");

  // Revenue by stream
  lines.push("💰 REVENUE BY STREAM");
  let totalSales = 0;
  const streamOrder = [
    "Airboat Revenue", "Attraction Revenue", "Retail Revenue",
    "Food & Beverage", "Food Truck", "Retail", "Gratuity", "Groups",
  ];
  for (const key of streamOrder) {
    const s = data.streams[key];
    if (!s) continue;
    const ticketStr = s.tickets > 0 ? ` (${fmtNum(s.tickets)} tickets)` : "";
    lines.push(`${s.emoji} ${s.label}: ${fmtMoney(s.sales)}${ticketStr}`);
    totalSales += s.sales;
  }
  // Include "Other" if nonzero
  const other = data.streams["_other"];
  if (other && other.sales > 0) {
    lines.push(`${other.emoji} ${other.label}: ${fmtMoney(other.sales)}`);
    totalSales += other.sales;
  }
  lines.push(hr);
  lines.push(`TOTAL: ${fmtMoney(totalSales)}`);
  lines.push("");

  // Top 5 bookings
  lines.push("🎟️ TOP 5 BOOKINGS");
  if (data.topBookings.length === 0) {
    lines.push("  No bookings data available");
  } else {
    data.topBookings.forEach((b, i) => {
      lines.push(`${i + 1}. ${b.name} — ${fmtMoney(b.total)} — ${b.payment}`);
    });
  }
  lines.push("");

  // Alerts
  lines.push("⚠️ NEEDS ATTENTION");
  if (data.alerts.length === 0) {
    lines.push("Nothing flagged ✅");
  } else {
    data.alerts.slice(0, 10).forEach((a) => {
      const msg = a.message || a.title || a.text || JSON.stringify(a);
      lines.push(`• ${msg}`);
    });
  }
  lines.push("");

  // GX Score
  if (data.gxScore) {
    lines.push(`😊 GX SCORE: ${data.gxScore}/100`);
  } else {
    lines.push("😊 GX SCORE: N/A");
  }
  lines.push("");

  // Footer
  lines.push("📝 Gross Sales = recognized revenue | Funds Received = cash collected");

  return lines.join("\n");
}

// ── Send via gog ────────────────────────────────────────────────────────────

function sendEmail(report, dateStr) {
  const subject = `🐊 Boggy Creek Daily Report — ${dateStr}`;

  const env = {
    ...process.env,
    PATH: `/data/.local/bin:${process.env.HOME}/bin:${process.env.PATH}`,
    GOG_KEYRING_PASSWORD: "",
    GOG_ACCOUNT: GOG_ACCOUNT,
  };

  // Find gog binary
  const gogPaths = [
    "/data/.local/bin/gog",
    path.join(process.env.HOME || "/root", "bin/gog"),
  ];
  let gogBin = null;
  for (const p of gogPaths) {
    if (fs.existsSync(p)) { gogBin = p; break; }
  }
  if (!gogBin) {
    console.error("ERROR: gog CLI not found at", gogPaths.join(" or "));
    process.exit(1);
  }

  // Write report to temp file to avoid ARG_MAX
  const tmpFile = `/tmp/bca_report_${Date.now()}.txt`;
  fs.writeFileSync(tmpFile, report);

  try {
    const cmd = [
      gogBin, "gmail", "send",
      "--to", TO,
      "--cc", CC,
      "--subject", subject,
      "--body-file", tmpFile,
    ].map((a) => `"${a}"`).join(" ");

    console.log(`Sending report to ${TO} (cc: ${CC})...`);
    execSync(cmd, { env, stdio: "pipe", timeout: 60000 });
    console.log("✓ Report sent successfully");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Save to memory ──────────────────────────────────────────────────────────

function saveToMemory(data, report) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      date: data.date,
      guestsBooked: data.guestsBooked,
      grossSales: data.grossSales,
      fundsReceived: data.fundsReceived,
      transactions: data.transactions,
      checkins: data.checkins,
      gxScore: data.gxScore,
      streams: Object.fromEntries(
        Object.entries(data.streams)
          .filter(([k]) => k !== "_other")
          .map(([k, v]) => [k, { sales: v.sales, tickets: v.tickets }])
      ),
      reportLength: report.length,
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(record, null, 2));
    console.log(`✓ Saved to ${MEMORY_FILE}`);
  } catch (e) {
    console.warn(`Warning: Could not save to memory: ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isTest = args.includes("--test");
  const isDryRun = args.includes("--dry-run");

  let data;

  if (isTest) {
    console.log("Running in TEST mode with sample data...");
    data = getSampleData();
  } else {
    const cookie = loadCookie();
    if (!cookie) {
      console.error("ERROR: No Roller session cookie found.");
      console.error(`  Set ROLLER_COOKIE env var or save cookie to ${ROLLER_COOKIE_PATH}`);
      process.exit(1);
    }
    data = await fetchLiveData(cookie);
  }

  const report = formatReport(data);

  console.log("\n" + report + "\n");

  if (isDryRun) {
    console.log("(Dry run — not sending email)");
  } else {
    sendEmail(report, data.dateDisplay);
  }

  saveToMemory(data, report);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
