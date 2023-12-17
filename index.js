#!/usr/bin/env node
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const WebSocket = require('ws');
const axios = require('axios').default;
const prompts = require('prompts');
const path = require('path');
const fs = require('fs-extra');
// const { Service } = require('node-windows');
const sc = require('windows-service-controller');
const { spawn } = require('child_process');
const execa = require('execa');

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
  })
  .option('svc', {
    describe: 'svc',
    type: 'boolean',
    default: false,
  });

let { token, address, silence, svc: isSvc } = argv;

const exeFilename = 'feros-proxy.exe';
const mainFolder = path.join(process.env.APPDATA || process.env.HOME, 'feros-proxy');
const confPath = path.join(mainFolder, 'cfg.json');
const startBatPath = path.join(mainFolder, 'start.bat');
const startAdmBatPath = path.join(mainFolder, 'start-adm.bat');

let globalWs;
let allowReconnect = true;
let usedConfig = false;

async function isAdmin() {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    // https://stackoverflow.com/a/21295806/1641422
    await execa('fsutil', ['dirty', 'query', process.env.systemdrive]);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await execa('fltmc');
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

// * Start
bootstrap().catch();
// * Functions

async function bootstrap() {
  !silence && console.log('execPath', process.execPath, path.basename(process.execPath));
  !silence && console.log('mainFolder', mainFolder);

  await fs.ensureDir(mainFolder);
  ({ address, token } = await loadData({ address, token }));

  let needExePath = path.join(mainFolder, exeFilename);
  if (path.basename(process.execPath) !== 'node.exe' && process.execPath !== needExePath) {
    console.log(`Copy from "${process.execPath}" to "${needExePath}"...`);

    try {
      await fs.copyFile(process.execPath, needExePath);
    } catch (err) {
      console.error(err);
    }

    try {
      const content = (adm = false) => `start powershell -Command "Start-Process cmd ${adm ? ' -Verb RunAs' : ''} -ArgumentList '/c cd "${mainFolder}" && ${exeFilename} --svc'"`;
      await fs.writeFile(startBatPath, content());
      await fs.writeFile(startAdmBatPath, content(true));
    } catch (err) {
      console.error(err);
    }

    // * Try set correct data
    await promptData({ address, token }, true);

    if (await isAdmin()) {
      const res = await installSvc(startBatPath || needExePath);
      isSvc = false;
      if (res) return;
    } else {
      await new Promise((resolve) => {
        const child = spawn(startAdmBatPath, [], { detached: true });
        child.once('exit', (c, d) => {
          console.log(`Exited with code: ${c}, SIGNAL: ${d}`);
          resolve();
        });
      });
      return;
    }
  }

  if (isSvc) {
    const res = await installSvc(startBatPath || needExePath);
    if (res) return;
  }

  // if (path.basename(process.execPath) !== 'node.exe') {
  //   try {
  //     console.log('installSvc...');
  //     await installSvc(needExePath);
  //     return;
  //   } catch (err) {
  //     console.error(err);
  //   }
  // }

  console.log('ferosProxy...');
  await ferosProxy(address, token)
}

async function installSvc(exePath) {
  return false;
  console.log('installSvc...');

  const serviceName = 'FerosProxy';

  // await sc.delete(serviceName).catch();
  try {
    await sc.create(serviceName, {
      binpath: exePath,
      displayname: 'Feros Proxy',
      start: 'auto',
    });
  } catch (err) {
    console.error(err);
  }

  try {
    await sc.start(serviceName);
    return true;
  } catch (err) {
    console.error(err);
  }

  return new Promise((resolve, reject) => {
    resolve();
    // const child = spawn('sc.exe', ['create', '"FerosProxy"', 'binpath="' + exePath + '"', 'start=auto', 'type=own', 'displayname="Feros Proxy"'], { detached: true });
    // child.once('exit', (c, d) => {
    //   console.log(`Exited with code: ${c}, SIGNAL: ${d}`);
    //   resolve();
    // });

    // const svc = new Service({
    //   name: 'FerosProxy',
    //   description: 'The nodejs.org Feros proxy.',
    //   script: exePath,
    // });
    // svc.on('install', function () {
    //   svc.start();
    //   resolve();
    // });
    // svc.install();
  });
}

async function loadData({ address, token }, forceLoad = false) {
  try {
    const conf = await fs.readJson(confPath);
    if (!address || forceLoad) {
      address = conf.address;
      usedConfig = true;
    }
    if (!token || forceLoad) {
      token = conf.token;
      usedConfig = true;
    }
  } catch (err) {
    console.error(err);
  }

  return { address, token }
}

async function promptData({ address, token }, forceSave = false) {
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

  if (askSave && !forceSave) {
    const response = await prompts({
      type: 'confirm',
      name: 'save',
      message: 'Save token and address?',
      initial: true,
    });
    forceSave = response.save;
  }

  if (forceSave) {
    await fs.writeJson(confPath, { address, token });
    usedConfig = true;
  }

  return { address, token }
}

async function ferosProxy(address, token, reconnect = false) {
  if (reconnect && usedConfig) {
    await fs.writeJson(confPath, { address, token, });
  }

  ({ address, token } = await promptData({ address, token }));

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
