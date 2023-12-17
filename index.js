#!/usr/bin/env node
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const WebSocket = require('ws');
const axios = require('axios').default;
const prompts = require('prompts');
const path = require('path');
const fs = require('fs-extra');

const { argv } = yargs(hideBin(process.argv))
  .option('token', {
    alias: 't',
    describe: 'Access token',
    type: 'string',
    default: '',
  })
  .option('address', {
    alias: 'a',
    describe: 'Main server address',
    type: 'string',
    default: '',
  })
  .option('silence', {
    alias: 's',
    describe: 'Silence',
    type: 'boolean',
    default: false,
  });

let { token, address, silence } = argv;

const confPath = path.join(process.env.HOME, 'feros-proxy-cfg.json');

let globalWs;
let allowReconnect = true;
let usedConfig = false;

// * Start
ferosProxy(address, token).catch();

// * Functions

async function ferosProxy(address, token, reconnect = false) {
  if (reconnect && usedConfig) {
    await fs.writeJson(confPath, { address, token, });
  }

  try {
    const conf = await fs.readJson(confPath);
    if (!address) {
      address = conf.address;
      usedConfig = true;
    }
    if (!token) {
      token = conf.token;
      usedConfig = true;
    }
  } catch { }

  let askSave = false;
  if (!address) {
    console.error('Need set ws address');
    do {
      const response = await prompts({
        type: 'text',
        name: 'address',
        message: 'WS address',
        // validate: (value) => {
        //   try {
        //     new URL(value);
        //     return true;
        //   } catch {
        //     return (`Invalid URL: ${address}`);
        //   }
        // }
      });
      address = String(response.address).trim();
      try {
        new URL(address);
      } catch {
        console.log(`Invalid URL: ${address}`);
        address = undefined;
      }
    } while (!address);
    askSave = true;
  }

  if (!token) {
    console.error('Need set ws token');
    do {
      const response = await prompts({
        type: 'text',
        name: 'token',
        message: 'Access token',
      });
      token = String(response.token).trim();
    } while (!token);
    askSave = true;
  }

  if (askSave) {
    const response = await prompts({
      type: 'confirm',
      name: 'save',
      message: 'Save token and address?',
      initial: true,
    });
    if (response.save) {
      await fs.writeJson(confPath, { address, token, });
      usedConfig = true;
    }
  }

  connect(address, token);
}

async function makeHttpRequest(ws, id, type, baseURL, method, url, data) {
  !silence && console.log(`[${new Date().toLocaleString()}]\tHTTP\t`, `[#${id}]\t`, type, baseURL, method, url);

  const makeResponse = (response, isError = false) => {
    ws.send(JSON.stringify({
      type: 'response',
      id,
      response,
      ...(isError ? { isError } : {}),
    }));
  }

  switch (type) {
    case 'octo_api': {
      const octoApi = axios({
        method,
        baseURL,
        url,
        timeout: 2e5,
        data,
      });

      octoApi
        .then(res => makeResponse({ data: res.data }))
        .catch(err => makeResponse(err, true));

      return true;
    }

    default:
      return null;
  }
}

const reverseWss = new Map();

async function initWebSocket(ws, id, wsEndpointUrl) {
  !silence && console.log(`[${new Date().toLocaleString()}]\t[WS] INIT\t`, `[#${id}]\t`, wsEndpointUrl);

  if (reverseWss.has(wsEndpointUrl)) {
    // return reverseWss.get(wsEndpointUrl);
    const wsEndpointData = reverseWss.get(wsEndpointUrl);
    wsEndpointData.wsEndpoint.close();
    reverseWss.delete(wsEndpointUrl);
  }

  const sendResponse = (response) => {
    ws.send(JSON.stringify({
      type: 'ws_init_response',
      id,
      response,
      wsEndpointUrl,
    }));
    id = undefined;
  }

  const wsEndpoint = new WebSocket(wsEndpointUrl);
  wsEndpoint.on('error', (error) => sendResponse({ error }));
  wsEndpoint.on('open', () => sendResponse({ open: true }));
  wsEndpoint.on('close', () => sendResponse({ close: true }));
  wsEndpoint.on('message', (data) => sendResponse({ data }));

  let wsEndpointData = { ws, wsEndpoint };

  reverseWss.set(wsEndpointUrl, wsEndpointData)
  return wsEndpointData;
}

