import { setTimeout as delay } from "timers/promises";

import _ from "lodash";
import type { AxiosResponse } from "axios";
import type {
  Browser,
  BrowserContext,
  Page,
  Request as PlaywrightRequest,
  Route,
} from "playwright-core";
import { chromium } from "playwright-core";

import {
  buildJimengRequestInit,
  checkResult,
  JimengRequestInit,
  JimengRequestOptions,
} from "@/api/controllers/core.ts";
import logger from "@/lib/logger.ts";
import { RETRY_CONFIG } from "@/api/consts/common.ts";

const SEEDANCE_PAGE_URL = "https://jimeng.jianying.com/ai-tool/generate?type=video";
const SESSION_IDLE_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const PAGE_READY_TIMEOUT_MS = 20 * 1000;
const NETWORK_CAPTURE_TIMEOUT_MS = 10 * 1000;
const BROWSER_REQUEST_TIMEOUT_MS = 45 * 1000;
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media"]);
const ALLOWED_RESOURCE_TYPES = new Set(["document", "script", "xhr", "fetch", "other"]);
const ALLOWED_HOST_SUFFIXES = [".jianying.com", ".vlabstatic.com", ".bytescm.com"];
const FORBIDDEN_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
]);

interface BrowserPool {
  browser: Browser;
  proxyUrl: string | null;
  sessionKeys: Set<string>;
}

interface BrowserSession {
  sessionKey: string;
  poolKey: string;
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

function maskProxyUrl(proxyUrl: string | null) {
  if (!proxyUrl) return "DIRECT";
  return proxyUrl.replace(/\/\/([^@/]+)@/i, "//***@");
}

function buildPlaywrightProxy(proxyUrl: string | null) {
  if (!proxyUrl) return undefined;

  const parsedUrl = new URL(proxyUrl);
  return {
    server: `${parsedUrl.protocol}//${parsedUrl.host}`,
    ...(parsedUrl.username ? { username: decodeURIComponent(parsedUrl.username) } : {}),
    ...(parsedUrl.password ? { password: decodeURIComponent(parsedUrl.password) } : {}),
  };
}

function isAllowedHostname(hostname: string) {
  return hostname === "jimeng.jianying.com"
    || ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function shouldAbortRoute(route: Route) {
  const request = route.request();
  const resourceType = request.resourceType();

  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true;
  if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) return true;

  try {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return false;
    return !isAllowedHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

function toPlaywrightCookies(cookieHeader?: string) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) return null;

      return {
        name: entry.slice(0, separatorIndex),
        value: entry.slice(separatorIndex + 1),
        url: "https://jimeng.jianying.com/",
      };
    })
    .filter((cookie): cookie is { name: string; value: string; url: string } => cookie !== null);
}

