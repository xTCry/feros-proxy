#!/usr/bin/env node
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const http = require('http');
const httpProxy = require('http-proxy');

const { argv } = yargs(hideBin(process.argv))
  .option('port', {
    alias: 'p',
    describe: 'Port',
    type: 'number',
    default: 27072,
  })
  .option('hostname', {
    alias: 'h',
    describe: 'Hostname',
    type: 'string',
    default: '0.0.0.0',
  })
  .option('silence', {
    alias: 's',
    describe: 'Silence',
    type: 'boolean',
    default: false,
  });
const { port, hostname, silence } = argv;

// Start
ferosProxy(port, hostname)

function ferosProxy(port, hostname) {
  const proxy = httpProxy.createProxyServer({ ws: true });

  http
    .createServer(function (req, res) {
      const path = req.url;
      !silence && console.log(`[${new Date().toLocaleString()}]\tHTTP\t`, req.method, req.url);

      if (!path.startsWith('/forward/')) {
        res.end('FF');
        return;
      }

      req.url = req.url.replace(/\/forward\/([0-9]{1,5})?/i, '');
      // console.log('TOO', req.method, req.url, req.headers);

      let target = 'http://127.0.0.1:' + path.replace('/forward/', '');
      proxy.web(req, res, { target, changeOrigin: true, prependPath: false });
    })
    .on('upgrade', function (req, socket, head) {
      const path = req.url;
      !silence && console.log(`[${new Date().toLocaleString()}]\tWS\t`, req.method, req.url);

      if (!path.startsWith('/forward/')) {
        socket.end('');
        return;
      }

      req.url = req.url.replace(/\/forward\/([0-9]{1,5})?/i, '');

      let target = 'ws://127.0.0.1:' + path.replace('/forward/', '');
      proxy.ws(req, socket, head, { target, changeOrigin: true, prependPath: false });
    })
    .listen(port, hostname)
    .on('error', console.log);
  console.log(`[${new Date().toLocaleString()}]\tListening on http://${hostname}:${port}`, port);
}
