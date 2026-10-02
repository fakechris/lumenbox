/** Vendor directory readers. A partial or malformed walk never becomes a snapshot. */

import type { DirectorySnapshot } from "../host/directory.ts";
import type { ChannelType } from "./identity.ts";

export interface DirectoryProvider {
  readonly type: ChannelType;
  /** The org as the app can see it, walked from the root. */
  fetchDirectory(args: {
    clientId: string;
    clientSecret: string;
    fetchFn: typeof fetch;
  }): Promise<DirectorySnapshot>;
}

/** A ceiling on walks: a loop over a hostile or cyclic answer ends, loudly. */
const MAX_PAGES = 500;
const TIMEOUT_MS = 15_000;

/** Feishu's hosts flip wholesale for Lark, read at call time like the login provider does. */
function feishuApiHost(): string {
  return process.env.FEISHU_DOMAIN === "lark" ? "open.larksuite.com" : "open.feishu.cn";
}

/**
 * Feishu: a tenant token, the department tree, then each department's people
 * (root included, as department `0`). Feishu answers 200 with a `code` — the
 * code is the error channel, and a non-zero one is thrown with its words.
 */
export const feishuDirectory: DirectoryProvider = {
  type: "feishu",
  async fetchDirectory({ clientId, clientSecret, fetchFn }) {
    const api = feishuApiHost();
    const tokenResponse = await fetchFn(`https://${api}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: clientId, app_secret: clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const tokenBody = (await tokenResponse.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
    };
    if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
      throw new Error(`tenant_access_token: ${tokenBody.msg ?? `code ${tokenBody.code ?? tokenResponse.status}`}`);
    }
    const auth = { authorization: `Bearer ${tokenBody.tenant_access_token}` };

    // Departments, paged. find_by_page lists the departments the app can see;
    // the root (`0`) is implied and never in the list itself.
    const departments: DirectorySnapshot["departments"] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ page_size: "50", department_id_type: "department_id" });
      if (pageToken !== undefined) query.set("page_token", pageToken);
      const response = await fetchFn(`https://${api}/open-apis/contact/v3/departments/find_by_page?${query}`, {
        headers: auth,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json()) as {
        code?: number;
        msg?: string;
        data?: {
          items?: Array<{ department_id?: string; name?: string; parent_department_id?: string }>;
          has_more?: boolean;
          page_token?: string;
        };
      };
      if (!response.ok || body.code !== 0) throw new Error(`departments: ${body.msg ?? `code ${body.code}`}`);
      if (!Array.isArray(body.data?.items)) throw new Error("Invalid directory page");
      for (const item of body.data.items) {
        if (typeof item.department_id !== "string" || item.department_id === "") throw new Error("Invalid department");
        departments.push({
          vendorId: item.department_id,
          name: typeof item.name === "string" ? item.name : item.department_id,
          parentVendorId:
            typeof item.parent_department_id === "string" && item.parent_department_id !== ""
              ? item.parent_department_id
              : "0",
        });
      }
      if (body.data.has_more !== true) break;
      if (!body.data.page_token || body.data.page_token === pageToken || page === MAX_PAGES - 1) throw new Error("Incomplete department pagination");
      pageToken = body.data.page_token;
    }

    // People, per department — root's own included as `0`, because a person
    // directly under the company is in no listed department otherwise.
    const bySubject = new Map<string, DirectorySnapshot["people"][number]>();
    for (const vendorId of ["0", ...departments.map(department => department.vendorId)]) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ department_id: vendorId, page_size: "50", department_id_type: "department_id", user_id_type: "open_id" });
        if (cursor !== undefined) query.set("page_token", cursor);
        const response = await fetchFn(`https://${api}/open-apis/contact/v3/users/find_by_department?${query}`, {
          headers: auth,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await response.json()) as {
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{ open_id?: string; name?: string; department_ids?: string[]; title?: string }>;
            has_more?: boolean;
            page_token?: string;
          };
        };
        if (!response.ok || body.code !== 0) throw new Error("Department people read failed");
        if (!Array.isArray(body.data?.items)) throw new Error("Invalid people page");
        for (const item of body.data?.items ?? []) {
          if (typeof item.open_id !== "string" || item.open_id === "") throw new Error("Invalid person");
          const departmentIds =
            item.department_ids !== undefined && item.department_ids.length > 0
              ? item.department_ids
              : [vendorId];
          const known = bySubject.get(item.open_id);
          if (known === undefined) {
            bySubject.set(item.open_id, {
              vendorSubject: item.open_id,
              name: typeof item.name === "string" ? item.name : item.open_id,
              departmentVendorIds: departmentIds,
              ...(typeof item.title === "string" && item.title !== "" ? { title: item.title } : {}),
            });
          } else {
            // A person listed under two departments keeps both, not the last one.
            known.departmentVendorIds = [
              ...new Set([...known.departmentVendorIds, ...departmentIds]),
            ];
          }
        }
        if (body.data.has_more !== true) break;
        if (!body.data.page_token || body.data.page_token === cursor || page === MAX_PAGES - 1) throw new Error("Incomplete people pagination");
        cursor = body.data.page_token;
      }
    }
    return { departments, people: [...bySubject.values()] };
  },
};

