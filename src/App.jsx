import { useEffect, useMemo, useState } from "react";

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_FORMAT = /^\d{6}$/;

function findTokenDeep(value) {
  const keys = new Set(["token", "accessToken", "access_token", "jwt", "bearer", "id_token"]);
  let found = "";

  function walk(item) {
    if (!item || found) return;
    if (typeof item === "string") {
      if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(item)) found = item;
      return;
    }
    if (typeof item !== "object") return;
    if (Array.isArray(item)) return item.forEach(walk);

    for (const [key, child] of Object.entries(item)) {
      if (keys.has(key) && typeof child === "string" && child.length > 16) {
        found = child;
        return;
      }
      walk(child);
    }
  }

  walk(value);
  return found;
}

function getFirstArray(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 3) return [];
  for (const key of ["items", "data", "results", "units", "records"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = getFirstArray(child, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function findValue(object, patterns, depth = 0) {
  if (!object || typeof object !== "object" || depth > 3) return null;
  const entry = Object.entries(object).find(([key]) => patterns.some((pattern) => pattern.test(key)));
  if (entry) return entry[1];
  for (const child of Object.values(object)) {
    const found = findValue(child, patterns, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function extractMetrics(reading) {
  if (!reading || typeof reading !== "object") return { fill: null, battery: null, when: null };

  let fill = Number(findValue(reading, [/fill/i, /fullness/i, /level/i, /percent/i]));
  if (!Number.isFinite(fill)) fill = null;
  else if (fill > 0 && fill <= 1) fill = Math.round(fill * 100);

  let battery = Number(findValue(reading, [/battery/i, /vbat/i, /volt/i]));
  if (!Number.isFinite(battery)) battery = null;
  else if (battery > 100) battery = Math.round(battery) / 1000;

  const when = findValue(reading, [/timestamp/i, /created/i, /date/i, /time/i]);
  return { fill, battery, when: when ? String(when) : null };
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function flattenRecord(value, prefix = "", depth = 0) {
  if (value == null || typeof value !== "object") return [];
  const rows = [];

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix} / ${humanizeKey(key)}` : humanizeKey(key);
    if (child && typeof child === "object" && !Array.isArray(child) && depth < 3) {
      const nested = flattenRecord(child, path, depth + 1);
      if (nested.length) rows.push(...nested);
      else rows.push({ label: path, value: "—" });
    } else if (Array.isArray(child)) {
      rows.push({ label: path, value: child.length ? JSON.stringify(child) : "None" });
    } else if (typeof child === "boolean") {
      rows.push({ label: path, value: child ? "Yes" : "No" });
    } else {
      rows.push({ label: path, value: child == null || child === "" ? "—" : String(child) });
    }
  }

  return rows;
}

function PrettyJson({ value }) {
  return <pre className="json-view">{JSON.stringify(value ?? null, null, 2)}</pre>;
}

function DetailsGrid({ value, emptyText }) {
  const rows = useMemo(() => flattenRecord(value), [value]);
  if (!rows.length) return <p className="empty-details">{emptyText}</p>;

  return (
    <dl className="details-grid">
      {rows.map((row, index) => (
        <div className="detail-row" key={`${row.label}-${index}`}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function apiCall(path, options = {}, token = "") {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const response = await fetch(`/api${path.startsWith("/") ? path : `/${path}`}`, {
    ...options,
    headers,
  });

  const data = await readJsonResponse(response);
  return { ok: response.ok, status: response.status, data };
}

function verificationStatusContent(status, message) {
  const states = {
    idle: {
      tone: "neutral",
      title: "Verify this email address",
      text: "A six-digit code will be sent to this mailbox.",
    },
    sending: { tone: "info", title: "Sending code", text: "Please wait…" },
    sent: { tone: "info", title: "Code sent", text: message },
    checking: { tone: "info", title: "Checking code", text: "Please wait…" },
    verified: { tone: "success", title: "Email address verified", text: message },
    error: { tone: "danger", title: "Verification not completed", text: message },
    setup: { tone: "warning", title: "Email sender needs setup", text: message },
  };
  return states[status] || states.idle;
}

export default function App() {
  const [email, setEmail] = useState("");
  const [verifyEmail, setVerifyEmail] = useState(true);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [senderStatus, setSenderStatus] = useState({ configured: null, sender: "your-email@gmail.com" });
  const [verification, setVerification] = useState({
    status: "idle",
    email: "",
    message: "",
    verificationToken: "",
  });
  const [code, setCode] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [checkingCode, setCheckingCode] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginMessage, setLoginMessage] = useState("");

  const [serial, setSerial] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [binResult, setBinResult] = useState(null);

  const normalizedEmail = email.trim().toLowerCase();
  const emailIsVerified = verification.status === "verified"
    && verification.email === normalizedEmail
    && Boolean(verification.verificationToken);
  const verificationComplete = !verifyEmail || emailIsVerified;
  const visibleVerification = verification.email && verification.email !== normalizedEmail
    ? { status: "idle", message: "", email: normalizedEmail }
    : verification;
  const verificationContent = verificationStatusContent(visibleVerification.status, visibleVerification.message);

  useEffect(() => {
    let active = true;
    fetch("/verification/status")
      .then((response) => readJsonResponse(response))
      .then((data) => {
        if (active) setSenderStatus({ configured: Boolean(data.configured), sender: data.sender || "your-email@gmail.com" });
      })
      .catch(() => {
        if (active) setSenderStatus({ configured: false, sender: "your-email@gmail.com" });
      });
    return () => {
      active = false;
    };
  }, []);

  function handleEmailChange(event) {
    setEmail(event.target.value);
    setCode("");
    setPassword("");
    setLoginMessage("");
    setVerification({ status: "idle", email: "", message: "", verificationToken: "" });
  }

  async function sendVerificationCode() {
    setLoginMessage("");
    if (!EMAIL_FORMAT.test(normalizedEmail)) {
      setVerification({
        status: "error",
        email: normalizedEmail,
        message: "Enter a complete email address, such as name@example.com.",
        verificationToken: "",
      });
      return;
    }

    setSendingCode(true);
    setCode("");
    setVerification({ status: "sending", email: normalizedEmail, message: "", verificationToken: "" });

    try {
      const response = await fetch("/verification/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      const data = await readJsonResponse(response);
      if (!response.ok) {
        setVerification({
          status: response.status === 503 ? "setup" : "error",
          email: normalizedEmail,
          message: data.message || "The code could not be sent.",
          verificationToken: "",
        });
        return;
      }

      setVerification({
        status: "sent",
        email: normalizedEmail,
        message: data.message || `Enter the six-digit code sent to ${normalizedEmail}.`,
        verificationToken: "",
      });
    } catch {
      setVerification({
        status: "error",
        email: normalizedEmail,
        message: "CustomerVision could not send the code. Check the internet connection and try again.",
        verificationToken: "",
      });
    } finally {
      setSendingCode(false);
    }
  }

  async function confirmVerificationCode() {
    if (!CODE_FORMAT.test(code.trim())) {
      setVerification({
        ...verification,
        status: "error",
        message: "Enter the six-digit code from the email.",
        verificationToken: "",
      });
      return;
    }

    setCheckingCode(true);
    setVerification({ ...verification, status: "checking", message: "" });
    try {
      const response = await fetch("/verification/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, code: code.trim() }),
      });
      const data = await readJsonResponse(response);
      if (!response.ok || !data.verificationToken) {
        setVerification({
          status: "error",
          email: normalizedEmail,
          message: data.message || "That code was not accepted.",
          verificationToken: "",
        });
        return;
      }

      setVerification({
        status: "verified",
        email: normalizedEmail,
        message: `${normalizedEmail} received the verification code and is confirmed as an accessible mailbox.`,
        verificationToken: data.verificationToken,
      });
      setCode("");
    } catch {
      setVerification({
        status: "error",
        email: normalizedEmail,
        message: "The code could not be checked. Please try again.",
        verificationToken: "",
      });
    } finally {
      setCheckingCode(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginMessage("");
    if (verifyEmail && !emailIsVerified) {
      setLoginMessage("Verify the email address before signing in, or untick the verification option.");
      return;
    }

    setLoggingIn(true);
    try {
      const result = await apiCall("/account/authentication/login", {
        method: "POST",
        headers: verifyEmail
          ? { "X-CustomerVision-Verification": verification.verificationToken }
          : { "X-CustomerVision-Skip-Verification": "true" },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
          deviceToken: "",
          deviceType: 1,
        }),
      });

      const loginToken = findTokenDeep(result.data);
      if (!result.ok || !loginToken) {
        setToken("");
        if (result.status === 400 || result.status === 401 || result.status === 403 || result.status === 404) {
          setLoginMessage(verifyEmail
            ? "The mailbox is verified, but BriteBin did not accept this email and password."
            : "BriteBin did not accept this email and password.");
        } else {
          setLoginMessage(result.data?.message || "Sign-in was not completed. Please try again.");
        }
        return;
      }

      setToken(loginToken);
      setPassword("");
    } catch {
      setLoginMessage("CustomerVision could not reach BriteBin. Check the internet connection.");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleSearch(event) {
    event.preventDefault();
    if (!token || !serial.trim()) return;

    setSearching(true);
    setSearchMessage("");
    setBinResult(null);

    try {
      const serialValue = serial.trim();
      const check = await apiCall(
        `/unit/unit/CheckSerialNumber?serialNumber=${encodeURIComponent(serialValue)}`,
        { method: "GET" },
        token
      );
      if (!check.ok) {
        setSearchMessage("No matching bin was found for that serial number.");
        return;
      }

      const unitsResponse = await apiCall("/unit/unit/getUnits", {
        method: "POST",
        body: JSON.stringify({
          dataTableOptions: {
            search: serialValue,
            page: 1,
            perPage: 10,
            sortBy: "id",
            sortByDirection: "asc",
          },
          includeInactive: true,
        }),
      }, token);

      const unitSearchRecord = getFirstArray(unitsResponse.data)[0]
        || unitsResponse.data?.item
        || unitsResponse.data;
      const unitId = unitSearchRecord?.id || unitSearchRecord?.unitId || unitSearchRecord?.unitID;
      if (!unitId) {
        setSearchMessage("The serial is valid, but its bin details could not be loaded.");
        return;
      }

      const [detailsResponse, readingsResponse] = await Promise.all([
        apiCall(`/unit/unit/${encodeURIComponent(unitId)}`, { method: "GET" }, token),
        apiCall(
          `/unit/unit/readings?UnitId=${encodeURIComponent(unitId)}&page=1&perPage=1&sortBy=id&sortByDirection=desc&ForLastDays=30`,
          { method: "GET" },
          token
        ),
      ]);

      const latestReading = readingsResponse.ok
        ? (getFirstArray(readingsResponse.data)[0] || readingsResponse.data?.item || readingsResponse.data)
        : null;
      const unitDetails = detailsResponse.ok && detailsResponse.data
        ? detailsResponse.data
        : unitSearchRecord;

      setBinResult({
        serial: serialValue,
        unitId,
        unit: unitDetails,
        reading: latestReading,
        metrics: extractMetrics(latestReading),
        records: {
          serialCheck: check.data,
          unitSearch: unitsResponse.data,
          unitDetails: detailsResponse.data,
          readings: readingsResponse.data,
        },
      });
    } catch {
      setSearchMessage("The bin search could not be completed. Please try again.");
    } finally {
      setSearching(false);
    }
  }

  function signOut() {
    setToken("");
    setBinResult(null);
    setSearchMessage("");
    setSerial("");
    setPassword("");
    setCode("");
    setVerification({ status: "idle", email: "", message: "", verificationToken: "" });
  }

  return (
    <main className="app-shell">
      <section className="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow">BriteBin</p>
            <h1>CustomerVision</h1>
            <p className="subtitle">Sign in, optionally verify the email, then find a bin.</p>
          </div>
          <div className={`connection-pill ${token ? "connected" : ""}`}>
            <span className="connection-dot" />
            {token ? "Connected" : "Not connected"}
          </div>
        </header>

        <div className="content-grid">
          <section className="card login-card">
            <div className="card-heading">
              <span className="step-number">1</span>
              <div>
                <h2>Sign in</h2>
                <p>Choose whether to verify the email with a one-time code.</p>
              </div>
            </div>

            {!token ? (
              <form onSubmit={handleLogin} className="form-stack">
                <label>
                  <span>Email address</span>
                  <input
                    type="email"
                    value={email}
                    onChange={handleEmailChange}
                    placeholder="name@company.com"
                    autoComplete="email"
                  />
                </label>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={verifyEmail}
                    onChange={(event) => {
                      setVerifyEmail(event.target.checked);
                      setLoginMessage("");
                    }}
                  />
                  <span>Verify this email address before signing in</span>
                </label>

                {verifyEmail && <div className={`status-box ${verificationContent.tone}`}>
                  <span className="status-icon" />
                  <div>
                    <strong>{verificationContent.title}</strong>
                    <p>{verificationContent.text}</p>
                  </div>
                </div>}

                {verifyEmail && !emailIsVerified && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={sendVerificationCode}
                    disabled={sendingCode || checkingCode || !normalizedEmail}
                  >
                    {sendingCode ? "Sending code…" : visibleVerification.status === "sent" ? "Send a new code" : "Send verification code"}
                  </button>
                )}

                {verifyEmail && ["sent", "error", "checking"].includes(visibleVerification.status) && !emailIsVerified && (
                  <div className="code-row">
                    <label>
                      <span>Six-digit code</span>
                      <input
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength="6"
                        value={code}
                        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        autoComplete="one-time-code"
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-button verify-button"
                      onClick={confirmVerificationCode}
                      disabled={checkingCode || code.length !== 6}
                    >
                      {checkingCode ? "Checking…" : "Verify code"}
                    </button>
                  </div>
                )}

                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setLoginMessage("");
                    }}
                    placeholder={verificationComplete ? "Your BriteBin password" : "Verify the email first"}
                    autoComplete="current-password"
                    disabled={!verificationComplete}
                  />
                </label>

                {loginMessage && <p className="form-error">{loginMessage}</p>}

                <button
                  type="submit"
                  className="primary-button"
                  disabled={!verificationComplete || !password || loggingIn}
                >
                  {loggingIn ? "Signing in…" : "Sign in to BriteBin"}
                </button>

                {verifyEmail && (
                  <p className="sender-note">
                    Codes are sent from <strong>{senderStatus.sender}</strong>.
                    {senderStatus.configured === false && " Run the included email setup once before sending codes."}
                  </p>
                )}
              </form>
            ) : (
              <div className="signed-in-panel">
                <span className="success-mark">✓</span>
                <h3>Signed in</h3>
                <p>{normalizedEmail}</p>
                <small>Email access and the BriteBin account are confirmed.</small>
                <button type="button" className="text-button" onClick={signOut}>Sign out</button>
              </div>
            )}
          </section>

          <section className={`card search-card ${!token ? "disabled-card" : ""}`}>
            <div className="card-heading">
              <span className="step-number">2</span>
              <div>
                <h2>Find a bin</h2>
                <p>Enter the serial number to load the complete bin record.</p>
              </div>
            </div>

            <form onSubmit={handleSearch} className="search-form">
              <label>
                <span>Bin serial number</span>
                <input
                  value={serial}
                  onChange={(event) => {
                    setSerial(event.target.value);
                    setSearchMessage("");
                  }}
                  placeholder="Example: FC0FE7161D1A"
                  disabled={!token}
                />
              </label>
              <button type="submit" className="primary-button" disabled={!token || !serial.trim() || searching}>
                {searching ? "Searching…" : "Find bin"}
              </button>
            </form>

            {!token && <p className="locked-message">Complete step 1 to unlock bin search.</p>}
            {searchMessage && <p className="form-error search-error">{searchMessage}</p>}
            {binResult && (
              <div className="result-summary">
                <p className="result-label">Bin found</p>
                <h3>{binResult.serial}</h3>
                <p>Unit #{binResult.unitId}. Full information is shown below.</p>
              </div>
            )}
          </section>
        </div>

        {binResult && (
          <section className="card bin-details-card">
            <div className="bin-title-row">
              <div>
                <p className="result-label">Complete bin information</p>
                <h2>{binResult.serial}</h2>
              </div>
              <span className="result-id">Unit #{binResult.unitId}</span>
            </div>

            <div className="metrics-grid metrics-wide-grid">
              <div className="metric">
                <span>Latest fill level</span>
                <strong>{binResult.metrics.fill != null ? `${binResult.metrics.fill}%` : "—"}</strong>
              </div>
              <div className="metric">
                <span>Latest battery</span>
                <strong>{binResult.metrics.battery != null ? `${binResult.metrics.battery} V` : "—"}</strong>
              </div>
              <div className="metric metric-wide">
                <span>Latest reading time</span>
                <strong>{binResult.metrics.when || "—"}</strong>
              </div>
            </div>

            <div className="record-section">
              <h3>All unit details</h3>
              <p>Every field returned by the BriteBin unit-details endpoint.</p>
              <DetailsGrid value={binResult.unit} emptyText="No unit-detail fields were returned." />
            </div>

            <div className="record-section">
              <h3>Latest reading</h3>
              <p>Every field in the most recent reading returned for this bin.</p>
              <DetailsGrid value={binResult.reading} emptyText="No reading was returned for the last 30 days." />
            </div>

            <details className="raw-details" open>
              <summary>Complete unit record — original JSON</summary>
              <PrettyJson value={binResult.unit} />
            </details>

            <details className="raw-details">
              <summary>Complete latest reading — original JSON</summary>
              <PrettyJson value={binResult.reading} />
            </details>

            <details className="raw-details">
              <summary>Additional API records</summary>
              <PrettyJson value={binResult.records} />
            </details>
          </section>
        )}

        <footer>
          Email verification is optional. Codes expire after 10 minutes. CustomerVision does not store the BriteBin password.
        </footer>
      </section>
    </main>
  );
}
