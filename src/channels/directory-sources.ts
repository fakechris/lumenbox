/**
 * Which doors have a directory behind them, and with what credentials: the three readers
 * the web server used to hold inline. A door's credentials are named by its id (FEISHU_WORK
 * reads FEISHU_WORK_APP_ID), read from the process environment or the saved config env.
 */
import { type Directories, type DirectorySource, departmentQuotaKey, directorySource } from "../host/directory.ts";
import { type DirectoryProvider, directoryProviders } from "./directory.ts";
import type { ChannelRecord } from "./identity.ts";

export interface DirectoryCredentials {
  source: DirectorySource;
  clientId: string;
  clientSecret: string;
  provider: DirectoryProvider;
}

export function directoryHelpers(input: {
  channelRecords: ChannelRecord[];
  directories: Directories;
  /** A credential by name: the process environment first, then the saved config env. */
  env: (key: string) => string | undefined;
  channelEnvBase: (id: string) => string;
  feishuDomain: () => string;
}) {
  const credentials = (id: string): DirectoryCredentials | undefined => {
    const record = input.channelRecords.find(item => item.id === id);
    if (!record || record.type === "telegram" || record.type === "tailmsg") return;
    const base = input.channelEnvBase(id);
    const value = input.env;
    const clientId = value(base + (record.type === "feishu" ? "_APP_ID" : "_CLIENT_ID"));
    const clientSecret = value(base + (record.type === "feishu" ? "_APP_SECRET" : "_CLIENT_SECRET"));
    if (!clientId || !clientSecret) return;
    return { source: directorySource(id, record.incarnation, clientId, record.type === "feishu" ? input.feishuDomain() : "dingtalk"), clientId, clientSecret, provider: directoryProviders[record.type]! };
  };
  const sources = () =>
    input.channelRecords.flatMap(record => {
      const found = credentials(record.id);
      return found ? [found.source] : [];
    });
  const departments = () =>
    sources().flatMap(source => {
      if (input.directories.status(source) !== "ready") return [];
      return input.directories.of(source.channelId)!.snapshot!.departments.map(department => ({
        key: departmentQuotaKey(source, department.vendorId),
        name: department.name,
        channelId: source.channelId,
      }));
    });
  return { credentials, sources, departments };
}
