# agentbox on Kubernetes

The control plane runs in the cluster and gives each tenant a box that is itself a pod. Per
tenant: one Pod, one ClusterIP Service (`boxdUrl` is `http://<pod>.<ns>.svc:1337` and never
drifts), three PVCs (work / config / hostd, the same three volumes Docker gives a box), and one
Secret holding the box's tokens — credentials travel by `envFrom` reference, never as plaintext in
the Pod spec.

## Apply order

```sh
# 1. Build and push the image somewhere the cluster can pull it. The box image doubles as the
#    control-plane image (one build carries the CLI); AGENTBOX_IMAGE_REPO picks the prefix.
npm run build:image
docker tag agentbox/box:latest <your-registry>/agentbox/box:latest
docker push <your-registry>/agentbox/box:latest

# 2. Namespace, then the identity, then the workload. RBAC references the namespace, and the
#    Deployment references the ServiceAccount, so this order is the one that applies cleanly.
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/rbac.yaml
kubectl apply -f deploy/kubernetes/control-plane.yaml
```

Then edit `control-plane.yaml` before real use: the ConfigMap's `AGENTBOX_CONTROL_USERS`, the
Secret's provider key, and the image name if you pushed to your own registry. There is no TLS on
the gateway — put an Ingress with a terminator in front of the `agentbox-control` Service's
`gateway` port before anyone signs in over a network.

## How it wires together

- The control plane authenticates to the API server with its own ServiceAccount (mounted token +
  CA); outside a cluster it falls back to `KUBECONFIG` (token or client-cert auth only — exec
  plugins such as gke/eks helpers are refused with instructions).
- Boxes reach the relay and the control plane through the `agentbox-control` Service
  (`http://agentbox-control.agentbox.svc:8788` / `:8080`). Rename that Service and set
  `AGENTBOX_K8S_RELAY_URL` / `AGENTBOX_K8S_CONTROL_URL` to match.
- Per-box resources come from the allocation policy: 4g memory and 10Gi per PVC by default,
  tunable with `AGENTBOX_K8S_MEMORY` / `AGENTBOX_K8S_STORAGE`; `AGENTBOX_K8S_STORAGE_CLASS` pins a
  StorageClass when the cluster default is not what boxes should get.

## Smoke check

```sh
kubectl -n agentbox logs deploy/agentbox-control          # banner names allocator "kubernetes"
kubectl -n agentbox port-forward svc/agentbox-control 8080:8080
# sign in at http://127.0.0.1:8080/gateway/login, then:
kubectl -n agentbox get pods,svc,pvc,secrets -l app.kubernetes.io/managed-by=agentbox
```
