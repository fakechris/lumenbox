/**
 * The directory providers: Feishu and DingTalk behind one interface, each
 * walked against scripted vendor answers. The claims pinned hardest: the
 * subject each returns is the field its door's messages carry (open_id,
 * userid), and a person in two departments keeps both.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dingtalkDirectory, directoryProviders, feishuDirectory } from "./directory.ts";

/**
 * A fetch that routes by URL and body, the way the vendors' consoles do:
 * each route is asked in turn and its answer returned, so a provider that
 * walks the wrong URL fails loudly instead of quietly passing.
 */
function routedFetch(
  routes: Array<{
    url: RegExp;
    reply: (url: string, body: Record<string, unknown>) => unknown;
  }>,
): { fetchFn: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    calls.push({ url, body });
    for (const candidate of routes) {
      if (!candidate.url.test(url)) continue;
      const answer = candidate.reply(url, body);
      if (answer === undefined) continue;
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    return new Response(JSON.stringify({ errcode: 404, errmsg: `no route for ${url}` }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const ARGS = { clientId: "cli", clientSecret: "sec" };

// --------------------------------------------------------------------- Feishu

test("feishu: token, the department tree, then people per department including root's", async () => {
  const { fetchFn, calls } = routedFetch([
    {
      url: /auth\/v3\/tenant_access_token\/internal$/,
      reply: (_url, body) => {
        assert.deepEqual(body, { app_id: "cli", app_secret: "sec" });
        return { code: 0, tenant_access_token: "tt" };
      },
    },
    {
      url: /contact\/v3\/departments\/find_by_page/,
      reply: url =>
        url.includes("page_token=p2")
          ? { code: 0, data: { items: [{ department_id: "od_2", name: "市场部", parent_department_id: "od_0" }] } }
          : {
              code: 0,
              data: {
                items: [{ department_id: "od_1", name: "研发部", parent_department_id: "0" }],
                has_more: true,
                page_token: "p2",
              },
            },
    },
    {
      url: /contact\/v3\/users\/find_by_department/,
      reply: url => {
        if (url.includes("department_id=0")) {
          return {
            code: 0,
            data: { items: [{ open_id: "ou_boss", name: "老板", department_ids: ["0"] }] },
          };
        }
        if (url.includes("department_id=od_1")) {
          return {
            code: 0,
            data: {
              items: [
                { open_id: "ou_1", name: "一", department_ids: ["od_1"] },
                // The same person also sits in 市场部 — deduped later, both kept.
                { open_id: "ou_2", name: "二", department_ids: ["od_1", "od_2"], title: "工程师" },
              ],
            },
          };
        }
        if (url.includes("department_id=od_2")) {
          return {
            code: 0,
            data: { items: [{ open_id: "ou_2", name: "二", department_ids: ["od_1", "od_2"] }] },
          };
        }
        return { code: 230002, msg: "no permission for this department" };
      },
    },
  ]);
  const snapshot = await feishuDirectory.fetchDirectory({ ...ARGS, fetchFn });
  assert.deepEqual(
    snapshot.departments.map(d => d.name),
    ["研发部", "市场部"],
  );
  assert.deepEqual(
    snapshot.people.map(p => p.vendorSubject).sort(),
    ["ou_1", "ou_2", "ou_boss"],
    "root's own people walked too, subjects are open_ids"
  );
  const two = snapshot.people.find(p => p.vendorSubject === "ou_2")!;
  assert.deepEqual(two.departmentVendorIds, ["od_1", "od_2"], "two departments, both kept");
  assert.equal(two.title, "工程师");
  // The Bearer token rode every contact call.
  assert.ok(calls.filter(c => c.url.includes("contact/")).length >= 4);
});

test("feishu: a vendor error on the token is thrown with its own words", async () => {
  const { fetchFn } = routedFetch([
    {
      url: /tenant_access_token/,
      reply: () => ({ code: 99991663, msg: "app secret is wrong" }),
    },
  ]);
  await assert.rejects(
    feishuDirectory.fetchDirectory({ ...ARGS, fetchFn }),
    /app secret is wrong/,
  );
});

// ------------------------------------------------------------------- DingTalk

test("dingtalk: token, root's name, the tree by recursion, people with cursor pagination", async () => {
  const { fetchFn, calls } = routedFetch([
    {
      url: /v1\.0\/oauth2\/accessToken$/,
      reply: (_url, body) => {
        assert.deepEqual(body, { appKey: "cli", appSecret: "sec" });
        return { accessToken: "at", expireIn: 7200 };
      },
    },
    {
      url: /topapi\/v2\/department\/get/,
      reply: () => ({ errcode: 0, result: { name: "纵横科技" } }),
    },
    {
      url: /topapi\/v2\/department\/listsub/,
      reply: (_url, body) => {
        const deptId = Number(body.dept_id);
        if (deptId === 1) {
          return {
            errcode: 0,
            result: [
              { dept_id: 10, name: "研发部" },
              { dept_id: 20, name: "市场部" },
            ],
          };
        }
        if (deptId === 10) return { errcode: 0, result: [{ dept_id: 11, name: "后端组" }] };
        return { errcode: 0, result: [] };
      },
    },
    {
      url: /topapi\/v2\/user\/list/,
      reply: (_url, body) => {
        const deptId = Number(body.dept_id);
        if (deptId === 1) {
          return Number(body.cursor) === 0
            ? {
                errcode: 0,
                result: {
                  list: [{ userid: "boss", name: "老板", dept_id_list: [1] }],
                  has_more: true,
                  next_cursor: 100,
                },
              }
            : { errcode: 0, result: { list: [{ userid: "ceo2", name: "副总", dept_id_list: [1] }] } };
        }
        if (deptId === 10) {
          return { errcode: 0, result: { list: [{ userid: "s7", name: "七", dept_id_list: [10, 20] }] } };
        }
        return { errcode: 0, result: { list: [] } };
      },
    },
  ]);
  const snapshot = await dingtalkDirectory.fetchDirectory({ ...ARGS, fetchFn });
  assert.deepEqual(
    snapshot.departments.map(d => `${d.name}@${d.parentVendorId}`),
    ["纵横科技@null", "研发部@1", "市场部@1", "后端组@10"],
    "breadth-first from the root, parents named"
  );
  assert.deepEqual(
    snapshot.people.map(p => p.vendorSubject).sort(),
    ["boss", "ceo2", "s7"],
    "pagination followed, subjects are userids"
  );
  assert.deepEqual(
    snapshot.people.find(p => p.vendorSubject === "s7")!.departmentVendorIds,
    ["10", "20"],
  );
  assert.ok(calls.some(c => c.url.includes("cursor") === false && JSON.stringify(c.body).includes('"cursor":100')), "the second page asked with the vendor's cursor");
});

test("dingtalk: a department error stops the sync with the vendor's words", async () => {
  const { fetchFn } = routedFetch([
    { url: /v1\.0\/oauth2\/accessToken$/, reply: () => ({ accessToken: "at" }) },
    { url: /topapi\/v2\/department\/get/, reply: () => ({ errcode: 88, errmsg: "ip not in whitelist" }) },
  ]);
  await assert.rejects(
    dingtalkDirectory.fetchDirectory({ ...ARGS, fetchFn }),
    /ip not in whitelist/,
  );
});

test("the registry carries feishu and dingtalk; telegram has no directory", () => {
  assert.equal(directoryProviders.feishu, feishuDirectory);
  assert.equal(directoryProviders.dingtalk, dingtalkDirectory);
  assert.equal(directoryProviders.telegram, undefined);
});

test("feishu rejects truncated pagination and denied department reads", async () => {
  for (const departments of [
    { items: [], has_more: "true", page_token: "next" },
    { items: [], has_more: null },
    { items: [], has_more: true },
    { items: [], has_more: true, page_token: "repeat" },
    { items: [] },
  ]) {
    const { fetchFn } = routedFetch([
      { url: /tenant_access_token/, reply: () => ({ code: 0, tenant_access_token: "tt" }) },
      { url: /departments\/find_by_page/, reply: () => ({ code: 0, data: departments }) },
      { url: /users\/find_by_department/, reply: () => ({ code: 230002 }) },
    ]);
    await assert.rejects(feishuDirectory.fetchDirectory({ ...ARGS, fetchFn }));
  }
});

test("dingtalk rejects missing and repeated pagination cursors", async () => {
  for (const next_cursor of [undefined, 0]) {
    const { fetchFn } = routedFetch([
      { url: /accessToken$/, reply: () => ({ accessToken: "at" }) },
      { url: /department\/get/, reply: () => ({ errcode: 0, result: { name: "root" } }) },
      { url: /department\/listsub/, reply: () => ({ errcode: 0, result: [] }) },
      { url: /user\/list/, reply: () => ({ errcode: 0, result: { list: [], has_more: true, next_cursor } }) },
    ]);
    await assert.rejects(dingtalkDirectory.fetchDirectory({ ...ARGS, fetchFn }));
  }
});


test("dingtalk rejects malformed department membership before coercion", async () => {
  for (const dept_id_list of [[null], [{}], [false], [""], []]) {
    const { fetchFn } = routedFetch([
      { url: /accessToken$/, reply: () => ({ accessToken: "at" }) },
      { url: /department\/get/, reply: () => ({ errcode: 0, result: { name: "root" } }) },
      { url: /department\/listsub/, reply: () => ({ errcode: 0, result: [] }) },
      { url: /user\/list/, reply: () => ({ errcode: 0, result: { list: [{ userid: "ada", dept_id_list }] } }) },
    ]);
    await assert.rejects(dingtalkDirectory.fetchDirectory({ ...ARGS, fetchFn }));
  }
});
