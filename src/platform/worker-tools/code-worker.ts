const VM_BOOTSTRAP = String.raw`
(() => {
  const bridge = globalThis.__workerBridge;
  delete globalThis.__workerBridge;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const PromiseType = Promise;
  const ErrorType = Error;
  const define = Object.defineProperty;
  function makeError(message) {
    const error = new ErrorType(message);
    define(error, "stack", { value: message });
    return error;
  }
  const then = Promise.prototype.then;
  const apply = Reflect.apply;
  const pending = new Map();
  let sequence = 0;
  function send(message) {
    const failure = bridge(stringify(message));
    if (failure) throw makeError(failure);
  }
  function rpc(operation, payload) {
    const id = ++sequence;
    return new PromiseType((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { send({ type: 'request', id, operation, payload }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  const tools = new Proxy(Object.create(null), {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'call') return (tool, args = {}) => rpc('call', { name: tool, args });
      if (name === 'list') return (query = {}) => rpc('list', query);
      if (name === 'describe') return name => rpc('describe', { name });
      return (args = {}) => rpc('call', { name, args });
    }
  });
  Object.defineProperty(globalThis, 'tools', { value: tools });
  Object.defineProperty(globalThis, 'emit', { value: value => send({ type: 'emit', value }) });
  function failed(error) {
    let message = 'Code execution failed';
    try { message = error && typeof error.message === 'string' ? error.message : String(error); } catch {}
    send({ type: 'failure', error: message });
  }
  Object.defineProperty(globalThis, '__workerRun', { value: promise => {
    apply(then, promise, [value => {
      try { send({ type: 'done', value }); } catch (error) { failed(error); }
    }, failed]);
  } });
  return encoded => {
    const message = parse(encoded);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(makeError(message.error));
    else request.resolve(message.value);
  };
})()
`;

/** JSON crosses realms; user code never receives a host function or host object prototype. */
export const WORKER_CODE_BOOTSTRAP = String.raw`
"use strict";
const { createContext, runInContext } = require('node:vm');
process.once('message', workerData => {
const parentPort = {
  postMessage(message) { process.send(message); },
  on(event, callback) { process.on(event, callback); }
};
let emittedBytes = 0;
const context = createContext(Object.create(null), {
  name: 'worker-tools', codeGeneration: { strings: false, wasm: false }
});
context.__workerBridge = encoded => {
  try {
    if (typeof encoded !== 'string') return 'Worker bridge requires encoded JSON';
    const message = JSON.parse(encoded);
    if (message.type === 'emit') {
      emittedBytes += Buffer.byteLength(JSON.stringify(message.value) ?? "null");
      if (emittedBytes > workerData.maxResultBytes) return 'Code output exceeds the result byte budget';
    }
    parentPort.postMessage(message);
    return null;
  } catch {
    return 'Unable to encode worker request';
  }
};
const receive = runInContext(${JSON.stringify(VM_BOOTSTRAP)}, context);
const importError = runInContext('new Error("Module imports are unavailable in worker code")', context);
Object.defineProperty(importError, "stack", { value: "Module imports are unavailable in worker code" });
parentPort.on('message', message => receive(JSON.stringify(message)));
// Separate evaluation prevents closure access; completion stays in the VM to avoid host Promise assimilation.
try {
  runInContext(
    '__workerRun((async () => { "use strict";\n' + workerData.source + '\n})()); void 0', context,
    { filename: 'worker-tools.js', importModuleDynamically() { throw importError; } }
  );
} catch (error) {
  parentPort.postMessage({ type: 'failure', error: error && typeof error.message === 'string' ? error.message : String(error) });
}
});
`;
