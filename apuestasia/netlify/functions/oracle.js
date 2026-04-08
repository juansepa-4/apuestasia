exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "Method Not Allowed" };

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "analyze";

    // ── ANALYZE: proxy a Anthropic ─────────────────────────────────────────
    if (action === "analyze") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 5000,
          system: body.system,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: body.messages || [],
        }),
      });
      const data = await r.json();
      return {
        statusCode: r.ok ? 200 : r.status,
        headers: { ...CORS, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      };
    }

    // ── SAVE_PREDICTIONS: guardar en Google Sheets ────────────────────────
    if (action === "save_predictions") {
      const SHEET_ID = process.env.GOOGLE_SHEET_ID;
      const SA_KEY   = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      if (!SHEET_ID || !SA_KEY) {
        return ok(CORS, { saved: false, msg: "Google Sheets no configurado — datos guardados localmente en el dispositivo." });
      }
      const { predictions, date, sport } = body;
      const token = await getToken(SA_KEY);
      const rows = (predictions || []).map(p => [
        date, sport || "", p.league || "", p.match || "", p.time || "",
        p.market || "", p.category || "", p.pick || "",
        p.confidence || "", p.fair_odds || "", p.best_odds || "",
        p.best_house || "", p.value_pct?.toFixed(1) || "", p.risk_level || "",
        "1", "", "", "", "", ""
      ]);
      const res = await sheetsAppend(SHEET_ID, token, "📋 Registro Diario", rows);
      return ok(CORS, { saved: true, updated: res.updates?.updatedRows || rows.length });
    }

    // ── SAVE_VALIDATION: guardar resultado real en Sheets ─────────────────
    if (action === "save_validation") {
      const SHEET_ID = process.env.GOOGLE_SHEET_ID;
      const SA_KEY   = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      if (!SHEET_ID || !SA_KEY) {
        return ok(CORS, { saved: false, msg: "Google Sheets no configurado." });
      }
      const { results, date } = body;
      const token = await getToken(SA_KEY);
      const rows = (results || []).map(r => [
        date, r.sport || "", r.match || "", r.pick || "", r.market || "",
        r.category || "", r.best_odds || "", "1",
        r.real_result || r.real_stat || "", r.hit ? "SI" : "NO",
        "", "", r.notes || "", ""
      ]);
      const res = await sheetsAppend(SHEET_ID, token, "✅ Validación", rows);
      return ok(CORS, { saved: true, updated: res.updates?.updatedRows || rows.length });
    }

    // ── SAVE_ADJUSTMENT: guardar ajuste de aprendizaje ────────────────────
    if (action === "save_adjustment") {
      const SHEET_ID = process.env.GOOGLE_SHEET_ID;
      const SA_KEY   = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      if (!SHEET_ID || !SA_KEY) {
        return ok(CORS, { saved: false, msg: "Google Sheets no configurado." });
      }
      const { adjustments, date } = body;
      const token = await getToken(SA_KEY);
      const rows = (adjustments || []).map((adj, i) => [
        i + 1, adj, "Global", date, "Pendiente evaluación", "ACTIVO", "", ""
      ]);
      const res = await sheetsAppend(SHEET_ID, token, "📊 Dashboard", rows);
      return ok(CORS, { saved: true, updated: res.updates?.updatedRows || rows.length });
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Acción no reconocida" }) };

  } catch (err) {
    console.error("Oracle function error:", err);
    return {
      statusCode: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: err.message } }),
    };
  }
};

function ok(cors, data) {
  return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

async function sheetsAppend(sheetId, token, sheetName, rows) {
  const encoded = encodeURIComponent(sheetName);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encoded}!A:T:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  return res.json();
}

async function getToken(saKeyStr) {
  const sa = JSON.parse(saKeyStr);
  const now = Math.floor(Date.now() / 1000);
  const hdr = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const clm = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  }));
  const key = await crypto.subtle.importKey("pkcs8", pem2buf(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(`${hdr}.${clm}`));
  const jwt = `${hdr}.${clm}.${buf2b64(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  return (await r.json()).access_token;
}

function base64url(str) { return btoa(str).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,""); }
function buf2b64(buf) { return base64url(String.fromCharCode(...new Uint8Array(buf))); }
function pem2buf(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g,"").replace(/\s/g,"");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i);
  return buf.buffer;
}
