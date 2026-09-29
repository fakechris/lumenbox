/**
 * Reading Feishu documents with the bot's own identity. R34's near half.
 *
 * The bot lives inside a Feishu workspace, logged in as itself — and until this
 * existed it could not read the very documents people paste at it, which is the first
 * expectation "it works in our company" sets. This is two orders of magnitude smaller
 * than the identity-box line: the credential never moves, nothing new is stored, the
 * app's own token reads what the app has been granted.
 *
 * Scope, deliberately: online documents (docx), including the ones a wiki page wraps.
 * Sheets, bitables and drive files answer honestly with the way that works today —
 * export it or drop it in the chat as a file. Growing those later is adding cases, not
 * changing shape.
 *
 * Same lazy-SDK discipline as the channel: nothing loads until a read is asked for.
 */

import { withReadOutcome } from "../host/read-outcome.ts";

/** What a Feishu URL points at, as much as the URL alone can say. */
export interface ParsedDocUrl {
  kind: "docx" | "wiki" | "docs" | "sheets" | "base" | "file" | "minutes";
  token: string;
}

/**
 * Reads the document type and token out of a Feishu/Lark URL, or nothing when the
 * URL is not a Feishu document at all.
 */
export function parseDocUrl(url: string): ParsedDocUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/(?:feishu\.cn|larksuite\.com|larkoffice\.com|feishu-pre\.cn)$/i.test(parsed.hostname) &&
      !/(?:\.feishu\.cn|\.larksuite\.com|\.larkoffice\.com)$/i.test(parsed.hostname)) {
    return undefined;
  }
  const match = /\/(docx|wiki|docs|sheets|base|file|minutes)\/([A-Za-z0-9_-]{10,})/.exec(
    parsed.pathname
  );
  if (match === null) return undefined;
  return { kind: match[1] as ParsedDocUrl["kind"], token: match[2]! };
}

/** Enough to read a document: the two docx calls and the wiki resolver. */
export interface DocApiClient {
  docx: {
    document: {
      get(options: { path: { document_id: string } }): Promise<{
        data?: { document?: { title?: string } };
      }>;
      rawContent(options: { path: { document_id: string }; params?: { lang?: number } }): Promise<{
        data?: { content?: string };
      }>;
    };
  };
  wiki: {
    space: {
      getNode(options: { params: { token: string; obj_type?: string } }): Promise<{
        data?: { node?: { obj_token?: string; obj_type?: string; title?: string } };
      }>;
    };
  };
}

/** Kept from a document before the cut. Feishu docs run long; a prompt should not. */
const DOC_CONTENT_LIMIT = 30_000;

const SHARE_ADVICE =
  "如果提示无权限:在文档右上角「分享」里把机器人加为协作者(或把它所在的群加进去),再试一次。";

/** What each unsupported kind should hear instead of a stack trace. */
const UNSUPPORTED: Record<Exclude<ParsedDocUrl["kind"], "docx" | "wiki">, string> = {
  docs: "这是旧版文档(docs),机器人暂时只能读新版在线文档(docx)。把它转换为新版文档,或导出后作为文件发过来。",
  sheets: "电子表格暂时读不了。把需要的部分导出(xlsx/csv)后作为文件发到群里,就能处理。",
  base: "多维表格暂时读不了。把需要的数据导出后作为文件发到群里,就能处理。",
  file: "云盘文件暂时不能直接拉取。把它下载后作为文件发到群里,就能处理。",
  minutes: "妙记暂时读不了。把纪要内容复制成文档或文字发过来。",
};

