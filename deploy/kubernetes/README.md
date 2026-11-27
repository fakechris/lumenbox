# agentbox on Kubernetes

The control plane runs in the cluster and gives each tenant a box that is itself a pod. Per
tenant: one Pod, one ClusterIP Service (`boxdUrl` is `http://<pod>.<ns>.svc:1337` and never
drifts), three PVCs (work / config / hostd, the same three volumes Docker gives a box), and one
Secret holding the box's tokens — credentials travel by `envFrom` reference, never as plaintext in
the Pod spec.

For a standalone organization server running `agentbox web` instead of this control-plane
gateway, use `organisation.yaml`: it mounts the `agentbox-organisation-state` PVC at the
directory named in `AGENTBOX_HOME` (`/state`). The generated installation token is stored in
`$AGENTBOX_HOME/ui-token`, not printed in the pod logs; it is the CLI's credential inside the pod
and signs nobody in from a browser (see [TLS](#tls-and-the-exposure-level)). Browser sessions are signed with a key
derived from it. Keep that volume across rollouts so browser sessions keep working. Without the
volume, every restart creates a new token and signs out the whole organization. If you supply
`AGENTBOX_UI_TOKEN` yourself, reference a stable Kubernetes Secret.

## Apply order

The checked-in manifest uses the published image for this checkout's `package.json` version.
Skip the build if your cluster can pull that image. For a private registry or a different tag,
set both the Deployment's `image` and the ConfigMap's `AGENTBOX_IMAGE` in
`control-plane.yaml` to the same pullable image before applying it.

```sh
# 1. Optional: build and push to your registry (replace the example hostname).
image_repo=registry.example.com/lumenbox
image_tag=$(node -p 'require("./package.json").version')
AGENTBOX_IMAGE_REPO="$image_repo" npm run build:image
docker push "$image_repo:$image_tag"
```

```sh
# 2. Namespace, then the identity, then the workload. RBAC references the namespace, and the
#    Deployment references the ServiceAccount, so this order is the one that applies cleanly.
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/rbac.yaml
```

### 3. Create the gateway account

Generate and save a random admin password in your password manager (use letters and digits;
`:` and `,` separate fields in the account list). In a private Bash terminal with shell tracing
off, paste it at the hidden prompt. `kubectl` prints only the Secret creation status, not the
password. Use the saved password to sign in as `admin`.

```bash
read -rsp 'Paste the saved admin password: ' admin_password
printf '\n'
kubectl -n agentbox create secret generic agentbox-control-users \
  --from-literal=AGENTBOX_CONTROL_USERS="admin:${admin_password:?Admin password is required}:default"
unset admin_password
```

```sh
# 4. The key the stored box tokens are encrypted with, kept out of the PVC that holds the
#    database. Without it the control plane mints a key onto /state and a snapshot of that
#    volume carries both halves — so the Deployment requires this Secret rather than starting
#    without it. Mint it before the first start: changing it later makes the tokens already in
#    the store unreadable.
kubectl -n agentbox create secret generic agentbox-control-key \
  --from-literal=AGENTBOX_CONTROL_KEY="$(openssl rand -hex 32)"

# Set the upstream provider key and any image overrides in control-plane.yaml first.
kubectl apply -f deploy/kubernetes/control-plane.yaml
```

If you skipped step 3, the control plane logs a generated admin password on every start
instead — fine for a look around, wrong for anything longer.

## TLS and the exposure level

Neither server terminates TLS, and neither starts on a network without it in front. Each reads
an exposure level at start (`AGENTBOX_EXPOSURE`: `local`, `private`, `public`; docs/06 "The
exposure level") and refuses a configuration weaker than the level requires, saying what is
missing in the pod's log.

**The control plane (`control-plane.yaml`)** ships as `local`: the Service is ClusterIP and the
smoke check below reaches it by `kubectl port-forward`, from your own machine. Before anyone
signs in over a network, put an Ingress that terminates TLS in front of the `agentbox-control`
Service's `gateway` port and set, in the `agentbox-control` ConfigMap, `AGENTBOX_EXPOSURE:
"private"` and `AGENTBOX_PUBLIC_URL: "https://<the Ingress host>"`. The session cookie is then
`Secure` and responses carry HSTS. With `private` and no `https://` address the pod exits with
the reason.

**The organisation server (`organisation.yaml`)** ships as `private`, because members open it
from their own computers: replace `REPLACE_WITH_PUBLIC_HOST` in `AGENTBOX_PUBLIC_URL` with the
host of an Ingress like this one (the class, the certificate and the timeouts are your
cluster's; the desktop stream is a WebSocket, so the Ingress must allow upgrades and long reads):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agentbox-organisation
  namespace: agentbox
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [lumenbox.example.com]
      secretName: lumenbox-example-com-tls
  rules:
    - host: lumenbox.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: agentbox-organisation
                port:
                  name: web
```

At this level the installation token is not a way in. `?token=` in an address is refused and
the token is accepted only as `Authorization: Bearer` from inside the pod. The first Admin opens
`https://<host>/bootstrap`; everyone else signs in as themselves. If nobody can sign in (the
bootstrap was used and the Admins are gone), mint an invitation from inside the pod:

```sh
kubectl -n agentbox exec deploy/agentbox-organisation -- sh -c \
  'curl -s -X POST -H "Authorization: Bearer $(cat /state/ui-token)" -H "content-type: application/json" \
     -d "{\"role\":\"admin\"}" http://127.0.0.1:7777/api/channels/invite'
```

The Ingress controller must set `X-Forwarded-For` (ingress-nginx and Traefik do): it is how the
server tells a member's request from the CLI's.

## How it wires together

- The control plane authenticates to the API server with its own ServiceAccount (mounted token +
  CA); outside a cluster it falls back to `KUBECONFIG` (token or client-cert auth only — exec
  plugins such as gke/eks helpers are refused with instructions).
- Boxes reach the relay and the control plane through the `agentbox-control` Service
  (`http://agentbox-control.agentbox.svc:8788` / `:8080`). Rename that Service and set
  `AGENTBOX_K8S_RELAY_URL` / `AGENTBOX_K8S_CONTROL_URL` to match.
- Per-box resources come from the allocation policy: 4Gi memory and 10Gi per PVC by default,
  tunable with `AGENTBOX_K8S_MEMORY` / `AGENTBOX_K8S_STORAGE`; `AGENTBOX_K8S_STORAGE_CLASS` pins a
  StorageClass when the cluster default is not what boxes should get.
- For an optional namespace quota and how to diagnose a rejected allocation, see
  [Capacity](ONBOARDING.md#6-capacity).

## Smoke check

```sh
kubectl -n agentbox logs deploy/agentbox-control          # banner names allocator "kubernetes"
kubectl -n agentbox port-forward svc/agentbox-control 8080:8080
# sign in at http://127.0.0.1:8080/gateway/login, then:
kubectl -n agentbox get pods,svc,pvc,secrets -l app.kubernetes.io/managed-by=agentbox
```