async function sendWebSocket(ws, id, wsEndpointUrl, message) {
  !silence && console.log(`[${new Date().toLocaleString()}]\t[WS] SEND\t`, `[#${id}]\t`, wsEndpointUrl, message);

  const sendResponse = (data) => {
    ws.send(JSON.stringify({
      type: 'ws_response',
      id,
      response: { data },
      wsEndpointUrl,
    }));
  }

  if (!reverseWss.has(wsEndpointUrl)) {
    sendResponse({ close: true });
    return;
  }

  const wsEndpointData = reverseWss.get(wsEndpointUrl)
  wsEndpointData.wsEndpoint.send(message);
}

async function closeWebSocket(ws, id, wsEndpointUrl) {
  !silence && console.log(`[${new Date().toLocaleString()}]\t[WS] CLOSE\t`, `[#${id}]\t`, wsEndpointUrl);

  const sendResponse = (data) => {
    ws.send(JSON.stringify({
      type: 'ws_response',
      id,
      response: { data },
      wsEndpointUrl,
    }));
  }

  if (!reverseWss.has(wsEndpointUrl)) {
    sendResponse({ close: true });
    return;
  }

  const wsEndpointData = reverseWss.get(wsEndpointUrl)
  wsEndpointData.wsEndpoint.close();
}

let wsAttempts = 0;
function connect(address, token) {
  console.log(`[${new Date().toLocaleString()}]\tTry connect to [${address}]`);

  globalWs = new WebSocket(address, {
    headers: {
      Authorization: `Bearer ${token}`,
    }
  });

  globalWs.on('error', (err) => {
    console.error(`[${new Date().toLocaleString()}]\tWS error`, err.message);
    if (err.message === 'Unexpected server response: 401') {
      token = undefined;
    }
    if (err.code === 'ENETUNREACH') {
      address = undefined;
    }
  });

  globalWs.on('open', () => {
    console.log(`[${new Date().toLocaleString()}]\tConnected`);
    globalWs.send(Date.now());
    wsAttempts = 0;
  });

  globalWs.on('close', () => {
    console.log(`[${new Date().toLocaleString()}]\tDisconnected`);

    if (allowReconnect) {
      let sec = 5 + Math.min(++wsAttempts, 20);
      console.log(`Try reconnect in ${sec} sec...`);
      setTimeout(function timeout() {
        ferosProxy/* connect */(address, token, true);
      }, 1e3 * sec);
    }
  });

  globalWs.on('message', (data) => {
    // console.log(`[${new Date().toLocaleString()}]\tWS message`, data);

    try {
      /*
        id: string;
        payload: {
          type: string;
          [key: string]: any;
        }
      */
      const { id, payload } = JSON.parse(data);
      // console.log('payload', payload);
      if ('type' in payload && payload.type) {
        switch (payload.type) {
          case 'octo_api': {
            const { method, url, data, baseURL = 'http://127.0.0.1:58888' } = payload;
            makeHttpRequest(globalWs, id, payload.type, baseURL, method, url, data)
            break;
          }

          case 'ws_init': {
            const { wsEndpointUrl } = payload;
            initWebSocket(globalWs, id, wsEndpointUrl)
            break;
          }
          case 'ws_send': {
            const { wsEndpointUrl, message } = payload;
            sendWebSocket(globalWs, id, wsEndpointUrl, message)
            break;
          }
          case 'ws_close': {
            const { wsEndpointUrl } = payload;
            closeWebSocket(globalWs, id, wsEndpointUrl)
            break;
          }

          default: {
            break;
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  });
}
