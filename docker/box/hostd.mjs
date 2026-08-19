#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/@anthropic-ai/sdk/internal/tslib.mjs
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
var init_tslib = __esm({
  "node_modules/@anthropic-ai/sdk/internal/tslib.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs
var uuid4;
var init_uuid = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs"() {
    uuid4 = function() {
      const { crypto: crypto2 } = globalThis;
      if (crypto2?.randomUUID) {
        uuid4 = crypto2.randomUUID.bind(crypto2);
        return crypto2.randomUUID();
      }
      const u8 = new Uint8Array(1);
      const randomByte = crypto2 ? () => crypto2.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
      return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/errors.mjs
function isAbortError(err2) {
  return typeof err2 === "object" && err2 !== null && // Spec-compliant fetch implementations
  ("name" in err2 && err2.name === "AbortError" || // Expo fetch
  "message" in err2 && String(err2.message).includes("FetchRequestCanceledException"));
}
var castToError;
var init_errors = __esm({
  "node_modules/@anthropic-ai/sdk/internal/errors.mjs"() {
    castToError = (err2) => {
      if (err2 instanceof Error)
        return err2;
      if (typeof err2 === "object" && err2 !== null) {
        try {
          if (Object.prototype.toString.call(err2) === "[object Error]") {
            const error = new Error(err2.message, err2.cause ? { cause: err2.cause } : {});
            if (err2.stack)
              error.stack = err2.stack;
            if (err2.cause && !error.cause)
              error.cause = err2.cause;
            if (err2.name)
              error.name = err2.name;
            return error;
          }
        } catch {
        }
        try {
          return new Error(JSON.stringify(err2));
        } catch {
        }
      }
      return new Error(err2);
    };
  }
});

// node_modules/@anthropic-ai/sdk/core/error.mjs
var AnthropicError, APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError, RetryableError, BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError, ConflictError, UnprocessableEntityError, RateLimitError, InternalServerError;
var init_error = __esm({
  "node_modules/@anthropic-ai/sdk/core/error.mjs"() {
    init_errors();
    AnthropicError = class extends Error {
    };
    APIError = class _APIError extends AnthropicError {
      constructor(status, error, message, headers, type) {
        super(`${_APIError.makeMessage(status, error, message)}`);
        this.status = status;
        this.headers = headers;
        this.requestID = headers?.get("request-id");
        this.error = error;
        this.type = type ?? null;
      }
      static makeMessage(status, error, message) {
        const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
        if (status && msg) {
          return `${status} ${msg}`;
        }
        if (status) {
          return `${status} status code (no body)`;
        }
        if (msg) {
          return msg;
        }
        return "(no status code or body)";
      }
      static generate(status, errorResponse, message, headers) {
        if (!status || !headers) {
          return new APIConnectionError({ message, cause: castToError(errorResponse) });
        }
        const error = errorResponse;
        const type = error?.["error"]?.["type"];
        if (status === 400) {
          return new BadRequestError(status, error, message, headers, type);
        }
        if (status === 401) {
          return new AuthenticationError(status, error, message, headers, type);
        }
        if (status === 403) {
          return new PermissionDeniedError(status, error, message, headers, type);
        }
        if (status === 404) {
          return new NotFoundError(status, error, message, headers, type);
        }
        if (status === 409) {
          return new ConflictError(status, error, message, headers, type);
        }
        if (status === 422) {
          return new UnprocessableEntityError(status, error, message, headers, type);
        }
        if (status === 429) {
          return new RateLimitError(status, error, message, headers, type);
        }
        if (status >= 500) {
          return new InternalServerError(status, error, message, headers, type);
        }
        return new _APIError(status, error, message, headers, type);
      }
    };
    APIUserAbortError = class extends APIError {
      constructor({ message } = {}) {
        super(void 0, void 0, message || "Request was aborted.", void 0);
      }
    };
    APIConnectionError = class extends APIError {
      constructor({ message, cause }) {
        super(void 0, void 0, message || "Connection error.", void 0);
        if (cause)
          this.cause = cause;
      }
    };
    APIConnectionTimeoutError = class extends APIConnectionError {
      constructor({ message } = {}) {
        super({ message: message ?? "Request timed out." });
      }
    };
    RetryableError = class extends AnthropicError {
      constructor(message, { cause } = {}) {
        super(message ?? "Retryable error.");
        if (cause !== void 0)
          this.cause = cause;
      }
    };
    BadRequestError = class extends APIError {
    };
    AuthenticationError = class extends APIError {
    };
    PermissionDeniedError = class extends APIError {
    };
    NotFoundError = class extends APIError {
    };
    ConflictError = class extends APIError {
    };
    UnprocessableEntityError = class extends APIError {
    };
    RateLimitError = class extends APIError {
    };
    InternalServerError = class extends APIError {
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
function maybeObj(x) {
  if (typeof x !== "object") {
    return {};
  }
  return x ?? {};
}
function isEmptyObj(obj) {
  if (!obj)
    return true;
  for (const _k in obj)
    return false;
  return true;
}
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
var startsWithSchemeRegexp, isAbsoluteURL, isArray, isReadonlyArray, validatePositiveInteger, safeJSON;
var init_values = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/values.mjs"() {
    init_error();
    startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
    isAbsoluteURL = (url) => {
      return startsWithSchemeRegexp.test(url);
    };
    isArray = (val) => (isArray = Array.isArray, isArray(val));
    isReadonlyArray = isArray;
    validatePositiveInteger = (name, n) => {
      if (typeof n !== "number" || !Number.isInteger(n)) {
        throw new AnthropicError(`${name} must be an integer`);
      }
      if (n < 0) {
        throw new AnthropicError(`${name} must be a positive integer`);
      }
      return n;
    };
    safeJSON = (text) => {
      try {
        return JSON.parse(text);
      } catch (err2) {
        return void 0;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs
var sleep;
var init_sleep = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs"() {
    sleep = (ms, signal) => new Promise((resolve5) => {
      if (signal?.aborted)
        return resolve5();
      const onAbort = () => {
        clearTimeout(timer);
        resolve5();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve5();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
});

// node_modules/@anthropic-ai/sdk/version.mjs
var VERSION2;
var init_version = __esm({
  "node_modules/@anthropic-ai/sdk/version.mjs"() {
    VERSION2 = "0.117.1";
  }
});

// node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs
function getDetectedPlatform() {
  if (typeof Deno !== "undefined" && Deno.build != null) {
    return "deno";
  }
  if (typeof EdgeRuntime !== "undefined") {
    return "edge";
  }
  if (Object.prototype.toString.call(typeof globalThis.process !== "undefined" ? globalThis.process : 0) === "[object process]") {
    return "node";
  }
  return "unknown";
}
function getBrowserInfo() {
  if (typeof navigator === "undefined" || !navigator) {
    return null;
  }
  const browserPatterns = [
    { key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }
  ];
  for (const { key, pattern } of browserPatterns) {
    const match = pattern.exec(navigator.userAgent);
    if (match) {
      const major = match[1] || 0;
      const minor = match[2] || 0;
      const patch = match[3] || 0;
      return { browser: key, version: `${major}.${minor}.${patch}` };
    }
  }
  return null;
}
var isRunningInBrowser, getPlatformProperties, normalizeArch, normalizePlatform, _platformHeaders, getPlatformHeaders;
var init_detect_platform = __esm({
  "node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs"() {
    init_version();
    isRunningInBrowser = () => {
      return (
        // @ts-ignore
        typeof window !== "undefined" && // @ts-ignore
        typeof window.document !== "undefined" && // @ts-ignore
        typeof navigator !== "undefined"
      );
    };
    getPlatformProperties = () => {
      const detectedPlatform = getDetectedPlatform();
      if (detectedPlatform === "deno") {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION2,
          "X-Stainless-OS": normalizePlatform(Deno.build.os),
          "X-Stainless-Arch": normalizeArch(Deno.build.arch),
          "X-Stainless-Runtime": "deno",
          "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
        };
      }
      if (typeof EdgeRuntime !== "undefined") {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION2,
          "X-Stainless-OS": "Unknown",
          "X-Stainless-Arch": `other:${EdgeRuntime}`,
          "X-Stainless-Runtime": "edge",
          "X-Stainless-Runtime-Version": globalThis.process.version
        };
      }
      if (detectedPlatform === "node") {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION2,
          "X-Stainless-OS": normalizePlatform(globalThis.process.platform ?? "unknown"),
          "X-Stainless-Arch": normalizeArch(globalThis.process.arch ?? "unknown"),
          "X-Stainless-Runtime": "node",
          "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown"
        };
      }
      const browserInfo = getBrowserInfo();
      if (browserInfo) {
        return {
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": VERSION2,
          "X-Stainless-OS": "Unknown",
          "X-Stainless-Arch": "unknown",
          "X-Stainless-Runtime": `browser:${browserInfo.browser}`,
          "X-Stainless-Runtime-Version": browserInfo.version
        };
      }
      return {
        "X-Stainless-Lang": "js",
        "X-Stainless-Package-Version": VERSION2,
        "X-Stainless-OS": "Unknown",
        "X-Stainless-Arch": "unknown",
        "X-Stainless-Runtime": "unknown",
        "X-Stainless-Runtime-Version": "unknown"
      };
    };
    normalizeArch = (arch) => {
      if (arch === "x32")
        return "x32";
      if (arch === "x86_64" || arch === "x64")
        return "x64";
      if (arch === "arm")
        return "arm";
      if (arch === "aarch64" || arch === "arm64")
        return "arm64";
      if (arch)
        return `other:${arch}`;
      return "unknown";
    };
    normalizePlatform = (platform) => {
      platform = platform.toLowerCase();
      if (platform.includes("ios"))
        return "iOS";
      if (platform === "android")
        return "Android";
      if (platform === "darwin")
        return "MacOS";
      if (platform === "win32")
        return "Windows";
      if (platform === "freebsd")
        return "FreeBSD";
      if (platform === "openbsd")
        return "OpenBSD";
      if (platform === "linux")
        return "Linux";
      if (platform)
        return `Other:${platform}`;
      return "Unknown";
    };
    getPlatformHeaders = () => {
      return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/request-signal.mjs
function makeCleanup(signal, listener) {
  return () => signal.removeEventListener("abort", listener);
}
function registerRequestSignalCleanup(controller, signal, listener) {
  cleanups.set(controller, makeCleanup(signal, listener));
}
function armAbandonmentBackstop(body, controller) {
  if (cleanups.has(controller))
    registry?.register(body, controller, controller);
}
function releaseRequestSignal(controller) {
  const cleanup = cleanups.get(controller);
  if (cleanup) {
    cleanups.delete(controller);
    registry?.unregister(controller);
    cleanup();
  }
}
var cleanups, registry;
var init_request_signal = __esm({
  "node_modules/@anthropic-ai/sdk/internal/request-signal.mjs"() {
    cleanups = /* @__PURE__ */ new WeakMap();
    registry = typeof globalThis.FinalizationRegistry === "function" ? new globalThis.FinalizationRegistry((controller) => releaseRequestSignal(controller)) : null;
  }
});

// node_modules/@anthropic-ai/sdk/internal/shims.mjs
function getDefaultFetch() {
  if (typeof fetch !== "undefined") {
    return fetch;
  }
  throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
function makeReadableStream(...args) {
  const ReadableStream2 = globalThis.ReadableStream;
  if (typeof ReadableStream2 === "undefined") {
    throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  }
  return new ReadableStream2(...args);
}
function ReadableStreamFrom(iterable) {
  let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  return makeReadableStream({
    start() {
    },
    async pull(controller) {
      const { done, value } = await iter.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      await iter.return?.();
    }
  });
}
function ReadableStreamToAsyncIterable(stream) {
  if (stream[Symbol.asyncIterator])
    return stream;
  const reader = stream.getReader();
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result?.done)
          reader.releaseLock();
        return result;
      } catch (e) {
        reader.releaseLock();
        throw e;
      }
    },
    async return() {
      const cancelPromise = reader.cancel();
      reader.releaseLock();
      await cancelPromise;
      return { done: true, value: void 0 };
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
async function CancelReadableStream(stream) {
  if (stream === null || typeof stream !== "object")
    return;
  if (stream[Symbol.asyncIterator]) {
    await stream[Symbol.asyncIterator]().return?.();
    return;
  }
  const reader = stream.getReader();
  const cancelPromise = reader.cancel();
  reader.releaseLock();
  await cancelPromise;
}
var init_shims = __esm({
  "node_modules/@anthropic-ai/sdk/internal/shims.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/request-options.mjs
var FallbackEncoder;
var init_request_options = __esm({
  "node_modules/@anthropic-ai/sdk/internal/request-options.mjs"() {
    FallbackEncoder = ({ headers, body }) => {
      return {
        bodyHeaders: {
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      };
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/qs/formats.mjs
var default_format, default_formatter, formatters, RFC1738;
var init_formats = __esm({
  "node_modules/@anthropic-ai/sdk/internal/qs/formats.mjs"() {
    default_format = "RFC3986";
    default_formatter = (v) => String(v);
    formatters = {
      RFC1738: (v) => String(v).replace(/%20/g, "+"),
      RFC3986: default_formatter
    };
    RFC1738 = "RFC1738";
  }
});

// node_modules/@anthropic-ai/sdk/internal/qs/utils.mjs
function is_buffer(obj) {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  return !!(obj.constructor && obj.constructor.isBuffer && obj.constructor.isBuffer(obj));
}
function maybe_map(val, fn) {
  if (isArray(val)) {
    const mapped = [];
    for (let i = 0; i < val.length; i += 1) {
      mapped.push(fn(val[i]));
    }
    return mapped;
  }
  return fn(val);
}
var has, hex_table, limit, encode;
var init_utils = __esm({
  "node_modules/@anthropic-ai/sdk/internal/qs/utils.mjs"() {
    init_formats();
    init_values();
    has = (obj, key) => (has = Object.hasOwn ?? Function.prototype.call.bind(Object.prototype.hasOwnProperty), has(obj, key));
    hex_table = /* @__PURE__ */ (() => {
      const array = [];
      for (let i = 0; i < 256; ++i) {
        array.push("%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase());
      }
      return array;
    })();
    limit = 1024;
    encode = (str, _defaultEncoder, charset, _kind, format) => {
      if (str.length === 0) {
        return str;
      }
      let string = str;
      if (typeof str === "symbol") {
        string = Symbol.prototype.toString.call(str);
      } else if (typeof str !== "string") {
        string = String(str);
      }
      if (charset === "iso-8859-1") {
        return escape(string).replace(/%u[0-9a-f]{4}/gi, function($0) {
          return "%26%23" + parseInt($0.slice(2), 16) + "%3B";
        });
      }
      let out2 = "";
      for (let j = 0; j < string.length; j += limit) {
        const segment = string.length >= limit ? string.slice(j, j + limit) : string;
        const arr = [];
        for (let i = 0; i < segment.length; ++i) {
          let c = segment.charCodeAt(i);
          if (c === 45 || // -
          c === 46 || // .
          c === 95 || // _
          c === 126 || // ~
          c >= 48 && c <= 57 || // 0-9
          c >= 65 && c <= 90 || // a-z
          c >= 97 && c <= 122 || // A-Z
          format === RFC1738 && (c === 40 || c === 41)) {
            arr[arr.length] = segment.charAt(i);
            continue;
          }
          if (c < 128) {
            arr[arr.length] = hex_table[c];
            continue;
          }
          if (c < 2048) {
            arr[arr.length] = hex_table[192 | c >> 6] + hex_table[128 | c & 63];
            continue;
          }
          if (c < 55296 || c >= 57344) {
            arr[arr.length] = hex_table[224 | c >> 12] + hex_table[128 | c >> 6 & 63] + hex_table[128 | c & 63];
            continue;
          }
          i += 1;
          c = 65536 + ((c & 1023) << 10 | segment.charCodeAt(i) & 1023);
          arr[arr.length] = hex_table[240 | c >> 18] + hex_table[128 | c >> 12 & 63] + hex_table[128 | c >> 6 & 63] + hex_table[128 | c & 63];
        }
        out2 += arr.join("");
      }
      return out2;
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/qs/stringify.mjs
function is_non_nullish_primitive(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "symbol" || typeof v === "bigint";
}
function inner_stringify(object, prefix, generateArrayPrefix, commaRoundTrip, allowEmptyArrays, strictNullHandling, skipNulls, encodeDotInKeys, encoder2, filter, sort, allowDots, serializeDate, format, formatter, encodeValuesOnly, charset, sideChannel) {
  let obj = object;
  let tmp_sc = sideChannel;
  let step = 0;
  let find_flag = false;
  while ((tmp_sc = tmp_sc.get(sentinel)) !== void 0 && !find_flag) {
    const pos = tmp_sc.get(object);
    step += 1;
    if (typeof pos !== "undefined") {
      if (pos === step) {
        throw new RangeError("Cyclic object value");
      } else {
        find_flag = true;
      }
    }
    if (typeof tmp_sc.get(sentinel) === "undefined") {
      step = 0;
    }
  }
  if (typeof filter === "function") {
    obj = filter(prefix, obj);
  } else if (obj instanceof Date) {
    obj = serializeDate?.(obj);
  } else if (generateArrayPrefix === "comma" && isArray(obj)) {
    obj = maybe_map(obj, function(value) {
      if (value instanceof Date) {
        return serializeDate?.(value);
      }
      return value;
    });
  }
  if (obj === null) {
    if (strictNullHandling) {
      return encoder2 && !encodeValuesOnly ? (
        // @ts-expect-error
        encoder2(prefix, defaults.encoder, charset, "key", format)
      ) : prefix;
    }
    obj = "";
  }
  if (is_non_nullish_primitive(obj) || is_buffer(obj)) {
    if (encoder2) {
      const key_value = encodeValuesOnly ? prefix : encoder2(prefix, defaults.encoder, charset, "key", format);
      return [
        formatter?.(key_value) + "=" + // @ts-expect-error
        formatter?.(encoder2(obj, defaults.encoder, charset, "value", format))
      ];
    }
    return [formatter?.(prefix) + "=" + formatter?.(String(obj))];
  }
  const values = [];
  if (typeof obj === "undefined") {
    return values;
  }
  let obj_keys;
  if (generateArrayPrefix === "comma" && isArray(obj)) {
    if (encodeValuesOnly && encoder2) {
      obj = maybe_map(obj, encoder2);
    }
    obj_keys = [{ value: obj.length > 0 ? obj.join(",") || null : void 0 }];
  } else if (isArray(filter)) {
    obj_keys = filter;
  } else {
    const keys = Object.keys(obj);
    obj_keys = sort ? keys.sort(sort) : keys;
  }
  const encoded_prefix = encodeDotInKeys ? String(prefix).replace(/\./g, "%2E") : String(prefix);
  const adjusted_prefix = commaRoundTrip && isArray(obj) && obj.length === 1 ? encoded_prefix + "[]" : encoded_prefix;
  if (allowEmptyArrays && isArray(obj) && obj.length === 0) {
    return adjusted_prefix + "[]";
  }
  for (let j = 0; j < obj_keys.length; ++j) {
    const key = obj_keys[j];
    const value = (
      // @ts-ignore
      typeof key === "object" && typeof key.value !== "undefined" ? key.value : obj[key]
    );
    if (skipNulls && value === null) {
      continue;
    }
    const encoded_key = allowDots && encodeDotInKeys ? key.replace(/\./g, "%2E") : key;
    const key_prefix = isArray(obj) ? typeof generateArrayPrefix === "function" ? generateArrayPrefix(adjusted_prefix, encoded_key) : adjusted_prefix : adjusted_prefix + (allowDots ? "." + encoded_key : "[" + encoded_key + "]");
    sideChannel.set(object, step);
    const valueSideChannel = /* @__PURE__ */ new WeakMap();
    valueSideChannel.set(sentinel, sideChannel);
    push_to_array(values, inner_stringify(
      value,
      key_prefix,
      generateArrayPrefix,
      commaRoundTrip,
      allowEmptyArrays,
      strictNullHandling,
      skipNulls,
      encodeDotInKeys,
      // @ts-ignore
      generateArrayPrefix === "comma" && encodeValuesOnly && isArray(obj) ? null : encoder2,
      filter,
      sort,
      allowDots,
      serializeDate,
      format,
      formatter,
      encodeValuesOnly,
      charset,
      valueSideChannel
    ));
  }
  return values;
}
function normalize_stringify_options(opts = defaults) {
  if (typeof opts.allowEmptyArrays !== "undefined" && typeof opts.allowEmptyArrays !== "boolean") {
    throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");
  }
  if (typeof opts.encodeDotInKeys !== "undefined" && typeof opts.encodeDotInKeys !== "boolean") {
    throw new TypeError("`encodeDotInKeys` option can only be `true` or `false`, when provided");
  }
  if (opts.encoder !== null && typeof opts.encoder !== "undefined" && typeof opts.encoder !== "function") {
    throw new TypeError("Encoder has to be a function.");
  }
  const charset = opts.charset || defaults.charset;
  if (typeof opts.charset !== "undefined" && opts.charset !== "utf-8" && opts.charset !== "iso-8859-1") {
    throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");
  }
  let format = default_format;
  if (typeof opts.format !== "undefined") {
    if (!has(formatters, opts.format)) {
      throw new TypeError("Unknown format option provided.");
    }
    format = opts.format;
  }
  const formatter = formatters[format];
  let filter = defaults.filter;
  if (typeof opts.filter === "function" || isArray(opts.filter)) {
    filter = opts.filter;
  }
  let arrayFormat;
  if (opts.arrayFormat && opts.arrayFormat in array_prefix_generators) {
    arrayFormat = opts.arrayFormat;
  } else if ("indices" in opts) {
    arrayFormat = opts.indices ? "indices" : "repeat";
  } else {
    arrayFormat = defaults.arrayFormat;
  }
  if ("commaRoundTrip" in opts && typeof opts.commaRoundTrip !== "boolean") {
    throw new TypeError("`commaRoundTrip` must be a boolean, or absent");
  }
  const allowDots = typeof opts.allowDots === "undefined" ? !!opts.encodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots;
  return {
    addQueryPrefix: typeof opts.addQueryPrefix === "boolean" ? opts.addQueryPrefix : defaults.addQueryPrefix,
    // @ts-ignore
    allowDots,
    allowEmptyArrays: typeof opts.allowEmptyArrays === "boolean" ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
    arrayFormat,
    charset,
    charsetSentinel: typeof opts.charsetSentinel === "boolean" ? opts.charsetSentinel : defaults.charsetSentinel,
    commaRoundTrip: !!opts.commaRoundTrip,
    delimiter: typeof opts.delimiter === "undefined" ? defaults.delimiter : opts.delimiter,
    encode: typeof opts.encode === "boolean" ? opts.encode : defaults.encode,
    encodeDotInKeys: typeof opts.encodeDotInKeys === "boolean" ? opts.encodeDotInKeys : defaults.encodeDotInKeys,
    encoder: typeof opts.encoder === "function" ? opts.encoder : defaults.encoder,
    encodeValuesOnly: typeof opts.encodeValuesOnly === "boolean" ? opts.encodeValuesOnly : defaults.encodeValuesOnly,
    filter,
    format,
    formatter,
    serializeDate: typeof opts.serializeDate === "function" ? opts.serializeDate : defaults.serializeDate,
    skipNulls: typeof opts.skipNulls === "boolean" ? opts.skipNulls : defaults.skipNulls,
    // @ts-ignore
    sort: typeof opts.sort === "function" ? opts.sort : null,
    strictNullHandling: typeof opts.strictNullHandling === "boolean" ? opts.strictNullHandling : defaults.strictNullHandling
  };
}
function stringify(object, opts = {}) {
  let obj = object;
  const options = normalize_stringify_options(opts);
  let obj_keys;
  let filter;
  if (typeof options.filter === "function") {
    filter = options.filter;
    obj = filter("", obj);
  } else if (isArray(options.filter)) {
    filter = options.filter;
    obj_keys = filter;
  }
  const keys = [];
  if (typeof obj !== "object" || obj === null) {
    return "";
  }
  const generateArrayPrefix = array_prefix_generators[options.arrayFormat];
  const commaRoundTrip = generateArrayPrefix === "comma" && options.commaRoundTrip;
  if (!obj_keys) {
    obj_keys = Object.keys(obj);
  }
  if (options.sort) {
    obj_keys.sort(options.sort);
  }
  const sideChannel = /* @__PURE__ */ new WeakMap();
  for (let i = 0; i < obj_keys.length; ++i) {
    const key = obj_keys[i];
    if (options.skipNulls && obj[key] === null) {
      continue;
    }
    push_to_array(keys, inner_stringify(
      obj[key],
      key,
      // @ts-expect-error
      generateArrayPrefix,
      commaRoundTrip,
      options.allowEmptyArrays,
      options.strictNullHandling,
      options.skipNulls,
      options.encodeDotInKeys,
      options.encode ? options.encoder : null,
      options.filter,
      options.sort,
      options.allowDots,
      options.serializeDate,
      options.format,
      options.formatter,
      options.encodeValuesOnly,
      options.charset,
      sideChannel
    ));
  }
  const joined = keys.join(options.delimiter);
  let prefix = options.addQueryPrefix === true ? "?" : "";
  if (options.charsetSentinel) {
    if (options.charset === "iso-8859-1") {
      prefix += "utf8=%26%2310003%3B&";
    } else {
      prefix += "utf8=%E2%9C%93&";
    }
  }
  return joined.length > 0 ? prefix + joined : "";
}
var array_prefix_generators, push_to_array, toISOString, defaults, sentinel;
var init_stringify = __esm({
  "node_modules/@anthropic-ai/sdk/internal/qs/stringify.mjs"() {
    init_utils();
    init_formats();
    init_values();
    array_prefix_generators = {
      brackets(prefix) {
        return String(prefix) + "[]";
      },
      comma: "comma",
      indices(prefix, key) {
        return String(prefix) + "[" + key + "]";
      },
      repeat(prefix) {
        return String(prefix);
      }
    };
    push_to_array = function(arr, value_or_array) {
      Array.prototype.push.apply(arr, isArray(value_or_array) ? value_or_array : [value_or_array]);
    };
    defaults = {
      addQueryPrefix: false,
      allowDots: false,
      allowEmptyArrays: false,
      arrayFormat: "indices",
      charset: "utf-8",
      charsetSentinel: false,
      delimiter: "&",
      encode: true,
      encodeDotInKeys: false,
      encoder: encode,
      encodeValuesOnly: false,
      format: default_format,
      formatter: default_formatter,
      /** @deprecated */
      indices: false,
      serializeDate(date) {
        return (toISOString ?? (toISOString = Function.prototype.call.bind(Date.prototype.toISOString)))(date);
      },
      skipNulls: false,
      strictNullHandling: false
    };
    sentinel = {};
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/query.mjs
function stringifyQuery(query) {
  return stringify(query, { arrayFormat: "brackets" });
}
var init_query = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/query.mjs"() {
    init_stringify();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/types.mjs
function requireSecureTokenEndpoint(baseURL) {
  if (!baseURL)
    return;
  let u;
  try {
    u = new URL(baseURL);
  } catch (err2) {
    throw new WorkloadIdentityError(`Invalid token endpoint base URL "${baseURL}": ${err2}`);
  }
  if (u.protocol === "https:")
    return;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    return;
  }
  throw new WorkloadIdentityError(`Refusing to send credential over non-https token endpoint "${baseURL}"`);
}
async function parseTokenResponse(resp, requestId) {
  const text = await readLimitedText(resp);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WorkloadIdentityError(`Token endpoint returned non-JSON response (status ${resp.status})`, resp.status, redactSensitive(text), requestId);
  }
  if (!data.access_token) {
    throw new WorkloadIdentityError(`Token endpoint response missing access_token: ${JSON.stringify(redactSensitive(data))}`, resp.status, redactSensitive(data), requestId);
  }
  if (data.token_type && data.token_type.toLowerCase() !== "bearer") {
    throw new WorkloadIdentityError(`Token endpoint response: unsupported token_type "${data.token_type}" (want Bearer)`, resp.status, redactSensitive(data), requestId);
  }
  return data;
}
function redactSensitive(body) {
  if (body == null)
    return body;
  if (typeof body === "string") {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      if (body.length <= MAX_ERROR_BODY_CHARS)
        return body;
      return body.slice(0, MAX_ERROR_BODY_CHARS) + `... <${body.length - MAX_ERROR_BODY_CHARS} more chars>`;
    }
    return JSON.stringify(redactSensitive(parsed));
  }
  if (typeof body === "object" && !Array.isArray(body)) {
    const out2 = {};
    for (const [k, v] of Object.entries(body)) {
      if (SAFE_ERROR_KEYS.has(k))
        out2[k] = v;
    }
    return out2;
  }
  return null;
}
async function checkCredentialsFileSafety(path5, onWarn = (m) => console.warn(`anthropic-sdk: ${m}`)) {
  if (typeof process === "undefined" || process.platform === "win32")
    return;
  const fs4 = await import("node:fs");
  let resolved = path5;
  let st;
  try {
    resolved = await fs4.promises.realpath(path5);
    st = await fs4.promises.stat(resolved);
  } catch {
    return;
  }
  const mode = st.mode & 511;
  if (mode & 18) {
    throw new WorkloadIdentityError(`Credentials file at ${resolved} is group/world-writable (mode 0o${mode.toString(8)}); this allows other local users to plant tokens. Run \`chmod 600 ${resolved}\`.`);
  }
  if (mode & 36) {
    throw new WorkloadIdentityError(`Credentials file at ${resolved} is group/world-readable (mode 0o${mode.toString(8)}); run \`chmod 600 ${resolved}\` before retrying.`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    onWarn(`credentials file at ${resolved} is owned by uid ${st.uid} (current process uid ${process.getuid()}); verify this is intentional.`);
  }
}
async function writeCredentialsFileAtomic(targetPath, data) {
  const fs4 = await import("node:fs");
  const path5 = await import("node:path");
  const dir = path5.dirname(targetPath);
  await fs4.promises.mkdir(dir, { recursive: true, mode: 448 });
  const tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fh = await fs4.promises.open(tmpPath, "w", 384);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs4.promises.rename(tmpPath, targetPath);
  } catch (err2) {
    await fs4.promises.unlink(tmpPath).catch(() => {
    });
    throw err2;
  }
  try {
    const dirFh = await fs4.promises.open(dir, "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  } catch {
  }
}
async function readLimitedText(resp) {
  if (!resp.body) {
    return "";
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    if (received + value.length > MAX_TOKEN_RESPONSE_BYTES) {
      const remaining = MAX_TOKEN_RESPONSE_BYTES - received;
      if (remaining > 0)
        chunks.push(value.subarray(0, remaining));
      await reader.cancel();
      break;
    }
    chunks.push(value);
    received += value.length;
  }
  let merged;
  if (chunks.length === 1) {
    merged = chunks[0];
  } else {
    merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
  }
  return new TextDecoder("utf-8").decode(merged);
}
var GRANT_TYPE_JWT_BEARER, GRANT_TYPE_REFRESH_TOKEN, TOKEN_ENDPOINT, OAUTH_API_BETA_HEADER, FEDERATION_BETA_HEADER, ADVISORY_REFRESH_THRESHOLD_IN_SECONDS, MANDATORY_REFRESH_THRESHOLD_IN_SECONDS, ADVISORY_REFRESH_BACKOFF_IN_SECONDS, MAX_TOKEN_RESPONSE_BYTES, MAX_ERROR_BODY_CHARS, SAFE_ERROR_KEYS, WorkloadIdentityError;
var init_types = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/types.mjs"() {
    init_error();
    GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
    GRANT_TYPE_REFRESH_TOKEN = "refresh_token";
    TOKEN_ENDPOINT = "/v1/oauth/token";
    OAUTH_API_BETA_HEADER = "oauth-2025-04-20";
    FEDERATION_BETA_HEADER = "oidc-federation-2026-04-01";
    ADVISORY_REFRESH_THRESHOLD_IN_SECONDS = 120;
    MANDATORY_REFRESH_THRESHOLD_IN_SECONDS = 30;
    ADVISORY_REFRESH_BACKOFF_IN_SECONDS = 5;
    MAX_TOKEN_RESPONSE_BYTES = 1 << 20;
    MAX_ERROR_BODY_CHARS = 2e3;
    SAFE_ERROR_KEYS = /* @__PURE__ */ new Set(["error", "error_description", "error_uri"]);
    WorkloadIdentityError = class extends AnthropicError {
      constructor(message, statusCode = null, body = null, requestId = null) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
        this.requestId = requestId;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/time.mjs
function nowAsSeconds() {
  return Math.floor(Date.now() / 1e3);
}
var init_time = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/time.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/token-cache.mjs
var TokenCache;
var init_token_cache = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/token-cache.mjs"() {
    init_types();
    init_time();
    TokenCache = class {
      constructor(provider, onAdvisoryRefreshError) {
        this.cached = null;
        this.pendingRefresh = null;
        this.nextForce = false;
        this.lastAdvisoryError = 0;
        this.provider = provider;
        this.onAdvisoryRefreshError = onAdvisoryRefreshError;
      }
      async getToken() {
        const force = this.nextForce;
        this.nextForce = false;
        const cached = this.cached;
        if (force || cached == null) {
          const token2 = await this.refresh(force);
          return token2.token;
        }
        if (cached.expiresAt == null) {
          return cached.token;
        }
        const remaining = cached.expiresAt - nowAsSeconds();
        if (remaining > ADVISORY_REFRESH_THRESHOLD_IN_SECONDS) {
          return cached.token;
        }
        if (remaining > MANDATORY_REFRESH_THRESHOLD_IN_SECONDS) {
          this.backgroundRefresh();
          return cached.token;
        }
        const token = await this.refresh();
        return token.token;
      }
      /**
       * Clears the cached token and marks the next {@link getToken} as a forced
       * refresh, so the underlying provider bypasses any on-disk freshness check.
       * Called after a 401 — the server has just told us the token is bad even
       * if its `expires_at` still looks fresh.
       */
      invalidate() {
        this.cached = null;
        this.nextForce = true;
      }
      /**
       * Mandatory refresh. Joins any in-flight refresh unless forced — a forced
       * refresh must not coalesce into a non-forced one that may re-serve the
       * same stale disk token.
       */
      refresh(force = false) {
        if (this.pendingRefresh && !force) {
          return this.pendingRefresh;
        }
        return this.doRefresh(force);
      }
      /**
       * Advisory background refresh. Shares the same in-flight promise as
       * mandatory refreshes for deduplication, but swallows errors so the
       * stale cached token keeps being served. Backs off for
       * {@link ADVISORY_REFRESH_BACKOFF_IN_SECONDS} after a failure so an
       * outage during the advisory window doesn't hammer the token endpoint.
       */
      backgroundRefresh() {
        if (this.pendingRefresh) {
          return;
        }
        if (nowAsSeconds() - this.lastAdvisoryError < ADVISORY_REFRESH_BACKOFF_IN_SECONDS) {
          return;
        }
        this.doRefresh().catch((err2) => {
          this.lastAdvisoryError = nowAsSeconds();
          this.onAdvisoryRefreshError?.(err2);
        });
      }
      /**
       * Core refresh. Sets {@link pendingRefresh} so concurrent callers
       * (both advisory and mandatory) coalesce into a single provider call.
       */
      doRefresh(force = false) {
        this.pendingRefresh = this.provider(force ? { forceRefresh: true } : void 0).then((token) => {
          this.cached = token;
          this.pendingRefresh = null;
          return token;
        }, (err2) => {
          this.pendingRefresh = null;
          throw err2;
        });
        return this.pendingRefresh;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/env.mjs
var readEnv;
var init_env = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/env.mjs"() {
    readEnv = (env) => {
      if (typeof globalThis.process !== "undefined") {
        return globalThis.process.env?.[env]?.trim() || void 0;
      }
      if (typeof globalThis.Deno !== "undefined") {
        return globalThis.Deno.env?.get?.(env)?.trim() || void 0;
      }
      return void 0;
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs
function concatBytes(buffers) {
  let length = 0;
  for (const buffer of buffers) {
    length += buffer.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const buffer of buffers) {
    output.set(buffer, index);
    index += buffer.length;
  }
  return output;
}
function encodeUTF8(str) {
  let encoder2;
  return (encodeUTF8_ ?? (encoder2 = new globalThis.TextEncoder(), encodeUTF8_ = encoder2.encode.bind(encoder2)))(str);
}
function decodeUTF8(bytes) {
  let decoder;
  return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}
var encodeUTF8_, decodeUTF8_;
var init_bytes = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/base64.mjs
var init_base64 = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/base64.mjs"() {
    init_error();
    init_bytes();
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/log.mjs
function noop() {
}
function makeLogFn(fnLevel, logger, logLevel) {
  if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) {
    return noop;
  } else {
    return logger[fnLevel].bind(logger);
  }
}
function filterLogger(logger, logLevel) {
  const cachedLogger = cachedLoggers.get(logger);
  if (cachedLogger && cachedLogger[0] === logLevel) {
    return cachedLogger[1];
  }
  const levelLogger = {
    error: makeLogFn("error", logger, logLevel),
    warn: makeLogFn("warn", logger, logLevel),
    info: makeLogFn("info", logger, logLevel),
    debug: makeLogFn("debug", logger, logLevel)
  };
  cachedLoggers.set(logger, [logLevel, levelLogger]);
  return levelLogger;
}
function loggerFor(client) {
  const logger = client.logger;
  const logLevel = client.logLevel ?? "off";
  if (!logger) {
    return noopLogger;
  }
  return filterLogger(logger, logLevel);
}
function defaultLogger() {
  const envLevel = readEnv("ANTHROPIC_LOG");
  if (!cachedDefaultLogger || envLevel !== lastEnvLevel) {
    lastEnvLevel = envLevel;
    cachedDefaultLogger = filterLogger(console, parseLogLevel(envLevel, "process.env['ANTHROPIC_LOG']", filterLogger(console, defaultLogLevel)) ?? defaultLogLevel);
  }
  return cachedDefaultLogger;
}
var defaultLogLevel, levelNumbers, parseLogLevel, noopLogger, cachedLoggers, lastEnvLevel, cachedDefaultLogger, formatRequestDetails;
var init_log = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/log.mjs"() {
    init_values();
    init_env();
    defaultLogLevel = "warn";
    levelNumbers = {
      off: 0,
      error: 200,
      warn: 300,
      info: 400,
      debug: 500
    };
    parseLogLevel = (maybeLevel, sourceName, logger) => {
      if (!maybeLevel) {
        return void 0;
      }
      if (hasOwn(levelNumbers, maybeLevel)) {
        return maybeLevel;
      }
      logger.warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
      return void 0;
    };
    noopLogger = {
      error: noop,
      warn: noop,
      info: noop,
      debug: noop
    };
    cachedLoggers = /* @__PURE__ */ new WeakMap();
    formatRequestDetails = (details) => {
      if (details.options) {
        details.options = { ...details.options };
        delete details.options["headers"];
      }
      if (details.headers) {
        details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [
          name,
          name.toLowerCase() === "authorization" || name.toLowerCase() === "api-key" || name.toLowerCase() === "x-api-key" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value
        ]));
      }
      if ("retryOfRequestLogID" in details) {
        if (details.retryOfRequestLogID) {
          details.retryOf = details.retryOfRequestLogID;
        }
        delete details.retryOfRequestLogID;
      }
      return details;
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils.mjs
var init_utils2 = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils.mjs"() {
    init_values();
    init_base64();
    init_env();
    init_log();
    init_uuid();
    init_sleep();
    init_query();
  }
});

// node_modules/@anthropic-ai/sdk/core/credentials.mjs
function validateProfileName(name) {
  if (!name) {
    throw new Error("profile name is empty");
  }
  if (name === "." || name === "..") {
    throw new Error(`profile name "${name}" is not allowed`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`profile name "${name}" must not contain path separators`);
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`profile name "${name}" contains disallowed characters (allowed: letters, digits, '_', '.', '-')`);
  }
}
var CREDENTIALS_FILE_VERSION, PROFILE_NAME_PATTERN, loadConfigWithSource, getCredentialsPath, getRootConfigPath, supportsLocalConfigFiles, getActiveProfileName;
var init_credentials = __esm({
  "node_modules/@anthropic-ai/sdk/core/credentials.mjs"() {
    init_detect_platform();
    init_utils2();
    CREDENTIALS_FILE_VERSION = "1.0";
    PROFILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
    loadConfigWithSource = async (profile) => {
      var _a2, _b;
      const rootConfigPath = await getRootConfigPath();
      if (rootConfigPath === null) {
        return null;
      }
      const profileName = profile ?? await getActiveProfileName();
      if (profileName === null) {
        return null;
      }
      validateProfileName(profileName);
      const fs4 = await import("node:fs");
      const path5 = await import("node:path");
      const configPath2 = path5.join(rootConfigPath, "configs", `${profileName}.json`);
      let configRaw;
      try {
        configRaw = await fs4.promises.readFile(configPath2, "utf-8");
      } catch (err2) {
        if (err2?.code !== "ENOENT") {
          throw new Error(`failed to read config file ${configPath2}: ${err2}`);
        }
        configRaw = null;
      }
      if (configRaw === null) {
        const organizationId = readEnv("ANTHROPIC_ORGANIZATION_ID");
        const identityTokenFile = readEnv("ANTHROPIC_IDENTITY_TOKEN_FILE");
        const federationRuleId = readEnv("ANTHROPIC_FEDERATION_RULE_ID");
        if (federationRuleId && organizationId) {
          return {
            fromFile: false,
            config: {
              organization_id: organizationId,
              // A defaulted-but-empty CI variable (`ANTHROPIC_WORKSPACE_ID=""`) is
              // treated as unset — readEnv coerces empty to undefined, and the body
              // builder's truthy check skips it — so `"workspace_id": ""` never goes
              // on the wire.
              workspace_id: readEnv("ANTHROPIC_WORKSPACE_ID"),
              base_url: readEnv("ANTHROPIC_BASE_URL"),
              authentication: {
                type: "oidc_federation",
                federation_rule_id: federationRuleId,
                service_account_id: readEnv("ANTHROPIC_SERVICE_ACCOUNT_ID"),
                identity_token: identityTokenFile ? { source: "file", path: identityTokenFile } : void 0,
                scope: readEnv("ANTHROPIC_SCOPE")
              }
            }
          };
        }
        return null;
      }
      let config;
      try {
        config = JSON.parse(configRaw);
      } catch (err2) {
        throw new Error(`failed to parse config file ${configPath2}: ${err2}`);
      }
      if (!config.authentication) {
        throw new Error(`config file ${configPath2} is missing "authentication"`);
      }
      const authType = config.authentication.type;
      if (authType !== "oidc_federation" && authType !== "user_oauth") {
        throw new Error(`authentication.type "${authType}" is not a known authentication type`);
      }
      config.organization_id ?? (config.organization_id = readEnv("ANTHROPIC_ORGANIZATION_ID"));
      config.workspace_id ?? (config.workspace_id = readEnv("ANTHROPIC_WORKSPACE_ID"));
      config.base_url ?? (config.base_url = readEnv("ANTHROPIC_BASE_URL"));
      (_a2 = config.authentication).scope ?? (_a2.scope = readEnv("ANTHROPIC_SCOPE"));
      if (config.authentication.type === "oidc_federation") {
        if (!config.authentication.identity_token) {
          const identityTokenFile = readEnv("ANTHROPIC_IDENTITY_TOKEN_FILE");
          if (identityTokenFile) {
            config.authentication.identity_token = {
              source: "file",
              path: identityTokenFile
            };
          }
        }
        if (!config.authentication.federation_rule_id) {
          config.authentication.federation_rule_id = readEnv("ANTHROPIC_FEDERATION_RULE_ID") ?? "";
        }
        (_b = config.authentication).service_account_id ?? (_b.service_account_id = readEnv("ANTHROPIC_SERVICE_ACCOUNT_ID"));
      }
      return { config, fromFile: true };
    };
    getCredentialsPath = async (config, profile) => {
      if (config?.authentication.credentials_path) {
        return config.authentication.credentials_path;
      }
      const rootConfigPath = await getRootConfigPath();
      if (!rootConfigPath) {
        return null;
      }
      const profileName = profile ?? await getActiveProfileName();
      if (!profileName) {
        return null;
      }
      validateProfileName(profileName);
      const path5 = await import("node:path");
      return path5.join(rootConfigPath, "credentials", `${profileName}.json`);
    };
    getRootConfigPath = async () => {
      if (!supportsLocalConfigFiles()) {
        return null;
      }
      const path5 = await import("node:path");
      const configDir = readEnv("ANTHROPIC_CONFIG_DIR");
      if (configDir) {
        return configDir;
      }
      const os = getPlatformHeaders()["X-Stainless-OS"];
      if (os === "Windows") {
        const appData = readEnv("APPDATA");
        if (appData) {
          return path5.join(appData, "Anthropic");
        }
        const userProfile = readEnv("USERPROFILE");
        if (userProfile) {
          return path5.join(userProfile, "AppData", "Roaming", "Anthropic");
        }
        return null;
      }
      const xdgConfigHome = readEnv("XDG_CONFIG_HOME");
      if (xdgConfigHome) {
        return path5.join(xdgConfigHome, "anthropic");
      }
      const home = readEnv("HOME");
      if (home) {
        return path5.join(home, ".config", "anthropic");
      }
      return null;
    };
    supportsLocalConfigFiles = () => {
      const runtime = getPlatformHeaders()["X-Stainless-Runtime"];
      return runtime === "node" || runtime === "deno";
    };
    getActiveProfileName = async () => {
      const rootConfigPath = await getRootConfigPath();
      if (!rootConfigPath) {
        return null;
      }
      const profileName = readEnv("ANTHROPIC_PROFILE");
      if (profileName) {
        return profileName;
      }
      const fs4 = await import("node:fs");
      const path5 = await import("node:path");
      const filePath = path5.join(rootConfigPath, "active_config");
      try {
        return (await fs4.promises.readFile(filePath, "utf-8")).trim() || "default";
      } catch (err2) {
        if (err2?.code !== "ENOENT") {
          throw new Error(`failed to read ${filePath}: ${err2}`);
        }
        return "default";
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/identity-token.mjs
function identityTokenFromFile(path5) {
  if (!path5) {
    throw new AnthropicError("Identity token file path is empty");
  }
  return async () => {
    const fs4 = await import("node:fs");
    let content;
    try {
      content = await fs4.promises.readFile(path5, "utf-8");
    } catch (err2) {
      throw new AnthropicError(`Failed to read identity token file at ${path5}: ${err2}`);
    }
    const token = content.trim();
    if (!token) {
      throw new AnthropicError(`Identity token file at ${path5} is empty`);
    }
    return token;
  };
}
function identityTokenFromValue(token) {
  if (!token) {
    throw new AnthropicError("Identity token value is empty");
  }
  return () => token;
}
var init_identity_token = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/identity-token.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/oidc-federation.mjs
function oidcFederationProvider(config) {
  return async () => {
    requireSecureTokenEndpoint(config.baseURL);
    const jwt = await config.identityTokenProvider();
    if (jwt.length > 16 * 1024) {
      throw new WorkloadIdentityError(`Identity token is ${Math.ceil(jwt.length / 1024)} KiB, exceeds the 16 KiB assertion limit`);
    }
    const body = {
      grant_type: GRANT_TYPE_JWT_BEARER,
      assertion: jwt,
      federation_rule_id: config.federationRuleId,
      organization_id: config.organizationId
    };
    if (config.serviceAccountId) {
      body["service_account_id"] = config.serviceAccountId;
    }
    if (config.workspaceId) {
      body["workspace_id"] = config.workspaceId;
    }
    const url = `${config.baseURL}${TOKEN_ENDPOINT}`;
    let resp;
    try {
      resp = await config.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": `${OAUTH_API_BETA_HEADER},${FEDERATION_BETA_HEADER}`,
          "User-Agent": config.userAgent || `anthropic-sdk-typescript/${VERSION2} oidcFederationProvider`
        },
        body: JSON.stringify(body)
      });
    } catch (err2) {
      throw new WorkloadIdentityError(`Failed to reach token endpoint ${url}: ${err2}`);
    }
    const requestId = resp.headers.get("Request-Id");
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const redacted = redactSensitive(text);
      let hint = "";
      if (resp.status === 401) {
        const hintMiddle = config.workspaceId ? "" : "If your federation rule is scoped to multiple workspaces, set the ANTHROPIC_WORKSPACE_ID environment variable, the 'workspace_id' config key, or the `workspaceId` option. ";
        hint = ` Ensure your federation rule matches your identity token. ${hintMiddle}View your authentication events in the Workload identity page of Claude Console for more details.`;
      }
      throw new WorkloadIdentityError(`Token exchange failed with status ${resp.status}${requestId ? ` (request-id ${requestId})` : ""}: ${redacted}${hint}`, resp.status, redacted, requestId);
    }
    const data = await parseTokenResponse(resp, requestId);
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn)) {
      throw new WorkloadIdentityError(`Token endpoint response missing required fields: ${JSON.stringify(redactSensitive(data))}`, resp.status, redactSensitive(data), requestId);
    }
    return {
      token: data.access_token,
      expiresAt: nowAsSeconds() + expiresIn
    };
  };
}
var init_oidc_federation = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/oidc-federation.mjs"() {
    init_types();
    init_time();
    init_version();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/user-oauth.mjs
function userOAuthProvider(config) {
  return async (opts) => {
    const fs4 = await import("node:fs");
    await checkCredentialsFileSafety(config.credentialsPath, config.onSafetyWarning);
    let raw;
    try {
      raw = await fs4.promises.readFile(config.credentialsPath, "utf-8");
    } catch (err2) {
      throw new WorkloadIdentityError(`Credentials file not found at ${config.credentialsPath}: ${err2}`);
    }
    let creds;
    try {
      creds = JSON.parse(raw);
    } catch (err2) {
      throw new WorkloadIdentityError(`Credentials file at ${config.credentialsPath} is not valid JSON: ${err2}`);
    }
    const accessToken = creds.access_token;
    if (!accessToken) {
      throw new WorkloadIdentityError(`Credentials file at ${config.credentialsPath} must include 'access_token'`);
    }
    const expiresAt = creds.expires_at;
    if (!opts?.forceRefresh && (expiresAt == null || nowAsSeconds() < expiresAt - MANDATORY_REFRESH_THRESHOLD_IN_SECONDS)) {
      return { token: accessToken, expiresAt: expiresAt ?? null };
    }
    const refreshToken = creds.refresh_token;
    if (!config.clientId || !refreshToken) {
      throw new WorkloadIdentityError(`Access token at ${config.credentialsPath} has expired and no refresh is available (client_id ${config.clientId ? "set" : "empty"}, refresh_token ${refreshToken ? "set" : "empty"})`);
    }
    requireSecureTokenEndpoint(config.baseURL);
    const body = {
      grant_type: GRANT_TYPE_REFRESH_TOKEN,
      refresh_token: refreshToken,
      client_id: config.clientId
    };
    const url = `${config.baseURL}${TOKEN_ENDPOINT}`;
    let resp;
    try {
      resp = await config.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": OAUTH_API_BETA_HEADER,
          "User-Agent": config.userAgent || `anthropic-sdk-typescript/${VERSION2} userOAuthProvider`
        },
        body: JSON.stringify(body)
      });
    } catch (err2) {
      throw new WorkloadIdentityError(`User OAuth refresh failed to reach token endpoint: ${err2}`);
    }
    const requestId = resp.headers.get("Request-Id");
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new WorkloadIdentityError(`User OAuth refresh failed (HTTP ${resp.status}): ${redactSensitive(text)}`, resp.status, redactSensitive(text), requestId);
    }
    const data = await parseTokenResponse(resp, requestId);
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn)) {
      throw new WorkloadIdentityError(`User OAuth refresh response missing or invalid expires_in: ${JSON.stringify(redactSensitive(data))}`, resp.status, redactSensitive(data), requestId);
    }
    const newExpiresAt = nowAsSeconds() + expiresIn;
    const newRefreshToken = data.refresh_token || refreshToken;
    await writeCredentialsFileAtomic(config.credentialsPath, {
      ...creds,
      version: CREDENTIALS_FILE_VERSION,
      type: "oauth_token",
      access_token: data.access_token,
      expires_at: newExpiresAt,
      refresh_token: newRefreshToken
    });
    return { token: data.access_token, expiresAt: newExpiresAt };
  };
}
var init_user_oauth = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/user-oauth.mjs"() {
    init_credentials();
    init_types();
    init_time();
    init_version();
  }
});

// node_modules/@anthropic-ai/sdk/lib/credentials/credential-chain.mjs
function resolveCredentialsFromConfig(config, options) {
  const credentialsPath = config.authentication.credentials_path ?? null;
  const effectiveBaseURL = (config.base_url || options.baseURL).replace(/\/+$/, "");
  const provider = buildProvider(config, credentialsPath, effectiveBaseURL, options);
  const extraHeaders = {};
  if (config.workspace_id && config.authentication.type === "user_oauth") {
    extraHeaders["anthropic-workspace-id"] = config.workspace_id;
  }
  return { provider, extraHeaders, baseURL: config.base_url || void 0 };
}
async function defaultCredentials(options, profile) {
  const loaded = await loadConfigWithSource(profile);
  if (!loaded) {
    return null;
  }
  const { config, fromFile } = loaded;
  const withPath = config.authentication.credentials_path || !fromFile ? config : {
    ...config,
    authentication: {
      ...config.authentication,
      credentials_path: await getCredentialsPath(config, profile) ?? void 0
    }
  };
  return resolveCredentialsFromConfig(withPath, options);
}
function buildProvider(config, credentialsPath, baseURL, options) {
  switch (config.authentication.type) {
    case "oidc_federation": {
      const auth = config.authentication;
      const identityProvider = resolveIdentityTokenProvider(auth);
      if (!identityProvider) {
        throw new WorkloadIdentityError("oidc_federation config requires an identity token (set authentication.identity_token, ANTHROPIC_IDENTITY_TOKEN_FILE, or ANTHROPIC_IDENTITY_TOKEN)");
      }
      if (!auth.federation_rule_id) {
        throw new WorkloadIdentityError("oidc_federation config requires 'federation_rule_id'. Set it in authentication.federation_rule_id in your profile, or via ANTHROPIC_FEDERATION_RULE_ID (profile takes precedence).");
      }
      if (!config.organization_id) {
        throw new WorkloadIdentityError("oidc_federation config requires organization_id (set ANTHROPIC_ORGANIZATION_ID or config.organization_id)");
      }
      const exchange = oidcFederationProvider({
        identityTokenProvider: identityProvider,
        federationRuleId: auth.federation_rule_id,
        organizationId: config.organization_id,
        serviceAccountId: auth.service_account_id,
        workspaceId: config.workspace_id,
        baseURL,
        fetch: options.fetch,
        userAgent: options.userAgent
      });
      if (credentialsPath) {
        return cachedExchangeProvider(exchange, credentialsPath, options.onCacheWriteError, options.onSafetyWarning);
      }
      return exchange;
    }
    case "user_oauth": {
      if (!credentialsPath) {
        throw new WorkloadIdentityError("user_oauth config requires authentication.credentials_path (or load via a profile so it defaults to <config_dir>/credentials/<profile>.json)");
      }
      return userOAuthProvider({
        credentialsPath,
        clientId: config.authentication.client_id,
        baseURL,
        fetch: options.fetch,
        userAgent: options.userAgent,
        onSafetyWarning: options.onSafetyWarning
      });
    }
    default: {
      const t = config.authentication.type;
      throw new WorkloadIdentityError(`authentication.type "${t}" is not a known authentication type`);
    }
  }
}
function resolveIdentityTokenProvider(auth) {
  if (auth.identity_token) {
    const source = auth.identity_token.source;
    if (source !== "file") {
      throw new WorkloadIdentityError(`identity_token.source "${source}" is not supported by this SDK version (only "file")`);
    }
    if (!auth.identity_token.path) {
      throw new WorkloadIdentityError(`identity_token.source "file" requires a non-empty path`);
    }
    return identityTokenFromFile(auth.identity_token.path);
  }
  const tokenFile = readEnv("ANTHROPIC_IDENTITY_TOKEN_FILE");
  if (tokenFile) {
    return identityTokenFromFile(tokenFile);
  }
  const tokenValue = readEnv("ANTHROPIC_IDENTITY_TOKEN");
  if (tokenValue) {
    return identityTokenFromValue(tokenValue);
  }
  return null;
}
function cachedExchangeProvider(exchange, credentialsPath, onCacheWriteError, onSafetyWarning) {
  return async (opts) => {
    const fs4 = await import("node:fs");
    await checkCredentialsFileSafety(credentialsPath, onSafetyWarning);
    let existing;
    try {
      const raw = await fs4.promises.readFile(credentialsPath, "utf-8");
      existing = JSON.parse(raw);
      const token = existing?.["access_token"];
      if (token && !opts?.forceRefresh) {
        const expiresAt = existing?.["expires_at"];
        if (expiresAt == null || nowAsSeconds() < expiresAt - MANDATORY_REFRESH_THRESHOLD_IN_SECONDS) {
          return { token, expiresAt: expiresAt ?? null };
        }
      }
    } catch (err2) {
      const code = err2?.code;
      if (code !== "ENOENT" && !(err2 instanceof SyntaxError)) {
        onCacheWriteError?.(err2);
      }
    }
    const result = await exchange(opts);
    try {
      await writeCredentialsFileAtomic(credentialsPath, {
        ...existing ?? {},
        version: CREDENTIALS_FILE_VERSION,
        type: "oauth_token",
        access_token: result.token,
        expires_at: result.expiresAt
      });
    } catch (err2) {
      onCacheWriteError?.(err2);
    }
    return result;
  };
}
var init_credential_chain = __esm({
  "node_modules/@anthropic-ai/sdk/lib/credentials/credential-chain.mjs"() {
    init_env();
    init_credentials();
    init_types();
    init_time();
    init_identity_token();
    init_oidc_federation();
    init_user_oauth();
  }
});

// node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
function findNewlineIndex(buffer, startIndex) {
  const newline = 10;
  const carriage = 13;
  for (let i = startIndex ?? 0; i < buffer.length; i++) {
    if (buffer[i] === newline) {
      return { preceding: i, index: i + 1, carriage: false };
    }
    if (buffer[i] === carriage) {
      return { preceding: i, index: i + 1, carriage: true };
    }
  }
  return null;
}
function findDoubleNewlineIndex(buffer) {
  const newline = 10;
  const carriage = 13;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === newline && buffer[i + 1] === newline) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === carriage) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === newline && i + 3 < buffer.length && buffer[i + 2] === carriage && buffer[i + 3] === newline) {
      return i + 4;
    }
  }
  return -1;
}
var _LineDecoder_buffer, _LineDecoder_carriageReturnIndex, LineDecoder;
var init_line = __esm({
  "node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs"() {
    init_tslib();
    init_bytes();
    LineDecoder = class {
      constructor() {
        _LineDecoder_buffer.set(this, void 0);
        _LineDecoder_carriageReturnIndex.set(this, void 0);
        __classPrivateFieldSet(this, _LineDecoder_buffer, new Uint8Array(), "f");
        __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
      }
      decode(chunk) {
        if (chunk == null) {
          return [];
        }
        const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
        __classPrivateFieldSet(this, _LineDecoder_buffer, concatBytes([__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), binaryChunk]), "f");
        const lines = [];
        let patternIndex;
        while ((patternIndex = findNewlineIndex(__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f"))) != null) {
          if (patternIndex.carriage && __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") == null) {
            __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, patternIndex.index, "f");
            continue;
          }
          if (__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") != null && (patternIndex.index !== __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") + 1 || patternIndex.carriage)) {
            lines.push(decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") - 1)));
            __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f")), "f");
            __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
            continue;
          }
          const endIndex = __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
          const line = decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, endIndex));
          lines.push(line);
          __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(patternIndex.index), "f");
          __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
        }
        return lines;
      }
      flush() {
        if (!__classPrivateFieldGet(this, _LineDecoder_buffer, "f").length) {
          return [];
        }
        return this.decode("\n");
      }
    };
    _LineDecoder_buffer = /* @__PURE__ */ new WeakMap(), _LineDecoder_carriageReturnIndex = /* @__PURE__ */ new WeakMap();
    LineDecoder.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
    LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
  }
});

// node_modules/@anthropic-ai/sdk/core/streaming.mjs
async function* _iterSSEMessages(response, controller) {
  if (!response.body) {
    controller.abort();
    if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
      throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
    }
    throw new AnthropicError(`Attempted to iterate over a response with no body`);
  }
  const sseDecoder = new SSEDecoder();
  const lineDecoder = new LineDecoder();
  const iter = ReadableStreamToAsyncIterable(response.body);
  for await (const sseChunk of iterSSEChunks(iter)) {
    for (const line of lineDecoder.decode(sseChunk)) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield sse;
    }
  }
  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse)
      yield sse;
  }
}
async function* iterSSEChunks(iterator) {
  let data = new Uint8Array();
  for await (const chunk of iterator) {
    if (chunk == null) {
      continue;
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
    let newData = new Uint8Array(data.length + binaryChunk.length);
    newData.set(data);
    newData.set(binaryChunk, data.length);
    data = newData;
    let patternIndex;
    while ((patternIndex = findDoubleNewlineIndex(data)) !== -1) {
      yield data.slice(0, patternIndex);
      data = data.slice(patternIndex);
    }
  }
  if (data.length > 0) {
    yield data;
  }
}
function partition(str, delimiter2) {
  const index = str.indexOf(delimiter2);
  if (index !== -1) {
    return [str.substring(0, index), delimiter2, str.substring(index + delimiter2.length)];
  }
  return [str, "", ""];
}
var _Stream_client, Stream, SSEDecoder;
var init_streaming = __esm({
  "node_modules/@anthropic-ai/sdk/core/streaming.mjs"() {
    init_tslib();
    init_error();
    init_shims();
    init_line();
    init_shims();
    init_errors();
    init_values();
    init_bytes();
    init_log();
    init_error();
    init_request_signal();
    Stream = class _Stream {
      constructor(iterator, controller, client) {
        this.iterator = iterator;
        _Stream_client.set(this, void 0);
        this.controller = controller;
        __classPrivateFieldSet(this, _Stream_client, client, "f");
      }
      /**
       * Iterate the raw Server-Sent Events from `response` — `{event, data, raw}`
       * objects, before any JSON parsing or event-name filtering.
       *
       * This reads `response.body` directly (not a clone), so the response is
       * consumed. Use this in middleware that fully replaces the stream body; for
       * read-only observation of parsed events, use `ctx.parse()` instead.
       */
      static rawEvents(response, controller = new AbortController()) {
        return _iterSSEMessages(response, controller);
      }
      static fromSSEResponse(response, controller, client) {
        let consumed = false;
        const logger = client ? loggerFor(client) : console;
        async function* iterator() {
          if (consumed) {
            throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
          }
          consumed = true;
          let done = false;
          try {
            for await (const sse of _iterSSEMessages(response, controller)) {
              if (sse.event === "completion") {
                try {
                  yield JSON.parse(sse.data);
                } catch (e) {
                  logger.error(`Could not parse message into JSON:`, sse.data);
                  logger.error(`From chunk:`, sse.raw);
                  throw e;
                }
              }
              if (sse.event === "message_start" || sse.event === "message_delta" || sse.event === "message_stop" || sse.event === "content_block_start" || sse.event === "content_block_delta" || sse.event === "content_block_stop" || sse.event === "message" || sse.event === "user.message" || sse.event === "user.interrupt" || sse.event === "user.tool_confirmation" || sse.event === "user.custom_tool_result" || sse.event === "user.tool_result" || sse.event === "agent.message" || sse.event === "agent.thinking" || sse.event === "agent.tool_use" || sse.event === "agent.tool_result" || sse.event === "agent.mcp_tool_use" || sse.event === "agent.mcp_tool_result" || sse.event === "agent.custom_tool_use" || sse.event === "agent.thread_context_compacted" || sse.event === "session.status_running" || sse.event === "session.status_idle" || sse.event === "session.status_rescheduled" || sse.event === "session.status_terminated" || sse.event === "session.error" || sse.event === "session.deleted" || sse.event === "session.updated" || sse.event === "span.model_request_start" || sse.event === "span.model_request_end" || sse.event === "span.outcome_evaluation_start" || sse.event === "span.outcome_evaluation_ongoing" || sse.event === "span.outcome_evaluation_end" || sse.event === "user.define_outcome" || sse.event === "agent.thread_message_received" || sse.event === "agent.thread_message_sent" || sse.event === "agent.session_thread_message_received" || sse.event === "agent.session_thread_message_sent" || sse.event === "session.thread_created" || sse.event === "session.thread_status_created" || sse.event === "session.thread_status_running" || sse.event === "session.thread_status_idle" || sse.event === "session.thread_status_rescheduled" || sse.event === "session.thread_status_terminated" || sse.event === "event_start" || sse.event === "event_delta" || sse.event === "system.message") {
                try {
                  yield JSON.parse(sse.data);
                } catch (e) {
                  logger.error(`Could not parse message into JSON:`, sse.data);
                  logger.error(`From chunk:`, sse.raw);
                  throw e;
                }
              }
              if (sse.event === "ping") {
                continue;
              }
              if (sse.event === "error") {
                const body = safeJSON(sse.data) ?? sse.data;
                const type = body?.error?.type;
                throw new APIError(void 0, body, void 0, response.headers, type);
              }
            }
            done = true;
          } catch (e) {
            if (isAbortError(e))
              return;
            throw e;
          } finally {
            if (!done)
              controller.abort();
            releaseRequestSignal(controller);
          }
        }
        return new _Stream(iterator, controller, client);
      }
      /**
       * Generates a Stream from a newline-separated ReadableStream
       * where each item is a JSON value.
       */
      static fromReadableStream(readableStream, controller, client) {
        let consumed = false;
        async function* iterLines() {
          const lineDecoder = new LineDecoder();
          const iter = ReadableStreamToAsyncIterable(readableStream);
          for await (const chunk of iter) {
            for (const line of lineDecoder.decode(chunk)) {
              yield line;
            }
          }
          for (const line of lineDecoder.flush()) {
            yield line;
          }
        }
        async function* iterator() {
          if (consumed) {
            throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
          }
          consumed = true;
          let done = false;
          try {
            for await (const line of iterLines()) {
              if (done)
                continue;
              if (line)
                yield JSON.parse(line);
            }
            done = true;
          } catch (e) {
            if (isAbortError(e))
              return;
            throw e;
          } finally {
            if (!done)
              controller.abort();
            releaseRequestSignal(controller);
          }
        }
        return new _Stream(iterator, controller, client);
      }
      [(_Stream_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
        return this.iterator();
      }
      /**
       * Splits the stream into two streams which can be
       * independently read from at different speeds.
       */
      tee() {
        const left = [];
        const right = [];
        const iterator = this.iterator();
        const teeIterator = (queue) => {
          return {
            next: () => {
              if (queue.length === 0) {
                const result = iterator.next();
                left.push(result);
                right.push(result);
              }
              return queue.shift();
            }
          };
        };
        return [
          new _Stream(() => teeIterator(left), this.controller, __classPrivateFieldGet(this, _Stream_client, "f")),
          new _Stream(() => teeIterator(right), this.controller, __classPrivateFieldGet(this, _Stream_client, "f"))
        ];
      }
      /**
       * Converts this stream to a newline-separated ReadableStream of
       * JSON stringified values in the stream
       * which can be turned back into a Stream with `Stream.fromReadableStream()`.
       */
      toReadableStream() {
        const self = this;
        let iter;
        return makeReadableStream({
          async start() {
            iter = self[Symbol.asyncIterator]();
          },
          async pull(ctrl) {
            try {
              const { value, done } = await iter.next();
              if (done)
                return ctrl.close();
              const bytes = encodeUTF8(JSON.stringify(value) + "\n");
              ctrl.enqueue(bytes);
            } catch (err2) {
              ctrl.error(err2);
            }
          },
          async cancel() {
            await iter.return?.();
          }
        });
      }
    };
    SSEDecoder = class {
      constructor() {
        this.event = null;
        this.data = [];
        this.chunks = [];
      }
      decode(line) {
        if (line.endsWith("\r")) {
          line = line.substring(0, line.length - 1);
        }
        if (!line) {
          if (!this.event && !this.data.length)
            return null;
          const sse = {
            event: this.event,
            data: this.data.join("\n"),
            raw: this.chunks
          };
          this.event = null;
          this.data = [];
          this.chunks = [];
          return sse;
        }
        this.chunks.push(line);
        if (line.startsWith(":")) {
          return null;
        }
        let [fieldname, _, value] = partition(line, ":");
        if (value.startsWith(" ")) {
          value = value.substring(1);
        }
        if (fieldname === "event") {
          this.event = value;
        } else if (fieldname === "data") {
          this.data.push(value);
        }
        return null;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/parse.mjs
async function defaultParseResponse(client, props) {
  const { response, requestLogID, retryOfRequestLogID, startTime } = props;
  const body = await (async () => {
    if (props.options.stream) {
      loggerFor(client).debug("response", response.status, response.url, response.headers, response.body);
      return Stream.fromSSEResponse(response, props.controller);
    }
    if (response.status === 204) {
      return null;
    }
    if (props.options.__binaryResponse) {
      return response;
    }
    const contentType = response.headers.get("content-type");
    const mediaType = contentType?.split(";")[0]?.trim();
    const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
    if (isJSON) {
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return void 0;
      }
      const json = await response.json();
      return addRequestID(json, response);
    }
    const text = await response.text();
    return text;
  })().finally(() => {
    if (!props.options.stream && !props.options.__binaryResponse) {
      releaseRequestSignal(props.controller);
    }
  });
  loggerFor(client).debug(`[${requestLogID}] response parsed`, formatRequestDetails({
    retryOfRequestLogID,
    url: response.url,
    status: response.status,
    body,
    durationMs: Date.now() - startTime
  }));
  return body;
}
function addRequestID(value, response) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.defineProperty(value, "_request_id", {
    value: response.headers.get("request-id"),
    enumerable: false
  });
}
var init_parse = __esm({
  "node_modules/@anthropic-ai/sdk/internal/parse.mjs"() {
    init_streaming();
    init_log();
    init_request_signal();
  }
});

// node_modules/@anthropic-ai/sdk/core/middleware.mjs
function isFetchOriginError(err2) {
  return typeof err2 === "object" && err2 !== null && fetchOriginErrors.has(err2);
}
function isRetryableError(err2) {
  const seen = /* @__PURE__ */ new Set();
  while (typeof err2 === "object" && err2 !== null && !seen.has(err2)) {
    seen.add(err2);
    if (isFetchOriginError(err2) || isAbortError(err2) || err2 instanceof APIConnectionError || err2 instanceof RetryableError) {
      return true;
    }
    err2 = err2.cause;
  }
  return false;
}
function wrapFetchWithMiddleware(fetchFn, middleware, options, client) {
  return async (url, init = {}) => {
    if (middleware.length === 0) {
      return fetchFn.call(void 0, url, init);
    }
    const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    const response = await applyMiddleware(fetchFn, middleware, options, client)({
      ...init,
      headers,
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    });
    if (response.bodyUsed || response.body?.locked) {
      throw new AnthropicError("middleware consumed the response body; use response.clone() to inspect it, or return new Response(body, response) to consume and replace it");
    }
    return response;
  };
}
function createMiddlewareContext(options, client) {
  const cache = /* @__PURE__ */ new WeakMap();
  return {
    options,
    // Resolved per chain, so changes to the client's `logLevel`/`logger`
    // apply to subsequent requests.
    logger: client ? loggerFor(client) : defaultLogger(),
    parse(response) {
      if (options?.stream && response.ok) {
        return parseMiddlewareResponse(response, options);
      }
      let parsed = cache.get(response);
      if (!parsed) {
        parsed = parseMiddlewareResponse(response, options);
        cache.set(response, parsed);
      }
      return parsed;
    }
  };
}
async function parseMiddlewareResponse(response, options) {
  if (response.bodyUsed || response.body?.locked) {
    throw new AnthropicError("cannot ctx.parse() a response whose body was already consumed; call ctx.parse() instead of reading the body, or read via response.clone()");
  }
  if (options?.stream && response.ok) {
    return Stream.fromSSEResponse(response.clone(), new AbortController());
  }
  if (response.status === 204) {
    return null;
  }
  if (options?.__binaryResponse) {
    return response;
  }
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";")[0]?.trim();
  const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
  if (isJSON) {
    if (response.headers.get("content-length") === "0") {
      return void 0;
    }
    return addRequestID(await response.clone().json(), response);
  }
  return await response.clone().text();
}
function applyMiddleware(fetchFn, middleware, options, client) {
  let next = async ({ url, ...init }) => {
    try {
      return await fetchFn.call(void 0, url, init);
    } catch (err2) {
      const error = castToError(err2);
      fetchOriginErrors.add(error);
      throw error;
    }
  };
  const ctx = createMiddlewareContext(options, client);
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    const nextInner = next;
    next = async (request) => mw(request, nextInner, ctx);
  }
  return next;
}
var fetchOriginErrors;
var init_middleware = __esm({
  "node_modules/@anthropic-ai/sdk/core/middleware.mjs"() {
    init_errors();
    init_parse();
    init_log();
    init_error();
    init_streaming();
    fetchOriginErrors = /* @__PURE__ */ new WeakSet();
  }
});

// node_modules/@anthropic-ai/sdk/core/api-promise.mjs
var _APIPromise_client, APIPromise;
var init_api_promise = __esm({
  "node_modules/@anthropic-ai/sdk/core/api-promise.mjs"() {
    init_tslib();
    init_parse();
    APIPromise = class _APIPromise extends Promise {
      constructor(client, responsePromise, parseResponse = defaultParseResponse) {
        super((resolve5) => {
          resolve5(null);
        });
        this.responsePromise = responsePromise;
        this.parseResponse = parseResponse;
        _APIPromise_client.set(this, void 0);
        __classPrivateFieldSet(this, _APIPromise_client, client, "f");
      }
      _thenUnwrap(transform) {
        return new _APIPromise(__classPrivateFieldGet(this, _APIPromise_client, "f"), this.responsePromise, async (client, props) => addRequestID(transform(await this.parseResponse(client, props), props), props.response));
      }
      /**
       * Gets the raw `Response` instance instead of parsing the response
       * data.
       *
       * If you want to parse the response body but still get the `Response`
       * instance, you can use {@link withResponse()}.
       *
       * 👋 Getting the wrong TypeScript type for `Response`?
       * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
       * to your `tsconfig.json`.
       */
      asResponse() {
        return this.responsePromise.then((p) => p.response);
      }
      /**
       * Gets the parsed response data, the raw `Response` instance and the ID of the request,
       * returned via the `request-id` header which is useful for debugging requests and resporting
       * issues to Anthropic.
       *
       * If you just want to get the raw `Response` instance without parsing it,
       * you can use {@link asResponse()}.
       *
       * 👋 Getting the wrong TypeScript type for `Response`?
       * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
       * to your `tsconfig.json`.
       */
      async withResponse() {
        const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
        return { data, response, request_id: response.headers.get("request-id") };
      }
      parse() {
        if (!this.parsedPromise) {
          this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(__classPrivateFieldGet(this, _APIPromise_client, "f"), data));
        }
        return this.parsedPromise;
      }
      then(onfulfilled, onrejected) {
        return this.parse().then(onfulfilled, onrejected);
      }
      catch(onrejected) {
        return this.parse().catch(onrejected);
      }
      finally(onfinally) {
        return this.parse().finally(onfinally);
      }
    };
    _APIPromise_client = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@anthropic-ai/sdk/core/pagination.mjs
var _AbstractPage_client, AbstractPage, PagePromise, Page, PageCursor, BidirectionalPageCursor;
var init_pagination = __esm({
  "node_modules/@anthropic-ai/sdk/core/pagination.mjs"() {
    init_tslib();
    init_error();
    init_parse();
    init_api_promise();
    init_values();
    AbstractPage = class {
      constructor(client, response, body, options) {
        _AbstractPage_client.set(this, void 0);
        __classPrivateFieldSet(this, _AbstractPage_client, client, "f");
        this.options = options;
        this.response = response;
        this.body = body;
      }
      hasNextPage() {
        const items = this.getPaginatedItems();
        if (!items.length)
          return false;
        return this.nextPageRequestOptions() != null;
      }
      async getNextPage() {
        const nextOptions = this.nextPageRequestOptions();
        if (!nextOptions) {
          throw new AnthropicError("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
        }
        return await __classPrivateFieldGet(this, _AbstractPage_client, "f").requestAPIList(this.constructor, nextOptions);
      }
      async *iterPages() {
        let page = this;
        yield page;
        while (page.hasNextPage()) {
          page = await page.getNextPage();
          yield page;
        }
      }
      async *[(_AbstractPage_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
        for await (const page of this.iterPages()) {
          for (const item of page.getPaginatedItems()) {
            yield item;
          }
        }
      }
    };
    PagePromise = class extends APIPromise {
      constructor(client, request, Page2) {
        super(client, request, async (client2, props) => new Page2(client2, props.response, await defaultParseResponse(client2, props), props.options));
      }
      /**
       * Allow auto-paginating iteration on an unawaited list call, eg:
       *
       *    for await (const item of client.items.list()) {
       *      console.log(item)
       *    }
       */
      async *[Symbol.asyncIterator]() {
        const page = await this;
        for await (const item of page) {
          yield item;
        }
      }
    };
    Page = class extends AbstractPage {
      constructor(client, response, body, options) {
        super(client, response, body, options);
        this.data = body.data || [];
        this.has_more = body.has_more || false;
        this.first_id = body.first_id || null;
        this.last_id = body.last_id || null;
      }
      getPaginatedItems() {
        return this.data ?? [];
      }
      hasNextPage() {
        if (this.has_more === false) {
          return false;
        }
        return super.hasNextPage();
      }
      nextPageRequestOptions() {
        if (this.options.query?.["before_id"]) {
          const first_id = this.first_id;
          if (!first_id) {
            return null;
          }
          return {
            ...this.options,
            query: {
              ...maybeObj(this.options.query),
              before_id: first_id
            }
          };
        }
        const cursor = this.last_id;
        if (!cursor) {
          return null;
        }
        return {
          ...this.options,
          query: {
            ...maybeObj(this.options.query),
            after_id: cursor
          }
        };
      }
    };
    PageCursor = class extends AbstractPage {
      constructor(client, response, body, options) {
        super(client, response, body, options);
        this.data = body.data || [];
        this.next_page = body.next_page || null;
      }
      getPaginatedItems() {
        return this.data ?? [];
      }
      nextPageRequestOptions() {
        const cursor = this.next_page;
        if (!cursor) {
          return null;
        }
        return {
          ...this.options,
          query: {
            ...maybeObj(this.options.query),
            page: cursor
          }
        };
      }
    };
    BidirectionalPageCursor = class extends AbstractPage {
      constructor(client, response, body, options) {
        super(client, response, body, options);
        this.data = body.data || [];
        this.next_page = body.next_page || null;
        this.prev_page = body.prev_page || null;
      }
      getPaginatedItems() {
        return this.data ?? [];
      }
      nextPageRequestOptions() {
        const cursor = this.next_page;
        if (!cursor) {
          return null;
        }
        return {
          ...this.options,
          query: {
            ...maybeObj(this.options.query),
            page: cursor
          }
        };
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/uploads.mjs
function makeFile(fileBits, fileName, options) {
  checkFileSupport();
  return new File(fileBits, fileName ?? "unknown_file", options);
}
function getName(value, stripPath) {
  const val = typeof value === "object" && value !== null && ("name" in value && value.name && String(value.name) || "url" in value && value.url && String(value.url) || "filename" in value && value.filename && String(value.filename) || "path" in value && value.path && String(value.path)) || "";
  return stripPath ? val.split(/[\\/]/).pop() || void 0 : val;
}
function supportsFormData(fetchObject) {
  const fetch2 = typeof fetchObject === "function" ? fetchObject : fetchObject.fetch;
  const cached = supportsFormDataMap.get(fetch2);
  if (cached)
    return cached;
  const promise = (async () => {
    try {
      const FetchResponse = "Response" in fetch2 ? fetch2.Response : (await fetch2("data:,")).constructor;
      const data = new FormData();
      if (data.toString() === await new FetchResponse(data).text()) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  })();
  supportsFormDataMap.set(fetch2, promise);
  return promise;
}
var checkFileSupport, isAsyncIterable, multipartFormRequestOptions, supportsFormDataMap, createForm, isNamedBlob, addFormValue;
var init_uploads = __esm({
  "node_modules/@anthropic-ai/sdk/internal/uploads.mjs"() {
    init_shims();
    checkFileSupport = () => {
      if (typeof File === "undefined") {
        const { process: process2 } = globalThis;
        const isOldNode = typeof process2?.versions?.node === "string" && parseInt(process2.versions.node.split(".")) < 20;
        throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
      }
    };
    isAsyncIterable = (value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";
    multipartFormRequestOptions = async (opts, fetch2, stripFilenames = true) => {
      return { ...opts, body: await createForm(opts.body, fetch2, stripFilenames) };
    };
    supportsFormDataMap = /* @__PURE__ */ new WeakMap();
    createForm = async (body, fetch2, stripFilenames = true) => {
      if (!await supportsFormData(fetch2)) {
        throw new TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
      }
      const form = new FormData();
      await Promise.all(Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value, stripFilenames)));
      return form;
    };
    isNamedBlob = (value) => value instanceof Blob && "name" in value;
    addFormValue = async (form, key, value, stripFilenames) => {
      if (value === void 0)
        return;
      if (value == null) {
        throw new TypeError(`Received null for "${key}"; to pass null in FormData, you must use the string 'null'`);
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        form.append(key, String(value));
      } else if (value instanceof Response) {
        let options = {};
        const contentType = value.headers.get("Content-Type");
        if (contentType) {
          options = { type: contentType };
        }
        form.append(key, makeFile([await value.blob()], getName(value, stripFilenames), options));
      } else if (isAsyncIterable(value)) {
        form.append(key, makeFile([await new Response(ReadableStreamFrom(value)).blob()], getName(value, stripFilenames)));
      } else if (isNamedBlob(value)) {
        form.append(key, makeFile([value], getName(value, stripFilenames), { type: value.type }));
      } else if (Array.isArray(value)) {
        await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry, stripFilenames)));
      } else if (typeof value === "object") {
        await Promise.all(Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop, stripFilenames)));
      } else {
        throw new TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/to-file.mjs
async function toFile(value, name, options) {
  checkFileSupport();
  value = await value;
  name || (name = getName(value, true));
  if (isFileLike(value)) {
    if (value instanceof File && name == null && options == null) {
      return value;
    }
    return makeFile([await value.arrayBuffer()], name ?? value.name, {
      type: value.type,
      lastModified: value.lastModified,
      ...options
    });
  }
  if (isResponseLike(value)) {
    const blob = await value.blob();
    name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
    return makeFile(await getBytes(blob), name, options);
  }
  const parts = await getBytes(value);
  if (!options?.type) {
    const type = parts.find((part) => typeof part === "object" && "type" in part && part.type);
    if (typeof type === "string") {
      options = { ...options, type };
    }
  }
  return makeFile(parts, name, options);
}
async function getBytes(value) {
  let parts = [];
  if (typeof value === "string" || ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
  value instanceof ArrayBuffer) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(value instanceof Blob ? value : await value.arrayBuffer());
  } else if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      parts.push(...await getBytes(chunk));
    }
  } else {
    const constructor = value?.constructor?.name;
    throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
  }
  return parts;
}
function propsForError(value) {
  if (typeof value !== "object" || value === null)
    return "";
  const props = Object.getOwnPropertyNames(value);
  return `; props: [${props.map((p) => `"${p}"`).join(", ")}]`;
}
var isBlobLike, isFileLike, isResponseLike;
var init_to_file = __esm({
  "node_modules/@anthropic-ai/sdk/internal/to-file.mjs"() {
    init_uploads();
    init_uploads();
    isBlobLike = (value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function";
    isFileLike = (value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value);
    isResponseLike = (value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function";
  }
});

// node_modules/@anthropic-ai/sdk/core/uploads.mjs
var init_uploads2 = __esm({
  "node_modules/@anthropic-ai/sdk/core/uploads.mjs"() {
    init_to_file();
  }
});

// node_modules/@anthropic-ai/sdk/resources/shared.mjs
var init_shared = __esm({
  "node_modules/@anthropic-ai/sdk/resources/shared.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/core/resource.mjs
var APIResource;
var init_resource = __esm({
  "node_modules/@anthropic-ai/sdk/core/resource.mjs"() {
    APIResource = class {
      constructor(client) {
        this._client = client;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/headers.mjs
function* iterateHeaders(headers) {
  if (!headers)
    return;
  if (brand_privateNullableHeaders in headers) {
    const { values, nulls } = headers;
    yield* values.entries();
    for (const name of nulls) {
      yield [name, null];
    }
    return;
  }
  let shouldClear = false;
  let iter;
  if (headers instanceof Headers) {
    iter = headers.entries();
  } else if (isReadonlyArray(headers)) {
    iter = headers;
  } else {
    shouldClear = true;
    iter = Object.entries(headers ?? {});
  }
  for (let row of iter) {
    const name = row[0];
    if (typeof name !== "string")
      throw new TypeError("expected header name to be a string");
    const values = isReadonlyArray(row[1]) ? row[1] : [row[1]];
    let didClear = false;
    for (const value of values) {
      if (value === void 0)
        continue;
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, clearSentinel];
      }
      yield [name, value];
    }
  }
}
var brand_privateNullableHeaders, clearSentinel, APPEND_HEADERS, appendHeaderValue, buildHeaders;
var init_headers = __esm({
  "node_modules/@anthropic-ai/sdk/internal/headers.mjs"() {
    init_values();
    brand_privateNullableHeaders = Symbol.for("brand.privateNullableHeaders");
    clearSentinel = Symbol("clear");
    APPEND_HEADERS = /* @__PURE__ */ new Set(["x-stainless-helper"]);
    appendHeaderValue = (existing, addition) => {
      const tokens = existing ? existing.split(",").map((t) => t.trim()).filter(Boolean) : [];
      for (const tok of addition.split(",").map((t) => t.trim())) {
        if (tok && !tokens.includes(tok))
          tokens.push(tok);
      }
      return tokens.join(", ");
    };
    buildHeaders = (newHeaders) => {
      const targetHeaders = new Headers();
      const nullHeaders = /* @__PURE__ */ new Set();
      for (const headers of newHeaders) {
        const seenHeaders = /* @__PURE__ */ new Set();
        for (const [name, value] of iterateHeaders(headers)) {
          const lowerName = name.toLowerCase();
          if (APPEND_HEADERS.has(lowerName)) {
            if (value === clearSentinel)
              continue;
            if (value === null) {
              targetHeaders.delete(name);
              nullHeaders.add(lowerName);
            } else {
              targetHeaders.set(name, appendHeaderValue(targetHeaders.get(name), value));
              nullHeaders.delete(lowerName);
            }
            continue;
          }
          if (value === clearSentinel || !seenHeaders.has(lowerName)) {
            targetHeaders.delete(name);
            seenHeaders.add(lowerName);
            if (value === clearSentinel)
              continue;
          }
          if (value === null) {
            targetHeaders.delete(name);
            nullHeaders.add(lowerName);
          } else {
            targetHeaders.append(name, value);
            nullHeaders.delete(lowerName);
          }
        }
      }
      return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/path.mjs
function encodeURIPath(str) {
  return str.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
var EMPTY, createPathTagFunction, path;
var init_path = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/path.mjs"() {
    init_error();
    EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
    createPathTagFunction = (pathEncoder = encodeURIPath) => function path5(statics, ...params) {
      if (statics.length === 1)
        return statics[0];
      let postPath = false;
      const invalidSegments = [];
      const path6 = statics.reduce((previousValue, currentValue, index) => {
        if (/[?#]/.test(currentValue)) {
          postPath = true;
        }
        const value = params[index];
        let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
        if (index !== params.length && (value == null || typeof value === "object" && // handle values from other realms
        value.toString === Object.getPrototypeOf(Object.getPrototypeOf(value.hasOwnProperty ?? EMPTY) ?? EMPTY)?.toString)) {
          encoded = value + "";
          invalidSegments.push({
            start: previousValue.length + currentValue.length,
            length: encoded.length,
            error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
          });
        }
        return previousValue + currentValue + (index === params.length ? "" : encoded);
      }, "");
      const pathOnly = path6.split(/[?#]/, 1)[0];
      const invalidSegmentPattern = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
      let match;
      while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) {
        invalidSegments.push({
          start: match.index,
          length: match[0].length,
          error: `Value "${match[0]}" can't be safely passed as a path parameter`
        });
      }
      invalidSegments.sort((a, b) => a.start - b.start);
      if (invalidSegments.length > 0) {
        let lastEnd = 0;
        const underline = invalidSegments.reduce((acc, segment) => {
          const spaces = " ".repeat(segment.start - lastEnd);
          const arrows = "^".repeat(segment.length);
          lastEnd = segment.start + segment.length;
          return acc + spaces + arrows;
        }, "");
        throw new AnthropicError(`Path parameters result in path with invalid segments:
${invalidSegments.map((e) => e.error).join("\n")}
${path6}
${underline}`);
      }
      return path6;
    };
    path = /* @__PURE__ */ createPathTagFunction(encodeURIPath);
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/deployment-runs.mjs
var DeploymentRuns;
var init_deployment_runs = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/deployment-runs.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    DeploymentRuns = class extends APIResource {
      /**
       * Get Deployment Run
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeploymentRun =
       *   await client.beta.deploymentRuns.retrieve(
       *     'deployment_run_id',
       *   );
       * ```
       */
      retrieve(deploymentRunID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/deployment_runs/${deploymentRunID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Deployment Runs
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsDeploymentRun of client.beta.deploymentRuns.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/deployment_runs?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/deployments.mjs
var Deployments;
var init_deployments = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/deployments.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Deployments = class extends APIResource {
      /**
       * Create Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.create({
       *     agent: 'string',
       *     environment_id: 'x',
       *     initial_events: [
       *       {
       *         content: [
       *           {
       *             text: 'Where is my order #1234?',
       *             type: 'text',
       *           },
       *         ],
       *         type: 'user.message',
       *       },
       *     ],
       *     name: 'x',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/deployments?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.retrieve(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      retrieve(deploymentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/deployments/${deploymentID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.update(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      update(deploymentID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/deployments/${deploymentID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Deployments
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsDeployment of client.beta.deployments.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/deployments?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.archive(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      archive(deploymentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/deployments/${deploymentID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Pause Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.pause(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      pause(deploymentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/deployments/${deploymentID}/pause?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Run Deployment Now
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeploymentRun =
       *   await client.beta.deployments.run(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      run(deploymentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/deployments/${deploymentID}/run?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Unpause Deployment
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeployment =
       *   await client.beta.deployments.unpause(
       *     'depl_011CZkZcDH3vPqd7xnEfwTai',
       *   );
       * ```
       */
      unpause(deploymentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/deployments/${deploymentID}/unpause?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/dreams.mjs
var Dreams;
var init_dreams = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/dreams.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Dreams = class extends APIResource {
      /**
       * Create a Dream
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.create({
       *   inputs: [{ memory_store_id: 'x', type: 'memory_store' }],
       *   model: 'string',
       * });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/dreams?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get a Dream
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.retrieve(
       *   'dream_id',
       * );
       * ```
       */
      retrieve(dreamID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/dreams/${dreamID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Dreams
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaDream of client.beta.dreams.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/dreams?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive a Dream
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.archive(
       *   'dream_id',
       * );
       * ```
       */
      archive(dreamID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/dreams/${dreamID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Cancel a Dream
       *
       * @example
       * ```ts
       * const betaDream = await client.beta.dreams.cancel(
       *   'dream_id',
       * );
       * ```
       */
      cancel(dreamID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/dreams/${dreamID}/cancel?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "dreaming-2026-04-21"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/stainless-helper-header.mjs
function helperHeader(value) {
  return { [STAINLESS_HELPER_HEADER]: value };
}
function wasCreatedByStainlessHelper(value) {
  return typeof value === "object" && value !== null && SDK_HELPER_SYMBOL in value;
}
function collectStainlessHelpers(tools, messages) {
  const helpers = /* @__PURE__ */ new Set();
  if (tools) {
    for (const tool of tools) {
      if (wasCreatedByStainlessHelper(tool)) {
        helpers.add(tool[SDK_HELPER_SYMBOL]);
      }
    }
  }
  if (messages) {
    for (const message of messages) {
      if (wasCreatedByStainlessHelper(message)) {
        helpers.add(message[SDK_HELPER_SYMBOL]);
      }
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (wasCreatedByStainlessHelper(block)) {
            helpers.add(block[SDK_HELPER_SYMBOL]);
          }
        }
      }
    }
  }
  return Array.from(helpers);
}
function stainlessHelperHeader(tools, messages) {
  const helpers = collectStainlessHelpers(tools, messages);
  if (helpers.length === 0)
    return {};
  return { [STAINLESS_HELPER_HEADER]: helpers.join(", ") };
}
function stainlessHelperHeaderFromFile(file) {
  if (wasCreatedByStainlessHelper(file)) {
    return { [STAINLESS_HELPER_HEADER]: file[SDK_HELPER_SYMBOL] };
  }
  return {};
}
var STAINLESS_HELPER_HEADER, STAINLESS_HELPER_METHOD_HEADER, SDK_HELPER_SYMBOL;
var init_stainless_helper_header = __esm({
  "node_modules/@anthropic-ai/sdk/internal/stainless-helper-header.mjs"() {
    STAINLESS_HELPER_HEADER = "x-stainless-helper";
    STAINLESS_HELPER_METHOD_HEADER = "x-stainless-helper-method";
    SDK_HELPER_SYMBOL = Symbol("anthropic.sdk.stainlessHelper");
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/files.mjs
var Files;
var init_files = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/files.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_stainless_helper_header();
    init_uploads();
    init_path();
    Files = class extends APIResource {
      /**
       * List Files
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const fileMetadata of client.beta.files.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/files?beta=true", Page, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete File
       *
       * @example
       * ```ts
       * const deletedFile = await client.beta.files.delete(
       *   'file_id',
       * );
       * ```
       */
      delete(fileID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/files/${fileID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Download File
       *
       * @example
       * ```ts
       * const response = await client.beta.files.download(
       *   'file_id',
       * );
       *
       * const content = await response.blob();
       * console.log(content);
       * ```
       */
      download(fileID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/files/${fileID}/content?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString(),
              Accept: "application/binary"
            },
            options?.headers
          ]),
          __binaryResponse: true
        });
      }
      /**
       * Get File Metadata
       *
       * @example
       * ```ts
       * const fileMetadata =
       *   await client.beta.files.retrieveMetadata('file_id');
       * ```
       */
      retrieveMetadata(fileID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/files/${fileID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Upload File
       *
       * @example
       * ```ts
       * const fileMetadata = await client.beta.files.upload({
       *   file: fs.createReadStream('path/to/file'),
       * });
       * ```
       */
      upload(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/files?beta=true", multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
            stainlessHelperHeaderFromFile(body.file),
            options?.headers
          ])
        }, this._client));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/models.mjs
var Models;
var init_models = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/models.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Models = class extends APIResource {
      /**
       * Get a specific model.
       *
       * The Models API response can be used to determine information about a specific
       * model or resolve a model alias to a model ID.
       *
       * @example
       * ```ts
       * const betaModelInfo = await client.beta.models.retrieve(
       *   'model_id',
       * );
       * ```
       */
      retrieve(modelID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/models/${modelID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * List available models.
       *
       * The Models API response can be used to determine which models are available for
       * use in the API. More recently released models are listed first.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaModelInfo of client.beta.models.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/models?beta=true", Page, {
          query,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs
var UserProfiles;
var init_user_profiles = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    UserProfiles = class extends APIResource {
      /**
       * Create User Profile
       *
       * @example
       * ```ts
       * const betaUserProfile =
       *   await client.beta.userProfiles.create();
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/user_profiles?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get User Profile
       *
       * @example
       * ```ts
       * const betaUserProfile =
       *   await client.beta.userProfiles.retrieve(
       *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
       *   );
       * ```
       */
      retrieve(userProfileID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/user_profiles/${userProfileID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update User Profile
       *
       * @example
       * ```ts
       * const betaUserProfile =
       *   await client.beta.userProfiles.update(
       *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
       *   );
       * ```
       */
      update(userProfileID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/user_profiles/${userProfileID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List User Profiles
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaUserProfile of client.beta.userProfiles.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/user_profiles?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Create Enrollment URL
       *
       * @example
       * ```ts
       * const betaUserProfileEnrollmentURL =
       *   await client.beta.userProfiles.createEnrollmentURL(
       *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
       *   );
       * ```
       */
      createEnrollmentURL(userProfileID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/user_profiles/${userProfileID}/enrollment_url?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/standardwebhooks/dist/timing_safe_equal.js
var require_timing_safe_equal = __commonJS({
  "node_modules/standardwebhooks/dist/timing_safe_equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.timingSafeEqual = void 0;
    function assert(expr, msg = "") {
      if (!expr) {
        throw new Error(msg);
      }
    }
    function timingSafeEqual2(a, b) {
      if (a.byteLength !== b.byteLength) {
        return false;
      }
      if (!(a instanceof DataView)) {
        a = new DataView(ArrayBuffer.isView(a) ? a.buffer : a);
      }
      if (!(b instanceof DataView)) {
        b = new DataView(ArrayBuffer.isView(b) ? b.buffer : b);
      }
      assert(a instanceof DataView);
      assert(b instanceof DataView);
      const length = a.byteLength;
      let out2 = 0;
      let i = -1;
      while (++i < length) {
        out2 |= a.getUint8(i) ^ b.getUint8(i);
      }
      return out2 === 0;
    }
    exports.timingSafeEqual = timingSafeEqual2;
  }
});

// node_modules/@stablelib/base64/lib/base64.js
var require_base64 = __commonJS({
  "node_modules/@stablelib/base64/lib/base64.js"(exports) {
    "use strict";
    var __extends = exports && exports.__extends || /* @__PURE__ */ (function() {
      var extendStatics = function(d, b) {
        extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
          d2.__proto__ = b2;
        } || function(d2, b2) {
          for (var p in b2) if (b2.hasOwnProperty(p)) d2[p] = b2[p];
        };
        return extendStatics(d, b);
      };
      return function(d, b) {
        extendStatics(d, b);
        function __() {
          this.constructor = d;
        }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
      };
    })();
    Object.defineProperty(exports, "__esModule", { value: true });
    var INVALID_BYTE = 256;
    var Coder = (
      /** @class */
      (function() {
        function Coder2(_paddingCharacter) {
          if (_paddingCharacter === void 0) {
            _paddingCharacter = "=";
          }
          this._paddingCharacter = _paddingCharacter;
        }
        Coder2.prototype.encodedLength = function(length) {
          if (!this._paddingCharacter) {
            return (length * 8 + 5) / 6 | 0;
          }
          return (length + 2) / 3 * 4 | 0;
        };
        Coder2.prototype.encode = function(data) {
          var out2 = "";
          var i = 0;
          for (; i < data.length - 2; i += 3) {
            var c = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
            out2 += this._encodeByte(c >>> 3 * 6 & 63);
            out2 += this._encodeByte(c >>> 2 * 6 & 63);
            out2 += this._encodeByte(c >>> 1 * 6 & 63);
            out2 += this._encodeByte(c >>> 0 * 6 & 63);
          }
          var left = data.length - i;
          if (left > 0) {
            var c = data[i] << 16 | (left === 2 ? data[i + 1] << 8 : 0);
            out2 += this._encodeByte(c >>> 3 * 6 & 63);
            out2 += this._encodeByte(c >>> 2 * 6 & 63);
            if (left === 2) {
              out2 += this._encodeByte(c >>> 1 * 6 & 63);
            } else {
              out2 += this._paddingCharacter || "";
            }
            out2 += this._paddingCharacter || "";
          }
          return out2;
        };
        Coder2.prototype.maxDecodedLength = function(length) {
          if (!this._paddingCharacter) {
            return (length * 6 + 7) / 8 | 0;
          }
          return length / 4 * 3 | 0;
        };
        Coder2.prototype.decodedLength = function(s) {
          return this.maxDecodedLength(s.length - this._getPaddingLength(s));
        };
        Coder2.prototype.decode = function(s) {
          if (s.length === 0) {
            return new Uint8Array(0);
          }
          var paddingLength = this._getPaddingLength(s);
          var length = s.length - paddingLength;
          var out2 = new Uint8Array(this.maxDecodedLength(length));
          var op = 0;
          var i = 0;
          var haveBad = 0;
          var v0 = 0, v1 = 0, v2 = 0, v3 = 0;
          for (; i < length - 4; i += 4) {
            v0 = this._decodeChar(s.charCodeAt(i + 0));
            v1 = this._decodeChar(s.charCodeAt(i + 1));
            v2 = this._decodeChar(s.charCodeAt(i + 2));
            v3 = this._decodeChar(s.charCodeAt(i + 3));
            out2[op++] = v0 << 2 | v1 >>> 4;
            out2[op++] = v1 << 4 | v2 >>> 2;
            out2[op++] = v2 << 6 | v3;
            haveBad |= v0 & INVALID_BYTE;
            haveBad |= v1 & INVALID_BYTE;
            haveBad |= v2 & INVALID_BYTE;
            haveBad |= v3 & INVALID_BYTE;
          }
          if (i < length - 1) {
            v0 = this._decodeChar(s.charCodeAt(i));
            v1 = this._decodeChar(s.charCodeAt(i + 1));
            out2[op++] = v0 << 2 | v1 >>> 4;
            haveBad |= v0 & INVALID_BYTE;
            haveBad |= v1 & INVALID_BYTE;
          }
          if (i < length - 2) {
            v2 = this._decodeChar(s.charCodeAt(i + 2));
            out2[op++] = v1 << 4 | v2 >>> 2;
            haveBad |= v2 & INVALID_BYTE;
          }
          if (i < length - 3) {
            v3 = this._decodeChar(s.charCodeAt(i + 3));
            out2[op++] = v2 << 6 | v3;
            haveBad |= v3 & INVALID_BYTE;
          }
          if (haveBad !== 0) {
            throw new Error("Base64Coder: incorrect characters for decoding");
          }
          return out2;
        };
        Coder2.prototype._encodeByte = function(b) {
          var result = b;
          result += 65;
          result += 25 - b >>> 8 & 0 - 65 - 26 + 97;
          result += 51 - b >>> 8 & 26 - 97 - 52 + 48;
          result += 61 - b >>> 8 & 52 - 48 - 62 + 43;
          result += 62 - b >>> 8 & 62 - 43 - 63 + 47;
          return String.fromCharCode(result);
        };
        Coder2.prototype._decodeChar = function(c) {
          var result = INVALID_BYTE;
          result += (42 - c & c - 44) >>> 8 & -INVALID_BYTE + c - 43 + 62;
          result += (46 - c & c - 48) >>> 8 & -INVALID_BYTE + c - 47 + 63;
          result += (47 - c & c - 58) >>> 8 & -INVALID_BYTE + c - 48 + 52;
          result += (64 - c & c - 91) >>> 8 & -INVALID_BYTE + c - 65 + 0;
          result += (96 - c & c - 123) >>> 8 & -INVALID_BYTE + c - 97 + 26;
          return result;
        };
        Coder2.prototype._getPaddingLength = function(s) {
          var paddingLength = 0;
          if (this._paddingCharacter) {
            for (var i = s.length - 1; i >= 0; i--) {
              if (s[i] !== this._paddingCharacter) {
                break;
              }
              paddingLength++;
            }
            if (s.length < 4 || paddingLength > 2) {
              throw new Error("Base64Coder: incorrect padding");
            }
          }
          return paddingLength;
        };
        return Coder2;
      })()
    );
    exports.Coder = Coder;
    var stdCoder = new Coder();
    function encode2(data) {
      return stdCoder.encode(data);
    }
    exports.encode = encode2;
    function decode(s) {
      return stdCoder.decode(s);
    }
    exports.decode = decode;
    var URLSafeCoder = (
      /** @class */
      (function(_super) {
        __extends(URLSafeCoder2, _super);
        function URLSafeCoder2() {
          return _super !== null && _super.apply(this, arguments) || this;
        }
        URLSafeCoder2.prototype._encodeByte = function(b) {
          var result = b;
          result += 65;
          result += 25 - b >>> 8 & 0 - 65 - 26 + 97;
          result += 51 - b >>> 8 & 26 - 97 - 52 + 48;
          result += 61 - b >>> 8 & 52 - 48 - 62 + 45;
          result += 62 - b >>> 8 & 62 - 45 - 63 + 95;
          return String.fromCharCode(result);
        };
        URLSafeCoder2.prototype._decodeChar = function(c) {
          var result = INVALID_BYTE;
          result += (44 - c & c - 46) >>> 8 & -INVALID_BYTE + c - 45 + 62;
          result += (94 - c & c - 96) >>> 8 & -INVALID_BYTE + c - 95 + 63;
          result += (47 - c & c - 58) >>> 8 & -INVALID_BYTE + c - 48 + 52;
          result += (64 - c & c - 91) >>> 8 & -INVALID_BYTE + c - 65 + 0;
          result += (96 - c & c - 123) >>> 8 & -INVALID_BYTE + c - 97 + 26;
          return result;
        };
        return URLSafeCoder2;
      })(Coder)
    );
    exports.URLSafeCoder = URLSafeCoder;
    var urlSafeCoder = new URLSafeCoder();
    function encodeURLSafe(data) {
      return urlSafeCoder.encode(data);
    }
    exports.encodeURLSafe = encodeURLSafe;
    function decodeURLSafe(s) {
      return urlSafeCoder.decode(s);
    }
    exports.decodeURLSafe = decodeURLSafe;
    exports.encodedLength = function(length) {
      return stdCoder.encodedLength(length);
    };
    exports.maxDecodedLength = function(length) {
      return stdCoder.maxDecodedLength(length);
    };
    exports.decodedLength = function(s) {
      return stdCoder.decodedLength(s);
    };
  }
});

// node_modules/fast-sha256/sha256.js
var require_sha256 = __commonJS({
  "node_modules/fast-sha256/sha256.js"(exports, module) {
    (function(root, factory) {
      var exports2 = {};
      factory(exports2);
      var sha256 = exports2["default"];
      for (var k in exports2) {
        sha256[k] = exports2[k];
      }
      if (typeof module === "object" && typeof module.exports === "object") {
        module.exports = sha256;
      } else if (typeof define === "function" && define.amd) {
        define(function() {
          return sha256;
        });
      } else {
        root.sha256 = sha256;
      }
    })(exports, function(exports2) {
      "use strict";
      exports2.__esModule = true;
      exports2.digestLength = 32;
      exports2.blockSize = 64;
      var K = new Uint32Array([
        1116352408,
        1899447441,
        3049323471,
        3921009573,
        961987163,
        1508970993,
        2453635748,
        2870763221,
        3624381080,
        310598401,
        607225278,
        1426881987,
        1925078388,
        2162078206,
        2614888103,
        3248222580,
        3835390401,
        4022224774,
        264347078,
        604807628,
        770255983,
        1249150122,
        1555081692,
        1996064986,
        2554220882,
        2821834349,
        2952996808,
        3210313671,
        3336571891,
        3584528711,
        113926993,
        338241895,
        666307205,
        773529912,
        1294757372,
        1396182291,
        1695183700,
        1986661051,
        2177026350,
        2456956037,
        2730485921,
        2820302411,
        3259730800,
        3345764771,
        3516065817,
        3600352804,
        4094571909,
        275423344,
        430227734,
        506948616,
        659060556,
        883997877,
        958139571,
        1322822218,
        1537002063,
        1747873779,
        1955562222,
        2024104815,
        2227730452,
        2361852424,
        2428436474,
        2756734187,
        3204031479,
        3329325298
      ]);
      function hashBlocks(w, v, p, pos, len) {
        var a, b, c, d, e, f, g, h, u, i, j, t1, t2;
        while (len >= 64) {
          a = v[0];
          b = v[1];
          c = v[2];
          d = v[3];
          e = v[4];
          f = v[5];
          g = v[6];
          h = v[7];
          for (i = 0; i < 16; i++) {
            j = pos + i * 4;
            w[i] = (p[j] & 255) << 24 | (p[j + 1] & 255) << 16 | (p[j + 2] & 255) << 8 | p[j + 3] & 255;
          }
          for (i = 16; i < 64; i++) {
            u = w[i - 2];
            t1 = (u >>> 17 | u << 32 - 17) ^ (u >>> 19 | u << 32 - 19) ^ u >>> 10;
            u = w[i - 15];
            t2 = (u >>> 7 | u << 32 - 7) ^ (u >>> 18 | u << 32 - 18) ^ u >>> 3;
            w[i] = (t1 + w[i - 7] | 0) + (t2 + w[i - 16] | 0);
          }
          for (i = 0; i < 64; i++) {
            t1 = (((e >>> 6 | e << 32 - 6) ^ (e >>> 11 | e << 32 - 11) ^ (e >>> 25 | e << 32 - 25)) + (e & f ^ ~e & g) | 0) + (h + (K[i] + w[i] | 0) | 0) | 0;
            t2 = ((a >>> 2 | a << 32 - 2) ^ (a >>> 13 | a << 32 - 13) ^ (a >>> 22 | a << 32 - 22)) + (a & b ^ a & c ^ b & c) | 0;
            h = g;
            g = f;
            f = e;
            e = d + t1 | 0;
            d = c;
            c = b;
            b = a;
            a = t1 + t2 | 0;
          }
          v[0] += a;
          v[1] += b;
          v[2] += c;
          v[3] += d;
          v[4] += e;
          v[5] += f;
          v[6] += g;
          v[7] += h;
          pos += 64;
          len -= 64;
        }
        return pos;
      }
      var Hash = (
        /** @class */
        (function() {
          function Hash2() {
            this.digestLength = exports2.digestLength;
            this.blockSize = exports2.blockSize;
            this.state = new Int32Array(8);
            this.temp = new Int32Array(64);
            this.buffer = new Uint8Array(128);
            this.bufferLength = 0;
            this.bytesHashed = 0;
            this.finished = false;
            this.reset();
          }
          Hash2.prototype.reset = function() {
            this.state[0] = 1779033703;
            this.state[1] = 3144134277;
            this.state[2] = 1013904242;
            this.state[3] = 2773480762;
            this.state[4] = 1359893119;
            this.state[5] = 2600822924;
            this.state[6] = 528734635;
            this.state[7] = 1541459225;
            this.bufferLength = 0;
            this.bytesHashed = 0;
            this.finished = false;
            return this;
          };
          Hash2.prototype.clean = function() {
            for (var i = 0; i < this.buffer.length; i++) {
              this.buffer[i] = 0;
            }
            for (var i = 0; i < this.temp.length; i++) {
              this.temp[i] = 0;
            }
            this.reset();
          };
          Hash2.prototype.update = function(data, dataLength) {
            if (dataLength === void 0) {
              dataLength = data.length;
            }
            if (this.finished) {
              throw new Error("SHA256: can't update because hash was finished.");
            }
            var dataPos = 0;
            this.bytesHashed += dataLength;
            if (this.bufferLength > 0) {
              while (this.bufferLength < 64 && dataLength > 0) {
                this.buffer[this.bufferLength++] = data[dataPos++];
                dataLength--;
              }
              if (this.bufferLength === 64) {
                hashBlocks(this.temp, this.state, this.buffer, 0, 64);
                this.bufferLength = 0;
              }
            }
            if (dataLength >= 64) {
              dataPos = hashBlocks(this.temp, this.state, data, dataPos, dataLength);
              dataLength %= 64;
            }
            while (dataLength > 0) {
              this.buffer[this.bufferLength++] = data[dataPos++];
              dataLength--;
            }
            return this;
          };
          Hash2.prototype.finish = function(out2) {
            if (!this.finished) {
              var bytesHashed = this.bytesHashed;
              var left = this.bufferLength;
              var bitLenHi = bytesHashed / 536870912 | 0;
              var bitLenLo = bytesHashed << 3;
              var padLength = bytesHashed % 64 < 56 ? 64 : 128;
              this.buffer[left] = 128;
              for (var i = left + 1; i < padLength - 8; i++) {
                this.buffer[i] = 0;
              }
              this.buffer[padLength - 8] = bitLenHi >>> 24 & 255;
              this.buffer[padLength - 7] = bitLenHi >>> 16 & 255;
              this.buffer[padLength - 6] = bitLenHi >>> 8 & 255;
              this.buffer[padLength - 5] = bitLenHi >>> 0 & 255;
              this.buffer[padLength - 4] = bitLenLo >>> 24 & 255;
              this.buffer[padLength - 3] = bitLenLo >>> 16 & 255;
              this.buffer[padLength - 2] = bitLenLo >>> 8 & 255;
              this.buffer[padLength - 1] = bitLenLo >>> 0 & 255;
              hashBlocks(this.temp, this.state, this.buffer, 0, padLength);
              this.finished = true;
            }
            for (var i = 0; i < 8; i++) {
              out2[i * 4 + 0] = this.state[i] >>> 24 & 255;
              out2[i * 4 + 1] = this.state[i] >>> 16 & 255;
              out2[i * 4 + 2] = this.state[i] >>> 8 & 255;
              out2[i * 4 + 3] = this.state[i] >>> 0 & 255;
            }
            return this;
          };
          Hash2.prototype.digest = function() {
            var out2 = new Uint8Array(this.digestLength);
            this.finish(out2);
            return out2;
          };
          Hash2.prototype._saveState = function(out2) {
            for (var i = 0; i < this.state.length; i++) {
              out2[i] = this.state[i];
            }
          };
          Hash2.prototype._restoreState = function(from, bytesHashed) {
            for (var i = 0; i < this.state.length; i++) {
              this.state[i] = from[i];
            }
            this.bytesHashed = bytesHashed;
            this.finished = false;
            this.bufferLength = 0;
          };
          return Hash2;
        })()
      );
      exports2.Hash = Hash;
      var HMAC = (
        /** @class */
        (function() {
          function HMAC2(key) {
            this.inner = new Hash();
            this.outer = new Hash();
            this.blockSize = this.inner.blockSize;
            this.digestLength = this.inner.digestLength;
            var pad = new Uint8Array(this.blockSize);
            if (key.length > this.blockSize) {
              new Hash().update(key).finish(pad).clean();
            } else {
              for (var i = 0; i < key.length; i++) {
                pad[i] = key[i];
              }
            }
            for (var i = 0; i < pad.length; i++) {
              pad[i] ^= 54;
            }
            this.inner.update(pad);
            for (var i = 0; i < pad.length; i++) {
              pad[i] ^= 54 ^ 92;
            }
            this.outer.update(pad);
            this.istate = new Uint32Array(8);
            this.ostate = new Uint32Array(8);
            this.inner._saveState(this.istate);
            this.outer._saveState(this.ostate);
            for (var i = 0; i < pad.length; i++) {
              pad[i] = 0;
            }
          }
          HMAC2.prototype.reset = function() {
            this.inner._restoreState(this.istate, this.inner.blockSize);
            this.outer._restoreState(this.ostate, this.outer.blockSize);
            return this;
          };
          HMAC2.prototype.clean = function() {
            for (var i = 0; i < this.istate.length; i++) {
              this.ostate[i] = this.istate[i] = 0;
            }
            this.inner.clean();
            this.outer.clean();
          };
          HMAC2.prototype.update = function(data) {
            this.inner.update(data);
            return this;
          };
          HMAC2.prototype.finish = function(out2) {
            if (this.outer.finished) {
              this.outer.finish(out2);
            } else {
              this.inner.finish(out2);
              this.outer.update(out2, this.digestLength).finish(out2);
            }
            return this;
          };
          HMAC2.prototype.digest = function() {
            var out2 = new Uint8Array(this.digestLength);
            this.finish(out2);
            return out2;
          };
          return HMAC2;
        })()
      );
      exports2.HMAC = HMAC;
      function hash(data) {
        var h = new Hash().update(data);
        var digest = h.digest();
        h.clean();
        return digest;
      }
      exports2.hash = hash;
      exports2["default"] = hash;
      function hmac(key, data) {
        var h = new HMAC(key).update(data);
        var digest = h.digest();
        h.clean();
        return digest;
      }
      exports2.hmac = hmac;
      function fillBuffer(buffer, hmac2, info, counter) {
        var num = counter[0];
        if (num === 0) {
          throw new Error("hkdf: cannot expand more");
        }
        hmac2.reset();
        if (num > 1) {
          hmac2.update(buffer);
        }
        if (info) {
          hmac2.update(info);
        }
        hmac2.update(counter);
        hmac2.finish(buffer);
        counter[0]++;
      }
      var hkdfSalt = new Uint8Array(exports2.digestLength);
      function hkdf(key, salt, info, length) {
        if (salt === void 0) {
          salt = hkdfSalt;
        }
        if (length === void 0) {
          length = 32;
        }
        var counter = new Uint8Array([1]);
        var okm = hmac(salt, key);
        var hmac_ = new HMAC(okm);
        var buffer = new Uint8Array(hmac_.digestLength);
        var bufpos = buffer.length;
        var out2 = new Uint8Array(length);
        for (var i = 0; i < length; i++) {
          if (bufpos === buffer.length) {
            fillBuffer(buffer, hmac_, info, counter);
            bufpos = 0;
          }
          out2[i] = buffer[bufpos++];
        }
        hmac_.clean();
        buffer.fill(0);
        counter.fill(0);
        return out2;
      }
      exports2.hkdf = hkdf;
      function pbkdf2(password, salt, iterations, dkLen) {
        var prf = new HMAC(password);
        var len = prf.digestLength;
        var ctr = new Uint8Array(4);
        var t = new Uint8Array(len);
        var u = new Uint8Array(len);
        var dk = new Uint8Array(dkLen);
        for (var i = 0; i * len < dkLen; i++) {
          var c = i + 1;
          ctr[0] = c >>> 24 & 255;
          ctr[1] = c >>> 16 & 255;
          ctr[2] = c >>> 8 & 255;
          ctr[3] = c >>> 0 & 255;
          prf.reset();
          prf.update(salt);
          prf.update(ctr);
          prf.finish(u);
          for (var j = 0; j < len; j++) {
            t[j] = u[j];
          }
          for (var j = 2; j <= iterations; j++) {
            prf.reset();
            prf.update(u).finish(u);
            for (var k = 0; k < len; k++) {
              t[k] ^= u[k];
            }
          }
          for (var j = 0; j < len && i * len + j < dkLen; j++) {
            dk[i * len + j] = t[j];
          }
        }
        for (var i = 0; i < len; i++) {
          t[i] = u[i] = 0;
        }
        for (var i = 0; i < 4; i++) {
          ctr[i] = 0;
        }
        prf.clean();
        return dk;
      }
      exports2.pbkdf2 = pbkdf2;
    });
  }
});

// node_modules/standardwebhooks/dist/index.js
var require_dist = __commonJS({
  "node_modules/standardwebhooks/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Webhook = exports.WebhookVerificationError = void 0;
    var timing_safe_equal_1 = require_timing_safe_equal();
    var base64 = require_base64();
    var sha256 = require_sha256();
    var WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60;
    var ExtendableError = class _ExtendableError extends Error {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _ExtendableError.prototype);
        this.name = "ExtendableError";
        this.stack = new Error(message).stack;
      }
    };
    var WebhookVerificationError = class _WebhookVerificationError extends ExtendableError {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _WebhookVerificationError.prototype);
        this.name = "WebhookVerificationError";
      }
    };
    exports.WebhookVerificationError = WebhookVerificationError;
    var Webhook2 = class _Webhook {
      constructor(secret, options) {
        if (!secret) {
          throw new Error("Secret can't be empty.");
        }
        if ((options === null || options === void 0 ? void 0 : options.format) === "raw") {
          if (secret instanceof Uint8Array) {
            this.key = secret;
          } else {
            this.key = Uint8Array.from(secret, (c) => c.charCodeAt(0));
          }
        } else {
          if (typeof secret !== "string") {
            throw new Error("Expected secret to be of type string");
          }
          if (secret.startsWith(_Webhook.prefix)) {
            secret = secret.substring(_Webhook.prefix.length);
          }
          this.key = base64.decode(secret);
        }
      }
      verify(payload, headers_) {
        const headers = {};
        for (const key of Object.keys(headers_)) {
          headers[key.toLowerCase()] = headers_[key];
        }
        const msgId = headers["webhook-id"];
        const msgSignature = headers["webhook-signature"];
        const msgTimestamp = headers["webhook-timestamp"];
        if (!msgSignature || !msgId || !msgTimestamp) {
          throw new WebhookVerificationError("Missing required headers");
        }
        const timestamp = this.verifyTimestamp(msgTimestamp);
        const computedSignature = this.sign(msgId, timestamp, payload);
        const expectedSignature = computedSignature.split(",")[1];
        const passedSignatures = msgSignature.split(" ");
        const encoder2 = new globalThis.TextEncoder();
        for (const versionedSignature of passedSignatures) {
          const [version, signature] = versionedSignature.split(",");
          if (version !== "v1") {
            continue;
          }
          if ((0, timing_safe_equal_1.timingSafeEqual)(encoder2.encode(signature), encoder2.encode(expectedSignature))) {
            return JSON.parse(payload.toString());
          }
        }
        throw new WebhookVerificationError("No matching signature found");
      }
      sign(msgId, timestamp, payload) {
        if (typeof payload === "string") {
        } else if (payload.constructor.name === "Buffer") {
          payload = payload.toString();
        } else {
          throw new Error("Expected payload to be of type string or Buffer.");
        }
        const encoder2 = new TextEncoder();
        const timestampNumber = Math.floor(timestamp.getTime() / 1e3);
        const toSign = encoder2.encode(`${msgId}.${timestampNumber}.${payload}`);
        const expectedSignature = base64.encode(sha256.hmac(this.key, toSign));
        return `v1,${expectedSignature}`;
      }
      verifyTimestamp(timestampHeader) {
        const now = Math.floor(Date.now() / 1e3);
        const timestamp = parseInt(timestampHeader, 10);
        if (isNaN(timestamp)) {
          throw new WebhookVerificationError("Invalid Signature Headers");
        }
        if (now - timestamp > WEBHOOK_TOLERANCE_IN_SECONDS) {
          throw new WebhookVerificationError("Message timestamp too old");
        }
        if (timestamp > now + WEBHOOK_TOLERANCE_IN_SECONDS) {
          throw new WebhookVerificationError("Message timestamp too new");
        }
        return new Date(timestamp * 1e3);
      }
    };
    exports.Webhook = Webhook2;
    Webhook2.prefix = "whsec_";
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/webhooks.mjs
var import_standardwebhooks, Webhooks;
var init_webhooks = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/webhooks.mjs"() {
    init_resource();
    import_standardwebhooks = __toESM(require_dist(), 1);
    Webhooks = class extends APIResource {
      unwrap(body, { headers, key }) {
        if (headers !== void 0) {
          const keyStr = key === void 0 ? this._client.webhookKey : key;
          if (keyStr === null)
            throw new Error("Webhook key must not be null in order to unwrap");
          const wh = new import_standardwebhooks.Webhook(keyStr);
          wh.verify(body, headers);
        }
        return JSON.parse(body);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs
var Versions;
var init_versions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Versions = class extends APIResource {
      /**
       * List Agent Versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsAgent of client.beta.agents.versions.list(
       *   'agent_011CZkYpogX7uDKUyvBTophP',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(agentID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/agents/${agentID}/versions?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs
var Agents;
var init_agents = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs"() {
    init_resource();
    init_versions();
    init_versions();
    init_pagination();
    init_headers();
    init_path();
    Agents = class extends APIResource {
      constructor() {
        super(...arguments);
        this.versions = new Versions(this._client);
      }
      /**
       * Create Agent
       *
       * @example
       * ```ts
       * const betaManagedAgentsAgent =
       *   await client.beta.agents.create({
       *     model: 'claude-sonnet-4-6',
       *     name: 'My First Agent',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/agents?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get Agent
       *
       * @example
       * ```ts
       * const betaManagedAgentsAgent =
       *   await client.beta.agents.retrieve(
       *     'agent_011CZkYpogX7uDKUyvBTophP',
       *   );
       * ```
       */
      retrieve(agentID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.get(path`/v1/agents/${agentID}?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update Agent
       *
       * @example
       * ```ts
       * const betaManagedAgentsAgent =
       *   await client.beta.agents.update(
       *     'agent_011CZkYpogX7uDKUyvBTophP',
       *     { description: 'updated' },
       *   );
       * ```
       */
      update(agentID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/agents/${agentID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Agents
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsAgent of client.beta.agents.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/agents?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive Agent
       *
       * @example
       * ```ts
       * const betaManagedAgentsAgent =
       *   await client.beta.agents.archive(
       *     'agent_011CZkYpogX7uDKUyvBTophP',
       *   );
       * ```
       */
      archive(agentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/agents/${agentID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
    Agents.Versions = Versions;
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/abort.mjs
function linkAbort(external, controller) {
  if (!external)
    return () => {
    };
  if (external.aborted) {
    controller.abort();
    return () => {
    };
  }
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort);
  return () => external.removeEventListener("abort", onAbort);
}
var init_abort = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/abort.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/backoff.mjs
function isStatus(e, code) {
  return e instanceof APIError && e.status === code;
}
function is4xx(e) {
  return e instanceof APIError && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}
function isFatal4xx(e) {
  return is4xx(e) && !isStatus(e, 408) && !isStatus(e, 409) && !isStatus(e, 429);
}
function backoff(attempt, baseMs, capMs) {
  return Math.min(baseMs * 2 ** attempt, capMs);
}
function jitter(lowMs, highMs) {
  return lowMs + Math.random() * (highMs - lowMs);
}
function applyJitter(ms) {
  return ms * (1 - Math.random() * 0.25);
}
var init_backoff = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/backoff.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/lib/helper-client.mjs
function copyClientForHelper(client, { authToken, helper }) {
  if (!authToken) {
    throw new AnthropicError(`copyClientForHelper: expected a non-empty authToken but received ${JSON.stringify(authToken)}`);
  }
  const internal = client;
  const parentDefaults = internal._options.defaultHeaders;
  const parentAuthExtraHeaders = internal._authState?.extraHeaders;
  const inheritedAuthExtraHeaders = parentAuthExtraHeaders ? Object.fromEntries(Object.entries(parentAuthExtraHeaders).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== "authorization" && lower !== "x-api-key";
  })) : void 0;
  const defaultHeaders = buildHeaders([
    inheritedAuthExtraHeaders,
    parentDefaults,
    { [STAINLESS_HELPER_HEADER]: helper }
  ]);
  return client.withOptions({
    apiKey: null,
    authToken,
    baseURL: client.baseURL,
    credentials: void 0,
    defaultHeaders
  });
}
var init_helper_client = __esm({
  "node_modules/@anthropic-ai/sdk/lib/helper-client.mjs"() {
    init_error();
    init_headers();
    init_stainless_helper_header();
  }
});

// node_modules/@anthropic-ai/sdk/lib/environments/poller.mjs
function backoff2(attempt) {
  return backoff(attempt, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_CAP_MS);
}
function defaultWorkerId() {
  const env = globalThis.process?.env;
  const host = env?.["HOSTNAME"];
  return host ? `${host}-${uuid4()}` : uuid4();
}
var _WorkPoller_runnerClient, _WorkPoller_consumed, _WorkPoller_controller, _WorkPoller_detachExternal, _WorkPoller_autoStop, _WorkPoller_drain, _WorkPoller_blockMs, _WorkPoller_reclaimOlderThanMs, _WorkPoller_requestOpts, POLL_BLOCK_MS, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_CAP_MS, WorkPoller;
var init_poller = __esm({
  "node_modules/@anthropic-ai/sdk/lib/environments/poller.mjs"() {
    init_tslib();
    init_error();
    init_log();
    init_sleep();
    init_uuid();
    init_abort();
    init_headers();
    init_backoff();
    init_helper_client();
    init_backoff();
    POLL_BLOCK_MS = 999;
    POLL_BACKOFF_BASE_MS = 1e3;
    POLL_BACKOFF_CAP_MS = 6e4;
    WorkPoller = class {
      constructor(opts) {
        _WorkPoller_runnerClient.set(this, void 0);
        _WorkPoller_consumed.set(this, false);
        _WorkPoller_controller.set(this, void 0);
        _WorkPoller_detachExternal.set(this, void 0);
        _WorkPoller_autoStop.set(this, void 0);
        _WorkPoller_drain.set(this, void 0);
        _WorkPoller_blockMs.set(this, void 0);
        _WorkPoller_reclaimOlderThanMs.set(this, void 0);
        _WorkPoller_requestOpts.set(this, void 0);
        this.client = opts.client;
        this.environmentId = opts.environmentId;
        this.environmentKey = opts.environmentKey;
        this.workerId = opts.workerId ?? defaultWorkerId();
        __classPrivateFieldSet(this, _WorkPoller_runnerClient, copyClientForHelper(opts.client, {
          authToken: opts.environmentKey,
          helper: "environments-work-poller"
        }), "f");
        __classPrivateFieldSet(this, _WorkPoller_autoStop, opts.autoStop ?? true, "f");
        __classPrivateFieldSet(this, _WorkPoller_drain, opts.drain ?? false, "f");
        __classPrivateFieldSet(this, _WorkPoller_blockMs, opts.blockMs === void 0 ? POLL_BLOCK_MS : opts.blockMs, "f");
        __classPrivateFieldSet(this, _WorkPoller_reclaimOlderThanMs, opts.reclaimOlderThanMs ?? null, "f");
        __classPrivateFieldSet(this, _WorkPoller_requestOpts, opts.requestOptions, "f");
        __classPrivateFieldSet(this, _WorkPoller_controller, new AbortController(), "f");
        __classPrivateFieldSet(this, _WorkPoller_detachExternal, linkAbort(opts.signal, __classPrivateFieldGet(this, _WorkPoller_controller, "f")), "f");
      }
      /** Read-only view of this iterator's abort signal. */
      get signal() {
        return __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal;
      }
      /** Abort the iterator. The current `for await` will exit cleanly. */
      abort() {
        __classPrivateFieldGet(this, _WorkPoller_controller, "f").abort();
      }
      async *[(_WorkPoller_runnerClient = /* @__PURE__ */ new WeakMap(), _WorkPoller_consumed = /* @__PURE__ */ new WeakMap(), _WorkPoller_controller = /* @__PURE__ */ new WeakMap(), _WorkPoller_detachExternal = /* @__PURE__ */ new WeakMap(), _WorkPoller_autoStop = /* @__PURE__ */ new WeakMap(), _WorkPoller_drain = /* @__PURE__ */ new WeakMap(), _WorkPoller_blockMs = /* @__PURE__ */ new WeakMap(), _WorkPoller_reclaimOlderThanMs = /* @__PURE__ */ new WeakMap(), _WorkPoller_requestOpts = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
        if (__classPrivateFieldGet(this, _WorkPoller_consumed, "f")) {
          throw new AnthropicError("Cannot iterate over a consumed WorkPoller");
        }
        __classPrivateFieldSet(this, _WorkPoller_consumed, true, "f");
        const log = loggerFor(this.client);
        log.info("poller starting", {
          component: "work-poller",
          environment_id: this.environmentId
        });
        try {
          let attempt = 0;
          while (!__classPrivateFieldGet(this, _WorkPoller_controller, "f").signal.aborted) {
            let work;
            try {
              work = await __classPrivateFieldGet(this, _WorkPoller_runnerClient, "f").beta.environments.work.poll(this.environmentId, {
                "Anthropic-Worker-ID": this.workerId,
                ...__classPrivateFieldGet(this, _WorkPoller_blockMs, "f") !== null ? { block_ms: __classPrivateFieldGet(this, _WorkPoller_blockMs, "f") } : {},
                ...__classPrivateFieldGet(this, _WorkPoller_reclaimOlderThanMs, "f") !== null ? { reclaim_older_than_ms: __classPrivateFieldGet(this, _WorkPoller_reclaimOlderThanMs, "f") } : {}
              }, { headers: buildHeaders([__classPrivateFieldGet(this, _WorkPoller_requestOpts, "f")?.headers]), signal: __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal });
            } catch (e) {
              if (__classPrivateFieldGet(this, _WorkPoller_controller, "f").signal.aborted)
                return;
              if (isFatal4xx(e)) {
                log.error("poll failed permanently, stopping poller", { error: String(e) });
                throw e;
              }
              const wait = applyJitter(backoff2(attempt));
              log.warn("poll failed, backing off", { error: String(e), backoff_ms: wait });
              attempt++;
              await sleep(wait, __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal);
              continue;
            }
            attempt = 0;
            if (work == null) {
              if (__classPrivateFieldGet(this, _WorkPoller_drain, "f"))
                return;
              await sleep(jitter(1e3, 3e3), __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal);
              continue;
            }
            log.info("claimed work", {
              component: "work-poller",
              environment_id: this.environmentId,
              work_id: work.id,
              work_type: work.data.type
            });
            try {
              await __classPrivateFieldGet(this, _WorkPoller_runnerClient, "f").beta.environments.work.ack(work.id, { environment_id: work.environment_id }, { headers: buildHeaders([__classPrivateFieldGet(this, _WorkPoller_requestOpts, "f")?.headers]), signal: __classPrivateFieldGet(this, _WorkPoller_controller, "f").signal });
            } catch (e) {
              log.error("ack failed", { work_id: work.id, error: String(e) });
              continue;
            }
            try {
              yield work;
            } finally {
              if (__classPrivateFieldGet(this, _WorkPoller_autoStop, "f")) {
                try {
                  await __classPrivateFieldGet(this, _WorkPoller_runnerClient, "f").beta.environments.work.stop(work.id, { environment_id: work.environment_id }, { headers: buildHeaders([__classPrivateFieldGet(this, _WorkPoller_requestOpts, "f")?.headers]) });
                } catch (e) {
                  if (!isStatus(e, 409))
                    log.warn("stop failed", { work_id: work.id, error: String(e) });
                }
              }
            }
          }
        } finally {
          __classPrivateFieldGet(this, _WorkPoller_detachExternal, "f").call(this);
        }
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/async-queue.mjs
var _AsyncQueue_items, _AsyncQueue_waiters, _AsyncQueue_closed, AsyncQueue;
var init_async_queue = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/async-queue.mjs"() {
    init_tslib();
    AsyncQueue = class {
      constructor() {
        _AsyncQueue_items.set(this, []);
        _AsyncQueue_waiters.set(this, []);
        _AsyncQueue_closed.set(this, false);
      }
      /** Enqueue an item, or hand it directly to a waiting reader. Returns `false` once closed. */
      push(item) {
        if (__classPrivateFieldGet(this, _AsyncQueue_closed, "f"))
          return false;
        const w = __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").shift();
        if (w)
          w({ done: false, value: item });
        else
          __classPrivateFieldGet(this, _AsyncQueue_items, "f").push(item);
        return true;
      }
      /** Mark the queue done. Idempotent; wakes every pending reader with `done: true`. */
      close() {
        if (__classPrivateFieldGet(this, _AsyncQueue_closed, "f"))
          return;
        __classPrivateFieldSet(this, _AsyncQueue_closed, true, "f");
        while (__classPrivateFieldGet(this, _AsyncQueue_waiters, "f").length > 0) {
          const w = __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").shift();
          w({ done: true, value: void 0 });
        }
      }
      /**
       * Resolve with the next item, or `done: true` once the queue is closed and
       * drained. When `signal` is supplied, aborting it resolves a pending read
       * with `done: true` (cancellation is pushed down here rather than handled by
       * an outer `Promise.race`).
       */
      next(signal) {
        if (__classPrivateFieldGet(this, _AsyncQueue_items, "f").length > 0) {
          return Promise.resolve({ done: false, value: __classPrivateFieldGet(this, _AsyncQueue_items, "f").shift() });
        }
        if (__classPrivateFieldGet(this, _AsyncQueue_closed, "f") || signal?.aborted) {
          return Promise.resolve({ done: true, value: void 0 });
        }
        return new Promise((resolve5) => {
          const waiter = (r) => {
            signal?.removeEventListener("abort", onAbort);
            resolve5(r);
          };
          const onAbort = () => {
            const idx = __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").indexOf(waiter);
            if (idx >= 0)
              __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").splice(idx, 1);
            resolve5({ done: true, value: void 0 });
          };
          __classPrivateFieldGet(this, _AsyncQueue_waiters, "f").push(waiter);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      /** Synchronously remove and return the next buffered item, or `undefined` if empty. */
      tryShift() {
        return __classPrivateFieldGet(this, _AsyncQueue_items, "f").shift();
      }
    };
    _AsyncQueue_items = /* @__PURE__ */ new WeakMap(), _AsyncQueue_waiters = /* @__PURE__ */ new WeakMap(), _AsyncQueue_closed = /* @__PURE__ */ new WeakMap();
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs
var ToolError;
var init_ToolError = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs"() {
    ToolError = class extends Error {
      constructor(content) {
        const message = typeof content === "string" ? content : content.map((block) => {
          if (block.type === "text")
            return block.text;
          return `[${block.type}]`;
        }).join(" ");
        super(message);
        this.name = "ToolError";
        this.content = content;
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs
function toolName(tool) {
  return "name" in tool ? tool.name : tool.mcp_server_name;
}
function toolErrorContent(e) {
  return e instanceof ToolError ? e.content : `Error: ${e instanceof Error ? e.message : String(e)}`;
}
async function runRunnableTool(tool, rawInput, context) {
  try {
    const input = tool.parse ? tool.parse(rawInput) : rawInput;
    const content = await tool.run(input, context);
    return { content, isError: false };
  } catch (e) {
    return { content: toolErrorContent(e), isError: true };
  }
}
var init_BetaRunnableTool = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs"() {
    init_ToolError();
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/SessionToolRunner.mjs
function isEndTurnIdle(ev) {
  return ev.type === "session.status_idle" && ev.stop_reason?.type === "end_turn";
}
function buildResultEvent(ev, isError, content) {
  if (ev.type === "agent.custom_tool_use") {
    return { type: "user.custom_tool_result", custom_tool_use_id: ev.id, is_error: isError, content };
  }
  return { type: "user.tool_result", tool_use_id: ev.id, is_error: isError, content };
}
function toSessionContent(content) {
  if (typeof content === "string")
    return [{ type: "text", text: content || "(no output)" }];
  const out2 = content.map((b) => {
    if (b.type === "text")
      return { type: "text", text: b.text || "(no output)" };
    if (b.type === "image" || b.type === "document")
      return b;
    if (b.type === "search_result") {
      return {
        type: "search_result",
        source: b.source,
        title: b.title,
        content: b.content.map((c) => ({ type: "text", text: c.text })),
        citations: { enabled: b.citations?.enabled ?? false }
      };
    }
    return { type: "text", text: JSON.stringify(b) };
  });
  return out2.length > 0 ? out2 : [{ type: "text", text: "(no output)" }];
}
var _IdleClock_maxIdleMs, _IdleClock_onExpire, _IdleClock_blockers, _IdleClock_armPending, _IdleClock_timer, _SessionToolRunner_instances, _SessionToolRunner_consumed, _SessionToolRunner_controller, _SessionToolRunner_detachExternal, _SessionToolRunner_requestOpts, _SessionToolRunner_toolByName, _SessionToolRunner_logger, _SessionToolRunner_seen, _SessionToolRunner_answered, _SessionToolRunner_confirmationVerdicts, _SessionToolRunner_awaitingConfirmation, _SessionToolRunner_results, _SessionToolRunner_inFlightCount, _SessionToolRunner_onIdle, _SessionToolRunner_idleClock, _SessionToolRunner_requestOptions, _SessionToolRunner_streamLoop, _SessionToolRunner_reconcile, _SessionToolRunner_ingestHistory, _SessionToolRunner_handleStreamEvent, _SessionToolRunner_routeToolEvent, _SessionToolRunner_noteConfirmation, _SessionToolRunner_applyVerdict, _SessionToolRunner_surfaceCall, _SessionToolRunner_execute, _SessionToolRunner_sendResult, _SessionToolRunner_drain, STREAM_BACKOFF_START_MS, STREAM_BACKOFF_CAP_MS, TOOL_TIMEOUT_MS, DRAIN_TIMEOUT_MS, SEND_RETRIES, DEFAULT_MAX_IDLE_MS, IdleClock, SessionToolRunner;
var init_SessionToolRunner = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/SessionToolRunner.mjs"() {
    init_tslib();
    init_error();
    init_log();
    init_sleep();
    init_backoff();
    init_abort();
    init_async_queue();
    init_headers();
    init_stainless_helper_header();
    init_BetaRunnableTool();
    STREAM_BACKOFF_START_MS = 500;
    STREAM_BACKOFF_CAP_MS = 1e4;
    TOOL_TIMEOUT_MS = 12e4;
    DRAIN_TIMEOUT_MS = 3e4;
    SEND_RETRIES = 3;
    DEFAULT_MAX_IDLE_MS = 6e4;
    IdleClock = class {
      constructor(maxIdleMs, onExpire) {
        _IdleClock_maxIdleMs.set(this, void 0);
        _IdleClock_onExpire.set(this, void 0);
        _IdleClock_blockers.set(this, /* @__PURE__ */ new Set());
        _IdleClock_armPending.set(this, false);
        _IdleClock_timer.set(this, void 0);
        __classPrivateFieldSet(this, _IdleClock_maxIdleMs, maxIdleMs, "f");
        __classPrivateFieldSet(this, _IdleClock_onExpire, onExpire, "f");
      }
      /**
       * Arm on `status_idle{end_turn}`; disarm otherwise. `user.tool_confirmation`
       * is neutral: it signals neither agent activity nor an idle, and its effect
       * on the clock flows through {@link block} / {@link unblock} instead —
       * disarming here would discard the pending arm the verdict is about to
       * settle.
       */
      noteEvent(ev) {
        if (ev.type === "user.tool_confirmation")
          return;
        if (isEndTurnIdle(ev))
          this.arm();
        else
          this.disarm();
      }
      /** Register gated work that must resolve before an idle countdown starts. */
      block(toolUseId) {
        __classPrivateFieldGet(this, _IdleClock_blockers, "f").add(toolUseId);
        if (__classPrivateFieldGet(this, _IdleClock_timer, "f") !== void 0) {
          __classPrivateFieldSet(this, _IdleClock_armPending, true, "f");
          clearTimeout(__classPrivateFieldGet(this, _IdleClock_timer, "f"));
          __classPrivateFieldSet(this, _IdleClock_timer, void 0, "f");
        }
      }
      /**
       * Retire gated work (a no-op for ids never blocked); applies a pending arm —
       * with a fresh full `maxIdleMs` window — once the last blocker retires.
       */
      unblock(toolUseId) {
        __classPrivateFieldGet(this, _IdleClock_blockers, "f").delete(toolUseId);
        if (__classPrivateFieldGet(this, _IdleClock_blockers, "f").size === 0 && __classPrivateFieldGet(this, _IdleClock_armPending, "f"))
          this.arm();
      }
      /**
       * (Re)start the idle countdown — or, while blockers are outstanding, hold
       * the arm pending instead. Stopping then would drop a held call when its
       * verdict later arrives, or cut the runner off before a released call's
       * result can drive the next turn.
       */
      arm() {
        if (__classPrivateFieldGet(this, _IdleClock_maxIdleMs, "f") <= 0)
          return;
        if (__classPrivateFieldGet(this, _IdleClock_blockers, "f").size > 0) {
          __classPrivateFieldSet(this, _IdleClock_armPending, true, "f");
          return;
        }
        __classPrivateFieldSet(this, _IdleClock_armPending, false, "f");
        if (__classPrivateFieldGet(this, _IdleClock_timer, "f") !== void 0)
          clearTimeout(__classPrivateFieldGet(this, _IdleClock_timer, "f"));
        __classPrivateFieldSet(this, _IdleClock_timer, setTimeout(__classPrivateFieldGet(this, _IdleClock_onExpire, "f"), __classPrivateFieldGet(this, _IdleClock_maxIdleMs, "f")), "f");
      }
      /**
       * Cancel the idle countdown and any pending arm. Blockers persist — they
       * track real outstanding work, retired only by {@link unblock}.
       */
      disarm() {
        __classPrivateFieldSet(this, _IdleClock_armPending, false, "f");
        if (__classPrivateFieldGet(this, _IdleClock_timer, "f") !== void 0) {
          clearTimeout(__classPrivateFieldGet(this, _IdleClock_timer, "f"));
          __classPrivateFieldSet(this, _IdleClock_timer, void 0, "f");
        }
      }
    };
    _IdleClock_maxIdleMs = /* @__PURE__ */ new WeakMap(), _IdleClock_onExpire = /* @__PURE__ */ new WeakMap(), _IdleClock_blockers = /* @__PURE__ */ new WeakMap(), _IdleClock_armPending = /* @__PURE__ */ new WeakMap(), _IdleClock_timer = /* @__PURE__ */ new WeakMap();
    SessionToolRunner = class {
      constructor(sessionId, opts) {
        _SessionToolRunner_instances.add(this);
        _SessionToolRunner_consumed.set(this, false);
        _SessionToolRunner_controller.set(this, void 0);
        _SessionToolRunner_detachExternal.set(this, void 0);
        _SessionToolRunner_requestOpts.set(this, void 0);
        _SessionToolRunner_toolByName.set(this, void 0);
        _SessionToolRunner_logger.set(this, void 0);
        _SessionToolRunner_seen.set(this, /* @__PURE__ */ new Set());
        _SessionToolRunner_answered.set(this, /* @__PURE__ */ new Set());
        _SessionToolRunner_confirmationVerdicts.set(this, /* @__PURE__ */ new Map());
        _SessionToolRunner_awaitingConfirmation.set(this, /* @__PURE__ */ new Map());
        _SessionToolRunner_results.set(this, new AsyncQueue());
        _SessionToolRunner_inFlightCount.set(this, 0);
        _SessionToolRunner_onIdle.set(this, null);
        _SessionToolRunner_idleClock.set(this, void 0);
        this.client = opts.client;
        this.sessionId = sessionId;
        this.tools = opts.tools;
        this.maxIdleMs = opts.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
        __classPrivateFieldSet(this, _SessionToolRunner_logger, loggerFor(opts.client), "f");
        __classPrivateFieldSet(this, _SessionToolRunner_toolByName, new Map(opts.tools.map((t) => [toolName(t), t])), "f");
        __classPrivateFieldSet(this, _SessionToolRunner_controller, new AbortController(), "f");
        __classPrivateFieldSet(this, _SessionToolRunner_detachExternal, linkAbort(opts.signal, __classPrivateFieldGet(this, _SessionToolRunner_controller, "f")), "f");
        __classPrivateFieldSet(this, _SessionToolRunner_requestOpts, opts.requestOptions, "f");
        __classPrivateFieldSet(this, _SessionToolRunner_idleClock, new IdleClock(this.maxIdleMs, () => {
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("session idle after end_turn; stopping", {
            component: "session-tool-runner",
            session_id: this.sessionId,
            max_idle_ms: this.maxIdleMs
          });
          __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
        }), "f");
      }
      /** Read-only view of this runner's abort signal. */
      get signal() {
        return __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal;
      }
      /** Abort the runner. Background tasks will wind down and `for await` will exit cleanly. */
      abort() {
        __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
      }
      async *[(_SessionToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_controller = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_detachExternal = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_requestOpts = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_toolByName = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_logger = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_seen = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_answered = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_confirmationVerdicts = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_awaitingConfirmation = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_results = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_inFlightCount = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_onIdle = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_idleClock = /* @__PURE__ */ new WeakMap(), _SessionToolRunner_instances = /* @__PURE__ */ new WeakSet(), Symbol.asyncIterator)]() {
        if (__classPrivateFieldGet(this, _SessionToolRunner_consumed, "f")) {
          throw new AnthropicError("Cannot iterate over a consumed SessionToolRunner");
        }
        __classPrivateFieldSet(this, _SessionToolRunner_consumed, true, "f");
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("session tool runner starting", {
          component: "session-tool-runner",
          session_id: this.sessionId
        });
        const streamPromise = __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_streamLoop).call(this).catch((e) => {
          if (!__classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal.aborted) {
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").error("stream loop failed", { error: String(e) });
          }
          __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
        });
        try {
          while (true) {
            const next = await __classPrivateFieldGet(this, _SessionToolRunner_results, "f").next(__classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal);
            if (next.done)
              break;
            yield next.value;
          }
          await streamPromise;
          let pending;
          while ((pending = __classPrivateFieldGet(this, _SessionToolRunner_results, "f").tryShift()) !== void 0) {
            yield pending;
          }
        } finally {
          __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").disarm();
          await streamPromise;
          try {
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_drain).call(this);
          } catch (e) {
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("drain failed", { error: String(e) });
          }
          __classPrivateFieldGet(this, _SessionToolRunner_results, "f").close();
          for (const t of this.tools) {
            try {
              await t.close?.();
            } catch (e) {
              __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("tool.close failed", { tool: toolName(t), error: String(e) });
            }
          }
          __classPrivateFieldGet(this, _SessionToolRunner_detachExternal, "f").call(this);
        }
      }
    };
    _SessionToolRunner_requestOptions = function _SessionToolRunner_requestOptions2() {
      return {
        ...__classPrivateFieldGet(this, _SessionToolRunner_requestOpts, "f"),
        headers: buildHeaders([helperHeader("session-tool-runner"), __classPrivateFieldGet(this, _SessionToolRunner_requestOpts, "f")?.headers]),
        signal: __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal
      };
    }, _SessionToolRunner_streamLoop = // ===== event stream =====
    async function _SessionToolRunner_streamLoop2() {
      const ctrl = __classPrivateFieldGet(this, _SessionToolRunner_controller, "f");
      let backoff3 = STREAM_BACKOFF_START_MS;
      while (!ctrl.signal.aborted) {
        try {
          const stream = await this.client.beta.sessions.events.stream(this.sessionId, {}, __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_requestOptions).call(this));
          await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_reconcile).call(this);
          for await (const ev of stream) {
            backoff3 = STREAM_BACKOFF_START_MS;
            if (await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_handleStreamEvent).call(this, ev))
              return;
          }
        } catch (e) {
          ctrl.signal.throwIfAborted();
          if (isFatal4xx(e)) {
            __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").error("permanent stream failure, shutting down", { error: String(e) });
            ctrl.abort();
            throw e;
          }
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("stream disconnected, reconnecting", {
            error: String(e),
            backoff_ms: backoff3
          });
        }
        ctrl.signal.throwIfAborted();
        await sleep(backoff3, ctrl.signal);
        backoff3 = Math.min(backoff3 * 2, STREAM_BACKOFF_CAP_MS);
      }
    }, _SessionToolRunner_reconcile = /**
     * Read full history before dispatching so a `tool_use` whose result appears
     * later in the same history is not re-executed. Runs after the live stream is
     * already attached (see {@link SessionToolRunner.#streamLoop}).
     */
    async function _SessionToolRunner_reconcile2() {
      const ctrl = __classPrivateFieldGet(this, _SessionToolRunner_controller, "f");
      const pending = [];
      let lastWasEndTurn = false;
      try {
        for await (const ev of this.client.beta.sessions.events.list(this.sessionId, { limit: 1e3 }, __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_requestOptions).call(this))) {
          __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_ingestHistory).call(this, ev, pending);
          lastWasEndTurn = isEndTurnIdle(ev);
        }
      } catch (e) {
        ctrl.signal.throwIfAborted();
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("reconcile list failed", { error: String(e) });
        for (const ev of pending)
          __classPrivateFieldGet(this, _SessionToolRunner_seen, "f").delete(ev.id);
        return;
      }
      const unanswered = pending.filter((ev) => !__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id));
      __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").disarm();
      for (const ev of unanswered)
        await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_routeToolEvent).call(this, ev);
      for (const held of [...__classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").values()]) {
        const verdict = __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").get(held.id);
        if (verdict !== void 0)
          await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_applyVerdict).call(this, held, verdict);
      }
      const outstanding = unanswered.filter((ev) => !__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id) && !__classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").has(ev.id));
      if (lastWasEndTurn && outstanding.length === 0)
        __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").arm();
      else
        __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").disarm();
    }, _SessionToolRunner_ingestHistory = function _SessionToolRunner_ingestHistory2(ev, pending) {
      if (ev.type === "agent.tool_use" || ev.type === "agent.custom_tool_use") {
        __classPrivateFieldGet(this, _SessionToolRunner_seen, "f").add(ev.id);
        if (!__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id))
          pending.push(ev);
      } else if (ev.type === "user.tool_result") {
        __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.tool_use_id);
      } else if (ev.type === "user.custom_tool_result") {
        __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.custom_tool_use_id);
      } else if (ev.type === "user.tool_confirmation") {
        if (!__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.tool_use_id))
          __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").set(ev.tool_use_id, ev.result);
      }
    }, _SessionToolRunner_handleStreamEvent = /** Returns true when the runner should exit. */
    async function _SessionToolRunner_handleStreamEvent2(ev) {
      __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").noteEvent(ev);
      switch (ev.type) {
        case "agent.tool_use":
        case "agent.custom_tool_use":
          if (!__classPrivateFieldGet(this, _SessionToolRunner_seen, "f").has(ev.id)) {
            __classPrivateFieldGet(this, _SessionToolRunner_seen, "f").add(ev.id);
            await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_routeToolEvent).call(this, ev);
          }
          return false;
        case "user.tool_confirmation":
          await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_noteConfirmation).call(this, ev);
          return false;
        case "user.tool_result":
          __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.tool_use_id);
          return false;
        case "user.custom_tool_result":
          __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.custom_tool_use_id);
          return false;
        case "session.status_terminated":
        case "session.deleted":
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("session terminated", {
            component: "session-tool-runner",
            session_id: this.sessionId
          });
          __classPrivateFieldGet(this, _SessionToolRunner_controller, "f").abort();
          return true;
        default:
          return false;
      }
    }, _SessionToolRunner_routeToolEvent = // ===== confirmation gating (always_ask tools) =====
    /**
     * Dispatch `ev`, honoring its evaluated permission. A call the server gated
     * (`evaluated_permission == "ask"`) is held until its `user.tool_confirmation`
     * arrives. Fails closed: only an explicit `allow` verdict releases a gated
     * call; a server-side `deny` overrides any recorded verdict; an unrecognized
     * permission is held like `ask` and an unrecognized verdict is denied.
     */
    async function _SessionToolRunner_routeToolEvent2(ev) {
      const permission = ev.evaluated_permission;
      const verdict = permission === "deny" ? "deny" : __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").get(ev.id);
      if (verdict === void 0) {
        if (permission === void 0 || permission === "allow") {
          await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_execute).call(this, ev, void 0);
        } else if (!__classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").has(ev.id)) {
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool call awaiting confirmation; holding", {
            component: "session-tool-runner",
            session_id: this.sessionId,
            tool: ev.name,
            tool_use_id: ev.id
          });
          __classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").set(ev.id, ev);
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").block(ev.id);
        }
        return;
      }
      await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_applyVerdict).call(this, ev, verdict);
    }, _SessionToolRunner_noteConfirmation = /** Record an allow/deny verdict and release the held call it gates, if any. */
    async function _SessionToolRunner_noteConfirmation2(ev) {
      __classPrivateFieldGet(this, _SessionToolRunner_confirmationVerdicts, "f").set(ev.tool_use_id, ev.result);
      const held = __classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").get(ev.tool_use_id);
      if (held === void 0)
        return;
      await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_applyVerdict).call(this, held, ev.result);
    }, _SessionToolRunner_applyVerdict = /**
     * Dispatch or resolve a gated call according to its verdict.
     *
     * The idle-clock blocker accounting lives here: a denial retires the held
     * call's blocker, while an allow keeps one on the call — taking it now if the
     * verdict was already known when the call was routed, so it was never held —
     * until `#execute` has finished with it. The countdown must not run over
     * gated work that is still in flight.
     */
    async function _SessionToolRunner_applyVerdict2(ev, verdict) {
      const wasHeld = __classPrivateFieldGet(this, _SessionToolRunner_awaitingConfirmation, "f").delete(ev.id);
      if (verdict === "allow") {
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool call confirmed", {
          component: "session-tool-runner",
          session_id: this.sessionId,
          tool: ev.name,
          tool_use_id: ev.id
        });
        if (!wasHeld)
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").block(ev.id);
        try {
          await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_execute).call(this, ev, "allow");
        } finally {
          __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").unblock(ev.id);
        }
        return;
      }
      if (wasHeld)
        __classPrivateFieldGet(this, _SessionToolRunner_idleClock, "f").unblock(ev.id);
      __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(ev.id);
      __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool call denied; not executing", {
        component: "session-tool-runner",
        session_id: this.sessionId,
        tool: ev.name,
        tool_use_id: ev.id
      });
      __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_surfaceCall).call(this, {
        event: ev,
        toolUseId: ev.id,
        name: ev.name,
        isError: false,
        posted: false,
        confirmation: "deny"
      });
    }, _SessionToolRunner_surfaceCall = function _SessionToolRunner_surfaceCall2(call) {
      __classPrivateFieldGet(this, _SessionToolRunner_results, "f").push(call);
    }, _SessionToolRunner_execute = // ===== tool execution =====
    async function _SessionToolRunner_execute2(ev, confirmation) {
      var _a2, _b;
      if (__classPrivateFieldGet(this, _SessionToolRunner_answered, "f").has(ev.id))
        return;
      __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("executing tool", {
        component: "session-tool-runner",
        session_id: this.sessionId,
        tool: ev.name,
        tool_use_id: ev.id
      });
      __classPrivateFieldSet(this, _SessionToolRunner_inFlightCount, (_a2 = __classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f"), _a2++, _a2), "f");
      try {
        const tool = __classPrivateFieldGet(this, _SessionToolRunner_toolByName, "f").get(ev.name);
        if (!tool) {
          __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").info("tool not owned by this runner; leaving the tool_use_id pending for its owner", {
            component: "session-tool-runner",
            session_id: this.sessionId,
            tool: ev.name,
            tool_use_id: ev.id
          });
          __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_surfaceCall).call(this, {
            event: ev,
            toolUseId: ev.id,
            name: ev.name,
            isError: false,
            posted: false,
            confirmation
          });
          return;
        }
        let content;
        let isError;
        const toolCtrl = new AbortController();
        const detachTool = linkAbort(__classPrivateFieldGet(this, _SessionToolRunner_controller, "f").signal, toolCtrl);
        const timer = setTimeout(() => toolCtrl.abort(), TOOL_TIMEOUT_MS);
        try {
          const outcome = await runRunnableTool(tool, ev.input, {
            toolUse: ev,
            toolUseBlock: ev,
            signal: toolCtrl.signal
          });
          content = outcome.content;
          isError = outcome.isError;
        } finally {
          clearTimeout(timer);
          detachTool();
        }
        const result = buildResultEvent(ev, isError, toSessionContent(content));
        const posted = await __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_sendResult).call(this, result, ev.id);
        __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_surfaceCall).call(this, {
          event: ev,
          result,
          toolUseId: ev.id,
          name: ev.name,
          isError,
          posted,
          confirmation
        });
      } finally {
        __classPrivateFieldSet(this, _SessionToolRunner_inFlightCount, (_b = __classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f"), _b--, _b), "f");
        if (__classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f") === 0)
          __classPrivateFieldGet(this, _SessionToolRunner_onIdle, "f")?.call(this);
      }
    }, _SessionToolRunner_sendResult = async function _SessionToolRunner_sendResult2(result, toolUseId) {
      const ctrl = __classPrivateFieldGet(this, _SessionToolRunner_controller, "f");
      let lastErr;
      for (let i = 0; i < SEND_RETRIES; i++) {
        ctrl.signal.throwIfAborted();
        try {
          await this.client.beta.sessions.events.send(this.sessionId, { events: [result] }, __classPrivateFieldGet(this, _SessionToolRunner_instances, "m", _SessionToolRunner_requestOptions).call(this));
          __classPrivateFieldGet(this, _SessionToolRunner_answered, "f").add(toolUseId);
          return true;
        } catch (e) {
          lastErr = e;
          if (isFatal4xx(e))
            break;
          if (i < SEND_RETRIES - 1)
            await sleep((i + 1) * 1e3, ctrl.signal);
        }
      }
      __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").error("failed to send tool result", {
        tool_use_id: toolUseId,
        error: String(lastErr)
      });
      return false;
    }, _SessionToolRunner_drain = /** Wait (bounded) for in-flight tool executions to finish during teardown. */
    async function _SessionToolRunner_drain2() {
      if (__classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f") === 0)
        return;
      await Promise.race([new Promise((r) => __classPrivateFieldSet(this, _SessionToolRunner_onIdle, r, "f")), sleep(DRAIN_TIMEOUT_MS)]);
      __classPrivateFieldSet(this, _SessionToolRunner_onIdle, null, "f");
      if (__classPrivateFieldGet(this, _SessionToolRunner_inFlightCount, "f") > 0) {
        __classPrivateFieldGet(this, _SessionToolRunner_logger, "f").warn("drain timeout exceeded");
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs
var init_transform_json_schema = __esm({
  "node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs"() {
    init_utils2();
  }
});

// node_modules/@anthropic-ai/sdk/helpers/beta/json-schema.mjs
function betaTool(options) {
  if (options.inputSchema.type !== "object") {
    throw new Error(`JSON schema for tool "${options.name}" must be an object, but got ${options.inputSchema.type}`);
  }
  return {
    type: "custom",
    name: options.name,
    input_schema: options.inputSchema,
    description: options.description,
    run: options.run,
    parse: (content) => content,
    ...options.close ? { close: options.close } : {}
  };
}
var init_json_schema = __esm({
  "node_modules/@anthropic-ai/sdk/helpers/beta/json-schema.mjs"() {
    init_sdk();
    init_transform_json_schema();
  }
});

// node_modules/@anthropic-ai/sdk/internal/utils/promise.mjs
function promiseWithResolvers() {
  let resolve5;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve5 = res;
    reject = rej;
  });
  return { promise, resolve: resolve5, reject };
}
var init_promise = __esm({
  "node_modules/@anthropic-ai/sdk/internal/utils/promise.mjs"() {
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/fs-util.mjs
import * as fs from "node:fs/promises";
import * as path2 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
async function realpathOrSelf(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}
function errnoCode(err2) {
  const code = err2?.code;
  return typeof code === "string" ? code : void 0;
}
async function canonicalize(abs) {
  const tail = [];
  let prefix = abs;
  let hops = 0;
  for (; ; ) {
    let real;
    try {
      real = await fs.realpath(prefix);
    } catch (realpathErr) {
      let isLink;
      try {
        isLink = (await fs.lstat(prefix)).isSymbolicLink();
      } catch (lstatErr) {
        const code = errnoCode(lstatErr);
        if (code !== "ENOENT" && code !== "ENOTDIR")
          throw lstatErr;
        const parent = path2.dirname(prefix);
        if (parent === prefix)
          throw lstatErr;
        tail.push(path2.basename(prefix));
        prefix = parent;
        continue;
      }
      if (!isLink)
        throw realpathErr;
      if (++hops > MAX_SYMLINK_HOPS) {
        throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
      }
      prefix = path2.resolve(path2.dirname(prefix), await fs.readlink(prefix));
      continue;
    }
    return tail.length ? path2.join(real, ...tail.reverse()) : real;
  }
}
async function confineToRoot(root, p, opts) {
  const allowOutside = opts?.allowOutside ?? false;
  const realRoot = await realpathOrSelf(path2.resolve(root));
  const abs = path2.resolve(realRoot, p);
  if (allowOutside)
    return abs;
  let real;
  try {
    real = await canonicalize(abs);
  } catch (err2) {
    throw new ToolError(fsErrorMessage(err2, `path ${JSON.stringify(p)}`));
  }
  if (real !== realRoot && !real.startsWith(realRoot + path2.sep)) {
    throw new ToolError(`path ${JSON.stringify(p)} escapes workdir`);
  }
  return real;
}
async function atomicWriteFile(targetPath, content) {
  const dir = path2.dirname(targetPath);
  const tempPath = path2.join(dir, `.tmp-${process.pid}-${randomUUID2()}`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", FILE_CREATE_MODE);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = void 0;
    await fs.rename(tempPath, targetPath);
  } catch (err2) {
    if (handle)
      await handle.close().catch(() => {
      });
    await fs.unlink(tempPath).catch(() => {
    });
    throw err2;
  }
}
function fsErrorMessage(err2, file) {
  const code = errnoCode(err2);
  switch (code) {
    case "ENOENT":
      return `${file}: no such file or directory`;
    case "EACCES":
    case "EPERM":
      return `${file}: permission denied`;
    case "ENOTDIR":
      return `${file}: not a directory`;
    case "EISDIR":
      return `${file}: is a directory`;
    case "ELOOP":
      return `${file}: too many levels of symbolic links`;
    case "ENAMETOOLONG":
      return `${file}: file name too long`;
    case "ENOSPC":
      return `${file}: no space left on device`;
    case "EMFILE":
    case "ENFILE":
      return `${file}: too many open files`;
    default:
      return `${file}: ${code !== void 0 ? `i/o error (${code})` : "i/o error"}`;
  }
}
var DIR_CREATE_MODE, FILE_CREATE_MODE, MAX_SYMLINK_HOPS;
var init_fs_util = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/fs-util.mjs"() {
    init_ToolError();
    DIR_CREATE_MODE = 493;
    FILE_CREATE_MODE = 420;
    MAX_SYMLINK_HOPS = 40;
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/skills.mjs
import * as fs2 from "node:fs/promises";
import * as fssync from "node:fs";
import * as path3 from "node:path";
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
async function setupSkills(ctx) {
  const { client, sessionId } = ctx;
  if (!client || !sessionId)
    return async () => {
    };
  const log = loggerFor(client);
  const session = await client.beta.sessions.retrieve(sessionId);
  const skillsRoot = path3.resolve(ctx.workdir, "skills");
  const created = [];
  for (const skill of session.agent.skills) {
    try {
      const versionId = await resolveSkillVersion(client, skill.skill_id, skill.version);
      const version = await client.beta.skills.versions.retrieve(versionId, { skill_id: skill.skill_id });
      let dirname8 = path3.basename(version.name.trim());
      if (dirname8 === "" || dirname8 === "." || dirname8 === "..")
        dirname8 = skill.skill_id;
      const dest = path3.resolve(skillsRoot, dirname8);
      if (dest !== skillsRoot && !dest.startsWith(skillsRoot + path3.sep)) {
        log.warn("skill name escapes the skills dir; skipping", {
          component: "agent-tool-context",
          name: version.name
        });
        continue;
      }
      const resp = await client.beta.skills.versions.download(versionId, { skill_id: skill.skill_id });
      await fs2.rm(dest, { recursive: true, force: true });
      await fs2.mkdir(dest, { recursive: true, mode: DIR_CREATE_MODE });
      created.push(dest);
      await extractSkillArchive(resp, dest);
      log.info("downloaded skill", {
        component: "agent-tool-context",
        skill_id: skill.skill_id,
        version: versionId,
        dest
      });
    } catch (e) {
      log.warn("failed to download skill", {
        component: "agent-tool-context",
        skill_id: skill.skill_id,
        error: String(e)
      });
    }
  }
  return async () => {
    for (const dest of created) {
      await fs2.rm(dest, { recursive: true, force: true }).catch((e) => {
        log.warn("failed to clean up skill", { component: "agent-tool-context", dest, error: String(e) });
      });
    }
  };
}
async function resolveSkillVersion(client, skillId, version) {
  if (/^\d+$/.test(version))
    return version;
  let newest;
  for await (const v of client.beta.skills.versions.list(skillId)) {
    if (/^\d+$/.test(v.version) && (newest === void 0 || BigInt(v.version) > BigInt(newest))) {
      newest = v.version;
    }
  }
  if (newest === void 0) {
    throw new AnthropicError(`skill ${JSON.stringify(skillId)} has no concrete version to resolve ${JSON.stringify(version)} against`);
  }
  return newest;
}
function assertSafeMemberNames(names) {
  for (const raw of names) {
    const entry = raw.trim();
    if (!entry)
      continue;
    if (path3.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      throw new AnthropicError(`refusing to extract unsafe archive member: ${entry}`);
    }
  }
}
function listingLines(listing) {
  const lines = listing.split("\n");
  if (lines[lines.length - 1] === "")
    lines.pop();
  return lines;
}
function canExcludeVerbatim(cmd, name) {
  return /^[\x20-\x7E]+$/.test(name) && !/[\\^#]/.test(name) && !(cmd === "unzip" && name.startsWith("-"));
}
function classifyArchiveListing(cmd, names, typed) {
  const nameLines = listingLines(names);
  const typedLines = listingLines(typed);
  if (nameLines.length !== typedLines.length)
    throw new AnthropicError(INCONSISTENT_LISTING);
  const plain = [];
  const special = [];
  nameLines.forEach((name, i) => {
    if (PLAIN_TYPE_CHARS[cmd].has(typedLines[i].charAt(0))) {
      plain.push(name);
      return;
    }
    if (!canExcludeVerbatim(cmd, name)) {
      throw new AnthropicError(`refusing to extract archive: cannot safely exclude member ${JSON.stringify(name)}`);
    }
    special.push(name);
  });
  return { plain, special };
}
async function assertOnlyPlainEntries(dir) {
  for (const entry of await fs2.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      await assertOnlyPlainEntries(path3.join(dir, entry.name));
    else if (!entry.isFile())
      throw new AnthropicError(INCONSISTENT_LISTING);
  }
}
async function runArchiveTool(cmd, args) {
  try {
    const { stdout } = await execFileAsync2(cmd, args);
    return stdout;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") {
      throw new AnthropicError(`skill extraction requires the \`${cmd}\` command, but it was not found on PATH`);
    }
    throw e;
  }
}
function archiveTopDir(names) {
  let top;
  let nested = false;
  for (const raw of names) {
    const parts = raw.trim().split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0)
      continue;
    const first = parts[0];
    if (top === void 0)
      top = first;
    else if (first !== top)
      return "";
    if (parts.length > 1)
      nested = true;
  }
  return top !== void 0 && nested ? top : "";
}
async function extractSkillArchive(resp, dest) {
  const tmp = path3.join(dest, `.skill-archive-${process.pid}-${Date.now()}`);
  if (!resp.body) {
    throw new AnthropicError("skill download response had no body");
  }
  await pipeline(Readable.fromWeb(resp.body), fssync.createWriteStream(tmp));
  const stage = path3.join(path3.dirname(dest), `.skill-stage-${process.pid}-${Date.now()}`);
  const excludeFile = path3.join(path3.dirname(dest), `.skill-exclude-${process.pid}-${Date.now()}`);
  try {
    const head = await readHead(tmp, 4);
    const isZip = head.length >= 4 && head[0] === 80 && head[1] === 75 && head[2] === 3 && head[3] === 4;
    const archiveCmd = isZip ? "unzip" : "tar";
    const names = await runArchiveTool(archiveCmd, isZip ? ["-Z1", tmp] : ["-tf", tmp]);
    const typed = await runArchiveTool(archiveCmd, isZip ? ["-Z", "--h", "--t", tmp] : ["-tvf", tmp]);
    const { plain, special } = classifyArchiveListing(archiveCmd, names, typed);
    assertSafeMemberNames([...plain, ...special]);
    const top = archiveTopDir(plain);
    await fs2.mkdir(stage, { recursive: true, mode: DIR_CREATE_MODE });
    if (plain.length > 0) {
      await runArchiveTool(archiveCmd, await extractArgs(archiveCmd, tmp, stage, special, excludeFile));
    }
    await assertOnlyPlainEntries(stage);
    const srcRoot = top ? path3.join(stage, top) : stage;
    const entries = await fs2.readdir(srcRoot).catch((e) => {
      throw errnoCode(e) === "ENOENT" ? new AnthropicError(INCONSISTENT_LISTING) : e;
    });
    for (const entry of entries) {
      await fs2.rename(path3.join(srcRoot, entry), path3.join(dest, entry));
    }
  } finally {
    await fs2.rm(tmp, { force: true });
    await fs2.rm(excludeFile, { force: true });
    await fs2.rm(stage, { recursive: true, force: true });
  }
}
async function extractArgs(cmd, archive, stage, special, excludeFile) {
  const patterns = special.map((name) => name.replace(/[*?[\\]/g, "\\$&"));
  if (cmd === "unzip") {
    return ["-oq", archive, "-d", stage, ...patterns.length > 0 ? ["-x", ...patterns] : []];
  }
  if (patterns.length === 0)
    return ["-xf", archive, "-C", stage];
  await fs2.writeFile(excludeFile, patterns.join("\n") + "\n", { flag: "wx", mode: 384 });
  return ["-xf", archive, "-C", stage, "-X", excludeFile];
}
async function readHead(file, n) {
  const handle = await fs2.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
var execFileAsync2, INCONSISTENT_LISTING, PLAIN_TYPE_CHARS;
var init_skills = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/skills.mjs"() {
    init_error();
    init_log();
    init_fs_util();
    execFileAsync2 = promisify2(execFile2);
    INCONSISTENT_LISTING = "skill archive listing is inconsistent; refusing to extract";
    PLAIN_TYPE_CHARS = { unzip: /* @__PURE__ */ new Set(["-", "d", "?"]), tar: /* @__PURE__ */ new Set(["-", "d", "C"]) };
  }
});

// node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.mjs
var node_exports = {};
__export(node_exports, {
  BashSession: () => BashSession,
  BashTimeoutError: () => BashTimeoutError,
  betaAgentToolset20260401: () => betaAgentToolset20260401,
  betaBashTool: () => betaBashTool,
  betaEditTool: () => betaEditTool,
  betaGlobTool: () => betaGlobTool,
  betaGrepTool: () => betaGrepTool,
  betaReadTool: () => betaReadTool,
  betaWriteTool: () => betaWriteTool,
  extractSkillArchive: () => extractSkillArchive,
  resolvePath: () => resolvePath,
  resolveSkillVersion: () => resolveSkillVersion,
  setupSkills: () => setupSkills
});
import * as fs3 from "node:fs/promises";
import * as fssync2 from "node:fs";
import * as path4 from "node:path";
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
function resolveMaxBytes(configured) {
  return configured === void 0 ? DEFAULT_MAX_FILE_BYTES : configured;
}
function betaAgentToolset20260401(ctx) {
  return [
    betaBashTool(ctx),
    betaReadTool(ctx),
    betaWriteTool(ctx),
    betaEditTool(ctx),
    betaGlobTool(ctx),
    betaGrepTool(ctx)
  ];
}
function resolvePath(ctx, p) {
  return confineToRoot(ctx.workdir, p, { allowOutside: ctx.unrestrictedPaths ?? false });
}
function scrubbedShellEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ANTHROPIC_"))
      continue;
    env[key] = value;
  }
  return env;
}
function betaBashTool(ctx) {
  let session;
  let tail = Promise.resolve();
  return betaTool({
    name: "bash",
    description: "Run a bash command in a persistent shell. State (cwd, env vars) persists across calls.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        restart: { type: "boolean", description: "Restart the persistent shell before running" },
        timeout_ms: { type: "integer", description: "Per-call timeout in milliseconds" }
      }
    },
    run: async ({ command, restart, timeout_ms }, context) => {
      const prev = tail;
      const gate = promiseWithResolvers();
      tail = gate.promise;
      try {
        await prev;
      } catch {
      }
      try {
        if (restart) {
          session?.close();
          session = void 0;
        }
        if (!command) {
          if (restart)
            return "bash session restarted";
          throw new ToolError("bash: command is required");
        }
        session ?? (session = new BashSession(ctx.workdir, ctx.env));
        try {
          const { output, exitCode } = await session.exec(command, {
            timeoutMs: timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS,
            signal: context?.signal
          });
          if (exitCode !== 0)
            throw new ToolError(output || `exit ${exitCode}`);
          return output;
        } catch (e) {
          if (e instanceof ToolError)
            throw e;
          session.close();
          session = void 0;
          throw new ToolError(`bash: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        gate.resolve();
      }
    },
    close: () => {
      session?.close();
      session = void 0;
    }
  });
}
function betaReadTool(ctx) {
  return betaTool({
    name: "read",
    description: "Read a UTF-8 text file relative to the workdir.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        view_range: {
          type: "array",
          items: { type: "integer" },
          description: "[start_line, end_line] 1-indexed inclusive"
        }
      },
      required: ["file_path"]
    },
    run: async ({ file_path, view_range }) => {
      if (!file_path)
        throw new ToolError("read: file_path is required");
      const abs = await resolvePath(ctx, file_path);
      let data;
      try {
        const st = await fs3.stat(abs);
        if (!st.isFile()) {
          throw new ToolError(`read: ${file_path} is not a regular file`);
        }
        const limit2 = resolveMaxBytes(ctx.maxFileBytes);
        if (limit2 !== null && st.size > limit2) {
          throw new ToolError(`read: ${file_path} is ${st.size} bytes, exceeds ${limit2}-byte limit. Use bash (head/tail/sed) to read a slice.`);
        }
        data = await fs3.readFile(abs, "utf8");
      } catch (e) {
        if (e instanceof ToolError)
          throw e;
        throw new ToolError(`read: ${fsErrorMessage(e, file_path)}`);
      }
      if (!view_range?.length)
        return data;
      if (view_range.length !== 2)
        throw new ToolError("read: view_range must be [start_line, end_line]");
      const [startLine, endLine] = view_range;
      const lines = data.split("\n");
      const start = Math.max(0, startLine - 1);
      const end = endLine > 0 ? endLine : lines.length;
      return lines.slice(start, end).join("\n");
    }
  });
}
function betaWriteTool(ctx) {
  return betaTool({
    name: "write",
    description: "Write a UTF-8 text file relative to the workdir, creating parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"]
    },
    run: async ({ file_path, content }) => {
      if (!file_path)
        throw new ToolError("write: file_path is required");
      const abs = await resolvePath(ctx, file_path);
      try {
        await fs3.mkdir(path4.dirname(abs), { recursive: true, mode: DIR_CREATE_MODE });
        await atomicWriteFile(abs, content ?? "");
      } catch (e) {
        throw new ToolError(`write: ${fsErrorMessage(e, file_path)}`);
      }
      return `wrote ${Buffer.byteLength(content ?? "")} bytes to ${file_path}`;
    }
  });
}
function betaEditTool(ctx) {
  return betaTool({
    name: "edit",
    description: "Replace old_string with new_string in a file. old_string must be unique unless replace_all.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" }
      },
      required: ["file_path", "old_string", "new_string"]
    },
    run: async ({ file_path, old_string, new_string, replace_all }) => {
      if (!file_path)
        throw new ToolError("edit: file_path is required");
      if (!old_string)
        throw new ToolError("edit: old_string is required");
      const abs = await resolvePath(ctx, file_path);
      let data;
      try {
        const st = await fs3.stat(abs);
        if (!st.isFile()) {
          throw new ToolError(`edit: ${file_path} is not a regular file`);
        }
        const limit2 = resolveMaxBytes(ctx.maxFileBytes);
        if (limit2 !== null && st.size > limit2) {
          throw new ToolError(`edit: ${file_path} is ${st.size} bytes, exceeds ${limit2}-byte limit. Use bash (sed/awk) to edit a large file.`);
        }
        data = await fs3.readFile(abs, "utf8");
      } catch (e) {
        if (e instanceof ToolError)
          throw e;
        throw new ToolError(`edit: ${fsErrorMessage(e, file_path)}`);
      }
      const count = data.split(old_string).length - 1;
      if (count === 0)
        throw new ToolError(`edit: old_string not found in ${file_path}`);
      let updated;
      if (replace_all) {
        updated = data.split(old_string).join(new_string);
      } else {
        if (count > 1)
          throw new ToolError(`edit: old_string appears ${count} times in ${file_path} (must be unique)`);
        updated = data.replace(old_string, () => new_string);
      }
      try {
        await atomicWriteFile(abs, updated);
      } catch (e) {
        throw new ToolError(`edit: write: ${fsErrorMessage(e, file_path)}`);
      }
      return `edited ${file_path} (${replace_all ? count : 1} replacement(s))`;
    }
  });
}
function betaGlobTool(ctx) {
  return betaTool({
    name: "glob",
    description: "Match files under the workdir against a glob pattern. Results are mtime-sorted, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to search in. Defaults to the workdir." }
      },
      required: ["pattern"]
    },
    run: async ({ pattern, path: searchPath }) => {
      if (!pattern)
        throw new ToolError("glob: pattern is required");
      let root = path4.resolve(ctx.workdir);
      let pat = pattern;
      if (path4.isAbsolute(pattern)) {
        if (!ctx.unrestrictedPaths)
          throw new ToolError("glob: absolute pattern not permitted");
        root = path4.parse(pattern).root;
        pat = path4.relative(root, pattern);
      } else if (searchPath) {
        root = await resolvePath(ctx, searchPath);
      }
      if (!ctx.unrestrictedPaths && pat.split(/[\\/]/).includes("..")) {
        throw new ToolError('glob: ".." is not permitted in the pattern');
      }
      const realRoot = ctx.unrestrictedPaths ? root : await fs3.realpath(root).catch(() => root);
      const matches = [];
      try {
        for await (const entry of fsGlob(pat, {
          cwd: root,
          withFileTypes: true,
          exclude: (d) => d.name === ".git" || d.name === "node_modules"
        })) {
          if (!entry.isFile())
            continue;
          const full = path4.join(entry.parentPath, entry.name);
          if (!ctx.unrestrictedPaths) {
            let real;
            try {
              real = await fs3.realpath(full);
            } catch {
              continue;
            }
            if (!isWithin(realRoot, real))
              continue;
          }
          let mtime = 0;
          try {
            mtime = (await fs3.stat(full)).mtimeMs;
          } catch {
          }
          matches.push({ path: full, mtime });
        }
      } catch (e) {
        throw new ToolError(`glob: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (matches.length === 0)
        return "no matches";
      matches.sort((a, b) => b.mtime - a.mtime);
      return matches.slice(0, GLOB_RESULT_LIMIT).map((m) => m.path).join("\n");
    }
  });
}
function betaGrepTool(ctx) {
  return betaTool({
    name: "grep",
    description: "Search file contents for a regex. Uses ripgrep if available, otherwise a built-in walker.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"]
    },
    run: async ({ pattern, path: p }, context) => {
      if (!pattern)
        throw new ToolError("grep: pattern is required");
      let searchPath = path4.resolve(ctx.workdir);
      if (p)
        searchPath = await resolvePath(ctx, p);
      const rg = await findRg();
      return rg ? runRipgrep(rg, pattern, searchPath, context?.signal) : runWalkGrep(pattern, searchPath, context?.signal);
    }
  });
}
function runRipgrep(rg, pattern, searchPath, signal) {
  return new Promise((resolve5, reject) => {
    const proc = cp.spawn(rg, ["-n", "--no-heading", "-e", pattern, "--", searchPath], {
      ...signal ? { signal } : {}
    });
    let out2 = "";
    let errOut = "";
    let truncated = false;
    proc.stdout.on("data", (d) => {
      if (truncated)
        return;
      out2 += d;
      if (out2.length > GREP_OUTPUT_LIMIT) {
        truncated = true;
        out2 = out2.slice(0, GREP_OUTPUT_LIMIT);
        proc.kill("SIGKILL");
      }
    });
    proc.stderr.on("data", (d) => errOut += d);
    proc.on("close", (code) => {
      if (signal?.aborted)
        return reject(new ToolError("grep: aborted"));
      if (truncated)
        return resolve5(out2 + `
[output truncated at ${GREP_OUTPUT_LIMIT} bytes]`);
      if (code === 0)
        return resolve5(out2);
      if (code === 1)
        return resolve5("no matches");
      reject(new ToolError(`grep: rg failed: ${errOut || `exit ${code}`}`));
    });
    proc.on("error", (e) => {
      if (signal?.aborted)
        return reject(new ToolError("grep: aborted"));
      reject(new ToolError(`grep: rg failed: ${e.message}`));
    });
  });
}
async function runWalkGrep(pattern, root, signal) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new ToolError(`grep: invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hits = [];
  let budget = GREP_OUTPUT_LIMIT;
  const push = (line) => {
    budget -= line.length + 1;
    if (budget < 0) {
      hits.push(`[output truncated at ${GREP_OUTPUT_LIMIT} bytes]`);
      return false;
    }
    hits.push(line);
    return true;
  };
  const stat2 = await fs3.stat(root).catch(() => null);
  if (stat2?.isFile()) {
    await grepFile(root, re, push);
  } else {
    await walk(root, "", (rel) => grepFile(path4.join(root, rel), re, push), signal);
  }
  if (signal?.aborted)
    throw new ToolError("grep: aborted");
  if (hits.length === 0)
    return "no matches";
  return hits.join("\n");
}
async function grepFile(file, re, push) {
  const stream = fssync2.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let i = 0;
  try {
    for await (const line of rl) {
      i++;
      if (line.length > GREP_MAX_LINE_LENGTH)
        continue;
      if (re.test(line) && !push(`${file}:${i}:${line}`))
        return false;
    }
  } catch {
  } finally {
    stream.destroy();
  }
  return true;
}
function isWithin(root, p) {
  const rel = path4.relative(root, p);
  return rel === "" || !rel.startsWith(".." + path4.sep) && rel !== ".." && !path4.isAbsolute(rel);
}
async function walk(root, rel, fn, signal) {
  let remaining = WALK_MAX_ENTRIES;
  async function inner(rel2, depth) {
    if (depth > WALK_MAX_DEPTH)
      return true;
    if (signal?.aborted)
      return false;
    let entries;
    try {
      entries = await fs3.readdir(path4.join(root, rel2), { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules")
        continue;
      if (remaining-- <= 0)
        return false;
      if (signal?.aborted)
        return false;
      const childRel = rel2 ? path4.join(rel2, e.name) : e.name;
      if (e.isDirectory()) {
        if (!await inner(childRel, depth + 1))
          return false;
      } else if (e.isFile()) {
        if (await fn(childRel) === false)
          return false;
      }
    }
    return true;
  }
  await inner(rel, 0);
}
async function findRg() {
  const dirs = (process.env["PATH"] ?? "").split(path4.delimiter);
  for (const d of dirs) {
    const candidate = path4.join(d, "rg");
    try {
      await fs3.access(candidate, fssync2.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}
var _BashSession_instances, _BashSession_proc, _BashSession_buf, _BashSession_truncated, _BashSession_closed, _BashSession_waiting, _BashSession_append, BASH_OUTPUT_LIMIT, BASH_DEFAULT_TIMEOUT_MS, DEFAULT_MAX_FILE_BYTES, GREP_OUTPUT_LIMIT, GREP_MAX_LINE_LENGTH, GLOB_RESULT_LIMIT, BashTimeoutError, ANSI_RE, fsGlob, BashSession, WALK_MAX_DEPTH, WALK_MAX_ENTRIES;
var init_node = __esm({
  "node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.mjs"() {
    init_tslib();
    init_error();
    init_ToolError();
    init_json_schema();
    init_promise();
    init_fs_util();
    init_skills();
    BASH_OUTPUT_LIMIT = 100 * 1024;
    BASH_DEFAULT_TIMEOUT_MS = 12e4;
    DEFAULT_MAX_FILE_BYTES = 256 * 1024;
    GREP_OUTPUT_LIMIT = 100 * 1024;
    GREP_MAX_LINE_LENGTH = 2e3;
    GLOB_RESULT_LIMIT = 200;
    BashTimeoutError = class extends AnthropicError {
      constructor(timeoutMs) {
        super(`bash command timed out after ${timeoutMs}ms`);
        this.name = "BashTimeoutError";
        this.timeoutMs = timeoutMs;
      }
    };
    ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    fsGlob = fs3.glob;
    BashSession = class {
      constructor(dir, env = scrubbedShellEnv()) {
        _BashSession_instances.add(this);
        _BashSession_proc.set(this, void 0);
        _BashSession_buf.set(this, "");
        _BashSession_truncated.set(this, false);
        _BashSession_closed.set(this, false);
        _BashSession_waiting.set(this, null);
        __classPrivateFieldSet(this, _BashSession_proc, cp.spawn("/bin/bash", ["--noprofile", "--norc"], {
          cwd: dir,
          // `env` is the full base environment (the scrubbed process env by
          // default, or the verbatim replacement from `AgentToolContext.env`).
          // PS1/PS2/TERM are shell-control settings BashSession always applies so
          // the pipe-based sentinel exec parsing works — not part of the
          // user-facing environment.
          env: { ...env, PS1: "", PS2: "", TERM: "dumb" },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true
        }), "f");
        __classPrivateFieldGet(this, _BashSession_proc, "f").stdout.setEncoding("utf8");
        __classPrivateFieldGet(this, _BashSession_proc, "f").stderr.setEncoding("utf8");
        __classPrivateFieldGet(this, _BashSession_proc, "f").stdout.on("data", (d) => __classPrivateFieldGet(this, _BashSession_instances, "m", _BashSession_append).call(this, d));
        __classPrivateFieldGet(this, _BashSession_proc, "f").stderr.on("data", (d) => __classPrivateFieldGet(this, _BashSession_instances, "m", _BashSession_append).call(this, d));
        __classPrivateFieldGet(this, _BashSession_proc, "f").once("close", () => {
          __classPrivateFieldSet(this, _BashSession_closed, true, "f");
          const w = __classPrivateFieldGet(this, _BashSession_waiting, "f");
          __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
          w?.resolve();
        });
      }
      /** Whether the underlying shell process has exited. */
      get closed() {
        return __classPrivateFieldGet(this, _BashSession_closed, "f");
      }
      async exec(command, opts = {}) {
        if (__classPrivateFieldGet(this, _BashSession_closed, "f")) {
          throw new AnthropicError("bash session terminated");
        }
        const timeoutMs = opts.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
        const signal = opts.signal;
        signal?.throwIfAborted();
        __classPrivateFieldSet(this, _BashSession_buf, "", "f");
        __classPrivateFieldSet(this, _BashSession_truncated, false, "f");
        const sentinel2 = `__ANT_CMD_${crypto.randomUUID()}_DONE__`;
        const sentinelSplit = `${sentinel2.slice(0, 8)}''${sentinel2.slice(8)}`;
        const wrapped = `{ ${command}
} </dev/null 2>&1; printf '\\n${sentinelSplit}%d\\n' $?
`;
        __classPrivateFieldGet(this, _BashSession_proc, "f").stdin.write(wrapped);
        if (__classPrivateFieldGet(this, _BashSession_buf, "f").indexOf(sentinel2) < 0) {
          const { promise: sentinelSeen, resolve: resolve5 } = promiseWithResolvers();
          __classPrivateFieldSet(this, _BashSession_waiting, { sentinel: sentinel2, resolve: resolve5 }, "f");
          let timer;
          let onAbort;
          try {
            await Promise.race([
              sentinelSeen,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new BashTimeoutError(timeoutMs)), timeoutMs);
              }),
              new Promise((_, reject) => {
                if (!signal)
                  return;
                onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
              })
            ]);
          } finally {
            if (timer)
              clearTimeout(timer);
            if (onAbort && signal)
              signal.removeEventListener("abort", onAbort);
            __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
          }
        }
        const idx = __classPrivateFieldGet(this, _BashSession_buf, "f").indexOf(sentinel2);
        if (idx < 0) {
          throw new AnthropicError("bash session terminated");
        }
        const tail = __classPrivateFieldGet(this, _BashSession_buf, "f").slice(idx + sentinel2.length);
        const m = tail.match(/^(-?\d+)/);
        const exitCode = m ? parseInt(m[1], 10) : -1;
        let out2 = __classPrivateFieldGet(this, _BashSession_buf, "f").slice(0, idx).replace(ANSI_RE, "").replace(/\n+$/, "");
        if (__classPrivateFieldGet(this, _BashSession_truncated, "f")) {
          out2 = `[output truncated]
${out2}`;
        }
        return { output: out2, exitCode };
      }
      close() {
        if (__classPrivateFieldGet(this, _BashSession_closed, "f"))
          return;
        __classPrivateFieldSet(this, _BashSession_closed, true, "f");
        const w = __classPrivateFieldGet(this, _BashSession_waiting, "f");
        __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
        w?.resolve();
        __classPrivateFieldGet(this, _BashSession_proc, "f").stdout.destroy();
        __classPrivateFieldGet(this, _BashSession_proc, "f").stderr.destroy();
        __classPrivateFieldGet(this, _BashSession_proc, "f").stdin.destroy();
        try {
          process.kill(-__classPrivateFieldGet(this, _BashSession_proc, "f").pid, "SIGKILL");
        } catch {
          __classPrivateFieldGet(this, _BashSession_proc, "f").kill("SIGKILL");
        }
        __classPrivateFieldGet(this, _BashSession_proc, "f").unref();
      }
    };
    _BashSession_proc = /* @__PURE__ */ new WeakMap(), _BashSession_buf = /* @__PURE__ */ new WeakMap(), _BashSession_truncated = /* @__PURE__ */ new WeakMap(), _BashSession_closed = /* @__PURE__ */ new WeakMap(), _BashSession_waiting = /* @__PURE__ */ new WeakMap(), _BashSession_instances = /* @__PURE__ */ new WeakSet(), _BashSession_append = function _BashSession_append2(d) {
      __classPrivateFieldSet(this, _BashSession_buf, __classPrivateFieldGet(this, _BashSession_buf, "f") + d, "f");
      if (__classPrivateFieldGet(this, _BashSession_buf, "f").length > BASH_OUTPUT_LIMIT) {
        __classPrivateFieldSet(this, _BashSession_buf, __classPrivateFieldGet(this, _BashSession_buf, "f").slice(__classPrivateFieldGet(this, _BashSession_buf, "f").length - BASH_OUTPUT_LIMIT), "f");
        __classPrivateFieldSet(this, _BashSession_truncated, true, "f");
      }
      if (__classPrivateFieldGet(this, _BashSession_waiting, "f") && __classPrivateFieldGet(this, _BashSession_buf, "f").indexOf(__classPrivateFieldGet(this, _BashSession_waiting, "f").sentinel) >= 0) {
        const w = __classPrivateFieldGet(this, _BashSession_waiting, "f");
        __classPrivateFieldSet(this, _BashSession_waiting, null, "f");
        w.resolve();
      }
    };
    WALK_MAX_DEPTH = 40;
    WALK_MAX_ENTRIES = 5e4;
  }
});

// node_modules/@anthropic-ai/sdk/lib/environments/worker.mjs
async function forceStop(client, work, log, requestOptions) {
  try {
    await client.beta.environments.work.stop(
      work.id,
      { environment_id: work.environment_id, force: true },
      // Caller's headers pass through; the helper-tag header is on the scoped
      // sub-client's default_headers via copyClientForHelper, so no per-call
      // re-stamping needed.
      { ...requestOptions, headers: buildHeaders([requestOptions?.headers]) }
    );
  } catch (e) {
    if (!isStatus(e, 409)) {
      log.error("force-stop on exit failed", { work_id: work.id, error: String(e) });
    }
  }
}
async function heartbeatLoop(client, work, ctrl, logger, requestOptions) {
  let intervalMs = HEARTBEAT_DEFAULT_MS;
  let ttlMs = HEARTBEAT_TTL_DEFAULT_MS;
  let lastSuccessMs = Date.now();
  let last = NO_HEARTBEAT_SENTINEL;
  const beat = async () => {
    const beatCtrl = new AbortController();
    const detach = linkAbort(ctrl.signal, beatCtrl);
    const cutoff = setTimeout(() => beatCtrl.abort(), intervalMs);
    try {
      const resp = await client.beta.environments.work.heartbeat(work.id, { environment_id: work.environment_id, expected_last_heartbeat: last }, { ...requestOptions, headers: buildHeaders([requestOptions?.headers]), signal: beatCtrl.signal });
      lastSuccessMs = Date.now();
      last = resp.last_heartbeat;
      if (resp.ttl_seconds > 0) {
        ttlMs = resp.ttl_seconds * 1e3;
        intervalMs = Math.max(1e3, Math.min(ttlMs / 2, HEARTBEAT_DEFAULT_MS));
      }
      if (resp.state === "stopping" || resp.state === "stopped") {
        logger.info("heartbeat signals shutdown", { work_id: work.id, state: resp.state });
        ctrl.abort();
      }
      if (!resp.lease_extended) {
        logger.warn("lease not extended, shutting down", { work_id: work.id });
        ctrl.abort();
      }
    } catch (e) {
      ctrl.signal.throwIfAborted();
      if (isFatal4xx(e)) {
        logger.error("permanent heartbeat failure", { work_id: work.id, error: String(e) });
        ctrl.abort();
        throw e;
      }
      if (Date.now() - lastSuccessMs > ttlMs) {
        logger.error("lease assumed lost: no successful heartbeat in ttl", {
          work_id: work.id,
          ttl_ms: ttlMs,
          error: String(e)
        });
        ctrl.abort();
        return;
      }
      logger.warn("transient heartbeat failure", { work_id: work.id, error: String(e) });
    } finally {
      clearTimeout(cutoff);
      detach();
    }
  };
  await beat();
  while (!ctrl.signal.aborted) {
    await sleep(intervalMs, ctrl.signal);
    ctrl.signal.throwIfAborted();
    await beat();
  }
}
var _EnvironmentWorker_instances, _EnvironmentWorker_signal, _EnvironmentWorker_handleItem, HEARTBEAT_DEFAULT_MS, HEARTBEAT_TTL_DEFAULT_MS, NO_HEARTBEAT_SENTINEL, EnvironmentWorker;
var init_worker = __esm({
  "node_modules/@anthropic-ai/sdk/lib/environments/worker.mjs"() {
    init_tslib();
    init_error();
    init_log();
    init_env();
    init_sleep();
    init_backoff();
    init_abort();
    init_headers();
    init_SessionToolRunner();
    init_poller();
    init_helper_client();
    HEARTBEAT_DEFAULT_MS = 3e4;
    HEARTBEAT_TTL_DEFAULT_MS = 9e4;
    NO_HEARTBEAT_SENTINEL = "NO_HEARTBEAT";
    EnvironmentWorker = class {
      constructor(opts) {
        _EnvironmentWorker_instances.add(this);
        _EnvironmentWorker_signal.set(this, void 0);
        this.client = opts.client;
        this.environmentId = opts.environmentId;
        this.environmentKey = opts.environmentKey;
        this.tools = opts.tools;
        this.workdir = opts.workdir ?? process.cwd();
        this.unrestrictedPaths = opts.unrestrictedPaths;
        this.maxFileBytes = opts.maxFileBytes;
        this.maxIdleMs = opts.maxIdleMs;
        this.workerId = opts.workerId;
        this.requestOptions = opts.requestOptions;
        __classPrivateFieldSet(this, _EnvironmentWorker_signal, opts.signal, "f");
      }
      /**
       * Poll the environment and service each claimed session until the supplied
       * signal (or the one passed to the constructor) aborts. Throws if
       * `environmentId` / `environmentKey` were not provided to the constructor.
       */
      async run(signal) {
        const { environmentId, environmentKey } = this;
        if (environmentId === void 0 || environmentKey === void 0) {
          throw new AnthropicError("EnvironmentWorker.run: environmentId and environmentKey are required to poll for work");
        }
        const externalSignal = signal ?? __classPrivateFieldGet(this, _EnvironmentWorker_signal, "f");
        const poller = new WorkPoller({
          client: this.client,
          environmentId,
          environmentKey,
          ...this.workerId !== void 0 ? { workerId: this.workerId } : {},
          ...externalSignal ? { signal: externalSignal } : {},
          ...this.requestOptions !== void 0 ? { requestOptions: this.requestOptions } : {},
          // The per-item handler force-stops every work item on exit; let it be the
          // single owner of `work.stop` rather than double-posting from the poller.
          autoStop: false
        });
        for await (const work of poller) {
          await __classPrivateFieldGet(this, _EnvironmentWorker_instances, "m", _EnvironmentWorker_handleItem).call(this, work, environmentKey, poller.signal);
        }
      }
      /**
       * Service a single, already-claimed work item without the poll loop: build the
       * per-session {@link AgentToolContext} (workdir from this worker's options),
       * download the session agent's skills (`setupSkills`), run a
       * {@link SessionToolRunner} for the session while heartbeating the work-item
       * lease in parallel, and force-stop the work item on exit (whether the runner
       * finishes normally, throws, or the heartbeat loop signals shutdown).
       *
       * Use this when something else does the claiming — e.g. a `worker poll
       * --on-work` script that hands an already-claimed item to a fresh process. The
       * work id / environment id / session id each fall back to `ANTHROPIC_WORK_ID` /
       * `ANTHROPIC_ENVIRONMENT_ID` / `ANTHROPIC_SESSION_ID` (the env vars that
       * command sets) when not passed; the environment key resolves from this
       * option, then the worker's own `environmentKey`, then
       * `ANTHROPIC_ENVIRONMENT_KEY`. With no arguments inside that command it just
       * works. Throws a clear error naming the first of the four required values
       * still missing after resolution.
       */
      async handleItem(opts) {
        const workId = opts?.workId ?? readEnv("ANTHROPIC_WORK_ID");
        const environmentId = opts?.environmentId ?? readEnv("ANTHROPIC_ENVIRONMENT_ID");
        const sessionId = opts?.sessionId ?? readEnv("ANTHROPIC_SESSION_ID");
        const environmentKey = opts?.environmentKey ?? this.environmentKey ?? readEnv("ANTHROPIC_ENVIRONMENT_KEY");
        if (!workId) {
          throw new AnthropicError("handleItem: workId is required \u2014 pass it or set ANTHROPIC_WORK_ID");
        }
        if (!environmentId) {
          throw new AnthropicError("handleItem: environmentId is required \u2014 pass it or set ANTHROPIC_ENVIRONMENT_ID");
        }
        if (!sessionId) {
          throw new AnthropicError("handleItem: sessionId is required \u2014 pass it or set ANTHROPIC_SESSION_ID");
        }
        if (!environmentKey) {
          throw new AnthropicError("handleItem: environmentKey is required \u2014 pass it, construct the worker with it, or set ANTHROPIC_ENVIRONMENT_KEY");
        }
        const work = {
          id: workId,
          environment_id: environmentId,
          data: { type: "session", id: sessionId }
        };
        await __classPrivateFieldGet(this, _EnvironmentWorker_instances, "m", _EnvironmentWorker_handleItem).call(this, work, environmentKey, opts?.signal ?? __classPrivateFieldGet(this, _EnvironmentWorker_signal, "f"));
      }
    };
    _EnvironmentWorker_signal = /* @__PURE__ */ new WeakMap(), _EnvironmentWorker_instances = /* @__PURE__ */ new WeakSet(), _EnvironmentWorker_handleItem = /**
     * The per-item body shared by {@link EnvironmentWorker.run}'s poll loop and
     * {@link EnvironmentWorker.handleItem}: run a {@link SessionToolRunner} for the
     * work item's session while heartbeating its lease, force-stopping on exit.
     * Non-session work items are ignored.
     */
    async function _EnvironmentWorker_handleItem2(work, environmentKey, externalSignal) {
      const log = loggerFor(this.client);
      const sessionClient = copyClientForHelper(this.client, {
        authToken: environmentKey,
        helper: "environments-worker"
      });
      const sessionId = work.data.id;
      const ctx = {
        workdir: this.workdir,
        client: this.client,
        sessionId,
        ...this.unrestrictedPaths !== void 0 ? { unrestrictedPaths: this.unrestrictedPaths } : {},
        ...this.maxFileBytes !== void 0 ? { maxFileBytes: this.maxFileBytes } : {}
      };
      const agentToolset = await Promise.resolve().then(() => (init_node(), node_exports));
      let cleanupSkills = async () => {
      };
      try {
        cleanupSkills = await agentToolset.setupSkills(ctx);
      } catch (e) {
        log.warn("skill setup failed", { session_id: sessionId, work_id: work.id, error: String(e) });
      }
      const tools = typeof this.tools === "function" ? this.tools(ctx) : this.tools ?? agentToolset.betaAgentToolset20260401(ctx);
      const ctrl = new AbortController();
      const detachExternal = linkAbort(externalSignal, ctrl);
      const heartbeatPromise = heartbeatLoop(sessionClient, work, ctrl, log, this.requestOptions).catch((e) => {
        if (!ctrl.signal.aborted)
          log.error("heartbeat loop failed", { work_id: work.id, error: String(e) });
        ctrl.abort();
      });
      try {
        const runner = new SessionToolRunner(sessionId, {
          client: sessionClient,
          tools,
          ...this.maxIdleMs !== void 0 ? { maxIdleMs: this.maxIdleMs } : {},
          ...this.requestOptions !== void 0 ? { requestOptions: this.requestOptions } : {},
          signal: ctrl.signal
        });
        for await (const _ of runner) {
        }
      } finally {
        ctrl.abort();
        detachExternal();
        await heartbeatPromise;
        await cleanupSkills().catch((e) => {
          log.warn("skill cleanup failed", { session_id: sessionId, work_id: work.id, error: String(e) });
        });
        await forceStop(sessionClient, work, log, this.requestOptions);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/environments/work.mjs
var Work;
var init_work = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/environments/work.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    init_poller();
    init_worker();
    init_poller();
    init_worker();
    Work = class extends APIResource {
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * Retrieve detailed information about a specific work item.
       *
       * @example
       * ```ts
       * const betaSelfHostedWork =
       *   await client.beta.environments.work.retrieve('work_id', {
       *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   });
       * ```
       */
      retrieve(workID, params, options) {
        const { environment_id, betas } = params;
        return this._client.get(path`/v1/environments/${environment_id}/work/${workID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * Update work item metadata with merge semantics.
       *
       * @example
       * ```ts
       * const betaSelfHostedWork =
       *   await client.beta.environments.work.update('work_id', {
       *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *     metadata: { foo: 'string' },
       *   });
       * ```
       */
      update(workID, params, options) {
        const { environment_id, betas, ...body } = params;
        return this._client.post(path`/v1/environments/${environment_id}/work/${workID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * List work items in an environment.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaSelfHostedWork of client.beta.environments.work.list(
       *   'env_011CZkZ9X2dpNyB7HsEFoRfW',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(environmentID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/environments/${environmentID}/work?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * Acknowledge receipt of a work item, transitioning it from 'queued' to 'starting'
       * and removing it from the queue.
       *
       * @example
       * ```ts
       * const betaSelfHostedWork =
       *   await client.beta.environments.work.ack('work_id', {
       *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   });
       * ```
       */
      ack(workID, params, options) {
        const { environment_id, betas } = params;
        return this._client.post(path`/v1/environments/${environment_id}/work/${workID}/ack?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * Record a heartbeat for a work item to maintain the lease.
       *
       * @example
       * ```ts
       * const betaSelfHostedWorkHeartbeatResponse =
       *   await client.beta.environments.work.heartbeat('work_id', {
       *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   });
       * ```
       */
      heartbeat(workID, params, options) {
        const { environment_id, desired_ttl_seconds, expected_last_heartbeat, betas } = params;
        return this._client.post(path`/v1/environments/${environment_id}/work/${workID}/heartbeat?beta=true`, {
          query: { desired_ttl_seconds, expected_last_heartbeat },
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * Long poll for work items in the queue.
       *
       * @example
       * ```ts
       * const betaSelfHostedWork =
       *   await client.beta.environments.work.poll(
       *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   );
       * ```
       */
      poll(environmentID, params = {}, options) {
        const { betas, "Anthropic-Worker-ID": anthropicWorkerID, ...query } = params ?? {};
        return this._client.get(path`/v1/environments/${environmentID}/work/poll?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString(),
              ...anthropicWorkerID != null ? { "Anthropic-Worker-ID": anthropicWorkerID } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * Get statistics about the work queue for an environment.
       *
       * @example
       * ```ts
       * const betaSelfHostedWorkQueueStats =
       *   await client.beta.environments.work.stats(
       *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   );
       * ```
       */
      stats(environmentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/environments/${environmentID}/work/stats?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Note: these endpoints are called automatically by the pre-built environment
       * worker provided in the SDKs and CLI, for orchestrating sessions with self-hosted
       * sandbox environments. They are included here as a reference; you do not need to
       * invoke them directly.
       *
       * Stop a work item, initiating graceful or forced shutdown.
       *
       * @example
       * ```ts
       * const betaSelfHostedWork =
       *   await client.beta.environments.work.stop('work_id', {
       *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   });
       * ```
       */
      stop(workID, params, options) {
        const { environment_id, betas, ...body } = params;
        return this._client.post(path`/v1/environments/${environment_id}/work/${workID}/stop?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Continuously claim work from a self-hosted environment, ack each item,
       * and yield it. Posts `stop` automatically when the consumer's loop body
       * returns or when iteration ends.
       *
       * @example
       * ```ts
       * for await (const work of client.beta.environments.work.poller({
       *   environmentId,
       *   environmentKey,
       * })) {
       *   if (work.data.type !== 'session') continue;
       *   // ...service the work...
       * }
       * ```
       */
      poller(opts) {
        return new WorkPoller({ ...opts, client: this._client });
      }
      /**
       * The self-hosted environment runner: poll for work, and for each claimed
       * session set up the workdir, download the agent's skills, run the tools while
       * heartbeating the lease, and force-stop on exit.
       *
       * @example
       * ```ts
       * // Long-running daemon — poll, serve each session, loop:
       * await client.beta.environments.work
       *   .worker({ environmentId, environmentKey, workdir: '/workspace' })
       *   .run();
       *
       * // Or service one already-claimed work item (e.g. inside a sandbox spawned
       * // by `ant worker poll --on-work`) — handleItem() reads the ANTHROPIC_* env vars:
       * await client.beta.environments.work.worker({ workdir: '/workspace' }).handleItem();
       * ```
       */
      worker(opts) {
        return new EnvironmentWorker({ ...opts, client: this._client });
      }
    };
    Work.WorkPoller = WorkPoller;
    Work.EnvironmentWorker = EnvironmentWorker;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/environments/environments.mjs
var Environments;
var init_environments = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/environments/environments.mjs"() {
    init_resource();
    init_work();
    init_work();
    init_pagination();
    init_headers();
    init_path();
    Environments = class extends APIResource {
      constructor() {
        super(...arguments);
        this.work = new Work(this._client);
      }
      /**
       * Create a new environment with the specified configuration.
       *
       * @example
       * ```ts
       * const betaEnvironment =
       *   await client.beta.environments.create({
       *     name: 'python-data-analysis',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/environments?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Retrieve a specific environment by ID.
       *
       * @example
       * ```ts
       * const betaEnvironment =
       *   await client.beta.environments.retrieve(
       *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   );
       * ```
       */
      retrieve(environmentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/environments/${environmentID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update an existing environment's configuration.
       *
       * @example
       * ```ts
       * const betaEnvironment =
       *   await client.beta.environments.update(
       *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   );
       * ```
       */
      update(environmentID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/environments/${environmentID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List environments with pagination support.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaEnvironment of client.beta.environments.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/environments?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete an environment by ID. Returns a confirmation of the deletion.
       *
       * @example
       * ```ts
       * const betaEnvironmentDeleteResponse =
       *   await client.beta.environments.delete(
       *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   );
       * ```
       */
      delete(environmentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/environments/${environmentID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive an environment by ID. Archived environments cannot be used to create new
       * sessions.
       *
       * @example
       * ```ts
       * const betaEnvironment =
       *   await client.beta.environments.archive(
       *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   );
       * ```
       */
      archive(environmentID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/environments/${environmentID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
    Environments.Work = Work;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memories.mjs
var Memories;
var init_memories = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memories.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Memories = class extends APIResource {
      /**
       * Create a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemory =
       *   await client.beta.memoryStores.memories.create(
       *     'memory_store_id',
       *     { content: 'content', path: 'xx' },
       *   );
       * ```
       */
      create(memoryStoreID, params, options) {
        const { view, betas, ...body } = params;
        return this._client.post(path`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, {
          query: { view },
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Retrieve a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemory =
       *   await client.beta.memoryStores.memories.retrieve(
       *     'memory_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      retrieve(memoryID, params, options) {
        const { memory_store_id, betas, ...query } = params;
        return this._client.get(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemory =
       *   await client.beta.memoryStores.memories.update(
       *     'memory_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      update(memoryID, params, options) {
        const { memory_store_id, view, betas, ...body } = params;
        return this._client.post(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
          query: { view },
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List memories
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsMemoryListItem of client.beta.memoryStores.memories.list(
       *   'memory_store_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(memoryStoreID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete a memory
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedMemory =
       *   await client.beta.memoryStores.memories.delete(
       *     'memory_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      delete(memoryID, params, options) {
        const { memory_store_id, expected_content_sha256, betas } = params;
        return this._client.delete(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
          query: { expected_content_sha256 },
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions.mjs
var MemoryVersions;
var init_memory_versions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    MemoryVersions = class extends APIResource {
      /**
       * Retrieve a memory version
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryVersion =
       *   await client.beta.memoryStores.memoryVersions.retrieve(
       *     'memory_version_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      retrieve(memoryVersionID, params, options) {
        const { memory_store_id, betas, ...query } = params;
        return this._client.get(path`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List memory versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsMemoryVersion of client.beta.memoryStores.memoryVersions.list(
       *   'memory_store_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(memoryStoreID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/memory_stores/${memoryStoreID}/memory_versions?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Redact a memory version
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryVersion =
       *   await client.beta.memoryStores.memoryVersions.redact(
       *     'memory_version_id',
       *     { memory_store_id: 'memory_store_id' },
       *   );
       * ```
       */
      redact(memoryVersionID, params, options) {
        const { memory_store_id, betas } = params;
        return this._client.post(path`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}/redact?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs
var MemoryStores;
var init_memory_stores = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs"() {
    init_resource();
    init_memories();
    init_memories();
    init_memory_versions();
    init_memory_versions();
    init_pagination();
    init_headers();
    init_path();
    MemoryStores = class extends APIResource {
      constructor() {
        super(...arguments);
        this.memories = new Memories(this._client);
        this.memoryVersions = new MemoryVersions(this._client);
      }
      /**
       * Create a memory store
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryStore =
       *   await client.beta.memoryStores.create({ name: 'x' });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/memory_stores?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Retrieve a memory store
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryStore =
       *   await client.beta.memoryStores.retrieve(
       *     'memory_store_id',
       *   );
       * ```
       */
      retrieve(memoryStoreID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update a memory store
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryStore =
       *   await client.beta.memoryStores.update('memory_store_id');
       * ```
       */
      update(memoryStoreID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List memory stores
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsMemoryStore of client.beta.memoryStores.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/memory_stores?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete a memory store
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedMemoryStore =
       *   await client.beta.memoryStores.delete('memory_store_id');
       * ```
       */
      delete(memoryStoreID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive a memory store
       *
       * @example
       * ```ts
       * const betaManagedAgentsMemoryStore =
       *   await client.beta.memoryStores.archive('memory_store_id');
       * ```
       */
      archive(memoryStoreID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/memory_stores/${memoryStoreID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "agent-memory-2026-07-22"].toString() },
            options?.headers
          ])
        });
      }
    };
    MemoryStores.Memories = Memories;
    MemoryStores.MemoryVersions = MemoryVersions;
  }
});

// node_modules/@anthropic-ai/sdk/error.mjs
var init_error2 = __esm({
  "node_modules/@anthropic-ai/sdk/error.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs
var JSONLDecoder;
var init_jsonl = __esm({
  "node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs"() {
    init_error();
    init_shims();
    init_line();
    JSONLDecoder = class _JSONLDecoder {
      constructor(iterator, controller) {
        this.iterator = iterator;
        this.controller = controller;
      }
      async *decoder() {
        const lineDecoder = new LineDecoder();
        for await (const chunk of this.iterator) {
          for (const line of lineDecoder.decode(chunk)) {
            yield JSON.parse(line);
          }
        }
        for (const line of lineDecoder.flush()) {
          yield JSON.parse(line);
        }
      }
      [Symbol.asyncIterator]() {
        return this.decoder();
      }
      static fromResponse(response, controller) {
        if (!response.body) {
          controller.abort();
          if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
            throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
          }
          throw new AnthropicError(`Attempted to iterate over a response with no body`);
        }
        return new _JSONLDecoder(ReadableStreamToAsyncIterable(response.body), controller);
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
var Batches;
var init_batches = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_jsonl();
    init_error2();
    init_path();
    Batches = class extends APIResource {
      /**
       * Send a batch of Message creation requests.
       *
       * The Message Batches API can be used to process multiple Messages API requests at
       * once. Once a Message Batch is created, it begins processing immediately. Batches
       * can take up to 24 hours to complete.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatch =
       *   await client.beta.messages.batches.create({
       *     requests: [
       *       {
       *         custom_id: 'my-custom-id-1',
       *         params: {
       *           max_tokens: 1024,
       *           messages: [
       *             { content: 'Hello, world', role: 'user' },
       *           ],
       *           model: 'claude-opus-4-6',
       *         },
       *       },
       *     ],
       *   });
       * ```
       */
      create(params, options) {
        const { betas, user_profile_id, ...body } = params;
        return this._client.post("/v1/messages/batches?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0
            },
            options?.headers
          ])
        });
      }
      /**
       * This endpoint is idempotent and can be used to poll for Message Batch
       * completion. To access the results of a Message Batch, make a request to the
       * `results_url` field in the response.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatch =
       *   await client.beta.messages.batches.retrieve(
       *     'message_batch_id',
       *   );
       * ```
       */
      retrieve(messageBatchID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List all Message Batches within a Workspace. Most recently created batches are
       * returned first.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaMessageBatch of client.beta.messages.batches.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/messages/batches?beta=true", Page, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete a Message Batch.
       *
       * Message Batches can only be deleted once they've finished processing. If you'd
       * like to delete an in-progress batch, you must first cancel it.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaDeletedMessageBatch =
       *   await client.beta.messages.batches.delete(
       *     'message_batch_id',
       *   );
       * ```
       */
      delete(messageBatchID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Batches may be canceled any time before processing ends. Once cancellation is
       * initiated, the batch enters a `canceling` state, at which time the system may
       * complete any in-progress, non-interruptible requests before finalizing
       * cancellation.
       *
       * The number of canceled requests is specified in `request_counts`. To determine
       * which requests were canceled, check the individual results within the batch.
       * Note that cancellation may not result in any canceled requests if they were
       * non-interruptible.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatch =
       *   await client.beta.messages.batches.cancel(
       *     'message_batch_id',
       *   );
       * ```
       */
      cancel(messageBatchID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Streams the results of a Message Batch as a `.jsonl` file.
       *
       * Each line in the file is a JSON object containing the result of a single request
       * in the Message Batch. Results are not guaranteed to be in the same order as
       * requests. Use the `custom_id` field to match results to requests.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const betaMessageBatchIndividualResponse =
       *   await client.beta.messages.batches.results(
       *     'message_batch_id',
       *   );
       * ```
       */
      async results(messageBatchID, params = {}, options) {
        const batch = await this.retrieve(messageBatchID);
        if (!batch.results_url) {
          throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
        }
        const { betas } = params ?? {};
        return this._client.get(batch.results_url, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
              Accept: "application/binary"
            },
            options?.headers
          ]),
          stream: true,
          __binaryResponse: true
        })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/internal/constants.mjs
var MODEL_NONSTREAMING_TOKENS;
var init_constants = __esm({
  "node_modules/@anthropic-ai/sdk/internal/constants.mjs"() {
    MODEL_NONSTREAMING_TOKENS = {
      "claude-opus-4@20250514": 8192,
      "anthropic.claude-opus-4-1-20250805-v1:0": 8192,
      "claude-opus-4-1@20250805": 8192
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs
function getOutputFormat(params) {
  return params?.output_format ?? params?.output_config?.format;
}
function maybeParseBetaMessage(message, params, opts) {
  const outputFormat = getOutputFormat(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return Object.defineProperty(parsedBlock, "parsed", {
            get() {
              opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
              return null;
            },
            enumerable: false
          });
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseBetaMessage(message, params, opts);
}
function parseBetaMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseBetaOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return Object.defineProperty(parsedBlock, "parsed", {
        get() {
          opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
          return parsedOutput;
        },
        enumerable: false
      });
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
function parseBetaOutputFormat(params, content) {
  const outputFormat = getOutputFormat(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}
var init_beta_parser = __esm({
  "node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/streaming.mjs
var init_streaming2 = __esm({
  "node_modules/@anthropic-ai/sdk/streaming.mjs"() {
    init_streaming();
  }
});

// node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs
var tokenize, strip, unstrip, generate, partialParse;
var init_parser = __esm({
  "node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs"() {
    tokenize = (input) => {
      let current = 0;
      let tokens = [];
      while (current < input.length) {
        let char = input[current];
        if (char === "\\") {
          current++;
          continue;
        }
        if (char === "{") {
          tokens.push({
            type: "brace",
            value: "{"
          });
          current++;
          continue;
        }
        if (char === "}") {
          tokens.push({
            type: "brace",
            value: "}"
          });
          current++;
          continue;
        }
        if (char === "[") {
          tokens.push({
            type: "paren",
            value: "["
          });
          current++;
          continue;
        }
        if (char === "]") {
          tokens.push({
            type: "paren",
            value: "]"
          });
          current++;
          continue;
        }
        if (char === ":") {
          tokens.push({
            type: "separator",
            value: ":"
          });
          current++;
          continue;
        }
        if (char === ",") {
          tokens.push({
            type: "delimiter",
            value: ","
          });
          current++;
          continue;
        }
        if (char === '"') {
          let value = "";
          let danglingQuote = false;
          char = input[++current];
          while (char !== '"') {
            if (current === input.length) {
              danglingQuote = true;
              break;
            }
            if (char === "\\") {
              current++;
              if (current === input.length) {
                danglingQuote = true;
                break;
              }
              value += char + input[current];
              char = input[++current];
            } else {
              value += char;
              char = input[++current];
            }
          }
          char = input[++current];
          if (!danglingQuote) {
            tokens.push({
              type: "string",
              value
            });
          }
          continue;
        }
        let WHITESPACE = /\s/;
        if (char && WHITESPACE.test(char)) {
          current++;
          continue;
        }
        let NUMBERS = /[0-9]/;
        if (char && NUMBERS.test(char) || char === "-" || char === ".") {
          let value = "";
          if (char === "-") {
            value += char;
            char = input[++current];
          }
          while (char && (NUMBERS.test(char) || char === "." || // exponent marker, e.g. `1e10` or `1.5E-9`
          char === "e" || char === "E" || // exponent sign, only valid immediately after the exponent marker
          (char === "-" || char === "+") && (value[value.length - 1] === "e" || value[value.length - 1] === "E"))) {
            value += char;
            char = input[++current];
          }
          tokens.push({
            type: "number",
            value
          });
          continue;
        }
        let LETTERS = /[a-z]/i;
        if (char && LETTERS.test(char)) {
          let value = "";
          while (char && LETTERS.test(char)) {
            if (current === input.length) {
              break;
            }
            value += char;
            char = input[++current];
          }
          if (value == "true" || value == "false" || value === "null") {
            tokens.push({
              type: "name",
              value
            });
          } else {
            current++;
            continue;
          }
          continue;
        }
        current++;
      }
      return tokens;
    };
    strip = (tokens) => {
      if (tokens.length === 0) {
        return tokens;
      }
      let lastToken = tokens[tokens.length - 1];
      switch (lastToken.type) {
        case "separator":
          tokens = tokens.slice(0, tokens.length - 1);
          return strip(tokens);
          break;
        case "number":
          let lastCharacterOfLastToken = lastToken.value[lastToken.value.length - 1];
          if (lastCharacterOfLastToken === "." || lastCharacterOfLastToken === "-" || lastCharacterOfLastToken === "+" || lastCharacterOfLastToken === "e" || lastCharacterOfLastToken === "E") {
            tokens = tokens.slice(0, tokens.length - 1);
            return strip(tokens);
          }
        case "string":
          let tokenBeforeTheLastToken = tokens[tokens.length - 2];
          if (tokenBeforeTheLastToken?.type === "delimiter") {
            tokens = tokens.slice(0, tokens.length - 1);
            return strip(tokens);
          } else if (tokenBeforeTheLastToken?.type === "brace" && tokenBeforeTheLastToken.value === "{") {
            tokens = tokens.slice(0, tokens.length - 1);
            return strip(tokens);
          }
          break;
        case "delimiter":
          tokens = tokens.slice(0, tokens.length - 1);
          return strip(tokens);
          break;
      }
      return tokens;
    };
    unstrip = (tokens) => {
      let tail = [];
      tokens.map((token) => {
        if (token.type === "brace") {
          if (token.value === "{") {
            tail.push("}");
          } else {
            tail.splice(tail.lastIndexOf("}"), 1);
          }
        }
        if (token.type === "paren") {
          if (token.value === "[") {
            tail.push("]");
          } else {
            tail.splice(tail.lastIndexOf("]"), 1);
          }
        }
      });
      if (tail.length > 0) {
        tail.reverse().map((item) => {
          if (item === "}") {
            tokens.push({
              type: "brace",
              value: "}"
            });
          } else if (item === "]") {
            tokens.push({
              type: "paren",
              value: "]"
            });
          }
        });
      }
      return tokens;
    };
    generate = (tokens) => {
      let output = "";
      tokens.map((token) => {
        switch (token.type) {
          case "string":
            output += '"' + token.value + '"';
            break;
          default:
            output += token.value;
            break;
        }
      });
      return output;
    };
    partialParse = (input) => JSON.parse(generate(unstrip(strip(tokenize(input)))));
  }
});

// node_modules/@anthropic-ai/sdk/internal/message-stream-utils.mjs
function withLazyInput(prev, jsonBuf) {
  const next = {};
  for (const key of Object.keys(prev)) {
    if (key !== "input")
      next[key] = prev[key];
  }
  Object.defineProperty(next, JSON_BUF_PROPERTY, { value: jsonBuf, enumerable: false, writable: true });
  let input;
  let parsed = false;
  Object.defineProperty(next, "input", {
    enumerable: true,
    configurable: true,
    get() {
      if (!parsed) {
        input = jsonBuf ? partialParse(jsonBuf) : {};
        parsed = true;
      }
      return input;
    }
  });
  return next;
}
var JSON_BUF_PROPERTY;
var init_message_stream_utils = __esm({
  "node_modules/@anthropic-ai/sdk/internal/message-stream-utils.mjs"() {
    init_parser();
    JSON_BUF_PROPERTY = "__json_buf";
  }
});

// node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
function tracksToolInput(content) {
  return content.type === "tool_use" || content.type === "server_tool_use" || content.type === "mcp_tool_use";
}
function checkNever(x) {
}
var _BetaMessageStream_instances, _BetaMessageStream_currentMessageSnapshot, _BetaMessageStream_params, _BetaMessageStream_connectedPromise, _BetaMessageStream_resolveConnectedPromise, _BetaMessageStream_rejectConnectedPromise, _BetaMessageStream_endPromise, _BetaMessageStream_resolveEndPromise, _BetaMessageStream_rejectEndPromise, _BetaMessageStream_listeners, _BetaMessageStream_ended, _BetaMessageStream_errored, _BetaMessageStream_aborted, _BetaMessageStream_catchingPromiseCreated, _BetaMessageStream_response, _BetaMessageStream_request_id, _BetaMessageStream_logger, _BetaMessageStream_getFinalMessage, _BetaMessageStream_getFinalText, _BetaMessageStream_handleError, _BetaMessageStream_beginRequest, _BetaMessageStream_addStreamEvent, _BetaMessageStream_endRequest, _BetaMessageStream_accumulateMessage, _BetaMessageStream_toolInputParseError, BetaMessageStream;
var init_BetaMessageStream = __esm({
  "node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs"() {
    init_tslib();
    init_stainless_helper_header();
    init_error2();
    init_errors();
    init_streaming2();
    init_beta_parser();
    init_message_stream_utils();
    BetaMessageStream = class _BetaMessageStream {
      constructor(params, opts) {
        _BetaMessageStream_instances.add(this);
        this.messages = [];
        this.receivedMessages = [];
        _BetaMessageStream_currentMessageSnapshot.set(this, void 0);
        _BetaMessageStream_params.set(this, null);
        this.controller = new AbortController();
        _BetaMessageStream_connectedPromise.set(this, void 0);
        _BetaMessageStream_resolveConnectedPromise.set(this, () => {
        });
        _BetaMessageStream_rejectConnectedPromise.set(this, () => {
        });
        _BetaMessageStream_endPromise.set(this, void 0);
        _BetaMessageStream_resolveEndPromise.set(this, () => {
        });
        _BetaMessageStream_rejectEndPromise.set(this, () => {
        });
        _BetaMessageStream_listeners.set(this, {});
        _BetaMessageStream_ended.set(this, false);
        _BetaMessageStream_errored.set(this, false);
        _BetaMessageStream_aborted.set(this, false);
        _BetaMessageStream_catchingPromiseCreated.set(this, false);
        _BetaMessageStream_response.set(this, void 0);
        _BetaMessageStream_request_id.set(this, void 0);
        _BetaMessageStream_logger.set(this, void 0);
        _BetaMessageStream_handleError.set(this, (error) => {
          __classPrivateFieldSet(this, _BetaMessageStream_errored, true, "f");
          if (isAbortError(error)) {
            error = new APIUserAbortError();
          }
          if (error instanceof APIUserAbortError) {
            __classPrivateFieldSet(this, _BetaMessageStream_aborted, true, "f");
            return this._emit("abort", error);
          }
          if (error instanceof AnthropicError) {
            return this._emit("error", error);
          }
          if (error instanceof Error) {
            const anthropicError = new AnthropicError(error.message);
            anthropicError.cause = error;
            return this._emit("error", anthropicError);
          }
          return this._emit("error", new AnthropicError(String(error)));
        });
        __classPrivateFieldSet(this, _BetaMessageStream_connectedPromise, new Promise((resolve5, reject) => {
          __classPrivateFieldSet(this, _BetaMessageStream_resolveConnectedPromise, resolve5, "f");
          __classPrivateFieldSet(this, _BetaMessageStream_rejectConnectedPromise, reject, "f");
        }), "f");
        __classPrivateFieldSet(this, _BetaMessageStream_endPromise, new Promise((resolve5, reject) => {
          __classPrivateFieldSet(this, _BetaMessageStream_resolveEndPromise, resolve5, "f");
          __classPrivateFieldSet(this, _BetaMessageStream_rejectEndPromise, reject, "f");
        }), "f");
        __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f").catch(() => {
        });
        __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f").catch(() => {
        });
        __classPrivateFieldSet(this, _BetaMessageStream_params, params, "f");
        __classPrivateFieldSet(this, _BetaMessageStream_logger, opts?.logger ?? console, "f");
      }
      get response() {
        return __classPrivateFieldGet(this, _BetaMessageStream_response, "f");
      }
      get request_id() {
        return __classPrivateFieldGet(this, _BetaMessageStream_request_id, "f");
      }
      /**
       * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
       * returned vie the `request-id` header which is useful for debugging requests and resporting
       * issues to Anthropic.
       *
       * This is the same as the `APIPromise.withResponse()` method.
       *
       * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
       * as no `Response` is available.
       */
      async withResponse() {
        __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
        const response = await __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f");
        if (!response) {
          throw new Error("Could not resolve a `Response` object");
        }
        return {
          data: this,
          response,
          request_id: response.headers.get("request-id")
        };
      }
      /**
       * Intended for use on the frontend, consuming a stream produced with
       * `.toReadableStream()` on the backend.
       *
       * Note that messages sent to the model do not appear in `.on('message')`
       * in this context.
       */
      static fromReadableStream(stream) {
        const runner = new _BetaMessageStream(null);
        runner._run(() => runner._fromReadableStream(stream));
        return runner;
      }
      static createMessage(messages, params, options, { logger } = {}) {
        const runner = new _BetaMessageStream(params, { logger });
        for (const message of params.messages) {
          runner._addMessageParam(message);
        }
        __classPrivateFieldSet(runner, _BetaMessageStream_params, { ...params, stream: true }, "f");
        runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, [STAINLESS_HELPER_METHOD_HEADER]: "stream" } }));
        return runner;
      }
      _run(executor) {
        executor().then(() => {
          this._emitFinal();
          this._emit("end");
        }, __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f"));
      }
      _addMessageParam(message) {
        this.messages.push(message);
      }
      _addMessage(message, emit = true) {
        this.receivedMessages.push(message);
        if (emit) {
          this._emit("message", message);
        }
      }
      async _createMessage(messages, params, options) {
        const signal = options?.signal;
        let abortHandler;
        if (signal) {
          if (signal.aborted)
            this.controller.abort();
          abortHandler = this.controller.abort.bind(this.controller);
          signal.addEventListener("abort", abortHandler);
        }
        try {
          __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
          const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
          this._connected(response);
          for await (const event of stream) {
            __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
          }
          if (stream.controller.signal?.aborted) {
            throw new APIUserAbortError();
          }
          __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
        } finally {
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
          }
        }
      }
      _connected(response) {
        if (this.ended)
          return;
        __classPrivateFieldSet(this, _BetaMessageStream_response, response, "f");
        __classPrivateFieldSet(this, _BetaMessageStream_request_id, response?.headers.get("request-id"), "f");
        __classPrivateFieldGet(this, _BetaMessageStream_resolveConnectedPromise, "f").call(this, response);
        this._emit("connect");
      }
      get ended() {
        return __classPrivateFieldGet(this, _BetaMessageStream_ended, "f");
      }
      get errored() {
        return __classPrivateFieldGet(this, _BetaMessageStream_errored, "f");
      }
      get aborted() {
        return __classPrivateFieldGet(this, _BetaMessageStream_aborted, "f");
      }
      abort() {
        this.controller.abort();
      }
      /**
       * Adds the listener function to the end of the listeners array for the event.
       * No checks are made to see if the listener has already been added. Multiple calls passing
       * the same combination of event and listener will result in the listener being added, and
       * called, multiple times.
       * @returns this MessageStream, so that calls can be chained
       */
      on(event, listener) {
        const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
        listeners.push({ listener });
        return this;
      }
      /**
       * Removes the specified listener from the listener array for the event.
       * off() will remove, at most, one instance of a listener from the listener array. If any single
       * listener has been added multiple times to the listener array for the specified event, then
       * off() must be called multiple times to remove each instance.
       * @returns this MessageStream, so that calls can be chained
       */
      off(event, listener) {
        const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
        if (!listeners)
          return this;
        const index = listeners.findIndex((l) => l.listener === listener);
        if (index >= 0)
          listeners.splice(index, 1);
        return this;
      }
      /**
       * Adds a one-time listener function for the event. The next time the event is triggered,
       * this listener is removed and then invoked.
       * @returns this MessageStream, so that calls can be chained
       */
      once(event, listener) {
        const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
        listeners.push({ listener, once: true });
        return this;
      }
      /**
       * This is similar to `.once()`, but returns a Promise that resolves the next time
       * the event is triggered, instead of calling a listener callback.
       * @returns a Promise that resolves the next time given event is triggered,
       * or rejects if an error is emitted.  (If you request the 'error' event,
       * returns a promise that resolves with the error).
       *
       * Example:
       *
       *   const message = await stream.emitted('message') // rejects if the stream errors
       */
      emitted(event) {
        return new Promise((resolve5, reject) => {
          __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
          if (event !== "error")
            this.once("error", reject);
          this.once(event, resolve5);
        });
      }
      async done() {
        __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
        await __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f");
      }
      get currentMessage() {
        return __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
      }
      /**
       * @returns a promise that resolves with the the final assistant Message response,
       * or rejects if an error occurred or the stream ended prematurely without producing a Message.
       * If structured outputs were used, this will be a ParsedMessage with a `parsed` field.
       */
      async finalMessage() {
        await this.done();
        return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this);
      }
      /**
       * @returns a promise that resolves with the the final assistant Message's text response, concatenated
       * together if there are more than one text blocks.
       * Rejects if an error occurred or the stream ended prematurely without producing a Message.
       */
      async finalText() {
        await this.done();
        return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalText).call(this);
      }
      _emit(event, ...args) {
        if (__classPrivateFieldGet(this, _BetaMessageStream_ended, "f"))
          return;
        if (event === "end") {
          __classPrivateFieldSet(this, _BetaMessageStream_ended, true, "f");
          __classPrivateFieldGet(this, _BetaMessageStream_resolveEndPromise, "f").call(this);
        }
        const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
        if (listeners) {
          __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
          listeners.forEach(({ listener }) => listener(...args));
        }
        if (event === "abort") {
          const error = args[0];
          if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
            Promise.reject(error);
          }
          __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
          __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
          this._emit("end");
          return;
        }
        if (event === "error") {
          const error = args[0];
          if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
            Promise.reject(error);
          }
          __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
          __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
          this._emit("end");
        }
      }
      _emitFinal() {
        const finalMessage = this.receivedMessages.at(-1);
        if (finalMessage) {
          this._emit("finalMessage", __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this));
        }
      }
      async _fromReadableStream(readableStream, options) {
        const signal = options?.signal;
        let abortHandler;
        if (signal) {
          if (signal.aborted)
            this.controller.abort();
          abortHandler = this.controller.abort.bind(this.controller);
          signal.addEventListener("abort", abortHandler);
        }
        try {
          __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
          this._connected(null);
          const stream = Stream.fromReadableStream(readableStream, this.controller);
          for await (const event of stream) {
            __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
          }
          if (stream.controller.signal?.aborted) {
            throw new APIUserAbortError();
          }
          __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
        } finally {
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
          }
        }
      }
      [(_BetaMessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_params = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_listeners = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_ended = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_errored = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_aborted = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_response = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_request_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_logger = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_handleError = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_instances = /* @__PURE__ */ new WeakSet(), _BetaMessageStream_getFinalMessage = function _BetaMessageStream_getFinalMessage2() {
        if (this.receivedMessages.length === 0) {
          throw new AnthropicError("stream ended without producing a Message with role=assistant");
        }
        return this.receivedMessages.at(-1);
      }, _BetaMessageStream_getFinalText = function _BetaMessageStream_getFinalText2() {
        if (this.receivedMessages.length === 0) {
          throw new AnthropicError("stream ended without producing a Message with role=assistant");
        }
        const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
        if (textBlocks.length === 0) {
          throw new AnthropicError("stream ended without producing a content block with type=text");
        }
        return textBlocks.join(" ");
      }, _BetaMessageStream_beginRequest = function _BetaMessageStream_beginRequest2() {
        if (this.ended)
          return;
        __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
      }, _BetaMessageStream_addStreamEvent = function _BetaMessageStream_addStreamEvent2(event) {
        if (this.ended)
          return;
        const messageSnapshot = __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_accumulateMessage).call(this, event);
        this._emit("streamEvent", event, messageSnapshot);
        switch (event.type) {
          case "content_block_delta": {
            const content = messageSnapshot.content.at(-1);
            switch (event.delta.type) {
              case "text_delta": {
                if (content.type === "text") {
                  this._emit("text", event.delta.text, content.text || "");
                }
                break;
              }
              case "citations_delta": {
                if (content.type === "text") {
                  this._emit("citation", event.delta.citation, content.citations ?? []);
                }
                break;
              }
              case "input_json_delta": {
                if (tracksToolInput(content) && __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f").inputJson?.length) {
                  let jsonSnapshot;
                  try {
                    jsonSnapshot = content.input;
                  } catch (err2) {
                    __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_toolInputParseError).call(this, content, err2));
                    break;
                  }
                  this._emit("inputJson", event.delta.partial_json, jsonSnapshot);
                }
                break;
              }
              case "thinking_delta": {
                if (content.type === "thinking") {
                  this._emit("thinking", event.delta.thinking, content.thinking);
                }
                break;
              }
              case "signature_delta": {
                if (content.type === "thinking") {
                  this._emit("signature", content.signature);
                }
                break;
              }
              case "compaction_delta": {
                if (content.type === "compaction" && content.content) {
                  this._emit("compaction", content.content);
                }
                break;
              }
              default:
                checkNever(event.delta);
            }
            break;
          }
          case "message_stop": {
            this._addMessageParam(messageSnapshot);
            this._addMessage(maybeParseBetaMessage(messageSnapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") }), true);
            break;
          }
          case "content_block_stop": {
            this._emit("contentBlock", messageSnapshot.content.at(-1));
            break;
          }
          case "message_start": {
            __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, messageSnapshot, "f");
            break;
          }
          case "content_block_start":
          case "message_delta":
            break;
        }
      }, _BetaMessageStream_endRequest = function _BetaMessageStream_endRequest2() {
        if (this.ended) {
          throw new AnthropicError(`stream has ended, this shouldn't happen`);
        }
        const snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
        if (!snapshot) {
          throw new AnthropicError(`request ended without sending any chunks`);
        }
        __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
        return maybeParseBetaMessage(snapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") });
      }, _BetaMessageStream_accumulateMessage = function _BetaMessageStream_accumulateMessage2(event) {
        let snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
        if (event.type === "message_start") {
          if (snapshot) {
            throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
          }
          return event.message;
        }
        if (!snapshot) {
          throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
        }
        switch (event.type) {
          case "message_stop":
            return snapshot;
          case "message_delta":
            snapshot.stop_reason = event.delta.stop_reason;
            snapshot.stop_sequence = event.delta.stop_sequence;
            snapshot.stop_details = event.delta.stop_details;
            snapshot.usage.output_tokens = event.usage.output_tokens;
            if (event.delta.container != null) {
              snapshot.container = event.delta.container;
            }
            if (event.context_management != null) {
              snapshot.context_management = event.context_management;
            }
            if (event.usage.input_tokens != null) {
              snapshot.usage.input_tokens = event.usage.input_tokens;
            }
            if (event.usage.cache_creation_input_tokens != null) {
              snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
            }
            if (event.usage.cache_read_input_tokens != null) {
              snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
            }
            if (event.usage.server_tool_use != null) {
              snapshot.usage.server_tool_use = event.usage.server_tool_use;
            }
            if (event.usage.iterations != null) {
              snapshot.usage.iterations = event.usage.iterations;
            }
            if (event.usage.fallback_credit != null) {
              snapshot.usage.fallback_credit = event.usage.fallback_credit;
            }
            if (event.usage.output_tokens_details != null) {
              snapshot.usage.output_tokens_details = event.usage.output_tokens_details;
            }
            return snapshot;
          case "content_block_start":
            snapshot.content.push(event.content_block);
            if (event.content_block.type === "fallback") {
              snapshot.model = event.content_block.to.model;
            }
            return snapshot;
          case "content_block_delta": {
            const snapshotContent = snapshot.content.at(event.index);
            switch (event.delta.type) {
              case "text_delta": {
                if (snapshotContent?.type === "text") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    text: (snapshotContent.text || "") + event.delta.text
                  };
                }
                break;
              }
              case "citations_delta": {
                if (snapshotContent?.type === "text") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    citations: [...snapshotContent.citations ?? [], event.delta.citation]
                  };
                }
                break;
              }
              case "input_json_delta": {
                if (snapshotContent && tracksToolInput(snapshotContent)) {
                  const jsonBuf = (snapshotContent[JSON_BUF_PROPERTY] || "") + event.delta.partial_json;
                  snapshot.content[event.index] = withLazyInput(snapshotContent, jsonBuf);
                }
                break;
              }
              case "thinking_delta": {
                if (snapshotContent?.type === "thinking") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    thinking: snapshotContent.thinking + event.delta.thinking
                  };
                }
                break;
              }
              case "signature_delta": {
                if (snapshotContent?.type === "thinking") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    signature: event.delta.signature
                  };
                }
                break;
              }
              case "compaction_delta": {
                if (snapshotContent?.type === "compaction") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    content: (snapshotContent.content || "") + event.delta.content,
                    encrypted_content: event.delta.encrypted_content
                  };
                }
                break;
              }
              default:
                checkNever(event.delta);
            }
            return snapshot;
          }
          case "content_block_stop": {
            const snapshotContent = snapshot.content.at(event.index);
            if (snapshotContent && tracksToolInput(snapshotContent) && JSON_BUF_PROPERTY in snapshotContent) {
              let input;
              try {
                input = snapshotContent.input;
              } catch (err2) {
                input = {};
                __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_toolInputParseError).call(this, snapshotContent, err2));
              }
              Object.defineProperty(snapshotContent, "input", {
                value: input,
                enumerable: true,
                configurable: true,
                writable: true
              });
            }
            return snapshot;
          }
        }
      }, _BetaMessageStream_toolInputParseError = function _BetaMessageStream_toolInputParseError2(block, err2) {
        const jsonBuf = block[JSON_BUF_PROPERTY];
        return new AnthropicError(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${err2}. JSON: ${jsonBuf}`);
      }, Symbol.asyncIterator)]() {
        const pushQueue = [];
        const readQueue = [];
        let done = false;
        this.on("streamEvent", (event) => {
          const reader = readQueue.shift();
          if (reader) {
            reader.resolve(event);
          } else {
            pushQueue.push(event);
          }
        });
        this.on("end", () => {
          done = true;
          for (const reader of readQueue) {
            reader.resolve(void 0);
          }
          readQueue.length = 0;
        });
        this.on("abort", (err2) => {
          done = true;
          for (const reader of readQueue) {
            reader.reject(err2);
          }
          readQueue.length = 0;
        });
        this.on("error", (err2) => {
          done = true;
          for (const reader of readQueue) {
            reader.reject(err2);
          }
          readQueue.length = 0;
        });
        return {
          next: async () => {
            if (!pushQueue.length) {
              if (done) {
                return { value: void 0, done: true };
              }
              return new Promise((resolve5, reject) => readQueue.push({ resolve: resolve5, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
            }
            const chunk = pushQueue.shift();
            return { value: chunk, done: false };
          },
          return: async () => {
            this.abort();
            return { value: void 0, done: true };
          }
        };
      }
      toReadableStream() {
        const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
        return stream.toReadableStream();
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/CompactionControl.mjs
var DEFAULT_TOKEN_THRESHOLD, DEFAULT_SUMMARY_PROMPT;
var init_CompactionControl = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/CompactionControl.mjs"() {
    DEFAULT_TOKEN_THRESHOLD = 1e5;
    DEFAULT_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete\u2014err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;
  }
});

// node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs
async function generateToolResponse(params, lastMessage = params.messages.at(-1), requestOptions) {
  if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.content || typeof lastMessage.content === "string") {
    return null;
  }
  const toolUseBlocks = lastMessage.content.filter((content) => content.type === "tool_use");
  if (toolUseBlocks.length === 0) {
    return null;
  }
  const available = availableToolNames(params);
  const toolResults = await Promise.all(toolUseBlocks.map(async (toolUse) => {
    const tool = params.tools.find((t) => ("name" in t ? t.name : t.mcp_server_name) === toolUse.name);
    if (!tool || !("run" in tool) || !available.has(toolUse.name)) {
      return toolNotFoundResult(toolUse);
    }
    try {
      let input = toolUse.input;
      if ("parse" in tool && tool.parse) {
        input = tool.parse(input);
      }
      const result = await tool.run(input, {
        toolUse,
        toolUseBlock: toolUse,
        signal: requestOptions?.signal
      });
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      };
    } catch (error) {
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: error instanceof ToolError ? error.content : `Error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
    }
  }));
  return {
    role: "user",
    content: toolResults
  };
}
function toolNotFoundResult(toolUse) {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: `Error: Tool '${toolUse.name}' not found`,
    is_error: true
  };
}
function availableToolNames(params) {
  const available = /* @__PURE__ */ new Set();
  for (const tool of params.tools) {
    if ("run" in tool) {
      available.add(tool.name);
    }
  }
  for (const message of params.messages) {
    if (message.role !== "system" || typeof message.content === "string") {
      continue;
    }
    for (const block of message.content) {
      applyToolChange(block, available);
    }
  }
  return available;
}
function applyToolChange(block, available) {
  switch (block.type) {
    case "tool_removal":
    case "tool_addition":
      applyToolReference(block, available);
      break;
    case "mid_conv_system":
      for (const inner of block.content) {
        if (inner.type === "tool_removal" || inner.type === "tool_addition") {
          applyToolReference(inner, available);
        }
      }
      break;
    default:
      break;
  }
}
function applyToolReference(block, available) {
  const name = referencedToolName(block.tool);
  if (name === void 0)
    return;
  if (block.type === "tool_removal") {
    available.delete(name);
  } else {
    available.add(name);
  }
}
function referencedToolName(ref) {
  switch (ref.type) {
    case "tool_reference":
      return ref.name;
    default:
      return void 0;
  }
}
var _BetaToolRunner_instances, _BetaToolRunner_consumed, _BetaToolRunner_mutated, _BetaToolRunner_state, _BetaToolRunner_options, _BetaToolRunner_message, _BetaToolRunner_toolResponse, _BetaToolRunner_completion, _BetaToolRunner_iterationCount, _BetaToolRunner_checkAndCompact, _BetaToolRunner_generateToolResponse, BetaToolRunner;
var init_BetaToolRunner = __esm({
  "node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs"() {
    init_tslib();
    init_ToolError();
    init_error();
    init_headers();
    init_promise();
    init_CompactionControl();
    init_stainless_helper_header();
    BetaToolRunner = class {
      constructor(client, params, options) {
        _BetaToolRunner_instances.add(this);
        this.client = client;
        _BetaToolRunner_consumed.set(this, false);
        _BetaToolRunner_mutated.set(this, false);
        _BetaToolRunner_state.set(this, void 0);
        _BetaToolRunner_options.set(this, void 0);
        _BetaToolRunner_message.set(this, void 0);
        _BetaToolRunner_toolResponse.set(this, void 0);
        _BetaToolRunner_completion.set(this, void 0);
        _BetaToolRunner_iterationCount.set(this, 0);
        __classPrivateFieldSet(this, _BetaToolRunner_state, {
          params: {
            // You can't clone the entire params since there are functions as handlers.
            // You also don't really need to clone params.messages, but it probably will prevent a foot gun
            // somewhere.
            ...params,
            messages: structuredClone(params.messages)
          }
        }, "f");
        const collected = collectStainlessHelpers(params.tools, params.messages);
        __classPrivateFieldSet(this, _BetaToolRunner_options, {
          ...options,
          headers: buildHeaders([
            helperHeader("BetaToolRunner"),
            collected.length ? { [STAINLESS_HELPER_HEADER]: collected.join(", ") } : void 0,
            options?.headers
          ])
        }, "f");
        __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
        if (params.compactionControl?.enabled) {
          console.warn('Anthropic: The `compactionControl` parameter is deprecated and will be removed in a future version. Use server-side compaction instead by passing `edits: [{ type: "compact_20260112" }]` in the params passed to `toolRunner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction');
        }
      }
      async *[(_BetaToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_mutated = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_state = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_options = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_message = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_toolResponse = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_completion = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_iterationCount = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_instances = /* @__PURE__ */ new WeakSet(), _BetaToolRunner_checkAndCompact = async function _BetaToolRunner_checkAndCompact2() {
        const compactionControl = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.compactionControl;
        if (!compactionControl || !compactionControl.enabled) {
          return false;
        }
        let tokensUsed = 0;
        if (__classPrivateFieldGet(this, _BetaToolRunner_message, "f") !== void 0) {
          try {
            const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
            const totalInputTokens = message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0);
            tokensUsed = totalInputTokens + message.usage.output_tokens;
          } catch {
            return false;
          }
        }
        const threshold = compactionControl.contextTokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
        if (tokensUsed < threshold) {
          return false;
        }
        const model = compactionControl.model ?? __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.model;
        const summaryPrompt = compactionControl.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
        const messages = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages;
        if (messages[messages.length - 1].role === "assistant") {
          const lastMessage = messages[messages.length - 1];
          if (Array.isArray(lastMessage.content)) {
            const nonToolBlocks = lastMessage.content.filter((block) => block.type !== "tool_use");
            if (nonToolBlocks.length === 0) {
              messages.pop();
            } else {
              lastMessage.content = nonToolBlocks;
            }
          }
        }
        const response = await this.client.beta.messages.create({
          model,
          messages: [
            ...messages,
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: summaryPrompt
                }
              ]
            }
          ],
          max_tokens: __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_tokens
        }, {
          signal: __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal,
          headers: buildHeaders([__classPrivateFieldGet(this, _BetaToolRunner_options, "f").headers, helperHeader("compaction")])
        });
        if (response.content[0]?.type !== "text") {
          throw new AnthropicError("Expected text response for compaction");
        }
        __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages = [
          {
            role: "user",
            content: response.content
          }
        ];
        return true;
      }, Symbol.asyncIterator)]() {
        var _a2;
        if (__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
          throw new AnthropicError("Cannot iterate over a consumed stream");
        }
        __classPrivateFieldSet(this, _BetaToolRunner_consumed, true, "f");
        __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
        __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
        try {
          while (true) {
            let stream;
            try {
              if (__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations && __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f") >= __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations) {
                break;
              }
              __classPrivateFieldSet(this, _BetaToolRunner_mutated, false, "f");
              __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
              __classPrivateFieldSet(this, _BetaToolRunner_iterationCount, (_a2 = __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f"), _a2++, _a2), "f");
              __classPrivateFieldSet(this, _BetaToolRunner_message, void 0, "f");
              const { max_iterations, compactionControl, ...params } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
              if (params.stream) {
                stream = this.client.beta.messages.stream({ ...params }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f"));
                __classPrivateFieldSet(this, _BetaToolRunner_message, stream.finalMessage(), "f");
                __classPrivateFieldGet(this, _BetaToolRunner_message, "f").catch(() => {
                });
                yield stream;
              } else {
                __classPrivateFieldSet(this, _BetaToolRunner_message, this.client.beta.messages.create({ ...params, stream: false }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
                yield __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
              }
              const isCompacted = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_checkAndCompact).call(this);
              if (!isCompacted) {
                if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
                  const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
                  __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push({ role: message.role, content: message.content });
                  const { container } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
                  if (message.container) {
                    if (container == null) {
                      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.container = message.container.id;
                    } else if (typeof container === "object" && container.id == null) {
                      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.container = { ...container, id: message.container.id };
                    }
                  }
                  if (message.stop_reason === "refusal") {
                    break;
                  }
                }
                const toolMessage = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.at(-1));
                if (toolMessage) {
                  __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push(toolMessage);
                } else if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
                  break;
                }
              }
            } finally {
              if (stream) {
                stream.abort();
              }
            }
          }
          if (!__classPrivateFieldGet(this, _BetaToolRunner_message, "f")) {
            throw new AnthropicError("ToolRunner concluded without a message from the server");
          }
          __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").resolve(await __classPrivateFieldGet(this, _BetaToolRunner_message, "f"));
        } catch (error) {
          __classPrivateFieldSet(this, _BetaToolRunner_consumed, false, "f");
          __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise.catch(() => {
          });
          __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").reject(error);
          __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
          throw error;
        }
      }
      setMessagesParams(paramsOrMutator) {
        if (typeof paramsOrMutator === "function") {
          __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params);
        } else {
          __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator;
        }
        __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
        __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
      }
      setRequestOptions(optionsOrMutator) {
        if (typeof optionsOrMutator === "function") {
          __classPrivateFieldSet(this, _BetaToolRunner_options, optionsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
        } else {
          __classPrivateFieldSet(this, _BetaToolRunner_options, { ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"), ...optionsOrMutator }, "f");
        }
      }
      /**
       * Get the tool response for the last message from the assistant.
       * Avoids redundant tool executions by caching results.
       *
       * @returns A promise that resolves to a BetaMessageParam containing tool results, or null if no tools need to be executed
       *
       * @example
       * const toolResponse = await runner.generateToolResponse();
       * if (toolResponse) {
       *   console.log('Tool results:', toolResponse.content);
       * }
       */
      async generateToolResponse(signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
        const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f") ?? this.params.messages.at(-1);
        if (!message) {
          return null;
        }
        return __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, message, signal);
      }
      /**
       * Wait for the async iterator to complete. This works even if the async iterator hasn't yet started, and
       * will wait for an instance to start and go to completion.
       *
       * @returns A promise that resolves to the final BetaMessage when the iterator completes
       *
       * @example
       * // Start consuming the iterator
       * for await (const message of runner) {
       *   console.log('Message:', message.content);
       * }
       *
       * // Meanwhile, wait for completion from another part of the code
       * const finalMessage = await runner.done();
       * console.log('Final response:', finalMessage.content);
       */
      done() {
        return __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise;
      }
      /**
       * Returns a promise indicating that the stream is done. Unlike .done(), this will eagerly read the stream:
       * * If the iterator has not been consumed, consume the entire iterator and return the final message from the
       * assistant.
       * * If the iterator has been consumed, waits for it to complete and returns the final message.
       *
       * @returns A promise that resolves to the final BetaMessage from the conversation
       * @throws {AnthropicError} If no messages were processed during the conversation
       *
       * @example
       * const finalMessage = await runner.runUntilDone();
       * console.log('Final response:', finalMessage.content);
       */
      async runUntilDone() {
        if (!__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
          for await (const _ of this) {
          }
        }
        return this.done();
      }
      /**
       * Get the current parameters being used by the ToolRunner.
       *
       * @returns A readonly view of the current ToolRunnerParams
       *
       * @example
       * const currentParams = runner.params;
       * console.log('Current model:', currentParams.model);
       * console.log('Message count:', currentParams.messages.length);
       */
      get params() {
        return __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
      }
      /**
       * Add one or more messages to the conversation history.
       *
       * @param messages - One or more BetaMessageParam objects to add to the conversation
       *
       * @example
       * runner.pushMessages(
       *   { role: 'user', content: 'Also, what about the weather in NYC?' }
       * );
       *
       * @example
       * // Adding multiple messages
       * runner.pushMessages(
       *   { role: 'user', content: 'What about NYC?' },
       *   { role: 'user', content: 'And Boston?' }
       * );
       */
      pushMessages(...messages) {
        this.setMessagesParams((params) => ({
          ...params,
          messages: [...params.messages, ...messages]
        }));
      }
      /**
       * Makes the ToolRunner directly awaitable, equivalent to calling .runUntilDone()
       * This allows using `await runner` instead of `await runner.runUntilDone()`
       */
      then(onfulfilled, onrejected) {
        return this.runUntilDone().then(onfulfilled, onrejected);
      }
    };
    _BetaToolRunner_generateToolResponse = async function _BetaToolRunner_generateToolResponse2(lastMessage, signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
      if (__classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f") !== void 0) {
        return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
      }
      __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, generateToolResponse(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params, lastMessage, {
        ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"),
        signal
      }), "f");
      return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
function transformOutputFormat(params) {
  if (!params.output_format) {
    return params;
  }
  if (params.output_config?.format) {
    throw new AnthropicError("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
  }
  const { output_format, ...rest } = params;
  return {
    ...rest,
    output_config: {
      ...params.output_config,
      format: output_format
    }
  };
}
var DEPRECATED_MODELS, MODELS_TO_WARN_WITH_THINKING_ENABLED, Messages;
var init_messages = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs"() {
    init_error2();
    init_batches();
    init_resource();
    init_constants();
    init_headers();
    init_stainless_helper_header();
    init_beta_parser();
    init_BetaMessageStream();
    init_BetaToolRunner();
    init_ToolError();
    init_batches();
    init_BetaToolRunner();
    init_ToolError();
    DEPRECATED_MODELS = {};
    MODELS_TO_WARN_WITH_THINKING_ENABLED = ["claude-mythos-preview", "claude-opus-4-6"];
    Messages = class extends APIResource {
      constructor() {
        super(...arguments);
        this.batches = new Batches(this._client);
      }
      create(params, options) {
        const modifiedParams = transformOutputFormat(params);
        const { betas, user_profile_id, ...body } = modifiedParams;
        if (body.model in DEPRECATED_MODELS) {
          console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
        }
        if (MODELS_TO_WARN_WITH_THINKING_ENABLED.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
          console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
        }
        let timeout = options?.timeout ?? this._client._options.timeout;
        if (!body.stream && timeout == null) {
          const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
          timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
        }
        const helperHeader2 = stainlessHelperHeader(body.tools, body.messages);
        return this._client.post("/v1/messages?beta=true", {
          body,
          timeout: timeout ?? 6e5,
          ...options,
          headers: buildHeaders([
            {
              ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0,
              ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0
            },
            helperHeader2,
            options?.headers
          ]),
          stream: modifiedParams.stream ?? false
        });
      }
      /**
       * Send a structured list of input messages with text and/or image content, along with an expected `output_format` and
       * the response will be automatically parsed and available in the `parsed_output` property of the message.
       *
       * @example
       * ```ts
       * const message = await client.beta.messages.parse({
       *   model: 'claude-3-5-sonnet-20241022',
       *   max_tokens: 1024,
       *   messages: [{ role: 'user', content: 'What is 2+2?' }],
       *   output_format: zodOutputFormat(z.object({ answer: z.number() }), 'math'),
       * });
       *
       * console.log(message.parsed_output?.answer); // 4
       * ```
       */
      parse(params, options) {
        options = {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...params.betas ?? [], "structured-outputs-2025-12-15"].toString() },
            options?.headers
          ])
        };
        return this.create(params, options).then((message) => parseBetaMessage(message, params, { logger: this._client.logger ?? console }));
      }
      /**
       * Create a Message stream
       */
      stream(body, options) {
        return BetaMessageStream.createMessage(this, body, options);
      }
      /**
       * Count the number of tokens in a Message.
       *
       * The Token Count API can be used to count the number of tokens in a Message,
       * including tools, images, and documents, without creating it.
       *
       * Learn more about token counting in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/token-counting)
       *
       * @example
       * ```ts
       * const betaMessageTokensCount =
       *   await client.beta.messages.countTokens({
       *     messages: [{ content: 'Hello, world', role: 'user' }],
       *     model: 'claude-opus-4-6',
       *   });
       * ```
       */
      countTokens(params, options) {
        const modifiedParams = transformOutputFormat(params);
        const { betas, user_profile_id, ...body } = modifiedParams;
        return this._client.post("/v1/messages/count_tokens?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "token-counting-2024-11-01"].toString(),
              ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0
            },
            options?.headers
          ])
        });
      }
      toolRunner(body, options) {
        return new BetaToolRunner(this._client, body, options);
      }
    };
    Messages.Batches = Batches;
    Messages.BetaToolRunner = BetaToolRunner;
    Messages.ToolError = ToolError;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs
var Events;
var init_events = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    init_SessionToolRunner();
    init_SessionToolRunner();
    Events = class extends APIResource {
      /**
       * List Events
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSessionEvent of client.beta.sessions.events.list(
       *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(sessionID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/sessions/${sessionID}/events?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Send Events
       *
       * @example
       * ```ts
       * const betaManagedAgentsSendSessionEvents =
       *   await client.beta.sessions.events.send(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *     {
       *       events: [
       *         {
       *           content: [
       *             {
       *               text: 'Where is my order #1234?',
       *               type: 'text',
       *             },
       *           ],
       *           type: 'user.message',
       *         },
       *       ],
       *     },
       *   );
       * ```
       */
      send(sessionID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/sessions/${sessionID}/events?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Stream Events
       *
       * @example
       * ```ts
       * const betaManagedAgentsStreamSessionEvents =
       *   await client.beta.sessions.events.stream(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *   );
       * ```
       */
      stream(sessionID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.get(path`/v1/sessions/${sessionID}/events/stream?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ]),
          stream: true
        });
      }
      /**
       * Attach to a session and dispatch every incoming `agent.tool_use` and
       * `agent.custom_tool_use` event to a local tool registry, sending the matching
       * result back (`user.tool_result` / `user.custom_tool_result`). The
       * sessions-side counterpart to `client.beta.messages.toolRunner`: yields one
       * entry per completed tool call so callers can observe each dispatch (and
       * `break` to abort cleanly).
       *
       * @example
       * ```ts
       * import { betaAgentToolset20260401 } from '@anthropic-ai/sdk/tools/agent-toolset/node';
       *
       * for await (const call of client.beta.sessions.events.toolRunner(work.data.id, {
       *   tools: [...betaAgentToolset20260401({ workdir }), myTool],
       * })) {
       *   console.log(`${call.name} -> ${call.isError ? 'error' : 'ok'}`);
       * }
       * ```
       */
      toolRunner(sessionID, opts) {
        return new SessionToolRunner(sessionID, { ...opts, client: this._client });
      }
    };
    Events.SessionToolRunner = SessionToolRunner;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs
var Resources;
var init_resources = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Resources = class extends APIResource {
      /**
       * Get Session Resource
       *
       * @example
       * ```ts
       * const resource =
       *   await client.beta.sessions.resources.retrieve(
       *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      retrieve(resourceID, params, options) {
        const { session_id, betas } = params;
        return this._client.get(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update Session Resource
       *
       * @example
       * ```ts
       * const resource =
       *   await client.beta.sessions.resources.update(
       *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
       *     {
       *       session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *       authorization_token: 'ghp_exampletoken',
       *     },
       *   );
       * ```
       */
      update(resourceID, params, options) {
        const { session_id, betas, ...body } = params;
        return this._client.post(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Session Resources
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSessionResource of client.beta.sessions.resources.list(
       *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(sessionID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/sessions/${sessionID}/resources?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete Session Resource
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeleteSessionResource =
       *   await client.beta.sessions.resources.delete(
       *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      delete(resourceID, params, options) {
        const { session_id, betas } = params;
        return this._client.delete(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Add Session Resource
       *
       * @example
       * ```ts
       * const betaManagedAgentsFileResource =
       *   await client.beta.sessions.resources.add(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *     {
       *       file_id: 'file_011CNha8iCJcU1wXNR6q4V8w',
       *       type: 'file',
       *     },
       *   );
       * ```
       */
      add(sessionID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/sessions/${sessionID}/resources?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/events.mjs
var Events2;
var init_events2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/events.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Events2 = class extends APIResource {
      /**
       * List Session Thread Events
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSessionEvent of client.beta.sessions.threads.events.list(
       *   'sthr_011CZkZVWa6oIjw0rgXZpnBt',
       *   { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       * )) {
       *   // ...
       * }
       * ```
       */
      list(threadID, params, options) {
        const { session_id, betas, ...query } = params;
        return this._client.getAPIList(path`/v1/sessions/${session_id}/threads/${threadID}/events?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Stream Session Thread Events
       *
       * @example
       * ```ts
       * const betaManagedAgentsStreamSessionThreadEvents =
       *   await client.beta.sessions.threads.events.stream(
       *     'sthr_011CZkZVWa6oIjw0rgXZpnBt',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      stream(threadID, params, options) {
        const { session_id, betas, ...query } = params;
        return this._client.get(path`/v1/sessions/${session_id}/threads/${threadID}/stream?beta=true`, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ]),
          stream: true
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/threads.mjs
var Threads;
var init_threads = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/threads/threads.mjs"() {
    init_resource();
    init_events2();
    init_events2();
    init_pagination();
    init_headers();
    init_path();
    Threads = class extends APIResource {
      constructor() {
        super(...arguments);
        this.events = new Events2(this._client);
      }
      /**
       * Get Session Thread
       *
       * @example
       * ```ts
       * const betaManagedAgentsSessionThread =
       *   await client.beta.sessions.threads.retrieve(
       *     'sthr_011CZkZVWa6oIjw0rgXZpnBt',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      retrieve(threadID, params, options) {
        const { session_id, betas } = params;
        return this._client.get(path`/v1/sessions/${session_id}/threads/${threadID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Session Threads
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSessionThread of client.beta.sessions.threads.list(
       *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(sessionID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/sessions/${sessionID}/threads?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive Session Thread
       *
       * @example
       * ```ts
       * const betaManagedAgentsSessionThread =
       *   await client.beta.sessions.threads.archive(
       *     'sthr_011CZkZVWa6oIjw0rgXZpnBt',
       *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
       *   );
       * ```
       */
      archive(threadID, params, options) {
        const { session_id, betas } = params;
        return this._client.post(path`/v1/sessions/${session_id}/threads/${threadID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
    Threads.Events = Events2;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs
var Sessions;
var init_sessions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs"() {
    init_resource();
    init_events();
    init_events();
    init_resources();
    init_resources();
    init_threads();
    init_threads();
    init_pagination();
    init_headers();
    init_path();
    Sessions = class extends APIResource {
      constructor() {
        super(...arguments);
        this.events = new Events(this._client);
        this.resources = new Resources(this._client);
        this.threads = new Threads(this._client);
      }
      /**
       * Create Session
       *
       * @example
       * ```ts
       * const betaManagedAgentsSession =
       *   await client.beta.sessions.create({
       *     agent: 'agent_011CZkYpogX7uDKUyvBTophP',
       *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/sessions?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get Session
       *
       * @example
       * ```ts
       * const betaManagedAgentsSession =
       *   await client.beta.sessions.retrieve(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *   );
       * ```
       */
      retrieve(sessionID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/sessions/${sessionID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update Session
       *
       * @example
       * ```ts
       * const betaManagedAgentsSession =
       *   await client.beta.sessions.update(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *   );
       * ```
       */
      update(sessionID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/sessions/${sessionID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Sessions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsSession of client.beta.sessions.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/sessions?beta=true", BidirectionalPageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete Session
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedSession =
       *   await client.beta.sessions.delete(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *   );
       * ```
       */
      delete(sessionID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/sessions/${sessionID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive Session
       *
       * @example
       * ```ts
       * const betaManagedAgentsSession =
       *   await client.beta.sessions.archive(
       *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
       *   );
       * ```
       */
      archive(sessionID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/sessions/${sessionID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
    Sessions.Events = Events;
    Sessions.Resources = Resources;
    Sessions.Threads = Threads;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs
var Versions2;
var init_versions2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_uploads();
    init_path();
    Versions2 = class extends APIResource {
      /**
       * Create Skill Version
       *
       * @example
       * ```ts
       * const version = await client.beta.skills.versions.create(
       *   'skill_id',
       *   { files: [fs.createReadStream('path/to/file')] },
       * );
       * ```
       */
      create(skillID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/skills/${skillID}/versions?beta=true`, multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        }, this._client, false));
      }
      /**
       * Get Skill Version
       *
       * @example
       * ```ts
       * const version = await client.beta.skills.versions.retrieve(
       *   'version',
       *   { skill_id: 'skill_id' },
       * );
       * ```
       */
      retrieve(version, params, options) {
        const { skill_id, betas } = params;
        return this._client.get(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Skill Versions
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const versionListResponse of client.beta.skills.versions.list(
       *   'skill_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(skillID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/skills/${skillID}/versions?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete Skill Version
       *
       * @example
       * ```ts
       * const version = await client.beta.skills.versions.delete(
       *   'version',
       *   { skill_id: 'skill_id' },
       * );
       * ```
       */
      delete(version, params, options) {
        const { skill_id, betas } = params;
        return this._client.delete(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Download a skill version's content as a zip archive.
       *
       * @example
       * ```ts
       * const response = await client.beta.skills.versions.download(
       *   'version',
       *   { skill_id: 'skill_id' },
       * );
       *
       * const content = await response.blob();
       * console.log(content);
       * ```
       */
      download(version, params, options) {
        const { skill_id, betas } = params;
        return this._client.get(path`/v1/skills/${skill_id}/versions/${version}/content?beta=true`, {
          ...options,
          headers: buildHeaders([
            {
              "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString(),
              Accept: "application/binary"
            },
            options?.headers
          ]),
          __binaryResponse: true
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs
var Skills;
var init_skills2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs"() {
    init_resource();
    init_versions2();
    init_versions2();
    init_pagination();
    init_headers();
    init_uploads();
    init_path();
    Skills = class extends APIResource {
      constructor() {
        super(...arguments);
        this.versions = new Versions2(this._client);
      }
      /**
       * Create Skill
       *
       * @example
       * ```ts
       * const skill = await client.beta.skills.create({
       *   files: [fs.createReadStream('path/to/file')],
       * });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/skills?beta=true", multipartFormRequestOptions({
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        }, this._client, false));
      }
      /**
       * Get Skill
       *
       * @example
       * ```ts
       * const skill = await client.beta.skills.retrieve('skill_id');
       * ```
       */
      retrieve(skillID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/skills/${skillID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Skills
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const skillListResponse of client.beta.skills.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/skills?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete Skill
       *
       * @example
       * ```ts
       * const skill = await client.beta.skills.delete('skill_id');
       * ```
       */
      delete(skillID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/skills/${skillID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
            options?.headers
          ])
        });
      }
    };
    Skills.Versions = Versions2;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/tunnels/certificates.mjs
var Certificates;
var init_certificates = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/tunnels/certificates.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Certificates = class extends APIResource {
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Registers a public CA certificate on a tunnel. Anthropic verifies the gateway's
       * server certificate against this CA when it terminates the inner TLS session. A
       * tunnel holds at most two non-archived certificates.
       *
       * @example
       * ```ts
       * const betaTunnelCertificate =
       *   await client.beta.tunnels.certificates.create(
       *     'tunnel_id',
       *     { ca_certificate_pem: 'ca_certificate_pem' },
       *   );
       * ```
       */
      create(tunnelID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/tunnels/${tunnelID}/certificates?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Fetches a tunnel certificate by ID.
       *
       * @example
       * ```ts
       * const betaTunnelCertificate =
       *   await client.beta.tunnels.certificates.retrieve(
       *     'certificate_id',
       *     { tunnel_id: 'tunnel_id' },
       *   );
       * ```
       */
      retrieve(certificateID, params, options) {
        const { tunnel_id, betas } = params;
        return this._client.get(path`/v1/tunnels/${tunnel_id}/certificates/${certificateID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Lists the certificates registered on a tunnel. Archived certificates are
       * excluded unless include_archived is set.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaTunnelCertificate of client.beta.tunnels.certificates.list(
       *   'tunnel_id',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(tunnelID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/tunnels/${tunnelID}/certificates?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Archives a tunnel certificate, removing it from the set Anthropic trusts for the
       * tunnel. The certificate record is retained. Archiving the last non-archived
       * certificate is permitted; the tunnel rejects MCP traffic until a new certificate
       * is added.
       *
       * @example
       * ```ts
       * const betaTunnelCertificate =
       *   await client.beta.tunnels.certificates.archive(
       *     'certificate_id',
       *     { tunnel_id: 'tunnel_id' },
       *   );
       * ```
       */
      archive(certificateID, params, options) {
        const { tunnel_id, betas } = params;
        return this._client.post(path`/v1/tunnels/${tunnel_id}/certificates/${certificateID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/tunnels/tunnels.mjs
var Tunnels;
var init_tunnels = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/tunnels/tunnels.mjs"() {
    init_resource();
    init_certificates();
    init_certificates();
    init_pagination();
    init_headers();
    init_path();
    Tunnels = class extends APIResource {
      constructor() {
        super(...arguments);
        this.certificates = new Certificates(this._client);
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Creates a tunnel. Creation allocates a fresh hostname and provisions the tunnel;
       * it is not idempotent. The new tunnel rejects MCP traffic until at least one CA
       * certificate is added.
       *
       * @example
       * ```ts
       * const betaTunnel = await client.beta.tunnels.create();
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/tunnels?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Fetches a tunnel by ID.
       *
       * @example
       * ```ts
       * const betaTunnel = await client.beta.tunnels.retrieve(
       *   'tunnel_id',
       * );
       * ```
       */
      retrieve(tunnelID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/tunnels/${tunnelID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Lists tunnels. Results are ordered by creation time, newest first; archived
       * tunnels are excluded unless include_archived is set.
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaTunnel of client.beta.tunnels.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/tunnels?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Archives a tunnel. Archival is irreversible: every non-archived certificate on
       * the tunnel is archived in the same operation, the hostname is retired and never
       * re-allocated, and the tunnel token is invalidated. Retrying against an
       * already-archived tunnel returns the existing record unchanged.
       *
       * @example
       * ```ts
       * const betaTunnel = await client.beta.tunnels.archive(
       *   'tunnel_id',
       * );
       * ```
       */
      archive(tunnelID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/tunnels/${tunnelID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Reveals a tunnel's connector token. The value is fetched live on each call;
       * Anthropic does not store it. Repeated calls return the same value until the
       * token is rotated. Exposed as POST so the token does not appear in intermediary
       * access logs.
       *
       * @example
       * ```ts
       * const betaTunnelToken =
       *   await client.beta.tunnels.revealToken('tunnel_id');
       * ```
       */
      revealToken(tunnelID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/tunnels/${tunnelID}/reveal_token?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * The Tunnels API is in research preview. It requires the
       * `anthropic-beta: mcp-tunnels-2026-06-22` header and may change without a
       * deprecation period. It supersedes the Admin API endpoints at
       * `/v1/organizations/tunnels`, which remain available during a migration window.
       *
       * Rotates a tunnel's connector token. Rotation invalidates the current token for
       * new connections and returns a fresh value; established connections are not
       * severed. A connector restarted after rotation must use the new value.
       *
       * @example
       * ```ts
       * const betaTunnelToken =
       *   await client.beta.tunnels.rotateToken('tunnel_id');
       * ```
       */
      rotateToken(tunnelID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/tunnels/${tunnelID}/rotate_token?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "mcp-tunnels-2026-06-22"].toString() },
            options?.headers
          ])
        });
      }
    };
    Tunnels.Certificates = Certificates;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs
var Credentials;
var init_credentials2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Credentials = class extends APIResource {
      /**
       * Create Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.create(
       *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       *     {
       *       auth: {
       *         token: 'bearer_exampletoken',
       *         mcp_server_url:
       *           'https://example-server.modelcontextprotocol.io/sse',
       *         type: 'static_bearer',
       *       },
       *     },
       *   );
       * ```
       */
      create(vaultID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/vaults/${vaultID}/credentials?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.retrieve(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      retrieve(credentialID, params, options) {
        const { vault_id, betas } = params;
        return this._client.get(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.update(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      update(credentialID, params, options) {
        const { vault_id, betas, ...body } = params;
        return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Credentials
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsCredential of client.beta.vaults.credentials.list(
       *   'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       * )) {
       *   // ...
       * }
       * ```
       */
      list(vaultID, params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList(path`/v1/vaults/${vaultID}/credentials?beta=true`, PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedCredential =
       *   await client.beta.vaults.credentials.delete(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      delete(credentialID, params, options) {
        const { vault_id, betas } = params;
        return this._client.delete(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredential =
       *   await client.beta.vaults.credentials.archive(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      archive(credentialID, params, options) {
        const { vault_id, betas } = params;
        return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Validate Credential
       *
       * @example
       * ```ts
       * const betaManagedAgentsCredentialValidation =
       *   await client.beta.vaults.credentials.mcpOAuthValidate(
       *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
       *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
       *   );
       * ```
       */
      mcpOAuthValidate(credentialID, params, options) {
        const { vault_id, betas } = params;
        return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}/mcp_oauth_validate?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs
var Vaults;
var init_vaults = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs"() {
    init_resource();
    init_credentials2();
    init_credentials2();
    init_pagination();
    init_headers();
    init_path();
    Vaults = class extends APIResource {
      constructor() {
        super(...arguments);
        this.credentials = new Credentials(this._client);
      }
      /**
       * Create Vault
       *
       * @example
       * ```ts
       * const betaManagedAgentsVault =
       *   await client.beta.vaults.create({
       *     display_name: 'Example vault',
       *   });
       * ```
       */
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/vaults?beta=true", {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Get Vault
       *
       * @example
       * ```ts
       * const betaManagedAgentsVault =
       *   await client.beta.vaults.retrieve(
       *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       *   );
       * ```
       */
      retrieve(vaultID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/vaults/${vaultID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Update Vault
       *
       * @example
       * ```ts
       * const betaManagedAgentsVault =
       *   await client.beta.vaults.update(
       *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       *   );
       * ```
       */
      update(vaultID, params, options) {
        const { betas, ...body } = params;
        return this._client.post(path`/v1/vaults/${vaultID}?beta=true`, {
          body,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * List Vaults
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const betaManagedAgentsVault of client.beta.vaults.list()) {
       *   // ...
       * }
       * ```
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/vaults?beta=true", PageCursor, {
          query,
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Delete Vault
       *
       * @example
       * ```ts
       * const betaManagedAgentsDeletedVault =
       *   await client.beta.vaults.delete(
       *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       *   );
       * ```
       */
      delete(vaultID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.delete(path`/v1/vaults/${vaultID}?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
      /**
       * Archive Vault
       *
       * @example
       * ```ts
       * const betaManagedAgentsVault =
       *   await client.beta.vaults.archive(
       *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
       *   );
       * ```
       */
      archive(vaultID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.post(path`/v1/vaults/${vaultID}/archive?beta=true`, {
          ...options,
          headers: buildHeaders([
            { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
            options?.headers
          ])
        });
      }
    };
    Vaults.Credentials = Credentials;
  }
});

// node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
var Beta;
var init_beta = __esm({
  "node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs"() {
    init_resource();
    init_deployment_runs();
    init_deployment_runs();
    init_deployments();
    init_deployments();
    init_dreams();
    init_dreams();
    init_files();
    init_files();
    init_models();
    init_models();
    init_user_profiles();
    init_user_profiles();
    init_webhooks();
    init_webhooks();
    init_agents();
    init_agents();
    init_environments();
    init_environments();
    init_memory_stores();
    init_memory_stores();
    init_messages();
    init_messages();
    init_sessions();
    init_sessions();
    init_skills2();
    init_skills2();
    init_tunnels();
    init_tunnels();
    init_vaults();
    init_vaults();
    Beta = class extends APIResource {
      constructor() {
        super(...arguments);
        this.models = new Models(this._client);
        this.messages = new Messages(this._client);
        this.agents = new Agents(this._client);
        this.environments = new Environments(this._client);
        this.sessions = new Sessions(this._client);
        this.deployments = new Deployments(this._client);
        this.deploymentRuns = new DeploymentRuns(this._client);
        this.vaults = new Vaults(this._client);
        this.memoryStores = new MemoryStores(this._client);
        this.files = new Files(this._client);
        this.skills = new Skills(this._client);
        this.webhooks = new Webhooks(this._client);
        this.userProfiles = new UserProfiles(this._client);
        this.dreams = new Dreams(this._client);
        this.tunnels = new Tunnels(this._client);
      }
    };
    Beta.Models = Models;
    Beta.Messages = Messages;
    Beta.Agents = Agents;
    Beta.Environments = Environments;
    Beta.Sessions = Sessions;
    Beta.Deployments = Deployments;
    Beta.DeploymentRuns = DeploymentRuns;
    Beta.Vaults = Vaults;
    Beta.MemoryStores = MemoryStores;
    Beta.Files = Files;
    Beta.Skills = Skills;
    Beta.Webhooks = Webhooks;
    Beta.UserProfiles = UserProfiles;
    Beta.Dreams = Dreams;
    Beta.Tunnels = Tunnels;
  }
});

// node_modules/@anthropic-ai/sdk/resources/completions.mjs
var Completions;
var init_completions = __esm({
  "node_modules/@anthropic-ai/sdk/resources/completions.mjs"() {
    init_resource();
    init_headers();
    Completions = class extends APIResource {
      create(params, options) {
        const { betas, ...body } = params;
        return this._client.post("/v1/complete", {
          body,
          timeout: this._client._options.timeout ?? 6e5,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ]),
          stream: params.stream ?? false
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/lib/parser.mjs
function getOutputFormat2(params) {
  return params?.output_config?.format;
}
function maybeParseMessage(message, params, opts) {
  const outputFormat = getOutputFormat2(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return parsedBlock;
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseMessage(message, params, opts);
}
function parseMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return parsedBlock;
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
function parseOutputFormat(params, content) {
  const outputFormat = getOutputFormat2(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}
var init_parser2 = __esm({
  "node_modules/@anthropic-ai/sdk/lib/parser.mjs"() {
    init_error();
  }
});

// node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
function tracksToolInput2(content) {
  return content.type === "tool_use" || content.type === "server_tool_use";
}
function checkNever2(x) {
}
var _MessageStream_instances, _MessageStream_currentMessageSnapshot, _MessageStream_params, _MessageStream_connectedPromise, _MessageStream_resolveConnectedPromise, _MessageStream_rejectConnectedPromise, _MessageStream_endPromise, _MessageStream_resolveEndPromise, _MessageStream_rejectEndPromise, _MessageStream_listeners, _MessageStream_ended, _MessageStream_errored, _MessageStream_aborted, _MessageStream_catchingPromiseCreated, _MessageStream_response, _MessageStream_request_id, _MessageStream_logger, _MessageStream_getFinalMessage, _MessageStream_getFinalText, _MessageStream_handleError, _MessageStream_beginRequest, _MessageStream_addStreamEvent, _MessageStream_endRequest, _MessageStream_accumulateMessage, MessageStream;
var init_MessageStream = __esm({
  "node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs"() {
    init_tslib();
    init_stainless_helper_header();
    init_errors();
    init_error2();
    init_streaming2();
    init_parser2();
    init_message_stream_utils();
    MessageStream = class _MessageStream {
      constructor(params, opts) {
        _MessageStream_instances.add(this);
        this.messages = [];
        this.receivedMessages = [];
        _MessageStream_currentMessageSnapshot.set(this, void 0);
        _MessageStream_params.set(this, null);
        this.controller = new AbortController();
        _MessageStream_connectedPromise.set(this, void 0);
        _MessageStream_resolveConnectedPromise.set(this, () => {
        });
        _MessageStream_rejectConnectedPromise.set(this, () => {
        });
        _MessageStream_endPromise.set(this, void 0);
        _MessageStream_resolveEndPromise.set(this, () => {
        });
        _MessageStream_rejectEndPromise.set(this, () => {
        });
        _MessageStream_listeners.set(this, {});
        _MessageStream_ended.set(this, false);
        _MessageStream_errored.set(this, false);
        _MessageStream_aborted.set(this, false);
        _MessageStream_catchingPromiseCreated.set(this, false);
        _MessageStream_response.set(this, void 0);
        _MessageStream_request_id.set(this, void 0);
        _MessageStream_logger.set(this, void 0);
        _MessageStream_handleError.set(this, (error) => {
          __classPrivateFieldSet(this, _MessageStream_errored, true, "f");
          if (isAbortError(error)) {
            error = new APIUserAbortError();
          }
          if (error instanceof APIUserAbortError) {
            __classPrivateFieldSet(this, _MessageStream_aborted, true, "f");
            return this._emit("abort", error);
          }
          if (error instanceof AnthropicError) {
            return this._emit("error", error);
          }
          if (error instanceof Error) {
            const anthropicError = new AnthropicError(error.message);
            anthropicError.cause = error;
            return this._emit("error", anthropicError);
          }
          return this._emit("error", new AnthropicError(String(error)));
        });
        __classPrivateFieldSet(this, _MessageStream_connectedPromise, new Promise((resolve5, reject) => {
          __classPrivateFieldSet(this, _MessageStream_resolveConnectedPromise, resolve5, "f");
          __classPrivateFieldSet(this, _MessageStream_rejectConnectedPromise, reject, "f");
        }), "f");
        __classPrivateFieldSet(this, _MessageStream_endPromise, new Promise((resolve5, reject) => {
          __classPrivateFieldSet(this, _MessageStream_resolveEndPromise, resolve5, "f");
          __classPrivateFieldSet(this, _MessageStream_rejectEndPromise, reject, "f");
        }), "f");
        __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f").catch(() => {
        });
        __classPrivateFieldGet(this, _MessageStream_endPromise, "f").catch(() => {
        });
        __classPrivateFieldSet(this, _MessageStream_params, params, "f");
        __classPrivateFieldSet(this, _MessageStream_logger, opts?.logger ?? console, "f");
      }
      get response() {
        return __classPrivateFieldGet(this, _MessageStream_response, "f");
      }
      get request_id() {
        return __classPrivateFieldGet(this, _MessageStream_request_id, "f");
      }
      /**
       * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
       * returned vie the `request-id` header which is useful for debugging requests and resporting
       * issues to Anthropic.
       *
       * This is the same as the `APIPromise.withResponse()` method.
       *
       * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
       * as no `Response` is available.
       */
      async withResponse() {
        __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
        const response = await __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f");
        if (!response) {
          throw new Error("Could not resolve a `Response` object");
        }
        return {
          data: this,
          response,
          request_id: response.headers.get("request-id")
        };
      }
      /**
       * Intended for use on the frontend, consuming a stream produced with
       * `.toReadableStream()` on the backend.
       *
       * Note that messages sent to the model do not appear in `.on('message')`
       * in this context.
       */
      static fromReadableStream(stream) {
        const runner = new _MessageStream(null);
        runner._run(() => runner._fromReadableStream(stream));
        return runner;
      }
      static createMessage(messages, params, options, { logger } = {}) {
        const runner = new _MessageStream(params, { logger });
        for (const message of params.messages) {
          runner._addMessageParam(message);
        }
        __classPrivateFieldSet(runner, _MessageStream_params, { ...params, stream: true }, "f");
        runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, [STAINLESS_HELPER_METHOD_HEADER]: "stream" } }));
        return runner;
      }
      _run(executor) {
        executor().then(() => {
          this._emitFinal();
          this._emit("end");
        }, __classPrivateFieldGet(this, _MessageStream_handleError, "f"));
      }
      _addMessageParam(message) {
        this.messages.push(message);
      }
      _addMessage(message, emit = true) {
        this.receivedMessages.push(message);
        if (emit) {
          this._emit("message", message);
        }
      }
      async _createMessage(messages, params, options) {
        const signal = options?.signal;
        let abortHandler;
        if (signal) {
          if (signal.aborted)
            this.controller.abort();
          abortHandler = this.controller.abort.bind(this.controller);
          signal.addEventListener("abort", abortHandler);
        }
        try {
          __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
          const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
          this._connected(response);
          for await (const event of stream) {
            __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
          }
          if (stream.controller.signal?.aborted) {
            throw new APIUserAbortError();
          }
          __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
        } finally {
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
          }
        }
      }
      _connected(response) {
        if (this.ended)
          return;
        __classPrivateFieldSet(this, _MessageStream_response, response, "f");
        __classPrivateFieldSet(this, _MessageStream_request_id, response?.headers.get("request-id"), "f");
        __classPrivateFieldGet(this, _MessageStream_resolveConnectedPromise, "f").call(this, response);
        this._emit("connect");
      }
      get ended() {
        return __classPrivateFieldGet(this, _MessageStream_ended, "f");
      }
      get errored() {
        return __classPrivateFieldGet(this, _MessageStream_errored, "f");
      }
      get aborted() {
        return __classPrivateFieldGet(this, _MessageStream_aborted, "f");
      }
      abort() {
        this.controller.abort();
      }
      /**
       * Adds the listener function to the end of the listeners array for the event.
       * No checks are made to see if the listener has already been added. Multiple calls passing
       * the same combination of event and listener will result in the listener being added, and
       * called, multiple times.
       * @returns this MessageStream, so that calls can be chained
       */
      on(event, listener) {
        const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
        listeners.push({ listener });
        return this;
      }
      /**
       * Removes the specified listener from the listener array for the event.
       * off() will remove, at most, one instance of a listener from the listener array. If any single
       * listener has been added multiple times to the listener array for the specified event, then
       * off() must be called multiple times to remove each instance.
       * @returns this MessageStream, so that calls can be chained
       */
      off(event, listener) {
        const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
        if (!listeners)
          return this;
        const index = listeners.findIndex((l) => l.listener === listener);
        if (index >= 0)
          listeners.splice(index, 1);
        return this;
      }
      /**
       * Adds a one-time listener function for the event. The next time the event is triggered,
       * this listener is removed and then invoked.
       * @returns this MessageStream, so that calls can be chained
       */
      once(event, listener) {
        const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
        listeners.push({ listener, once: true });
        return this;
      }
      /**
       * This is similar to `.once()`, but returns a Promise that resolves the next time
       * the event is triggered, instead of calling a listener callback.
       * @returns a Promise that resolves the next time given event is triggered,
       * or rejects if an error is emitted.  (If you request the 'error' event,
       * returns a promise that resolves with the error).
       *
       * Example:
       *
       *   const message = await stream.emitted('message') // rejects if the stream errors
       */
      emitted(event) {
        return new Promise((resolve5, reject) => {
          __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
          if (event !== "error")
            this.once("error", reject);
          this.once(event, resolve5);
        });
      }
      async done() {
        __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
        await __classPrivateFieldGet(this, _MessageStream_endPromise, "f");
      }
      get currentMessage() {
        return __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
      }
      /**
       * @returns a promise that resolves with the the final assistant Message response,
       * or rejects if an error occurred or the stream ended prematurely without producing a Message.
       * If structured outputs were used, this will be a ParsedMessage with a `parsed_output` field.
       */
      async finalMessage() {
        await this.done();
        return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this);
      }
      /**
       * @returns a promise that resolves with the the final assistant Message's text response, concatenated
       * together if there are more than one text blocks.
       * Rejects if an error occurred or the stream ended prematurely without producing a Message.
       */
      async finalText() {
        await this.done();
        return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalText).call(this);
      }
      _emit(event, ...args) {
        if (__classPrivateFieldGet(this, _MessageStream_ended, "f"))
          return;
        if (event === "end") {
          __classPrivateFieldSet(this, _MessageStream_ended, true, "f");
          __classPrivateFieldGet(this, _MessageStream_resolveEndPromise, "f").call(this);
        }
        const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
        if (listeners) {
          __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
          listeners.forEach(({ listener }) => listener(...args));
        }
        if (event === "abort") {
          const error = args[0];
          if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
            Promise.reject(error);
          }
          __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
          __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
          this._emit("end");
          return;
        }
        if (event === "error") {
          const error = args[0];
          if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
            Promise.reject(error);
          }
          __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
          __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
          this._emit("end");
        }
      }
      _emitFinal() {
        const finalMessage = this.receivedMessages.at(-1);
        if (finalMessage) {
          this._emit("finalMessage", __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this));
        }
      }
      async _fromReadableStream(readableStream, options) {
        const signal = options?.signal;
        let abortHandler;
        if (signal) {
          if (signal.aborted)
            this.controller.abort();
          abortHandler = this.controller.abort.bind(this.controller);
          signal.addEventListener("abort", abortHandler);
        }
        try {
          __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
          this._connected(null);
          const stream = Stream.fromReadableStream(readableStream, this.controller);
          for await (const event of stream) {
            __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
          }
          if (stream.controller.signal?.aborted) {
            throw new APIUserAbortError();
          }
          __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
        } finally {
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
          }
        }
      }
      [(_MessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _MessageStream_params = /* @__PURE__ */ new WeakMap(), _MessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_listeners = /* @__PURE__ */ new WeakMap(), _MessageStream_ended = /* @__PURE__ */ new WeakMap(), _MessageStream_errored = /* @__PURE__ */ new WeakMap(), _MessageStream_aborted = /* @__PURE__ */ new WeakMap(), _MessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _MessageStream_response = /* @__PURE__ */ new WeakMap(), _MessageStream_request_id = /* @__PURE__ */ new WeakMap(), _MessageStream_logger = /* @__PURE__ */ new WeakMap(), _MessageStream_handleError = /* @__PURE__ */ new WeakMap(), _MessageStream_instances = /* @__PURE__ */ new WeakSet(), _MessageStream_getFinalMessage = function _MessageStream_getFinalMessage2() {
        if (this.receivedMessages.length === 0) {
          throw new AnthropicError("stream ended without producing a Message with role=assistant");
        }
        return this.receivedMessages.at(-1);
      }, _MessageStream_getFinalText = function _MessageStream_getFinalText2() {
        if (this.receivedMessages.length === 0) {
          throw new AnthropicError("stream ended without producing a Message with role=assistant");
        }
        const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
        if (textBlocks.length === 0) {
          throw new AnthropicError("stream ended without producing a content block with type=text");
        }
        return textBlocks.join(" ");
      }, _MessageStream_beginRequest = function _MessageStream_beginRequest2() {
        if (this.ended)
          return;
        __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
      }, _MessageStream_addStreamEvent = function _MessageStream_addStreamEvent2(event) {
        if (this.ended)
          return;
        const messageSnapshot = __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_accumulateMessage).call(this, event);
        this._emit("streamEvent", event, messageSnapshot);
        switch (event.type) {
          case "content_block_delta": {
            const content = messageSnapshot.content.at(-1);
            switch (event.delta.type) {
              case "text_delta": {
                if (content.type === "text") {
                  this._emit("text", event.delta.text, content.text || "");
                }
                break;
              }
              case "citations_delta": {
                if (content.type === "text") {
                  this._emit("citation", event.delta.citation, content.citations ?? []);
                }
                break;
              }
              case "input_json_delta": {
                if (tracksToolInput2(content) && __classPrivateFieldGet(this, _MessageStream_listeners, "f").inputJson?.length) {
                  this._emit("inputJson", event.delta.partial_json, content.input);
                }
                break;
              }
              case "thinking_delta": {
                if (content.type === "thinking") {
                  this._emit("thinking", event.delta.thinking, content.thinking);
                }
                break;
              }
              case "signature_delta": {
                if (content.type === "thinking") {
                  this._emit("signature", content.signature);
                }
                break;
              }
              default:
                checkNever2(event.delta);
            }
            break;
          }
          case "message_stop": {
            this._addMessageParam(messageSnapshot);
            this._addMessage(maybeParseMessage(messageSnapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") }), true);
            break;
          }
          case "content_block_stop": {
            this._emit("contentBlock", messageSnapshot.content.at(-1));
            break;
          }
          case "message_start": {
            __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, messageSnapshot, "f");
            break;
          }
          case "content_block_start":
          case "message_delta":
            break;
        }
      }, _MessageStream_endRequest = function _MessageStream_endRequest2() {
        if (this.ended) {
          throw new AnthropicError(`stream has ended, this shouldn't happen`);
        }
        const snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
        if (!snapshot) {
          throw new AnthropicError(`request ended without sending any chunks`);
        }
        __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
        return maybeParseMessage(snapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") });
      }, _MessageStream_accumulateMessage = function _MessageStream_accumulateMessage2(event) {
        let snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
        if (event.type === "message_start") {
          if (snapshot) {
            throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
          }
          return event.message;
        }
        if (!snapshot) {
          throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
        }
        switch (event.type) {
          case "message_stop":
            return snapshot;
          case "message_delta":
            snapshot.stop_reason = event.delta.stop_reason;
            snapshot.stop_sequence = event.delta.stop_sequence;
            snapshot.stop_details = event.delta.stop_details;
            snapshot.usage.output_tokens = event.usage.output_tokens;
            if (event.delta.container != null) {
              snapshot.container = event.delta.container;
            }
            if (event.usage.input_tokens != null) {
              snapshot.usage.input_tokens = event.usage.input_tokens;
            }
            if (event.usage.cache_creation_input_tokens != null) {
              snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
            }
            if (event.usage.cache_read_input_tokens != null) {
              snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
            }
            if (event.usage.server_tool_use != null) {
              snapshot.usage.server_tool_use = event.usage.server_tool_use;
            }
            if (event.usage.output_tokens_details != null) {
              snapshot.usage.output_tokens_details = event.usage.output_tokens_details;
            }
            return snapshot;
          case "content_block_start":
            snapshot.content.push({ ...event.content_block });
            return snapshot;
          case "content_block_delta": {
            const snapshotContent = snapshot.content.at(event.index);
            switch (event.delta.type) {
              case "text_delta": {
                if (snapshotContent?.type === "text") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    text: (snapshotContent.text || "") + event.delta.text
                  };
                }
                break;
              }
              case "citations_delta": {
                if (snapshotContent?.type === "text") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    citations: [...snapshotContent.citations ?? [], event.delta.citation]
                  };
                }
                break;
              }
              case "input_json_delta": {
                if (snapshotContent && tracksToolInput2(snapshotContent)) {
                  const jsonBuf = (snapshotContent[JSON_BUF_PROPERTY] || "") + event.delta.partial_json;
                  snapshot.content[event.index] = withLazyInput(snapshotContent, jsonBuf);
                }
                break;
              }
              case "thinking_delta": {
                if (snapshotContent?.type === "thinking") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    thinking: snapshotContent.thinking + event.delta.thinking
                  };
                }
                break;
              }
              case "signature_delta": {
                if (snapshotContent?.type === "thinking") {
                  snapshot.content[event.index] = {
                    ...snapshotContent,
                    signature: event.delta.signature
                  };
                }
                break;
              }
              default:
                checkNever2(event.delta);
            }
            return snapshot;
          }
          case "content_block_stop": {
            const snapshotContent = snapshot.content.at(event.index);
            if (snapshotContent && tracksToolInput2(snapshotContent) && JSON_BUF_PROPERTY in snapshotContent) {
              Object.defineProperty(snapshotContent, "input", {
                value: snapshotContent.input,
                enumerable: true,
                configurable: true,
                writable: true
              });
            }
            return snapshot;
          }
        }
      }, Symbol.asyncIterator)]() {
        const pushQueue = [];
        const readQueue = [];
        let done = false;
        this.on("streamEvent", (event) => {
          const reader = readQueue.shift();
          if (reader) {
            reader.resolve(event);
          } else {
            pushQueue.push(event);
          }
        });
        this.on("end", () => {
          done = true;
          for (const reader of readQueue) {
            reader.resolve(void 0);
          }
          readQueue.length = 0;
        });
        this.on("abort", (err2) => {
          done = true;
          for (const reader of readQueue) {
            reader.reject(err2);
          }
          readQueue.length = 0;
        });
        this.on("error", (err2) => {
          done = true;
          for (const reader of readQueue) {
            reader.reject(err2);
          }
          readQueue.length = 0;
        });
        return {
          next: async () => {
            if (!pushQueue.length) {
              if (done) {
                return { value: void 0, done: true };
              }
              return new Promise((resolve5, reject) => readQueue.push({ resolve: resolve5, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
            }
            const chunk = pushQueue.shift();
            return { value: chunk, done: false };
          },
          return: async () => {
            this.abort();
            return { value: void 0, done: true };
          }
        };
      }
      toReadableStream() {
        const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
        return stream.toReadableStream();
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs
var Batches2;
var init_batches2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_jsonl();
    init_error2();
    init_path();
    Batches2 = class extends APIResource {
      /**
       * Send a batch of Message creation requests.
       *
       * The Message Batches API can be used to process multiple Messages API requests at
       * once. Once a Message Batch is created, it begins processing immediately. Batches
       * can take up to 24 hours to complete.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatch = await client.messages.batches.create({
       *   requests: [
       *     {
       *       custom_id: 'my-custom-id-1',
       *       params: {
       *         max_tokens: 1024,
       *         messages: [
       *           { content: 'Hello, world', role: 'user' },
       *         ],
       *         model: 'claude-opus-4-6',
       *       },
       *     },
       *   ],
       * });
       * ```
       */
      create(params, options) {
        const { user_profile_id, ...body } = params;
        return this._client.post("/v1/messages/batches", {
          body,
          ...options,
          headers: buildHeaders([
            { ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * This endpoint is idempotent and can be used to poll for Message Batch
       * completion. To access the results of a Message Batch, make a request to the
       * `results_url` field in the response.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatch = await client.messages.batches.retrieve(
       *   'message_batch_id',
       * );
       * ```
       */
      retrieve(messageBatchID, options) {
        return this._client.get(path`/v1/messages/batches/${messageBatchID}`, options);
      }
      /**
       * List all Message Batches within a Workspace. Most recently created batches are
       * returned first.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * // Automatically fetches more pages as needed.
       * for await (const messageBatch of client.messages.batches.list()) {
       *   // ...
       * }
       * ```
       */
      list(query = {}, options) {
        return this._client.getAPIList("/v1/messages/batches", Page, { query, ...options });
      }
      /**
       * Delete a Message Batch.
       *
       * Message Batches can only be deleted once they've finished processing. If you'd
       * like to delete an in-progress batch, you must first cancel it.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const deletedMessageBatch =
       *   await client.messages.batches.delete('message_batch_id');
       * ```
       */
      delete(messageBatchID, options) {
        return this._client.delete(path`/v1/messages/batches/${messageBatchID}`, options);
      }
      /**
       * Batches may be canceled any time before processing ends. Once cancellation is
       * initiated, the batch enters a `canceling` state, at which time the system may
       * complete any in-progress, non-interruptible requests before finalizing
       * cancellation.
       *
       * The number of canceled requests is specified in `request_counts`. To determine
       * which requests were canceled, check the individual results within the batch.
       * Note that cancellation may not result in any canceled requests if they were
       * non-interruptible.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatch = await client.messages.batches.cancel(
       *   'message_batch_id',
       * );
       * ```
       */
      cancel(messageBatchID, options) {
        return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel`, options);
      }
      /**
       * Streams the results of a Message Batch as a `.jsonl` file.
       *
       * Each line in the file is a JSON object containing the result of a single request
       * in the Message Batch. Results are not guaranteed to be in the same order as
       * requests. Use the `custom_id` field to match results to requests.
       *
       * Learn more about the Message Batches API in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
       *
       * @example
       * ```ts
       * const messageBatchIndividualResponse =
       *   await client.messages.batches.results('message_batch_id');
       * ```
       */
      async results(messageBatchID, options) {
        const batch = await this.retrieve(messageBatchID);
        if (!batch.results_url) {
          throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
        }
        return this._client.get(batch.results_url, {
          ...options,
          headers: buildHeaders([{ Accept: "application/binary" }, options?.headers]),
          stream: true,
          __binaryResponse: true
        })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
var Messages2, DEPRECATED_MODELS2, MODELS_TO_WARN_WITH_THINKING_ENABLED2;
var init_messages2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs"() {
    init_resource();
    init_headers();
    init_stainless_helper_header();
    init_MessageStream();
    init_parser2();
    init_batches2();
    init_batches2();
    init_constants();
    Messages2 = class extends APIResource {
      constructor() {
        super(...arguments);
        this.batches = new Batches2(this._client);
      }
      create(params, options) {
        const { user_profile_id, ...body } = params;
        if (body.model in DEPRECATED_MODELS2) {
          console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS2[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
        }
        if (MODELS_TO_WARN_WITH_THINKING_ENABLED2.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
          console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
        }
        let timeout = options?.timeout ?? this._client._options.timeout;
        if (!body.stream && timeout == null) {
          const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
          timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
        }
        const helperHeader2 = stainlessHelperHeader(body.tools, body.messages);
        return this._client.post("/v1/messages", {
          body,
          timeout: timeout ?? 6e5,
          ...options,
          headers: buildHeaders([
            { ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0 },
            helperHeader2,
            options?.headers
          ]),
          stream: params.stream ?? false
        });
      }
      /**
       * Send a structured list of input messages with text and/or image content, along with an expected `output_config.format` and
       * the response will be automatically parsed and available in the `parsed_output` property of the message.
       *
       * @example
       * ```ts
       * const message = await client.messages.parse({
       *   model: 'claude-sonnet-4-5-20250929',
       *   max_tokens: 1024,
       *   messages: [{ role: 'user', content: 'What is 2+2?' }],
       *   output_config: {
       *     format: zodOutputFormat(z.object({ answer: z.number() })),
       *   },
       * });
       *
       * console.log(message.parsed_output?.answer); // 4
       * ```
       */
      parse(params, options) {
        return this.create(params, options).then((message) => parseMessage(message, params, { logger: this._client.logger ?? console }));
      }
      /**
       * Create a Message stream.
       *
       * If `output_config.format` is provided with a parseable format (like `zodOutputFormat()`),
       * the final message will include a `parsed_output` property with the parsed content.
       *
       * @example
       * ```ts
       * const stream = client.messages.stream({
       *   model: 'claude-sonnet-4-5-20250929',
       *   max_tokens: 1024,
       *   messages: [{ role: 'user', content: 'What is 2+2?' }],
       *   output_config: {
       *     format: zodOutputFormat(z.object({ answer: z.number() })),
       *   },
       * });
       *
       * const message = await stream.finalMessage();
       * console.log(message.parsed_output?.answer); // 4
       * ```
       */
      stream(body, options) {
        return MessageStream.createMessage(this, body, options, { logger: this._client.logger ?? console });
      }
      /**
       * Count the number of tokens in a Message.
       *
       * The Token Count API can be used to count the number of tokens in a Message,
       * including tools, images, and documents, without creating it.
       *
       * Learn more about token counting in our
       * [user guide](https://platform.claude.com/docs/en/build-with-claude/token-counting)
       *
       * @example
       * ```ts
       * const messageTokensCount =
       *   await client.messages.countTokens({
       *     messages: [{ content: 'Hello, world', role: 'user' }],
       *     model: 'claude-opus-4-6',
       *   });
       * ```
       */
      countTokens(params, options) {
        const { user_profile_id, ...body } = params;
        return this._client.post("/v1/messages/count_tokens", {
          body,
          ...options,
          headers: buildHeaders([
            { ...user_profile_id != null ? { "anthropic-user-profile-id": user_profile_id } : void 0 },
            options?.headers
          ])
        });
      }
    };
    DEPRECATED_MODELS2 = {};
    MODELS_TO_WARN_WITH_THINKING_ENABLED2 = ["claude-mythos-preview", "claude-opus-4-6"];
    Messages2.Batches = Batches2;
  }
});

// node_modules/@anthropic-ai/sdk/resources/models.mjs
var Models2;
var init_models2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/models.mjs"() {
    init_resource();
    init_pagination();
    init_headers();
    init_path();
    Models2 = class extends APIResource {
      /**
       * Get a specific model.
       *
       * The Models API response can be used to determine information about a specific
       * model or resolve a model alias to a model ID.
       */
      retrieve(modelID, params = {}, options) {
        const { betas } = params ?? {};
        return this._client.get(path`/v1/models/${modelID}`, {
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
      /**
       * List available models.
       *
       * The Models API response can be used to determine which models are available for
       * use in the API. More recently released models are listed first.
       */
      list(params = {}, options) {
        const { betas, ...query } = params ?? {};
        return this._client.getAPIList("/v1/models", Page, {
          query,
          ...options,
          headers: buildHeaders([
            { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
            options?.headers
          ])
        });
      }
    };
  }
});

// node_modules/@anthropic-ai/sdk/resources/index.mjs
var init_resources2 = __esm({
  "node_modules/@anthropic-ai/sdk/resources/index.mjs"() {
    init_shared();
    init_beta();
    init_completions();
    init_messages2();
    init_models2();
  }
});

// node_modules/@anthropic-ai/sdk/client.mjs
var _BaseAnthropic_instances, _a, _BaseAnthropic_encoder, _BaseAnthropic_baseURLOverridden, HUMAN_PROMPT, AI_PROMPT, BaseAnthropic, Anthropic;
var init_client = __esm({
  "node_modules/@anthropic-ai/sdk/client.mjs"() {
    init_tslib();
    init_uuid();
    init_values();
    init_sleep();
    init_errors();
    init_detect_platform();
    init_request_signal();
    init_shims();
    init_request_options();
    init_query();
    init_version();
    init_error();
    init_types();
    init_token_cache();
    init_credential_chain();
    init_middleware();
    init_pagination();
    init_uploads2();
    init_resources2();
    init_api_promise();
    init_completions();
    init_models2();
    init_beta();
    init_messages2();
    init_detect_platform();
    init_headers();
    init_env();
    init_log();
    init_values();
    HUMAN_PROMPT = "\\n\\nHuman:";
    AI_PROMPT = "\\n\\nAssistant:";
    BaseAnthropic = class {
      /**
       * The active credential provider. Default credential resolution runs once
       * at construction time. If it fails, the error is surfaced on every
       * request and the client must be reconstructed — there is no retry path.
       *
       * Clones returned by {@link withOptions} share the parent's auth state
       * (provider, token cache, pending resolution, and any resolution error)
       * unless the caller passes an explicit `apiKey`, `authToken`,
       * `credentials`, `config`, or `profile` override.
       */
      get credentials() {
        return this._authState.provider;
      }
      /**
       * API Client for interfacing with the Anthropic API.
       *
       * @param {string | null | undefined} [opts.apiKey=process.env['ANTHROPIC_API_KEY'] ?? null]
       * @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
       * @param {string | null | undefined} [opts.webhookKey=process.env['ANTHROPIC_WEBHOOK_SIGNING_KEY'] ?? null]
       * @param {string} [opts.baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com] - Override the default base URL for the API.
       * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
       * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
       * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
       * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
       * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
       * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
       * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
       */
      constructor({ baseURL = readEnv("ANTHROPIC_BASE_URL"), apiKey, authToken, webhookKey = readEnv("ANTHROPIC_WEBHOOK_SIGNING_KEY") ?? null, ...opts } = {}) {
        _BaseAnthropic_instances.add(this);
        this._requestAuthFlags = /* @__PURE__ */ new WeakMap();
        _BaseAnthropic_encoder.set(this, void 0);
        if (apiKey === void 0) {
          apiKey = opts.profile != null ? null : readEnv("ANTHROPIC_API_KEY") ?? null;
        }
        if (authToken === void 0) {
          authToken = opts.profile != null ? null : readEnv("ANTHROPIC_AUTH_TOKEN") ?? null;
        }
        if (opts.profile != null && (opts.credentials != null || opts.config != null)) {
          throw new TypeError("Pass at most one of `profile`, `credentials`, or `config`.");
        }
        const options = {
          apiKey,
          authToken,
          webhookKey,
          ...opts,
          baseURL: baseURL || `https://api.anthropic.com`
        };
        if (!options.dangerouslyAllowBrowser && isRunningInBrowser()) {
          throw new AnthropicError("It looks like you're running in a browser-like environment.\n\nThis is disabled by default, as it risks exposing your secret API credentials to attackers.\nIf you understand the risks and have appropriate mitigations in place,\nyou can set the `dangerouslyAllowBrowser` option to `true`, e.g.,\n\nnew Anthropic({ apiKey, dangerouslyAllowBrowser: true });\n");
        }
        this.baseURL = options.baseURL;
        this._baseURLIsExplicit = opts.__baseURLIsExplicit ?? !!baseURL;
        this.timeout = options.timeout ?? _a.DEFAULT_TIMEOUT;
        this.logger = options.logger ?? console;
        this.logLevel = defaultLogLevel;
        this.logLevel = parseLogLevel(options.logLevel, "ClientOptions.logLevel", loggerFor(this)) ?? parseLogLevel(readEnv("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", loggerFor(this)) ?? defaultLogLevel;
        this.fetchOptions = options.fetchOptions;
        this.maxRetries = options.maxRetries ?? 2;
        this.fetch = options.fetch ?? getDefaultFetch();
        __classPrivateFieldSet(this, _BaseAnthropic_encoder, FallbackEncoder, "f");
        this.middleware = [...options.middleware ?? []];
        const customHeadersEnv = readEnv("ANTHROPIC_CUSTOM_HEADERS");
        if (customHeadersEnv) {
          const parsed = {};
          for (const line of customHeadersEnv.split("\n")) {
            const colon = line.indexOf(":");
            if (colon >= 0) {
              parsed[line.substring(0, colon).trim()] = line.substring(colon + 1).trim();
            }
          }
          options.defaultHeaders = { ...parsed, ...options.defaultHeaders };
        }
        const inherited = opts.__auth;
        delete options.__auth;
        delete options.__baseURLIsExplicit;
        this._options = options;
        this.apiKey = typeof apiKey === "string" ? apiKey : null;
        this.authToken = authToken;
        this.webhookKey = webhookKey;
        if (inherited) {
          this._authState = inherited;
          if (!this._baseURLIsExplicit && inherited.baseURL) {
            this.baseURL = inherited.baseURL;
          }
        } else {
          this._authState = { provider: null, tokenCache: null, resolution: null, error: null, extraHeaders: {} };
          if (this.apiKey == null && this.authToken == null) {
            const credentials = options.credentials ?? null;
            if (credentials) {
              this._authState.provider = credentials;
              this._authState.tokenCache = this._makeTokenCache(credentials);
            } else if (options.config != null) {
              const result = resolveCredentialsFromConfig(options.config, this._credentialResolverOptions());
              this._authState.provider = result.provider;
              this._authState.tokenCache = this._makeTokenCache(result.provider);
              this._authState.extraHeaders = result.extraHeaders;
              this._applyCredentialBaseURL(result.baseURL);
            } else if (options.profile != null) {
              this._authState.resolution = this._resolveDefaultCredentials(options.profile);
            } else if (this._shouldResolveDefaultCredentials()) {
              this._authState.resolution = this._resolveDefaultCredentials();
            }
          }
        }
      }
      /**
       * Whether to lazily resolve auth from the default credential chain when no
       * explicit auth is configured. Called once from the constructor, so
       * overrides must not depend on subclass instance state. Subclasses that
       * bring their own auth scheme return false so unrelated local credentials
       * are never resolved or allowed to supply a base URL.
       */
      _shouldResolveDefaultCredentials() {
        return true;
      }
      /**
       * Stores a profile/config-supplied base URL on the shared auth state and, if
       * the caller did not pin `baseURL` via constructor option or env, adopts it
       * as this client's outbound API host. Precedence: ctor opt > env > profile >
       * hardcoded default.
       */
      _applyCredentialBaseURL(baseURL) {
        if (!baseURL)
          return;
        const normalized = baseURL.replace(/\/+$/, "");
        this._authState.baseURL = normalized;
        if (!this._baseURLIsExplicit) {
          this.baseURL = normalized;
        }
      }
      /**
       * Options bag passed into the credential chain. `baseURL` here is only the
       * fallback host for the token-exchange POST when the config itself omits
       * `base_url`; the chain returns the config's own `base_url` (if any) on
       * {@link CredentialResult.baseURL}, which {@link _applyCredentialBaseURL}
       * then adopts for outbound API requests. The two are deliberately decoupled
       * so this fallback never round-trips into precedence.
       */
      _credentialResolverOptions() {
        return {
          baseURL: this.baseURL,
          fetch: this._credentialsFetch(),
          userAgent: this.getUserAgent(),
          onCacheWriteError: (err2) => {
            loggerFor(this).debug("credential cache write failed (best-effort)", err2);
          },
          onSafetyWarning: (msg) => {
            loggerFor(this).warn(msg);
          }
        };
      }
      /**
       * A `Fetch` for first-party credential token-exchange requests (OIDC
       * federation jwt-bearer grants, user-OAuth refresh grants) that routes
       * through this client's middleware chain, so middleware observes token
       * traffic like any other request. Only client-level middleware applies:
       * a minted token is shared across requests, so attributing the exchange
       * to any one request's per-request middleware would be arbitrary. For the
       * same reason, `ctx.options` is undefined for these requests.
       */
      _credentialsFetch() {
        return wrapFetchWithMiddleware(this.fetch, this.middleware, void 0, this);
      }
      _makeTokenCache(provider) {
        return new TokenCache(provider, (err2) => {
          loggerFor(this).debug("advisory token refresh failed; serving cached token", err2);
        });
      }
      /**
       * Create a new client instance re-using the same options given to the current client with optional overriding.
       */
      withOptions(options) {
        const overridesStructuredAuth = "credentials" in options || "config" in options || "profile" in options;
        const overridesAuth = "apiKey" in options || "authToken" in options || overridesStructuredAuth;
        const internal = {
          ...this._options,
          // Only forward baseURL when the caller (or env) explicitly chose it.
          // For a non-explicit parent, this.baseURL may have been mutated to the
          // profile-resolved host; pinning that as the clone's options.baseURL
          // would make _options on the clone misreport caller intent and would
          // leave the clone stuck on the parent's host across an auth override.
          // The clone instead receives the construction-time value via
          // ...this._options above and re-adopts the profile host through the
          // shared _authState.baseURL + __baseURLIsExplicit=false path.
          ...this._baseURLIsExplicit ? { baseURL: this.baseURL } : {},
          maxRetries: this.maxRetries,
          timeout: this.timeout,
          logger: this.logger,
          logLevel: this.logLevel,
          fetch: this.fetch,
          fetchOptions: this.fetchOptions,
          middleware: this.middleware,
          apiKey: this.apiKey,
          authToken: this.authToken,
          webhookKey: this.webhookKey,
          // credentials: this.credentials is a no-op when __auth is shared (the
          // ctor takes the inherited path and ignores options.credentials); when
          // overridesAuth is true via apiKey/authToken only, it lets the clone
          // build a fresh TokenCache around the parent's provider.
          credentials: this.credentials,
          // When the caller passes a structured-credential override, drop inherited
          // structured-credential options so only `...options` supplies them —
          // otherwise an inherited `credentials`/`config`/`profile` would trip the
          // mutual-exclusion check or precedence over the override.
          ...overridesStructuredAuth ? { credentials: void 0, config: void 0, profile: void 0 } : {},
          ...options,
          // Always set __auth so any stale value from ...this._options is
          // overwritten. undefined means "build fresh auth from these options".
          __auth: overridesAuth ? void 0 : this._authState,
          __baseURLIsExplicit: "baseURL" in options ? true : this._baseURLIsExplicit
        };
        return new this.constructor(internal);
      }
      /**
       * Lazily resolves credentials from config files or environment variables.
       * Called once from the constructor when no explicit auth is provided, or
       * when an explicit `profile` was passed (in which case a missing/unresolved
       * profile is surfaced as an error instead of falling through to "no auth").
       * The returned promise is stored and awaited on the first request.
       */
      async _resolveDefaultCredentials(profile) {
        try {
          const result = await defaultCredentials(this._credentialResolverOptions(), profile);
          if (result) {
            this._authState.provider = result.provider;
            this._authState.tokenCache = this._makeTokenCache(result.provider);
            this._authState.extraHeaders = result.extraHeaders;
            this._applyCredentialBaseURL(result.baseURL);
          } else if (profile != null) {
            throw new AnthropicError(`Profile "${profile}" could not be resolved (no <config_dir>/configs/${profile}.json found).`);
          }
        } catch (err2) {
          this._authState.error = err2;
        } finally {
          this._authState.resolution = null;
        }
      }
      defaultQuery() {
        return this._options.defaultQuery;
      }
      validateHeaders({ values, nulls }) {
        if (values.get("x-api-key") || values.get("authorization")) {
          return;
        }
        if (this._authState.error) {
          throw this._authState.error;
        }
        if (this._authState.tokenCache || this._authState.resolution) {
          return;
        }
        if (this.apiKey && values.get("x-api-key")) {
          return;
        }
        if (nulls.has("x-api-key")) {
          return;
        }
        if (this.authToken && values.get("authorization")) {
          return;
        }
        if (nulls.has("authorization")) {
          return;
        }
        throw new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
      }
      _authFlags(opts) {
        let flags = this._requestAuthFlags.get(opts);
        if (!flags) {
          flags = { usedTokenCache: false, didRefreshFor401: false };
          this._requestAuthFlags.set(opts, flags);
        }
        return flags;
      }
      async authHeaders(opts) {
        if (this._authState.resolution) {
          await this._authState.resolution;
        }
        if (this._authState.error) {
          return void 0;
        }
        if (this._authState.tokenCache && this.apiKey == null) {
          const token = await this._authState.tokenCache.getToken();
          this._authFlags(opts).usedTokenCache = true;
          return buildHeaders([{ Authorization: `Bearer ${token}` }]);
        }
        return buildHeaders([await this.apiKeyAuth(opts), await this.bearerAuth(opts)]);
      }
      async apiKeyAuth(opts) {
        if (this.apiKey == null) {
          return void 0;
        }
        return buildHeaders([{ "X-Api-Key": this.apiKey }]);
      }
      async bearerAuth(opts) {
        if (this.authToken == null) {
          return void 0;
        }
        return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }]);
      }
      stringifyQuery(query) {
        return stringifyQuery(query);
      }
      getUserAgent() {
        return `Anthropic/JS ${VERSION2}`;
      }
      defaultIdempotencyKey() {
        return `stainless-node-retry-${uuid4()}`;
      }
      makeStatusError(status, error, message, headers) {
        return APIError.generate(status, error, message, headers);
      }
      buildURL(path5, query, defaultBaseURL) {
        const baseURL = !__classPrivateFieldGet(this, _BaseAnthropic_instances, "m", _BaseAnthropic_baseURLOverridden).call(this) && defaultBaseURL || this.baseURL;
        const url = isAbsoluteURL(path5) ? new URL(path5) : new URL(baseURL + (baseURL.endsWith("/") && path5.startsWith("/") ? path5.slice(1) : path5));
        const defaultQuery = this.defaultQuery();
        const pathQuery = Object.fromEntries(url.searchParams);
        if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) {
          query = { ...pathQuery, ...defaultQuery, ...query };
        }
        if (typeof query === "object" && query && !Array.isArray(query)) {
          url.search = this.stringifyQuery(query);
        }
        return url.toString();
      }
      _calculateNonstreamingTimeout(maxTokens) {
        const defaultTimeout = 10 * 60;
        const expectedTimeout = 60 * 60 * maxTokens / 128e3;
        if (expectedTimeout > defaultTimeout) {
          throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
        }
        return defaultTimeout * 1e3;
      }
      /**
       * Used as a callback for mutating the given `FinalRequestOptions` object.
       */
      async prepareOptions(options) {
      }
      /**
       * Used as a callback for mutating the given `RequestInit` object.
       *
       * This is useful for cases where you want to add certain headers based off of
       * the request properties, e.g. `method` or `url`.
       *
       * Runs after all middleware (including {@link backendMiddleware}),
       * immediately before each underlying fetch call, so it sees exactly what
       * goes over the wire. Middleware may replay a request by calling `next()`
       * more than once, so this hook can run multiple times per attempt:
       * overrides must be idempotent and overwrite headers from a previous
       * invocation rather than append to them.
       */
      async prepareRequest(request, { url, options }) {
        if (this._authState.tokenCache && this.apiKey == null) {
          const headers = request.headers instanceof Headers ? request.headers : new Headers(request.headers);
          for (const [k, v] of Object.entries(this._authState.extraHeaders)) {
            if (!headers.has(k))
              headers.set(k, v);
          }
          const existing = headers.get("anthropic-beta")?.split(",").map((s) => s.trim());
          if (!existing?.includes(OAUTH_API_BETA_HEADER)) {
            headers.append("anthropic-beta", OAUTH_API_BETA_HEADER);
          }
          request.headers = headers;
        }
      }
      /**
       * Internal {@link Middleware} composed innermost in the chain — inside both
       * client-level and per-request middleware, immediately around the underlying
       * `fetch`. Subclasses for third-party backends override this to adapt the
       * canonical Anthropic-shaped request to the backend's wire shape (URL/body
       * rewriting, request signing) and to normalize the wire response back to the
       * canonical shape (e.g. AWS EventStream to SSE).
       *
       * Running inside the user's middleware means user middleware always observes
       * canonical Anthropic-shaped traffic, and the adaptation re-runs (e.g.
       * re-signs) on every `next()` invocation, covering whatever the middleware
       * mutated.
       *
       * Errors thrown here follow the middleware error policy: they propagate to
       * the caller as-is — no retries, no `APIConnectionError` wrapping — unless
       * retryable (see {@link Middleware}); throw a `RetryableError` to opt into
       * the retry path.
       */
      backendMiddleware() {
        return [];
      }
      get(path5, opts) {
        return this.methodRequest("get", path5, opts);
      }
      post(path5, opts) {
        return this.methodRequest("post", path5, opts);
      }
      patch(path5, opts) {
        return this.methodRequest("patch", path5, opts);
      }
      put(path5, opts) {
        return this.methodRequest("put", path5, opts);
      }
      delete(path5, opts) {
        return this.methodRequest("delete", path5, opts);
      }
      methodRequest(method, path5, opts) {
        return this.request(Promise.resolve(opts).then((opts2) => {
          return { method, path: path5, ...opts2 };
        }));
      }
      request(options, remainingRetries = null) {
        return new APIPromise(this, this.makeRequest(options, remainingRetries, void 0));
      }
      async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
        const options = await optionsInput;
        const maxRetries = options.maxRetries ?? this.maxRetries;
        if (retriesRemaining == null) {
          retriesRemaining = maxRetries;
          this._requestAuthFlags.delete(options);
        }
        await this.prepareOptions(options);
        const { req, url, timeout } = await this.buildRequest(options, {
          retryCount: maxRetries - retriesRemaining
        });
        const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
        const retryLogStr = retryOfRequestLogID === void 0 ? "" : `, retryOf: ${retryOfRequestLogID}`;
        const startTime = Date.now();
        if (options.signal?.aborted) {
          throw new APIUserAbortError();
        }
        const controller = new AbortController();
        const response = await this.fetchWithTimeout(url, req, timeout, controller, options, {
          requestLogID,
          retryOfRequestLogID
        }).catch(castToError);
        const headersTime = Date.now();
        if (response instanceof globalThis.Error) {
          releaseRequestSignal(controller);
          const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
          if (options.signal?.aborted) {
            throw new APIUserAbortError();
          }
          const isTimeout = isAbortError(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
          const hasMiddleware = this.middleware.length > 0 || !!options.middleware?.length || this.backendMiddleware().length > 0;
          if (hasMiddleware && !isTimeout && !isRetryableError(response)) {
            loggerFor(this).info(`[${requestLogID}] middleware error (not retryable)`);
            loggerFor(this).debug(`[${requestLogID}] middleware error (not retryable)`, formatRequestDetails({
              retryOfRequestLogID,
              url,
              durationMs: headersTime - startTime,
              message: response.message
            }));
            throw response;
          }
          if (retriesRemaining) {
            loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
            loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, formatRequestDetails({
              retryOfRequestLogID,
              url,
              durationMs: headersTime - startTime,
              message: response.message
            }));
            return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
          }
          loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
          loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, formatRequestDetails({
            retryOfRequestLogID,
            url,
            durationMs: headersTime - startTime,
            message: response.message
          }));
          if (isTimeout) {
            throw new APIConnectionTimeoutError();
          }
          if (hasMiddleware && !isFetchOriginError(response)) {
            throw response;
          }
          throw new APIConnectionError({ cause: response });
        }
        const specialHeaders = [...response.headers.entries()].filter(([name]) => name === "request-id").map(([name, value]) => ", " + name + ": " + JSON.stringify(value)).join("");
        const responseInfo = `[${requestLogID}${retryLogStr}${specialHeaders}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
        if (!response.ok) {
          const shouldRetry = await this.shouldRetry(response, options);
          if (retriesRemaining && shouldRetry) {
            const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
            await CancelReadableStream(response.body);
            releaseRequestSignal(controller);
            loggerFor(this).info(`${responseInfo} - ${retryMessage2}`);
            loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage2})`, formatRequestDetails({
              retryOfRequestLogID,
              url: response.url,
              status: response.status,
              headers: response.headers,
              durationMs: headersTime - startTime
            }));
            return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID, response.headers);
          }
          const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
          loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
          const errText = await response.text().catch((err3) => castToError(err3).message);
          const errJSON = safeJSON(errText);
          const errMessage = errJSON ? void 0 : errText;
          loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage})`, formatRequestDetails({
            retryOfRequestLogID,
            url: response.url,
            status: response.status,
            headers: response.headers,
            message: errMessage,
            durationMs: Date.now() - startTime
          }));
          releaseRequestSignal(controller);
          const err2 = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
          throw err2;
        }
        loggerFor(this).info(responseInfo);
        loggerFor(this).debug(`[${requestLogID}] response start`, formatRequestDetails({
          retryOfRequestLogID,
          url: response.url,
          status: response.status,
          headers: response.headers,
          durationMs: headersTime - startTime
        }));
        armAbandonmentBackstop(response.body ?? response, controller);
        return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
      }
      getAPIList(path5, Page2, opts) {
        return this.requestAPIList(Page2, opts && "then" in opts ? opts.then((opts2) => ({ method: "get", path: path5, ...opts2 })) : { method: "get", path: path5, ...opts });
      }
      requestAPIList(Page2, options) {
        const request = this.makeRequest(options, null, void 0);
        return new PagePromise(this, request, Page2);
      }
      async fetchWithTimeout(url, init, ms, controller, requestOptions, logCtx) {
        const { signal, method, ...options } = init || {};
        const abort = this._makeAbort(controller);
        if (signal) {
          signal.addEventListener("abort", abort, { once: true });
          registerRequestSignalCleanup(controller, signal, abort);
        }
        const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
        const fetchOptions = {
          signal: controller.signal,
          ...isReadableBody ? { duplex: "half" } : {},
          method: "GET",
          ...options
        };
        if (method) {
          fetchOptions.method = method.toUpperCase();
        }
        const baseFetch = this.fetch;
        const timedFetch = async (innerUrl, innerInit) => {
          const timeout = setTimeout(abort, ms);
          try {
            return await baseFetch.call(void 0, innerUrl, innerInit);
          } finally {
            clearTimeout(timeout);
          }
        };
        const innerFetch = requestOptions === void 0 ? timedFetch : (async (innerUrl, innerInit = {}) => {
          const innerUrlStr = typeof innerUrl === "string" ? innerUrl : innerUrl instanceof URL ? innerUrl.href : innerUrl.url;
          innerInit.headers = innerInit.headers instanceof Headers ? innerInit.headers : new Headers(innerInit.headers);
          await this.prepareRequest(innerInit, { url: innerUrlStr, options: requestOptions });
          if (logCtx) {
            loggerFor(this).debug(`[${logCtx.requestLogID}] sending request`, formatRequestDetails({
              retryOfRequestLogID: logCtx.retryOfRequestLogID,
              method: innerInit.method,
              url: innerUrlStr,
              options: requestOptions,
              headers: innerInit.headers
            }));
          }
          return timedFetch(innerUrl, innerInit);
        });
        const requestMiddleware = requestOptions?.middleware;
        const backendMiddleware = this.backendMiddleware();
        const allMiddleware = requestMiddleware?.length || backendMiddleware.length ? [...this.middleware, ...requestMiddleware ?? [], ...backendMiddleware] : this.middleware;
        return await wrapFetchWithMiddleware(innerFetch, allMiddleware, requestOptions, this)(url, fetchOptions);
      }
      async shouldRetry(response, options) {
        const flags = this._authFlags(options);
        if (response.status === 401 && this._authState.tokenCache && flags.usedTokenCache && !flags.didRefreshFor401) {
          flags.didRefreshFor401 = true;
          this._authState.tokenCache.invalidate();
          return true;
        }
        const shouldRetryHeader = response.headers.get("x-should-retry");
        if (shouldRetryHeader === "true")
          return true;
        if (shouldRetryHeader === "false")
          return false;
        if (response.status === 408)
          return true;
        if (response.status === 409)
          return true;
        if (response.status === 429)
          return true;
        if (response.status >= 500)
          return true;
        return false;
      }
      async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
        let timeoutMillis;
        const retryAfterMillisHeader = responseHeaders?.get("retry-after-ms");
        if (retryAfterMillisHeader) {
          const timeoutMs = parseFloat(retryAfterMillisHeader);
          if (!Number.isNaN(timeoutMs)) {
            timeoutMillis = timeoutMs;
          }
        }
        const retryAfterHeader = responseHeaders?.get("retry-after");
        if (retryAfterHeader && !timeoutMillis) {
          const timeoutSeconds = parseFloat(retryAfterHeader);
          if (!Number.isNaN(timeoutSeconds)) {
            timeoutMillis = timeoutSeconds * 1e3;
          } else {
            timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
          }
        }
        if (timeoutMillis === void 0) {
          const maxRetries = options.maxRetries ?? this.maxRetries;
          timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
        }
        await sleep(timeoutMillis);
        return this.makeRequest(options, retriesRemaining - 1, requestLogID);
      }
      calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
        const initialRetryDelay = 0.5;
        const maxRetryDelay = 8;
        const numRetries = maxRetries - retriesRemaining;
        const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
        const jitter2 = 1 - Math.random() * 0.25;
        return sleepSeconds * jitter2 * 1e3;
      }
      calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) {
        const maxTime = 60 * 60 * 1e3;
        const defaultTime = 60 * 10 * 1e3;
        const expectedTime = maxTime * maxTokens / 128e3;
        if (expectedTime > defaultTime || maxNonstreamingTokens != null && maxTokens > maxNonstreamingTokens) {
          throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
        }
        return defaultTime;
      }
      async buildRequest(inputOptions, { retryCount = 0 } = {}) {
        const options = { ...inputOptions };
        const { method, path: path5, query, defaultBaseURL } = options;
        if (this._authState.resolution) {
          await this._authState.resolution;
        }
        if (!this._baseURLIsExplicit && this._authState.baseURL && this.baseURL !== this._authState.baseURL) {
          this.baseURL = this._authState.baseURL;
        }
        const url = this.buildURL(path5, query, defaultBaseURL);
        if ("timeout" in options)
          validatePositiveInteger("timeout", options.timeout);
        options.timeout = options.timeout ?? this.timeout;
        const { bodyHeaders, body } = this.buildBody({ options });
        const reqHeaders = await this.buildHeaders({ options: inputOptions, method, bodyHeaders, retryCount });
        const req = {
          method,
          headers: reqHeaders,
          ...options.signal && { signal: options.signal },
          ...globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" },
          ...body && { body },
          ...this.fetchOptions ?? {},
          ...options.fetchOptions ?? {}
        };
        return { req, url, timeout: options.timeout };
      }
      async buildHeaders({ options, method, bodyHeaders, retryCount }) {
        let idempotencyHeaders = {};
        if (this.idempotencyHeader && method !== "get") {
          if (!options.idempotencyKey)
            options.idempotencyKey = this.defaultIdempotencyKey();
          idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
        }
        const headers = buildHeaders([
          idempotencyHeaders,
          {
            Accept: "application/json",
            "User-Agent": this.getUserAgent(),
            "X-Stainless-Retry-Count": String(retryCount),
            ...options.timeout ? { "X-Stainless-Timeout": String(Math.trunc(options.timeout / 1e3)) } : {},
            ...getPlatformHeaders(),
            ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0,
            "anthropic-version": "2023-06-01"
          },
          await this.authHeaders(options),
          this._options.defaultHeaders,
          bodyHeaders,
          options.headers
        ]);
        this.validateHeaders(headers);
        return headers.values;
      }
      _makeAbort(controller) {
        return () => controller.abort();
      }
      buildBody({ options: { body, headers: rawHeaders } }) {
        if (!body) {
          return { bodyHeaders: void 0, body: void 0 };
        }
        const headers = buildHeaders([rawHeaders]);
        if (
          // Pass raw type verbatim
          ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && // Preserve legacy string encoding behavior for now
          headers.values.has("content-type") || // `Blob` is superset of `File`
          globalThis.Blob && body instanceof globalThis.Blob || // `FormData` -> `multipart/form-data`
          body instanceof FormData || // `URLSearchParams` -> `application/x-www-form-urlencoded`
          body instanceof URLSearchParams || // Send chunked stream (each chunk has own `length`)
          globalThis.ReadableStream && body instanceof globalThis.ReadableStream
        ) {
          return { bodyHeaders: void 0, body };
        } else if (typeof body === "object" && (Symbol.asyncIterator in body || Symbol.iterator in body && "next" in body && typeof body.next === "function")) {
          return { bodyHeaders: void 0, body: ReadableStreamFrom(body) };
        } else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") {
          return {
            bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
            body: this.stringifyQuery(body)
          };
        } else {
          return __classPrivateFieldGet(this, _BaseAnthropic_encoder, "f").call(this, { body, headers });
        }
      }
    };
    _a = BaseAnthropic, _BaseAnthropic_encoder = /* @__PURE__ */ new WeakMap(), _BaseAnthropic_instances = /* @__PURE__ */ new WeakSet(), _BaseAnthropic_baseURLOverridden = function _BaseAnthropic_baseURLOverridden2() {
      return this.baseURL !== "https://api.anthropic.com";
    };
    BaseAnthropic.Anthropic = _a;
    BaseAnthropic.HUMAN_PROMPT = HUMAN_PROMPT;
    BaseAnthropic.AI_PROMPT = AI_PROMPT;
    BaseAnthropic.DEFAULT_TIMEOUT = 6e5;
    BaseAnthropic.AnthropicError = AnthropicError;
    BaseAnthropic.APIError = APIError;
    BaseAnthropic.APIConnectionError = APIConnectionError;
    BaseAnthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
    BaseAnthropic.APIUserAbortError = APIUserAbortError;
    BaseAnthropic.NotFoundError = NotFoundError;
    BaseAnthropic.ConflictError = ConflictError;
    BaseAnthropic.RateLimitError = RateLimitError;
    BaseAnthropic.BadRequestError = BadRequestError;
    BaseAnthropic.AuthenticationError = AuthenticationError;
    BaseAnthropic.InternalServerError = InternalServerError;
    BaseAnthropic.PermissionDeniedError = PermissionDeniedError;
    BaseAnthropic.UnprocessableEntityError = UnprocessableEntityError;
    BaseAnthropic.toFile = toFile;
    Anthropic = class extends BaseAnthropic {
      constructor() {
        super(...arguments);
        this.completions = new Completions(this);
        this.messages = new Messages2(this);
        this.models = new Models2(this);
        this.beta = new Beta(this);
      }
    };
    Anthropic.Completions = Completions;
    Anthropic.Messages = Messages2;
    Anthropic.Models = Models2;
    Anthropic.Beta = Beta;
  }
});

// node_modules/@anthropic-ai/sdk/lib/middleware.mjs
var encoder;
var init_middleware2 = __esm({
  "node_modules/@anthropic-ai/sdk/lib/middleware.mjs"() {
    init_error();
    init_streaming();
    init_errors();
    init_headers();
    init_stainless_helper_header();
    init_values();
    init_request_options();
    encoder = new TextEncoder();
  }
});

// node_modules/@anthropic-ai/sdk/index.mjs
var init_sdk = __esm({
  "node_modules/@anthropic-ai/sdk/index.mjs"() {
    init_client();
    init_uploads2();
    init_api_promise();
    init_middleware2();
    init_client();
    init_pagination();
    init_error();
  }
});

// src/cli.ts
import { createInterface as createInterface2 } from "node:readline/promises";
import { existsSync as existsSync7, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname7, join as join10, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir as homedir4 } from "node:os";

// src/box/docker.ts
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// src/protocol/index.ts
var BOXD_PORT = 1337;
var UI_PORT = 7777;
var DEFAULT_DISPLAY_INDEX = 1;

// src/box/client.ts
var BoxError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "BoxError";
  }
};
var DEFAULT_TIMEOUT_MS = 6e4;
var COMPUTER_TIMEOUT_MS = 18e4;
var BoxClient = class {
  baseUrl;
  token;
  timeoutMs;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  async post(path5, body, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path5}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new BoxError(
          `Box returned non-JSON on ${path5} (HTTP ${response.status}): ${text.slice(0, 200)}`,
          response.status
        );
      }
      if (!response.ok) {
        const message = parsed.error ?? `HTTP ${response.status}`;
        throw new BoxError(`${path5}: ${message}`, response.status);
      }
      return parsed;
    } catch (error) {
      if (error instanceof BoxError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new BoxError(`${path5} timed out after ${timeoutMs}ms`);
      }
      throw new BoxError(
        `${path5} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async health(timeoutMs = 5e3) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal
      });
      if (!response.ok) {
        throw new BoxError(`health: HTTP ${response.status}`, response.status);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof BoxError) throw error;
      throw new BoxError(
        `health failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
  computer(actions, options = {}) {
    return this.post(
      "/computer",
      {
        actions,
        display: options.display,
        owner: options.owner,
        bind_unmapped_characters: options.bindUnmappedCharacters ?? true
      },
      COMPUTER_TIMEOUT_MS
    );
  }
  /** Brings up an agent's desktop, or adopts it if already running. */
  ensureDisplay(index, owner) {
    return this.post("/displays/ensure", { index, owner }, 12e4);
  }
  exec(command, options = {}) {
    const commandTimeout = options.timeoutMs ?? 12e4;
    return this.post(
      "/exec",
      {
        command,
        cwd: options.cwd,
        timeout_ms: commandTimeout,
        session: options.session,
        display: options.display,
        owner: options.owner
      },
      // Give the HTTP layer headroom over the command's own timeout, so a
      // command that times out reports its output instead of aborting the request.
      commandTimeout + 15e3
    );
  }
  /** What is on a desktop's clipboard. Empty when nothing owns the selection. */
  readClipboard(display) {
    return this.post("/clipboard/read", { display });
  }
  /** Puts text on a desktop's clipboard, ready for the user or agent to paste. */
  writeClipboard(text, display) {
    return this.post("/clipboard/write", { display, text });
  }
  /** Starts recording a desktop. One recording per desktop at a time. */
  startRecording(options = {}) {
    return this.post("/record/start", {
      display: options.display,
      name: options.name,
      framerate: options.framerate,
      draw_mouse: options.drawMouse
    });
  }
  /** Stops it and returns the finished file. Waits for ffmpeg to write its trailer. */
  stopRecording(display) {
    return this.post("/record/stop", { display }, 3e4);
  }
  listRecordings() {
    return this.post("/recordings", {});
  }
  readFile(path5, range = {}) {
    return this.post("/fs/read", {
      path: path5,
      start_line: range.startLine,
      end_line: range.endLine
    });
  }
  writeFile(path5, content) {
    return this.post("/fs/write", { path: path5, content });
  }
  listDir(path5) {
    return this.post("/fs/list", { path: path5 });
  }
};

// src/box/docker.ts
var execFileAsync = promisify(execFile);
var DEFAULT_IMAGE = "agentbox/box:latest";
var DEFAULT_CONTAINER = "agentbox-box";
function loadBoxToken() {
  const existing = readBoxToken();
  if (existing) return existing;
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
  const path5 = join(home, "token");
  const token = generateToken();
  mkdirSync(home, { recursive: true });
  writeFileSync(path5, `${token}
`, { mode: 384 });
  return token;
}
function readBoxToken() {
  if (process.env.AGENTBOX_TOKEN) return process.env.AGENTBOX_TOKEN;
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
  const path5 = join(home, "token");
  if (!existsSync(path5)) return void 0;
  const existing = readFileSync(path5, "utf8").trim();
  return existing || void 0;
}
function defaultBoxConfig(overrides = {}) {
  return {
    containerName: process.env.AGENTBOX_CONTAINER ?? DEFAULT_CONTAINER,
    image: process.env.AGENTBOX_IMAGE ?? DEFAULT_IMAGE,
    boxdPort: Number(process.env.AGENTBOX_BOXD_PORT ?? 0),
    token: loadBoxToken(),
    host: process.env.AGENTBOX_BOX_HOST ?? resolveDockerHostAddress(),
    displayWidth: Number(process.env.AGENTBOX_WIDTH ?? 1280),
    displayHeight: Number(process.env.AGENTBOX_HEIGHT ?? 800),
    runArgs: [],
    withHost: process.env.AGENTBOX_HOST_ENABLED === "1",
    ...overrides
  };
}
function resolveDockerHostAddress(dockerHost = process.env.DOCKER_HOST) {
  if (!dockerHost) return "127.0.0.1";
  if (/^(unix|npipe):/.test(dockerHost)) return "127.0.0.1";
  try {
    const url = new URL(dockerHost.replace(/^tcp:/, "http:"));
    return url.hostname || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}
function generateToken() {
  return randomBytes(32).toString("hex");
}
var DockerError = class extends Error {
  constructor(message, stderr = "") {
    super(message);
    this.stderr = stderr;
    this.name = "DockerError";
  }
};
async function docker(args, timeoutMs = 12e4) {
  try {
    const { stdout } = await execFileAsync("docker", [...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024
    });
    return stdout.trim();
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim();
    const message = stderr || error.message;
    throw new DockerError(`docker ${args[0]} failed: ${message}`, stderr);
  }
}
function uiToken() {
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
  const path5 = join(home, "ui-token");
  if (existsSync(path5)) {
    const existing = readFileSync(path5, "utf8").trim();
    if (existing) return existing;
  }
  const token = generateToken();
  mkdirSync(home, { recursive: true });
  writeFileSync(path5, `${token}
`, { mode: 384 });
  return token;
}
function hostCredentialArgs() {
  const names = [
    "ANTHROPIC_API_KEY",
    "MINIMAX_CODE_CN_API_KEY",
    "AGENTBOX_API_KEY",
    "AGENTBOX_BASE_URL",
    "AGENTBOX_MODEL",
    "AGENTBOX_PROVIDER",
    "AGENTBOX_KEY_ENV",
    "AGENTBOX_AUTH"
  ];
  return names.flatMap((name) => {
    const value = process.env[name];
    return value ? ["--env", `${name}=${value}`] : [];
  });
}
var BoxManager = class {
  constructor(config) {
    this.config = config;
  }
  async dockerAvailable() {
    try {
      await docker(["version", "--format", "{{.Server.Version}}"], 15e3);
      return true;
    } catch {
      return false;
    }
  }
  async state() {
    try {
      const out2 = await docker(
        [
          "inspect",
          "--format",
          "{{.State.Status}}",
          this.config.containerName
        ],
        2e4
      );
      return out2 || "missing";
    } catch (error) {
      if (error instanceof DockerError && /No such object|no such container/i.test(error.stderr)) {
        return "missing";
      }
      throw error;
    }
  }
  /** Resolves the host port Docker assigned to a container port. */
  async publishedPort(containerPort) {
    try {
      const out2 = await docker(
        ["port", this.config.containerName, `${containerPort}/tcp`],
        2e4
      );
      const match = /:(\d+)\s*$/m.exec(out2);
      return match ? Number(match[1]) : void 0;
    } catch {
      return void 0;
    }
  }
  async status() {
    const state = await this.state();
    const status = { state, containerName: this.config.containerName };
    if (state !== "running") return status;
    const boxdPort = await this.publishedPort(BOXD_PORT);
    if (boxdPort) status.boxdUrl = `http://${this.config.host}:${boxdPort}`;
    const port = await this.publishedPort(UI_PORT);
    if (port) status.uiUrl = `http://${this.config.host}:${port}`;
    return status;
  }
  async imageExists() {
    try {
      await docker(["image", "inspect", this.config.image], 2e4);
      return true;
    } catch {
      return false;
    }
  }
  /** Builds the box image from the given context directory. */
  async build(contextDir, onOutput) {
    onOutput?.(`building ${this.config.image} from ${contextDir}`);
    await docker(
      ["build", "-t", this.config.image, contextDir],
      20 * 6e4
    );
    onOutput?.(`built ${this.config.image}`);
  }
  runArguments() {
    const { config } = this;
    const publish = (hostPort, containerPort) => hostPort > 0 ? `${hostPort}:${containerPort}` : `${containerPort}`;
    const publishOn = (address, hostPort, containerPort) => hostPort > 0 ? `${address}:${hostPort}:${containerPort}` : `${address}::${containerPort}`;
    return [
      "run",
      "--detach",
      "--name",
      config.containerName,
      // Only the daemon is published. It proxies every desktop's noVNC, so the
      // number of desktops is not fixed by port mappings chosen at create time.
      "--publish",
      publish(config.boxdPort, BOXD_PORT),
      "--env",
      `BOXD_TOKEN=${config.token}`,
      "--env",
      `DISPLAY_WIDTH=${config.displayWidth}`,
      "--env",
      `DISPLAY_HEIGHT=${config.displayHeight}`,
      // Chrome and friends need more than Docker's default 64MB of /dev/shm.
      "--shm-size",
      "1g",
      // The services inside are supervised and restarted in place; this is for the case
      // where one of them cannot be kept alive at all, and for the engine restarting.
      // unless-stopped rather than always, so `box down` stays down.
      "--restart",
      "unless-stopped",
      // The box runs a desktop and a browser; without this a runaway page can
      // starve the engine host.
      "--memory",
      process.env.AGENTBOX_MEMORY ?? "4g",
      // A ceiling, if one is wanted. Unset by default: the split that matters is inside
      // the box — the desktop ahead of the agent's work — and a wrong number here just
      // makes the agent slow for no reason. Set it when a box shares a machine.
      ...process.env.AGENTBOX_CPUS ? ["--cpus", process.env.AGENTBOX_CPUS] : [],
      // Egress, when a relay was named. host.docker.internal resolves on Docker Desktop
      // already; the mapping is what makes the same name work on a Linux engine, so the
      // relay address does not have to change per platform.
      ...process.env.AGENTBOX_EGRESS_RELAY ? [
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `AGENTBOX_EGRESS_RELAY=${process.env.AGENTBOX_EGRESS_RELAY}`,
        ...process.env.AGENTBOX_EGRESS_TOKEN ? ["--env", `AGENTBOX_EGRESS_TOKEN=${process.env.AGENTBOX_EGRESS_TOKEN}`] : []
      ] : [],
      // Two named volumes, because everything else in the container is disposable and
      // these two things are not: what the agents made, and what they logged into.
      // Without them, `box up --recreate` — which is also what upgrading the image
      // means — silently destroys both.
      //
      // The system layer stays ephemeral on purpose, so a rebuilt image really does
      // deliver a fresh box. The image's own config files are re-seeded into the
      // config volume on every start (see entrypoint.sh), or an old volume would
      // shadow them forever.
      "--volume",
      `${config.containerName}-work:/home/box/work`,
      "--volume",
      `${config.containerName}-config:/home/box/.config`,
      ...config.withHost ? [
        // The orchestrator's own state — transcripts, agent profiles, owner tokens —
        // on its own volume, so it outlives the container like the agents' work does.
        "--volume",
        `${config.containerName}-hostd:/home/hostd/.agentbox`,
        "--env",
        "AGENTBOX_HOST_ENABLED=1",
        // Generated here rather than in the container, so the CLI can print a URL that
        // works. Inside the box the UI binds 0.0.0.0 — Docker's publish address is all
        // that keeps it local — so it must not be open.
        "--env",
        `AGENTBOX_UI_TOKEN=${config.uiToken ?? uiToken()}`,
        // Published to loopback only. The UI has no authentication — the assumption
        // has always been that anything able to reach it can already drive the
        // agents — so it must not be reachable from the network.
        "--publish",
        publishOn("127.0.0.1", config.uiPort ?? UI_PORT, UI_PORT),
        ...hostCredentialArgs()
      ] : [],
      ...config.runArgs,
      config.image
    ];
  }
  /**
   * Brings the box up and waits for the daemon to answer.
   *
   * Idempotent: an already-running container is reused, a stopped one is started.
   */
  async up(options = {}) {
    const { onOutput } = options;
    if (!this.config.token) {
      throw new DockerError(
        "No box token configured. Set AGENTBOX_TOKEN, or let `agentbox box up` generate one."
      );
    }
    if (!await this.dockerAvailable()) {
      throw new DockerError(
        "Cannot reach a Docker engine. Check `docker version`, DOCKER_HOST, and your docker context."
      );
    }
    let state = await this.state();
    if (options.recreate && state !== "missing") {
      onOutput?.(`removing existing container ${this.config.containerName}`);
      await this.down({ remove: true });
      state = "missing";
    }
    if (state === "missing") {
      if (!await this.imageExists()) {
        throw new DockerError(
          `Image ${this.config.image} not found. Run \`agentbox box build\` first.`
        );
      }
      onOutput?.(`starting container ${this.config.containerName}`);
      await docker(this.runArguments(), 12e4);
    } else if (state === "exited" || state === "created") {
      onOutput?.(`restarting container ${this.config.containerName}`);
      await docker(["start", this.config.containerName], 6e4);
    } else if (state === "paused") {
      await docker(["unpause", this.config.containerName], 3e4);
    } else if (state !== "running") {
      throw new DockerError(
        `Container ${this.config.containerName} is in state "${state}"; resolve it manually or re-run with --recreate.`
      );
    }
    const status = await this.status();
    if (!status.boxdUrl) {
      throw new DockerError(
        `Container is running but port ${BOXD_PORT} is not published. It may have been created outside agentbox; re-run with --recreate.`
      );
    }
    const client = new BoxClient({ baseUrl: status.boxdUrl, token: this.config.token });
    await this.waitForHealthy(client, onOutput);
    if (this.config.withHost === true && status.uiUrl !== void 0) {
      await this.waitForUi(status.uiUrl, onOutput);
    }
    return { client, status };
  }
  /**
   * Polls the in-box orchestrator's UI until it answers.
   *
   * A box whose desktop is up is not a box a person can use: the orchestrator starts after X, and
   * for a second or two the published port accepts a connection and then nothing serves it. Found
   * by allocating two boxes for real and watching the second one's UI refuse a request that the
   * first one — allocated seconds earlier — had answered.
   *
   * A 401 counts as answering, for the same reason it does in `box-healthcheck`: a UI that refuses
   * an unauthenticated request correctly is a UI that is serving.
   */
  async waitForUi(uiUrl, onOutput, timeoutMs = 6e4) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "not yet listening";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(uiUrl, {
          redirect: "manual",
          signal: AbortSignal.timeout(4e3)
        });
        if (response.status < 500) {
          onOutput?.(`orchestrator answering on ${uiUrl}`);
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve5) => setTimeout(resolve5, 500));
    }
    throw new DockerError(
      `Box desktop is up but its orchestrator never answered on ${uiUrl} within ${timeoutMs / 1e3}s (last: ${lastError}). Check \`docker logs ${this.config.containerName}\`.`
    );
  }
  /** Polls /health until the daemon reports a usable display. */
  async waitForHealthy(client, onOutput, timeoutMs = 9e4) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    let announcedWait = false;
    while (Date.now() < deadline) {
      try {
        const health = await client.health(4e3);
        if (health.resolution) {
          onOutput?.(
            `box ready: display ${health.display} at ${health.resolution.display.width}x${health.resolution.display.height}`
          );
          return;
        }
        lastError = "display not ready";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (!announcedWait) {
        onOutput?.("waiting for the box desktop to come up");
        announcedWait = true;
      }
      await new Promise((resolve5) => setTimeout(resolve5, 1e3));
    }
    throw new DockerError(
      `Box did not become healthy within ${timeoutMs / 1e3}s (last: ${lastError}). Check \`docker logs ${this.config.containerName}\`.`
    );
  }
  async down(options = {}) {
    const state = await this.state();
    if (state === "missing") return;
    if (state === "running" || state === "paused" || state === "restarting") {
      await docker(["stop", "--timeout", "10", this.config.containerName], 6e4);
    }
    if (options.remove) {
      await docker(["rm", "--force", this.config.containerName], 6e4);
    }
  }
  logs(tail = 200) {
    return docker(["logs", "--tail", String(tail), this.config.containerName], 3e4);
  }
  /** A client for an already-running box, without touching its lifecycle. */
  async connect() {
    const status = await this.status();
    if (status.state !== "running" || !status.boxdUrl) {
      throw new DockerError(
        `Box ${this.config.containerName} is not running (state: ${status.state}). Run \`agentbox box up\`.`
      );
    }
    return new BoxClient({ baseUrl: status.boxdUrl, token: this.config.token });
  }
};

// src/agents/registry.ts
import { randomBytes as randomBytes2, randomUUID } from "node:crypto";
import {
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  readdirSync,
  renameSync,
  writeFileSync as writeFileSync2,
  existsSync as existsSync2,
  appendFileSync
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var AGENT_NAME_MAX_LENGTH = 72;
var AGENT_DESCRIPTION_MAX_LENGTH = 2e3;
var PROFILE_FILENAME = "profile.json";
var TRANSCRIPT_FILENAME = "conversation.jsonl";
var MEMORY_FILENAME = "memory.md";
var BOX_OWNER_FILENAME = "box-owner";
function clampLine(raw, max) {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}
function clampBlock(raw, max) {
  return raw.trim().slice(0, max);
}
function defaultAgentsRoot() {
  return process.env.AGENTBOX_AGENTS_DIR ?? join2(process.env.AGENTBOX_HOME ?? join2(homedir2(), ".agentbox"), "agents");
}
var AgentNotFoundError = class extends Error {
  constructor(agentId) {
    super(`No agent found with id ${agentId}.`);
    this.agentId = agentId;
    this.name = "AgentNotFoundError";
  }
};
var AgentRegistry = class {
  constructor(root = defaultAgentsRoot()) {
    this.root = root;
    mkdirSync2(this.root, { recursive: true });
  }
  dirFor(agentId) {
    return join2(this.root, agentId);
  }
  profilePathFor(agentId) {
    return join2(this.dirFor(agentId), PROFILE_FILENAME);
  }
  transcriptPathFor(agentId) {
    return join2(this.dirFor(agentId), TRANSCRIPT_FILENAME);
  }
  memoryPathFor(agentId) {
    return join2(this.dirFor(agentId), MEMORY_FILENAME);
  }
  /**
   * Writes a profile atomically.
   *
   * Temp file plus rename, because a reader that catches a half-written
   * profile.json would see invalid JSON — and the agent directory is read on
   * every prompt assembly, so that window gets hit.
   */
  writeProfile(agentId, profile) {
    const dir = this.dirFor(agentId);
    mkdirSync2(dir, { recursive: true });
    const path5 = join2(dir, PROFILE_FILENAME);
    const temp = `${path5}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync2(temp, `${JSON.stringify(profile, null, 2)}
`, "utf8");
    renameSync(temp, path5);
  }
  has(agentId) {
    return existsSync2(this.profilePathFor(agentId));
  }
  get(agentId) {
    const record = this.tryGet(agentId);
    if (!record) throw new AgentNotFoundError(agentId);
    return record;
  }
  tryGet(agentId) {
    const path5 = this.profilePathFor(agentId);
    if (!existsSync2(path5)) return void 0;
    try {
      const profile = JSON.parse(readFileSync2(path5, "utf8"));
      return { id: agentId, profile, dir: this.dirFor(agentId) };
    } catch {
      return void 0;
    }
  }
  /** All agents, including hidden ones, sorted by name. */
  list() {
    let ids;
    try {
      ids = readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
    return ids.map((id) => this.tryGet(id)).filter((record) => record !== void 0).sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  }
  /** Resolves an id, or a unique case-insensitive name match. */
  resolve(idOrName) {
    const direct = this.tryGet(idOrName);
    if (direct) return direct;
    const needle = idOrName.trim().toLowerCase();
    const matches = this.list().filter(
      (record) => record.profile.name.toLowerCase() === needle
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `"${idOrName}" matches ${matches.length} agents. Use an id: ` + matches.map((m) => m.id).join(", ")
      );
    }
    throw new AgentNotFoundError(idOrName);
  }
  /** The lowest display index no agent holds, so a deleted agent's slot is reused. */
  nextDisplayIndex() {
    const taken = new Set(
      this.list().map((record) => record.profile.displayIndex).filter((index) => typeof index === "number")
    );
    for (let index = 1; index <= 32; index++) {
      if (!taken.has(index)) return index;
    }
    throw new Error("No free desktop: all 32 display slots are assigned.");
  }
  create(input) {
    const name = clampLine(input.name ?? "", AGENT_NAME_MAX_LENGTH);
    if (!name) throw new Error("An agent needs a non-empty name.");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = randomUUID();
    const profile = {
      name,
      description: clampBlock(input.description ?? "", AGENT_DESCRIPTION_MAX_LENGTH),
      title: input.title ? clampLine(input.title, 64) : void 0,
      avatarColor: input.avatarColor,
      hidden: input.hidden ?? false,
      displayIndex: this.nextDisplayIndex(),
      createdAt: now,
      updatedAt: now
    };
    this.writeProfile(id, profile);
    return { id, profile, dir: this.dirFor(id) };
  }
  /**
   * Merges changes into an existing profile.
   *
   * Only provided fields change; there is deliberately no way to blank a name or
   * delete an agent through this path, so a confused agent cannot destroy a
   * teammate. Deletion is a human action.
   */
  update(agentId, changes) {
    const existing = this.get(agentId);
    const profile = { ...existing.profile };
    if (changes.name !== void 0) {
      const name = clampLine(changes.name, AGENT_NAME_MAX_LENGTH);
      if (name) profile.name = name;
    }
    if (changes.description !== void 0) {
      profile.description = clampBlock(
        changes.description,
        AGENT_DESCRIPTION_MAX_LENGTH
      );
    }
    if (changes.title !== void 0) profile.title = clampLine(changes.title, 64);
    if (changes.avatarColor !== void 0) profile.avatarColor = changes.avatarColor;
    if (changes.hidden !== void 0) profile.hidden = changes.hidden;
    profile.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.writeProfile(agentId, profile);
    return { id: agentId, profile, dir: this.dirFor(agentId) };
  }
  /**
   * The agent's desktop, assigning one if it predates per-agent displays.
   *
   * Backfilled rather than defaulted, so an older agent gets a desktop of its own
   * instead of quietly sharing display 1 with everyone else.
   */
  displayIndexFor(agentId) {
    const record = this.get(agentId);
    if (typeof record.profile.displayIndex === "number") {
      return record.profile.displayIndex;
    }
    const assigned = this.nextDisplayIndex();
    this.writeProfile(agentId, {
      ...record.profile,
      displayIndex: assigned,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    return assigned;
  }
  /**
   * The agent's claim on its own desktop.
   *
   * Bound to a display in the box, which then refuses input carrying anyone else's token.
   * The reason it is needed: BOXD_TOKEN is what authorises a box request, and an agent
   * with a shell can reach the daemon directly — so nothing stopped one agent from
   * naming another's display and typing into it. Demonstrated, not theorised.
   *
   * Kept on the host, next to the agent's other state, because the box must not be able
   * to read it. Persisted rather than per-process so a restarted host rebinds the same
   * token instead of being locked out of a display it already owns.
   *
   * This is an accident guard, not a security boundary. Agents share a filesystem by
   * design and can already read each other's profiles or kill each other's processes;
   * what this removes is a whole class of silent interference.
   */
  boxOwnerTokenFor(agentId) {
    const path5 = join2(this.dirFor(agentId), BOX_OWNER_FILENAME);
    if (existsSync2(path5)) {
      const existing = readFileSync2(path5, "utf8").trim();
      if (existing) return existing;
    }
    const token = randomBytes2(16).toString("hex");
    mkdirSync2(this.dirFor(agentId), { recursive: true });
    writeFileSync2(path5, `${token}
`, { encoding: "utf8", mode: 384 });
    return token;
  }
  /**
   * The token for whichever agent owns this desktop, if any.
   *
   * Here so host-side callers — the CLI, the web UI, the smoke test — can present the
   * right claim. The host holds every token; the box holds none. That asymmetry is the
   * whole design: a person driving their own box is never locked out of it, while an
   * agent inside the box cannot produce a claim it was not given.
   */
  boxOwnerTokenForDisplay(index) {
    const owner = this.list().find((record) => record.profile.displayIndex === index);
    return owner ? this.boxOwnerTokenFor(owner.id) : void 0;
  }
  readMemory(agentId) {
    const path5 = this.memoryPathFor(agentId);
    if (!existsSync2(path5)) return "";
    try {
      return readFileSync2(path5, "utf8");
    } catch {
      return "";
    }
  }
  writeMemory(agentId, content) {
    mkdirSync2(this.dirFor(agentId), { recursive: true });
    const path5 = this.memoryPathFor(agentId);
    const temp = `${path5}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync2(temp, content, "utf8");
    renameSync(temp, path5);
  }
  appendTranscript(agentId, entry) {
    mkdirSync2(this.dirFor(agentId), { recursive: true });
    appendFileSync(
      this.transcriptPathFor(agentId),
      `${JSON.stringify(entry)}
`,
      "utf8"
    );
  }
  readTranscript(agentId) {
    const path5 = this.transcriptPathFor(agentId);
    if (!existsSync2(path5)) return [];
    return readFileSync2(path5, "utf8").split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
};

// src/egress/relay.ts
import { createServer, connect as netConnect } from "node:net";

// src/egress/protocol.ts
var PROTOCOL = "AGENTBOX-EGRESS";
var VERSION = 1;
var MAX_PREAMBLE_BYTES = 4096;
var EgressProtocolError = class extends Error {
};
var HOST_PATTERN = /^[A-Za-z0-9._:\-[\]]{1,253}$/;
function decodeRequest(buffer) {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) {
    if (buffer.length > MAX_PREAMBLE_BYTES) {
      throw new EgressProtocolError("Preamble is too long to be one");
    }
    return void 0;
  }
  const lines = buffer.subarray(0, end).toString("utf8").split("\r\n");
  const [greeting = "", ...headers] = lines;
  const match = new RegExp(`^${PROTOCOL} (\\d+)$`).exec(greeting);
  if (!match) throw new EgressProtocolError("Not an egress stream");
  if (Number(match[1]) !== VERSION) {
    throw new EgressProtocolError(`Unsupported version ${match[1]}`);
  }
  let token;
  let target;
  for (const line of headers) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name === "authorization") token = value;
    if (name === "host") target = value;
  }
  if (!token) throw new EgressProtocolError("No token");
  if (!target) throw new EgressProtocolError("No host");
  const split = target.lastIndexOf(":");
  if (split <= 0) throw new EgressProtocolError(`No port in ${JSON.stringify(target)}`);
  const host = target.slice(0, split);
  const port = Number(target.slice(split + 1));
  if (!HOST_PATTERN.test(host)) {
    throw new EgressProtocolError(`Not a host: ${JSON.stringify(host)}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EgressProtocolError(`Not a port: ${JSON.stringify(target.slice(split + 1))}`);
  }
  return { request: { token, host, port }, rest: buffer.subarray(end + 4) };
}
function encodeResponse(ok, detail = "") {
  return ok ? `${PROTOCOL} 200 OK\r
\r
` : `${PROTOCOL} 502 ${detail.replace(/[\r\n]+/g, " ").slice(0, 200)}\r
\r
`;
}

// src/egress/relay.ts
var DEFAULT_PORT = 8790;
var PREAMBLE_TIMEOUT_MS = 1e4;
var RelayError = class extends Error {
};
function startEgressRelay(options) {
  if (!options.token || options.token.length < 16) {
    throw new RelayError(
      "The relay needs a token of at least 16 characters. Without one it is an open proxy for anything that can reach it."
    );
  }
  const log = options.log ?? (() => {
  });
  const allow = options.allow ?? [];
  const server = createServer((box) => {
    box.setNoDelay(true);
    box.setTimeout(PREAMBLE_TIMEOUT_MS, () => box.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      let decoded;
      try {
        decoded = decodeRequest(head);
      } catch (error) {
        log(`relay: rejected a stream (${describe(error)})`);
        box.destroy();
        return;
      }
      if (!decoded) return;
      box.off("data", onData);
      box.setTimeout(0);
      const { request, rest } = decoded;
      if (request.token !== options.token) {
        log(`relay: wrong token for ${request.host}:${request.port}`);
        box.end(encodeResponse(false, "unauthorized"));
        return;
      }
      if (!permitted(request, allow)) {
        log(`relay: ${request.host}:${request.port} is not in the allow list`);
        box.end(encodeResponse(false, "not allowed"));
        return;
      }
      const upstream = netConnect(request.port, request.host);
      upstream.setNoDelay(true);
      upstream.on("connect", () => {
        log(`relay: ${request.host}:${request.port}`);
        box.write(encodeResponse(true));
        if (rest.length > 0) upstream.write(rest);
        upstream.pipe(box);
        box.pipe(upstream);
      });
      upstream.on("error", (error) => {
        box.end(encodeResponse(false, describe(error)));
        upstream.destroy();
      });
      box.on("error", () => {
        upstream.destroy();
        box.destroy();
      });
    };
    box.on("data", onData);
    box.on("error", () => box.destroy());
  });
  const host = options.host ?? "127.0.0.1";
  server.listen(options.port ?? DEFAULT_PORT, host, () => {
    log(
      `egress relay on ${host}:${options.port ?? DEFAULT_PORT}` + (allow.length > 0 ? `, allowing ${allow.join(", ")}` : ", allowing anywhere")
    );
  });
  return server;
}
function permitted(request, allow) {
  if (allow.length === 0) return true;
  return allow.some((pattern) => {
    const [patternHost, patternPort] = splitPattern(pattern);
    if (patternPort !== void 0 && patternPort !== request.port) return false;
    if (patternHost === "*") return true;
    if (patternHost.startsWith("*.")) {
      const suffix = patternHost.slice(1);
      return request.host === patternHost.slice(2) || request.host.endsWith(suffix);
    }
    return request.host === patternHost;
  });
}
function splitPattern(pattern) {
  const at = pattern.lastIndexOf(":");
  if (at <= 0) return [pattern, void 0];
  const port = Number(pattern.slice(at + 1));
  if (!Number.isInteger(port)) return [pattern, void 0];
  return [pattern.slice(0, at), port];
}
function describe(error) {
  if (error instanceof EgressProtocolError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

// src/host/orchestrator.ts
init_sdk();

// src/agents/bus.ts
var AGENT_MESSAGE_MAX_LENGTH = 8e3;
var AGENT_WAKE_CUE = "[agent]";
var AgentBus = class {
  constructor(registry2, runTurn2, onEvent = () => {
  }) {
    this.registry = registry2;
    this.runTurn = runTurn2;
    this.onEvent = onEvent;
  }
  pending = /* @__PURE__ */ new Map();
  /** Tail of each agent's serialized turn chain. Never rejects. */
  chains = /* @__PURE__ */ new Map();
  active = /* @__PURE__ */ new Map();
  /** Agents with a wake already queued, so a burst collapses into one turn. */
  wakeScheduled = /* @__PURE__ */ new Set();
  /**
   * Delivers a message to another agent and wakes it.
   *
   * Returns the acknowledgement string the sending agent sees as its tool result.
   */
  send(input) {
    const text = clampBlock(input.text ?? "", AGENT_MESSAGE_MAX_LENGTH);
    if (text.length === 0) return "Message was empty; nothing was sent.";
    if (input.toId === input.fromId) {
      return "An agent can't message itself. Reply to the user instead, or pick a different target id.";
    }
    const target = this.registry.tryGet(input.toId);
    if (!target) return `No agent found with id ${input.toId}.`;
    const sender = this.registry.tryGet(input.fromId);
    const fromName = sender?.profile.name ?? input.fromId;
    const priority = input.priority ?? false;
    const message = {
      fromId: input.fromId,
      fromName,
      text,
      priority,
      receivedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.enqueue(input.toId, message);
    this.onEvent({
      type: "message_sent",
      fromId: input.fromId,
      fromName,
      toId: target.id,
      toName: target.profile.name,
      priority,
      text
    });
    void this.wake(target.id);
    return priority ? `Sent to ${target.profile.name} as a priority message \u2014 it interrupts their current non-user work and wakes them now. Delivery is asynchronous: if they reply it will arrive later as a new message that wakes you. Don't wait on it.` : `Sent to ${target.profile.name}. Delivery is asynchronous: if they reply it will arrive later as a new message that wakes you. Don't wait on it.`;
  }
  /** Queues an inbound message and interrupts the recipient if it is priority. */
  enqueue(agentId, message) {
    const queue = this.pending.get(agentId) ?? [];
    queue.push(message);
    this.pending.set(agentId, queue);
    if (!message.priority) return;
    const running = this.active.get(agentId);
    if (running && !running.userDriven) {
      this.onEvent({ type: "turn_interrupted", agentId, reason: "priority_message" });
      running.controller.abort();
    }
  }
  /** Injects a message from the user (or an operator) into an agent's queue. */
  sendFromUser(agentId, text) {
    this.enqueue(agentId, {
      fromId: "user",
      fromName: "user",
      text: clampBlock(text, AGENT_MESSAGE_MAX_LENGTH),
      priority: false,
      receivedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  drain(agentId) {
    const queue = this.pending.get(agentId) ?? [];
    this.pending.delete(agentId);
    return queue;
  }
  pendingCount(agentId) {
    return this.pending.get(agentId)?.length ?? 0;
  }
  /**
   * Runs a turn for an agent, serialized against any turn already in flight.
   *
   * `userDriven` turns are protected from priority interrupts.
   */
  async runExclusive(agentId, options = {}) {
    const agent = this.registry.tryGet(agentId);
    if (!agent) throw new AgentNotFoundError(agentId);
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    const run = (async () => {
      await previous;
      const controller = new AbortController();
      this.active.set(agentId, {
        controller,
        userDriven: options.userDriven ?? false
      });
      try {
        const inbound = this.drain(agentId);
        this.onEvent({ type: "turn_started", agentId, inboundCount: inbound.length });
        await this.runTurn(agent, inbound, controller.signal);
        this.onEvent({ type: "turn_finished", agentId });
      } finally {
        if (this.active.get(agentId)?.controller === controller) {
          this.active.delete(agentId);
        }
      }
    })();
    this.chains.set(agentId, run.catch(() => {
    }));
    await run;
    if (this.pendingCount(agentId) > 0) {
      void this.wake(agentId);
    }
  }
  /**
   * Drives turns for an agent until its queue is empty.
   *
   * The loop is what makes an interrupt safe. A priority message aborts the
   * running turn *before* that turn has consumed the message, so one turn is not
   * enough — and it cannot be a single re-entrant `wake` call either, because the
   * guard below is still held while the aborted turn unwinds. Looping here keeps
   * the guard's other job (collapsing a burst into one turn) without dropping the
   * message that caused the interrupt.
   */
  async wake(agentId) {
    if (this.pendingCount(agentId) === 0) return;
    if (this.wakeScheduled.has(agentId)) return;
    this.wakeScheduled.add(agentId);
    try {
      while (this.pendingCount(agentId) > 0) {
        try {
          await this.runExclusive(agentId, { userDriven: false });
        } catch (error) {
          this.onEvent({
            type: "turn_failed",
            agentId,
            error: error instanceof Error ? error.message : String(error)
          });
          this.drain(agentId);
          return;
        }
      }
    } finally {
      this.wakeScheduled.delete(agentId);
    }
  }
  /**
   * Resolves once no agent has a turn in flight and no message is queued.
   *
   * Loops rather than awaiting once, because a finishing turn can send a message
   * that wakes another agent, which is the whole point of the system.
   */
  async idle(timeoutMs = 10 * 6e4) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Promise.allSettled([...this.chains.values()]);
      if (this.active.size === 0 && this.totalPending() === 0) return;
      await new Promise((resolve5) => setTimeout(resolve5, 10));
    }
    throw new Error(`Agents did not settle within ${timeoutMs / 1e3}s`);
  }
  /** Names of agents currently inside a turn. For status output. */
  activeAgentIds() {
    return [...this.active.keys()];
  }
  totalPending() {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }
};

// src/box/display-lease.ts
var DisplayLease = class {
  holderId;
  acquiredAt = 0;
  /**
   * Claims the display for `agentId`.
   *
   * Re-entrant for the holder, so a turn can call the computer tool repeatedly.
   * Returns false when another agent holds it.
   */
  acquire(agentId) {
    if (this.holderId === void 0) {
      this.holderId = agentId;
      this.acquiredAt = Date.now();
      return true;
    }
    return this.holderId === agentId;
  }
  /** Releases the display if `agentId` holds it. A non-holder is a no-op. */
  release(agentId) {
    if (this.holderId === agentId) {
      this.holderId = void 0;
      this.acquiredAt = 0;
    }
  }
  heldBy() {
    return this.holderId;
  }
  /** How long the current holder has had it, for diagnostics. */
  heldForMs() {
    return this.acquiredAt === 0 ? 0 : Date.now() - this.acquiredAt;
  }
};

// src/box/provisioner.ts
var AttachedBoxProvisioner = class {
  kind = "attached";
  label;
  baseUrl;
  token;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const token = options.token ?? readBoxToken();
    if (!token) {
      throw new Error(
        `No box token for ${this.baseUrl}. Set AGENTBOX_TOKEN to the token the box was started with \u2014 a token cannot be invented for a box someone else is running.`
      );
    }
    this.token = token;
    this.label = `attached (${this.baseUrl})`;
  }
  async endpoint() {
    return { baseUrl: this.baseUrl, token: this.token };
  }
  async connect() {
    const client = new BoxClient({ baseUrl: this.baseUrl, token: this.token });
    await client.health();
    return client;
  }
};
var DockerBoxProvisioner = class {
  kind = "docker";
  label;
  manager;
  constructor(config = defaultBoxConfig()) {
    this.manager = new BoxManager(config);
    this.label = `docker (${config.containerName})`;
  }
  async endpoint() {
    try {
      const status = await this.manager.status();
      if (!status.boxdUrl) return void 0;
      return { baseUrl: status.boxdUrl, token: this.manager.config.token };
    } catch {
      return void 0;
    }
  }
  connect() {
    return this.manager.connect();
  }
};
function resolveBoxProvisioner() {
  const url = process.env.AGENTBOX_BOXD_URL?.trim();
  if (url) return new AttachedBoxProvisioner({ baseUrl: url });
  return new DockerBoxProvisioner();
}

// src/host/turn.ts
init_sdk();

// src/host/compaction.ts
var CHARS_PER_TOKEN = 4;
var DEFAULT_POLICY = {
  triggerTokens: Number(process.env.AGENTBOX_COMPACT_AT_TOKENS ?? 6e4),
  keepTailTokens: Number(process.env.AGENTBOX_COMPACT_KEEP_TOKENS ?? 2e4)
};
function estimateTokens(entries) {
  let chars = 0;
  for (const entry of entries) {
    chars += "kind" in entry && entry.kind !== "summary" ? JSON.stringify(entry.blocks).length : entry.text.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
function activeWindow(entries) {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at];
    if ("kind" in entry && entry.kind === "summary") return entries.slice(at);
  }
  return entries;
}
function chooseCutPoint(entries, policy = DEFAULT_POLICY) {
  const total = estimateTokens(entries);
  if (total <= policy.triggerTokens) return void 0;
  let tail = 0;
  let index = entries.length;
  while (index > 0 && tail < policy.keepTailTokens) {
    index -= 1;
    tail += estimateTokens([entries[index]]);
  }
  while (index > 0) {
    const previous = entries[index - 1];
    const isPairEnd = !("kind" in previous) || previous.kind === "results" || previous.kind === "summary";
    if (isPairEnd) break;
    index -= 1;
  }
  if (index <= 0) return void 0;
  return {
    index,
    reason: `history is about ${total} tokens, over the ${policy.triggerTokens} trigger; summarising the first ${index} entr${index === 1 ? "y" : "ies"} and keeping about ${tail} tokens of tail`
  };
}
function buildSummaryPrompt(entries) {
  const rendered = entries.map((entry) => {
    if (!("kind" in entry)) return `${entry.role}: ${entry.text}`;
    if (entry.kind === "summary") return `summary of earlier work: ${entry.text}`;
    if (entry.kind === "blocks") {
      return entry.blocks.map(
        (block) => block.type === "text" ? `assistant: ${block.text}` : block.type === "tool_use" ? `assistant used ${block.name}: ${JSON.stringify(block.input).slice(0, 400)}` : ""
      ).filter(Boolean).join("\n");
    }
    return entry.blocks.map((block) => {
      const content = block.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ") : "";
      return `result: ${text.slice(0, 400)}`;
    }).join("\n");
  }).filter((line) => line.trim() !== "").join("\n");
  return "Summarise the earlier part of your own working history below, for your future self.\n\nWrite what a later turn needs to continue without re-reading any of it:\n- what was asked, and what has been decided\n- what you actually did, including files you created or changed, with their paths\n- the current state of the work, and anything left open or blocked\n- facts you established that would be expensive to find again\n\nBe specific and dense. Omit narration, apologies and anything you would not need again. Do not invent progress: if something was attempted and failed, say so.\n\n--- history ---\n" + rendered;
}
function summaryEntry(text, covers, at = /* @__PURE__ */ new Date()) {
  return {
    role: "user",
    kind: "summary",
    covers,
    text: `[Summary of the first ${covers} entries of this conversation]

${text}`,
    at: at.toISOString()
  };
}
function droppedEntry(covers, reason, at = /* @__PURE__ */ new Date()) {
  return {
    role: "user",
    kind: "summary",
    covers,
    text: `[The first ${covers} entries of this conversation were dropped to fit the context window, and could not be summarised: ${reason}. Earlier work is still in the transcript on disk, but not in this request \u2014 treat anything you cannot see as unknown rather than as not done.]`,
    at: at.toISOString()
  };
}

// src/host/prompt.ts
var AGENT_DIRECTORY_LIMIT = 40;
var BASE_PROMPT = `You are one of several agents that a single user runs together as a team.

You have your own persona, your own chat with the user, your own memory, and your own
long-running work. You share one Linux computer (your "box") with your teammates, and
you can message any of them directly.

Do the work you are asked to do and report what actually happened. When a task is
finished, say so plainly; when it is blocked, say what is blocking it. Prefer acting on
what you can verify from a tool result over what you assume to be true.`;
var COMPUTER_SECTION = `# Your computer

You have a Linux desktop running inside a container. It is yours to use: a browser, a
terminal, a filesystem. The user's own machine is a separate thing you cannot touch \u2014
when you talk about "the computer", you mean your box.

Use \`computer\` for anything visual: a browser, a GUI application, a page you need to
read or click through. Use \`bash\` for anything a shell does better \u2014 installing
packages, moving files, running scripts, checking output. Reaching for the GUI to do
something a one-line shell command would do is slower and less reliable.

Start the browser with \`box-chrome\` (via \`bash\`, backgrounded: \`box-chrome &\`), not
\`chromium\` directly \u2014 the wrapper carries the sandbox and shared-memory flags this
container needs, and a bare \`chromium\` fails for reasons that have nothing to do with
your task. Pass a URL as an argument to open it directly. Once it is up, drive it with
\`computer\`.

Put anything that must outlive this box under \`/home/box/work\`. That directory and the
browser's profile are the only parts of the filesystem that survive the box being rebuilt \u2014
which is what upgrading it means \u2014 so a report written to your home directory disappears the
next time it happens, silently. Scratch files can go anywhere; work someone asked for goes in
\`/home/box/work\`.

For the clipboard, use \`box-clip copy\` and \`box-clip paste\` rather than \`xclip\`
directly. An X selection belongs to the process that set it, and the shell tool kills its
process group when a command returns \u2014 so a bare \`xclip\` copy is empty a second later.
The wrapper detaches the owner. The user can read and write the same clipboard from
outside the box, so this is also how you hand them a value they need.

When something about your computer seems wrong \u2014 a click that does nothing, a screenshot
that looks empty, a browser that will not start \u2014 run \`box-doctor\` before guessing. It
checks the handful of things that fail silently in here and prints one line each, so you
find out which part is broken instead of working around the symptom.

You have \`sudo\` without a password. Installing a package you need is expected, not a
last resort.

Screenshots you receive are scaled to a fixed width, and the coordinates you send are in
that same scaled space. Click the thing you can see at the coordinates you can see it at;
do not try to correct for the real resolution.

Every \`computer\` call returns a screenshot of the end state, so you do not need to ask
for one separately. You can batch several actions into one call \u2014 click a field, type
into it, press Enter \u2014 and you will see one settled screenshot of the result. Batch when
the steps are certain; go one action at a time when you need to see what happened before
deciding the next move.

Never state what is on the screen unless you took a screenshot **in this turn** and are
reading it. You have no other way to know: the desktop changes between turns, and a
screenshot you remember from earlier is not evidence about now. If you are asked what is
displayed, call \`computer\` first. Describing a screen you have not just looked at is
worse than saying you need to check, because it reads as fact.`;
var TEAM_SECTION_PREAMBLE = `# Your teammates

Messaging a teammate is asynchronous, like texting a person. \`SendToAgent\` delivers your
message, wakes that agent, and returns an acknowledgement immediately. It does not return
their reply, and there is no way to wait for one \u2014 send it and carry on, or end your turn.
If they respond, it arrives later as its own message that wakes you on a fresh turn,
marked ${AGENT_WAKE_CUE}.

\`SendToAgent\` reaches another agent. \`SendMessage\` is not a thing here \u2014 plain text in
your response is what the user reads.

Waking a teammate is a real side effect: it starts them working and their reply lands in
the user's view of this team. Message someone when it genuinely serves the task, not
because they were mentioned. Messaging several teammates about the same thing multiplies
that effect, so only fan out when the user actually asked you to contact those agents;
otherwise say who you would message and what you would ask, and wait.

Treat what the user tells you as theirs. Do not relay a complaint or a candid aside
verbatim \u2014 if the substance needs passing on, paraphrase the actionable part.

When a message arrives from a teammate, apply the same judgement receiving it as you
would sending one. Reply only if you have something to say or were asked something. If it
is an FYI with nothing for you to do, stop \u2014 do not send an acknowledgement back, or the
two of you will ping-pong forever.`;
function describeTeammate(record) {
  const description = record.profile.description.trim();
  const summary = description ? ` \u2014 ${description.replace(/\s+/g, " ").slice(0, 120)}` : "";
  return `- ${record.profile.name} (id: ${record.id})${summary}`;
}
function teamSection(context) {
  const visible = context.teammates.filter(
    (record) => record.id !== context.agent.id && !record.profile.hidden
  );
  const lines = [TEAM_SECTION_PREAMBLE, ""];
  if (visible.length === 0) {
    lines.push(
      "This user has no other agents yet. If a task would be better owned by a dedicated",
      "teammate, offer to create one with `CreateAgent` rather than creating it unasked."
    );
    return lines.join("\n");
  }
  lines.push("Teammates you can message right now:");
  for (const record of visible.slice(0, AGENT_DIRECTORY_LIMIT)) {
    lines.push(describeTeammate(record));
  }
  if (visible.length > AGENT_DIRECTORY_LIMIT) {
    lines.push(
      `...and ${visible.length - AGENT_DIRECTORY_LIMIT} more. Every agent is a directory under ${context.agentsRoot}; read <id>/profile.json for the full roster.`
    );
  }
  return lines.join("\n");
}
function profileSection(agent) {
  const lines = [`# Who you are`, "", `Your name is ${agent.profile.name}.`];
  if (agent.profile.title) {
    lines.push(`Your role on this team: ${agent.profile.title}.`);
  }
  if (agent.profile.description.trim()) {
    lines.push("", agent.profile.description.trim());
  }
  lines.push(
    "",
    `Your agent id is ${agent.id}. Teammates address you by it; you never need to send yourself a message.`
  );
  return lines.join("\n");
}
function memorySection(memory) {
  const trimmed = memory.trim();
  if (!trimmed) {
    return `# Your memory

Your memory file is empty. As you learn things worth keeping across conversations \u2014
a decision the user made, a fact about their setup, a correction they gave you \u2014 write
them there with \`RememberFact\`. Do not record what a tool can tell you again on demand.`;
  }
  return `# Your memory

What you have chosen to remember from earlier conversations:

${trimmed}`;
}
function boxSection(context) {
  if (!context.hasBox) {
    return `# Your computer

Your box is not running right now, so \`computer\`, \`bash\`, and the file tools are
unavailable. Say so rather than pretending to act; the user can start it with
\`agentbox box up\`.`;
  }
  if (context.vision === false) {
    return `# Your computer

You have a Linux container with a shell and a filesystem, and you can install what
you need. You do **not** have vision: you cannot see screenshots, so there is no
computer tool and no way for you to look at the desktop. Do the work through
\`bash\` and the file tools.

If a task genuinely cannot be done without seeing the screen, say so plainly rather
than guessing at what is on it. Never describe the contents of a screen \u2014 you have
not seen one.`;
  }
  if (!context.resolution) return COMPUTER_SECTION;
  const { width, height } = context.resolution.api;
  return `${COMPUTER_SECTION}

Screenshots come to you at ${width}x${height}, and click, move, and scroll
coordinates are pixels in that same space with the origin at the top left. Never
emit a coordinate outside 0..${width - 1} horizontally or 0..${height - 1} vertically.`;
}
function buildSystemPromptParts(context) {
  return {
    stable: [
      BASE_PROMPT,
      boxSection(context),
      profileSection(context.agent)
    ].join("\n\n---\n\n"),
    volatile: [memorySection(context.memory), teamSection(context)].join(
      "\n\n---\n\n"
    )
  };
}
function buildWakePrompt(inbound) {
  const fromPeers = inbound.filter((message) => message.fromId !== "user");
  const lines = [];
  if (fromPeers.length === 1) {
    const message = fromPeers[0];
    lines.push(
      `${AGENT_WAKE_CUE} A message arrived from your teammate ${message.fromName} (id: ${message.fromId}).`,
      // Both branches must say this is a peer: on a priority message especially,
      // the agent is being told to drop everything, and it needs to know that
      // instruction came from a teammate rather than from the user.
      message.priority ? "This is another agent reaching out, not the user typing. It is marked priority, so it interrupted what you were doing: drop conflicting work and deal with it now." : "This is another agent reaching out, not the user typing. It arrived asynchronously.",
      "",
      `${message.fromName}: ${message.text}`
    );
  } else {
    lines.push(
      `${AGENT_WAKE_CUE} ${fromPeers.length} messages arrived from your teammates while you were idle.`,
      "These are other agents reaching out, not the user typing.",
      ""
    );
    for (const message of fromPeers) {
      const flag = message.priority ? " (priority)" : "";
      lines.push(`${message.fromName} (id: ${message.fromId})${flag}: ${message.text}`);
    }
  }
  lines.push(
    "",
    "If this needs a reply or an action, handle it \u2014 reply with `SendToAgent` using the sender's id, which reaches them on their own later turn. If it is an FYI with nothing for you to do, end your turn without replying."
  );
  return lines.join("\n");
}
function parseWakePrompt(text, knownNames) {
  const value = typeof text === "string" ? text : "";
  if (!value.startsWith(AGENT_WAKE_CUE)) return null;
  const parts = value.split("\n\n");
  if (parts.length < 3) return null;
  const body = parts.slice(1, -1).join("\n\n");
  const messages = [];
  for (const line of body.split("\n")) {
    const opener = knownNames.map((name) => ({
      name,
      match: new RegExp(
        `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\(id: [^)]*\\))?( \\(priority\\))?: ([\\s\\S]*)$`
      ).exec(line)
    })).find((candidate) => candidate.match !== null);
    if (opener?.match) {
      messages.push({
        from: opener.name,
        priority: opener.match[1] !== void 0,
        text: opener.match[2]
      });
    } else if (messages.length > 0) {
      messages[messages.length - 1].text += `
${line}`;
    }
  }
  return messages.length > 0 ? messages : null;
}
function buildTurnPrompt(inbound) {
  const fromUser = inbound.filter((message) => message.fromId === "user");
  const fromPeers = inbound.filter((message) => message.fromId !== "user");
  const parts = [];
  if (fromUser.length > 0) {
    parts.push(fromUser.map((message) => message.text).join("\n\n"));
  }
  if (fromPeers.length > 0) {
    parts.push(buildWakePrompt(fromPeers));
  }
  return parts.join("\n\n---\n\n");
}

// src/host/tools.ts
var MOUSE_BUTTONS = ["left", "middle", "right", "back", "forward"];
var SCROLL_DIRECTIONS = ["up", "down", "left", "right"];
var coordinateSchema = {
  type: "array",
  description: "[x, y] in screenshot coordinates \u2014 the same space as the screenshots you receive.",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2
};
var actionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "mouse_move",
        "click",
        "mouse_down",
        "mouse_up",
        "drag",
        "scroll",
        "type",
        "key",
        "wait",
        "screenshot",
        "cursor_position",
        "list_windows",
        "activate_window",
        "screenshot_window",
        "click_in_window"
      ],
      description: "Which action to perform."
    },
    coordinate: coordinateSchema,
    path: {
      type: "array",
      description: "For drag: the points to move through, starting point first.",
      items: coordinateSchema
    },
    button: {
      type: "string",
      enum: [...MOUSE_BUTTONS],
      description: "Mouse button. Defaults to left."
    },
    count: {
      type: "integer",
      description: "Click count \u2014 2 for a double-click. Defaults to 1."
    },
    modifiers: {
      type: "string",
      description: 'Modifier keys held during the action, joined with "+", e.g. "ctrl" or "ctrl+shift". Use "meta" for Super/Command.'
    },
    direction: {
      type: "string",
      enum: [...SCROLL_DIRECTIONS],
      description: "For scroll: which way."
    },
    amount: {
      type: "integer",
      description: "For scroll: how many wheel notches. Defaults to 3."
    },
    text: {
      type: "string",
      description: "For type: the literal text to type. Newlines are sent as Return presses."
    },
    key: {
      type: "string",
      description: 'For key: an X keysym or chord, e.g. "Return", "Escape", "Tab", "ctrl+c", "F5".'
    },
    hold_duration_ms: {
      type: "integer",
      description: "For key: hold the key down this long instead of tapping it."
    },
    duration_ms: {
      type: "integer",
      description: "For wait: how long to pause, in milliseconds."
    },
    window_id: {
      type: "string",
      description: 'For activate_window, screenshot_window and click_in_window: an id from list_windows, e.g. "0x01e00003".'
    }
  },
  required: ["action"]
};
function buildTools(hasBox, vision = true) {
  const tools = [];
  if (hasBox && vision) {
    tools.push({
      name: "computer",
      description: "Interact with the Linux desktop in your box: move and click the mouse, type, press keys, scroll, drag, and capture the screen. Call this whenever the task involves something visual \u2014 a browser, a GUI application, a page you need to read or click through. Every call returns a screenshot of the end state, so you never need a separate screenshot call to see what happened. Pass several actions in one call when the sequence is certain (click a field, type, press Enter) and you will get one settled screenshot of the result; pass one action when you need to see the outcome before choosing the next move. Coordinates are in the same space as the screenshots you receive.\n\nWhen a window you need is behind another one, do not hunt for it by eye. `list_windows` gives you every window's id, title and geometry; `activate_window` raises one and gives it focus, which you must do before typing into it, because keystrokes go to whatever holds focus; and `screenshot_window` reads one window's own contents even while it is covered, for when you only need to read it. Coordinates in a window screenshot are the window's own, measured from its top-left corner, not the screen's \u2014 so to act on something you found there, use `click_in_window` with those coordinates as they are. It raises the window and translates them for you.",
      input_schema: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            description: "The actions to perform, in order.",
            items: actionSchema,
            minItems: 1
          }
        },
        required: ["actions"]
      }
    });
  }
  if (hasBox) {
    tools.push(
      {
        name: "bash",
        description: "Run a shell command inside your box. This is the right tool for anything a terminal does better than a GUI: installing packages, inspecting and moving files, running scripts or tests, checking whether a service is up, querying an HTTP endpoint with curl. Prefer it over driving a GUI for the same result. Returns stdout, stderr, and the exit code; a non-zero exit code is information, not necessarily a failure to report. Commands run through bash, so pipes, redirection, and globs work. The session is stateful across calls: your working directory and exported variables persist, so `cd` into a directory once and later commands run there, and an activated virtualenv stays active. Use this to modify files in place too \u2014 `sed -i`, a heredoc, or a short python script are often better than rewriting a whole file with write_file.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to run." },
            cwd: {
              type: "string",
              description: "Directory to run in. Defaults to the box home directory."
            },
            timeout_ms: {
              type: "integer",
              description: "Kill the command after this long. Defaults to 120000."
            }
          },
          required: ["command"]
        }
      },
      {
        name: "read_file",
        description: "Read a text file from your box. Use this instead of `cat` when you want the content itself rather than shell output, and pass a line range when you only need part of a large file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file." },
            start_line: {
              type: "integer",
              description: "First line to return, 1-indexed and inclusive."
            },
            end_line: {
              type: "integer",
              description: "Last line to return, inclusive."
            }
          },
          required: ["path"]
        }
      },
      {
        name: "write_file",
        description: "Write a text file in your box, creating parent directories as needed and overwriting any existing file at that path. Use this for creating scripts, configuration, and notes \u2014 it is more reliable than heredocs through `bash`.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to write." },
            content: { type: "string", description: "The full file contents." }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "list_dir",
        description: "List a directory in your box, with entry types and sizes. Use it to orient yourself before reading files, rather than guessing paths.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the directory." }
          },
          required: ["path"]
        }
      }
    );
  }
  tools.push(
    {
      name: "SendToAgent",
      description: "Send a message to another of your user's agents. Delivery is fire-and-forget: it wakes that agent and returns an acknowledgement immediately. It does NOT return their reply, and you must not wait or poll for one in this turn \u2014 send it and move on. Any reply arrives later as its own message that wakes you on a fresh turn. Call this when a task genuinely belongs to a teammate's remit, or when you need something only they have. Do not call it to acknowledge a message you just received, and do not message several agents about the same effort unless the user explicitly asked you to contact them \u2014 that wakes each one and buries the user in replies. Get ids from your teammates list.",
      input_schema: {
        type: "object",
        properties: {
          target_id: {
            type: "string",
            description: "The recipient's agent id, taken from your teammates list \u2014 not their name."
          },
          message: {
            type: "string",
            description: "What to say. Write it as if texting a colleague: lead with the ask, keep it short."
          },
          priority: {
            type: "boolean",
            description: "When true, interrupt the recipient's current background work and wake them immediately. Use only for stop/supersede or genuinely time-critical instructions. Defaults to false, which waits out their current turn."
          }
        },
        required: ["target_id", "message"]
      }
    },
    {
      name: "CreateAgent",
      description: "Create a new agent \u2014 a new teammate \u2014 with a name and a persona. Returns its id so you can message it immediately. Use this when a body of work deserves a dedicated owner with its own memory and chat. There is no tool to delete an agent, so only create one that is genuinely worth keeping; the user removes agents themselves.",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "A short human-readable name for the new agent."
          },
          description: {
            type: "string",
            description: "The new agent's persona and remit: what it is for and how it should behave. This becomes its system prompt, so write it as instructions to that agent."
          },
          title: {
            type: "string",
            description: 'A short role label, e.g. "release manager".'
          }
        },
        required: ["name", "description"]
      }
    },
    {
      name: "UpdateAgent",
      description: "Edit another agent's name, description, or role label. Only the fields you pass change; the rest are left exactly as they were, and there is no way to blank a profile or remove an agent through this tool. Use it to refine a teammate's remit as the work becomes clearer.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "The id of the agent to update." },
          name: { type: "string", description: "New name. Omit to leave unchanged." },
          description: {
            type: "string",
            description: "New persona/remit. Omit to leave unchanged."
          },
          title: { type: "string", description: "New role label. Omit to leave unchanged." }
        },
        required: ["agent_id"]
      }
    },
    {
      name: "RememberFact",
      description: "Append a durable note to your own memory file, which is included in your system prompt on every future turn. Use it for things that will still matter next conversation: a decision the user made and why, a constraint about their setup, a correction they gave you. Do not use it for what a tool can tell you again on demand, or for details that only matter inside this conversation.",
      input_schema: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description: "The note to keep, as one or two self-contained sentences that will still make sense without this conversation around them."
          }
        },
        required: ["fact"]
      }
    }
  );
  return tools;
}
function truncate(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return `${text.slice(0, half)}

... [${dropped} characters omitted] ...

` + text.slice(text.length - half);
}
function formatExec(result) {
  const parts = [];
  if (result.timed_out) parts.push("[command timed out and was killed]");
  parts.push(`exit code: ${result.exit_code}`);
  if (result.stdout.trim()) parts.push(`stdout:
${truncate(result.stdout, 2e4)}`);
  if (result.stderr.trim()) parts.push(`stderr:
${truncate(result.stderr, 1e4)}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(no output)");
  return parts.join("\n\n");
}
function requireBox(context) {
  if (!context.box) {
    throw new Error(
      "The box is not running, so this tool is unavailable. Tell the user to start it with `agentbox box up`."
    );
  }
  return context.box;
}
async function dispatchTool(name, input, context) {
  switch (name) {
    case "computer": {
      const box = requireBox(context);
      const actions = input.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        return { text: "`actions` must be a non-empty array.", isError: true };
      }
      if (context.display && !context.display.acquire(context.agent.id)) {
        const holderId = context.display.heldBy();
        const holder = context.registry.tryGet(holderId);
        const seconds = Math.round(context.display.heldForMs() / 1e3);
        return {
          text: `${holder?.profile.name ?? holderId} is using the box's desktop (for ${seconds}s). Only one agent can drive the screen at a time, because keystrokes and screenshots would otherwise cross between you. Do something that does not need the screen \u2014 \`bash\` and the file tools still work \u2014 or wait and try again.`,
          isError: true
        };
      }
      const result = await box.computer(actions, {
        display: context.displayIndex,
        owner: context.boxOwner
      });
      const notes = [];
      if (result.error) {
        notes.push(`The action sequence failed: ${result.error}`);
      } else {
        notes.push(`Ran ${result.action_count} action(s) in ${result.duration_ms}ms.`);
      }
      if (result.cursor_position) {
        notes.push(
          `Cursor is at (${result.cursor_position.x}, ${result.cursor_position.y}).`
        );
      }
      if (result.windows) {
        const rows = result.windows.filter((window2) => window2.desktop >= 0).map(
          (window2) => `${window2.id}  ${window2.width}x${window2.height} at (${window2.x},${window2.y})  ${window2.title}`
        );
        notes.push(
          rows.length > 0 ? `Windows on your desktop:
${rows.join("\n")}` : "No application windows are open on your desktop."
        );
      }
      if (result.screenshot) {
        notes.push(
          result.error ? "A screenshot of the current screen is attached; check what state it is in before retrying." : "Screenshot of the resulting screen is attached."
        );
      }
      return {
        text: notes.join(" "),
        images: result.screenshot ? [{ mediaType: "image/webp", data: result.screenshot }] : void 0,
        isError: Boolean(result.error)
      };
    }
    case "bash": {
      const box = requireBox(context);
      const command = String(input.command ?? "");
      const result = await box.exec(command, {
        cwd: input.cwd ? String(input.cwd) : void 0,
        timeoutMs: input.timeout_ms ? Number(input.timeout_ms) : void 0,
        // Per-agent session, so each agent keeps its own working directory and
        // environment without inheriting a teammate's.
        session: context.agent.id,
        // So a GUI the agent launches from the shell opens on its own desktop.
        display: context.displayIndex,
        owner: context.boxOwner
      });
      return { text: formatExec(result) };
    }
    case "read_file": {
      const box = requireBox(context);
      const result = await box.readFile(String(input.path ?? ""), {
        startLine: input.start_line ? Number(input.start_line) : void 0,
        endLine: input.end_line ? Number(input.end_line) : void 0
      });
      const header = result.truncated ? `${result.path} (showing part of ${result.total_lines} lines)` : `${result.path} (${result.total_lines} lines)`;
      return { text: `${header}

${result.content}` };
    }
    case "write_file": {
      const box = requireBox(context);
      const result = await box.writeFile(
        String(input.path ?? ""),
        String(input.content ?? "")
      );
      return { text: `Wrote ${result.bytes_written} bytes to ${result.path}.` };
    }
    case "list_dir": {
      const box = requireBox(context);
      const result = await box.listDir(String(input.path ?? ""));
      if (result.entries.length === 0) return { text: `${result.path} is empty.` };
      const lines = result.entries.map(
        (entry) => entry.type === "directory" ? `${entry.name}/` : `${entry.name}  (${entry.size} bytes)`
      );
      return { text: `${result.path}

${lines.join("\n")}` };
    }
    case "SendToAgent": {
      const ack = context.bus.send({
        fromId: context.agent.id,
        toId: String(input.target_id ?? ""),
        text: String(input.message ?? ""),
        priority: input.priority === true
      });
      return { text: ack };
    }
    case "CreateAgent": {
      const created = context.registry.create({
        name: String(input.name ?? ""),
        description: String(input.description ?? ""),
        title: input.title ? String(input.title) : void 0
      });
      return {
        text: `Created agent "${created.profile.name}" (id: ${created.id}). Message it with SendToAgent using that id.`
      };
    }
    case "UpdateAgent": {
      const agentId = String(input.agent_id ?? "");
      const changes = {
        name: input.name === void 0 ? void 0 : String(input.name),
        description: input.description === void 0 ? void 0 : String(input.description),
        title: input.title === void 0 ? void 0 : String(input.title)
      };
      if (changes.name === void 0 && changes.description === void 0 && changes.title === void 0) {
        return {
          text: "Nothing to update: provide a new name, description, or title.",
          isError: true
        };
      }
      if (!context.registry.has(agentId)) {
        return { text: `No agent found with id ${agentId}.`, isError: true };
      }
      const updated = context.registry.update(agentId, changes);
      return {
        text: `Updated agent "${updated.profile.name}" (id: ${updated.id}).`
      };
    }
    case "RememberFact": {
      const fact = String(input.fact ?? "").trim();
      if (!fact) return { text: "Nothing to remember.", isError: true };
      const existing = context.registry.readMemory(context.agent.id);
      const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const next = existing.trim() ? `${existing.trimEnd()}
- (${stamp}) ${fact}
` : `# Memory

- (${stamp}) ${fact}
`;
      context.registry.writeMemory(context.agent.id, next);
      return { text: "Noted in your memory file." };
    }
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}

// src/host/turn.ts
var MAX_ROUNDS = Number(process.env.AGENTBOX_MAX_ROUNDS ?? 400);
var HISTORY_LIMIT = 60;
var FULL_CLAUDE = {
  label: "Anthropic",
  model: "claude-opus-5",
  maxTokens: 64e3,
  vision: true,
  adaptiveThinking: true,
  effort: true,
  promptCaching: true,
  auth: "x-api-key",
  keyEnv: "ANTHROPIC_API_KEY"
};
var REPLAYED_RESULT_LIMIT = 2e3;
function storableResult(block) {
  const content = Array.isArray(block.content) ? block.content : [];
  const texts = content.filter((part) => part.type === "text").map((part) => part.text);
  const imageCount = content.filter((part) => part.type === "image").length;
  let text = texts.join("\n").slice(0, REPLAYED_RESULT_LIMIT);
  if (imageCount > 0) {
    text += `
[${imageCount} screenshot(s) were attached and shown at the time]`;
  }
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content: [{ type: "text", text: text || "(no output)" }],
    is_error: block.is_error
  };
}
async function compactHistory(options) {
  const { history, agent, registry: registry2, client, provider, log, onCompacted } = options;
  const active = activeWindow(history);
  const cut = chooseCutPoint(active);
  if (!cut) return history;
  const olderEntries = active.slice(0, cut.index);
  log(`compacting history: ${cut.reason}`);
  let entry;
  try {
    const response = await client.messages.create({
      model: provider.model,
      // Enough for a dense summary and no more; a summary that runs to pages defeats the purpose.
      max_tokens: Math.min(4096, provider.maxTokens),
      messages: [{ role: "user", content: buildSummaryPrompt(olderEntries) }]
    });
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    if (!text) throw new Error("the summariser returned no text");
    entry = summaryEntry(text, cut.index);
    const detail = `summarised ${cut.index} entries: about ${estimateTokens(olderEntries)} tokens became ${estimateTokens([entry])}`;
    log(detail);
    onCompacted({ type: "compacted", covers: cut.index, summarised: true, detail });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    entry = droppedEntry(cut.index, reason);
    const detail = `could not summarise (${reason}); dropped ${cut.index} entries instead`;
    log(detail);
    onCompacted({ type: "compacted", covers: cut.index, summarised: false, detail });
  }
  registry2.appendTranscript(agent.id, entry);
  return [...history, entry];
}
function historyToMessages(entries) {
  const window2 = [...activeWindow(entries)].slice(
    -HISTORY_LIMIT
  );
  while (window2.length > 0 && "kind" in window2[0] && window2[0].kind === "results") {
    window2.shift();
  }
  while (window2.length > 0 && "kind" in window2.at(-1) && window2.at(-1).kind === "blocks") {
    window2.pop();
  }
  const messages = [];
  for (const entry of window2) {
    if ("kind" in entry) {
      if (entry.kind === "summary") {
        messages.push({ role: "user", content: entry.text });
        continue;
      }
      if (entry.blocks.length === 0) continue;
      messages.push({ role: entry.role, content: entry.blocks });
    } else if (entry.text.trim() !== "") {
      messages.push({ role: entry.role, content: entry.text });
    }
  }
  return messages;
}
function toolResultBlock(toolUseId, outcome) {
  const content = [
    { type: "text", text: outcome.text }
  ];
  for (const image of outcome.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data }
    });
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: outcome.isError
  };
}
var TurnAborted = class extends Error {
  constructor() {
    super("Turn aborted");
    this.name = "TurnAborted";
  }
};
var TurnRoundLimitExceeded = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TurnRoundLimitExceeded";
  }
};
async function runTurn(agent, inbound, signal, deps) {
  if (inbound.length === 0) return;
  const { registry: registry2, bus, box, client } = deps;
  const emit = deps.onEvent ?? (() => {
  });
  const provider = deps.provider ?? FULL_CLAUDE;
  const promptParts = buildSystemPromptParts({
    agent,
    teammates: registry2.list(),
    memory: registry2.readMemory(agent.id),
    resolution: deps.resolution,
    agentsRoot: registry2.root,
    hasBox: box !== void 0,
    vision: provider.vision
  });
  const cache = provider.promptCaching ? { cache_control: { type: "ephemeral" } } : {};
  const system = [
    { type: "text", text: promptParts.stable, ...cache },
    { type: "text", text: promptParts.volatile, ...cache }
  ];
  let history = registry2.readTranscript(agent.id);
  const turnText = buildTurnPrompt(inbound);
  history = await compactHistory({
    history,
    agent,
    registry: registry2,
    client,
    provider,
    log: (line) => console.error(`[compaction] ${agent.profile.name}: ${line}`),
    onCompacted: (event) => emit({ ...event, agentId: agent.id })
  });
  const messages = [
    ...historyToMessages(history),
    { role: "user", content: turnText }
  ];
  registry2.appendTranscript(agent.id, {
    role: "user",
    text: turnText,
    at: (/* @__PURE__ */ new Date()).toISOString()
  });
  const tools = buildTools(box !== void 0, provider.vision);
  try {
    await runRounds();
  } finally {
    deps.display?.release(agent.id);
  }
  async function runRounds() {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) {
        emit({ type: "aborted", agentId: agent.id });
        throw new TurnAborted();
      }
      emit({ type: "round", agentId: agent.id, round });
      const stream = client.messages.stream(
        {
          model: provider.model,
          max_tokens: provider.maxTokens,
          // Adaptive thinking with a summary, so the caller can show progress
          // instead of a silent pause on a long turn. Both this and effort are
          // Claude-only; a compatible endpoint that accepts them without
          // implementing them is worse than one that never sees them.
          ...provider.adaptiveThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {},
          ...provider.effort ? { output_config: { effort: deps.effort ?? "high" } } : {},
          system,
          tools,
          messages
        },
        { signal }
      );
      stream.on("text", (delta) => {
        emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta });
      });
      let response;
      try {
        response = await stream.finalMessage();
      } catch (error) {
        if (signal.aborted) {
          emit({ type: "aborted", agentId: agent.id });
          throw new TurnAborted();
        }
        throw error;
      }
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0
      };
      emit({ type: "usage", agentId: agent.id, round, ...usage });
      deps.usage?.record({
        agentId: agent.id,
        agentName: agent.profile.name,
        // Recorded from what was actually used, with a fallback rather than an optional field: a
        // usage record whose model is missing cannot be priced later.
        provider: deps.provider?.label ?? "unknown",
        model: deps.provider?.model ?? "unknown",
        round,
        ...usage
      });
      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unspecified";
        const note2 = `The model declined this request (category: ${category}).`;
        registry2.appendTranscript(agent.id, {
          role: "assistant",
          text: note2,
          at: (/* @__PURE__ */ new Date()).toISOString()
        });
        emit({ type: "text", agentId: agent.id, agentName: agent.profile.name, delta: note2 });
        return;
      }
      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter(
        (block) => block.type === "tool_use"
      );
      if (toolUses.length === 0) {
        const finalText = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        if (finalText.trim()) {
          registry2.appendTranscript(agent.id, {
            role: "assistant",
            text: finalText,
            at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        return;
      }
      const results = [];
      for (const toolUse of toolUses) {
        emit({
          type: "tool_start",
          agentId: agent.id,
          agentName: agent.profile.name,
          tool: toolUse.name,
          input: toolUse.input
        });
        let outcome;
        try {
          outcome = await dispatchTool(
            toolUse.name,
            toolUse.input ?? {},
            {
              agent,
              registry: registry2,
              bus,
              box,
              display: deps.display,
              displayIndex: deps.displayIndex,
              boxOwner: deps.boxOwner
            }
          );
        } catch (error) {
          outcome = {
            text: error instanceof Error ? error.message : String(error),
            isError: true
          };
        }
        emit({
          type: "tool_end",
          agentId: agent.id,
          agentName: agent.profile.name,
          tool: toolUse.name,
          summary: outcome.text.split("\n")[0]?.slice(0, 200) ?? "",
          screenshot: outcome.images?.[0]?.data
        });
        results.push(toolResultBlock(toolUse.id, outcome));
      }
      const at = (/* @__PURE__ */ new Date()).toISOString();
      registry2.appendTranscript(agent.id, {
        role: "assistant",
        kind: "blocks",
        blocks: response.content.filter(
          (block) => block.type === "text" || block.type === "tool_use"
        ),
        at
      });
      registry2.appendTranscript(agent.id, {
        role: "user",
        kind: "results",
        blocks: results.map(storableResult),
        at
      });
      messages.push({ role: "user", content: results });
    }
    const note = `Stopped after ${MAX_ROUNDS} tool rounds without finishing \u2014 the agent is probably looping rather than making progress.`;
    registry2.appendTranscript(agent.id, {
      role: "assistant",
      text: note,
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    throw new TurnRoundLimitExceeded(note);
  }
}

// src/host/usage.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync4, renameSync as renameSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname5, join as join7 } from "node:path";

// src/config.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname4, join as join6 } from "node:path";
var DEFAULT_CONFIG = {
  activityLimit: 400
};
var MAX_ACTIVITY_LIMIT = 2e4;
function agentboxHome() {
  return process.env.AGENTBOX_HOME ?? join6(homedir3(), ".agentbox");
}
function configPath() {
  return process.env.AGENTBOX_CONFIG ?? join6(agentboxHome(), "config.json");
}
function readInteger(value, fallback, bounds, key, warn) {
  if (value === void 0) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warn(`config: ${key} must be a whole number, using ${fallback}`);
    return fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    const clamped = Math.min(Math.max(parsed, bounds.min), bounds.max);
    warn(`config: ${key} must be between ${bounds.min} and ${bounds.max}, using ${clamped}`);
    return clamped;
  }
  return parsed;
}
function loadConfig(onWarn = () => {
}) {
  const path5 = configPath();
  if (!existsSync3(path5)) return { ...DEFAULT_CONFIG };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(path5, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarn(`config: ${path5} is not valid JSON (${detail}), using defaults`);
    return { ...DEFAULT_CONFIG };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    onWarn(`config: ${path5} should contain an object, using defaults`);
    return { ...DEFAULT_CONFIG };
  }
  const raw = parsed;
  return {
    activityLimit: readInteger(
      raw.activityLimit,
      DEFAULT_CONFIG.activityLimit,
      { min: 1, max: MAX_ACTIVITY_LIMIT },
      "activityLimit",
      onWarn
    )
  };
}
function ensureConfigFile() {
  const path5 = configPath();
  if (existsSync3(path5)) return path5;
  mkdirSync3(dirname4(path5), { recursive: true });
  writeFileSync3(path5, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}
`, "utf8");
  return path5;
}

// src/host/usage.ts
function usageLogPath() {
  return process.env.AGENTBOX_USAGE_LOG ?? join7(agentboxHome(), "usage.jsonl");
}
var COMPACT_AT = Number(process.env.AGENTBOX_USAGE_COMPACT_AT ?? 2e4);
var KEEP_ON_COMPACT = Number(process.env.AGENTBOX_USAGE_KEEP ?? 5e3);
var UsageLog = class {
  constructor(path5 = usageLogPath(), onWarn = () => {
  }) {
    this.path = path5;
    this.onWarn = onWarn;
    this.load();
  }
  nextSeq = 1;
  lines = 0;
  /** Reads the last sequence number so numbering continues across restarts. */
  load() {
    if (!existsSync4(this.path)) return;
    try {
      const lines = readFileSync4(this.path, "utf8").split("\n").filter((line) => line.trim() !== "");
      this.lines = lines.length;
      for (let at = lines.length - 1; at >= 0; at--) {
        try {
          const record = JSON.parse(lines[at]);
          if (typeof record.seq === "number") {
            this.nextSeq = record.seq + 1;
            return;
          }
        } catch {
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`usage: cannot read ${this.path} (${detail}); numbering restarts`);
    }
  }
  record(entry, now = /* @__PURE__ */ new Date()) {
    const full = { seq: this.nextSeq++, at: now.toISOString(), ...entry };
    try {
      mkdirSync4(dirname5(this.path), { recursive: true });
      appendFileSync2(this.path, `${JSON.stringify(full)}
`, "utf8");
      this.lines++;
      if (this.lines > COMPACT_AT) this.compact();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`usage: cannot write ${this.path} (${detail})`);
    }
    return full;
  }
  /** Records after `afterSeq`, which is how a collector catches up. */
  since(afterSeq = 0, limit2 = 1e3) {
    if (!existsSync4(this.path)) return [];
    try {
      return readFileSync4(this.path, "utf8").split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }).filter((record) => typeof record.seq === "number" && record.seq > afterSeq).slice(0, limit2);
    } catch {
      return [];
    }
  }
  /** Totals over what is still in the file. Not a billing figure: compaction drops the tail. */
  totals(afterSeq = 0) {
    return this.since(afterSeq, Number.MAX_SAFE_INTEGER).reduce(
      (sum, record) => ({
        records: sum.records + 1,
        inputTokens: sum.inputTokens + record.inputTokens,
        outputTokens: sum.outputTokens + record.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + record.cacheReadTokens,
        cacheWriteTokens: sum.cacheWriteTokens + record.cacheWriteTokens
      }),
      { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    );
  }
  /** Rewrites the file with its tail. Temp plus rename, so a reader never sees half a file. */
  compact() {
    try {
      const kept = this.since(0, Number.MAX_SAFE_INTEGER).slice(-KEEP_ON_COMPACT);
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync4(temp, kept.map((record) => `${JSON.stringify(record)}
`).join(""), "utf8");
      renameSync2(temp, this.path);
      this.lines = kept.length;
      this.onWarn(`usage: compacted to the most recent ${kept.length} records`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`usage: cannot compact ${this.path} (${detail})`);
    }
  }
};

// src/host/provider.ts
init_sdk();
var ANTHROPIC = {
  label: "Anthropic",
  model: "claude-opus-5",
  maxTokens: 64e3,
  vision: true,
  adaptiveThinking: true,
  effort: true,
  promptCaching: true,
  auth: "x-api-key",
  keyEnv: "ANTHROPIC_API_KEY"
};
var MINIMAX_VISION_MODELS = /* @__PURE__ */ new Set(["MiniMax-M3"]);
var MINIMAX = {
  label: "MiniMax",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  // Thinking counts against the cap, so a tight budget yields an empty response
  // with stop_reason max_tokens rather than an answer.
  maxTokens: 32e3,
  vision: true,
  // Accepted but not implemented. Omitted so behaviour is not left to chance.
  adaptiveThinking: false,
  effort: false,
  promptCaching: false,
  auth: "bearer",
  keyEnv: "MINIMAX_CODE_CN_API_KEY"
};
function compatible() {
  const truthy = (value) => value === "1" || value?.toLowerCase() === "true";
  return {
    label: process.env.AGENTBOX_PROVIDER_LABEL ?? "custom",
    baseUrl: process.env.AGENTBOX_BASE_URL,
    model: process.env.AGENTBOX_MODEL ?? "unknown",
    maxTokens: Number(process.env.AGENTBOX_MAX_TOKENS ?? 32e3),
    // Default every optional capability off: a wrong "yes" fails silently,
    // a wrong "no" merely costs a feature and says so.
    vision: truthy(process.env.AGENTBOX_VISION),
    adaptiveThinking: truthy(process.env.AGENTBOX_THINKING),
    effort: truthy(process.env.AGENTBOX_EFFORT),
    promptCaching: truthy(process.env.AGENTBOX_CACHING),
    auth: process.env.AGENTBOX_AUTH === "x-api-key" ? "x-api-key" : "bearer",
    keyEnv: process.env.AGENTBOX_KEY_ENV ?? "AGENTBOX_API_KEY"
  };
}
var PRESETS = {
  anthropic: () => ({ ...ANTHROPIC }),
  minimax: () => ({ ...MINIMAX }),
  custom: compatible,
  compatible
};
function providerNames() {
  return ["anthropic", "minimax", "custom"];
}
function resolveProvider(name) {
  const requested = (name ?? process.env.AGENTBOX_PROVIDER ?? "").toLowerCase();
  const chosen = requested || (process.env.AGENTBOX_BASE_URL ? "custom" : "anthropic");
  const build = PRESETS[chosen];
  if (!build) {
    throw new Error(
      `Unknown provider "${chosen}". Known: ${providerNames().join(", ")}.`
    );
  }
  const profile = build();
  if (process.env.AGENTBOX_MODEL) profile.model = process.env.AGENTBOX_MODEL;
  if (process.env.AGENTBOX_BASE_URL) profile.baseUrl = process.env.AGENTBOX_BASE_URL;
  if (process.env.AGENTBOX_MAX_TOKENS) {
    profile.maxTokens = Number(process.env.AGENTBOX_MAX_TOKENS);
  }
  if (chosen === "minimax") {
    profile.vision = MINIMAX_VISION_MODELS.has(profile.model);
  }
  if (process.env.AGENTBOX_VISION === "1") profile.vision = true;
  if (process.env.AGENTBOX_VISION === "0") profile.vision = false;
  return profile;
}
var MissingCredentialError = class extends Error {
  constructor(profile) {
    super(
      `No credential for ${profile.label}: set ${profile.keyEnv}.` + (profile.keyEnv === "ANTHROPIC_API_KEY" ? " Or run `ant auth login`." : "")
    );
    this.name = "MissingCredentialError";
  }
};
function createClient(profile) {
  const key = process.env[profile.keyEnv];
  if (!key && profile.keyEnv !== "ANTHROPIC_API_KEY") {
    throw new MissingCredentialError(profile);
  }
  if (profile.auth === "bearer") {
    return new Anthropic({
      baseURL: profile.baseUrl,
      authToken: key,
      apiKey: null
    });
  }
  return new Anthropic({
    baseURL: profile.baseUrl,
    ...key ? { apiKey: key } : {}
  });
}
function describeProvider(profile) {
  const missing = [];
  if (!profile.vision) missing.push("no vision (computer tool withheld)");
  if (!profile.promptCaching) missing.push("no prompt caching");
  const suffix = missing.length > 0 ? ` \u2014 ${missing.join(", ")}` : "";
  return `${profile.label} ${profile.model}${profile.baseUrl ? ` at ${profile.baseUrl}` : ""}${suffix}`;
}

// src/host/orchestrator.ts
var Orchestrator = class {
  constructor(options = {}) {
    this.options = options;
    this.registry = options.registry ?? new AgentRegistry();
    this.provider = options.provider ?? resolveProvider();
    this.client = options.client ?? createClient(this.provider);
    this.bus = new AgentBus(
      this.registry,
      (agent, inbound, signal) => this.executeTurn(agent, inbound, signal),
      options.onBusEvent
    );
  }
  registry;
  bus;
  client;
  box;
  resolution;
  /**
   * One lease for the whole process, not one per conversation. The display is a
   * property of the box, so scoping this per agent or per turn would let two
   * agents each believe they held it.
   */
  display = new DisplayLease();
  /** Desktops already brought up, so each is started once per process. */
  readyDisplays = /* @__PURE__ */ new Set();
  /**
   * What every turn cost, appended as it happens.
   *
   * One per process rather than per turn: the sequence numbers a collector reads by have to be
   * monotonic across the whole file, and two logs would produce two sequences.
   */
  usage = new UsageLog();
  provider;
  /**
   * Attaches to a running box, if there is one.
   *
   * A missing box is not fatal: agents still reason and message each other, they
   * just lose the computer and shell tools, and the prompt says so.
   */
  async connectBox() {
    if (this.options.useBox === false) {
      return { connected: false, detail: "box disabled by --no-box" };
    }
    try {
      const provisioner = this.options.boxProvisioner ?? resolveBoxProvisioner();
      const client = await provisioner.connect();
      const health = await client.health();
      this.box = client;
      this.resolution = health.resolution;
      const size = health.resolution ? `${health.resolution.display.width}x${health.resolution.display.height}` : "no display";
      return { connected: true, detail: `box ready (${size}) via ${provisioner.label}` };
    } catch (error) {
      return {
        connected: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }
  /**
   * The agent's own desktop, brought up if this is its first turn.
   *
   * Created on demand rather than at startup so a box with one active agent does
   * not pay for a desktop per registered agent. A failure is not fatal — the agent
   * keeps its shell and file tools — but it is reported, because silently falling
   * back to a shared display is how agents end up typing into each other's windows.
   */
  async ensureDesktop(agent) {
    if (!this.box) return void 0;
    const index = this.registry.displayIndexFor(agent.id);
    if (this.readyDisplays.has(index)) return index;
    try {
      await this.box.ensureDisplay(index, this.registry.boxOwnerTokenFor(agent.id));
      this.readyDisplays.add(index);
      return index;
    } catch (error) {
      this.options.onBusEvent?.({
        type: "turn_failed",
        agentId: agent.id,
        error: `could not start desktop ${index} for ${agent.profile.name}: ` + (error instanceof Error ? error.message : String(error))
      });
      return void 0;
    }
  }
  /** The box client, for callers that need the box directly (recording, downloads). */
  boxClient() {
    return this.box;
  }
  /**
   * Brings up every registered agent's desktop at once.
   *
   * On-demand creation is right for the CLI, but not for a person: they can open
   * any agent's desktop and work in it before that agent has ever taken a turn,
   * and a desktop that does not exist yet shows a proxy error instead of a screen.
   * Failures are collected rather than thrown — one agent's desktop failing must
   * not stop the others from being usable.
   */
  async ensureAllDesktops() {
    const agents = this.registry.list();
    return Promise.all(
      agents.map(async (agent) => ({
        name: agent.profile.name,
        index: await this.ensureDesktop(agent)
      }))
    );
  }
  async executeTurn(agent, inbound, signal) {
    const displayIndex = await this.ensureDesktop(agent);
    return runTurn(agent, inbound, signal, {
      displayIndex,
      boxOwner: this.registry.boxOwnerTokenFor(agent.id),
      usage: this.usage,
      client: this.client,
      registry: this.registry,
      bus: this.bus,
      box: this.box,
      display: this.display,
      resolution: this.resolution,
      provider: this.provider,
      effort: this.options.effort,
      onEvent: this.options.onTurnEvent
    }).catch((error) => {
      if (error instanceof TurnAborted) return;
      throw error;
    });
  }
  /** Sends a user message to an agent and runs its turn to completion. */
  async prompt(agentIdOrName, text) {
    const agent = this.registry.resolve(agentIdOrName);
    this.bus.sendFromUser(agent.id, text);
    await this.bus.runExclusive(agent.id, { userDriven: true });
  }
  /** Waits for every agent woken as a side effect of the last prompt. */
  settle(timeoutMs) {
    return this.bus.idle(timeoutMs);
  }
  /** Creates the first agent when the registry is empty, so the CLI is usable. */
  ensureDefaultAgent() {
    const existing = this.registry.list();
    if (existing.length > 0) return existing[0];
    return this.registry.create({
      name: "Ada",
      title: "coordinator",
      description: "You coordinate this user's team of agents. You are the one they talk to first. When a request falls squarely inside a teammate's remit, hand it to them and say you did; when the team is missing someone the work clearly needs, propose creating them rather than creating them unasked. Do the work yourself when it is faster than delegating \u2014 a single file read or a one-line shell command is not worth a handoff."
    });
  }
};

// src/web/server.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import {
  createServer as createServer2,
  request as httpRequest
} from "node:http";
import { readFileSync as readFileSync6 } from "node:fs";
import { connect as netConnect2 } from "node:net";
import { join as join9 } from "node:path";

// src/web/markdown.ts
import { existsSync as existsSync5 } from "node:fs";
import { createRequire } from "node:module";
import { join as join8 } from "node:path";
var MARKDOWN_OPTIONS = {
  html: false,
  linkify: true,
  // Chat is written the way people type: a single newline is a line break.
  breaks: true
};
var VENDOR_MARKDOWN_IT = "markdown-it/browser";
function vendorPath(spec = VENDOR_MARKDOWN_IT) {
  const dir = process.env.AGENTBOX_VENDOR_DIR;
  if (dir) {
    const copied = join8(dir, "markdown-it.js");
    if (existsSync5(copied)) return copied;
  }
  return createRequire(import.meta.url).resolve(spec);
}

// src/web/app-html.ts
var APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentbox</title>
<style>
  :root {
    --bg: #14161a; --panel: #1b1e24; --line: #2a2f38; --text: #e6e9ef;
    --dim: #8b93a1; --accent: #7aa2f7; --warn: #e0af68; --ok: #9ece6a; --err: #f7768e;
  }
  * { box-sizing: border-box; }
  /*
   * Nothing scrolls the document. Each column scrolls inside itself, so reading
   * back through one agent's conversation never moves the desktop out of view.
   *
   * min-height: 0 on the panes and their scrollers is what makes that work: a flex
   * item defaults to min-height auto, so a long conversation or a busy activity
   * feed grows its column past the viewport, the body scrolls instead, and all
   * three columns move together.
   */
  html, body { height: 100%; }
  body {
    margin: 0; overflow: hidden; display: grid;
    grid-template-columns: 232px minmax(340px, 1fr) minmax(420px, 1.05fr);
    font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--text);
  }
  .pane {
    min-width: 0; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column; border-right: 1px solid var(--line);
  }
  .pane:last-child { border-right: 0; }
  h2, form, .bar, iframe { flex: none; }
  h2 {
    margin: 0; padding: 11px 14px; font-size: 11px; letter-spacing: .09em;
    text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line);
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  h2 .plain { text-transform: none; letter-spacing: 0; }
  .scroll { overflow-y: auto; flex: 1; min-height: 0; }

  .agent {
    padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--line);
    display: flex; gap: 9px; align-items: flex-start;
  }
  .agent:hover { background: #20242b; }
  .agent.on { background: #232935; box-shadow: inset 2px 0 0 var(--accent); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); margin-top: 6px; flex: none; }
  .dot.busy { background: var(--warn); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .agent .nm { font-weight: 600; }
  .agent .ttl { color: var(--dim); font-size: 12px; }

  /* No pre-wrap: the body is rendered Markdown now, so the blocks carry the layout.
     Leaving it on would add a blank line for every newline between two tags. */
  .msg { padding: 11px 16px; border-bottom: 1px solid #21252c; word-break: break-word; }
  .msg .who { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .msg.user .who { color: var(--accent); }
  .msg .body > :first-child { margin-top: 0; }
  .msg .body > :last-child { margin-bottom: 0; }
  .msg .body p { margin: 0 0 8px; }
  .msg .body h1, .msg .body h2, .msg .body h3,
  .msg .body h4, .msg .body h5, .msg .body h6 { margin: 14px 0 6px; font-size: 15px; line-height: 1.3; }
  .msg .body h1 { font-size: 18px; }
  .msg .body h2 { font-size: 16px; }
  .msg .body ul, .msg .body ol { margin: 4px 0 8px; padding-left: 22px; }
  .msg .body li { margin: 2px 0; }
  .msg .body a { color: var(--accent); }
  .msg .body code {
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #1b1f27; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px;
  }
  .msg .body pre {
    margin: 8px 0; padding: 10px 12px; background: #0f1115; border: 1px solid var(--line);
    /* Scroll long lines rather than wrapping them: wrapped code misreads. */
    border-radius: 6px; overflow-x: auto; word-break: normal;
  }
  .msg .body pre code { background: none; border: 0; padding: 0; }
  .msg .body blockquote {
    margin: 6px 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--line); color: var(--dim);
  }
  .msg .body hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
  /* Full width and wrapping cells, rather than a scrolling block: these tables are
     mostly long prose in two columns, and wrapping keeps all of it on screen. */
  .msg .body table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 13px; }
  .msg .body th, .msg .body td {
    border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top;
  }
  .msg .body th { background: #1b1f27; font-weight: 600; }
  /* Tool calls collapse to one line. A turn can make dozens, each result can be pages
     long, and shown in full the conversation becomes a log with the reasoning buried
     in it. The summary is the call; arguments, output and screenshot are one click in. */
  .tool { padding: 4px 16px; color: var(--dim); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tool .nm { color: var(--accent); }
  details.tool > summary {
    cursor: pointer; list-style: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  details.tool > summary::-webkit-details-marker { display: none; }
  details.tool > summary::before { content: "\25b8  "; }
  details.tool[open] > summary::before { content: "\25be  "; }
  details.tool > summary:hover { color: var(--text); }
  details.tool .det {
    white-space: pre-wrap; word-break: break-word; color: var(--text);
    padding: 5px 0 6px 15px; opacity: .9;
  }
  details.tool.err > summary, details.tool.err .det { color: var(--err); }
  /* A teammate message: a one-line hint naming the agent, not the message body.
     The text is there when you open it. */
  details.note > summary { color: var(--ok); }
  .note .chip {
    background: #232935; border: 1px solid var(--line); border-radius: 9px;
    padding: 0 7px; color: var(--text);
  }
  .shot { display: block; max-width: 100%; margin: 8px 0 2px; border: 1px solid var(--line); border-radius: 4px; }
  form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
  textarea {
    flex: 1; resize: none; height: 62px; padding: 9px 11px; border-radius: 6px;
    border: 1px solid var(--line); background: #0f1115; color: var(--text); font: inherit;
  }
  textarea:focus { outline: 0; border-color: var(--accent); }
  button {
    padding: 0 16px; border-radius: 6px; border: 1px solid var(--line);
    background: #262c36; color: var(--text); font: inherit; cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .45; cursor: default; }

  iframe { width: 100%; border: 0; background: #000; aspect-ratio: 16/10; flex: none; }
  /* The desktop keeps its size no matter how long the activity feed gets. */
  #vnc { min-height: 240px; }
  .feed { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
  .ev { padding: 3px 14px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); }
  .ev b { color: var(--text); font-weight: 600; }
  .ev .t { color: #59616e; }
  .ev.mail { color: var(--ok); }
  .ev.err { color: var(--err); }
  .ev.warn { color: var(--warn); }
  .bar { padding: 8px 14px; color: var(--dim); font-size: 12px; border-bottom: 1px solid var(--line); }
  .bar b { color: var(--text); }
  /* One line, because it sits between the desktop and the activity feed. */
  #clipbar { display: flex; gap: 6px; align-items: center; }
  #clipbar input {
    flex: 1; min-width: 0; padding: 3px 7px; border-radius: 4px;
    border: 1px solid var(--line); background: #0f1115; color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #clipbar button { padding: 2px 9px; font-size: 12px; }
  h2 a { color: var(--accent); text-decoration: none; margin-right: 10px; }
  h2 a#rec.on { color: var(--err); }
  #recordings a { color: var(--accent); text-decoration: none; margin-right: 10px; }
  #recordings a:hover { text-decoration: underline; }
  h2 a:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="pane">
  <h2><span>Agents</span><button id="new" style="padding:2px 9px;font-size:12px">+</button></h2>
  <div class="scroll" id="agents"></div>
</div>

<div class="pane">
  <h2><span id="title">&mdash;</span><span class="plain" id="round"></span></h2>
  <div class="scroll" id="chat"></div>
  <form id="form">
    <textarea id="input" placeholder="Ask this agent to do something.  Enter sends, Shift+Enter for a newline."></textarea>
    <button id="send">Send</button>
  </form>
</div>

<div class="pane">
  <h2>
    <span id="desktoptitle">Desktop</span>
    <span class="plain">
      <a id="rec" href="#">&#9679; record</a>
      <a id="full" href="#" target="_blank" rel="noopener">open full size</a>
      <span id="boxinfo"></span>
    </span>
  </h2>
  <div class="bar" id="model">&mdash;</div>
  <div class="bar" id="recordings" style="display:none"></div>
  <div class="bar" id="clipbar">
    <b>clipboard</b>
    <input id="cliptext" placeholder="text to paste into the box" spellcheck="false">
    <button id="clipin" title="Put this on the box's clipboard, then press Ctrl+V in the desktop">&rarr; box</button>
    <button id="clipout" title="Read the box's clipboard and copy it here">&larr; box</button>
  </div>
  <iframe id="vnc" title="box desktop"></iframe>
  <div class="bar" style="border-top:1px solid var(--line);border-bottom:0">
    Every agent has its own desktop, so they never fight over focus. This shows the
    selected agent's. Click it for keyboard focus, or open it full size — you can
    drive one while the others keep working.
  </div>
  <h2 style="border-top:1px solid var(--line)">Activity &mdash; all agents</h2>
  <div class="feed" id="feed"></div>
</div>

<script src="/vendor/markdown-it.js"></script>
<script>
"use strict";
// Markdown rendering is markdown-it's job, served from node_modules by this server.
// html:false is what keeps model output inert — see src/web/markdown.ts.
var md = window.markdownit ? window.markdownit(${JSON.stringify(MARKDOWN_OPTIONS)}) : null;

function renderMarkdown(text) {
  var value = String(text == null ? "" : text);
  // If the library did not load, show escaped text rather than nothing. A feed
  // showing raw Markdown is poor; a blank one is useless.
  if (!md) return "<p>" + esc(value).replace(/\n/g, "<br>") + "</p>";
  return md.render(value);
}

function $(id) { return document.getElementById(id); }

var agents = [];
var current = null;
var busy = new Set();
/** In-flight assistant text nodes, keyed by agent id, so deltas land in one bubble. */
var live = new Map();
/** The tool row awaiting its result, per agent. */
var openTool = new Map();

function esc(value) {
  return String(value).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function nameOf(id) {
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i].name;
  return String(id).slice(0, 8);
}

/**
 * One activity line. The at argument is when it happened; omit it for something now.
 *
 * The clock is there because this history outlives the process: without it, a line from
 * last night's run reads as if it just happened.
 */
function feed(html, cls, at) {
  var el = $("feed");
  var stick = nearBottom(el);
  var when = at ? new Date(at) : new Date();
  var stamp = isNaN(when.getTime())
    ? ""
    : '<span class="t">' + ("0" + when.getHours()).slice(-2) + ":" +
        ("0" + when.getMinutes()).slice(-2) + "</span> ";
  var row = document.createElement("div");
  row.className = "ev " + (cls || "");
  row.innerHTML = stamp + html;
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
}

function renderAgents() {
  var html = "";
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    html += '<div class="agent ' + (a.id === current ? "on" : "") + '" data-id="' + esc(a.id) + '">' +
      '<div class="dot ' + (busy.has(a.id) ? "busy" : "") + '"></div>' +
      '<div style="min-width:0"><div class="nm">' + esc(a.name) + "</div>" +
      '<div class="ttl">' + esc(String(a.title || a.description || "").slice(0, 40)) +
      (a.displayIndex ? ' <span style="opacity:.7">:' + esc(a.displayIndex) + "</span>" : "") +
      "</div></div></div>";
  }
  $("agents").innerHTML = html;
  var nodes = document.querySelectorAll(".agent");
  for (var j = 0; j < nodes.length; j++) {
    nodes[j].onclick = function () { select(this.dataset.id); };
  }
}

function bubble(role, who, text) {
  var el = $("chat");
  var stick = nearBottom(el);
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = '<div class="who">' + esc(who) + '</div><div class="body"></div>';
  var body = div.querySelector(".body");
  body.innerHTML = renderMarkdown(text);
  el.appendChild(div);
  if (stick) el.scrollTop = el.scrollHeight;
  return body;
}

/**
 * A collapsed row: one line of summary, the rest behind a click.
 *
 * Used for tool calls and for teammate messages, which are the two things that arrive
 * in bulk and drown the conversation when shown in full.
 */
/** The argument that identifies a call. Mirrors src/web/transcript.ts for replay. */
function toolDetail(tool, input) {
  var args = input || {};
  if (tool === "bash") return args.command || "";
  if (tool === "SendToAgent") return nameOf(args.target_id || "") + ": " + (args.text || "");
  if (tool === "computer") {
    var actions = args.actions || [];
    var names = [];
    for (var i = 0; i < actions.length; i++) names.push(actions[i].action);
    return names.join(" + ");
  }
  var values = Object.keys(args).map(function (key) { return String(args[key]); });
  return values.length ? values[0] : "";
}

function collapsedRow(cls, summaryHtml, detail) {
  var el = $("chat");
  var stick = nearBottom(el);
  var row = document.createElement("details");
  row.className = "tool " + (cls || "");
  row.innerHTML = "<summary>" + summaryHtml + '</summary><div class="det"></div>';
  // textContent, not innerHTML: this is output from a command or another agent.
  row.querySelector(".det").textContent = String(detail == null ? "" : detail);
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
  return row;
}

/** Appends to an open row's body, for a result that arrives after the call. */
function appendDetail(row, text) {
  if (!row || !text) return;
  var body = row.querySelector(".det");
  body.textContent = body.textContent ? body.textContent + "\n\n" + text : String(text);
}

function toolCall(name, detail, result, isError) {
  var oneLine = String(detail == null ? "" : detail).replace(/\s+/g, " ");
  var row = collapsedRow(
    isError ? "err" : "",
    '<span class="nm">' + esc(name) + "</span> " + esc(oneLine.slice(0, 140)),
    detail
  );
  appendDetail(row, result);
  return row;
}

/**
 * A teammate message as a one-line hint.
 *
 * The established pattern for this is an inline hint — "Messaged [Bob]" — naming the
 * agent rather than quoting what was sent. Following that: the row says who and which
 * direction, and the message itself is one click away.
 */
function peerNote(direction, name, text, priority) {
  var oneLine = String(text == null ? "" : text).replace(/\s+/g, " ");
  return collapsedRow(
    "note",
    "&#9993; " + esc(direction) + ' <span class="chip">' + esc(name) + "</span>" +
      (priority ? " (priority)" : "") + " " + esc(oneLine.slice(0, 60)),
    text
  );
}

/** Points the desktop pane at one agent's own display. */
function showDesktop(id) {
  var agent = null;
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) agent = agents[i];
  if (!agent || !agent.desktopUrl) {
    $("desktoptitle").textContent = "Desktop";
    $("full").style.display = "none";
    return;
  }
  $("desktoptitle").textContent = agent.name + "'s desktop (:" + agent.displayIndex + ")";
  $("full").href = agent.desktopUrl;
  $("full").style.display = "";
  // Only reload when it is a different desktop: re-setting src restarts noVNC and
  // flashes "Connecting…", so switching back and forth must not thrash it.
  if ($("vnc").getAttribute("src") !== agent.desktopUrl) {
    $("vnc").setAttribute("src", agent.desktopUrl);
  }
}

/**
 * One mapped transcript entry.
 *
 * The server hands over what to show — prose, teammate messages, tool calls, results —
 * because the stored transcript is written for the model and needs a real parse to read
 * as a conversation. See src/web/transcript.ts.
 */
function replayEntry(id, entry) {
  if (entry.kind === "peer") {
    for (var p = 0; p < entry.messages.length; p++) {
      peerNote("from", entry.messages[p].from, entry.messages[p].text, entry.messages[p].priority);
    }
    return;
  }
  if (entry.kind === "tools") {
    for (var t = 0; t < entry.tools.length; t++) {
      var call = entry.tools[t];
      toolCall(call.name, call.detail, call.result, call.isError);
    }
    return;
  }
  bubble(entry.role === "user" ? "user" : "", entry.role === "user" ? "you" : nameOf(id), entry.text);
}

function select(id) {
  current = id;
  $("title").textContent = nameOf(id);
  $("round").textContent = "";
  spend = { input: 0, output: 0 };
  spendLabel = "";
  roundLabel = "";
  renderAgents();
  showDesktop(id);
  $("chat").innerHTML = "";
  live.delete(id);

  return fetch("/api/transcript?agent=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (entries) {
      for (var i = 0; i < entries.length; i++) replayEntry(id, entries[i]);
      $("chat").scrollTop = $("chat").scrollHeight;
    });
}

function refresh() {
  return fetch("/api/state").then(function (r) { return r.json(); }).then(function (state) {
    agents = state.agents;
    $("model").innerHTML = "<b>model</b> " + esc(state.provider);
    $("boxinfo").textContent = state.box.ok ? state.box.detail : "unavailable";
    if (!current && agents.length) return select(agents[0].id);
    renderAgents();
    // A newly created agent gets its display assigned server-side; keep the pane
    // in step without reloading an unchanged one.
    if (current) showDesktop(current);
  });
}

// --- live events ----------------------------------------------------------

var stream = new EventSource("/api/events");

/**
 * The activity line for an event, or null if it does not belong in the feed.
 *
 * Shared by the live stream and by the replay of recent activity on load, so a
 * reloaded page reads the same as one that was open the whole time.
 */
function activityLine(e) {
  if (e.type === "prompt") return { html: "<b>you</b> &rarr; " + esc(nameOf(e.agentId)), cls: "" };
  if (e.type === "turn_started") return { html: "<b>" + esc(nameOf(e.agentId)) + "</b> started a turn", cls: "" };
  if (e.type === "tool_start") return { html: "<b>" + esc(e.agentName) + "</b> &rarr; " + esc(e.tool), cls: "" };
  if (e.type === "message_sent") {
    return {
      html: "&#9993; <b>" + esc(e.fromName) + "</b> &rarr; <b>" + esc(e.toName) + "</b>" +
        (e.priority ? " (priority)" : "") + ": " + esc(String(e.text).slice(0, 90)),
      cls: "mail"
    };
  }
  if (e.type === "turn_failed") {
    return { html: "<b>" + esc(nameOf(e.agentId)) + "</b> failed: " + esc(e.error), cls: "err" };
  }
  if (e.type === "turn_interrupted") {
    return { html: "<b>" + esc(nameOf(e.agentId)) + "</b> interrupted (" + esc(e.reason) + ")", cls: "warn" };
  }
  if (e.type === "error") return { html: esc(e.message), cls: "err" };
  return null;
}

/** What happened before this page was opened. The feed used to start blank on reload. */
function loadActivity() {
  return fetch("/api/activity")
    .then(function (r) { return r.json(); })
    .then(function (events) {
      for (var i = 0; i < events.length; i++) {
        var line = activityLine(events[i]);
        if (line) feed(line.html, line.cls, events[i].at);
      }
    })
    .catch(function () { /* an empty feed is not worth an error row */ });
}

/** Tokens as a person reads them: exact until it stops being useful. */
function fmtTokens(n) {
  if (n < 10000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 100000 ? 1 : 0) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

var spend = { input: 0, output: 0 };
var spendLabel = "";
var roundLabel = "";

stream.onmessage = function (raw) {
  var e = JSON.parse(raw.data);
  var line = activityLine(e);
  if (line) feed(line.html, line.cls);

  if (e.type === "prompt") {
    if (e.agentId === current) bubble("user", "you", e.text);
    return;
  }

  if (e.type === "text") {
    if (e.agentId !== current) return;
    var open = live.get(e.agentId);
    if (!open) {
      open = { node: bubble("", e.agentName, ""), text: "", queued: false };
      live.set(e.agentId, open);
    }
    open.text += e.delta;
    // The whole message has to be re-rendered, not appended to: half a fence is not
    // yet a code block, and a list grows an item at a time. Deltas arrive far faster
    // than the screen refreshes, so paint once per frame instead of once per delta.
    if (!open.queued) {
      open.queued = true;
      requestAnimationFrame(function () {
        open.queued = false;
        var chat = $("chat");
        var stick = nearBottom(chat);
        open.node.innerHTML = renderMarkdown(open.text);
        if (stick) chat.scrollTop = chat.scrollHeight;
      });
    }
    return;
  }

  if (e.type === "tool_start") {
    live.delete(e.agentId);
    // Held so the result can be folded into the same row when it arrives.
    if (e.agentId === current) {
      openTool.set(e.agentId, toolCall(e.tool, toolDetail(e.tool, e.input)));
    }
    return;
  }

  if (e.type === "tool_end") {
    var row = openTool.get(e.agentId);
    openTool.delete(e.agentId);
    if (e.agentId !== current || !row) return;
    appendDetail(row, e.summary);
    if (e.screenshot) {
      var img = document.createElement("img");
      img.className = "shot";
      img.src = "data:image/webp;base64," + e.screenshot;
      // Inside the row, so it appears when opened rather than filling the column.
      row.appendChild(img);
    }
    return;
  }

  if (e.type === "message_sent") {
    // Both sides, in their own chat: the sender's record of messaging a teammate, and
    // the recipient's of being messaged. Without the second, the pane jumps from
    // nothing to a reply and what prompted it only shows up on reload.
    if (e.toId === current) peerNote("from", e.fromName, e.text, e.priority);
    else if (e.fromId === current) peerNote("to", e.toName, e.text, e.priority);
    return;
  }

  if (e.type === "turn_started") {
    busy.add(e.agentId); renderAgents();
    return;
  }

  if (e.type === "turn_finished") {
    busy.delete(e.agentId); live.delete(e.agentId); renderAgents();
    // A teammate that just worked may be new to this page, or have new history.
    refresh();
    return;
  }

  if (e.type === "turn_failed") {
    busy.delete(e.agentId); renderAgents();
    return;
  }

  if (e.type === "round") {
    if (e.agentId === current) {
      roundLabel = "round " + (e.round + 1);
      $("round").textContent = spendLabel ? roundLabel + " · " + spendLabel : roundLabel;
    }
    return;
  }

  if (e.type === "usage") {
    // Shown while it is being spent, not after: a turn that is costing more than it should is
    // something to notice during, and this is the only number that says so.
    if (e.agentId !== current) return;
    spend.input += e.inputTokens;
    spend.output += e.outputTokens;
    spendLabel = fmtTokens(spend.input) + " in / " + fmtTokens(spend.output) + " out";
    $("round").textContent = roundLabel ? roundLabel + " · " + spendLabel : spendLabel;
    return;
  }

};

stream.onerror = function () {
  feed("event stream dropped &mdash; reload the page to reconnect", "err");
};

// --- input ----------------------------------------------------------------

$("form").onsubmit = function (event) {
  event.preventDefault();
  var text = $("input").value.trim();
  if (!text || !current) return;
  $("input").value = "";
  $("send").disabled = true;
  fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, text: text })
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (t) { feed("prompt rejected: " + esc(t), "err"); });
  }).catch(function (error) {
    feed("prompt failed: " + esc(error.message), "err");
  }).then(function () {
    $("send").disabled = false;
    $("input").focus();
  });
};

// Enter is overloaded, and an IME has the stronger claim on it: while composing,
// Enter accepts the candidate. That keydown reaches the page looking like a
// deliberate send, and sending on it throws away a half-composed sentence — the
// characters chosen so far go out as the message and the rest of the thought is
// lost. Anyone typing Chinese, Japanese or Korean hits this on their first line.
var composing = false;
var compositionEndedAt = 0;

$("input").addEventListener("compositionstart", function () {
  composing = true;
});
$("input").addEventListener("compositionend", function () {
  composing = false;
  compositionEndedAt = Date.now();
});

$("input").onkeydown = function (event) {
  if (event.key !== "Enter" || event.shiftKey) return;

  // isComposing is the standard signal (Chrome, Firefox, Edge); keyCode 229 is the
  // older one some IMEs still send; the flag covers anything that sets neither.
  if (event.isComposing || event.keyCode === 229 || composing) return;

  // Safari delivers the accepting Enter *after* compositionend with isComposing
  // false, so none of the checks above can see it. Nothing legitimate arrives this
  // fast: a second, deliberate Enter needs the key released and pressed again.
  if (Date.now() - compositionEndedAt < 50) return;

  event.preventDefault();
  $("form").requestSubmit();
};

/**
 * The box's clipboard, in both directions.
 *
 * The desktop is a VNC canvas, so text cannot be typed into it from here and text copied
 * inside it cannot be got out. Writing puts it on the box's CLIPBOARD selection, ready
 * for a Ctrl+V in the desktop; reading pulls it back and, where the browser allows it,
 * onto the host clipboard too — the click is the user gesture that permission needs.
 */
function clipboard(text) {
  var body = { agent: current };
  if (text !== undefined) body.text = text;
  return fetch("/api/clipboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || "clipboard failed");
      return data;
    });
  });
}

function flashButton(button, label) {
  var original = button.textContent;
  button.textContent = label;
  setTimeout(function () { button.textContent = original; }, 1200);
}

$("clipin").onclick = function () {
  if (!current) return;
  var text = $("cliptext").value;
  if (!text) return;
  clipboard(text).then(function () {
    flashButton($("clipin"), "on the box");
  }).catch(function (error) {
    feed("clipboard: " + esc(error.message), "err");
  });
};

$("clipout").onclick = function () {
  if (!current) return;
  clipboard().then(function (data) {
    $("cliptext").value = data.text;
    if (!data.text) {
      flashButton($("clipout"), "empty");
      return;
    }
    // Best effort: this needs a secure context and permission, and the field is
    // already filled either way, so a refusal is not worth an error row.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(data.text).then(function () {
        flashButton($("clipout"), "copied here");
      }, function () {
        flashButton($("clipout"), "in the field");
      });
    } else {
      flashButton($("clipout"), "in the field");
    }
  }).catch(function (error) {
    feed("clipboard: " + esc(error.message), "err");
  });
};

/**
 * Recording the desktop.
 *
 * A transcript says what an agent claims it did and a screenshot shows one instant;
 * neither answers "what did it actually do" after the screen has moved on. The file
 * lands on the box's work volume, so it outlives the container, and opens in a tab
 * rather than an embedded player — the browser plays fragmented MP4 natively.
 */
var recording = null;

function renderRecordings(list) {
  var box = $("recordings");
  if (!list || !list.length) {
    box.style.display = "none";
    return;
  }
  var html = "<b>recordings</b> ";
  for (var i = 0; i < Math.min(list.length, 6); i++) {
    var item = list[i];
    var size = item.size_bytes ? Math.round(item.size_bytes / 1024) + "KB" : "recording…";
    html += '<a href="/recording?name=' + encodeURIComponent(item.file) + '" target="_blank"' +
      ' rel="noopener">' + esc(item.file.replace(/\.mp4$/, "")) + " (" + size + ")</a>";
  }
  box.innerHTML = html;
  box.style.display = "";
}

function loadRecordings() {
  return fetch("/api/recordings")
    .then(function (r) { return r.json(); })
    .then(function (data) { renderRecordings(data.recordings); })
    .catch(function () { /* the box may be down; the pane just stays hidden */ });
}

$("rec").onclick = function (event) {
  event.preventDefault();
  if (!current) return;
  var starting = recording === null;
  var link = $("rec");
  link.textContent = starting ? "starting…" : "stopping…";

  fetch("/api/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, action: starting ? "start" : "stop" })
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || "failed");
      return data;
    });
  }).then(function (data) {
    recording = starting ? data.file : null;
    link.textContent = starting ? "\u25a0 stop" : "\u25cf record";
    link.className = starting ? "on" : "";
    if (!starting) feed("recording saved: " + esc(data.file), "mail");
    return loadRecordings();
  }).catch(function (error) {
    link.textContent = "\u25cf record";
    link.className = "";
    recording = null;
    feed("recording: " + esc(error.message), "err");
  });
};

$("new").onclick = function () {
  var name = prompt("Agent name?");
  if (!name) return;
  var description = prompt("What is this agent for? (becomes its system prompt)") || "";
  fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name, description: description })
  }).then(refresh);
};

// Activity after the roster, because its lines name agents.
refresh().then(loadActivity).then(loadRecordings);
setInterval(refresh, 15000);
</script>
</body>
</html>`;

// src/web/auth.ts
import { timingSafeEqual } from "node:crypto";
var COOKIE_NAME = "agentbox_ui";
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
function isLoopback(host) {
  return LOOPBACK.has(host);
}
function sameToken(a, b) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
function parseCookies(header) {
  const cookies = /* @__PURE__ */ new Map();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    cookies.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return cookies;
}
function authorize(config, request) {
  if (!config.token) {
    return { allow: true, reason: "loopback" };
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(request.authorization ?? "")?.[1]?.trim();
  if (bearer && sameToken(bearer, config.token)) return { allow: true, reason: "token" };
  const cookie = parseCookies(request.cookie).get(COOKIE_NAME);
  if (cookie && sameToken(cookie, config.token)) return { allow: true, reason: "token" };
  const query = request.query?.trim();
  if (query && sameToken(query, config.token)) {
    return {
      allow: true,
      reason: "token",
      setCookie: `${COOKIE_NAME}=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax`
    };
  }
  return { allow: false, reason: cookie || bearer || query ? "wrong" : "missing" };
}

// src/web/activity.ts
import { appendFileSync as appendFileSync3, existsSync as existsSync6, mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname6 } from "node:path";
var COMPACT_FACTOR = 3;
var ActivityLog = class {
  path;
  limit;
  now;
  onWarn;
  events = [];
  /** Lines in the file, so compaction does not need to read it back. */
  lines = 0;
  constructor(options) {
    this.path = options.path;
    this.limit = Math.max(1, options.limit);
    this.now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
    this.onWarn = options.onWarn ?? (() => {
    });
    this.load();
  }
  load() {
    if (!existsSync6(this.path)) return;
    let contents;
    try {
      contents = readFileSync5(this.path, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`activity: cannot read ${this.path} (${detail}), starting empty`);
      return;
    }
    const lines = contents.split("\n").filter((line) => line.trim() !== "");
    this.lines = lines.length;
    const parsed = [];
    let skipped = 0;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event.type === "string") parsed.push(event);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) this.onWarn(`activity: skipped ${skipped} unreadable line(s)`);
    this.events = parsed.slice(-this.limit);
  }
  /** Most recent last, at most `limit` of them. */
  list() {
    return this.events;
  }
  add(event) {
    const stored = { ...event, at: this.now() };
    this.events.push(stored);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    try {
      appendFileSync3(this.path, `${JSON.stringify(stored)}
`, "utf8");
      this.lines++;
      if (this.lines > this.limit * COMPACT_FACTOR) this.compact();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`activity: cannot write ${this.path} (${detail})`);
    }
    return stored;
  }
  /** Rewrites the file with what is kept. Temp plus rename, so a reader never sees half. */
  compact() {
    const temp = `${this.path}.${process.pid}.tmp`;
    const body = this.events.map((event) => `${JSON.stringify(event)}
`).join("");
    try {
      mkdirSync5(dirname6(this.path), { recursive: true });
      writeFileSync5(temp, body, "utf8");
      renameSync3(temp, this.path);
      this.lines = this.events.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`activity: cannot compact ${this.path} (${detail})`);
    }
  }
};

// src/web/transcript.ts
function toolDetail(name, input, roster) {
  const args = input ?? {};
  if (name === "bash") return String(args.command ?? "");
  if (name === "SendToAgent") {
    const target = roster.find((entry) => entry.id === String(args.target_id ?? ""));
    const to = target ? target.name : String(args.target_id ?? "someone");
    return `${to}: ${String(args.text ?? "")}`;
  }
  if (name === "computer") {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    return actions.map((action) => String(action.action ?? "")).join(" + ");
  }
  const values = Object.values(args).map((value) => String(value));
  return values.length > 0 ? values[0] : "";
}
function resultText(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
}
function toDisplayEntries(entries, roster) {
  const display = [];
  const knownNames = roster.map((entry) => entry.name);
  let awaiting;
  for (const raw of entries) {
    const entry = raw ?? {};
    const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
    if (entry.kind === "blocks") {
      const text2 = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("").trim();
      if (text2) display.push({ kind: "text", role: "assistant", text: text2 });
      const calls = blocks.filter((block) => block.type === "tool_use");
      const tools = calls.map((block) => ({
        name: String(block.name ?? "tool"),
        detail: toolDetail(String(block.name ?? ""), block.input, roster)
      }));
      if (tools.length > 0) {
        const entryWithTools = { kind: "tools", tools };
        display.push(entryWithTools);
        awaiting = {
          entry: entryWithTools,
          ids: calls.map((block) => String(block.id ?? ""))
        };
      }
      continue;
    }
    if (entry.kind === "results") {
      for (const block of blocks) {
        const at = awaiting?.ids.indexOf(String(block.tool_use_id ?? "")) ?? -1;
        const tool = at >= 0 ? awaiting.entry.tools[at] : void 0;
        if (!tool) continue;
        tool.result = resultText(block);
        tool.isError = block.is_error === true;
      }
      awaiting = void 0;
      continue;
    }
    const text = typeof entry.text === "string" ? entry.text : "";
    if (!text.trim()) continue;
    if (entry.role === "user") {
      const peers = parseWakePrompt(text, knownNames);
      if (peers) display.push({ kind: "peer", messages: peers });
      else display.push({ kind: "text", role: "user", text });
      continue;
    }
    display.push({ kind: "text", role: "assistant", text });
  }
  return display;
}

// src/web/server.ts
async function startWebServer(options) {
  const log = options.onLog ?? (() => {
  });
  const registry2 = new AgentRegistry();
  let vendorScript;
  const clients = /* @__PURE__ */ new Set();
  const activityLimit = loadConfig((line) => log(line)).activityLimit;
  const activity = new ActivityLog({
    path: join9(agentboxHome(), "activity.jsonl"),
    limit: activityLimit,
    onWarn: (line) => log(line)
  });
  const FEED_EVENTS = /* @__PURE__ */ new Set([
    "prompt",
    "turn_started",
    "turn_failed",
    "turn_interrupted",
    "tool_start",
    "message_sent",
    "error"
  ]);
  const remember = (event) => {
    if (!FEED_EVENTS.has(event.type)) return;
    activity.add(event);
  };
  const broadcast = (event) => {
    remember(event);
    const payload = `data: ${JSON.stringify(event)}

`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };
  const provisioner = options.boxProvisioner ?? resolveBoxProvisioner();
  const orchestrator = new Orchestrator({
    registry: registry2,
    provider: options.provider,
    useBox: options.useBox,
    boxProvisioner: provisioner,
    onTurnEvent: broadcast,
    onBusEvent: broadcast
  });
  const box = await orchestrator.connectBox();
  log(box.connected ? `box: ${box.detail}` : `box: unavailable \u2014 ${box.detail}`);
  if (box.connected) {
    const desktops = await orchestrator.ensureAllDesktops();
    for (const desktop of desktops) {
      log(
        desktop.index === void 0 ? `desktop for ${desktop.name}: failed to start` : `desktop for ${desktop.name}: :${desktop.index}`
      );
    }
  }
  let cachedOrigin;
  const ORIGIN_TTL_MS = 5e3;
  async function resolveBoxdOrigin(force = false) {
    if (!force && cachedOrigin && Date.now() - cachedOrigin.at < ORIGIN_TTL_MS) {
      return cachedOrigin.value;
    }
    let value;
    try {
      const endpoint = await provisioner.endpoint();
      if (endpoint) {
        const url = new URL(endpoint.baseUrl);
        value = {
          host: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          token: endpoint.token
        };
      }
    } catch {
      value = void 0;
    }
    cachedOrigin = { value, at: Date.now() };
    return value;
  }
  function desktopUpstreamPath(pathname, search) {
    const match = /^\/desktop\/(\d+)(\/.*)?$/.exec(pathname);
    if (!match) return void 0;
    const rest = match[2] ?? "/";
    return `/vnc/${match[1]}${rest}${search}`;
  }
  async function proxyDesktop(req, res, path5, retried = false) {
    const origin = await resolveBoxdOrigin(retried);
    if (!origin) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("The box is not available. Start it with `agentbox box up`.");
      return;
    }
    const upstream = httpRequest(
      {
        host: origin.host,
        port: origin.port,
        method: req.method,
        path: path5,
        headers: {
          ...req.headers,
          host: `${origin.host}:${origin.port}`,
          // boxd requires the token on everything but /health and the VNC stream.
          authorization: `Bearer ${origin.token}`
        }
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      }
    );
    upstream.on("error", (error) => {
      if (!retried && !res.headersSent) {
        void proxyDesktop(req, res, path5, true);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Cannot reach the box desktop: ${error.message}`);
      } else {
        res.end();
      }
    });
    req.pipe(upstream);
  }
  function send(res, status, body, type = "application/json") {
    const payload = type === "application/json" ? JSON.stringify(body) : String(body);
    res.writeHead(status, {
      "content-type": type === "application/json" ? type : `${type}; charset=utf-8`,
      "content-length": Buffer.byteLength(payload),
      // The page is regenerated on every start; a cached copy would hide changes.
      "cache-control": "no-store"
    });
    res.end(payload);
  }
  async function readJson(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 1e6) throw new Error("request body too large");
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const server = createServer2((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const decision = authorize(
        { token, host },
        {
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          query: url.searchParams.get("token")
        }
      );
      if (!decision.allow) {
        send(res, 401, {
          error: "This UI needs a token. Open it with ?token=\u2026 or send an Authorization: Bearer header."
        });
        return;
      }
      if ("setCookie" in decision && decision.setCookie) {
        res.setHeader("set-cookie", decision.setCookie);
      }
      try {
        if (route === "GET /") {
          send(res, 200, APP_HTML, "text/html");
          return;
        }
        if (url.pathname.startsWith("/desktop/")) {
          const upstream = desktopUpstreamPath(url.pathname, url.search);
          if (!upstream) {
            send(res, 404, { error: `Not a desktop path: ${url.pathname}` });
            return;
          }
          await proxyDesktop(req, res, upstream);
          return;
        }
        if (route === "GET /vendor/markdown-it.js") {
          try {
            vendorScript ??= readFileSync6(vendorPath());
            res.writeHead(200, {
              "content-type": "application/javascript; charset=utf-8",
              "content-length": vendorScript.length,
              "cache-control": "no-store"
            });
            res.end(vendorScript);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log(`markdown-it is unavailable: ${detail}`);
            send(res, 404, { error: detail });
          }
          return;
        }
        if (route === "GET /recording") {
          const name = url.searchParams.get("name") ?? "";
          await proxyDesktop(
            req,
            res,
            `/recordings/file?name=${encodeURIComponent(name)}`
          );
          return;
        }
        if (route === "POST /api/clipboard") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not available." });
            return;
          }
          if (!registry2.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          const index = registry2.displayIndexFor(agentId);
          try {
            const result = typeof body.text === "string" ? await client.writeClipboard(body.text, index) : await client.readClipboard(index);
            send(res, 200, result);
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (route === "GET /api/usage") {
          const since = Number(url.searchParams.get("since") ?? 0);
          const afterSeq = Number.isFinite(since) && since > 0 ? since : 0;
          send(res, 200, {
            records: orchestrator.usage.since(afterSeq, 500),
            totals: orchestrator.usage.totals(afterSeq)
          });
          return;
        }
        if (route === "GET /api/recordings") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 200, { recordings: [] });
            return;
          }
          send(res, 200, await client.listRecordings());
          return;
        }
        if (route === "POST /api/record") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const action = String(body.action ?? "");
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not available." });
            return;
          }
          if (!registry2.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          const index = registry2.displayIndexFor(agentId);
          const name = registry2.get(agentId).profile.name;
          try {
            const result = action === "start" ? await client.startRecording({ display: index, name }) : await client.stopRecording(index);
            log(
              action === "start" ? `recording ${name}'s desktop to ${result.file}` : `recording saved: ${result.file} (${result.size_bytes ?? 0} bytes)`
            );
            send(res, 200, result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send(res, 400, { error: message });
          }
          return;
        }
        if (route === "GET /api/state") {
          send(res, 200, {
            provider: describeProvider(options.provider),
            box: { ...box, ok: box.connected },
            agents: registry2.list().map((record) => {
              const index = registry2.displayIndexFor(record.id);
              return {
                id: record.id,
                name: record.profile.name,
                title: record.profile.title ?? "",
                description: record.profile.description,
                // Every agent has its own desktop, so the UI shows whichever one
                // belongs to the agent you are looking at.
                displayIndex: index,
                desktopUrl: `/desktop/${index}/vnc.html?autoconnect=1&resize=scale&path=desktop/${index}/websockify`
              };
            })
          });
          return;
        }
        if (route === "GET /api/activity") {
          send(res, 200, activity.list());
          return;
        }
        if (route === "GET /api/transcript") {
          const id = url.searchParams.get("agent") ?? "";
          if (!registry2.has(id)) {
            send(res, 404, { error: `No agent ${id}` });
            return;
          }
          const roster = registry2.list().map((record) => ({
            id: record.id,
            name: record.profile.name
          }));
          send(res, 200, toDisplayEntries(registry2.readTranscript(id), roster));
          return;
        }
        if (route === "POST /api/agents") {
          const body = await readJson(req);
          const created = registry2.create({
            name: String(body.name ?? ""),
            description: String(body.description ?? "")
          });
          log(`created agent ${created.profile.name} (${created.id})`);
          send(res, 200, { id: created.id, name: created.profile.name });
          return;
        }
        if (route === "POST /api/prompt") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const text = String(body.text ?? "").trim();
          if (!registry2.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          if (!text) {
            send(res, 400, { error: "text is required" });
            return;
          }
          broadcast({ type: "prompt", agentId, text });
          send(res, 202, { accepted: true });
          void orchestrator.prompt(agentId, text).then(() => orchestrator.settle()).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            log(`turn failed: ${message}`);
            broadcast({ type: "error", message });
          });
          return;
        }
        if (route === "GET /api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive"
          });
          res.write(": connected\n\n");
          clients.add(res);
          const keepAlive = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              clearInterval(keepAlive);
              clients.delete(res);
            }
          }, 2e4);
          req.on("close", () => {
            clearInterval(keepAlive);
            clients.delete(res);
          });
          return;
        }
        send(res, 404, { error: `No route for ${route}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`error on ${route}: ${message}`);
        if (!res.headersSent) send(res, 500, { error: message });
      }
    })();
  });
  server.on("upgrade", (req, clientSocket, head) => {
    const raw = req.url ?? "";
    const [pathname, query] = raw.split("?");
    const upstreamPath = desktopUpstreamPath(pathname ?? "", query ? `?${query}` : "");
    if (!upstreamPath) {
      clientSocket.destroy();
      return;
    }
    const upgradeDecision = authorize(
      { token, host },
      { authorization: req.headers.authorization, cookie: req.headers.cookie }
    );
    if (!upgradeDecision.allow) {
      clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    void openUpgrade(req, clientSocket, head, upstreamPath);
  });
  async function openUpgrade(req, clientSocket, head, upstreamPath) {
    const origin = await resolveBoxdOrigin();
    if (!origin) {
      clientSocket.destroy();
      return;
    }
    const upstream = netConnect2(origin.port, origin.host, () => {
      const headers = Object.entries(req.headers).map(
        ([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r
`
      ).join("");
      upstream.write(`GET ${upstreamPath} HTTP/1.1\r
${headers}\r
`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  }
  const host = options.host ?? "127.0.0.1";
  const configured = options.token ?? process.env.AGENTBOX_UI_TOKEN;
  let token = configured;
  if (!token && !isLoopback(host)) {
    token = randomBytes3(16).toString("hex");
    log(`bound to ${host} with no token configured; generated one`);
    log(`open: http://${host}:${options.port}/?token=${token}`);
  }
  if (!token) {
    log("no UI token: anything that can reach this port can drive the agents");
  }
  await new Promise((resolve5) => server.listen(options.port, host, resolve5));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  options.onReady?.(`http://${host}:${port}`);
  return () => {
    for (const client of clients) client.end();
    server.close();
  };
}

// src/cli.ts
var here = dirname7(fileURLToPath(import.meta.url));
function agentboxHome2() {
  return process.env.AGENTBOX_HOME ?? join10(homedir4(), ".agentbox");
}
function boxConfig(overrides = {}) {
  return defaultBoxConfig(overrides);
}
var out = (line = "") => process.stdout.write(`${line}
`);
var err = (line) => process.stderr.write(`${line}
`);
function dim(text) {
  return process.stdout.isTTY ? `\x1B[2m${text}\x1B[0m` : text;
}
function bold(text) {
  return process.stdout.isTTY ? `\x1B[1m${text}\x1B[0m` : text;
}
async function cmdBoxBuild() {
  const config = boxConfig();
  const manager = new BoxManager(config);
  const context = resolve4(here, "..", "docker", "box");
  const bundle = join10(context, "boxd.cjs");
  if (!existsSync7(bundle)) {
    err(
      `Daemon bundle missing at ${bundle}.
Run \`npm run build:boxd\` first \u2014 the image copies the bundle in.`
    );
    return 1;
  }
  out(`Building ${config.image}. This takes a few minutes the first time.`);
  await manager.build(context, (line) => out(dim(line)));
  out("Done. Start it with `agentbox box up`.");
  return 0;
}
async function cmdBoxUp(argv) {
  const withHost = argv.includes("--with-host");
  const manager = new BoxManager(boxConfig({ withHost }));
  const { status } = await manager.up({
    recreate: argv.includes("--recreate"),
    onOutput: (line) => out(dim(line))
  });
  out("");
  out(`${bold("Box running")} (${status.containerName})`);
  if (status.boxdUrl) out(`  daemon:  ${status.boxdUrl}`);
  if (withHost) {
    out(`  web UI:  http://127.0.0.1:7777/?token=${uiToken()}`);
    out("");
    out("The orchestrator runs inside the box. Nothing here drives it.");
  } else {
    out("");
    out("Each agent gets its own desktop inside the box. Run `agentbox web` to see them.");
  }
  return 0;
}
async function cmdBoxStatus() {
  const manager = new BoxManager(boxConfig());
  if (!await manager.dockerAvailable()) {
    err("Cannot reach a Docker engine. Check `docker version` and DOCKER_HOST.");
    return 1;
  }
  const status = await manager.status();
  out(`container: ${status.containerName}`);
  out(`state:     ${status.state}`);
  out(`engine:    ${process.env.DOCKER_HOST ?? "local"} (ports on ${resolveDockerHostAddress()})`);
  if (status.state !== "running") {
    out("");
    out("Start it with `agentbox box up`.");
    return 0;
  }
  out(`daemon:    ${status.boxdUrl ?? "port not published"}`);
  try {
    const client = await manager.connect();
    const health = await client.health();
    const size = health.resolution ? `${health.resolution.display.width}x${health.resolution.display.height}` : "no display detected";
    out(
      `health:    ok, display ${health.display} at ${size}, up ${health.uptime_seconds}s`
    );
    if (health.resolution) {
      out(
        `api space: ${health.resolution.api.width}x${health.resolution.api.height} (what the model sees)`
      );
    }
    const running = health.displays ?? [];
    out(
      `desktops:  ${running.length === 0 ? "none yet" : running.map((d) => d.index).join(", ")}`
    );
  } catch (error) {
    out(`health:    ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}
async function cmdBoxDown(argv) {
  const manager = new BoxManager(boxConfig());
  await manager.down({ remove: argv.includes("--rm") });
  out(argv.includes("--rm") ? "Box stopped and removed." : "Box stopped.");
  return 0;
}
async function cmdBoxLogs(argv) {
  const manager = new BoxManager(boxConfig());
  const tailIndex = argv.indexOf("--tail");
  const tail = tailIndex >= 0 ? Number(argv[tailIndex + 1] ?? 200) : 200;
  out(await manager.logs(tail));
  return 0;
}
function ownerFor(displayIndex) {
  if (displayIndex === void 0) return void 0;
  try {
    return new AgentRegistry().boxOwnerTokenForDisplay(displayIndex);
  } catch {
    return void 0;
  }
}
function displayArg(argv) {
  const at = argv.indexOf("--display");
  const value = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DISPLAY_INDEX;
}
async function cmdBoxShot(argv) {
  const target = argv.find((arg) => !arg.startsWith("-")) ?? "box-screenshot.webp";
  const manager = new BoxManager(boxConfig());
  const client = await manager.connect();
  const display = displayArg(argv);
  const result = await client.computer([{ action: "screenshot" }], {
    display,
    owner: ownerFor(display)
  });
  if (!result.screenshot) {
    err("The box returned an empty screenshot.");
    return 1;
  }
  writeFileSync6(target, Buffer.from(result.screenshot, "base64"));
  out(`Wrote ${target} (${result.duration_ms}ms).`);
  return 0;
}
async function cmdBoxExec(argv) {
  const command = argv.join(" ").trim();
  if (!command) {
    err("Usage: agentbox box exec <command>");
    return 1;
  }
  const manager = new BoxManager(boxConfig());
  const client = await manager.connect();
  const display = displayArg(argv);
  const result = await client.exec(command, { display, owner: ownerFor(display) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exit_code;
}
function cmdAgents() {
  const registry2 = new AgentRegistry();
  const agents = registry2.list();
  if (agents.length === 0) {
    out("No agents yet. `agentbox chat` creates a coordinator to start with,");
    out("or make one directly: agentbox agent new <name> <description>");
    return 0;
  }
  out(`${agents.length} agent(s) in ${registry2.root}:`);
  out("");
  for (const agent of agents) {
    const title = agent.profile.title ? ` \u2014 ${agent.profile.title}` : "";
    const hidden = agent.profile.hidden ? dim(" (hidden)") : "";
    out(`${bold(agent.profile.name)}${title}${hidden}`);
    out(dim(`  id: ${agent.id}`));
    if (agent.profile.description) {
      const summary = agent.profile.description.replace(/\s+/g, " ").slice(0, 140);
      out(dim(`  ${summary}${agent.profile.description.length > 140 ? "..." : ""}`));
    }
    out("");
  }
  return 0;
}
function cmdAgentNew(argv) {
  const [name, ...rest] = argv;
  if (!name) {
    err("Usage: agentbox agent new <name> [description]");
    return 1;
  }
  const registry2 = new AgentRegistry();
  const created = registry2.create({ name, description: rest.join(" ") });
  out(`Created ${created.profile.name} (id: ${created.id})`);
  out(dim(`  ${created.dir}`));
  return 0;
}
function makeRenderer() {
  let streaming = false;
  let lastAgent = "";
  const endStream = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };
  const onTurnEvent = (event) => {
    switch (event.type) {
      case "text": {
        if (!streaming || lastAgent !== event.agentName) {
          endStream();
          process.stdout.write(`${bold(event.agentName)}: `);
          lastAgent = event.agentName;
          streaming = true;
        }
        process.stdout.write(event.delta);
        return;
      }
      case "tool_start": {
        endStream();
        const detail = event.tool === "bash" ? String(event.input.command ?? "") : event.tool === "SendToAgent" ? String(event.input.target_id ?? "") : "";
        out(dim(`  ${event.agentName} \u2192 ${event.tool}${detail ? ` ${detail}` : ""}`));
        return;
      }
      case "tool_end": {
        if (event.summary) out(dim(`    ${event.summary}`));
        return;
      }
      case "aborted": {
        endStream();
        out(dim("  (turn superseded by a priority message)"));
        return;
      }
      default:
        return;
    }
  };
  const onBusEvent = (event) => {
    if (event.type === "message_sent") {
      endStream();
      const flag = event.priority ? " (priority)" : "";
      out(dim(`  \u2709 ${event.fromName} \u2192 ${event.toName}${flag}`));
    } else if (event.type === "turn_failed") {
      endStream();
      err(`  ! turn failed for ${event.agentId}: ${event.error}`);
    }
  };
  return { onTurnEvent, onBusEvent, endStream };
}
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--provider",
  "--model",
  "--effort",
  "--port",
  "--host",
  "--token",
  "--allow"
]);
function parseArgs(argv) {
  const positional = [];
  const flags = /* @__PURE__ */ new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value !== void 0 && !value.startsWith("-")) {
        flags.set(arg, value);
        i++;
        continue;
      }
    }
    flags.set(arg, true);
  }
  return { positional, flags };
}
async function cmdChat(argv) {
  const { positional, flags } = parseArgs(argv);
  const providerName = flags.get("--provider");
  const modelOverride = flags.get("--model");
  if (typeof modelOverride === "string") {
    process.env.AGENTBOX_MODEL = modelOverride;
  }
  let provider;
  try {
    provider = resolveProvider(
      typeof providerName === "string" ? providerName : void 0
    );
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (provider.keyEnv === "ANTHROPIC_API_KEY" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    out(
      dim(
        "No ANTHROPIC_API_KEY set \u2014 relying on an `ant auth login` profile. Run `ant auth status` if requests fail."
      )
    );
  }
  const noBox = flags.has("--no-box");
  const agentArg = positional[0];
  const oneShot = positional.slice(1).join(" ").trim();
  const renderer = makeRenderer();
  let orchestrator;
  try {
    orchestrator = new Orchestrator({
      provider,
      useBox: !noBox,
      onTurnEvent: renderer.onTurnEvent,
      onBusEvent: renderer.onBusEvent
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  out(dim(`model: ${describeProvider(provider)}`));
  const box = await orchestrator.connectBox();
  out(box.connected ? dim(`box: ${box.detail}`) : dim(`box: unavailable \u2014 ${box.detail}`));
  const agent = agentArg ? orchestrator.registry.resolve(agentArg) : orchestrator.ensureDefaultAgent();
  out(dim(`talking to ${agent.profile.name} (${agent.id})`));
  out("");
  const runOne = async (text) => {
    let ok = true;
    try {
      await orchestrator.prompt(agent.id, text);
      await orchestrator.settle();
    } catch (error) {
      renderer.endStream();
      err(`error: ${error instanceof Error ? error.message : String(error)}`);
      ok = false;
    }
    renderer.endStream();
    return ok;
  };
  if (oneShot) {
    return await runOne(oneShot) ? 0 : 1;
  }
  const rl = createInterface2({ input: process.stdin, output: process.stdout });
  out(dim("Type a message. Ctrl-C or an empty line with 'exit' to quit."));
  try {
    for (; ; ) {
      const line = (await rl.question(`
${bold("you")}: `)).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      out("");
      await runOne(line);
    }
  } finally {
    rl.close();
  }
  return 0;
}
async function cmdEgress(argv) {
  const { flags } = parseArgs(argv);
  const portFlag = flags.get("--port");
  const hostFlag = flags.get("--host");
  const allowFlag = flags.get("--allow");
  try {
    const server = startEgressRelay({
      // The box token by default, so a box started by this CLI can already authenticate.
      token: loadBoxToken(),
      port: typeof portFlag === "string" ? Number(portFlag) : void 0,
      host: typeof hostFlag === "string" ? hostFlag : void 0,
      allow: typeof allowFlag === "string" ? allowFlag.split(",").map((entry) => entry.trim()).filter(Boolean) : void 0,
      log: (line) => out(dim(line))
    });
    out("");
    out(`${bold("egress relay")} running. Point a box at it with:`);
    out(dim("  AGENTBOX_EGRESS_RELAY=host.docker.internal:8790 agentbox box up --recreate"));
    out(dim("Ctrl-C to stop."));
    await new Promise((resolve5) => server.on("close", resolve5));
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
async function cmdWeb(argv) {
  const { flags } = parseArgs(argv);
  const providerName = flags.get("--provider");
  const modelOverride = flags.get("--model");
  if (typeof modelOverride === "string") process.env.AGENTBOX_MODEL = modelOverride;
  const portFlag = flags.get("--port");
  const port = typeof portFlag === "string" ? Number(portFlag) : 7777;
  const tokenFlag = flags.get("--token");
  const hostFlag = flags.get("--host");
  const host = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
  let provider;
  try {
    provider = resolveProvider(
      typeof providerName === "string" ? providerName : void 0
    );
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const registry2 = new AgentRegistry();
  if (registry2.list().length === 0) {
    const created = registry2.create({
      name: "Ada",
      title: "coordinator",
      description: "You coordinate this user's team of agents. You are the one they talk to first. When a request falls squarely inside a teammate's remit, hand it to them and say you did; when the team is missing someone the work clearly needs, propose creating them rather than creating them unasked. Do the work yourself when it is faster than delegating."
    });
    out(dim(`created ${created.profile.name} to start with`));
  }
  out(dim(`model: ${describeProvider(provider)}`));
  out(dim(`config: ${ensureConfigFile()}`));
  try {
    await startWebServer({
      port,
      host,
      token: typeof tokenFlag === "string" ? tokenFlag : void 0,
      provider,
      useBox: !flags.has("--no-box"),
      onLog: (line) => out(dim(line)),
      onReady: (url) => {
        out("");
        out(`${bold("agentbox web")} on ${url}`);
        out(dim("Open it in a browser. Ctrl-C to stop."));
      }
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  await new Promise((resolve5) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => resolve5());
    }
  });
  out("\nstopped");
  return 0;
}
var USAGE = `agentbox \u2014 multi-agent orchestrator with a Docker box and Linux computer-use

Usage: agentbox <command> [args]

Box:
  box build                 Build the box image (needs \`npm run build:boxd\` first)
  box up [--recreate]       Start the box and wait for its desktop
             --with-host    also run the orchestrator inside it (web UI on 7777)
  box status                Show container state, ports, and health
  box down [--rm]           Stop the box, optionally removing the container
  box logs [--tail N]       Container logs
  box shot [file.webp]      Save a screenshot of the box desktop
  box exec <command>        Run a shell command in the box

Agents:
  agents                    List agents
  agent new <name> [desc]   Create an agent

Chat:
  chat [agent] [message]    Talk to an agent. Omit the message for a REPL,
                            omit the agent to use the first one.
                            --no-box              run without the box tools
                            --provider <name>     anthropic | minimax | custom
                            --model <id>          override the model

The box runs wherever your Docker engine points: set DOCKER_HOST or use
\`docker context use\` to put it on a remote machine.

Providers:
  anthropic (default)      claude-opus-5; full vision, caching, thinking
  minimax                  MiniMax-M3 via its Anthropic-compatible endpoint.
                           M3 can see screenshots; M2 accepts and silently
                           discards them, so it loses the computer tool.
  custom                   Set AGENTBOX_BASE_URL, AGENTBOX_MODEL, and
                           AGENTBOX_KEY_ENV. Every optional capability
                           defaults off; opt in with AGENTBOX_VISION=1,
                           AGENTBOX_CACHING=1, AGENTBOX_THINKING=1.

Environment:
  ANTHROPIC_API_KEY         API credentials (or run \`ant auth login\`)
  AGENTBOX_PROVIDER         Which provider to use (see above)
  AGENTBOX_HOME             State directory (default ~/.agentbox)
  AGENTBOX_CONFIG           Config file (default <state>/config.json)
  AGENTBOX_IMAGE            Box image tag (default agentbox/box:latest)
  AGENTBOX_BOX_HOST         Override where published ports are reachable
  AGENTBOX_WIDTH/HEIGHT     Box display size (default 1280x800)`;
async function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  switch (command) {
    case void 0:
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return 0;
    case "box": {
      const [sub, ...boxArgs] = rest;
      switch (sub) {
        case "build":
          return cmdBoxBuild();
        case "up":
          return cmdBoxUp(boxArgs);
        case "status":
          return cmdBoxStatus();
        case "down":
          return cmdBoxDown(boxArgs);
        case "logs":
          return cmdBoxLogs(boxArgs);
        case "shot":
          return cmdBoxShot(boxArgs);
        case "exec":
          return cmdBoxExec(boxArgs);
        default:
          err(`Unknown box command: ${sub ?? "(none)"}`);
          out(USAGE);
          return 1;
      }
    }
    case "agents":
      return cmdAgents();
    case "agent": {
      const [sub, ...agentArgs] = rest;
      if (sub === "new") return cmdAgentNew(agentArgs);
      err(`Unknown agent command: ${sub ?? "(none)"}`);
      return 1;
    }
    case "chat":
      return cmdChat(rest);
    case "egress":
      return cmdEgress(rest);
    case "web":
      return cmdWeb(rest);
    case "providers": {
      for (const name of providerNames()) {
        const profile = resolveProvider(name);
        const key = process.env[profile.keyEnv] ? "key set" : `needs ${profile.keyEnv}`;
        out(`${bold(name)}  ${dim(`${key}`)}`);
        out(dim(`  ${describeProvider(profile)}`));
      }
      return 0;
    }
    case "where":
      out(`state:  ${agentboxHome2()}`);
      out(`agents: ${defaultAgentsRoot()}`);
      return 0;
    default:
      err(`Unknown command: ${command}`);
      out(USAGE);
      return 1;
  }
}
main().then((code) => process.exit(code)).catch((error) => {
  err(`
error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
