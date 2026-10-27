import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import nodemailer from "nodemailer";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = join(APP_ROOT, "dist");

async function loadLocalEnvironment() {
  try {
    const text = await readFile(join(APP_ROOT, ".env"), "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // First launch is allowed before email setup is completed.
  }
}

await loadLocalEnvironment();

const API_BASE = (process.env.BRITEBIN_API_URL || "https://api.britebin.ie").replace(/\/$/, "");
const START_PORT = Number(process.env.PORT) || 4173;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_FORMAT = /^\d{6}$/;
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false";
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASSWORD = (process.env.SMTP_APP_PASSWORD || "").replace(/\s+/g, "");
const SMTP_FROM = process.env.SMTP_FROM || `BriteBin CustomerVision <${SMTP_USER}>`;
const EMAIL_CONFIGURED = Boolean(SMTP_USER && SMTP_PASSWORD);
const OTP_TTL_MS = 10 * 60 * 1000;
const VERIFIED_TTL_MS = 30 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const MAX_SENDS_PER_IP = 10;
const MAX_CODE_ATTEMPTS = 5;
const OTP_SECRET = randomBytes(32);

const pendingCodes = new Map();
const verifiedSessions = new Map();
const ipSendHistory = new Map();

const mailTransport = EMAIL_CONFIGURED
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  : null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function sendJson(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashCode(email, code, salt) {
  return createHash("sha256")
    .update(OTP_SECRET)
    .update(email)
    .update(":")
    .update(code)
    .update(":")
    .update(salt)
    .digest();
}

function constantTimeMatch(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

function cleanExpiredState(now = Date.now()) {
  for (const [email, record] of pendingCodes) {
    if (record.expiresAt <= now) pendingCodes.delete(email);
  }
  for (const [token, record] of verifiedSessions) {
    if (record.expiresAt <= now) verifiedSessions.delete(token);
  }
  for (const [ip, timestamps] of ipSendHistory) {
    const active = timestamps.filter((time) => now - time < IP_WINDOW_MS);
    if (active.length) ipSendHistory.set(ip, active);
    else ipSendHistory.delete(ip);
  }
}

setInterval(cleanExpiredState, 5 * 60 * 1000).unref();

async function readRequestBody(request, maxBytes = 24 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function checkIpRateLimit(request) {
  const now = Date.now();
  const ip = request.socket.remoteAddress || "local";
  const active = (ipSendHistory.get(ip) || []).filter((time) => now - time < IP_WINDOW_MS);
  if (active.length >= MAX_SENDS_PER_IP) return false;
  active.push(now);
  ipSendHistory.set(ip, active);
  return true;
}

async function handleVerificationStatus(response) {
  sendJson(response, 200, {
    configured: EMAIL_CONFIGURED,
    sender: SMTP_USER,
  });
}

async function handleSendVerification(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Use POST to send a verification code." }, { Allow: "POST" });
    return;
  }
  if (!EMAIL_CONFIGURED || !mailTransport) {
    sendJson(response, 503, {
      message: "Verification email is not configured yet. Close CustomerVision and run the included email setup, then launch it again.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { message: "The verification request was not valid." });
    return;
  }

  const email = normalizeEmail(body.email);
  if (!EMAIL_FORMAT.test(email) || email.length > 254) {
    sendJson(response, 400, { message: "Enter a complete email address, such as name@example.com." });
    return;
  }

  cleanExpiredState();
  if (!checkIpRateLimit(request)) {
    sendJson(response, 429, { message: "Too many verification emails were requested. Wait 15 minutes and try again." });
    return;
  }

  const now = Date.now();
  const previous = pendingCodes.get(email);
  if (previous && now - previous.sentAt < RESEND_WAIT_MS) {
    const retryAfter = Math.ceil((RESEND_WAIT_MS - (now - previous.sentAt)) / 1000);
    sendJson(
      response,
      429,
      { message: `A code was already sent. Wait ${retryAfter} seconds before requesting another.` },
      { "Retry-After": String(retryAfter) }
    );
    return;
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  const record = {
    hash: hashCode(email, code, salt),
    salt,
    sentAt: now,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
  };

  try {
    await mailTransport.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: "Your CustomerVision verification code",
      text: `Your BriteBin CustomerVision verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#172033">
          <h2 style="color:#142b46">BriteBin CustomerVision</h2>
          <p>Use this one-time code to verify your email address:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p>
          <p>This code expires in 10 minutes.</p>
          <p style="color:#64758a;font-size:13px">If you did not request this code, you can ignore this email.</p>
        </div>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    pendingCodes.set(email, record);
    sendJson(response, 200, {
      message: `A six-digit code was sent to ${email}. Check the inbox and spam folder.`,
      expiresInSeconds: OTP_TTL_MS / 1000,
    });
  } catch (error) {
    console.error("Verification email failed:", error?.code || error?.message || "Unknown SMTP error");
    sendJson(response, 502, {
      message: "Gmail could not send the verification code. Check the recipient address and the local sender setup, then try again.",
    });
  }
}

async function handleConfirmVerification(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Use POST to confirm a verification code." }, { Allow: "POST" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { message: "The verification request was not valid." });
    return;
  }

  const email = normalizeEmail(body.email);
  const code = String(body.code || "").trim();
  if (!EMAIL_FORMAT.test(email) || !CODE_FORMAT.test(code)) {
    sendJson(response, 400, { message: "Enter the six-digit code from the verification email." });
    return;
  }

  const record = pendingCodes.get(email);
  if (!record || record.expiresAt <= Date.now()) {
    pendingCodes.delete(email);
    sendJson(response, 400, { message: "That code has expired. Send a new code and try again." });
    return;
  }

  record.attempts += 1;
  if (record.attempts > MAX_CODE_ATTEMPTS) {
    pendingCodes.delete(email);
    sendJson(response, 429, { message: "Too many incorrect attempts. Send a new code." });
    return;
  }

  const candidateHash = hashCode(email, code, record.salt);
  if (!constantTimeMatch(candidateHash, record.hash)) {
    sendJson(response, 400, { message: "That code is not correct. Check the email and try again." });
    return;
  }

  pendingCodes.delete(email);
  const verificationToken = randomBytes(32).toString("base64url");
  verifiedSessions.set(verificationToken, {
    email,
    expiresAt: Date.now() + VERIFIED_TTL_MS,
  });

  sendJson(response, 200, {
    verificationToken,
    message: "Email address verified.",
    expiresInSeconds: VERIFIED_TTL_MS / 1000,
  });
}

function validateLoginVerification(request, bodyBuffer) {
  const skipVerification = String(request.headers["x-customervision-skip-verification"] || "").toLowerCase() === "true";
  if (skipVerification) return { ok: true, skipped: true };

  const verificationToken = String(request.headers["x-customervision-verification"] || "");
  const session = verifiedSessions.get(verificationToken);
  if (!session || session.expiresAt <= Date.now()) {
    if (verificationToken) verifiedSessions.delete(verificationToken);
    return { ok: false, message: "Verify the email address again before signing in." };
  }

  try {
    const loginBody = JSON.parse(bodyBuffer.toString("utf8"));
    const loginEmail = normalizeEmail(loginBody.email);
    if (loginEmail !== session.email) {
      return { ok: false, message: "The verified email does not match the BriteBin login email." };
    }
  } catch {
    return { ok: false, message: "The BriteBin login request was not valid." };
  }

  return { ok: true };
}

async function handleApiProxy(request, requestUrl, response) {
  const targetPath = requestUrl.pathname.replace(/^\/api/, "") || "/";
  const targetUrl = `${API_BASE}${targetPath}${requestUrl.search}`;
  const method = request.method || "GET";
  const body = ["GET", "HEAD"].includes(method) ? undefined : await readRequestBody(request, 1024 * 1024);

  if (method === "POST" && targetPath.toLowerCase() === "/account/authentication/login") {
    const verification = validateLoginVerification(request, body || Buffer.alloc(0));
    if (!verification.ok) {
      sendJson(response, 403, { message: verification.message });
      return;
    }
  }

  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (
      !value
      || ["host", "connection", "content-length", "origin", "referer", "accept-encoding", "x-customervision-verification", "x-customervision-skip-verification"].includes(lowerKey)
      || lowerKey.startsWith("sec-")
    ) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "follow",
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    responseHeaders["Cache-Control"] = "no-store";

    response.writeHead(upstream.status, responseHeaders);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    sendJson(response, 502, { error: "CustomerVision could not reach the BriteBin API." });
  }
}

async function serveStatic(requestUrl, response) {
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
  let filePath = join(STATIC_ROOT, safePath);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = join(filePath, "index.html");
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    response.end(content);
  } catch {
    try {
      const content = await readFile(join(STATIC_ROOT, "index.html"));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(content);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("CustomerVision has not been built. Run npm run build first.");
    }
  }
}

function openBrowser(url) {
  if (process.argv.includes("--no-open")) return;
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, () => {});
}

function startServer(port) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (requestUrl.pathname === "/verification/status") {
        await handleVerificationStatus(response);
        return;
      }
      if (requestUrl.pathname === "/verification/send") {
        await handleSendVerification(request, response);
        return;
      }
      if (requestUrl.pathname === "/verification/confirm") {
        await handleConfirmVerification(request, response);
        return;
      }
      if (requestUrl.pathname === "/health") {
        sendJson(response, 200, { status: "ok", emailConfigured: EMAIL_CONFIGURED, sender: SMTP_USER });
        return;
      }
      if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
        await handleApiProxy(request, requestUrl, response);
        return;
      }
      await serveStatic(requestUrl, response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { message: "CustomerVision could not complete that request." });
      else response.end();
      console.error("Request failed:", error?.message || error);
    }
  });

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && port < START_PORT + 10) {
      startServer(port + 1);
      return;
    }
    console.error("Unable to start CustomerVision:", error.message);
    process.exitCode = 1;
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log("\nBriteBin CustomerVision is ready.");
    console.log(`Open: ${url}`);
    console.log(`Verification sender: ${SMTP_USER} (${EMAIL_CONFIGURED ? "configured" : "setup required"})`);
    console.log("Keep this window open while using the dashboard.\n");
    openBrowser(url);
  });
}

startServer(START_PORT);
