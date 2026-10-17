# WhatsApp developer PDF inbox

The opt-in `/webhook/whatsapp-intake` endpoint receives PDF documents from
explicitly allowed WhatsApp senders, checks Meta's signature and the receiving
account, durably queues the event, and uploads the original bytes into the
configured private Drive inbox. The existing document-intake agent can then
sort files and add reviewable evidence to Airtable.

This receiver does not send WhatsApp replies, produce property facts, update
Airtable, or enable outbound broker alerts. The ordinary Instagram webhook
continues to use its own configuration.

## Configuration

Set these on the receiving server, using the Railway dashboard for secrets.
Never put credentials in the repository, PR, source PDF, or runtime logs.

| Variable | Required value |
| --- | --- |
| `WHATSAPP_INTAKE_ENABLED` | `true` only after authorization and setup are complete; defaults to disabled |
| `WHATSAPP_INTAKE_ACCESS_TOKEN` | A token authorized to download media for this WhatsApp account; a short-lived dashboard token needs replacement before continuous operation |
| `WHATSAPP_INTAKE_PHONE_NUMBER_ID` | The receiving phone-number ID from Meta |
| `WHATSAPP_INTAKE_WABA_ID` | The receiving WhatsApp Business Account ID |
| `WHATSAPP_INTAKE_APP_SECRET` | Signing secret of the Meta app delivering this WhatsApp webhook; do not assume the Instagram app secret is the same |
| `WHATSAPP_INTAKE_VERIFY_TOKEN` | A random secret chosen for webhook verification, also entered in Meta |
| `WHATSAPP_INTAKE_ALLOWED_SENDERS` | Comma-separated sender numbers in international digits only, without `+`; empty denies intake |
| `WHATSAPP_INTAKE_DRIVE_FOLDER_ID` | The exact private Developer files inbox folder ID |
| `GOOGLE_DRIVE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Offline OAuth authorization for the Drive account owning the inbox |
| `WHATSAPP_INTAKE_GRAPH_VERSION` | Optional supported Graph API version, default `v23.0` |
| `RUNTIME_DATA_DIR` | Durable storage; use the existing `/data` Railway volume in production |

The server's Drive authorization is separate from a user's connected ChatGPT
Drive app. Authorize the Google OAuth client once for offline access using the
account owning the inbox. The authorization must include that existing folder:
`drive.file` requires explicit access granted to this app, for example through
Google Picker; otherwise an appropriate Drive scope is needed. Verify the
account can create files in the intended inbox. Do not use an unrelated Google
account, upload to My Drive root by accident, or treat merely sharing a My Drive
folder with an unauthenticated server as authorization.

## Connect and verify

1. Deploy the code only after reviewing the change and configuring the secrets.
   Keep one server replica: the queue has one writer on the existing volume.
2. Confirm `/api/health` reports `integrations.whatsappDocumentIntake.enabled`
   and `configured` as true. These flags check configuration presence, not that
   the external credentials are valid.
3. In the correct Meta app, configure callback URL
   `https://<server-domain>/webhook/whatsapp-intake` and the exact verification
   token. Subscribe to the WhatsApp `messages` field and subscribe that app to
   the intended WABA. This setup is separate from Instagram subscriptions.
4. From the allowed sender, forward one known PDF under 15 MiB to the receiving
   WhatsApp number. Confirm its original bytes and source SHA-256 reach the
   intended Drive folder. Check a redelivery produces no second upload.
5. Confirm the existing intake agent subsequently puts it in the correct
   project dossier and Airtable review fields. Its normal cadence still applies;
   a successful upload does not prove sorting or data extraction succeeded.

## Delivery behavior and limits

- The server validates the signature over the original request bytes, exact
  WABA and phone IDs, sender allowlist, document MIME type, downloaded size,
  PDF header and Meta's SHA-256 checksum. It refuses unexpected media hosts or
  redirects before sending a credential to them.
- Request bodies are limited to 1 MiB; documents are limited to 15 MiB to bound
  memory on the existing bot server. Larger documents must use the Drive inbox
  directly. Unsupported messages are ignored; no conversation engine runs.
- Events are acknowledged only after durable queue acceptance. A storage
  failure returns 503 so Meta can retry. The worker serializes deliveries and
  retries failures with backoff, fetching a fresh media URL on each attempt.
- A Drive ID is reserved and persisted before upload. Readback checks the
  original MD5 and intake SHA-256 property. Lost upload responses recover that
  ID, including after sorting moves the file to another folder. An existing
  conflicting or trashed file is not overwritten or restored automatically.
- The queue retains up to 5,000 jobs, evicting completed jobs first. Content
  and message deduplication cover retained history; downstream source-hash
  deduplication is still required for older forwards. If all retained jobs are
  pending, new acceptance fails retryably rather than discarding queued work.
- Queue state stays in `whatsapp-document-intake.json` on the private runtime
  volume. It records delivery state and generic failure categories, not tokens
  or the full WhatsApp message. Failed deliveries remain pending for operator
  review/retry; permanent credential, size or integrity failures require fixing
  the cause. This feature does not automatically notify the broker of failures.

Before calling this connection live, verify a real forwarded PDF end to end.
Offline tests use fake credentials and mocked HTTP only.

## References

- [Meta Cloud API and webhook subscription](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-eb9a6721-1056-4db2-b00a-2290e04b5b5d)
- [Meta media download](https://www.postman.com/meta/whatsapp-business-platform/request/zsq66eh/download-media)
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google Drive pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file#generate-ids)
- [Google OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
