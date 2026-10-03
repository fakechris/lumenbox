import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { BoxManager, defaultBoxImage, networkNameFor, type BoxConfig } from "./docker.ts";
import type { PersonalBoxDriver, PersonalBoxRecord } from "../host/personal-boxes.ts";
const execute = promisify(execFile);

/** Explicit construction: defaultBoxConfig() consults installation tokens and host settings. */
export function personalBoxConfig(record: PersonalBoxRecord, token?: string): BoxConfig {
  return {
    containerName: record.name,
    image: defaultBoxImage(),
    boxdPort: 0,
    token: token ?? readFileSync(record.tokenFile, "utf8").trim(),
    host: "127.0.0.1",
    displayWidth: 1280,
    displayHeight: 800,
    withHost: false,
    isolated: true,
    relayed: true,
    runArgs: [],
  };
}
export class PersonalDocker implements PersonalBoxDriver {
  async start(record: PersonalBoxRecord): Promise<string> {
    const result = await new BoxManager(personalBoxConfig(record)).up();
    if (!result.status.boxdUrl) throw new Error("Personal box has no endpoint");
    return result.status.boxdUrl;
  }
  async remove(record: PersonalBoxRecord, deleteData: boolean): Promise<void> {
    await new BoxManager(personalBoxConfig(record, "")).down({ remove: true });
    const networks = await execute("docker", ["network", "ls", "--format", "{{.Name}}"], { timeout: 30_000 });
    const network = networkNameFor(record.name);
    if (networks.stdout.split("\n").includes(network))
      await execute("docker", ["network", "rm", network], { timeout: 30_000 });
    if (deleteData)
      for (const suffix of ["work", "config"]) {
        const name = `${record.name}-${suffix}`;
        const listed = await execute("docker", ["volume", "ls", "--format", "{{.Name}}"], {
          timeout: 30_000,
        });
        if (listed.stdout.split("\n").includes(name))
          await execute("docker", ["volume", "rm", name], { timeout: 30_000 });
      }
  }
}
