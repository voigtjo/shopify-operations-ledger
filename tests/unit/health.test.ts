import { describe, expect, it } from "vitest";

import { loader } from "../../app/routes/health";

describe("health route", () => {
  it("returns a minimal app health payload", async () => {
    const request = new Request("http://localhost/health");

    const response = await loader({
      request,
      unstable_url: new URL(request.url),
      unstable_pattern: "/health",
      context: {},
      params: {},
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "operations-ledger",
      path: "/health",
    });
  });
});
