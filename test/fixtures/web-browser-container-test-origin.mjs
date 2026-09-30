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
  if (request.url !== "/js") {
    response.writeHead(404, { "content-length": "0" });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><p>Visible shell</p><script>
    document.body.insertAdjacentHTML('beforeend', '<p id="rendered">Rendered by JavaScript</p>');
  </script></body></html>`);
});

server.listen(8443, "0.0.0.0", async () => {
  await writeFile(READY_PATH, "ready\n", { flag: "wx", mode: 0o600 });
});
