import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexCredentialFileName,
  buildSavedTokenFile,
  parseCodexIdTokenClaims
} from "./codex.js";

function buildUnsignedJwt(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

test("parseCodexIdTokenClaims reads plan and account data", () => {
  const token = buildUnsignedJwt({
    email: "user@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "plus"
    }
  });

  const claims = parseCodexIdTokenClaims(token);
  assert.equal(claims?.email, "user@example.com");
  assert.equal(claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type, "plus");
});

test("buildCodexCredentialFileName matches plan-specific naming", () => {
  assert.equal(buildCodexCredentialFileName("user@example.com", "plus", "acct_1"), "codex-user@example.com-plus.json");
  assert.match(buildCodexCredentialFileName("user@example.com", "team", "acct_1"), /^codex-[0-9a-f]{8}-user@example\.com-team\.json$/);
});

test("buildSavedTokenFile derives email and account id from id token", () => {
  const idToken = buildUnsignedJwt({
    email: "user@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro"
    }
  });
  const saved = buildSavedTokenFile({
    access_token: "at",
    refresh_token: "rt",
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600
  });

  assert.equal(saved.email, "user@example.com");
  assert.equal(saved.account_id, "acct_123");
  assert.equal(saved.type, "codex");
});
