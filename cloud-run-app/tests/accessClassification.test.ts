import assert from "node:assert/strict";
import test from "node:test";
import { classifyBlockedNavigation } from "../src/crawler/accessClassification.js";

test("classifies an HTTP 403 human verification page as a challenge", () => {
  assert.equal(
    classifyBlockedNavigation(403, "Verificação humana", "<main>Verify you are human</main>"),
    "challenge_detected",
  );
});

test("classifies a bare HTTP 403 response as a WAF block", () => {
  assert.equal(
    classifyBlockedNavigation(403, "Access denied", "<main>Request blocked</main>"),
    "blocked_by_waf",
  );
});
