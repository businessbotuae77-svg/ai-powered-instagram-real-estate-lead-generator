import { createPrivateKey, sign } from "node:crypto";

export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleSheetsError(code) {
  const error = new Error(`Google Sheets catalogue unavailable (${code}).`);
  error.code = code;
  return error;
}

/** No impersonation or configurable token endpoint: this account reads one shared private workbook. */
export function createGoogleTokenProvider(raw, { fetchImpl = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  let account, key;
  try {
    account = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (account?.type !== "service_account" || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email || "")) throw new Error();
    key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
  } catch { throw googleSheetsError("invalid_credentials"); }
  let cached = null, pending = null;
  return async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const issued = Math.floor(now() / 1000);
      const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
      const claims = { iss: account.client_email, scope: SHEETS_READONLY_SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 };
      const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
      const content = `${encode(header)}.${encode(claims)}`;
      const assertion = `${content}.${sign("RSA-SHA256", Buffer.from(content), key).toString("base64url")}`;
      try {
        const response = await fetchImpl(TOKEN_URL, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
        if (!response.ok) throw googleSheetsError("authentication_failed");
        const body = await response.json();
        if (typeof body.access_token !== "string" || !body.access_token.trim() || body.token_type !== "Bearer" ||
            !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 30 ||
            (body.scope && body.scope !== SHEETS_READONLY_SCOPE)) throw googleSheetsError("invalid_token_response");
        cached = { token: body.access_token, expiresAt: now() + (Math.min(3600, Number(body.expires_in)) - 30) * 1000 };
        return cached.token;
      } catch (error) {
        if (["authentication_failed", "invalid_token_response"].includes(error.code)) throw error;
        throw googleSheetsError(error.name === "AbortError" || error.name === "TimeoutError" ? "authentication_timeout" : "authentication_failed");
      }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
