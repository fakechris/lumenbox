/**
 * UCP (Universal Commerce Protocol) client for the Poppy UCP extension.
 *
 * UCP is Shopify's protocol for agent commerce. When a Company's poppy.json
 * has an `extensions.ucp` entry, the agent can discover the Company's UCP
 * profile, negotiate capabilities, and perform shopping operations.
 *
 * Flow:
 *   1. Profile discovery: GET /ucp/v1/profile → what the Company offers
 *   2. Capability negotiation: POST /ucp/v1/capabilities → what both sides support
 *   3. Shopping operations: cart, checkout, orders
 */

import type { PoppyCompany } from "./discovery.ts";
import type { PoppySession } from "./session.ts";
import { poppyRequest, poppyUrl } from "./http.ts";

// ── Types ─────────────────────────────────────────────────────

export interface UcpProfile {
  name: string;
  domain: string;
  capabilities: string[];
  endpoints: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface UcpCapabilities {
  /** What both sides agreed on. */
  negotiated: string[];
  /** Endpoints for the negotiated capabilities. */
  endpoints: Record<string, string>;
  raw: Record<string, unknown>;
}

export interface UcpCartItem {
  variantId: string;
  quantity: number;
  attributes?: Record<string, string>;
}

export interface UcpCart {
  id: string;
  items: Array<{ variantId: string; quantity: number; title?: string; price?: string }>;
  subtotal?: string;
  currency?: string;
  checkoutUrl?: string;
  raw: Record<string, unknown>;
}

export interface UcpCheckout {
  id: string;
  status: string;
  webUrl?: string;
  totalPrice?: string;
  currency?: string;
  raw: Record<string, unknown>;
}

export interface UcpOrder {
  id: string;
  status: string;
  totalPrice?: string;
  currency?: string;
  raw: Record<string, unknown>;
}

// ── UCP Client ────────────────────────────────────────────────

export class UcpClient {
  private readonly baseUrl: string;
  /** Every UCP call is on the Company's own site, through the guarded door (http.ts). */
  private readonly site: string;
  private readonly session: PoppySession;
  private accessToken?: string;

  constructor(company: PoppyCompany, session: PoppySession, accessToken?: string) {
    const ucpExt = company.extensions?.ucp?.find(e => e.endpoint);
    const ucpProto = company.agentProtocols?.find(p => p.type === "ucp");
    const endpoint = ucpExt?.endpoint ?? ucpProto?.endpoint;

    if (!endpoint) {
      throw new Error(`Company ${company.name} has no UCP endpoint`);
    }
    this.baseUrl = poppyUrl(endpoint, company.domain).toString().replace(/\/$/, "");
    this.site = company.domain;
    this.session = session;
    this.accessToken = accessToken;
  }

  /** Sets or updates the access token (after OAuth). */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  private async headers(method: string, path: string): Promise<Record<string, string>> {
    const url = `${this.baseUrl}${path}`;
    const h = await this.session.headers(method, url, this.accessToken);
    return {
      ...h,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ── Profile Discovery ─────────────────────────────────────

  /**
   * Fetches the Company's UCP profile (what they offer).
   */
  async discoverProfile(): Promise<UcpProfile> {
    const path = "/ucp/v1/profile";
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      headers: await this.headers("GET", path),
      timeoutMs: 15_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Profile discovery failed: HTTP ${response.status}`, await response.text());
    }

    const doc = (await response.json()) as Record<string, unknown>;
    return {
      name: String(doc.name ?? ""),
      domain: String(doc.domain ?? ""),
      capabilities: Array.isArray(doc.capabilities) ? doc.capabilities.filter((s): s is string => typeof s === "string") : [],
      endpoints: isStringRecord(doc.endpoints) ? doc.endpoints : {},
      raw: doc,
    };
  }

  // ── Capability Negotiation ────────────────────────────────

  /**
   * Negotiates capabilities with the Company.
   *
   * The agent sends what it supports; the Company responds with the
   * intersection — what both sides can do.
   */
  async negotiateCapabilities(
    agentCapabilities: string[],
  ): Promise<UcpCapabilities> {
    const path = "/ucp/v1/capabilities";
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: await this.headers("POST", path),
      body: JSON.stringify({ capabilities: agentCapabilities }),
      timeoutMs: 15_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Capability negotiation failed: HTTP ${response.status}`, await response.text());
    }

    const doc = (await response.json()) as Record<string, unknown>;
    return {
      negotiated: Array.isArray(doc.capabilities) ? doc.capabilities.filter((s): s is string => typeof s === "string") : [],
      endpoints: isStringRecord(doc.endpoints) ? doc.endpoints : {},
      raw: doc,
    };
  }