/**
 * DingTalk: the app's token (the same one the door's REST twin uses), the
 * department tree by recursion from the root, and each department's people
 * with cursor pagination. A person in two departments appears in both walks;
 * the walks merge, not overwrite.
 */
export const dingtalkDirectory: DirectoryProvider = {
  type: "dingtalk",
  async fetchDirectory({ clientId, clientSecret, fetchFn }) {
    const tokenResponse = await fetchFn("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const token = (await tokenResponse.json()) as { accessToken?: string };
    const accessToken = token.accessToken;
    if (!tokenResponse.ok || !accessToken) {
      throw new Error(`access token: HTTP ${tokenResponse.status}`);
    }
    const oapi = (path: string): string =>
      `https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(accessToken)}`;
    const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      const response = await fetchFn(oapi(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const parsed = (await response.json()) as { errcode?: number; errmsg?: string };
      if (!response.ok || parsed.errcode !== 0) {
        throw new Error(`${path}: ${parsed.errmsg ?? `errcode ${parsed.errcode}`}`);
      }
      return parsed as T;
    };

    // The root department's own name, so the tree has a top and not a hole.
    const rootDetail = await post<{ result?: { name?: string } }>("topapi/v2/department/get", { dept_id: 1 });
    const departments: DirectorySnapshot["departments"] = [
      {
        vendorId: "1",
        name: rootDetail.result?.name ?? "root",
        parentVendorId: null,
      },
    ];
    // listsub returns one level; the tree is walked breadth-first with a seen
    // set, because a vendor answer that cycles must not loop the sync.
    const pending = ["1"];
    const seen = new Set(["1"]);
    while (pending.length > 0 && departments.length < MAX_PAGES * 100) {
      const parent = pending.shift()!;
      const children = await post<{
        result?: Array<{ dept_id?: number; name?: string }>;
      }>("topapi/v2/department/listsub", { dept_id: Number(parent) });
      if (!Array.isArray(children.result)) throw new Error("Invalid department children");
      for (const child of children.result) {
        if (!Number.isSafeInteger(child.dept_id)) throw new Error("Invalid department ID");
        const vendorId = String(child.dept_id);
        if (seen.has(vendorId)) continue;
        seen.add(vendorId);
        departments.push({
          vendorId,
          name: typeof child.name === "string" ? child.name : vendorId,
          parentVendorId: parent,
        });
        pending.push(vendorId);
      }
    }

    if (pending.length) throw new Error("Incomplete department tree");
    const bySubject = new Map<string, DirectorySnapshot["people"][number]>();
    for (const department of departments) {
      const deptId = Number(department.vendorId);
      let cursor = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const listed = await post<{
          result?: {
            list?: Array<{
              userid?: string;
              name?: string;
              title?: string;
              dept_id_list?: Array<number | string>;
            }>;
            has_more?: boolean;
            next_cursor?: number;
          };
        }>("topapi/v2/user/list", { dept_id: deptId, cursor, size: 100 });
        if (!Array.isArray(listed.result?.list)) throw new Error("Invalid people page");
        for (const person of listed.result.list) {
          if (typeof person.userid !== "string" || person.userid === "") throw new Error("Invalid person");
          const departmentIds = (person.dept_id_list ?? [deptId]).map(String);
          const known = bySubject.get(person.userid);
          if (known === undefined) {
            bySubject.set(person.userid, {
              vendorSubject: person.userid,
              name: typeof person.name === "string" ? person.name : person.userid,
              departmentVendorIds: departmentIds,
              ...(typeof person.title === "string" && person.title !== "" ? { title: person.title } : {}),
            });
          } else {
            known.departmentVendorIds = [
              ...new Set([...known.departmentVendorIds, ...departmentIds]),
            ];
          }
        }
        if (listed.result?.has_more !== true) break;
        if (!Number.isSafeInteger(listed.result.next_cursor) || listed.result.next_cursor! <= cursor || page === MAX_PAGES - 1) throw new Error("Incomplete people pagination");
        cursor = listed.result.next_cursor!;
      }
    }
    return { departments, people: [...bySubject.values()] };
  },
};

/** Telegram's directory is the chat roster it already syncs implicitly; no org tree to fetch. */
export const directoryProviders: Readonly<Record<ChannelType, DirectoryProvider | undefined>> = {
  feishu: feishuDirectory,
  dingtalk: dingtalkDirectory,
  telegram: undefined,
};
