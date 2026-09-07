/**
 * Tests for the kubeconfig reader and the minimal YAML parser behind it.
 *
 * The parser is hand-written because the project carries no YAML dependency, and a hand-written
 * parser with no tests is how a silent misread of `current-context` allocates tenant boxes into
 * whichever cluster a developer's kubeconfig happens to point at. What is checked: the shapes a
 * real kubeconfig comes in (token, client-cert, inline vs file CA), and that everything outside
 * the understood subset fails loudly instead of guessing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inClusterCredentials, kubeconfigCredentials, parseMinimalYaml } from "./kube-client.ts";

const KIND_CONFIG = `
apiVersion: v1
kind: Config
clusters:
- name: kind-kind
  cluster:
    certificate-authority-data: ${Buffer.from("FAKE-CA").toString("base64")}
    server: https://127.0.0.1:6443
contexts:
- context:
    cluster: kind-kind
    user: kind-kind
  name: kind-kind
current-context: kind-kind
users:
- name: kind-kind
  user:
    token: s3cr3t-token
`;

function withKubeconfig(text: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-kubeconfig-"));
  try {
    const path = join(dir, "config");
    writeFileSync(path, text);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a kind-style kubeconfig yields server, CA and token", () => {
  withKubeconfig(KIND_CONFIG, path => {
    const credentials = kubeconfigCredentials({ KUBECONFIG: path });
    assert.equal(credentials.server, "https://127.0.0.1:6443");
    assert.equal(credentials.token, "s3cr3t-token");
    assert.equal(credentials.ca?.toString("utf8"), "FAKE-CA");
  });
});

test("the context names its cluster and user, and does not assume they share its name", () => {
  // Hand-written configs diverge from kind's everything-named-alike shape; finding the entry
  // *named by the context* is the whole point, because the alternative picks the wrong cluster
  // the day two exist.
  withKubeconfig(
    `
current-context: work
contexts:
- name: work
  context:
    cluster: prod-eu
    user: deploy-bot
clusters:
- name: dev
  cluster:
    server: https://dev.example.com
- name: prod-eu
  cluster:
    server: https://prod-eu.example.com
users:
- name: deploy-bot
  user:
    token: bot-token
`,
    path => {
      const credentials = kubeconfigCredentials({ KUBECONFIG: path });
      assert.equal(credentials.server, "https://prod-eu.example.com");
      assert.equal(credentials.token, "bot-token");
    }
  );
});

test("client-certificate auth is understood, inline or by path", () => {
  withKubeconfig(
    `
current-context: c
contexts:
- name: c
  context:
    cluster: c
    user: c
clusters:
- name: c
  cluster:
    server: https://c.example.com
users:
- name: c
  user:
    client-certificate-data: ${Buffer.from("CERT").toString("base64")}
    client-key-data: ${Buffer.from("KEY").toString("base64")}
`,
    path => {
      const credentials = kubeconfigCredentials({ KUBECONFIG: path });
      assert.equal(credentials.clientCert?.toString("utf8"), "CERT");
      assert.equal(credentials.clientKey?.toString("utf8"), "KEY");
      assert.equal(credentials.token, undefined);
    }
  );
});

test("an exec-plugin credential is refused loudly, with the way out", () => {
  // gke/eks/SSO kubeconfigs. Silently producing unauthenticated 401s against a real cluster is
  // the worst version of this failure, so the error names the plugin and the two fixes.
  withKubeconfig(
    `
current-context: gke
contexts:
- name: gke
  context:
    cluster: gke
    user: gke
clusters:
- name: gke
  cluster:
    server: https://gke.example.com
users:
- name: gke
  user:
    exec:
      command: gke-gcloud-auth-plugin
`,
    path => {
      assert.throws(() => kubeconfigCredentials({ KUBECONFIG: path }), /exec plugin/);
      assert.throws(() => kubeconfigCredentials({ KUBECONFIG: path }), /kubectl create token/);
    }
  );
});

test("a config with no current-context, or no usable credential, says so", () => {
  withKubeconfig("apiVersion: v1\nkind: Config\n", path => {
    assert.throws(() => kubeconfigCredentials({ KUBECONFIG: path }), /no current-context/);
  });
  withKubeconfig(
    KIND_CONFIG.replace("token: s3cr3t-token", "# no credential at all"),
    path => {
      assert.throws(() => kubeconfigCredentials({ KUBECONFIG: path }), /neither a token nor a client certificate/);
    }
  );
});

test("in-cluster credentials come from the environment and the mounted token", () => {
  // Not in a cluster: undefined, so the caller falls through to the kubeconfig.
  assert.equal(inClusterCredentials({}), undefined);
  // Half a deployment — the variable set, the mount absent — is loud rather than a quiet fall
  // through to whatever kubeconfig happens to be lying around.
  assert.throws(() => inClusterCredentials({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }), /ServiceAccount is not mounted/);
});

test("an in-cluster token is re-read every time it is asked for, because it rotates", () => {
  // Kubernetes rotates ServiceAccount tokens (BoundServiceAccountTokenVolume, hourly by default)
  // and rewrites the file underneath the process; a token read once at startup is a 401 an hour
  // in, with nothing pointing at the cause.
  const dir = mkdtempSync(join(tmpdir(), "agentbox-sa-"));
  try {
    writeFileSync(join(dir, "token"), "tok-one\n");
    writeFileSync(join(dir, "ca.crt"), "FAKE-CA");
    const credentials = inClusterCredentials({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }, dir);
    assert.ok(credentials !== undefined);
    assert.equal(typeof credentials.token, "function", "a reader, not a value");
    const readToken = credentials.token as () => string;
    assert.equal(readToken(), "tok-one");
    writeFileSync(join(dir, "token"), "tok-two\n");
    assert.equal(readToken(), "tok-two", "the rotation is picked up without a restart");
    assert.equal(credentials.ca?.toString("utf8"), "FAKE-CA");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a # only starts a comment at line start or after whitespace", () => {
  // `token: abc#def` is a value — tokens with a # in them exist, and stripping at any # would
  // silently truncate a credential.
  assert.deepEqual(parseMinimalYaml("token: abc#def\n"), { token: "abc#def" });
  assert.deepEqual(parseMinimalYaml("key: value # the comment\n"), { key: "value" });
  assert.deepEqual(parseMinimalYaml("# just a comment\nkey: value\n"), { key: "value" });
});

test("insecure-skip-tls-verify is refused, with the way out", () => {
  withKubeconfig(
    KIND_CONFIG.replace(/certificate-authority-data: \S+/, "insecure-skip-tls-verify: true"),
    path => {
      assert.throws(() => kubeconfigCredentials({ KUBECONFIG: path }), /insecure-skip-tls-verify/);
    }
  );
});

test("a plain-http cluster server is refused, not silently used", () => {
  withKubeconfig(KIND_CONFIG.replace("https://127.0.0.1:6443", "http://127.0.0.1:6443"), path => {
    assert.throws(() => kubeconfigCredentials({ KUBECONFIG: path }), /plain-http/);
  });
});

test("certificate paths resolve against the kubeconfig's own directory, not cwd", () => {
  // kubectl resolves relative certificate-authority / client-certificate / client-key paths
  // against the config file's directory; resolving against process.cwd() would load whichever
  // files the working directory happened to hold.
  const dir = mkdtempSync(join(tmpdir(), "agentbox-kubeconfig-"));
  try {
    writeFileSync(join(dir, "ca.pem"), "CA-BY-PATH");
    writeFileSync(join(dir, "client.pem"), "CERT-BY-PATH");
    writeFileSync(join(dir, "client-key.pem"), "KEY-BY-PATH");
    writeFileSync(
      join(dir, "config"),
      `
current-context: c
contexts:
- name: c
  context:
    cluster: c
    user: c
clusters:
- name: c
  cluster:
    server: https://c.example.com
    certificate-authority: ca.pem
users:
- name: c
  user:
    client-certificate: client.pem
    client-key: client-key.pem
`
    );
    const credentials = kubeconfigCredentials({ KUBECONFIG: join(dir, "config") });
    assert.equal(credentials.server, "https://c.example.com");
    assert.equal(credentials.ca?.toString("utf8"), "CA-BY-PATH");
    assert.equal(credentials.clientCert?.toString("utf8"), "CERT-BY-PATH");
    assert.equal(credentials.clientKey?.toString("utf8"), "KEY-BY-PATH");
    assert.equal(credentials.token, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the parser refuses the YAML it does not understand, with a line number", () => {
  assert.throws(() => parseMinimalYaml("key: |\n  multi\n  line\n"), /block scalars/);
  assert.throws(() => parseMinimalYaml("key:\n\tvalue: 1\n"), /tab/);
  assert.throws(() => parseMinimalYaml("just a scalar\n"), /expected 'key: value'/);
  // And the subset it claims stays claimed: quoted scalars, nested maps, lists of maps. Scalars
  // are strings — a parser that guessed at types would turn a token of digits into a number.
  assert.deepEqual(parseMinimalYaml('a: "quoted"\nb:\n- name: one\n  value: 1\n- name: two\n'), {
    a: "quoted",
    b: [{ name: "one", value: "1" }, { name: "two" }],
  });
});
