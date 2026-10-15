import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

test("GET /health returns 200 and service payload", async () => {
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

  const { createApp } = await import("../src/app.js");
  const app = createApp();

  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, "crawler-tag-backend");
  assert.ok(response.body.timestamp);
});
