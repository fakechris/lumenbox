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

## 2. Choose the image

The checked-in `control-plane.yaml` pins the published image for this checkout's
`package.json` version. If the cluster can pull it, skip the build. Otherwise, build
and push to a registry the cluster can pull from (replace the example hostname):

```sh
image_repo=registry.example.com/lumenbox
image_tag=$(node -p 'require("./package.json").version')
AGENTBOX_IMAGE_REPO="$image_repo" npm run build:image
docker push "$image_repo:$image_tag"
```

If you deploy a different image, edit both the Deployment's `image` and the ConfigMap's
`AGENTBOX_IMAGE` in `control-plane.yaml`. If you use the content-hash tag printed by the build
instead of the release tag, push that tag too. Do not use `:latest`: nodes may keep a cached
build with `imagePullPolicy: IfNotPresent`.

When cutting a release, update both manifest pins to the new `package.json` version;
`npm test` checks that they stay in sync.

Two cross-architecture facts this step is where you find out about:

- **Build for the nodes' architecture, not your laptop's.** From Apple Silicon that is
  `DOCKER_DEFAULT_PLATFORM=linux/amd64 npm run build:image` — check with
  `kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'` first, because a
  wrong-arch image is a `CrashLoopBackOff` ("exec format error") an hour later, not a build error.
- **Old kubelets pull schema2, not OCI.** Docker ≤ 19.x on the nodes may refuse an OCI-format
  manifest. If pulls fail with manifest errors, push through a converter instead of `docker push`:
  `skopeo copy --format v2s2 docker-archive:img.tar docker://<registry>/<project>/agentbox:<tag>`
  (this is also the way around a `docker push` that must traverse a proxy the registry is not on).

## 3. Deploy the control plane

```sh
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/rbac.yaml

# The key the stored box tokens are encrypted with. Required: unset, the control plane writes a
# key onto the same PVC as the database, which makes a snapshot of that volume a token dump.
# Mint it now — changing it later makes the tokens already stored unreadable.
kubectl -n agentbox create secret generic agentbox-control-key \
  --from-literal=AGENTBOX_CONTROL_KEY="$(openssl rand -hex 32)"
```

Follow [Create the gateway account](README.md#3-create-the-gateway-account) to save a random
admin password before creating the users Secret. There is no default password; if the Secret is
omitted, the control plane generates a password and logs it on each start.

Then edit `control-plane.yaml`: set both image fields if you chose a different image in step 2
and set the upstream model key in the `agentbox-control` Secret (the relay holds it so no
provider key ever enters a box). Optionally
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

If the pod exists but stays `Pending`, check its Events for scheduling, volume binding, or
image pull problems. If no pod was created, see [Capacity](#6-capacity) for admission errors.

```sh
kubectl -n agentbox describe pod <box-pod>   # the Events section says which
```

### Updating to a new image

The Deployment's strategy is Recreate (the SQLite store tolerates no second writer), so a
rollout is downtime for exactly as long as the new image takes to pull. Pull first, then update
both the Deployment's `image` and the ConfigMap's `AGENTBOX_IMAGE` in `control-plane.yaml` and apply:

```sh
node --experimental-transform-types scripts/k8s-prewarm.ts --image <registry>/<project>/agentbox:<tag>
kubectl apply -f deploy/kubernetes/control-plane.yaml
kubectl -n agentbox rollout status deploy/agentbox-control
```

`k8s-prewarm.ts` runs a throwaway pod per node and waits for it — a node whose pull wedges is
named *before* the old control plane is stopped, not after. A node it reports UNSCHEDULABLE is
one the scheduler could not place a box on today either; that is a warning about capacity, not
a prewarm failure. The ConfigMap's `AGENTBOX_IMAGE` decides what *new* boxes run; applying the
manifest does not update existing box pods.

Cluster-age failure modes seen in the wild, so they are not mysteries when you meet them:

- **PVC stuck `Pending` with "create process timeout" from the provisioner.** OpenEBS localpv's
  provisioner shells out to a helper pod whose image (`OPENEBS_IO_HELPER_IMAGE`) defaults to
  docker.io. On a cluster where docker.io is unreachable, every new PVC times out — pre-existing
  ones keep working, so the breakage hides until someone provisions. Mirror the helper image into
  your registry and patch the env on the provisioner Deployment.
- **`kubectl apply` fails schema validation on resources you never heard of.** Old apiservers
  carrying CRDs with broken OpenAPI schemas (a classic: velero's Restore) fail client-side
  validation of *unrelated* manifests. `--validate=false` is the workaround; it is a property of
  that cluster, not of these manifests.
- **A first request that 502s with "Your box is not answering"** while the pod is still booting
  is normal — retry once the pod is Ready. If it 502s with the pod Ready, the box's UI port is
  not listening; the allocator sets `AGENTBOX_HOST_ENABLED=1` for exactly this, so a 502 then
  means the box predates that and should be restarted through the admin API.

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
   total memory / PVC count / storage, and a LimitRange supplies defaults and limits individual
   containers. Apply with `kubectl apply -f deploy/kubernetes/quota.yaml`. All workloads in the
   namespace count toward the quota, including the control plane.
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

**Admission `Forbidden` vs. scheduling `Pending`.** If a new Pod or PVC exceeds ResourceQuota
or violates LimitRange, the API rejects the create request with HTTP 403 (`Forbidden`).
There is no rejected object to describe. For a direct `kubectl` create/apply, read its API
error; for a tenant box, look for the allocation error in the control-plane log. If a
Kubernetes controller was creating the object, check that controller's Events for
`FailedCreate`.

```sh
kubectl -n agentbox logs deploy/agentbox-control
kubectl -n agentbox describe resourcequota agentbox-boxes
kubectl -n agentbox describe limitrange agentbox-boxes
kubectl -n agentbox get events --sort-by=.metadata.creationTimestamp
```

For `exceeded quota`, compare Used and Hard for the resource named in the error. Free
unused resources (only delete PVCs once their data is no longer needed), reduce the new
workload's request, or have the cluster operator raise the quota. For a LimitRange error
such as `maximum memory usage per Container`, bring the container's request/limit within
the range or have the operator change that policy. Retry the allocation after making room
or correcting the settings. If the pod was admitted but there is no eligible node with
enough capacity, it can instead remain `Pending`: use `kubectl describe pod` and look for
`FailedScheduling` in its Events.

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