function sanitizeHeaders(requestInit: JimengRequestInit) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestInit.headers)) {
    if (_.isNil(value)) continue;
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = String(value);
  }

  if (!_.isNil(requestInit.data) && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

function createAxiosLikeResponse(data: any, status: number, statusText: string): AxiosResponse {
  return {
    data,
    status,
    statusText,
    headers: {},
    config: {} as any,
    request: undefined,
  };
}

function isRetryableBrowserError(error: any) {
  if (!error) return false;

  const code = String(error.code || "").toUpperCase();
  if (RETRYABLE_ERROR_CODES.has(code)) return true;

  const message = String(error.message || "").toLowerCase();
  if (!message) return false;

  if (message.includes("请先执行 npm run install:chromium")) {
    return false;
  }

  return [
      "timeout",
      "socket hang up",
      "browser has been closed",
      "target page, context or browser has been closed",
      "execution context was destroyed",
      "page crashed",
      "context destroyed",
      "navigation",
      "net::err",
      "failed to fetch",
      "network",
      "proxy",
      "aborterror",
      "chromium",
    ].some((keyword) => message.includes(keyword));
}

class BrowserService {
  private static instance: BrowserService | null = null;

  private readonly pools = new Map<string, BrowserPool>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly requestChains = new Map<string, Promise<unknown>>();
  private readonly cleanupTimer: NodeJS.Timeout;

  private constructor() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions().catch((error: any) => {
        logger.warn(`浏览器会话清理失败: ${error.message}`);
      });
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  static getInstance() {
    if (!this.instance) {
      this.instance = new BrowserService();
    }
    return this.instance;
  }

  async request(
    method: string,
    uri: string,
    refreshToken: string,
    options: JimengRequestOptions = {},
  ) {
    if (options.responseType === "stream") {
      throw new Error("浏览器代理暂不支持流式请求");
    }

    const requestInit = buildJimengRequestInit(method, uri, refreshToken, options);
    if (!requestInit.regionInfo.isCN) {
      throw new Error("浏览器代理仅支持国内站请求");
    }

    const execute = async () => this.performRequestWithRetry(refreshToken, requestInit);
    const chain = this.requestChains.get(refreshToken) ?? Promise.resolve();
    const pending = chain.then(execute, execute);
    this.requestChains.set(refreshToken, pending);

    return pending.finally(() => {
      const activeChain = this.requestChains.get(refreshToken);
      if (activeChain === pending) {
        this.requestChains.delete(refreshToken);
      }

      const session = this.sessions.get(refreshToken);
      if (session) {
        session.lastUsedAt = Date.now();
      }
    });
  }

  async dispose() {
    clearInterval(this.cleanupTimer);

    for (const sessionKey of [...this.sessions.keys()]) {
      await this.destroySession(sessionKey);
    }

    for (const [poolKey, pool] of this.pools.entries()) {
      try {
        await pool.browser.close();
      } catch (error: any) {
        logger.warn(`关闭浏览器池失败(${poolKey}): ${error.message}`);
      } finally {
        this.pools.delete(poolKey);
      }
    }
  }

  private async getOrCreateSession(sessionKey: string, requestInit: JimengRequestInit) {
    const poolKey = requestInit.proxyUrl || "__direct__";
    const existingSession = this.sessions.get(sessionKey);

    if (existingSession && !existingSession.page.isClosed() && existingSession.poolKey === poolKey) {
      existingSession.lastUsedAt = Date.now();
      logger.info(`复用浏览器会话: session=${sessionKey.slice(0, 8)}...`);
      return existingSession;
    }

    if (existingSession) {
      await this.destroySession(sessionKey);
    }

    const pool = await this.getOrCreatePool(poolKey, requestInit.proxyUrl);
    logger.info(`创建浏览器会话: session=${sessionKey.slice(0, 8)}..., proxy=${maskProxyUrl(requestInit.proxyUrl)}`);

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      context = await pool.browser.newContext({
        locale: "zh-CN",
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
      });
      await context.route("**/*", async (route) => {
        if (shouldAbortRoute(route)) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      await context.addCookies(toPlaywrightCookies(requestInit.headers.Cookie));

      page = await context.newPage();
      await page.goto(SEEDANCE_PAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      await page.waitForFunction(
        () => typeof (window as any)._SdkGlueInit === "function" && !!(window as any).bdms,
        { timeout: PAGE_READY_TIMEOUT_MS },
      );
      await delay(1500);

      const session: BrowserSession = {
        sessionKey,
        poolKey,
        context,
        page,
        lastUsedAt: Date.now(),
      };

      this.sessions.set(sessionKey, session);
      pool.sessionKeys.add(sessionKey);
      return session;
    } catch (error) {
      try {
        await page?.close();
      } catch {
        // Ignore page close failures during setup rollback.
      }

      try {
        await context?.close();
      } catch {
        // Ignore context close failures during setup rollback.
      }

      await this.disposePoolIfUnused(poolKey);
      throw error;
    }
  }

  private async getOrCreatePool(poolKey: string, proxyUrl: string | null) {
    const existingPool = this.pools.get(poolKey);
    if (existingPool) return existingPool;

    logger.info(`启动 Chromium: proxy=${maskProxyUrl(proxyUrl)}`);
    try {
      const browser = await chromium.launch({
        headless: true,
        proxy: buildPlaywrightProxy(proxyUrl),
      });
      const pool: BrowserPool = {
        browser,
        proxyUrl,
        sessionKeys: new Set(),
      };
      this.pools.set(poolKey, pool);
      return pool;
    } catch (error: any) {
      throw new Error(
        `启动 Chromium 失败: ${error.message}. 请先执行 npm run install:chromium 安装浏览器。`,
      );
    }
  }

  private async performRequest(session: BrowserSession, requestInit: JimengRequestInit) {
    const relativePath = `${requestInit.uri}${new URL(requestInit.finalUrl).search}`;
    const headers = sanitizeHeaders(requestInit);
    const observedRequest = this.captureTargetRequest(session.page, requestInit.uri);

    logger.info(`浏览器代理请求: ${requestInit.method.toUpperCase()} ${requestInit.finalUrl}`);
    const response = await session.page.evaluate(
      async ({ method, relativePath, headers, body, timeout }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
          const fetchResponse = await fetch(relativePath, {
            method,
            headers,
            body,
            credentials: "include",
            signal: controller.signal,
          });
          const text = await fetchResponse.text();

          return {
            status: fetchResponse.status,
            statusText: fetchResponse.statusText,
            text,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        method: requestInit.method.toUpperCase(),
        relativePath,
        headers,
        body: _.isNil(requestInit.data) ? undefined : JSON.stringify(requestInit.data),
        timeout: requestInit.timeout || BROWSER_REQUEST_TIMEOUT_MS,
      },
    );

    const observedUrl = await observedRequest;
    logger.info(`浏览器代理最终请求含 a_bogus: ${observedUrl?.includes("a_bogus=") ? "yes" : "no"}`);
    if (observedUrl && !observedUrl.includes("a_bogus=")) {
      const error: any = new Error("浏览器代理请求未注入 a_bogus");
      error.code = "ECONNABORTED";
      throw error;
    }

    let responseData: any = response.text;
    if (response.text) {
      try {
        responseData = JSON.parse(response.text);
      } catch {
        responseData = response.text;
      }
    }

    if (response.status >= 500 && !_.isPlainObject(responseData)) {
      throw new Error(`浏览器代理请求失败: HTTP ${response.status} ${response.statusText}`);
    }

    return createAxiosLikeResponse(responseData, response.status, response.statusText);
  }

  private async performRequestWithRetry(sessionKey: string, requestInit: JimengRequestInit) {
    const maxRetries = RETRY_CONFIG.MAX_RETRY_COUNT;
    let retries = 0;
    let lastError: any = null;

    while (retries <= maxRetries) {
      try {
        if (retries > 0) {
          logger.info(
            `浏览器代理第 ${retries} 次重试: ${requestInit.method.toUpperCase()} ${requestInit.finalUrl}`,
          );
          await delay(RETRY_CONFIG.RETRY_DELAY);
        }

        const session = await this.getOrCreateSession(sessionKey, requestInit);
        const response = await this.performRequest(session, requestInit);
        logger.info(`浏览器代理响应状态: ${response.status} ${response.statusText}`);

        if (response.status >= 400) {
          logger.warn(`浏览器代理HTTP错误: ${response.status} ${response.statusText}`);
          if (retries < maxRetries) {
            await this.destroySession(sessionKey);
            retries++;
            continue;
          }
        }

        return checkResult(response);
      } catch (error: any) {
        lastError = error;
        logger.warn(
          `浏览器代理请求失败 (尝试 ${retries + 1}/${maxRetries + 1}): ${error.message}`,
        );

        if (!isRetryableBrowserError(error) || retries >= maxRetries) {
          break;
        }

        await this.destroySession(sessionKey);
        retries++;
      }
    }

    throw lastError;
  }

  private captureTargetRequest(page: Page, uri: string) {
    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        page.off("request", listener);
        resolve(null);
      }, NETWORK_CAPTURE_TIMEOUT_MS);

      const listener = (request: PlaywrightRequest) => {
        try {
          const url = new URL(request.url());
          if (url.pathname !== uri) return;

          clearTimeout(timeout);
          page.off("request", listener);
          resolve(request.url());
        } catch {
          // Ignore malformed URL.
        }
      };

      page.on("request", listener);
    });
  }

  private async cleanupIdleSessions() {
    const now = Date.now();
    const expiredSessions = [...this.sessions.entries()]
      .filter(([, session]) => now - session.lastUsedAt >= SESSION_IDLE_MS)
      .map(([sessionKey]) => sessionKey);

    for (const sessionKey of expiredSessions) {
      logger.info(`清理空闲浏览器会话: session=${sessionKey.slice(0, 8)}...`);
      await this.destroySession(sessionKey);
    }
  }

  private async destroySession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    this.sessions.delete(sessionKey);

    try {
      await session.page.close();
    } catch {
      // Ignore page close failures.
    }

    try {
      await session.context.close();
    } catch {
      // Ignore context close failures.
    }

    const pool = this.pools.get(session.poolKey);
    if (!pool) return;

    pool.sessionKeys.delete(sessionKey);
    if (pool.sessionKeys.size > 0) return;

    try {
      await pool.browser.close();
    } catch (error: any) {
      logger.warn(`关闭 Chromium 失败(${session.poolKey}): ${error.message}`);
    } finally {
      this.pools.delete(session.poolKey);
    }
  }

  private async disposePoolIfUnused(poolKey: string) {
    const pool = this.pools.get(poolKey);
    if (!pool || pool.sessionKeys.size > 0) return;

    try {
      await pool.browser.close();
    } catch (error: any) {
      logger.warn(`关闭 Chromium 失败(${poolKey}): ${error.message}`);
    } finally {
      this.pools.delete(poolKey);
    }
  }
}

export async function browserRequest(
  method: string,
  uri: string,
  refreshToken: string,
  options: JimengRequestOptions = {},
) {
  return BrowserService.getInstance().request(method, uri, refreshToken, options);
}

export async function disposeBrowserService() {
  await BrowserService.getInstance().dispose();
}
