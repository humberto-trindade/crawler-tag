import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { resolveFieldMapping } from "../src/crawler/fieldMapper.js";

test("maps synthetic values using labels and attributes", () => {
  const $ = cheerio.load(`
    <form>
      <label for="email">E-mail</label>
      <input id="email" name="customerEmail" type="email" />
    </form>
  `);

  const result = resolveFieldMapping($,   $("#email").get(0)!, [
    {
      key: "email",
      value: "qa@example.test",
      matchers: { attributes: ["email"], labels: ["e-mail"], types: ["email"] },
    },
  ]);

  assert.deepEqual(result, { type: "mapped", key: "email", value: "qa@example.test" });
});

test("does not guess when fields map ambiguously to different values", () => {
  const $ = cheerio.load('<input id="profile" name="profile" type="text" />');
  const result = resolveFieldMapping($, $("#profile").get(0)!, [
    { key: "first_name", value: "Ana", matchers: { attributes: ["profile"] } },
    { key: "last_name", value: "Silva", matchers: { attributes: ["profile"] } },
  ]);

  assert.deepEqual(result, { type: "ignored", reason: "ambiguous_mapping" });
});

test("ignores sensitive or unsupported input types", () => {
  const $ = cheerio.load('<input id="password" type="password" />');
  const result = resolveFieldMapping($, $("#password").get(0)!, [
    { key: "password", value: "synthetic", matchers: { attributes: ["password"] } },
  ]);

  assert.deepEqual(result, { type: "ignored", reason: "unsupported_type" });
});
