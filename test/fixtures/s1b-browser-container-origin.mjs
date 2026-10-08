import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";

const CERTIFICATE_PATH = "/run/web-browser/test-cert.pem";
const PRIVATE_KEY_PATH = "/run/web-browser/test-key.pem";
const OUTPUT_DIRECTORY = "/run/web-browser-output";
const READY_PATH = `${OUTPUT_DIRECTORY}/source-ready`;
const REQUESTS_PATH = `${OUTPUT_DIRECTORY}/source-requests.txt`;
const HOLD_PATH = `${OUTPUT_DIRECTORY}/hold-requested`;
const USERNAME = "s1b-owner-fixture";
const PASSWORD = "SyntheticPassword391";

const [cert, key] = await Promise.all([
  readFile(CERTIFICATE_PATH),
  readFile(PRIVATE_KEY_PATH),
]);
const server = createServer({ cert, key }, async (request, response) => {
  const methodPath = `${request.method ?? "GET"} ${request.url ?? "/"}`;
  await appendFile(REQUESTS_PATH, `${methodPath}\n`, { mode: 0o600 });

  if (request.method === "GET" && request.url === "/rendered-js") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><p>Static shell</p><script>
      document.body.insertAdjacentHTML('beforeend', '<p id="rendered">S1B_COMPOSED_PUBLIC_JS_RENDERED</p>');
    </script></body></html>`);
    return;
  }

  if (request.method === "GET" && request.url === "/login") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><html><body><form action="/login/submit" method="post"><input name="username" type="text"><input name="password" type="password"><button type="submit">Sign in</button></form></body></html>');
    return;
  }

  if (request.method === "POST" && request.url === "/login/submit") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (body !== `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`) {
      response.writeHead(401, { "content-length": "0" });
      response.end();
      return;
    }
    response.writeHead(303, {
      location: "/private-js",
      "set-cookie": "s1b_fixture_session=accepted; Path=/; HttpOnly; Secure; SameSite=Strict",
      "content-length": "0",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/private-js" && request.headers.cookie?.includes("s1b_fixture_session=accepted")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><p id="signed-in">Signed in</p><script>
      document.body.insertAdjacentHTML('beforeend', '<p id="private">S1B_COMPOSED_PRIVATE_OWNER_PREVIEW</p>');
    </script></body></html>`);
    return;
  }

  if (request.method === "GET" && request.url === "/hold") {
    await writeFile(HOLD_PATH, "requested\n", { flag: "wx", mode: 0o600 });
    return;
  }

  response.writeHead(404, { "content-length": "0" });
  response.end();
});

server.listen(8443, "0.0.0.0", async () => {
  await writeFile(READY_PATH, "ready\n", { flag: "wx", mode: 0o600 });
});
