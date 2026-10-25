import { createServer } from "node:http";

export async function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = createServer(async (request, response) => {
    try {
      const result = await fetch(new Request(`http://${request.headers.host}${request.url}`, { method: request.method }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
  return {
    port: address.port,
    async stop(force = false) {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (force) server.closeAllConnections();
      await closed;
    },
  };
}
