import http from "node:http";
import net from "node:net";

const listenHost = process.argv[2] ?? "0.0.0.0";
const listenPort = Number(process.argv[3] ?? "3000");
const targetHost = "::1";
const targetPort = 3000;

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${targetPort}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    res.writeHead(502);
    res.end(`Proxy error: ${error.message}`);
  });

  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(targetPort, targetHost, () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [key, value] of Object.entries(req.headers)) {
      upstream.write(`${key}: ${key.toLowerCase() === "host" ? `localhost:${targetPort}` : value}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.log(`LAN URL: http://${listenHost}:${listenPort}/`);
});
