import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const CONVERSATION_POLICY = readFileSync(new URL("../../prompts/conversation-policy.md", import.meta.url), "utf8");
export const POLICY_VERSION = createHash("sha256").update(CONVERSATION_POLICY).digest("hex").slice(0, 12);
