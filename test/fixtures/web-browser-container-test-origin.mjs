import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";

const CERTIFICATE_PATH = "/run/web-browser/test-cert.pem";
const PRIVATE_KEY_PATH = "/run/web-browser/test-key.pem";
const READY_PATH = "/run/web-browser-output/source-ready";
const REQUESTS_PATH = "/run/web-browser-output/source-requests.txt";

const [cert, key] = await Promise.all([
  readFile(CERTIFICATE_PATH),
  readFile(PRIVATE_KEY_PATH),
]);
const server = createServer({ cert, key }, async (request, response) => {
  await appendFile(REQUESTS_PATH, `${request.method} ${request.url}\n`, { mode: 0o600 });
  if (request.method === "GET" && request.url === "/login") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><html><body><form action="/login/submit" method="post"><input name="username" type="text"><input name="password" type="password"><button type="submit">Sign in</button></form></body></html>');
    return;
  }
  if (request.method === "POST" && request.url === "/login/submit") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (body !== "username=fixture-user&password=fixture-password") {
      response.writeHead(401, { "content-length": "0" });
      response.end();
      return;
    }
    response.writeHead(303, { location: "/js", "set-cookie": "fixture_session=accepted; Path=/; HttpOnly; Secure; SameSite=Strict", "content-length": "0" });
    response.end();
    return;
  }
  if (request.method !== "GET" || request.url !== "/js" || !request.headers.cookie?.includes("fixture_session=accepted")) {
    response.writeHead(404, { "content-length": "0" });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><p id="signed-in">Visible shell</p><script>
    document.body.insertAdjacentHTML('beforeend', '<p id="rendered">Rendered by JavaScript</p>');
  </script></body></html>`);
});

server.listen(8443, "0.0.0.0", async () => {
  await writeFile(READY_PATH, "ready\n", { flag: "wx", mode: 0o600 });
});
