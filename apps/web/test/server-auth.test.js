import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../scripts/server.mjs";

const passwordHash = "$2a$14$NlifRDOzfgyhGyNAIXT3YujBT2ChqXY26SkTMMMg4PYGf/TMpCiAS";
const sessionToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("web login endpoint", () => {
  let server;
  let origin;

  beforeAll(async () => {
    const instance = createWebServer({
      host: "127.0.0.1",
      port: 0,
      authUsername: "mimex",
      authPasswordHash: passwordHash,
      authSessionToken: sessionToken
    });
    server = instance.server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("rejects a bad password without a Basic Auth challenge", async () => {
    const response = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mimex", password: "wrong" })
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("issues the secure session cookie for valid credentials", async () => {
    const response = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mimex", password: "testpass" })
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(
      `mimex_session=${sessionToken}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Strict`
    );
  });

  it("rejects non-POST login requests", async () => {
    const response = await fetch(`${origin}/auth/login`);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
