import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  composeReplyWithModel,
  extractFirstJsonObject,
  formatViolation,
  maskDigits,
  truncate
} from "../src/conversation/llm.js";

describe("extractFirstJsonObject", () => {
  it("parses raw JSON without fences", () => {
    const input = '{"message":"Hello","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const result = extractFirstJsonObject(input);
    assert.equal(result, input);
  });

  it("parses JSON wrapped in ```json fence", () => {
    const json = '{"message":"Hello","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const input = "```json\n" + json + "\n```";
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("parses JSON wrapped in bare ``` fence", () => {
    const json = '{"message":"Hello","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const input = "```\n" + json + "\n```";
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("parses JSON with leading prose", () => {
    const json = '{"message":"Hello","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const input = "Here is my response:\n" + json;
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("parses JSON with trailing prose", () => {
    const json = '{"message":"Hello","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const input = json + "\nI hope this helps!";
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("parses JSON with prose before and after", () => {
    const json = '{"message":"Hello","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const input = "Sure, here it is:\n" + json + "\nLet me know if you need changes.";
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("returns null for garbage input", () => {
    const input = "This is just some random text without any JSON.";
    const result = extractFirstJsonObject(input);
    assert.equal(result, null);
  });

  it("returns null for incomplete JSON object", () => {
    const input = '{"message": "Hello';
    const result = extractFirstJsonObject(input);
    assert.equal(result, null);
  });

  it("handles nested objects correctly", () => {
    const json = '{"message":"Hello","claims":[{"text":"price","value":{"amount":1000}}],"askedQuestion":false}';
    const input = "Response: " + json + " Done.";
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("handles strings containing braces correctly", () => {
    const json = '{"message":"Use { and } for objects","askedQuestion":false}';
    const input = json;
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });

  it("handles escaped quotes in strings", () => {
    const json = '{"message":"He said \\"hello\\"","askedQuestion":false}';
    const input = json;
    const result = extractFirstJsonObject(input);
    assert.equal(result, json);
  });
});

describe("formatViolation", () => {
  it("formats violation with type field", () => {
    const violation = { type: "empty_message" };
    const result = formatViolation(violation);
    assert.equal(result, "type=empty_message");
  });

  it("formats violation with multiple fields", () => {
    const violation = { type: "citation_claim_mismatch", projectId: "proj-123", field: "price" };
    const result = formatViolation(violation);
    assert.ok(result.includes("type=citation_claim_mismatch"));
    assert.ok(result.includes("projectId=proj-123"));
    assert.ok(result.includes("field=price"));
  });

  it("does not contain [object Object]", () => {
    const violation = { type: "some_error", field: "budget", code: "X123" };
    const result = formatViolation(violation);
    assert.ok(!result.includes("[object Object]"));
  });

  it("truncates long violations to ~200 characters", () => {
    const violation = {
      type: "very_long_error_type_name_that_goes_on_and_on",
      field: "some_very_long_field_name_here",
      code: "VERYLONGCODE123456789",
      reason: "This is an extremely long reason that explains what went wrong in great detail",
      projectId: "project-with-a-very-long-identifier-12345",
      unitId: "unit-with-long-id-67890"
    };
    const result = formatViolation(violation);
    assert.ok(result.length <= 203); // 200 + "..."
  });

  it("handles non-object violations gracefully", () => {
    assert.equal(formatViolation("string error"), "string error");
    assert.equal(formatViolation(null), "null");
    assert.equal(formatViolation(undefined), "undefined");
  });
});

describe("maskDigits", () => {
  it("replaces digits with X", () => {
    const result = maskDigits("Phone: 123-456-7890");
    assert.equal(result, "Phone: XXX-XXX-XXXX");
  });

  it("masks digits in email addresses", () => {
    const result = maskDigits("user123@example.com");
    assert.equal(result, "userXXX@example.com");
  });

  it("masks prices", () => {
    const result = maskDigits("Price: AED 1,500,000");
    assert.equal(result, "Price: AED X,XXX,XXX");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncate("short", 80), "short");
  });

  it("truncates long text", () => {
    const long = "a".repeat(100);
    const result = truncate(long, 80);
    assert.equal(result.length, 83); // 80 + "..."
    assert.ok(result.endsWith("..."));
  });
});

describe("composeReplyWithModel", () => {
  let logs = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    logs = [];
    console.warn = (...args) => logs.push(args.join(" "));
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it("returns null and logs for non-OK HTTP response", async () => {
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({ ok: false, status: 500 })
    };
    const result = await composeReplyWithModel(client, {});
    assert.equal(result, null);
    const statusLog = logs.find(log => log.includes("non-OK HTTP response"));
    assert.ok(statusLog, "should log non-OK HTTP response");
    assert.ok(statusLog.includes("500"), "should include status code");
  });

  it("returns null and logs for JSON parse failure with garbage", async () => {
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "This is not JSON at all" }] })
      })
    };
    const result = await composeReplyWithModel(client, {});
    assert.equal(result, null);
    const parseLog = logs.find(log => log.includes("JSON parse failure"));
    assert.ok(parseLog, "should log JSON parse failure");
    assert.ok(parseLog.includes("no valid JSON object found"), "should include reason");
    assert.ok(parseLog.includes("text length"), "should include text length");
  });

  it("logs masked preview without buyer phone/email", async () => {
    const textWithPii = "Error 12345: contact buyer at 555-123-4567 or email@test.com";
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: textWithPii }] })
      })
    };
    const result = await composeReplyWithModel(client, {});
    assert.equal(result, null);
    const parseLog = logs.find(log => log.includes("JSON parse failure"));
    assert.ok(parseLog, "should log JSON parse failure");
    assert.ok(!parseLog.includes("12345"), "should not include digits (phone)");
    assert.ok(!parseLog.includes("555-123-4567"), "should not include phone number");
    assert.ok(parseLog.includes("XXX-XXX-XXXX") || parseLog.includes("XXXXX"), "should have masked digits");
  });

  it("parses fenced JSON successfully", async () => {
    const validJson = '{"message":"Hello buyer!","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const fencedResponse = "```json\n" + validJson + "\n```";
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: fencedResponse }] })
      })
    };
    const result = await composeReplyWithModel(client, { validationOptions: { allowMultipleQuestions: true } });
    assert.ok(result, "should parse fenced JSON successfully");
    assert.equal(result.message, "Hello buyer!");
  });

  it("parses bare fence JSON successfully", async () => {
    const validJson = '{"message":"Hello from bare fence!","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const fencedResponse = "```\n" + validJson + "\n```";
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: fencedResponse }] })
      })
    };
    const result = await composeReplyWithModel(client, { validationOptions: { allowMultipleQuestions: true } });
    assert.ok(result, "should parse bare fence JSON successfully");
    assert.equal(result.message, "Hello from bare fence!");
  });

  it("parses JSON with prose around it successfully", async () => {
    const validJson = '{"message":"Extracted from prose!","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const responseWithProse = "Sure, here is my response:\n" + validJson + "\nLet me know if this works.";
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: responseWithProse }] })
      })
    };
    const result = await composeReplyWithModel(client, { validationOptions: { allowMultipleQuestions: true } });
    assert.ok(result, "should parse JSON with surrounding prose");
    assert.equal(result.message, "Extracted from prose!");
  });

  it("logs readable violation text, not [object Object]", async () => {
    const jsonWithViolations = '{"message":"I will call you at 555-1234","askedQuestion":false,"questionField":null,"claims":[],"proposedActions":[]}';
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: jsonWithViolations }] })
      })
    };
    const result = await composeReplyWithModel(client, { buyer: { noCalls: true } });
    assert.equal(result, null, "should reject violation");
    const rejectionLog = logs.find(log => log.includes("model reply rejected"));
    assert.ok(rejectionLog, "should log rejection");
    assert.ok(!rejectionLog.includes("[object Object]"), "should not contain [object Object]");
    assert.ok(rejectionLog.includes("type="), "should contain readable violation format");
  });

  it("logs shape check failure for invalid shape", async () => {
    const invalidShape = '{"notMessage":"wrong field"}';
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: invalidShape }] })
      })
    };
    const result = await composeReplyWithModel(client, {});
    assert.equal(result, null);
    const shapeLog = logs.find(log => log.includes("shape check failed"));
    assert.ok(shapeLog, "should log shape check failure");
  });

  it("no buyer message text appears in any log from the input options", async () => {
    const buyerMessage = "I want to buy property for my family";
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "This response fails parsing" }] })
      })
    };
    await composeReplyWithModel(client, { message: buyerMessage });
    for (const log of logs) {
      assert.ok(!log.includes(buyerMessage), "buyer message from options should not appear in logs");
    }
  });

  it("digits in model response preview are masked", async () => {
    const responseWithNumbers = "Error 12345 call 555-867-5309";
    const client = {
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://test.api",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: responseWithNumbers }] })
      })
    };
    await composeReplyWithModel(client, {});
    const parseLog = logs.find(log => log.includes("JSON parse failure"));
    assert.ok(parseLog, "should log parse failure");
    assert.ok(!parseLog.includes("12345"), "should not include raw digits");
    assert.ok(!parseLog.includes("555-867-5309"), "should not include phone-like digits");
    assert.ok(parseLog.includes("XXX-XXX-XXXX") || parseLog.includes("XXXXX"), "should have masked digits");
  });
});
