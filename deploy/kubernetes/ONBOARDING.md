# Onboarding: the kubernetes allocator on a real cluster

The path from "I have kubectl access" to "tenants get boxes as pods", in order. Every step names
its check, so the first thing that is wrong is the first thing you see.

## 0. What the client can authenticate with

The allocator's client (`src/control/kube-client.ts`) speaks to the apiserver with either:

- **an in-cluster ServiceAccount token** — automatic when the control plane runs as the
  Deployment in `control-plane.yaml`. This is the supported topology: box addresses are Service
  DNS (`http://<name>.<ns>.svc:1337`), which resolves only inside the cluster. A control plane
  outside the cluster can create pods but its gateway and collector can never reach them, so
  outside-the-cluster is not a deployment, only a debugging stance.
- **a kubeconfig** (`KUBECONFIG` or `~/.kube/config`) carrying a `token` or a client certificate
  pair. Useful for `scripts/k8s-smoke.ts`.

What it does **not** speak: username/password basic auth, and `exec:` credential plugins
(gke/eks/SSO helpers) — both are refused loudly with the way out named in the error. If your
cluster access is a username and password, their one job is to make `kubectl` work; everything
below runs on `kubectl` and the in-cluster identity.

## 1. Prerequisites

```sh
kubectl cluster-info            # your access works
kubectl get storageclass        # an RWO-capable StorageClass exists (a default is easiest)
```

And one pipeline decision: **the box image must be pullable by the cluster's nodes.** The same
image runs the control plane (it is one build; the control plane is the CLI invoked with
`control up`). Options, in order of preference:

1. A registry the nodes already pull from — push there (see step 2).
2. `docker save` / `docker load` onto each node (needs node shell access).
3. A public registry — possible, but you are publishing the image; decide that on purpose.

## 2. Build and push the image

```sh
AGENTBOX_IMAGE_REPO=<registry>/<project>/agentbox npm run build:image
docker push <registry>/<project>/agentbox:latest    # and the content-hash tag it printed
```

Prefer the content-hash tag over `:latest` when you edit `control-plane.yaml`: nodes cache
`:latest`, and `imagePullPolicy: IfNotPresent` plus a warm cache is how a control plane and its
boxes silently run different builds.

## 3. Deploy the control plane

```sh
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/rbac.yaml

# The gateway's accounts. There is no default password; a forgotten Secret degrades to a
# generated one printed in the pod log.
kubectl -n agentbox create secret generic agentbox-control-users \
  --from-literal=AGENTBOX_CONTROL_USERS="admin:$(openssl rand -hex 8):default"
```

Then edit `control-plane.yaml`: the image (step 2's tag) and the upstream model key in the
`agentbox-control` Secret (the relay holds it so no provider key ever enters a box). Optionally
uncomment the `AGENTBOX_K8S_*` knobs in the ConfigMap. Then:

```sh
kubectl apply -f deploy/kubernetes/control-plane.yaml
kubectl -n agentbox rollout status deploy/agentbox-control
```

## 4. Verify end to end

```sh
kubectl -n agentbox port-forward svc/agentbox-control 8080:8080
# Open http://127.0.0.1:8080 and sign in with the account from step 3.
# The first request allocates a box; the image pull dominates the wait.
kubectl -n agentbox get pods -w          # the tenant's pod reaches Ready
kubectl -n agentbox get pvc              # <box>-work, <box>-config, <box>-hostd
```

`Pending` that does not clear is almost always the image pull or an unsatisfiable PVC —

```sh
kubectl -n agentbox describe pod <box-pod>   # the Events section says which
```

## 5. Wire-level validation without the box image

If the image pipeline is not ready yet, the REST client itself can still be proven against the
real apiserver with any image the nodes already have:

```sh
node --experimental-transform-types scripts/k8s-smoke.ts \
  --namespace default --image <an-image-already-running-on-the-cluster>
```

It exercises the paths a fake cannot: idempotent re-apply (409 → merge → PUT), clusterIP
preservation, and the pod replace path (grace-0 delete, wait, re-POST). Everything it creates is
named `agentbox-smoke-*` and removed afterwards.

## 6. Capacity

Three layers, independent:

1. **Per box** — `AGENTBOX_K8S_MEMORY` (default 4Gi, request *and* limit, so the scheduler
   reserves it) and `AGENTBOX_K8S_STORAGE` (default 10Gi per PVC, three PVCs per box). Values must
   be Kubernetes quantities (`4Gi`, not `4g`); the policy validates before the apiserver is asked.
2. **Fleet total** — `quota.yaml` (not applied by default): a ResourceQuota caps the namespace's
   total memory / PVC count / storage, and its LimitRange keeps hand-created pods schedulable
   under that quota. `requests.memory ÷ per-box memory = tenant cap`, and one tenant too many
   becomes a clean `Pending` instead of a node outage.
3. **Per tenant** — replace `staticPolicy()` (`src/control/policy.ts`). The decision lands in the
   pod manifest and the audit log:

```ts
policy: {
  decide: ({ tenant }) =>
    (tenant.quota as { tier?: string }).tier === "premium"
      ? {
          resources: { memoryRequest: "8Gi", memoryLimit: "8Gi", cpuRequest: "2", cpuLimit: "4" },
          storageSize: "50Gi",
          nodeSelector: { nodepool: "compute" },        // dedicated node pool
          labels: { "example.com/tier": "premium" },    // what a NetworkPolicy selects on
        }
      : { resources: { memoryRequest: "4Gi", memoryLimit: "4Gi" }, storageSize: "10Gi" },
}
```

## 7. Operations notes

- **The `agentbox-control-state` PVC is the control plane.** Tenants, boxes, tokens (encrypted)
  and the audit log are one SQLite file there. Back up that directory and you have backed up
  everything; lose it and every tenant gets allocated a second box.
- **No TLS anywhere in this file.** The relay token and the gateway session travel in plain HTTP
  inside the cluster. Put a TLS-terminating Ingress in front of the gateway for real use, and
  treat east-west encryption (service mesh) as a separate decision.
- **Box pods carry no API credential** (`automountServiceAccountToken: false`) and the control
  plane's Role cannot `list` secrets — see `rbac.yaml`'s header for the exact posture.
- **Recovery**: a deleted or evicted box pod is recreated by the admin API's restart path; the
  store row, the PVCs and the token Secret all survive, so the box comes back as itself.
