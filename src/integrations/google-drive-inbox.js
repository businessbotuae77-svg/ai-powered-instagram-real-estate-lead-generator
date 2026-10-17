const DRIVE = "https://www.googleapis.com/drive/v3/files";

export function intakeError(code) {
  return Object.assign(new Error(code), { intakeCode: code });
}

export class GoogleDriveInbox {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.token = null;
  }

  configured() {
    return ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN",
      "WHATSAPP_INTAKE_DRIVE_FOLDER_ID"].every(key => Boolean(this.env[key]));
  }

  async accessToken() {
    if (this.token?.expires > Date.now() + 60000) return this.token.value;
    const response = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.env.GOOGLE_DRIVE_CLIENT_ID,
        client_secret: this.env.GOOGLE_DRIVE_CLIENT_SECRET, refresh_token: this.env.GOOGLE_DRIVE_REFRESH_TOKEN })
    });
    if (!response.ok) throw intakeError("drive_authorization_failed");
    const data = await response.json();
    if (!data.access_token) throw intakeError("drive_authorization_failed");
    this.token = { value: data.access_token, expires: Date.now() + Math.min(Number(data.expires_in) || 3600, 3600) * 1000 };
    return this.token.value;
  }

  async request(url, options = {}) {
    const response = await this.fetch(url, {
      ...options, redirect: "error", signal: AbortSignal.timeout(45000),
      headers: { ...options.headers, authorization: `Bearer ${await this.accessToken()}` }
    });
    if (response.status === 401) this.token = null;
    return response;
  }

  async reserveId() {
    const response = await this.request(`${DRIVE}/generateIds?count=1&space=drive&type=files`);
    if (!response.ok) throw intakeError("drive_id_failed");
    const data = await response.json();
    if (!/^[\w-]+$/.test(data.ids?.[0] || "")) throw intakeError("drive_id_failed");
    return data.ids[0];
  }

  async matches({ driveId, sha256, md5 }) {
    const response = await this.request(`${DRIVE}/${encodeURIComponent(driveId)}?fields=id,mimeType,md5Checksum,appProperties,trashed&supportsAllDrives=true`);
    if (response.status === 404) return false;
    if (!response.ok) throw intakeError("drive_lookup_failed");
    const file = await response.json();
    if (file.trashed || file.mimeType !== "application/pdf" || file.md5Checksum !== md5 || file.appProperties?.intakeSha256 !== sha256) {
      throw intakeError("drive_file_conflict");
    }
    return file.id === driveId;
  }

  async upload({ driveId, sha256, md5, filename, bytes }) {
    if (await this.matches({ driveId, sha256, md5 })) return;
    const response = await this.request("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id", {
      method: "POST", headers: { "content-type": "application/json", "x-upload-content-type": "application/pdf",
        "x-upload-content-length": String(bytes.length) },
      body: JSON.stringify({ id: driveId, name: filename, mimeType: "application/pdf",
        parents: [this.env.WHATSAPP_INTAKE_DRIVE_FOLDER_ID],
        appProperties: { intakeSource: "whatsapp", intakeSha256: sha256 } })
    });
    // A previous upload may have committed before its response was lost.
    if (response.status === 409 && await this.matches({ driveId, sha256, md5 })) return;
    if (!response.ok) throw intakeError("drive_upload_start_failed");
    const location = response.headers.get("location");
    let target;
    try { target = new URL(location); } catch { throw intakeError("drive_upload_location_invalid"); }
    if (target.protocol !== "https:" || target.hostname !== "www.googleapis.com" || target.port ||
        target.username || target.password || target.pathname !== "/upload/drive/v3/files") {
      throw intakeError("drive_upload_location_invalid");
    }
    const uploaded = await this.request(target.href, {
      method: "PUT", headers: { "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes
    });
    if (!uploaded.ok) throw intakeError("drive_upload_failed");
    if (!await this.matches({ driveId, sha256, md5 })) throw intakeError("drive_upload_unverified");
  }
}
