/**
 * The names and addresses a container uses for the machine it runs on: Docker Desktop's and
 * OrbStack's `host.docker.internal` (and its IPs), Lima's, Podman's. One list for the web's refusal
 * (web/auth.ts boxSideRefusal) and the shell guard's (host/boundary-probe.ts).
 */
export const BOX_SIDE_HOSTS: ReadonlySet<string> = new Set(["host.docker.internal", "gateway.docker.internal", "docker.for.mac.localhost", "host.lima.internal", "host.containers.internal", "0.250.250.254", "192.168.65.254"]);
