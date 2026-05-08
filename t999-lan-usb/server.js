const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 9999);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SLIPS_FILE = path.join(DATA_DIR, "slips.json");
const AGENTS_FILE = path.join(DATA_DIR, "agents.json");
const OUTBOUND_FILE = path.join(DATA_DIR, "outbound.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const clients = new Set();

function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), "utf8");
  }
}

function ensureBaseFiles() {
  ensureFile(AGENTS_FILE, [
    { id: "A001", name: "เอเยนต์ A" },
    { id: "A002", name: "เอเยนต์ B" },
    { id: "A003", name: "เอเยนต์ C" }
  ]);

  ensureFile(SLIPS_FILE, []);
  ensureFile(OUTBOUND_FILE, []);

  ensureFile(SETTINGS_FILE, {
    appName: "T999 LAN USB",
    step: "1",
    runtime: "usb-lan-offline",
    demoLimit: 1000,
    note: "Step 1: LAN runtime base. USB is the program/data container. LAN is the real-time connection."
  });
}

function readJson(file, fallback) {
  ensureFile(file, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("JSON read error:", file, err);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function getLocalIps() {
  const os = require("os");
  const nets = os.networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        results.push(net.address);
      }
    }
  }

  return results;
}

function getSummary() {
  const slips = readJson(SLIPS_FILE, []);
  const outbound = readJson(OUTBOUND_FILE, []);
  const agents = readJson(AGENTS_FILE, []);
  const settings = readJson(SETTINGS_FILE, {});
  const demoLimit = Number(settings.demoLimit || 1000);

  const totalsByNumber = {};
  const agentTotals = {};

  for (const slip of slips) {
    if (!agentTotals[slip.agentId]) {
      const found = agents.find(a => a.id === slip.agentId);
      agentTotals[slip.agentId] = {
        agentId: slip.agentId,
        agentName: found ? found.name : slip.agentName || slip.agentId,
        amount: 0,
        slipCount: 0
      };
    }

    agentTotals[slip.agentId].slipCount += 1;

    for (const item of slip.items || []) {
      const amount = Number(item.amount || 0);
      const key = `${item.market || "thai"}|${item.type || "บน"}|${item.number}`;

      if (!totalsByNumber[key]) {
        totalsByNumber[key] = {
          market: item.market || "thai",
          type: item.type || "บน",
          number: item.number,
          amount: 0,
          outboundAmount: 0,
          overAmount: 0
        };
      }

      totalsByNumber[key].amount += amount;
      agentTotals[slip.agentId].amount += amount;
    }
  }

  for (const out of outbound) {
    for (const item of out.items || []) {
      const amount = Number(item.amount || 0);
      const key = `${item.market || "thai"}|${item.type || "บน"}|${item.number}`;

      if (!totalsByNumber[key]) {
        totalsByNumber[key] = {
          market: item.market || "thai",
          type: item.type || "บน",
          number: item.number,
          amount: 0,
          outboundAmount: 0,
          overAmount: 0
        };
      }

      totalsByNumber[key].outboundAmount += amount;
    }
  }

  for (const row of Object.values(totalsByNumber)) {
    row.overAmount = Math.max(0, row.amount - demoLimit - row.outboundAmount);
  }

  return {
    serverTime: new Date().toISOString(),
    runtime: {
      root: ROOT,
      port: PORT,
      ips: getLocalIps()
    },
    slips,
    outbound,
    agents,
    accountMain: {
      name: "บัญชียอดรวมทั้งหมด",
      totalAmount: Object.values(agentTotals).reduce((sum, a) => sum + a.amount, 0),
      slipCount: slips.length
    },
    accountOutbound: {
      name: "บัญชียอดส่งออก / ส่งนอก",
      totalAmount: outbound.reduce((sum, out) => {
        return sum + (out.items || []).reduce((s, i) => s + Number(i.amount || 0), 0);
      }, 0),
      slipCount: outbound.length
    },
    agentTotals: Object.values(agentTotals).sort((a, b) => {
      return String(a.agentName).localeCompare(String(b.agentName), "th");
    }),
    totalsByNumber: Object.values(totalsByNumber).sort((a, b) => {
      if (b.amount !== a.amount) return b.amount - a.amount;
      return String(a.number).localeCompare(String(b.number), "th");
    }),
    overLimit: Object.values(totalsByNumber)
      .filter(row => row.overAmount > 0)
      .sort((a, b) => b.overAmount - a.overAmount)
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(getSummary())}\n\n`;

  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      clients.delete(res);
    }
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/") {
    res.writeHead(302, { Location: "/master" });
    return res.end();
  }

  if (urlPath === "/master") urlPath = "/master/index.html";
  if (urlPath === "/subkey") urlPath = "/subkey/index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ไม่พบไฟล์: " + urlPath);
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  };

  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });

  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, urlPath) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method === "GET" && urlPath === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    res.write(`data: ${JSON.stringify(getSummary())}\n\n`);
    clients.add(res);

    req.on("close", () => clients.delete(res));
    return true;
  }

  if (req.method === "GET" && urlPath === "/api/summary") {
    sendJson(res, 200, getSummary());
    return true;
  }

  if (req.method === "GET" && urlPath === "/api/agents") {
    sendJson(res, 200, readJson(AGENTS_FILE, []));
    return true;
  }

  if (req.method === "GET" && urlPath === "/api/runtime") {
    sendJson(res, 200, {
      ok: true,
      root: ROOT,
      port: PORT,
      ips: getLocalIps(),
      masterUrls: getLocalIps().map(ip => `http://${ip}:${PORT}/master`),
      subkeyUrls: getLocalIps().map(ip => `http://${ip}:${PORT}/subkey`)
    });
    return true;
  }

  if (req.method === "POST" && urlPath === "/api/slips") {
    const body = await parseBody(req);

    if (!body.agentId || !Array.isArray(body.items) || body.items.length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: "ต้องมี agentId และ items อย่างน้อย 1 รายการ"
      });
      return true;
    }

    const agents = readJson(AGENTS_FILE, []);
    const agent = agents.find(a => a.id === body.agentId);

    const cleanItems = body.items.map((item, index) => ({
      row: index + 1,
      market: item.market || body.market || "thai",
      type: item.type || "บน",
      number: String(item.number || "").trim(),
      amount: Number(item.amount || 0),
      note: item.note || ""
    })).filter(item => item.number && item.amount > 0);

    if (cleanItems.length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: "ไม่มีรายการที่ถูกต้อง"
      });
      return true;
    }

    const slip = {
      id: `SLIP-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      createdAt: new Date().toISOString(),
      source: body.source || "subkey",
      mode: body.mode || "paper",
      machineName: body.machineName || "",
      operatorName: body.operatorName || "",
      agentId: body.agentId,
      agentName: agent ? agent.name : body.agentName || body.agentId,
      paperNo: body.paperNo || "",
      market: body.market || "thai",
      items: cleanItems
    };

    const slips = readJson(SLIPS_FILE, []);
    slips.unshift(slip);
    writeJson(SLIPS_FILE, slips);
    broadcast();

    sendJson(res, 201, { ok: true, slip });
    return true;
  }

  if (req.method === "POST" && urlPath === "/api/reset-demo") {
    writeJson(SLIPS_FILE, []);
    writeJson(OUTBOUND_FILE, []);
    broadcast();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

ensureBaseFiles();

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  try {
    const handled = await handleApi(req, res, urlPath);
    if (handled) return;

    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, {
      ok: false,
      error: err.message
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = getLocalIps();

  console.log("");
  console.log("========================================");
  console.log(" T999 LAN USB - STEP 1 SERVER STARTED");
  console.log("========================================");
  console.log("Root:", ROOT);
  console.log("");
  console.log(`Master local: http://localhost:${PORT}/master`);
  console.log(`Subkey local: http://localhost:${PORT}/subkey`);
  console.log("");

  if (ips.length) {
    console.log("LAN URLs:");
    for (const ip of ips) {
      console.log(`Master LAN: http://${ip}:${PORT}/master`);
      console.log(`Subkey LAN: http://${ip}:${PORT}/subkey`);
    }
  } else {
    console.log("ยังไม่พบ IP LAN ของเครื่องนี้");
  }

  console.log("");
  console.log("หมายเหตุ:");
  console.log("- เสียบ USB ที่เครื่อง Master");
  console.log("- รัน node server.js จากโฟลเดอร์ t999-lan-usb ใน USB");
  console.log("- เครื่อง Subkey เปิดผ่าน IP ของเครื่อง Master");
  console.log("========================================");
  console.log("");
});
