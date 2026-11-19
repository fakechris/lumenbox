// The smallest thing that stands where the egress proxy stands (INV-1756): a confined command
// reaches the network only through a loopback port, so the measurement's "ordinary commands still
// work" needs one. CONNECT only, no allow list — it runs on a disposable machine for one job.
// Prints the port it listens on, then serves until killed.

import { createServer } from "node:http";
import { connect } from "node:net";

const server = createServer((_request, response) => {
  response.writeHead(405).end("CONNECT only\n");
});
server.on("connect", (request, client, head) => {
  const [host, port] = (request.url ?? "").split(":");
  const upstream = connect(Number(port ?? 443), host ?? "", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  client.on("error", () => upstream.destroy());
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(typeof address === "object" && address !== null ? address.port : "");
});
