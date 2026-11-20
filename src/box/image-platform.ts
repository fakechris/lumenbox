import { DockerError } from "./docker.ts";
import type { DockerRunner } from "./box-network.ts";

export function imagePlatformProblem(image: string, imagePlatform: string, serverPlatform: string): string | undefined {
  const actual = imagePlatform.trim();
  const host = serverPlatform.trim();
  if (!actual || !host || actual === host) return undefined;
  return `Cannot start image ${image}: its platform is ${actual}, but the Docker server platform is ${host}. ` +
    "From a checkout, build a local image with `npm run build:image` (requires the Go toolchain), " +
    "then run `agentbox box up --recreate`; or use a release image that publishes this platform.";
}

export async function ensureImagePlatform(run: DockerRunner, image: string): Promise<void> {
  const [actual, host] = await Promise.all([
    run(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image], 20_000).catch(() => ""),
    run(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], 20_000).catch(() => ""),
  ]);
  const problem = imagePlatformProblem(image, actual, host);
  if (problem) throw new DockerError(problem);
}