export class FeishuDocReader {
  private client: DocApiClient | undefined;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    /** Injected by tests; production builds the lark SDK client lazily. */
    private readonly clientFactory?: () => Promise<DocApiClient>
  ) {}

  private async api(): Promise<DocApiClient> {
    if (this.client !== undefined) return this.client;
    if (this.clientFactory !== undefined) {
      this.client = await this.clientFactory();
      return this.client;
    }
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = process.env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain,
    }) as unknown as DocApiClient;
    return this.client;
  }

  /**
   * The document as text, or the honest reason there is none. Never throws: the
   * caller is a tool dispatch, and "why not" is the answer the agent needs.
   */
  async read(url: string): Promise<{ text: string; isError?: boolean }> {
    const parsed = parseDocUrl(url);
    if (parsed === undefined) {
      return {
        text:
          "这不是一个飞书文档链接。能读的形如 https://xxx.feishu.cn/docx/<token> " +
          "或 /wiki/<token>;普通网页用 WebFetch。",
        isError: true,
      };
    }
    if (parsed.kind !== "docx" && parsed.kind !== "wiki") {
      return { text: UNSUPPORTED[parsed.kind], isError: true };
    }

    try {
      const api = await this.api();
      let documentId = parsed.token;
      if (parsed.kind === "wiki") {
        const node = (await api.wiki.space.getNode({
          params: { token: parsed.token, obj_type: "wiki" },
        })).data?.node;
        if (node?.obj_token === undefined) {
          return {
            text: `这个知识库页面解析不出内容对象。${SHARE_ADVICE}`,
            isError: true,
          };
        }
        if (node.obj_type !== "docx") {
          return {
            text:
              `这个知识库页面包的是 ${node.obj_type ?? "未知类型"},暂时只能读在线文档(docx)。` +
              "把内容导出后作为文件发过来。",
            isError: true,
          };
        }
        documentId = node.obj_token;
      }

      const [meta, raw] = await Promise.all([
        api.docx.document.get({ path: { document_id: documentId } }).catch(() => undefined),
        api.docx.document.rawContent({ path: { document_id: documentId } }),
      ]);
      const content = raw.data?.content ?? "";
      const title = meta?.data?.document?.title;
      const clipped = content.length > DOC_CONTENT_LIMIT;
      const cut = clipped ? content.slice(0, DOC_CONTENT_LIMIT) : content;
      const heading = [title !== undefined ? `# ${title}` : undefined, `Source: ${url}`]
        .filter(Boolean)
        .join("\n");
      // The shape goes first, in the same words every other reader uses (read-outcome.ts):
      // a note at the bottom is the first thing the transcript's cut throws away.
      return {
        text: withReadOutcome(
          {
            completeness: clipped ? "clipped" : "full",
            shape: { chars: cut.length, ...(clipped ? { totalChars: content.length } : {}) },
            ...(clipped ? { hint: "export the document and send it as a file to read the rest" } : {}),
          },
          `${heading}\n\n${cut}`
        ),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        text: withReadOutcome({ completeness: "unavailable" }, `读取失败:${detail}\n${SHARE_ADVICE}`),
        isError: true,
      };
    }
  }
}

/** Anything that reads a Feishu document link: `FeishuDocReader`, or a composition of them. */
export interface DocReader {
  read(url: string): Promise<{ text: string; isError?: boolean }>;
}

/**
 * The box's document reader, given the chat a link arrived in (INV-871).
 *
 * docs/22 §3: document reading is a box capability, and which door a link came through must not
 * change whether it can be read. It used to be served by the grandfathered door's app alone,
 * which holds for two doors in one tenant and fails for two tenants — tenant A's app cannot see
 * tenant B's documents at all. So the box's document credential is now *every* configured app,
 * each tried in turn: what can be read is the same whichever door a link arrives through (the
 * union of what each app's tenant lets it read), and no credential reaches the prompt. The
 * arriving door's app is tried first only because it is the likeliest to succeed; the default
 * door's comes next, then the rest.
 *
 * `chatKey` is `<door>:<chat>[:<thread>]`; undefined (a web conversation) starts at the default.
 * The first failure is what is reported when every app fails.
 */
export function docReaderForChat(
  chatKey: string | undefined,
  readers: ReadonlyMap<string, DocReader>,
  defaultDoor: string
): DocReader | undefined {
  const door = chatKey?.split(":")[0];
  const order = [door, defaultDoor, ...readers.keys()].filter(
    (name, index, all): name is string => name !== undefined && readers.has(name) && all.indexOf(name) === index
  );
  const chain = order.map(name => readers.get(name)!);
  if (chain.length === 0) return undefined;
  if (chain.length === 1) return chain[0];
  return {
    read: async url => {
      let first: { text: string; isError?: boolean } | undefined;
      for (const reader of chain) {
        const result = await reader.read(url);
        if (result.isError !== true) return result;
        first ??= result;
      }
      return first!;
    },
  };
}
