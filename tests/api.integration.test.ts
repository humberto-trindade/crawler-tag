import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/crawler_tag";
process.env.LOG_LEVEL = "error";

let app: import("express").Express;
let staticServer: http.Server;
let staticOrigin = "";

before(async () => {
  const appModule = await import("../src/app.js");
  app = appModule.createApp();

  staticServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
      <head><script>window.gtag=function(){}</script></head>
      <body>
        <a href="/next">proximo</a>
        <form>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" />
          <input id="unknown_field" name="unknown_field" type="text" />
        </form>
      </body>
      </html>
    `);
  });

  await new Promise<void>((resolve) => {
    staticServer.listen(0, "127.0.0.1", () => {
      const address = staticServer.address();
      if (typeof address === "object" && address) {
        staticOrigin = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => staticServer.close(() => resolve()));
});

test("templates API should create and version templates", async () => {
  const createResponse = await request(app).post("/api/templates").send({
    name: `Template ${randomUUID()}`,
    createdBy: "test-user",
    data: {
      keys: [
        {
          key: "email",
          value: "qa@example.test",
          matchers: { attributes: ["email"], types: ["email"] },
        },
      ],
    },
  });

  assert.equal(createResponse.status, 201);
  const templateId = createResponse.body.id as string;
  assert.ok(templateId);

  const patchResponse = await request(app).patch(`/api/templates/${templateId}`).send({
    createdBy: "test-user",
    data: {
      keys: [
        {
          key: "email",
          value: "qa2@example.test",
          matchers: { attributes: ["email"], types: ["email"] },
        },
      ],
    },
  });

  assert.equal(patchResponse.status, 200);
  assert.equal(patchResponse.body.version, 2);

  const versionsResponse = await request(app).get(`/api/templates/${templateId}/versions`);
  assert.equal(versionsResponse.status, 200);
  assert.ok(Array.isArray(versionsResponse.body));
  assert.equal(versionsResponse.body.length, 2);
});

test("audit and execution flow should create events and report", async () => {
  const templateResponse = await request(app).post("/api/templates").send({
    name: `Execution Template ${randomUUID()}`,
    createdBy: "test-user",
    data: {
      keys: [
        {
          key: "email",
          value: "audit@example.test",
          matchers: { attributes: ["email"], types: ["email"] },
        },
      ],
    },
  });
  assert.equal(templateResponse.status, 201);

  const auditResponse = await request(app).post("/api/audits").send({
    name: `Audit ${randomUUID()}`,
    objective: "Inventariar eventos",
    createdBy: "test-user",
    templateId: templateResponse.body.id,
    urls: [
      {
        url: staticOrigin,
        depth: 1,
        maxActions: 20,
        maxStates: 20,
        allowedDomains: ["127.0.0.1"],
      },
    ],
    config: {
      technologies: ["ga4"],
      auditLevel: "inventory",
      syntheticPolicy: "ignore_unknown_fields",
      blockedActions: [],
      maxDurationMinutes: 10,
    },
  });
  assert.equal(auditResponse.status, 201);
  const auditId = auditResponse.body.id as string;

  const executionCreate = await request(app)
    .post(`/api/audits/${auditId}/executions`)
    .send({ platform: "web", environment: "local" });
  assert.equal(executionCreate.status, 201);
  const executionId = executionCreate.body.id as string;

  let status = executionCreate.body.status as string;
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (status === "completed" || status === "paused" || status === "failed") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const current = await request(app).get(`/api/audits/${auditId}/executions/${executionId}`);
    status = current.body.status as string;
  }

  assert.equal(status, "completed");

  const eventsResponse = await request(app).get(`/api/audits/${auditId}/executions/${executionId}/events`);
  assert.equal(eventsResponse.status, 200);
  assert.ok(eventsResponse.body.length >= 1);

  const reportResponse = await request(app).get(`/api/audits/${auditId}/executions/${executionId}/report`);
  assert.equal(reportResponse.status, 200);
  assert.ok(reportResponse.body.totals.events >= 1);

  const csvResponse = await request(app).get(
    `/api/audits/${auditId}/executions/${executionId}/export?format=csv`,
  );
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers["content-type"] ?? "", /text\/csv/);

  const jsonResponse = await request(app).get(
    `/api/audits/${auditId}/executions/${executionId}/export?format=json`,
  );
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers["content-type"] ?? "", /application\/json/);
  const jsonExport = jsonResponse.body as {
    report?: unknown;
    events?: unknown;
    journeyInventory?: unknown;
  };
  assert.ok(jsonExport.report);
  assert.ok(Array.isArray(jsonExport.events));
  assert.ok(jsonExport.journeyInventory);

  const pdfResponse = await request(app).get(
    `/api/audits/${auditId}/executions/${executionId}/export?format=pdf`,
  );
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers["content-type"] ?? "", /application\/pdf/);
  assert.ok(Buffer.isBuffer(pdfResponse.body));
});