  // ── Shopping: Cart ────────────────────────────────────────

  /**
   * Creates a cart or adds items to an existing one.
   */
  async createCart(items: UcpCartItem[]): Promise<UcpCart> {
    const path = "/ucp/v1/cart";
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: await this.headers("POST", path),
      body: JSON.stringify({ items }),
      timeoutMs: 15_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Cart creation failed: HTTP ${response.status}`, await response.text());
    }

    return parseCart(await response.json() as Record<string, unknown>);
  }

  /**
   * Retrieves the current cart.
   */
  async getCart(cartId: string): Promise<UcpCart> {
    const path = `/ucp/v1/cart/${encodeURIComponent(cartId)}`;
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      headers: await this.headers("GET", path),
      timeoutMs: 15_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Cart fetch failed: HTTP ${response.status}`, await response.text());
    }

    return parseCart(await response.json() as Record<string, unknown>);
  }

  // ── Shopping: Checkout ────────────────────────────────────

  /**
   * Initiates checkout from a cart.
   */
  async createCheckout(cartId: string): Promise<UcpCheckout> {
    const path = "/ucp/v1/checkout";
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: await this.headers("POST", path),
      body: JSON.stringify({ cart_id: cartId }),
      timeoutMs: 15_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Checkout creation failed: HTTP ${response.status}`, await response.text());
    }

    const doc = (await response.json()) as Record<string, unknown>;
    return {
      id: String(doc.id ?? ""),
      status: String(doc.status ?? "pending"),
      webUrl: typeof doc.web_url === "string" ? doc.web_url : undefined,
      totalPrice: typeof doc.total_price === "string" ? doc.total_price : undefined,
      currency: typeof doc.currency === "string" ? doc.currency : undefined,
      raw: doc,
    };
  }

  /**
   * Completes a checkout (the irreversible step — charges the user).
   */
  async completeCheckout(checkoutId: string): Promise<UcpCheckout> {
    const path = `/ucp/v1/checkout/${encodeURIComponent(checkoutId)}/complete`;
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: await this.headers("POST", path),
      timeoutMs: 30_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Checkout completion failed: HTTP ${response.status}`, await response.text());
    }

    const doc = (await response.json()) as Record<string, unknown>;
    return {
      id: String(doc.id ?? ""),
      status: String(doc.status ?? ""),
      webUrl: typeof doc.web_url === "string" ? doc.web_url : undefined,
      totalPrice: typeof doc.total_price === "string" ? doc.total_price : undefined,
      currency: typeof doc.currency === "string" ? doc.currency : undefined,
      raw: doc,
    };
  }

  // ── Shopping: Orders ──────────────────────────────────────

  /**
   * Lists orders for the current user.
   */
  async listOrders(): Promise<UcpOrder[]> {
    const path = "/ucp/v1/orders";
    const response = await poppyRequest(`${this.baseUrl}${path}`, {
      headers: await this.headers("GET", path),
      timeoutMs: 15_000,
    }, this.site);

    if (!response.ok) {
      throw new UcpError(`Orders fetch failed: HTTP ${response.status}`, await response.text());
    }

    const doc = (await response.json()) as Record<string, unknown>;
    const orders = Array.isArray(doc.orders) ? doc.orders : [];
    return orders
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map(o => ({
        id: String(o.id ?? ""),
        status: String(o.status ?? ""),
        totalPrice: typeof o.total_price === "string" ? o.total_price : undefined,
        currency: typeof o.currency === "string" ? o.currency : undefined,
        raw: o,
      }));
  }
}

// ── Helpers ───────────────────────────────────────────────────

function parseCart(doc: Record<string, unknown>): UcpCart {
  const items = Array.isArray(doc.items) ? doc.items : [];
  return {
    id: String(doc.id ?? ""),
    items: items
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map(i => ({
        variantId: String(i.variant_id ?? i.variantId ?? ""),
        quantity: Number(i.quantity ?? 0),
        title: typeof i.title === "string" ? i.title : undefined,
        price: typeof i.price === "string" ? i.price : undefined,
      })),
    subtotal: typeof doc.subtotal === "string" ? doc.subtotal : undefined,
    currency: typeof doc.currency === "string" ? doc.currency : undefined,
    checkoutUrl: typeof doc.checkout_url === "string" ? doc.checkout_url : undefined,
    raw: doc,
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v).every(val => typeof val === "string");
}

export class UcpError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}
